// 作品別収支の文書データ（計画の K-5。帳票の文書データの型の最初の1本）。DB と時刻に触れない純関数。
// 画面（reports/WorkPnlReport.jsx）・Excel・印刷・CSV（report-output.mjs の document*）は、この1つの文書データから出す。
//   {title, conditions[{key,label,value}], dataAsOf{label,at,generatedAt}, definitionVersion, basis,
//    tables[{name, title, columns[{key,label,type,nullText?}], rows, total?}], notes[{code,text}], checks[{code,label,ok,value}], sourceHash}
// - 計算は既存の作品別収支（reports/work-pnl-model.mjs の buildWorkPnl）。基準は計上（accrual。既定）か入金（cash。フェーズ1 #16）。
//   入金は売上を請求の入金の入金日の月、経費を出金日の月に並べ、税抜にできない入出金を「未確定」の表に税込で出す（行は accounting/work-pnl/work-pnl-cash-model.mjs）
// - 表の値は JSON の値だけ（数・文字・null）。率は整数の bp のまま（列の型 bps）。流通別の経費のように記録の無い値は null で、0円で埋めない
// - checks は文書の表どうしの照合（差額の円。0 で OK）。全部 OK でない文書からは何も出さない（report-output.mjs の documentExportBlock）。
//   表どうしで必ず等しくなる額だけを照合にする。「経費のうち制作費 ≦ 作品計の経費」は、制作費以外の区分に返金・取消（負の経費）があると
//   正しいデータでも超えるので、照合（出力の関門）に入れず、超えたときは注記 production_cost_exceeds で知らせる
// - sourceHash は hash の元（workPnlSource: 定義の版・基準・条件・作品・データ時点・読んだ明細と経費。入金は未確定の行も）の SHA-256。作った時刻は入れない。
//   受け口は app の道具（sha256・canonical。app.ux）を渡す（段A のシナリオの比較と同じ作り方）
// - 制作費の版の行（#6b）と U-4 R-a はまだ入れない。「経費のうち制作費」は会計の費用区分で公開月一括の経費
import {buildWorkPnl, EXPENSE_ONLY_CARD, OUT_OF_SCOPE_NOTE, LIST_SEPARATOR} from '../../reports/work-pnl-model.mjs';
import {monthsBetween} from '../../reports/annual-sales-model.mjs';

// 表の列・行・照合・hash の元を変えたら上げる（hash が変わり、前の版から作った派生物と区別できる）
export const WORK_PNL_DEFINITION_VERSION = 'work-pnl.2026-10-11';
export const WORK_PNL_BASIS = 'accrual';
export const WORK_PNL_BASES = Object.freeze(['accrual', 'cash']);
export const BASIS_NOTE = '計上月・税抜。売上は商品の作品配賦で割り当てた額（帳票センターの年間売上と同じ数え方）。';
export const CASH_BASIS_NOTE = '入金ベース・税抜。売上は請求の入金を入金日の月に、消込で結んだ請求明細の作品の配賦で割り当てた税抜額。経費は出金日の月。取消は取消日の月に負の額。';
export const UNSETTLED_NOTE = '税抜にできない入出金（請求額と違う額の入金・経費の税込額と違う額の出金。源泉・手数料・一部入金・分割払いなど）は、税込のまま「未確定」の表に出し、作品計に入れていません（入金の税抜の出し方は U-5 で未決）。';
export const SCOPE_NOTE = '作品に直接付いた経費だけを作品計に入れます。作品の決まっていない案件の経費は「未配賦の経費」として別に示し、差し引きません。';
export const DISTRIBUTION_EXPENSE_NOTE = '経費には流通の区分が無いため、作品の経費は「流通に紐づかない経費」の行にまとめています。';
export const NO_DISTRIBUTION_EXPENSE = '流通別の記録なし';
const BASIS_CONDITION = Object.freeze({accrual: '計上（計上月・税抜）', cash: '入金（入金日・出金日の月・税抜）'});
export const basisNoteOf = (basis) => (basis === 'cash' ? CASH_BASIS_NOTE : BASIS_NOTE);

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
// 整数の円・件数の和（null は数えない）。整数でない値は誤りとして止める（0 や丸めた値にしない。money.md）
function sumInts(values) {
  let n = 0n;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!Number.isSafeInteger(value)) throw new Error(`作品別収支の金額・件数が整数ではありません: ${value}`);
    n += BigInt(value);
  }
  if (n > MAX || n < -MAX) throw new Error('作品別収支の合計が安全な整数の範囲を超えました');
  return Number(n);
}
const sumOf = (rows, key) => sumInts(rows.map((row) => row[key]));

