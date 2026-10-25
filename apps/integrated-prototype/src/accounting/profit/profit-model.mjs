// 会社への利益額（K-16）の純関数（フェーズ1の仕様書 #14b。要件 docs/requirements/accounting/company-profit.md）。
// 利益額＝売上（入金×売上率。計上の基準は計上の売上×売上率）− 案件の経費。税別。給与は引かない（D-039 の 2026-10-09 の追記2）。
// - 基準（basis）は accrual（計上）と cash（入金）で切り替える。語と見出しは reports/pl-bs-cash-model.mjs と同じ（フェーズ1 #16）
// - 自社出資の出資額・製作委員会の出資額（自社の分）・買付の MG・買い切りの買付額の4費目は、計上・入金とも払った月に引く（J-11b (a)）。
//   自社出資の出資額は稟議の払込の版（移行 0019。行動指標の計画 段B #4）の払った日と額
// - 費目ごとに 確定・未確定・除外 を持ち、利益額に入れるのは確定だけ。未確定（U-5・U-4 の残りと、負担者・費用区分の記録が無いもの）は
//   別の行に出し、除外（引かないと決まったもの）も別の行に出す。記録の形がまだ無い費目は「未接続」として額を出さない（0円で埋めない）
// - 入金を案件に結ぶ規則は revenue/yojitsu/receipt-inflow-model.mjs の linkReceiptsToProjects（消込 → 請求明細の作品の配賦 → 作品の案件）。
//   結べない入金・売上明細は『案件不明』の行に出して売上に数えない。作品の無い案件の売上は「未確定」（U-9・U-5）
// - 売上率を掛けた額は、基準×月×案件×費目ごとに税別の額を足してから1回だけ truncate（signedRateAmount。FR-REV-YOJITSU-004 と同じ）
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）
import {signedRateAmount} from '../../royalty/royalty-model.mjs';
import {splitByAllocation} from '../../money-allocation.mjs';
import {sumOf, monthOfDate} from '../../reports/pl-bs-model.mjs';
import {basisFields, cashExpenseParts, BASES} from '../../reports/pl-bs-cash-model.mjs';
import {linkReceiptsToProjects} from '../../revenue/yojitsu/receipt-inflow-model.mjs';
import {acquisitionTermsOf, revenueClassBases} from '../../revenue/revenue-class/revenue-class-model.mjs';

export const PROFIT_FORMULA = '利益額＝売上（入金×売上率。計上の基準は計上の売上×売上率）− 案件の経費（K-16）';
export const TAX_LABEL = '税別';

// 額の中身（行ごとに出す。税込や率を掛ける前の額を、確定の税別の額と取り違えないため）
export const AMOUNT_KINDS = Object.freeze({
  rate_applied: '税別×売上率',
  before_rate: '税別（売上率を掛ける前）',
  ex_tax: '税別',
  inc_tax: '税込（税抜にできない）',
  paid: '払った額（出資・買付。不課税の額）',
});

