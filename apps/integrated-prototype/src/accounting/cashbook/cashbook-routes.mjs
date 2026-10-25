// 入出金の履歴の受け口（会計の最初の組。移行 0045_cashbook。会社ルートの plans/2026-10-22-folder-cashflow.md の「最優先」）。
// 口座ごとに、日付・項目・入出金・残高の累計を仕訳から導き、銀行の明細の残高と照らす。会社の口座と現預金は管理者だけが読み書きする（制作担当と別の組織は 403）。
// 明細の取込は、読めない行が1つでもあれば受け取らない（読めない額を0にしない。docs/rules/money.md）。同じ明細は組織×ハッシュで、重なる行は口座×鍵で二重にしない
import {CASHBOOK_PARSER, MAX_STATEMENT_CHARS, buildHistory, parseDate, parseStatement, reconcile} from './cashbook-model.mjs';
import {addBankAccount, addManualEntry, addStatementImport, ensureHelperAccount, readBankAccount, readBankAccounts, readCashAccount, readCashRows, readEntry,
  readExistingKeys, readGlAccounts, readImportByHash, readImports, readStatementLines, reclassifyEntry, readHelperAccountId} from './cashbook-store.mjs';
import {isUniqueViolation} from '../../data-platform/db-errors.mjs';

const FORBIDDEN = '入出金の履歴は管理者だけが扱えます';
const NO_CASH = '勘定科目「現預金」がありません。PL・BS の画面で初期の勘定科目を作ってから口座を足してください';
const MAX_YEN = 1_000_000_000_000;
const intOf = (value) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : null));