const column = (key, label, type, nullText) => (nullText === undefined ? {key, label, type} : {key, label, type, nullText});
const SUMMARY_COLUMNS = [column('item', '項目', 'text'), column('amount', '金額（税抜）', 'yen'), column('note', '説明', 'text')];
const DISTRIBUTION_COLUMNS = [
  column('label', '流通', 'text'), column('sales', '売上（税抜）', 'yen'), column('expense', '経費（流通に紐づく分）', 'yen', NO_DISTRIBUTION_EXPENSE),
  column('balance', '差額', 'yen'), column('lineCount', '売上明細の件数', 'int'), column('expenseCount', '経費の件数', 'int', '—'),
  column('deals', '取引区分', 'text', '—'), column('partners', '取引先', 'text', '—'),
];
const LINE_COLUMNS = [
  column('accounting_month', '計上月', 'month'), column('distribution_label', '流通', 'text'), column('partner_name', '取引先', 'text'),
  column('product_name', '商品', 'text'), column('description', '内容', 'text'), column('deal_label', '取引区分', 'text'),
  column('allocation_bps', '作品への配賦率', 'bps'), column('amount', '売上（税抜・配賦後）', 'yen'), column('quantity', '数量', 'int'),
  column('report_key', '報告キー', 'code'), column('source_row', '原本の行', 'int'), column('product_sku', '商品SKU', 'code'),
];
// 入金ベースの売上の明細（入金1件×請求明細×作品）。配賦率は請求明細の作品の配賦
const CASH_LINE_COLUMNS = [
  column('received_on', '入金日（取消は取消日）', 'date'), column('distribution_label', '流通', 'text'), column('partner_name', '取引先', 'text'),
  column('product_name', '商品', 'text'), column('description', '内容', 'text'), column('deal_label', '取引区分', 'text'),
  column('allocation_bps', '作品への配賦率（請求明細）', 'bps'), column('amount', '入金（税抜・配賦後）', 'yen'), column('accounting_month', '計上月', 'month'),
  column('receipt_id', '入金の番号', 'int'), column('invoice_id', '請求の番号', 'int'), column('report_key', '報告キー', 'code'),
];
const EXPENSE_COLUMNS = [
  column('accounting_month', '計上月', 'month'), column('incurred_on', '発生日', 'date'), column('category', '費目', 'text'),
  column('description', '内容', 'text'), column('partner_name', '支払先', 'text'),
  column('actual_ex_tax', '税抜', 'yen'), column('tax_amount', '税額', 'yen'), column('actual_inc_tax', '税込', 'yen'),
];
const EXPENSE_TOTAL_KEYS = ['actual_ex_tax', 'tax_amount', 'actual_inc_tax'];
// 入金ベースの経費の明細（出金1件ごと。税込額どおりに払い切った出金だけ。取消は負）
const CASH_EXPENSE_COLUMNS = [
  column('paid_on', '出金日（取消は取消日）', 'date'), column('accounting_month', '計上月', 'month'), column('category', '費目', 'text'),
  column('description', '内容', 'text'), column('partner_name', '支払先', 'text'),
  column('actual_ex_tax', '税抜', 'yen'), column('paid_amount', '出金の額', 'yen'), column('expense_id', '経費の番号', 'int'),
];
const CASH_EXPENSE_TOTAL_KEYS = ['actual_ex_tax', 'paid_amount'];
const UNSETTLED_COLUMNS = [
  column('on', '日付', 'date'), column('kindLabel', '種類', 'text'), column('reasonLabel', '未確定の理由', 'text'),
  column('category', '費目', 'text', '—'), column('amount', '額（税込・作品計に入れない）', 'yen'), column('ref', '記録', 'text'),
];

// 行は列の値と、画面が使う識別（id・流通のコード）だけにする（読んだ行の内部の列を文書へ持ち出さない）
const rowOf = (source, columns, extra = []) => Object.fromEntries([...extra, ...columns.map((c) => c.key)].map((key) => [key, source[key] ?? null]));