// 費目。side: sales（売上率を掛けて足す）・cost（引く）。status: settled（確定。利益額に入れる）・unsettled（未確定）・excluded（除外）。
// 並びは golden（test/fixtures/yojitsu/golden.py の ITEMS）と同じ順に、記録の形から出る費目を足した
export const PROFIT_ITEMS = Object.freeze([
  {key: 'sales', label: '売上', side: 'sales', status: 'settled', amountKind: 'rate_applied',
    reason: 'K-16: 入金（計上は計上の売上）×案件の売上率'},
  {key: 'sales_withholding', label: '売上（源泉のある取引先）', side: 'sales', status: 'unsettled', amountKind: 'rate_applied',
    reason: 'U-5 の残り（源泉と税込）。外国で源泉される契約の取引先の売上'},
  {key: 'sales_no_work', label: '売上（作品の無い案件）', side: 'sales', status: 'unsettled', amountKind: 'rate_applied',
    reason: '#14b（U-9・U-5）。作品の無い案件の入金'},
  {key: 'sales_no_rate', label: '売上（売上率の決まらない案件）', side: 'sales', status: 'unsettled', amountKind: 'before_rate',
    reason: '案件の売上率が決まらない（稼ぎ方・既定の売上率・受託制作の契約の版が無い）。率を掛ける前の税別の額'},
  {key: 'sales_amount_differs', label: '売上（請求額と違う額の入金）', side: 'sales', status: 'unsettled', amountKind: 'inc_tax',
    reason: 'U-5 の残り（入金の税抜の出し方）。源泉・手数料・一部入金などで請求額と違う額の入金は税抜にできず、税込のまま出す'},
  {key: 'own_investment', label: '自社出資の出資額', side: 'cost', status: 'settled', amountKind: 'paid',
    reason: 'J-11b (a): 払った月に引く。稟議の払込の版の払った日と額'},
  {key: 'committee_investment', label: '製作委員会の出資額（自社の分）', side: 'cost', status: 'settled', amountKind: 'paid',
    reason: 'J-11b (a): 払った月に引く。委員会への自社の払込'},
  {key: 'acquisition_mg', label: '買付の MG', side: 'cost', status: 'settled', amountKind: 'paid',
    reason: 'J-11b (a): 払った月に引く。権利元の取り分から回収した分は戻す'},
  {key: 'acquisition_buyout', label: '買い切りの買付額', side: 'cost', status: 'settled', amountKind: 'paid',
    reason: 'J-11b (a)・J-9 (c): 払った月に引く'},
  {key: 'promotion_self', label: '宣伝費（負担者 自社）', side: 'cost', status: 'settled', amountKind: 'ex_tax',
    reason: 'K-16: 案件の経費（P&A。負担者が自社）'},
  {key: 'distribution_self', label: '配給費（負担者 自社）', side: 'cost', status: 'unsettled', amountKind: 'ex_tax',
    reason: 'U-4（配給費の会計の科目）。#24 は配給費の科目を U-4 まで「未確定」とするので、負担者が自社の額も別の行に出す'},
  {key: 'promotion_other', label: '宣伝費（負担者 自社以外）', side: 'cost', status: 'unsettled', amountKind: 'ex_tax',
    reason: 'U-4 R-d・R-f（#24）。負担者が配給会社・委員会・出資の P&A を引くか'},
  {key: 'distribution_other', label: '配給費（負担者 自社以外）', side: 'cost', status: 'unsettled', amountKind: 'ex_tax',
    reason: 'U-4 R-d・R-f（#24）。負担者が配給会社・委員会・出資の P&A を引くか'},
  {key: 'promotion_unregistered', label: '宣伝費（負担者 未登録）', side: 'cost', status: 'unsettled', amountKind: 'ex_tax',
    reason: 'P&A の負担者の記録（#24）が無く、自社の負担か決められない（K-12）'},
  {key: 'distribution_unregistered', label: '配給費（負担者 未登録）', side: 'cost', status: 'unsettled', amountKind: 'ex_tax',
    reason: 'U-4（配給費の会計の科目）と、P&A の負担者の記録（#24）が無いこと'},
  {key: 'production_expense', label: '費用区分「制作費」の経費', side: 'cost', status: 'unsettled', amountKind: 'ex_tax',
    reason: 'U-5 の残り（費用区分「制作費」の経費）'},
  {key: 'project_expense', label: '案件の経費（ほかの費用区分）', side: 'cost', status: 'settled', amountKind: 'ex_tax',
    reason: 'K-16: 案件の経費（制作費・宣伝費・配給費のほかの費用区分の科目に対応した経費）'},
  {key: 'unclassified_expense', label: '費用区分の決まらない経費', side: 'cost', status: 'unsettled', amountKind: 'ex_tax',
    reason: '費目が費用区分（勘定科目）に対応していない（費用区分未整備）。どの費目か決められない'},
  {key: 'expense_amount_differs', label: '出金（経費の税込額と違う額）', side: 'cost', status: 'unsettled', amountKind: 'inc_tax',
    reason: 'U-5 の残り（出金の税抜の出し方）。分割払い・源泉の控除の記録が無い出金などは税抜にできず、出金の額のまま出す'},
  {key: 'contract_production_cost', label: '制作の実費', side: 'cost', status: 'excluded', amountKind: 'ex_tax',
    reason: 'J-14 (a): 受託は受託費の純額で、制作の実費は粗利に入れない'},
  {key: 'contract_production_cost_amount_differs', label: '制作の実費（税込額と違う額の出金）', side: 'cost', status: 'excluded', amountKind: 'inc_tax',
    reason: 'J-14 (a): 制作の実費は粗利に入れない。税込額と違う額の出金（分割払いなど）は税抜にできず、出金の額のまま「制作の実費」（税別）と別の行に出す'},
]);
// 入金の基準で、税込額と違う額の出金を置く費目（除外の費目は除外のまま、税込の別の行へ。ほかは未確定の「出金（経費の税込額と違う額）」）
const AMOUNT_DIFFERS_ITEM = Object.freeze({contract_production_cost: 'contract_production_cost_amount_differs'});
const ITEM = new Map(PROFIT_ITEMS.map((item) => [item.key, item]));
export const STATUS_LABELS = Object.freeze({settled: '確定', unsettled: '未確定', excluded: '除外', unconnected: '未接続'});