export function registerCashbookRoutes(app, {db, bad, body, sha256}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof sha256 !== 'function') {
    throw new Error('cashbook routes require app, db, bad, body and sha256');
  }

  const admin = (c) => {
    const identity = c.get('identity');
    return identity?.role === 'admin' ? identity : null;
  };
  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }
  async function accountOf(c, identity) {
    const raw = c.req.param('accountId');
    if (!/^\d+$/.test(raw)) return {error: bad(c, '口座の番号を確かめてください', 400)};
    const account = await readBankAccount(db, identity.org_id, Number(raw));
    if (!account) return {error: bad(c, '口座が見つかりません', 404)};
    return {account: {...account, id: Number(account.id), gl_account_id: Number(account.gl_account_id)}};
  }
  async function accountSummary(orgId, account) {
    const suspenseAccountId = await readHelperAccountId(db, orgId, 'suspense');
    const history = buildHistory(await readCashRows(db, orgId, account.id), {suspenseAccountId});
    const statement = (await readStatementLines(db, orgId, account.id)).map((l) => ({id: Number(l.id), valueDate: l.value_date,
      balanceAfterYen: l.balance_after_yen == null ? null : Number(l.balance_after_yen)}));
    return {history, check: reconcile(history, statement), unclassified: history.filter((h) => h.unclassified).length};
  }
  const accountView = (a) => ({id: Number(a.id), label: a.label, bankName: a.bank_name, last4: a.last4, openedOn: a.opened_on});

  // 口座の一覧と、口座ごとの履歴の残高・銀行の残高・差・未分類の件数。項目に選べる勘定科目
  app.get('/api/cashbook', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, FORBIDDEN, 403);
    const orgId = identity.org_id;
    const [cash, accounts, gl] = await Promise.all([readCashAccount(db, orgId), readBankAccounts(db, orgId), readGlAccounts(db, orgId)]);
    const rows = [];
    for (const a of accounts) {
      const {history, check, unclassified} = await accountSummary(orgId, {id: Number(a.id)});
      rows.push({...accountView(a), bookBalanceYen: history.at(-1)?.balanceYen ?? 0, bankBalanceYen: check.bankBalanceYen, bankAsOf: check.asOf,
        diffYen: check.diffYen, unclassified});
    }
    return c.json({ok: true, hasCashAccount: Boolean(cash), accounts: rows,
      items: gl.filter((g) => g.system_key !== 'cash').map((g) => ({id: Number(g.id), code: g.code, name: g.name, section: g.section}))});
  });

  // 口座を足す（開始日と開始残高。開始残高は相手を「開始残高（調整）」にした仕訳になる）
  app.post('/api/cashbook/accounts', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, FORBIDDEN, 403);
    const {input, error} = await readBody(c);
    if (error) return error;
    const label = String(input.label ?? '').trim();
    const bankName = String(input.bankName ?? '').trim() || null;
    const last4 = String(input.last4 ?? '').trim() || null;
    const openedOn = parseDate(input.openedOn);
    const opening = intOf(input.openingBalanceYen ?? 0);
    const errors = [];
    if (!label || label.length > 60) errors.push({field: 'label', message: '口座の名前を60字までで入れてください'});
    if (last4 && !/^\d{4}$/.test(last4)) errors.push({field: 'last4', message: '口座番号は下4桁の数字だけを入れてください'});
    if (!openedOn) errors.push({field: 'openedOn', message: '開始日を入れてください'});
    if (opening == null || Math.abs(opening) > MAX_YEN) errors.push({field: 'openingBalanceYen', message: '開始残高を円の整数で入れてください'});
    if (errors.length) return bad(c, errors[0].message, 400, errors);
    const cash = await readCashAccount(db, identity.org_id);
    if (!cash) return bad(c, NO_CASH, 409);
    try {
      const openingAccountId = opening === 0 ? null : await ensureHelperAccount(db, identity.org_id, 'opening', identity.user_id);
      const row = await addBankAccount(db, identity.org_id, {label, bankName, last4, glAccountId: Number(cash.id), openedOn, openingBalanceYen: opening},
        {createdBy: identity.user_id, openingAccountId});
      return c.json({ok: true, id: Number(row.id)}, 201);
    } catch (e) {
      if (isUniqueViolation(e, 'bank_accounts')) return bad(c, '同じ名前の口座があります', 409);
      throw e;
    }
  });

  // 口座の履歴（日付・項目・入出金・残高の累計）、銀行の残高との照合、取り込んだ明細の一覧
  app.get('/api/cashbook/accounts/:accountId', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, FORBIDDEN, 403);
    const {account, error} = await accountOf(c, identity);
    if (error) return error;
    const {history, check, unclassified} = await accountSummary(identity.org_id, account);
    const imports = (await readImports(db, identity.org_id, account.id)).map((i) => ({id: Number(i.id), fileName: i.file_name, lineCount: Number(i.line_count),
      newLineCount: Number(i.new_line_count), createdAt: i.created_at}));
    return c.json({ok: true, account: accountView(account), history, check, unclassified, imports});
  });

  async function prepareImport(c, identity, account) {
    const {input, error} = await readBody(c);
    if (error) return {error};
    const text = typeof input.text === 'string' ? input.text : '';
    const fileName = String(input.fileName ?? '').trim().slice(0, 240) || '明細.csv';
    if (!text) return {error: bad(c, 'CSV の中身がありません', 400)};
    if (text.length > MAX_STATEMENT_CHARS) return {error: bad(c, 'CSV が大きすぎます', 413)};
    const parsed = parseStatement(text);
    const existing = await readExistingKeys(db, identity.org_id, account.id);
    const fresh = parsed.lines.filter((l) => !existing.has(l.dedupeKey));
    const sha = await sha256(text);
    const already = await readImportByHash(db, identity.org_id, sha);
    return {text, fileName, parsed, fresh, sha, already};
  }

  // 取り込む前の下見（読めた行・新しい行・重なって数えない行・読めない行）
  app.post('/api/cashbook/accounts/:accountId/preview', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, FORBIDDEN, 403);
    const {account, error} = await accountOf(c, identity);
    if (error) return error;
    const prepared = await prepareImport(c, identity, account);
    if (prepared.error) return prepared.error;
    const {parsed, fresh, already} = prepared;
    return c.json({ok: true, columns: parsed.columns, errors: parsed.errors, lineCount: parsed.lines.length, newLineCount: fresh.length,
      duplicateCount: parsed.lines.length - fresh.length, alreadyImported: already ? {fileName: already.file_name, createdAt: already.created_at} : null,
      lines: parsed.lines.slice(0, 500).map((l) => ({...l, isNew: fresh.some((f) => f.dedupeKey === l.dedupeKey)}))});
  });

  // 取り込む。新しい行ごとに、相手を「未分類（仮勘定）」にした仕訳を作る（履歴の残高がすぐ銀行の残高に合う。項目はあとで付ける）
  app.post('/api/cashbook/accounts/:accountId/imports', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, FORBIDDEN, 403);
    const {account, error} = await accountOf(c, identity);
    if (error) return error;
    const prepared = await prepareImport(c, identity, account);
    if (prepared.error) return prepared.error;
    const {text, fileName, parsed, fresh, sha, already} = prepared;
    if (already) return bad(c, `同じ明細は受け取り済みです（${already.file_name}）`, 409);
    if (parsed.errors.length) return bad(c, `読めない行が ${parsed.errors.length} 行あります。直してから取り込んでください`, 400, parsed.errors.slice(0, 50));
    const suspenseAccountId = await ensureHelperAccount(db, identity.org_id, 'suspense', identity.user_id);
    try {
      await addStatementImport(db, identity.org_id, account, {sha, fileName, parser: CASHBOOK_PARSER, text, lineCount: parsed.lines.length, lines: fresh},
        {createdBy: identity.user_id, cashAccountId: account.gl_account_id, suspenseAccountId});
    } catch (e) {
      if (isUniqueViolation(e, 'bank_statement_imports')) return bad(c, '同じ明細は受け取り済みです', 409);
      if (isUniqueViolation(e, 'bank_statement_lines')) return bad(c, 'ほかの画面で同じ行が取り込まれました。もう一度取り込んでください', 409);
      throw e;
    }
    return c.json({ok: true, lineCount: parsed.lines.length, newLineCount: fresh.length, duplicateCount: parsed.lines.length - fresh.length}, 201);
  });

  // 項目を付ける・付け直す（元の仕訳を取り消し、相手の科目を変えた仕訳を足す）
  app.post('/api/cashbook/entries/:entryId/classify', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, FORBIDDEN, 403);
    const raw = c.req.param('entryId');
    if (!/^\d+$/.test(raw)) return bad(c, '仕訳の番号を確かめてください', 400);
    const {input, error} = await readBody(c);
    if (error) return error;
    const counterAccountId = intOf(input.accountId);
    const memo = String(input.memo ?? '').trim().slice(0, 300) || null;
    const entry = await readEntry(db, identity.org_id, Number(raw));
    if (!entry) return bad(c, '仕訳が見つかりません', 404);
    if (entry.reverses_entry_id != null || entry.reversed) return bad(c, 'この仕訳はもう取り消されています。読み直してください', 409);
    if (entry.source_kind === 'opening') return bad(c, '開始残高の仕訳は項目を変えられません', 400);
    if (Number(entry.line_count) !== 2 || entry.lines.filter((l) => l.bank_account_id != null).length !== 1) return bad(c, 'この仕訳は項目を付け直せない形です', 400);
    const gl = await readGlAccounts(db, identity.org_id);
    const target = gl.find((g) => Number(g.id) === counterAccountId);
    if (!target || target.system_key === 'cash') return bad(c, '項目（勘定科目）を選んでください', 400);
    try {
      await reclassifyEntry(db, identity.org_id, entry, {counterAccountId, memo, createdBy: identity.user_id});
    } catch (e) {
      if (isUniqueViolation(e, 'journal_entries')) return bad(c, 'ほかの画面で項目が付け直されました。読み直してください', 409);
      throw e;
    }
    return c.json({ok: true}, 201);
  });

  // 明細の無い入出金を手で足す
  app.post('/api/cashbook/accounts/:accountId/manual', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, FORBIDDEN, 403);
    const {account, error} = await accountOf(c, identity);
    if (error) return error;
    const {input, error: bodyError} = await readBody(c);
    if (bodyError) return bodyError;
    const date = parseDate(input.date);
    const direction = input.direction === 'in' || input.direction === 'out' ? input.direction : null;
    const amountYen = intOf(input.amountYen);
    const counterAccountId = intOf(input.accountId);
    const memo = String(input.memo ?? '').trim().slice(0, 300) || null;
    if (!date || !direction || amountYen == null || amountYen <= 0 || amountYen > MAX_YEN) return bad(c, '日付・入金か出金・額（正の整数の円）を入れてください', 400);
    const gl = await readGlAccounts(db, identity.org_id);
    const target = gl.find((g) => Number(g.id) === counterAccountId);
    if (!target || target.system_key === 'cash') return bad(c, '項目（勘定科目）を選んでください', 400);
    await addManualEntry(db, identity.org_id, account, {date, direction, amountYen, counterAccountId, memo}, {createdBy: identity.user_id, cashAccountId: account.gl_account_id});
    return c.json({ok: true}, 201);
  });
}
