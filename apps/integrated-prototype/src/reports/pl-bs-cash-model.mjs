// 計上と入金の切り替え（フェーズ1の仕様書 #16）と、入金ベースの税抜換算。DB・時刻に触れない純関数。
// 基準（basis）: accrual＝計上（売上・経費は計上月）、cash＝入金（売上は入金日・経費は出金日の月）。既定は計上。
//   語の正本は brain の ontology「基準（basis）と『入金日』」（U-5 の裁定まで仮の定義）。予実の4段は入金に固定で、この切り替えに入れない（D-039）。
// 入金ベースの税抜換算（U-5 の「入金の税抜の出し方」「源泉と税込」が決まるまでの仮の出し方。FR-REV-YOJITSU-032 と同じく、記録どおりの額で動いた現金だけを税抜にする）:
//   - 請求の入金: 消込の額が請求の税込額と同じ（請求どおり）なら、請求明細の税抜額を作品の配賦で分けた額（最大剰余法）を税抜の入金とする（確定）。
//     違う額（源泉・手数料・一部入金など）は税抜にせず、税込の額を作品の税抜額の比で分けて「未確定」に出す。作品の配賦がそろわない消込は作品を決めずに「未確定」
//   - 経費の出金: 出金の額＋源泉の控除額が経費の税込額と同じ（1回で払い切った）なら、経費の税抜額を税抜の出金とする（確定）。違う額（分割払いなど）は出金の額のまま「未確定」
//   - ロイヤリティの支払: 支払の額が報告書の明細の和（充当を引いた額）と同じなら、明細の作品ごとの額を税抜の支払とする（確定）。違う額は「未確定」
//   - 委員会からの受取と委員会への出資の払込: 税の扱いと PL への入れ方が決まっていない（U-5・U-4 R-e）ので全部「未確定」
//   - 取消は取消日の月に負の額（元と同じ扱い）。「未確定」は利益に入れず、別の行に税込のまま出す（0円で埋めない）
// 入金ベースの PL は、税抜にした入出金を計上の本体（pl-bs-model.mjs の buildPlBs）へ cash: true で渡して作る。BS は計上の材料から作る（入金ベースの BS は作らない。計画の「計上と入金」）
import {splitByAllocation} from '../money-allocation.mjs';
import {buildPlBs, splitByWeights, sumOf, monthOfDate, ORIGIN_LABELS} from './pl-bs-model.mjs';

export const BASES = Object.freeze(['accrual', 'cash']);
export const DEFAULT_BASIS = 'accrual';
export const BASIS_LABELS = Object.freeze({accrual: '計上', cash: '入金'});
// 見出しに出す基準の説明（全画面の見出しに基準を出す。計画 #16）
export const BASIS_DESCRIPTIONS = Object.freeze({
  accrual: '計上（売上・経費は計上月・税抜）',
  cash: '入金（売上は入金日・経費は出金日の月・税抜。税抜にできない入出金は未確定）',
});

// 基準の引数を読む。無ければ既定（呼び出し側が渡す。会社の帳票は入金）。accrual・cash のほかは誤り（0や既定で埋めない）
export function parseBasis(raw, {defaultBasis = DEFAULT_BASIS} = {}) {
  if (raw === undefined || raw === null || raw === '') return {ok: true, basis: defaultBasis};
  if (BASES.includes(raw)) return {ok: true, basis: raw};
  return {ok: false, error: `基準（basis）は accrual（計上）か cash（入金）で指定してください（受け取った値: ${String(raw).slice(0, 40)}）`};
}

// 応答・文書に付ける基準の項目（基準の無い応答を出さない）
export function basisFields(basis) {
  if (!BASES.includes(basis)) throw new Error(`基準（basis）は ${BASES.join('・')} のどれかです`);
  return {basis, basisLabel: BASIS_LABELS[basis], basisDescription: BASIS_DESCRIPTIONS[basis]};
}

// 「未確定」に分けた理由（label は短い名前、note は理由。決まるまでの裁定は U-5・U-4）
export const UNSETTLED_REASONS = Object.freeze({
  receipt_amount_differs: {label: '請求額と違う額の入金', note: '源泉・手数料・一部入金など。入金の税抜の出し方は U-5 で未決'},
  receipt_allocation_incomplete: {label: '作品を決められない入金', note: '請求明細の作品の配賦がそろわない消込'},
  expense_amount_differs: {label: '経費の税込額と違う額の出金', note: '分割払い・源泉の控除の記録が無い出金など。出金の税抜の出し方は U-5 で未決'},
  royalty_amount_differs: {label: '報告書と違う額のロイヤリティの支払', note: '消費税・控除を含む支払など。支払の税抜の出し方は U-5 で未決'},
  committee_receipt: {label: '委員会からの受取', note: '受取の税の扱いと PL への入れ方は U-5 で未決'},
  investment_payment: {label: '委員会への出資の払込', note: '出資の税の扱い（U-4 R-e）と PL への入れ方（U-5）が未決'},
});
export const unsettledReasonLabel = (reason) => UNSETTLED_REASONS[reason]?.label ?? reason;