// 記録の形がまだ無い（読めない）ときの理由。記録の一覧が null で渡ると「未接続」の行に出す（[] は記録が0件で、未接続ではない）
export const UNCONNECTED_REASONS = Object.freeze({
  ownInvestmentPayments: {item: 'own_investment', reason: '自社出資の払込の日と額の記録（稟議の払込の版。移行 0019）を読んでいない（作品の費用の版の出資額は払込の日を持たない）'},
  committeeInvestmentPayments: {item: 'committee_investment', reason: '会社の法人情報に自社の取引先が無く、委員会への払込のうち自社の分を決められない'},
  mgPayments: {item: 'acquisition_mg', reason: '権利元への支払の記録（rights_payment_events）は日と額を持つが、MG の前払いと回収のあとの分配を分けないので、買付の MG の支払と決められない（出どころは要件の要確認9。行動指標の計画 #6）'},
  buyoutPayments: {item: 'acquisition_buyout', reason: '買い切りの買付額を払った日を持つ記録が無い（作品の費用の版の買付額は日を持たない。行動指標の計画 #6）'},
});

// 案件に結べない入金・売上明細の理由
export const UNKNOWN_REASONS = Object.freeze({
  allocation_incomplete: {label: '作品を決められない入金', amountKind: 'inc_tax', note: '請求明細の作品の配賦がそろわない消込（税込）'},
  product_allocation_incomplete: {label: '作品へ分けられない売上明細', amountKind: 'ex_tax', note: '商品の作品への配賦の和が 100% でない売上明細（税別）'},
  no_project: {label: '案件の無い入金', amountKind: 'ex_tax', note: '請求の無い入金・支援金など、案件に結ぶ記録の無い入金（税別）'},
});

export const PROFIT_RULES = Object.freeze([
  '利益額＝売上 − 案件の経費（K-16。D-039 の 2026-10-09 の追記2）。税別。給与は引かない',
  '入金の基準（cash）: 売上は請求の入金の入金日の月（消込 → 請求明細の作品の配賦 → 作品の案件）の税別の額×案件の売上率。経費は出金日の月（未払の経費は入れない）',
  '計上の基準（accrual）: 売上は売上明細の計上月の税別の額（商品は作品への配賦で分ける）×案件の売上率。経費は計上月（取り消した経費は取消日の月に負の額）',
  'J-11b (a) の4費目（自社出資の出資額・製作委員会の出資額・買付の MG・買い切りの買付額）は、計上・入金とも払った月に引く。自社出資の出資額は稟議の払込の版の払った日と額',
  '売上率を掛けた額は、基準×月×案件×費目ごとに税別の額を足してから1回だけ 0 に向かって切り捨てる（signedRateAmount と同じ）。使う率は案件のいまの率（稼ぎ方の既定・案件の率・受託制作の最新の契約の版）',
  '入金の税抜の出し方は U-5 の残り。請求どおりの額の入金だけを、消込で結んだ請求明細の税抜額で数え、違う額の入金は税込のまま「未確定」に出す（FR-REV-YOJITSU-032 と同じ仮の出し方）',
  '照合するのは状態が「確定」の費目だけ。「未確定」は答えか記録が出るまで別の行に出す額、「除外」は引かないと決まった額、「未接続」は記録の形が無く額を出せない費目',
  '月の軸は、計上・入金のどちらかで記録のある月（基準を切り替えても同じ列）。軸の月で記録の無い費目の額は 0',
]);

const monthOf = (value) => String(value ?? '').slice(0, 7);
const isMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));
const num = (value) => (value === null || value === undefined ? null : Number(value));
// 案件コードの並び（文字の符号の順。BMP の文字ではコードポイントの順で、golden〈Python の sorted〉と同じ。localeCompare と違い、
// 実行環境の ICU・大小文字・記号で並びと sourceHash を変えない）
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 経費の費用区分（勘定科目の system_key）から、利益額の費目の種類へ。科目に対応していない経費は unclassified
export function expenseKindOf(row) {
  if (row.expense_system_key === 'production_cost') return 'production_cost';
  if (row.expense_system_key === 'promotion') return 'promotion';
  if (row.expense_system_key === 'distribution_cost') return 'distribution';
  if (row.expense_account_id !== null && row.expense_account_id !== undefined) return 'other';
  return 'unclassified';
}

