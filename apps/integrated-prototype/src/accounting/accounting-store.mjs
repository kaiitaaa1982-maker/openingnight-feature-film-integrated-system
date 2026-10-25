// 会計（accounting）の領域の DB の読み書き。いまは作品の月別収支（accounting/work-income/）と作品別収支（work-pnl-report-routes.mjs）、
// 会社への利益額（accounting/profit/。フェーズ1 #14b。自社出資の払込は行動指標の計画 段B #4 の稟議の版から）と、その源泉別の内訳（同じ計画 段B #2）が使う読み取りだけを置く。
// 作品・売上明細・売上報告・商品の配賦・経費・出金・委員会の払込はまだ領域フォルダへ移していない古い形の表なので、ここから直接読む
// （docs/rules/architecture.md の「ほかの領域の表」）。案件・稼ぎ方（企画）と入金の消込（売上）は、その領域の store の文を使う。どの読み取りも組織（org_id）で絞る。
import {expenseSource, expenseAccountStatements, applyExpenseAccounts} from '../expense-sheet/expense-read.mjs';
import {contractMilestonesStatement, earningTypesWithDefaultRatesStatement, investmentApprovalVersionsStatement, ownInvestmentPaymentsSelect,
  ownInvestmentUnpaidCountSubquery, projectRevenueBasesStatement, revenueClassInputsFromRows} from '../planning/planning-store.mjs';
import {receiptLinesStatement} from '../revenue/revenue-store.mjs';
import {allIn} from '../sql-in.mjs';

// 組織の作品と、その案件（見てよい作品の判定に使う）
export async function listWorkProjects(db, orgId) {
  return db.all('SELECT id,project_id FROM works WHERE org_id=?', [orgId]);
}

// 有効な売上明細（売上報告に属さない手入力の明細と、有効な報告の明細）。accountingMonth を渡すとその計上月だけ
export async function listActiveSaleLines(db, orgId, accountingMonth = null) {
  return db.all(`SELECT s.* FROM sale_lines s LEFT JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=? AND (s.report_id IS NULL OR r.status='active') ${accountingMonth ? 'AND s.accounting_month=?' : ''}`, accountingMonth ? [orgId, accountingMonth] : [orgId]);
}

// 商品の作品への配賦（作品 ID の順）
export async function listProductWorkShares(db, orgId) {
  return db.all('SELECT * FROM product_works WHERE org_id=? ORDER BY work_id', [orgId]);
}

// 取消を除いた経費（expense-sheet/expense-read.mjs の expenseSource）。accountingMonth を渡すとその計上月だけ
export async function listActiveExpenses(db, orgId, accountingMonth = null) {
  return db.all(`SELECT * FROM ${expenseSource()} WHERE org_id=? ${accountingMonth ? 'AND accounting_month=?' : ''}`, accountingMonth ? [orgId, accountingMonth] : [orgId]);
}

const WORK_PNL_SALE_SELECT = `SELECT s.id, s.work_id, s.product_id, s.partner_id, s.report_id, s.source_row, s.description, s.quantity,
      s.accounting_month, s.amount_ex_tax, r.kind, r.report_key,
      p.name AS partner_name, p.code AS partner_code, pr.sku AS product_sku, pr.name AS product_name,
      d.distribution_code, d.settlement_method
    FROM sale_lines s
    JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
    LEFT JOIN products pr ON pr.org_id=s.org_id AND pr.id=s.product_id
    LEFT JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id
      AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
    WHERE s.org_id=? AND r.status='active'`;

// 作品別収支の売上明細（有効な報告の明細に、取引先・商品・最新の流通の版を付ける。ID の順）。作品への配賦は呼び出し側。
// 計上月の期間（from・to）で読む。saleIds を渡すとその明細だけを計上月によらず読む（入金ベースの入金の行の元。組織の全期間の売上明細を読まない）
export async function listWorkPnlSaleLines(db, orgId, {from, to, saleIds = null}) {
  if (saleIds) return allIn(db, `${WORK_PNL_SALE_SELECT} AND s.id IN (:in)`, {before: [orgId], ids: saleIds, sortBy: (a, b) => a.id - b.id});
  return db.all(`${WORK_PNL_SALE_SELECT} AND s.accounting_month BETWEEN ? AND ?
    ORDER BY s.id`, [orgId, from, to]);
}

