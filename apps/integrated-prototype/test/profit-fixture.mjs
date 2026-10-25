// 会社への利益額（K-16。フェーズ1 #14b）の試験の部品。架空の種（test/fixtures/yojitsu/seed.json）と入金の確認の架空の請求
// （test/fixtures/receipt-matching/invoices.json）から、利益額の記録（src/accounting/profit/profit-model.mjs の buildCompanyProfit の入力）を作る。
// golden（expected.json の「利益額」）は golden.py が同じ種から独立に計算した値で、ここは記録の形へ写すだけ（額の計算をしない）。
// 写し方: 種の「実績」の入金の行 → 請求どおりの入金（税別・案件・入金日の月）、請求明細 → 計上の売上明細（作品の案件）、経費 → 費用区分と負担者つきの経費と
// 払った日の出金（税込どおり）、出資の記録の払込（種の時点まで）→ 自社出資・製作委員会の払込、実績の買付（MG）→ MG の支払、実績の制作の実費 →
// 制作受託の案件の制作費の経費。実績の「出資」の行は出資の記録の払込と同じ事実なので写さない（DB では払込の記録1つ）
// 架空のデータだけを使う
import {readFileSync} from 'node:fs';

const read = (folder, name) => JSON.parse(readFileSync(new URL(`./fixtures/${folder}/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
export const invoicesDoc = () => read('receipt-matching', 'invoices.json');

// 種の語 → 統合システムのコード
export const EARNING_CODE = Object.freeze({買付: 'acquisition', 販売委託: 'consignment', 自社出資: 'own_investment', 製作委員会: 'committee', 制作受託: 'contract_work'});
export const EXPENSE_KIND = Object.freeze({制作費: 'production_cost', 宣伝費: 'promotion', 配給費: 'distribution'});
// golden の 除外 のうち、DB に記録の形が無い（種の「実績」の表が出資の記録の払込を二重に持つ）行
export const SEED_ONLY_EXCLUDED = '出資の実績の行（出資の記録の払込と同じ）';

const ym = (date) => String(date).slice(0, 7);

export function profitRecordsFromSeed(seed, invoices = invoicesDoc()) {
  const asOf = seed.as_of;
  const projectId = new Map(seed.案件.map((p, i) => [p.案件コード, i + 1]));
  const withWork = new Set(seed.works.map((w) => w.project_code));
  const projectOfWorkId = new Map(seed.works.map((w) => [w.work_id, w.project_code]));
  const projectOfWorkCode = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const partnerId = new Map(invoices.partners.map((p, i) => [p.partner_code, 1000 + i]));
  const partnerOfInvoice = new Map(invoices.invoices.map((v) => [v.invoice_number, partnerId.get(v.partner_code)]));
  const kubun = new Map(seed.vocabulary.kubun.map((k) => [k.name, k]));
  const projects = seed.案件.map((p) => ({id: projectId.get(p.案件コード), code: p.案件コード, title: p.案件名, earningType: EARNING_CODE[p.稼ぎ方], earningTypeLabel: p.稼ぎ方,
    rateBps: p.rate_bps, rateReason: null, hasWork: withWork.has(p.案件コード), mgContracts: 0, purchaseWorks: 0}));

  const settled = [];
  const unknownReceipts = [];
  const mgPayments = [];
  const buyoutPayments = [];
  const expenses = [];
  const expensePayments = [];
  for (const r of seed.実績) {
    const k = kubun.get(r.区分);
    if (k.direction === '入金') {
      if (!projectId.has(r.案件コード)) { unknownReceipts.push({month: ym(r.日付), amountYen: r['金額（円・税別）'], reason: 'no_project'}); continue; }
      settled.push({projectId: projectId.get(r.案件コード), month: ym(r.日付), exTaxYen: r['金額（円・税別）'], partnerId: partnerOfInvoice.get(r.invoice_number) ?? null});
    } else if (r.区分 === '買付') {
      (r.項目.includes('MG') ? mgPayments : buyoutPayments).push({projectId: projectId.get(r.案件コード), paidOn: r.日付, amountYen: r['金額（円・税別）']});
    } else if (r.区分 === '制作の実費') {
      const id = 900000 + expenses.length;
      expenses.push({id, projectId: projectId.get(r.案件コード), month: ym(r.日付), exTax: r['金額（円・税別）'], incTax: r['金額（円・税別）'], voidedOn: null, kind: 'production_cost', bearer: null});
      expensePayments.push({id, expenseId: id, paidOn: r.日付, amount: r['金額（円・税別）'], reversesId: null, withheld: null});
    } else if (r.区分 !== '出資') {
      throw new Error(`利益額の記録に写す形を決めていない実績の区分: ${r.区分}`);
    }
  }
  for (const [i, x] of seed.expenses.entries()) {
    const id = i + 1;
    expenses.push({id, projectId: projectId.get(x.project_code), month: ym(x.accounting_month), exTax: x.amount_ex_tax, incTax: x.amount_inc_tax, voidedOn: null,
      kind: EXPENSE_KIND[x.category], bearer: x.bearer === null ? null : x.bearer === '自社' ? 'self' : 'other'});
    if (x.paid_on && x.paid_on <= asOf) expensePayments.push({id: 10000 + id, expenseId: id, paidOn: x.paid_on, amount: x.amount_inc_tax, reversesId: null, withheld: null});
  }
  const ownInvestmentPayments = [];
  const committeeInvestmentPayments = [];
  for (const x of seed.investments) {
    const list = x.kind === '自社出資' ? ownInvestmentPayments : committeeInvestmentPayments;
    for (const p of x.payments) if (p.paid_on <= asOf) list.push({projectId: projectId.get(projectOfWorkCode.get(x.work_code)), paidOn: p.paid_on, amountYen: p.amount_yen});
  }
  const saleLines = [];
  const unknownSaleLines = [];
  for (const v of invoices.invoices) {
    for (const line of v.lines) {
      const code = projectOfWorkId.get(line.work_id);
      if (!projectId.has(code)) { unknownSaleLines.push({month: line.accounting_month, amountYen: line.amount_ex_tax, reason: 'no_project'}); continue; }
      saleLines.push({projectId: projectId.get(code), month: line.accounting_month, exTaxYen: line.amount_ex_tax, partnerId: partnerId.get(v.partner_code)});
    }
  }
  return {
    projects, receipts: {settled, unsettled: []}, unknownReceipts, saleLines, unknownSaleLines, expenses, expensePayments,
    ownInvestmentPayments, committeeInvestmentPayments, mgPayments, buyoutPayments,
    withholdingPartnerIds: invoices.contracts.filter((c) => c.foreign_withholding_bps).map((c) => partnerId.get(c.partner_code)),
    codeOf: new Map(projects.map((p) => [p.id, p.code])),
  };
}

// 応答（buildCompanyProfit の返り値・受け口の応答）を golden の「利益額.基準.<basis>」と同じ形にそろえる（比べるのは額と並びだけ）
export function asGoldenBasis(view) {
  const rows = (list) => list.map((r) => ({費目: r.label, 額: r.amounts, 合計: r.total}));
  return {
    月: view.months,
    確定: {売上: view.settled.salesYen, 経費: view.settled.costYen, 利益額: view.settled.profitYen,
      合計: {売上: view.settled.totals.salesYen, 経費: view.settled.totals.costYen, 利益額: view.settled.totals.profitYen}},
    未確定: rows(view.unsettled),
    除外: rows(view.excluded),
    案件不明: view.unknownProject && {額: view.unknownProject.amounts, 合計: view.unknownProject.total},
    案件別: view.byProject.map((p) => ({案件コード: p.code, 稼ぎ方: p.earningTypeLabel, 売上: p.salesYen, 経費: p.costYen, 利益額: p.profitYen})),
  };
}

// golden の基準の節から、比べる形だけを取り出す（未確定・除外の理由と状態の語は費目の表で別に照らす）
export function goldenBasis(profit, basis, {dropExcluded = [SEED_ONLY_EXCLUDED]} = {}) {
  const b = profit.基準[basis];
  const rows = (list) => list.map((r) => ({費目: r.費目, 額: r.額, 合計: r.合計}));
  return {
    月: profit.月,
    確定: b.確定,
    未確定: rows(b.未確定),
    除外: rows(b.除外.filter((r) => !dropExcluded.includes(r.費目))),
    案件不明: {額: b.案件不明.額, 合計: b.案件不明.合計},
    案件別: b.案件別,
  };
}