const events = (on, reversedOn) => (reversedOn ? [{on, sign: 1}, {on: reversedOn, sign: -1}] : [{on, sign: 1}]);

// 請求の入金 → 作品×売上明細の税抜（確定）と、税込の未確定。
// side: {receiptAllocations[{receiptId, invoiceId, amount, receivedOn, reversedOn, invoiceIncTax}], invoiceLines[{invoiceId, saleId, exTax, workId, bps}]}
// 返り値: settled[{workId, saleId, bps（請求明細の作品の配賦）, receiptId, invoiceId, on, month, amount}]、unsettled[{workId|null, workIds, receiptId, invoiceId, on, month, amount, reason}]
export function cashReceiptParts({receiptAllocations = [], invoiceLines = []} = {}) {
  const linesOf = new Map();
  for (const row of invoiceLines) {
    const invoiceId = Number(row.invoiceId);
    if (!linesOf.has(invoiceId)) linesOf.set(invoiceId, new Map());
    const lines = linesOf.get(invoiceId);
    const saleId = Number(row.saleId);
    if (!lines.has(saleId)) lines.set(saleId, {saleId, exTax: row.exTax, shares: []});
    lines.get(saleId).shares.push({work_id: Number(row.workId), allocation_bps: Number(row.bps)});
  }
  const settled = [];
  const unsettled = [];
  for (const a of receiptAllocations) {
    const lines = [...(linesOf.get(Number(a.invoiceId))?.values() ?? [])];
    const ids = {receiptId: Number(a.receiptId), invoiceId: Number(a.invoiceId)};
    const workIds = [...new Set(lines.flatMap((line) => line.shares.map((share) => share.work_id)))].sort((x, y) => x - y);
    const complete = lines.length > 0 && lines.every((line) => line.shares.reduce((n, share) => n + share.allocation_bps, 0) === 10000);
    const parts = complete ? lines.map((line) => ({line, split: splitByAllocation(line.exTax, line.shares)})) : null;
    if (parts && a.amount === a.invoiceIncTax) {
      for (const {line, split} of parts) {
        for (const share of line.shares) {
          for (const e of events(a.receivedOn, a.reversedOn)) {
            settled.push({workId: share.work_id, saleId: line.saleId, bps: share.allocation_bps, ...ids, on: e.on, month: monthOfDate(e.on), amount: e.sign * split.get(share.work_id)});
          }
        }
      }
      continue;
    }
    // 請求額と違う入金: 税込の額を、作品の税抜額の比で分ける（税抜にはしない）。分けられないときは作品を決めない
    let byWork = null;
    if (parts) {
      const exTaxByWork = new Map();
      for (const {split} of parts) for (const [workId, amount] of split) exTaxByWork.set(workId, sumOf([exTaxByWork.get(workId) ?? 0, amount]));
      byWork = splitByWeights(a.amount, [...exTaxByWork].map(([key, weight]) => ({key, weight})));
    }
    for (const e of events(a.receivedOn, a.reversedOn)) {
      if (!byWork) { unsettled.push({workId: null, workIds, ...ids, on: e.on, month: monthOfDate(e.on), amount: e.sign * a.amount, reason: 'receipt_allocation_incomplete'}); continue; }
      for (const [workId, amount] of byWork) unsettled.push({workId, workIds, ...ids, on: e.on, month: monthOfDate(e.on), amount: e.sign * amount, reason: 'receipt_amount_differs'});
    }
  }
  return {settled, unsettled};
}

