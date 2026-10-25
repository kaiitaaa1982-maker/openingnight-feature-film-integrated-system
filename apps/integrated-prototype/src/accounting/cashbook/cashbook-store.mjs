// 入出金の履歴の DB の読み書き（移行 0045_cashbook）。書き込みは1回の batch で、仕訳と行は明細の行の鍵・仕訳の ID から引く（ID を先に読まない）。
// 仕訳の借方計＝貸方計・口座の科目の一致・明細の行1つに有効な仕訳1本は DB のトリガーが断る。変更の記録 audit_log に1行残す（金額は残さない）
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const LINE_ID = '(SELECT l.id FROM bank_statement_lines l WHERE l.org_id=? AND l.bank_account_id=? AND l.dedupe_key=?)';

// 会計が使う補助の科目（無ければ作る）。未分類は明細から取り込んだ直後の相手の科目、開始残高は口座を作るときの相手の科目
export const HELPER_ACCOUNTS = Object.freeze({
  suspense: {code: '1950', name: '未分類（仮勘定）', section: 'asset', note: '銀行の明細から取り込んだ直後の相手の科目。項目を付けると正しい科目へ振り替わる'},
  opening: {code: '3990', name: '開始残高（調整）', section: 'equity', note: '口座を作るときの開始残高の相手の科目'},
});

export async function readCashAccount(db, orgId) {
  return db.get("SELECT id,code,name FROM gl_accounts WHERE org_id=? AND system_key='cash'", [orgId]);
}

export async function readGlAccounts(db, orgId) {
  return db.all('SELECT id,code,name,section,system_key FROM gl_accounts WHERE org_id=? ORDER BY sort_order,code', [orgId]);
}

export async function readHelperAccountId(db, orgId, key) {
  const found = await db.get('SELECT id FROM gl_accounts WHERE org_id=? AND code=?', [orgId, HELPER_ACCOUNTS[key].code]);
  return found ? Number(found.id) : null;
}

export async function ensureHelperAccount(db, orgId, key, createdBy) {
  const spec = HELPER_ACCOUNTS[key];
  const found = await db.get('SELECT id FROM gl_accounts WHERE org_id=? AND code=?', [orgId, spec.code]);
  if (found) return Number(found.id);
  const row = await db.get(`INSERT INTO gl_accounts(org_id,code,name,section,source,system_key,cash_effect,sort_order,note,created_by)
    VALUES(?,?,?,?,'manual',NULL,1,?,?,?) RETURNING id`, [orgId, spec.code, spec.name, spec.section, spec.section === 'asset' ? 1180 : 3190, spec.note, createdBy]);
  return Number(row.id);
}

export async function readBankAccounts(db, orgId) {
  return db.all('SELECT id,label,bank_name,last4,gl_account_id,opened_on,created_at FROM bank_accounts WHERE org_id=? ORDER BY id', [orgId]);
}

export async function readBankAccount(db, orgId, id) {
  return db.get('SELECT id,label,bank_name,last4,gl_account_id,opened_on FROM bank_accounts WHERE org_id=? AND id=?', [orgId, id]);
}

// 口座と開始残高の仕訳を1回で足す（開始残高が0なら仕訳は作らない）
export async function addBankAccount(db, orgId, input, {createdBy, openingAccountId}) {
  const statements = [{sql: `INSERT INTO bank_accounts(org_id,label,bank_name,last4,gl_account_id,opened_on,created_by) VALUES(?,?,?,?,?,?,?)`,
    params: [orgId, input.label, input.bankName ?? null, input.last4 ?? null, input.glAccountId, input.openedOn, createdBy]}];
  const bankId = '(SELECT b.id FROM bank_accounts b WHERE b.org_id=? AND b.label=?)';
  if (input.openingBalanceYen !== 0) {
    const amount = Math.abs(input.openingBalanceYen);
    const cashSide = input.openingBalanceYen > 0 ? 'debit' : 'credit';
    const other = cashSide === 'debit' ? 'credit' : 'debit';
    const entryId = `(SELECT e.id FROM journal_entries e WHERE e.org_id=? AND e.source_kind='opening' AND e.memo=? ORDER BY e.id DESC LIMIT 1)`;
    const memo = `開始残高 ${input.label}`;
    statements.push(
      {sql: `INSERT INTO journal_entries(org_id,entry_date,source_kind,line_count,memo,created_by) VALUES(?,?,'opening',2,?,?)`, params: [orgId, input.openedOn, memo, createdBy]},
      {sql: `INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id) VALUES(?,${entryId},1,?,?,?,${bankId})`,
        params: [orgId, orgId, memo, input.glAccountId, cashSide, amount, orgId, input.label]},
      {sql: `INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id) VALUES(?,${entryId},2,?,?,?,NULL)`,
        params: [orgId, orgId, memo, openingAccountId, other, amount]});
  }
  statements.push({sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'bank_account', input.label, JSON.stringify({label: input.label, openedOn: input.openedOn})]});
  await db.batch(statements);
  return db.get('SELECT id FROM bank_accounts WHERE org_id=? AND label=?', [orgId, input.label]);
}