// ---------- 会社への利益額（K-16。フェーズ1 #14b）が読むもの ----------
// scope は受け口が渡す「財務の権限で見てよい案件」の副問い合わせ（src/app.mjs の permittedProjectScope(identity, true)。案件 ID を値として並べない）。
// months は月の期間（{from, to}。YYYY-MM。片方だけなら反対の端を開く）で、渡すと軸の月を決める日付（計上月・取消日・入金日・出金日・払込日）が
// その間に入る記録だけを読む（期間外の全期間の記録を読まない）。null は全期間で、条件を付けない
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export function profitMonths({from = null, to = null} = {}) {
  if (from === null && to === null) return null;
  for (const value of [from, to]) if (value !== null && !MONTH.test(value)) throw new Error(`会社への利益額の期間は YYYY-MM で渡します: ${value}`);
  return {from: from ?? '0000-01', to: to ?? '9999-12'};
}
const monthRange = (months) => (months ? [months.from, months.to] : []);

// 組織の案件の数（見てよい案件と同じ数なら会社全体を見てよい）と、会社の法人情報の最新の版の自社の取引先（委員会への払込のうち自社の分を決める）と、
// 見てよい案件のうち稟議の払込の版が1つも無い自社出資の案件の数（利益額の注記。稟議の表は企画の store の副問い合わせ）
function profitOrgFactsStatement(orgId, scope) {
  const unpaid = ownInvestmentUnpaidCountSubquery(orgId, scope);
  return {sql: `SELECT (SELECT COUNT(*) FROM projects x WHERE x.org_id=?) AS project_count,
      (SELECT pv.self_partner_id FROM org_profile_versions pv WHERE pv.org_id=? ORDER BY pv.version_no DESC LIMIT 1) AS self_partner_id,
      ${unpaid.sql} AS own_investment_unpaid_count`, params: [orgId, orgId, ...unpaid.params]};
}

// 計上の売上の元（有効な報告の売上明細と、報告に属さない手入力の明細）に、商品の作品への配賦の行と、その作品の案件を付ける（明細×配賦の行）。
// 見てよい案件の作品の明細か、見てよい案件の作品へ配賦する商品の明細だけを読む（配賦の端数は全部の配賦先で決めるので、配賦の行は全部読む）
function accrualSaleLinesStatement(orgId, scope, months) {
  return {sql: `SELECT s.id AS sale_id,s.accounting_month,s.amount_ex_tax,s.partner_id,s.product_id,s.work_id,w.project_id,
      pw.work_id AS share_work_id,pw.allocation_bps AS share_bps,sw.project_id AS share_project_id
    FROM sale_lines s
    JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id
    LEFT JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    LEFT JOIN product_works pw ON pw.org_id=s.org_id AND pw.product_id=s.product_id
    LEFT JOIN works sw ON sw.org_id=pw.org_id AND sw.id=pw.work_id
    WHERE s.org_id=? AND (s.report_id IS NULL OR r.status='active')
      AND (w.project_id IN (${scope.sql}) OR s.product_id IN (SELECT pw2.product_id FROM product_works pw2 JOIN works w2 ON w2.org_id=pw2.org_id AND w2.id=pw2.work_id
        WHERE pw2.org_id=? AND w2.project_id IN (${scope.sql})))${months ? `
      AND s.accounting_month BETWEEN ? AND ?` : ''}
    ORDER BY s.id,pw.work_id`, params: [orgId, ...scope.params, orgId, ...scope.params, ...monthRange(months)]};
}

// 見てよい案件の経費（取消を含む。取消日 expense_voided_on）と、その出金（取消の行つき）・出金の源泉の控除額（経費×出金の行。出金の無い経費は出金の列が NULL）。
// 期間を渡すと、計上月・取消日・出金日のどれかが期間に入る経費だけを読み、その経費の出金は期間によらず全部読む（出金の取消の税抜は元の出金で決めるため）
function expensesWithPaymentsStatement(orgId, scope, months) {
  return {sql: `SELECT e.id,e.project_id,e.work_id,e.category,e.accounting_month,e.actual_ex_tax,e.tax_amount,e.actual_inc_tax,e.expense_voided_on,
      p.id AS payment_id,p.paid_on,p.amount_yen AS payment_yen,p.reverses_id AS payment_reverses_id,a.withheld_yen
    FROM ${expenseSource({history: true})} e
    LEFT JOIN expense_payments p ON p.org_id=e.org_id AND p.expense_id=e.id
    LEFT JOIN expense_payment_accounting a ON a.org_id=p.org_id AND a.payment_id=p.id
    WHERE e.org_id=? AND e.project_id IN (${scope.sql})${months ? `
      AND (e.accounting_month BETWEEN ? AND ? OR substr(e.expense_voided_on,1,7) BETWEEN ? AND ?
        OR EXISTS (SELECT 1 FROM expense_payments q WHERE q.org_id=e.org_id AND q.expense_id=e.id AND substr(q.paid_on,1,7) BETWEEN ? AND ?))` : ''}
    ORDER BY e.id,p.id`, params: [orgId, ...scope.params, ...monthRange(months), ...monthRange(months), ...monthRange(months)]};
}