// 経費の出金 → 経費の税抜（確定）と、出金の額のままの未確定。expenses: [{id, exTax, incTax, ...}]（取消の負の行を含めない）。
// payments: [{id, expenseId, paidOn, amount（取消の行は負）, reversesId, withheld（源泉の控除額。記録の無い出金は null）}]
// 返り値: settled[{expense, paymentId, on, month, exTax, amount（出金の額）}]、unsettled[{expense, paymentId, on, month, amount, reason}]
export function cashExpenseParts({expenses = [], payments = []} = {}) {
  const byId = new Map(expenses.map((row) => [Number(row.id), row]));
  const paymentById = new Map(payments.map((row) => [Number(row.id), row]));
  const paidInFull = (payment, expense) => Number.isSafeInteger(expense.incTax) && expense.incTax > 0 && payment.amount > 0
    && sumOf([payment.amount, payment.withheld ?? 0]) === expense.incTax;
  const settled = [];
  const unsettled = [];
  for (const payment of payments) {
    const expense = byId.get(Number(payment.expenseId));
    const origin = payment.reversesId == null ? payment : paymentById.get(Number(payment.reversesId));
    if (!expense || !origin) continue;
    const base = {expense, paymentId: Number(payment.id), on: payment.paidOn, month: monthOfDate(payment.paidOn)};
    if (paidInFull(origin, expense)) settled.push({...base, exTax: payment.reversesId == null ? expense.exTax : -expense.exTax, amount: payment.amount});
    else unsettled.push({...base, amount: payment.amount, reason: 'expense_amount_differs'});
  }
  return {settled, unsettled};
}

// ロイヤリティの支払 → 作品ごとの税抜（確定）と、未確定。payments: pl-bs-data の royaltyPayments（{statementId, paidOn, amount（取消は負）, weights[{workId, weight, net}]}）
export function cashRoyaltyParts(payments = []) {
  const settled = [];
  const unsettled = [];
  for (const payment of payments) {
    const weights = payment.weights || [];
    const sign = payment.amount < 0 ? -1 : 1;
    const nets = weights.map((row) => row.net);
    const exact = weights.length > 0 && nets.every((net) => Number.isSafeInteger(net) && net >= 0) && Math.abs(payment.amount) === sumOf(nets);
    const base = {statementId: payment.statementId, on: payment.paidOn, month: monthOfDate(payment.paidOn)};
    if (exact) {
      for (const row of weights) if (row.net !== 0) settled.push({...base, workId: Number(row.workId), amount: sign * row.net});
      continue;
    }
    const split = splitByWeights(payment.amount, weights.map((row) => ({key: Number(row.workId), weight: row.weight})));
    if (!split) { unsettled.push({...base, workId: null, amount: payment.amount, reason: 'royalty_amount_differs'}); continue; }
    for (const [workId, amount] of split) unsettled.push({...base, workId, amount, reason: 'royalty_amount_differs'});
  }
  return {settled, unsettled};
}

// 入金ベースの PL の計算の決まり（計算の決まりの欄。計上の決まりの代わりに出す）
export const CASH_HEADING_NOTES = Object.freeze([
  '入金ベースのPL: 売上は請求の入金の入金日の月（消込で結んだ請求明細の作品へ）、経費は出金日の月、ロイヤリティは支払日の月に載せます。どれも税抜です。取消は取消日の月に負の額です。BS は基準によらず月末の残高で、入金ベースの BS は作りません。',
  '税抜への換算（U-5 で未決の間の仮の出し方）: 請求どおりの額の入金・税込額どおりに払い切った出金・報告書どおりの額のロイヤリティの支払だけを、元の記録の税抜額で数えます。違う額（源泉・手数料・一部入金・分割払いなど）は税込のまま「未確定」の行に出し、利益に入れません。',
  '委員会作品は、委員会からの受取と委員会への出資の払込を「未確定」に出します（税の扱いと PL への入れ方が未決）。委員会作品の売上の入金は委員会の預り金、委員会作品の経費・ロイヤリティの支払は委員会の口座からの支払として、自社の PL に入れません。',
  '制作費は払った月の費用にします（公開月に一括にせず、制作中の作品に置きません）。手入力の額は計上と同じ月に入れます。',
  '経費の返金の入金・カードの引落・源泉の納付は入金ベースの経費に入れていません（経費は出金の記録の出金日で数えます）。',
]);

const SKIP_FOR_COMMITTEE = new Set(['receipt', 'expense', 'royalty']);

