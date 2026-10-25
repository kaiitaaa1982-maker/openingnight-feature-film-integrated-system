// 製作委員会の収支の台帳（純関数）。1回分の計算を台帳の行にし、台帳の行から収支報告書（前回まで累計・今回・累計）と
// 相手ごとの累計を導く。累計の列は持たず、いつも行の和で出す。
// 要件: docs/requirements/settlement/committee.md（FR-SETL-COMM-015〜018）。設計: 会社ルート plans/2026-10-23-committee-terms-ledger.md の C。

// 区分。配分金・A・D は区分の和から導くので行にしない
export const SECTIONS = Object.freeze({
  income: '収入',
  expense: '支出',
  secondary_royalty: '権利処理費',
  agent_fee: '業務手数料',
  other_income: 'その他収入',
  overhead: '委員会経費',
  manager_fee: '幹事手数料',
  success_fee: '成功報酬',
  member_distribution: '当事者への配分',
});
const BUSINESS_SECTIONS = ['income', 'expense', 'secondary_royalty', 'agent_fee'];
const COMMITTEE_COST_SECTIONS = ['overhead', 'manager_fee', 'success_fee'];

function add(a, b) {
  const out = Number(BigInt(a) + BigInt(b));
  if (!Number.isSafeInteger(out)) throw new Error('台帳の和が安全な整数を超えました');
  return out;
}

// calcRound（committee-formula-model.mjs）の結果を台帳の行にする。round = {tier, closeOn}、businesses の key は事業化権利の語
export function entriesFromRound(result, {tier, closeOn, incomeItems = {}}) {
  if (!tier || !closeOn) throw new Error('台帳の行には段と締め日が要ります');
  const rows = [];
  const row = (business, section, amountYen, extra = {}) => rows.push({tier, closeOn, business, section, amountYen, item: null, counterparty: null, holderRole: null, ...extra});
  for (const lane of result.lanes) {
    const items = incomeItems[lane.key];
    if (items && items.length) {
      const total = items.reduce((acc, x) => add(acc, x.amountYen), 0);
      if (total !== lane.incomeYen) throw new Error(`${lane.key} の収入の内訳の和が収入と一致しません`);
      for (const x of items) row(lane.key, 'income', x.amountYen, {item: x.item, counterparty: x.counterparty ?? null});
    } else row(lane.key, 'income', lane.incomeYen);
    for (const s of lane.steps) row(lane.key, s.kind, s.amountYen, {item: s.item ?? null, counterparty: s.counterparty ?? null, holderRole: s.holderRole ?? null});
  }
  if (result.otherIncomeYen) row(null, 'other_income', result.otherIncomeYen);
  for (const s of result.committee.steps) row(null, s.kind, s.amountYen, {item: s.item ?? null, counterparty: s.counterparty ?? null});
  for (const d of result.distributions) row(null, 'member_distribution', d.amountYen, {counterparty: d.partnerId, item: `${d.shareBps}bp`});
  return rows;
}

// 1つの区分×事業の、前回まで累計・今回・累計
function split3(rows, closeOn) {
  let prior = 0, current = 0;
  for (const r of rows) {
    if (r.closeOn < closeOn) prior = add(prior, r.amountYen);
    else if (r.closeOn === closeOn) current = add(current, r.amountYen);
  }
  return {prior, current, cumulative: add(prior, current)};
}
const minus3 = (a, b) => ({prior: add(a.prior, -b.prior), current: add(a.current, -b.current), cumulative: add(a.cumulative, -b.cumulative)});
const plus3 = (a, b) => ({prior: add(a.prior, b.prior), current: add(a.current, b.current), cumulative: add(a.cumulative, b.cumulative)});
const zero3 = () => ({prior: 0, current: 0, cumulative: 0});

// 収支報告書の数字。entries は1つの契約×段の行。closeOn の回を「今回」にし、それより後の回は数えない
export function statement(entries, {closeOn, investmentTotalYen}) {
  const businesses = [...new Set(entries.filter((r) => r.business).map((r) => r.business))];
  const pick = (f) => split3(entries.filter(f), closeOn);
  const byBusiness = businesses.map((business) => {
    const parts = Object.fromEntries(BUSINESS_SECTIONS.map((s) => [s, pick((r) => r.business === business && r.section === s)]));
    const distribution = minus3(minus3(minus3(parts.income, parts.expense), parts.secondary_royalty), parts.agent_fee);
    return {business, ...parts, distribution};
  });
  const A = byBusiness.reduce((acc, b) => plus3(acc, b.distribution), zero3());
  const B = pick((r) => r.section === 'other_income');
  const costs = Object.fromEntries(COMMITTEE_COST_SECTIONS.map((s) => [s, pick((r) => r.section === s)]));
  const C = COMMITTEE_COST_SECTIONS.reduce((acc, s) => plus3(acc, costs[s]), zero3());
  const D = minus3(plus3(A, B), C);
  const distributed = pick((r) => r.section === 'member_distribution');
  if (distributed.prior !== D.prior || distributed.current !== D.current) throw new Error('当事者への配分の和が委員会配分 D と一致しません');
  const E = {prior: investmentTotalYen, current: 0, cumulative: investmentTotalYen};
  return {byBusiness, A, B, C, costs, D, E, balance: {prior: add(D.prior, -E.prior), current: D.current, cumulative: add(D.cumulative, -E.cumulative)}};
}