// 経費1件の費目。制作受託の案件の制作費は制作の実費（除外）。宣伝費・配給費は負担者（#24。いまは記録が無く null）で分ける
export function expenseItemOf(expense, project) {
  const bearer = (kind) => (expense.bearer === 'self' ? `${kind}_self` : expense.bearer === 'other' ? `${kind}_other` : `${kind}_unregistered`);
  if (expense.kind === 'production_cost') return project?.earningType === 'contract_work' ? 'contract_production_cost' : 'production_expense';
  if (expense.kind === 'promotion') return bearer('promotion');
  if (expense.kind === 'distribution') return bearer('distribution');
  if (expense.kind === 'other') return 'project_expense';
  return 'unclassified_expense';
}

// 売上の行の費目。率の決まらない案件 → 源泉のある取引先 → 作品の無い案件 → 売上 の順に決める
export function saleItemOf(project, partnerId, withholdingPartnerIds) {
  if (project.rateBps === null || project.rateBps === undefined) return 'sales_no_rate';
  if (withholdingPartnerIds && partnerId !== null && partnerId !== undefined && withholdingPartnerIds.has(Number(partnerId))) return 'sales_withholding';
  if (!project.hasWork) return 'sales_no_work';
  return 'sales';
}

// 売上明細の行（商品の配賦の行つき。store の accrualSaleLinesStatement）を作品へ分け、案件ごとの税別の額にする。
// 商品の配賦があればその比で（最大剰余法）、無ければ明細の作品へ。配賦の和が 10000 でない明細は分けず案件不明。
// 見てよい案件の分だけを返す（ほかの案件の分は捨てる）。案件不明は、明細のどれかの作品が見てよい案件のときだけ返す
export function accrualSaleParts(rows, {projectIds}) {
  const permitted = new Set([...projectIds].map(Number));
  const sales = new Map();
  for (const row of rows) {
    const saleId = Number(row.sale_id);
    if (!sales.has(saleId)) {
      sales.set(saleId, {saleId, month: monthOf(row.accounting_month), exTaxYen: Number(row.amount_ex_tax), partnerId: num(row.partner_id),
        workId: Number(row.work_id), projectId: Number(row.project_id), shares: []});
    }
    if (row.share_work_id !== null && row.share_work_id !== undefined) {
      sales.get(saleId).shares.push({work_id: Number(row.share_work_id), allocation_bps: Number(row.share_bps), projectId: Number(row.share_project_id)});
    }
  }
  const parts = [];
  const unknown = [];
  for (const sale of sales.values()) {
    const base = {saleId: sale.saleId, month: sale.month, partnerId: sale.partnerId};
    if (!sale.shares.length) {
      if (permitted.has(sale.projectId)) parts.push({...base, projectId: sale.projectId, exTaxYen: sale.exTaxYen});
      continue;
    }
    if (sale.shares.reduce((n, share) => n + share.allocation_bps, 0) !== 10000) {
      if (sale.shares.some((share) => permitted.has(share.projectId))) unknown.push({...base, amountYen: sale.exTaxYen, reason: 'product_allocation_incomplete'});
      continue;
    }
    const split = splitByAllocation(sale.exTaxYen, sale.shares);
    const byProject = new Map();
    for (const share of sale.shares) byProject.set(share.projectId, sumOf([byProject.get(share.projectId) ?? 0, split.get(share.work_id)]));
    for (const [projectId, exTaxYen] of byProject) if (permitted.has(projectId)) parts.push({...base, projectId, exTaxYen});
  }
  return {parts, unknown};
}

// 経費の行（store の expensesWithPaymentsStatement。経費×出金の行）を、経費と出金の一覧に分ける
function expensesAndPayments(rows) {
  const expenses = new Map();
  const payments = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!expenses.has(id)) {
      expenses.set(id, {id, projectId: Number(row.project_id), month: monthOf(row.accounting_month), exTax: Number(row.actual_ex_tax), incTax: Number(row.actual_inc_tax),
        voidedOn: row.expense_voided_on ?? null, kind: expenseKindOf(row), bearer: row.bearer ?? null});
    }
    if (row.payment_id !== null && row.payment_id !== undefined) {
      payments.push({id: Number(row.payment_id), expenseId: id, paidOn: row.paid_on, amount: Number(row.payment_yen),
        reversesId: num(row.payment_reverses_id), withheld: num(row.withheld_yen)});
    }
  }
  return {expenses: [...expenses.values()], payments};
}