// 入金ベースの材料（計上の本体へ渡す形）と、未確定の入出金の一覧
function cashFlowsOf(input) {
  const works = input.works || [];
  const visible = new Set(works.map((work) => Number(work.id)));
  const committee = new Set(works.filter((work) => work.committee).map((work) => Number(work.id)));
  const side = input.cashSide || {};
  const receipts = cashReceiptParts(side);
  const expenses = cashExpenseParts({expenses: (input.expenses || []).filter((row) => Number(row.id) > 0), payments: side.expensePayments || []});
  const royalty = cashRoyaltyParts(input.royaltyPayments || []);
  const channelOf = new Map((input.saleLines || []).map((line) => [Number(line.saleId), line.channelGroup]));
  const selfPartnerId = input.profile?.selfPartnerId ?? null;
  const cashInput = {
    ...input,
    saleLines: receipts.settled.filter((part) => visible.has(part.workId))
      .map((part) => ({saleId: part.saleId, workId: part.workId, month: part.month, amount: part.amount, tax: 0, channelGroup: channelOf.get(part.saleId) || 'other'})),
    expenses: expenses.settled.map((part) => ({...part.expense, id: part.paymentId, month: part.month, exTax: part.exTax, tax: 0, incTax: 0})),
    royaltyAccruals: royalty.settled.map((part) => ({workId: part.workId, month: part.month, royaltyYen: part.amount, holdSalesYen: 0})),
    committee: (input.committee || []).map((row) => ({...row, acquisitions: [], error: null, holdNote: null})),
    expensePayments: [], royaltyPayments: [], royaltyRecoups: [], royaltyAdvances: [], receipts: [], investmentPayments: [], committeeReceipts: [], mg: [], expenseSettlement: null,
  };
  const all = [
    ...receipts.unsettled.map(({workIds, ...row}) => ({direction: 'in', kind: 'receipt', ...row})),
    ...expenses.unsettled.map(({expense, ...row}) => ({direction: 'out', kind: 'expense', workId: expense.workId == null ? null : Number(expense.workId), expenseId: Number(expense.id), ...row})),
    ...royalty.unsettled.map((row) => ({direction: 'out', kind: 'royalty', ...row})),
    ...(input.committeeReceipts || []).map((row) => ({direction: 'in', kind: 'committee_receipt', workId: Number(row.workId), on: row.receivedOn, month: monthOfDate(row.receivedOn), amount: row.amount, reason: 'committee_receipt'})),
    ...(input.investmentPayments || []).filter((row) => selfPartnerId && Number(row.partnerId) === Number(selfPartnerId))
      .map((row) => ({direction: 'out', kind: 'investment', workId: Number(row.workId), on: row.paidOn, month: monthOfDate(row.paidOn), amount: row.amount, reason: 'investment_payment'})),
  ];
  // 見えない作品の分は落とす。委員会作品の売上の入金（預り金）・経費・ロイヤリティの支払は委員会の口座の分なので PL の未確定にも出さない
  const unsettled = all.filter((row) => row.month && (row.workId === null || (visible.has(row.workId) && !(committee.has(row.workId) && SKIP_FOR_COMMITTEE.has(row.kind)))))
    .map((row) => ({...row, reasonLabel: unsettledReasonLabel(row.reason)}));
  return {cashInput, unsettled};
}