const basisOf = (input) => {
  const basis = input.basis ?? WORK_PNL_BASIS;
  if (!WORK_PNL_BASES.includes(basis)) throw new Error(`作品別収支の基準は ${WORK_PNL_BASES.join('・')} のどれかです`);
  return basis;
};

// hash の元。同じ元から同じ文書が出る（作った時刻 generatedAt は入れない）。入金は未確定の行と作品を決められない入金の件数も元に入れる
export function workPnlSource(input) {
  const {work, conditions, dataAsOf, lines = [], expenses = [], unallocatedExpenses = []} = input;
  const basis = basisOf(input);
  const source = {
    definitionVersion: WORK_PNL_DEFINITION_VERSION,
    basis,
    conditions: {workId: conditions.workId, from: conditions.from, to: conditions.to},
    work: {id: work.id, code: work.code, title: work.title},
    dataAsOf: {latestImportAt: dataAsOf?.latestImportAt ?? null},
    lines, expenses, unallocatedExpenses,
  };
  if (basis === 'cash') Object.assign(source, {unsettled: input.unsettled ?? [], unattachedReceiptCount: input.unattachedReceiptCount ?? 0});
  return source;
}

function summaryTable(result, basis, unsettled, {from, to}) {
  const {totals, productionCost} = result;
  const rows = [
    {code: 'sales', item: basis === 'cash' ? '売上（入金・税抜）' : '売上（税抜）', amount: totals.sales,
      note: basis === 'cash' ? `入金の明細 ${result.lineCount}件。${CASH_BASIS_NOTE}` : `売上明細 ${result.lineCount}件。${BASIS_NOTE}`},
    {code: 'expense', item: basis === 'cash' ? '経費（出金・税抜・作品に付いた分）' : '経費（税抜・作品に付いた分）', amount: totals.expense,
      note: basis === 'cash' ? `作品の経費の出金 ${result.expenseCount}件` : `作品の経費 ${result.expenseCount}件`},
    {code: 'balance', item: '差額（売上−経費）', amount: totals.balance, note: '売上−作品の全経費'},
    {code: 'productionCost', status: productionCost.status, item: '経費のうち制作費', amount: productionCost.amount, note: productionCost.note},
    {code: 'unallocated', item: '未配賦の経費（作品計に含めていません）', amount: result.unallocated.total,
      note: `作品の決まっていない案件の経費${basis === 'cash' ? 'の出金' : ''} ${result.unallocated.count}件。差し引いていません`},
  ];
  if (basis === 'cash') {
    // 未確定の額は期間内の行だけを数える（ほかの作品計と同じ。未確定の表には受け取った行をすべて載せ、照合 unsettled_in・unsettled_out で期間外の行を見つける）
    const inPeriod = (row) => typeof row.month === 'string' && row.month >= from && row.month <= to;
    const of = (kind) => unsettled.filter((row) => row.kind === kind && inPeriod(row));
    rows.push(
      {code: 'unsettledIn', item: '未確定の入金（税込・作品計に入れていません）', amount: sumOf(of('receipt'), 'amount'), note: `${of('receipt').length}件。${UNSETTLED_NOTE}`},
      {code: 'unsettledOut', item: '未確定の出金（税込・作品の経費・作品計に入れていません）', amount: sumOf(of('expense'), 'amount'), note: `${of('expense').length}件。未配賦の経費の未確定の出金は「未確定」の表だけに出します`},
    );
  }
  return {name: 'summary', title: '作品計', columns: SUMMARY_COLUMNS, rows};
}

function distributionTable(result) {
  const rows = result.cards.map((card) => (card.kind === 'distribution'
    ? {kind: card.kind, code: card.code, label: card.label, sales: card.sales, expense: null, balance: card.balance, lineCount: card.lineCount, expenseCount: null,
      deals: card.deals.length ? card.deals.join(LIST_SEPARATOR) : null, partners: card.partners.length ? card.partners.join(LIST_SEPARATOR) : null}
    : {kind: card.kind, code: null, label: EXPENSE_ONLY_CARD, sales: 0, expense: card.expense, balance: card.balance, lineCount: 0, expenseCount: card.expenseCount,
      deals: null, partners: null}));
  const {totals} = result;
  return {name: 'distributions', title: '流通別', columns: DISTRIBUTION_COLUMNS, rows,
    total: {sales: totals.sales, expense: totals.expense, balance: totals.balance, lineCount: result.lineCount, expenseCount: result.expenseCount}};
}