// 払った月に引く出資の払込（J-11b (a)）を1つの文で読む（SQL の数を10本以内に保つ）。source で分ける:
// - committee: 見てよい案件の作品の製作委員会への払込のうち、自社（会社の法人情報の最新の版の自社の取引先）の払込（取消の行は負の額で取消日に）
// - own_investment: 見てよい案件の稟議の払込の版（行動指標の計画 段B #4。企画の store の SELECT。取消の行は無い）
function investmentPaymentsStatement(orgId, scope, months) {
  const own = ownInvestmentPaymentsSelect(orgId, scope, months);
  return {sql: `SELECT 'committee' AS source,p.id,p.paid_on,p.amount_yen,p.reverses_id,c.project_id,c.work_id,NULL AS approval_no,NULL AS version_no
    FROM committee_investment_payments p
    JOIN committee_term_versions v ON v.org_id=p.org_id AND v.id=p.term_version_id
    JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id
    WHERE p.org_id=? AND p.partner_id=(SELECT pv.self_partner_id FROM org_profile_versions pv WHERE pv.org_id=? ORDER BY pv.version_no DESC LIMIT 1)
      AND c.project_id IN (${scope.sql})${months ? `
      AND substr(p.paid_on,1,7) BETWEEN ? AND ?` : ''}
    UNION ALL
    ${own.sql}
    ORDER BY source,id,project_id,approval_no,version_no`, params: [orgId, orgId, ...scope.params, ...monthRange(months), ...own.params]};
}

function checkScope(scope, name) {
  if (!scope || typeof scope.sql !== 'string' || !Array.isArray(scope.params)) throw new Error(`${name} は見てよい案件の副問い合わせ（scope）で呼んでください`);
}

// 会社への利益額が読む10文（読み取りの一括に入れる順）。months は profitMonths の値
function profitSourceStatements(orgId, scope, months) {
  return [
    earningTypesWithDefaultRatesStatement(orgId),
    projectRevenueBasesStatement(orgId, scope),
    profitOrgFactsStatement(orgId, scope),
    receiptLinesStatement(orgId, scope, months),
    accrualSaleLinesStatement(orgId, scope, months),
    expensesWithPaymentsStatement(orgId, scope, months),
    ...expenseAccountStatements(orgId),
    investmentPaymentsStatement(orgId, scope, months),
  ];
}

// 会社への利益額が読むものを1回の読み取りの一括（10文。同じ時点）で読む。返り値は src/accounting/profit/profit-model.mjs の
// profitRecordsFromSources が記録へ直す形。経費には費用区分（勘定科目）を付けて返す（expense-read の applyExpenseAccounts。PL と同じ対応）。
// from・to（YYYY-MM）を渡すと、売上明細・入金・経費・払込を期間で絞って読む（profitMonths）
export async function readProfitSources(db, orgId, {scope, from = null, to = null}) {
  checkScope(scope, 'readProfitSources');
  return profitSourcesFromRows(await db.readBatch(profitSourceStatements(orgId, scope, profitMonths({from, to}))));
}

// 組織の集計と経費の対応3種を、種別つきの1文で読む。
// 各領域のstoreが作る文を使い、行どうしをJOINして件数を掛け合わせない。
function sourceProfitFactsStatement(orgId, scope) {
  const reads = [profitOrgFactsStatement(orgId, scope), ...expenseAccountStatements(orgId)];
  const fields = [
    ['project_count', 'self_partner_id', 'own_investment_unpaid_count'],
    ['expense_id', 'version_no', 'active', 'category_version_id'],
    ['alias_text', 'version_no', 'active', 'category_version_id'],
    ['id', 'account_id', 'account_name', 'section', 'system_key', 'recognition_timing'],
  ];
  const columns = [...new Set(fields.flat())];
  const strings = new Set(['alias_text', 'account_name', 'section', 'system_key', 'recognition_timing']);
  return {
    sql: reads.map((read, i) => `SELECT ${i} AS read_kind, ${columns.map((column) =>
      `${fields[i].includes(column) ? `r.${column}` : strings.has(column) ? 'CAST(NULL AS TEXT)' : 'CAST(NULL AS INTEGER)'} AS ${column}`).join(', ')}
      FROM (${read.sql}) r`).join('\nUNION ALL\n'),
    params: reads.flatMap((read) => read.params),
  };
}