// 計上と入金のどちらかで PL・BS を作る。入金は PL（作品別PL・作品の月別・会社PL・PL の照合・経費の費目）を入金の材料から作り、
// BS（作品別の残高・会社BS・BS の照合）は計上と同じものを返す。未確定の入出金は作品別PL・作品の月別・会社PL に別の行で出す（利益に入れない）
export function buildPlBsForBasis(input = {}, basis = DEFAULT_BASIS) {
  const fields = basisFields(basis);
  const accrual = buildPlBs(input);
  if (basis === 'accrual') return {...accrual, ...fields, conditions: {...accrual.conditions, basis}, unsettled: null};
  const {cashInput, unsettled} = cashFlowsOf(input);
  const cash = buildPlBs(cashInput, {cash: true, headingNotes: [...CASH_HEADING_NOTES]});
  const {from, to} = accrual.conditions;
  const inPeriod = (month) => month >= from && month <= to;
  const upTo = (month) => month <= to;
  const sumWhere = (rows, predicate) => sumOf(rows.filter(predicate).map((row) => row.amount));

  const workPl = cash.workPl.map((row) => {
    const own = unsettled.filter((u) => u.workId === row.workId);
    const flow = (direction) => ({period: sumWhere(own, (u) => u.direction === direction && inPeriod(u.month)), cumulative: sumWhere(own, (u) => u.direction === direction && upTo(u.month))});
    const reasons = [...row.reasons];
    const shown = own.filter((u) => upTo(u.month));
    if (shown.length) reasons.push(`税抜にできない入出金を「未確定」に分け、利益に入れていません（${[...new Set(shown.map((u) => u.reasonLabel))].join('・')}）`);
    const origin = reasons.length ? 'unverified' : row.origin;
    return {...row, reasons, origin, originLabel: ORIGIN_LABELS[origin], unsettled: {inflow: flow('in'), outflow: flow('out')}};
  });

  // 作品の月別と会社PLの未確定の行（列は月・期間計・累計。月の列の額はその月の和）
  const columnValues = (columns, rows) => Object.fromEntries(columns.map((column) => {
    const month = column.key.startsWith('m:') ? column.key.slice(2) : null;
    const pick = month ? (u) => u.month === month : column.key === 'period' ? (u) => inPeriod(u.month) : (u) => upTo(u.month);
    return [column.key, sumWhere(rows, pick)];
  }));
  const unsettledRow = (key, label, columns, rows, extra = {}) => ({key, label, level: 0, emphasis: false, origin: 'unverified', originLabel: ORIGIN_LABELS.unverified,
    excluded: true, values: columnValues(columns, rows), ...extra});
  const workDetail = Object.fromEntries(Object.entries(cash.workDetail).map(([workId, detail]) => {
    if (!detail) return [workId, detail];
    const own = unsettled.filter((u) => u.workId === Number(workId));
    return [workId, {...detail, rows: [...detail.rows,
      unsettledRow('unsettled:in', '未確定の入金（税込・利益に入れない）', detail.columns, own.filter((u) => u.direction === 'in')),
      unsettledRow('unsettled:out', '未確定の出金（税込・利益に入れない）', detail.columns, own.filter((u) => u.direction === 'out'))]}];
  }));
  const plColumns = cash.companyPl.columns;
  const companyRows = [];
  for (const [direction, label] of [['in', '未確定の入金（税込・利益に入れない）'], ['out', '未確定の出金（税込・利益に入れない）']]) {
    const rows = unsettled.filter((u) => u.direction === direction);
    companyRows.push(unsettledRow(`unsettled:${direction}`, label, plColumns, rows, {section: 'unsettled', emphasis: true}));
    for (const reason of Object.keys(UNSETTLED_REASONS)) {
      const own = rows.filter((u) => u.reason === reason);
      if (own.some((u) => upTo(u.month))) companyRows.push(unsettledRow(`unsettled:${direction}:${reason}`, `　うち${unsettledReasonLabel(reason)}`, plColumns, own, {section: 'unsettled', level: 1}));
    }
  }

  // 期間に未確定の入出金があれば、利益の行（売上総利益〜当期純利益）と、未確定の入金の元の科目（売上高・委員会の取得額）の由来を未確定にする
  // （確定した額だけの利益なので、決まるまで数字を確定として見せない）
  const periodKinds = new Set(unsettled.filter((u) => inPeriod(u.month)).map((u) => u.kind));
  const affected = new Set([...(periodKinds.has('receipt') ? ['own_sales'] : []), ...(periodKinds.has('committee_receipt') ? ['committee_share'] : []),
    ...(periodKinds.has('royalty') ? ['royalty'] : [])]);
  const plRows = cash.companyPl.rows.map((row) => ((periodKinds.size && row.profit) || affected.has(row.key)
    ? {...row, origin: 'unverified', originLabel: ORIGIN_LABELS.unverified} : row));

  // 照合: PL は入金の材料から、BS は計上の材料から。未確定は作品の分＋作品に付かない分＝会社PLの未確定の行（期間計）
  const companyUnsettled = (direction) => companyRows.find((row) => row.key === `unsettled:${direction}`).values.period;
  const worksUnsettled = (direction) => sumOf(workPl.map((row) => row.unsettled[direction === 'in' ? 'inflow' : 'outflow'].period));
  const unattached = (direction) => sumWhere(unsettled, (u) => u.workId === null && u.direction === direction && inPeriod(u.month));
  const unsettledDiff = ['in', 'out'].map((direction) => companyUnsettled(direction) - worksUnsettled(direction) - unattached(direction)).find((value) => value !== 0) ?? 0;
  const checks = [
    ...cash.checks.filter((row) => row.part === 'pl'),
    {item: '未確定の入出金（作品の分＋作品に付かない分）＝ 会社PLの未確定の行（期間計）', value: unsettledDiff, ok: unsettledDiff === 0, scope: 'company', part: 'pl',
      detail: unsettledDiff === 0 ? '一致' : `差 ${unsettledDiff.toLocaleString('ja-JP')}円`},
    ...accrual.checks.filter((row) => row.part === 'bs'),
  ];
  return {
    ...accrual,
    ...fields,
    conditions: {...accrual.conditions, basis},
    headingNotes: cash.headingNotes,
    notes: [...new Set([...cash.notes, ...accrual.notes])],
    months: cash.months, firstMonth: cash.firstMonth,
    workPl, workDetail,
    companyPl: {...cash.companyPl, rows: [...plRows, ...companyRows]},
    expenseClassification: cash.expenseClassification,
    checks,
    unsettled: {rows: unsettled.filter((u) => inPeriod(u.month)).sort((a, b) => a.on.localeCompare(b.on) || a.direction.localeCompare(b.direction))},
  };
}