function monthlyTable(result, basis) {
  const codes = result.distributions.map((d) => d.code);
  const columns = [
    column('month', basis === 'cash' ? '月（入金日・出金日）' : '計上月', 'month'), column('sales', '売上（税抜）', 'yen'), column('expense', '経費（税抜）', 'yen'), column('balance', '差額（売上−経費）', 'yen'),
    ...result.distributions.map((d) => column(`d:${d.code}`, `売上のうち ${d.label}`, 'yen')),
  ];
  const rows = result.monthly.map((row) => ({month: row.month, sales: row.sales, expense: row.expense, balance: row.balance,
    ...Object.fromEntries(codes.map((code) => [`d:${code}`, row.byDistribution[code] ?? 0]))}));
  const {totals} = result;
  return {name: 'monthly', title: '月別', columns, rows,
    total: {sales: totals.sales, expense: totals.expense, balance: totals.balance, ...Object.fromEntries(result.distributions.map((d) => [`d:${d.code}`, d.sales]))}};
}

function detailTable(name, title, columns, sourceRows, totalKeys, extra) {
  const rows = sourceRows.map((row) => rowOf(row, columns, extra));
  return {name, title, columns, rows, total: Object.fromEntries(totalKeys.map((key) => [key, sumOf(rows, key)]))};
}

// 文書の表どうしの照合。value は差額（円）で、0 なら OK。作品計は期間内の明細から計算した額、明細の表は受け取った明細のすべて。
// 入金ベースは、未確定の表の入金・作品の経費の出金の和（受け取った行のすべて）＝作品計の未確定の入金・出金（期間内の行だけ）も見る
// （期間外の未確定の行が渡ると NG。作品計と表を同じ行の集まりから足すと必ず一致して欠陥を見つけられないので、ほかの明細の照合と同じ分け方にする）
export function documentChecks(tables) {
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const summary = Object.fromEntries(byName.summary.rows.map((row) => [row.code, row.amount]));
  const monthly = byName.monthly.rows;
  const distributions = byName.distributions.rows;
  const codes = distributions.filter((row) => row.kind === 'distribution').map((row) => row.code);
  const breakdown = monthly.reduce((n, row) => n + Math.abs(sumInts(codes.map((code) => row[`d:${code}`])) - row.sales), 0)
    + distributions.filter((row) => row.kind === 'distribution').reduce((n, row) => n + Math.abs(sumOf(monthly, `d:${row.code}`) - row.sales), 0);
  const check = (code, label, value) => ({code, label, ok: value === 0, value});
  const checks = [
    check('monthly_sales', '月別の売上の和＝作品計の売上', sumOf(monthly, 'sales') - summary.sales),
    check('lines_sales', '売上明細の和＝作品計の売上', sumOf(byName.lines.rows, 'amount') - summary.sales),
    check('distribution_sales', '流通別の売上の和＝作品計の売上', sumOf(distributions, 'sales') - summary.sales),
    check('monthly_expense', '月別の経費の和＝作品計の経費', sumOf(monthly, 'expense') - summary.expense),
    check('expense_lines', '作品の経費の明細の和＝作品計の経費', sumOf(byName.expenses.rows, 'actual_ex_tax') - summary.expense),
    check('distribution_balance', '流通別の差額の和＝作品計の差額', sumOf(distributions, 'balance') - summary.balance),
    check('monthly_breakdown', '月別の流通の内訳の和＝その月の売上・流通別の売上', breakdown),
    check('balance', '作品計の差額＝売上−経費', summary.balance - (summary.sales - summary.expense)),
    check('unallocated', '未配賦の経費の明細の和＝未配賦の合計', sumOf(byName.unallocated.rows, 'actual_ex_tax') - summary.unallocated),
  ];
  if (byName.unsettled) {
    const rows = byName.unsettled.rows;
    checks.push(
      check('unsettled_in', '未確定の表の入金の和＝作品計の未確定の入金', sumOf(rows.filter((row) => row.kind === 'receipt'), 'amount') - summary.unsettledIn),
      check('unsettled_out', '未確定の表の作品の経費の出金の和＝作品計の未確定の出金', sumOf(rows.filter((row) => row.kind === 'expense'), 'amount') - summary.unsettledOut),
    );
  }
  return checks;
}