// store の readProfitSources の返り値を、利益額の記録（buildCompanyProfit の入力）にする。
// 売上率は revenue-class-model の revenueClassBases（予実の4段・売上の4区分と同じ率）。作品の有無は案件の作品の数
export function profitRecordsFromSources(sources) {
  const bases = revenueClassBases(sources.revenueClassInputs);
  const labels = new Map(sources.earningTypes.map((e) => [e.code, e.label]));
  const projects = sources.projectRows.map((row) => {
    const base = bases.get(Number(row.id));
    return {id: Number(row.id), code: row.code, title: row.title, earningType: row.earning_type ?? null, earningTypeLabel: labels.get(row.earning_type) ?? null,
      rateBps: base?.rate?.bps ?? null, rateReason: base?.rate?.reason ?? null, hasWork: Number(row.work_count) > 0,
      mgContracts: Number(row.mg_contracts ?? 0), purchaseWorks: Number(row.purchase_works ?? 0)};
  });
  const projectIds = projects.map((p) => p.id);
  const link = linkReceiptsToProjects(sources.receiptRows, {projectIds});
  const partnerOfInvoice = new Map(sources.receiptRows.map((row) => [Number(row.invoice_id), num(row.invoice_partner_id)]));
  const sale = accrualSaleParts(sources.saleRows, {projectIds});
  const {expenses, payments} = expensesAndPayments(sources.expenseRows);
  const projectOf = (row) => Number(row.project_id);
  const paid = (rows) => rows.map((row) => ({projectId: projectOf(row), paidOn: row.paid_on, amountYen: Number(row.amount_yen)}));
  return {
    projects,
    receipts: {
      settled: link.settled.map((r) => ({projectId: r.projectId, month: monthOf(r.month), exTaxYen: r.exTaxYen, partnerId: partnerOfInvoice.get(r.invoiceId) ?? null})),
      unsettled: link.unsettled.map((r) => ({projectId: r.projectId, month: monthOf(r.month), amountYen: r.amountYen, reason: r.reason})),
    },
    saleLines: sale.parts.map(({projectId, month, exTaxYen, partnerId}) => ({projectId, month, exTaxYen, partnerId})),
    unknownSaleLines: sale.unknown.map(({month, amountYen, reason}) => ({month, amountYen, reason})),
    expenses, expensePayments: payments,
    // 記録の形がまだ無い費目は null（未接続）。自社の取引先の無い組織は委員会の払込も未接続。自社出資の払込は稟議の払込の版（読めば接続）
    ownInvestmentPayments: Array.isArray(sources.ownInvestmentPaymentRows) ? paid(sources.ownInvestmentPaymentRows) : null,
    ownInvestmentUnpaidProjects: Number.isSafeInteger(sources.ownInvestmentUnpaidCount) ? sources.ownInvestmentUnpaidCount : null,
    committeeInvestmentPayments: sources.selfPartnerId === null ? null : paid(sources.committeePaymentRows),
    mgPayments: null,
    buyoutPayments: null,
    withholdingPartnerIds: null,
  };
}

// 未接続の費目に当たりそうな案件の数（記録が無いことを0円で隠さず、どれだけ抜けているかの目安を出す）。
// 買付の MG・買い切りは、稼ぎ方が買付の案件だけを、売上率と同じ見分け方（revenue-class-model の acquisitionTermsOf）で数える
function unconnectedProjectCount(source, projects) {
  const acquisitionTerms = (p) => (p.earningType === 'acquisition' ? acquisitionTermsOf({mg_contracts: p.mgContracts, purchase_works: p.purchaseWorks}) : null);
  if (source === 'ownInvestmentPayments') return projects.filter((p) => p.earningType === 'own_investment').length;
  if (source === 'committeeInvestmentPayments') return projects.filter((p) => p.earningType === 'committee').length;
  if (source === 'mgPayments') return projects.filter((p) => acquisitionTerms(p) === 'mg').length;
  if (source === 'buyoutPayments') return projects.filter((p) => acquisitionTerms(p) === 'buyout').length;
  return null;
}