// 相手ごとの累計（closeOn の回まで）。section の行を key ごとに足す。key は既定で相手（counterparty）、著作権者は役×相手
export function cumulativeBy(entries, {section, closeOn, key = (r) => r.counterparty}) {
  if (!SECTIONS[section]) throw new Error(`区分 ${section} はありません`);
  const out = new Map();
  for (const r of entries) {
    if (r.section !== section || (closeOn && r.closeOn > closeOn)) continue;
    const k = key(r);
    const cur = out.get(k) ?? {prior: 0, current: 0, cumulative: 0};
    if (closeOn && r.closeOn === closeOn) cur.current = add(cur.current, r.amountYen);
    else cur.prior = add(cur.prior, r.amountYen);
    cur.cumulative = add(cur.prior, cur.current);
    out.set(k, cur);
  }
  return out;
}

// 受け取った収支報告書の「前回まで累計」と台帳の照合。reported: [{business, section, priorYen}]（business は委員会全体なら null）
export function checkReportedPrior(entries, {closeOn, reported}) {
  return reported.map(({business = null, section, priorYen}) => {
    const ledger = split3(entries.filter((r) => (r.business ?? null) === business && r.section === section), closeOn).prior;
    return {business, section, reportedYen: priorYen, ledgerYen: ledger, diffYen: add(priorYen, -ledger), ok: priorYen === ledger};
  });
}

// 幹事から届いた収支報告書の1回分（全行）を、そのまま台帳の行にする（区分ごとの額は報告書の値。式で計算し直さない）。
// report: {businesses: [{business, income, expense, secondary_royalty, agent_fee}]（各 [{amountYen, item?, counterparty?, holderRole?}]）,
//          other_income, overhead, manager_fee, success_fee（同じ形の並び）, member_distribution: [{counterparty, amountYen}]}
// 当事者への配分の和が A＋B−C と一致しなければ、差を添えて断る（報告書の読み違いか、幹事の計算の誤り）。
export function entriesFromReport(report, {tier, closeOn}) {
  if (!tier || !closeOn) throw new Error('台帳の行には段と締め日が要ります');
  const rows = [];
  const push = (business, section, list = []) => {
    for (const x of list) {
      if (!Number.isSafeInteger(x.amountYen)) throw new Error(`${business ?? '委員会'} の ${SECTIONS[section]} に整数の円でない額があります`);
      rows.push({tier, closeOn, business, section, amountYen: x.amountYen, item: x.item ?? null, counterparty: x.counterparty ?? null,
        holderRole: section === 'secondary_royalty' ? (x.holderRole ?? null) : null});
    }
  };
  for (const b of report.businesses ?? []) {
    if (!b.business) throw new Error('事業化権利の無い事業の行があります');
    for (const s of BUSINESS_SECTIONS) push(b.business, s, b[s]);
  }
  for (const s of ['other_income', ...COMMITTEE_COST_SECTIONS]) push(null, s, report[s]);
  for (const d of report.member_distribution ?? []) if (d.counterparty == null) throw new Error('当事者の無い配分の行があります');
  push(null, 'member_distribution', report.member_distribution);
  const total = (f) => rows.filter(f).reduce((acc, r) => add(acc, r.amountYen), 0);
  const a = total((r) => r.section === 'income') - total((r) => ['expense', 'secondary_royalty', 'agent_fee'].includes(r.section));
  const expected = add(add(a, total((r) => r.section === 'other_income')), -total((r) => COMMITTEE_COST_SECTIONS.includes(r.section)));
  const distributed = total((r) => r.section === 'member_distribution');
  if (expected !== distributed) throw Object.assign(new Error(`当事者への配分の和（${distributed}円）が A＋B−C（${expected}円）と一致しません`), {code: 'committee_report_unbalanced', diffYen: distributed - expected});
  return rows;
}

// 同じ回の、報告書から作った行と、条件版の式で計算した行を、事業×区分（委員会全体は区分）ごとに比べる。差のある所だけを返す
export function compareWithFormula(reportEntries, formulaEntries) {
  const keyOf = (r) => `${r.business ?? ''}|${r.section}`;
  const sums = (rows) => rows.reduce((m, r) => m.set(keyOf(r), add(m.get(keyOf(r)) ?? 0, r.amountYen)), new Map());
  const a = sums(reportEntries);
  const b = sums(formulaEntries);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  return keys.flatMap((k) => {
    const reportYen = a.get(k) ?? 0;
    const formulaYen = b.get(k) ?? 0;
    if (reportYen === formulaYen) return [];
    const [business, section] = k.split('|');
    return [{business: business || null, section, reportYen, formulaYen, diffYen: add(reportYen, -formulaYen)}];
  });
}