export async function readExistingKeys(db, orgId, bankAccountId) {
  return new Set((await db.all('SELECT dedupe_key FROM bank_statement_lines WHERE org_id=? AND bank_account_id=?', [orgId, bankAccountId])).map((r) => r.dedupe_key));
}

export async function readImportByHash(db, orgId, sha) {
  return db.get('SELECT id,bank_account_id,file_name,created_at FROM bank_statement_imports WHERE org_id=? AND raw_sha256=?', [orgId, sha]);
}

// 明細の1通・新しい行・行ごとの仕訳（相手は未分類）を1回で足す。lines は重なりを除いた新しい行だけ
export async function addStatementImport(db, orgId, account, {sha, fileName, parser, text, lineCount, lines}, {createdBy, cashAccountId, suspenseAccountId}) {
  const importId = '(SELECT i.id FROM bank_statement_imports i WHERE i.org_id=? AND i.raw_sha256=?)';
  const statements = [{sql: `INSERT INTO bank_statement_imports(org_id,bank_account_id,raw_sha256,file_name,parser,original_text,line_count,new_line_count,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`, params: [orgId, account.id, sha, fileName, parser, text, lineCount, lines.length, createdBy]}];
  for (const line of lines) {
    statements.push({sql: `INSERT INTO bank_statement_lines(org_id,bank_account_id,import_id,line_no,value_date,direction,amount_yen,balance_after_yen,description,dedupe_key)
      VALUES(?,?,${importId},?,?,?,?,?,?,?)`, params: [orgId, account.id, orgId, sha, line.lineNo, line.valueDate, line.direction, line.amountYen,
      line.balanceAfterYen, line.description, line.dedupeKey]});
    statements.push(...bankLineEntryStatements(orgId, account, line, {createdBy, cashAccountId, counterAccountId: suspenseAccountId}));
  }
  statements.push({sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'bank_statement_import', sha, JSON.stringify({bankAccountId: account.id, fileName, lineCount, newLineCount: lines.length})]});
  await db.batch(statements);
}

function bankLineEntryStatements(orgId, account, line, {createdBy, cashAccountId, counterAccountId, memo = null}) {
  const entryId = `(SELECT e.id FROM journal_entries e WHERE e.org_id=? AND e.bank_statement_line_id=${LINE_ID} AND e.reverses_entry_id IS NULL ORDER BY e.id DESC LIMIT 1)`;
  const keyParams = [orgId, orgId, account.id, line.dedupeKey];
  const inbound = line.direction === 'in';
  const rows = [
    {lineNo: 1, side: 'debit', accountId: inbound ? cashAccountId : counterAccountId, bank: inbound},
    {lineNo: 2, side: 'credit', accountId: inbound ? counterAccountId : cashAccountId, bank: !inbound},
  ];
  return [
    {sql: `INSERT INTO journal_entries(org_id,entry_date,source_kind,bank_statement_line_id,line_count,memo,created_by) VALUES(?,?,'bank_line',${LINE_ID},2,?,?)`,
      params: [orgId, line.valueDate, orgId, account.id, line.dedupeKey, memo, createdBy]},
    ...rows.map((r) => ({sql: `INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id) VALUES(?,${entryId},?,?,?,?,?)`,
      params: [orgId, ...keyParams, r.lineNo, r.accountId, r.side, line.amountYen, r.bank ? account.id : null]})),
  ];
}

export async function readStatementLines(db, orgId, bankAccountId) {
  return db.all(`SELECT id,value_date,direction,amount_yen,balance_after_yen,description,dedupe_key FROM bank_statement_lines
    WHERE org_id=? AND bank_account_id=? ORDER BY value_date,id`, [orgId, bankAccountId]);
}

export async function readImports(db, orgId, bankAccountId) {
  return db.all(`SELECT id,file_name,line_count,new_line_count,created_at FROM bank_statement_imports WHERE org_id=? AND bank_account_id=? ORDER BY id DESC`,
    [orgId, bankAccountId]);
}

// 口座の現預金の行と、同じ仕訳の相手の行（科目の名前）
export async function readCashRows(db, orgId, bankAccountId) {
  const cash = await db.all(`SELECT e.id AS entry_id,e.entry_date,e.source_kind,e.reverses_entry_id,e.memo,e.bank_statement_line_id,l.side,l.amount_yen,s.description
    FROM journal_lines l JOIN journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
    LEFT JOIN bank_statement_lines s ON s.org_id=e.org_id AND s.id=e.bank_statement_line_id
    WHERE l.org_id=? AND l.bank_account_id=?`, [orgId, bankAccountId]);
  if (!cash.length) return [];
  const ids = [...new Set(cash.map((r) => Number(r.entry_id)))];
  const counters = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    counters.push(...await db.all(`SELECT l.entry_id,g.id,g.name FROM journal_lines l JOIN gl_accounts g ON g.org_id=l.org_id AND g.id=l.account_id
      WHERE l.org_id=? AND l.bank_account_id IS NULL AND l.entry_id IN (${chunk.map(() => '?').join(',')}) ORDER BY l.entry_id,l.line_no`, [orgId, ...chunk]));
  }
  const byEntry = new Map();
  for (const c of counters) {
    const list = byEntry.get(Number(c.entry_id)) ?? [];
    list.push({id: Number(c.id), name: c.name});
    byEntry.set(Number(c.entry_id), list);
  }
  return cash.map((r) => ({entryId: Number(r.entry_id), entryDate: r.entry_date, sourceKind: r.source_kind,
    reversesEntryId: r.reverses_entry_id == null ? null : Number(r.reverses_entry_id), side: r.side, amountYen: Number(r.amount_yen),
    description: r.description ?? r.memo ?? null, bankLineId: r.bank_statement_line_id == null ? null : Number(r.bank_statement_line_id),
    counterAccounts: byEntry.get(Number(r.entry_id)) ?? []}));
}