// 記録を基準ごとの出来事（基準・月・案件・費目・額）に分ける。売上の額は率を掛ける前の税別の額（入金の違う額は税込）
function profitEvents(records) {
  const projects = new Map(records.projects.map((p) => [p.id, p]));
  const withholding = records.withholdingPartnerIds ? new Set([...records.withholdingPartnerIds].map(Number)) : null;
  const events = [];
  const unknown = [];
  const push = (basis, month, projectId, item, amount) => events.push({basis, month, projectId, item, amount});
  // 売上（入金）
  for (const r of records.receipts.settled) {
    const project = projects.get(Number(r.projectId));
    if (!project) continue;
    push('cash', r.month, project.id, saleItemOf(project, r.partnerId, withholding), r.exTaxYen);
  }
  for (const r of records.receipts.unsettled) {
    if (r.projectId === null || r.projectId === undefined) { unknown.push({basis: 'cash', month: r.month, amount: r.amountYen, reason: r.reason}); continue; }
    if (projects.has(Number(r.projectId))) push('cash', r.month, Number(r.projectId), 'sales_amount_differs', r.amountYen);
  }
  for (const r of records.unknownReceipts ?? []) unknown.push({basis: 'cash', month: r.month, amount: r.amountYen, reason: r.reason ?? 'no_project'});
  // 売上（計上）
  for (const s of records.saleLines) {
    const project = projects.get(Number(s.projectId));
    if (!project) continue;
    push('accrual', s.month, project.id, saleItemOf(project, s.partnerId, withholding), s.exTaxYen);
  }
  for (const s of records.unknownSaleLines ?? []) unknown.push({basis: 'accrual', month: s.month, amount: s.amountYen, reason: s.reason});
  // 経費（計上は計上月と取消日の月、入金は出金日の月）
  const expenseItems = new Map();
  for (const e of records.expenses) {
    const project = projects.get(Number(e.projectId));
    if (!project) continue;
    const item = expenseItemOf(e, project);
    expenseItems.set(Number(e.id), {item, projectId: project.id});
    push('accrual', e.month, project.id, item, e.exTax);
    if (e.voidedOn) push('accrual', monthOf(e.voidedOn), project.id, item, -e.exTax);
  }
  const cash = cashExpenseParts({expenses: records.expenses.filter((e) => expenseItems.has(Number(e.id))), payments: records.expensePayments ?? []});
  for (const part of cash.settled) {
    const {item, projectId} = expenseItems.get(Number(part.expense.id));
    push('cash', part.month, projectId, item, part.exTax);
  }
  for (const part of cash.unsettled) {
    const {item, projectId} = expenseItems.get(Number(part.expense.id));
    // 除外の費目は除外のまま税込の別の行へ（未確定へ移さず、税別の行の額にも混ぜない）
    push('cash', part.month, projectId, AMOUNT_DIFFERS_ITEM[item] ?? 'expense_amount_differs', part.amount);
  }
  // 払った月に引く4費目（計上・入金とも払った月）
  for (const [source, item] of [['ownInvestmentPayments', 'own_investment'], ['committeeInvestmentPayments', 'committee_investment'],
    ['mgPayments', 'acquisition_mg'], ['buyoutPayments', 'acquisition_buyout']]) {
    for (const p of records[source] ?? []) {
      const project = projects.get(Number(p.projectId));
      if (!project) continue;
      for (const basis of BASES) push(basis, monthOfDate(p.paidOn), project.id, item, p.amountYen);
    }
  }
  return {events, unknown};
}

// 基準×月×案件×費目で足し、売上の費目は率を掛けて1回だけ truncate する
function aggregate(events, projects) {
  const groups = new Map();
  for (const e of events) {
    const key = `${e.basis}\u0000${e.month}\u0000${e.projectId}\u0000${e.item}`;
    if (!groups.has(key)) groups.set(key, {basis: e.basis, month: e.month, projectId: e.projectId, item: e.item, raw: []});
    groups.get(key).raw.push(e.amount);
  }
  return [...groups.values()].map((g) => {
    const raw = sumOf(g.raw, '費目の額');
    const item = ITEM.get(g.item);
    const amount = item.amountKind === 'rate_applied' ? signedRateAmount(raw, projects.get(g.projectId).rateBps) : raw;
    return {basis: g.basis, month: g.month, projectId: g.projectId, item: g.item, raw, amount};
  });
}