// 制作費が作品計の経費を超えたときの注記（出力は止めない。上の説明）
function productionCostExceedsNote({productionCost, totals}) {
  if (productionCost.status !== 'included' || productionCost.amount <= totals.expense) return null;
  return {code: 'production_cost_exceeds',
    text: '経費のうち制作費が作品計の経費を超えています。制作費以外の区分の返金・取消（負の経費）によるものか、作品の経費の明細で確かめてください（Excel・印刷は止めません）。'};
}

// 文書データを作る。sourceHash は呼び出し側が workPnlSource から作って渡す（workPnlDocument が両方を行う）
export function buildWorkPnlDocument(input, {sourceHash = null} = {}) {
  const {work, conditions, dataAsOf, lines = [], expenses = [], unallocatedExpenses = []} = input;
  const basis = basisOf(input);
  const cash = basis === 'cash';
  const unsettled = cash ? (input.unsettled ?? []) : [];
  const months = monthsBetween(conditions.from, conditions.to);
  const result = buildWorkPnl({lines, expenses, unallocatedExpenses, months, basis});
  // 未配賦の経費の合計は期間内の分（buildWorkPnl と同じ）。表には受け取った行をすべて載せ、照合で期間外の行を見つける
  const tables = [
    summaryTable(result, basis, unsettled, conditions),
    distributionTable(result),
    monthlyTable(result, basis),
    cash
      ? detailTable('lines', '入金の明細', CASH_LINE_COLUMNS, lines, ['amount'], ['id', 'distribution_code', 'receipt_id'])
      : detailTable('lines', '売上明細', LINE_COLUMNS, lines, ['amount', 'quantity'], ['id', 'distribution_code']),
    cash
      ? detailTable('expenses', '作品の経費の出金', CASH_EXPENSE_COLUMNS, expenses, CASH_EXPENSE_TOTAL_KEYS, ['id'])
      : detailTable('expenses', '作品の経費', EXPENSE_COLUMNS, expenses, EXPENSE_TOTAL_KEYS, ['id']),
    cash
      ? detailTable('unallocated', '未配賦の経費の出金', CASH_EXPENSE_COLUMNS, unallocatedExpenses, CASH_EXPENSE_TOTAL_KEYS, ['id'])
      : detailTable('unallocated', '未配賦の経費', EXPENSE_COLUMNS, unallocatedExpenses, EXPENSE_TOTAL_KEYS, ['id']),
  ];
  if (cash) tables.push({name: 'unsettled', title: '未確定の入出金（税込・作品計に入れていません）', columns: UNSETTLED_COLUMNS, rows: unsettled.map((row) => rowOf(row, UNSETTLED_COLUMNS, ['kind', 'reason']))});
  const unattached = cash && input.unattachedReceiptCount > 0
    ? {code: 'unattached_receipts', text: `請求明細の作品の配賦がそろわない入金が${input.unattachedReceiptCount}件あり、作品を決められないため、この帳票に入れていません（会社PLの「未確定」に出ます）。`}
    : null;
  return {
    title: `作品別収支（${work.title}）`,
    conditions: [
      {key: 'work', label: '作品', value: `${work.title}（${work.code}）`},
      {key: 'period', label: '期間', value: `${conditions.from}〜${conditions.to}`},
      {key: 'basis', label: '基準', value: BASIS_CONDITION[basis]},
    ],
    dataAsOf: {label: '最終取込', at: dataAsOf?.latestImportAt ?? null, generatedAt: dataAsOf?.generatedAt ?? null},
    definitionVersion: WORK_PNL_DEFINITION_VERSION,
    basis,
    tables,
    notes: [
      {code: 'basis', text: basisNoteOf(basis)},
      cash ? {code: 'unsettled', text: UNSETTLED_NOTE} : null,
      unattached,
      {code: 'scope', text: SCOPE_NOTE},
      {code: 'production_cost', text: `${result.productionCost.label}: ${result.productionCost.note}`},
      productionCostExceedsNote(result),
      {code: 'distribution_expense', text: DISTRIBUTION_EXPENSE_NOTE},
      {code: 'out_of_scope', text: OUT_OF_SCOPE_NOTE},
    ].filter(Boolean),
    checks: documentChecks(tables),
    sourceHash,
  };
}

// 受け口が使う入口。{sha256, canonical} は app の道具（app.ux）
export async function workPnlDocument(input, {sha256, canonical}) {
  const sourceHash = await sha256(canonical(workPnlSource(input)));
  return buildWorkPnlDocument(input, {sourceHash});
}