export async function readEntry(db, orgId, entryId) {
  const entry = await db.get(`SELECT id,entry_date,source_kind,bank_statement_line_id,reverses_entry_id,line_count,memo FROM journal_entries WHERE org_id=? AND id=?`,
    [orgId, entryId]);
  if (!entry) return null;
  const lines = await db.all('SELECT line_no,account_id,side,amount_yen,bank_account_id,memo FROM journal_lines WHERE org_id=? AND entry_id=? ORDER BY line_no', [orgId, entryId]);
  const reversed = await db.get('SELECT id FROM journal_entries WHERE org_id=? AND reverses_entry_id=?', [orgId, entryId]);
  return {...entry, lines, reversed: Boolean(reversed)};
}

// 項目を付け直す: 元の仕訳の取消（借方と貸方を入れ替えた行）と、新しい相手の科目の仕訳を1回で足す
export async function reclassifyEntry(db, orgId, entry, {counterAccountId, memo, createdBy}) {
  const reversalId = '(SELECT r.id FROM journal_entries r WHERE r.org_id=? AND r.reverses_entry_id=?)';
  const statements = [
    {sql: `INSERT INTO journal_entries(org_id,entry_date,source_kind,bank_statement_line_id,reverses_entry_id,line_count,memo,created_by) VALUES(?,?,?,?,?,?,?,?)`,
      params: [orgId, entry.entry_date, entry.source_kind, entry.bank_statement_line_id, entry.id, entry.line_count, '項目の付け直し', createdBy]},
    ...entry.lines.map((l) => ({sql: `INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id,memo) VALUES(?,${reversalId},?,?,?,?,?,?)`,
      params: [orgId, orgId, entry.id, l.line_no, l.account_id, l.side === 'debit' ? 'credit' : 'debit', l.amount_yen, l.bank_account_id, l.memo]})),
  ];
  const newId = `(SELECT n.id FROM journal_entries n WHERE n.org_id=? AND n.reverses_entry_id IS NULL AND n.id>? AND n.created_by=? ORDER BY n.id DESC LIMIT 1)`;
  statements.push({sql: `INSERT INTO journal_entries(org_id,entry_date,source_kind,bank_statement_line_id,line_count,memo,created_by) VALUES(?,?,?,?,?,?,?)`,
    params: [orgId, entry.entry_date, entry.source_kind, entry.bank_statement_line_id, entry.line_count, memo, createdBy]});
  entry.lines.forEach((l) => {
    statements.push({sql: `INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id,memo) VALUES(?,${newId},?,?,?,?,?,?)`,
      params: [orgId, orgId, entry.id, createdBy, l.line_no, l.bank_account_id == null ? counterAccountId : l.account_id, l.side, l.amount_yen, l.bank_account_id, null]});
  });
  statements.push({sql: AUDIT_INSERT, params: [orgId, createdBy, 'reclassify', 'journal_entry', String(entry.id), JSON.stringify({entryId: entry.id, counterAccountId})]});
  await db.batch(statements);
}

// 明細の無い入出金を手で足す（現金の動き・明細が手に入らない月など）
export async function addManualEntry(db, orgId, account, {date, direction, amountYen, counterAccountId, memo}, {createdBy, cashAccountId}) {
  const entryId = `(SELECT e.id FROM journal_entries e WHERE e.org_id=? AND e.source_kind='manual' AND e.created_by=? ORDER BY e.id DESC LIMIT 1)`;
  const inbound = direction === 'in';
  await db.batch([
    {sql: `INSERT INTO journal_entries(org_id,entry_date,source_kind,line_count,memo,created_by) VALUES(?,?,'manual',2,?,?)`, params: [orgId, date, memo, createdBy]},
    {sql: `INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id) VALUES(?,${entryId},1,?,'debit',?,?)`,
      params: [orgId, orgId, createdBy, inbound ? cashAccountId : counterAccountId, amountYen, inbound ? account.id : null]},
    {sql: `INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id) VALUES(?,${entryId},2,?,'credit',?,?)`,
      params: [orgId, orgId, createdBy, inbound ? counterAccountId : cashAccountId, amountYen, inbound ? null : account.id]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'journal_entry', 'manual', JSON.stringify({bankAccountId: account.id, date, direction})]},
  ]);
}