// 基準×月×案件×費目で足した行（buildCompanyProfit が足す前の行。売上の費目は率を掛けて1回だけ truncate した額）を、基準と期間で絞って返す。
// 源泉別の内訳（source-profit-model.mjs。行動指標の計画 段B #2）が案件×費目で分けるのに使う。同じ記録・基準・期間なら、状態が確定の行の和は
// buildCompanyProfit の確定の売上・経費と同じで、案件ごとの和は byProject と同じ（足す単位と truncate の単位が同じなので）
export function profitItemRows(records, {basis, from = null, to = null} = {}) {
  basisFields(basis);
  if (from !== null && !isMonth(from)) throw new Error(`期間の開始月（from）は YYYY-MM で渡します: ${from}`);
  if (to !== null && !isMonth(to)) throw new Error(`期間の終了月（to）は YYYY-MM で渡します: ${to}`);
  const inRange = (month) => (from === null || month >= from) && (to === null || month <= to);
  const projects = new Map(records.projects.map((p) => [p.id, p]));
  const {events} = profitEvents(records);
  for (const e of events) if (!isMonth(e.month)) throw new Error(`月を読めない記録があります（${e.item}: ${e.month}）`);
  return aggregate(events.filter((e) => e.basis === basis && inRange(e.month)), projects).map(({month, projectId, item, amount}) => {
    const def = ITEM.get(item);
    return {month, projectId, item, label: def.label, side: def.side, status: def.status, amountKind: def.amountKind, amount};
  });
}