// 源泉別の利益額（行動指標の計画 段B #2。導き方は src/accounting/profit/source-profit-model.mjs）が読むものを、1回の読み取りの一括（9文。同じ時点）で読む:
// 会社への利益額の10文（profit。readProfitSources と同じ形）に、源泉1の受託制作の最新の契約の版の節目（企画の store の文）と、源泉2の稟議の版の全部
// （企画の store の文）を足す。どの文も見てよい案件の副問い合わせ（scope）で絞るので、案件・稟議の数によらず文の数は同じ。
// 期間の始まりでは絞らない（出資の回収は全期間の累計）。to（YYYY-MM）を渡すと、それより後の売上明細・入金・経費・払込を読まない（受け口は締めた月を渡す）。
// 源泉1の案件の行は利益額の案件の行（projectRevenueBasesStatement。型・稼ぎ方・利益の源泉・段階・最新の契約の版の列を持つ）から作り、
// planning-store の readContractWorkSourceRows と同じ形（projects・milestones）で返す。源泉2の案件は readInvestmentApprovals と同じ形で返す
export async function readSourceProfitSources(db, orgId, {scope, to = null}) {
  checkScope(scope, 'readSourceProfitSources');
  const profitStatements = profitSourceStatements(orgId, scope, profitMonths({from: null, to}));
  const [earningTypes, projects, factsAndAccounts, receipts, sales, expenses, payments, milestoneRows, versionRows] = await db.readBatch([
    profitStatements[0], profitStatements[1], sourceProfitFactsStatement(orgId, scope),
    ...profitStatements.slice(3, 6), profitStatements.at(-1),
    contractMilestonesStatement(orgId, scope), investmentApprovalVersionsStatement(orgId, scope),
  ]);
  const groups = [0, 1, 2, 3].map((kind) => factsAndAccounts.filter((row) => Number(row.read_kind) === kind));
  // applyExpenseAccountsは版番号の順から最新の版を選ぶため、UNIONの応答順に依存させない。
  groups[1].sort((a, b) => Number(a.version_no) - Number(b.version_no));
  groups[2].sort((a, b) => Number(a.version_no) - Number(b.version_no));
  const profit = profitSourcesFromRows([earningTypes, projects, groups[0], receipts, sales, expenses, ...groups.slice(1), payments]);
  const contractProjects = profit.projectRows.filter((row) => row.project_type === 'contract_production').map((row) => ({
    project_id: row.id, code: row.code, title: row.title, earning_type: row.earning_type ?? null, profit_source: row.profit_source ?? null,
    stage_code: row.stage_code ?? null, version_no: row.contract_version_no ?? null, budget_yen: row.contract_budget_yen ?? null,
    markup_bps: row.contract_markup_bps ?? null, fee_yen: row.contract_fee_yen ?? null, milestone_count: row.contract_milestone_count ?? null,
  }));
  const withVersions = new Set(versionRows.map((row) => Number(row.project_id)));
  const approvalProjects = profit.projectRows.filter((row) => row.earning_type === 'own_investment' || withVersions.has(Number(row.id)))
    .map((row) => ({id: row.id, code: row.code, title: row.title, earning_type: row.earning_type ?? null}));
  return {profit, contractWork: {projects: contractProjects, milestones: milestoneRows}, approvals: {projects: approvalProjects, versions: versionRows}};
}

// profitSourceStatements の10文の結果を、readProfitSources の返り値の形にする
function profitSourcesFromRows([earningTypeRows, projectRows, [facts], receiptRows, saleRows, expenseRows, ...rest]) {
  const paymentRows = rest.pop();
  return {
    earningTypes: earningTypeRows,
    projectRows,
    revenueClassInputs: revenueClassInputsFromRows({earningTypeRows, projectRows}),
    projectCount: Number(facts?.project_count ?? 0),
    selfPartnerId: facts?.self_partner_id === null || facts?.self_partner_id === undefined ? null : Number(facts.self_partner_id),
    ownInvestmentUnpaidCount: Number(facts?.own_investment_unpaid_count ?? 0),
    receiptRows,
    saleRows,
    expenseRows: applyExpenseAccounts(expenseRows, rest),
    committeePaymentRows: paymentRows.filter((row) => row.source === 'committee'),
    ownInvestmentPaymentRows: paymentRows.filter((row) => row.source === 'own_investment'),
  };
}