// 会社への利益額。records は profitRecordsFromSources の形（試験は種から同じ形を作る）。
// options: basis（accrual|cash）、from・to（YYYY-MM。省けば全期間）、includeCompany（会社全体を見てよいか。false なら案件不明の行は出さない）
export function buildCompanyProfit(records, {basis, from = null, to = null, includeCompany = true} = {}) {
  const fields = basisFields(basis);
  if (from !== null && !isMonth(from)) throw new Error(`期間の開始月（from）は YYYY-MM で渡します: ${from}`);
  if (to !== null && !isMonth(to)) throw new Error(`期間の終了月（to）は YYYY-MM で渡します: ${to}`);
  const inRange = (month) => (from === null || month >= from) && (to === null || month <= to);
  const projects = new Map(records.projects.map((p) => [p.id, p]));
  const {events, unknown} = profitEvents(records);
  for (const e of [...events, ...unknown]) if (!isMonth(e.month)) throw new Error(`月を読めない記録があります（${e.item ?? e.reason}: ${e.month}）`);
  const rows = aggregate(events.filter((e) => inRange(e.month)), projects);
  const unknownRows = includeCompany ? unknown.filter((u) => inRange(u.month)) : [];
  // 月の軸は両方の基準の記録のある月（基準を切り替えても列が同じ）
  const months = [...new Set([...rows.map((r) => r.month), ...unknownRows.map((u) => u.month)])].sort();
  const index = new Map(months.map((m, i) => [m, i]));
  // 月ごとの額の入れ物（額を積み、最後に月ごとに sumOf で足す。軸の月で記録の無いところは 0）
  const series = () => months.map(() => []);
  const toNumbers = (buckets, label) => buckets.map((values) => sumOf(values, label));
  const mine = rows.filter((r) => r.basis === basis);

  const sales = series();
  const cost = series();
  for (const r of mine) {
    const item = ITEM.get(r.item);
    if (item.status !== 'settled') continue;
    (item.side === 'sales' ? sales : cost)[index.get(r.month)].push(r.amount);
  }
  const salesYen = toNumbers(sales, '売上');
  const costYen = toNumbers(cost, '経費');
  const profitYen = salesYen.map((s, i) => sumOf([s, -costYen[i]], '利益額'));

  const itemRows = (status) => PROFIT_ITEMS.filter((item) => item.status === status).flatMap((item) => {
    const own = mine.filter((r) => r.item === item.key);
    if (!own.length) return [];
    const values = series();
    for (const r of own) values[index.get(r.month)].push(r.amount);
    const amounts = toNumbers(values, item.label);
    return [{key: item.key, label: item.label, side: item.side, status, statusLabel: STATUS_LABELS[status], reason: item.reason,
      amountKind: item.amountKind, amountKindLabel: AMOUNT_KINDS[item.amountKind], amounts, total: sumOf(amounts, item.label), projectIds: [...new Set(own.map((r) => r.projectId))].sort((a, b) => a - b)}];
  });

  const unconnected = Object.entries(UNCONNECTED_REASONS).filter(([source]) => records[source] === null || records[source] === undefined).map(([source, {item, reason}]) => {
    const def = ITEM.get(item);
    return {key: def.key, label: def.label, side: def.side, status: 'unconnected', statusLabel: STATUS_LABELS.unconnected, reason, settledWhenConnected: def.status === 'settled',
      projectCount: unconnectedProjectCount(source, records.projects)};
  });
  if (!records.withholdingPartnerIds) {
    unconnected.push({key: 'sales_withholding', label: ITEM.get('sales_withholding').label, side: 'sales', status: 'unconnected', statusLabel: STATUS_LABELS.unconnected,
      reason: '取引先の源泉の有無を持つ記録が無く、源泉のある取引先の売上を分けられない（その売上は「売上」に入る。入金の確認の計画 #6 の控除の表）',
      settledWhenConnected: false, projectCount: null});
  }

  const byProject = new Map();
  for (const r of mine) {
    const item = ITEM.get(r.item);
    if (item.status !== 'settled') continue;
    if (!byProject.has(r.projectId)) byProject.set(r.projectId, {sales: [], cost: []});
    byProject.get(r.projectId)[item.side === 'sales' ? 'sales' : 'cost'].push(r.amount);
  }
  const projectRows = [...byProject].map(([projectId, v]) => {
    const p = projects.get(projectId);
    const s = sumOf(v.sales, '案件の売上');
    const c = sumOf(v.cost, '案件の経費');
    return {projectId, code: p.code, title: p.title, earningType: p.earningType, earningTypeLabel: p.earningTypeLabel, salesYen: s, costYen: c, profitYen: sumOf([s, -c], '案件の利益額')};
  }).sort((a, b) => byCodePoint(String(a.code), String(b.code)) || a.projectId - b.projectId);

  let unknownProject = null;
  if (includeCompany) {
    const mineUnknown = unknownRows.filter((u) => u.basis === basis);
    const values = series();
    for (const u of mineUnknown) values[index.get(u.month)].push(u.amount);
    const amounts = toNumbers(values, '案件不明');
    const reasons = Object.entries(UNKNOWN_REASONS).flatMap(([reason, def]) => {
      const own = mineUnknown.filter((u) => u.reason === reason);
      return own.length ? [{reason, label: def.label, amountKind: def.amountKind, amountKindLabel: AMOUNT_KINDS[def.amountKind], note: def.note, total: sumOf(own.map((u) => u.amount), def.label)}] : [];
    });
    unknownProject = {label: '案件不明', reason: '案件に結べない入金（計上は売上明細）。売上に数えず、別の行に出す', amounts, total: sumOf(amounts, '案件不明'), reasons};
  }

  const notes = [];
  if (!includeCompany) notes.push('会社全体を見る権限が無いので、案件不明の行を出していません（見てよい案件の分だけ）');
  for (const u of unconnected) if (u.settledWhenConnected && u.projectCount) notes.push(`${u.label}は記録が無く引いていません（当たりそうな案件 ${u.projectCount}件）。利益額はその分だけ大きく出ます`);
  // 自社出資の払込は稟議の払込の版から引くので、払込の版の無い自社出資の案件は、出資していても引いていない（0円で引いたと読ませない）
  if (Array.isArray(records.ownInvestmentPayments) && records.ownInvestmentUnpaidProjects > 0) {
    notes.push(`自社出資の出資額は、稟議の払込の記録が無い案件 ${records.ownInvestmentUnpaidProjects}件では引いていません。出資していれば、利益額はその分だけ大きく出ます`);
  }

  return {
    ...fields,
    taxLabel: TAX_LABEL,
    formula: PROFIT_FORMULA,
    rules: [...PROFIT_RULES],
    conditions: {from, to},
    months,
    settled: {salesYen, costYen, profitYen, totals: {salesYen: sumOf(salesYen, '売上'), costYen: sumOf(costYen, '経費'), profitYen: sumOf(profitYen, '利益額')}},
    unsettled: itemRows('unsettled'),
    excluded: itemRows('excluded'),
    unconnected,
    unknownProject,
    byProject: projectRows,
    items: PROFIT_ITEMS.map(({key, label, side, status, reason, amountKind}) => ({key, label, side, status, statusLabel: STATUS_LABELS[status], reason, amountKind})),
    notes,
  };
}
