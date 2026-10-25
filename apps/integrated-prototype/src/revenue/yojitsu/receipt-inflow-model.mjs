// 入金を案件に結ぶ規則の純関数（フェーズ1の仕様書 #14。要件 FR-REV-YOJITSU-031・032、計画の「計上と入金」の節）。
// 消込（billing_receipt_allocations）→ 請求明細（billing_invoice_lines）の作品の配賦（billing_invoice_line_works）→ 作品の案件（works.project_id）。
// 1つの入金が複数の案件にまたがるときは、請求明細の税抜額を作品の配賦で分けた額（最大剰余法。src/money-allocation.mjs）の比で割る。
// 入金の税抜の出し方は U-5 の残りで、決まるまで FR-REV-YOJITSU-032 の仮の出し方: 請求どおりの額で入った入金（消込の額＝請求の税込額）は、
// 結んだ請求明細の税抜額の和を税抜の入金とする（確定）。請求額と違う額で入った入金（一部入金・源泉・手数料など）は税抜にせず「未確定」に分け、
// 4段の実績に入れない（税込の額を案件の税抜額の比で分けて返す）。入金の取消は取消日の月に負の額。
// 案件に結べない入金（請求の無い入金・支援金）は、入金の確認の計画 #6 の表が入るまで記録の形が無い（消込は請求を必ず指す）。
// 会社への利益額（フェーズ1 #14b）も同じ規則で入金を案件に結ぶ。DB・時刻・環境変数を読まない（docs/rules/architecture.md）
import {splitByAllocation} from '../../money-allocation.mjs';
import {splitByWeights} from '../../reports/pl-bs-model.mjs';

const monthOf = (date) => `${date.slice(0, 7)}-01`;
const num = (value) => Number(value);

// 消込ごとにまとめる。rows は store の receiptLinesStatement の行（消込×請求明細×作品の配賦）
function groupAllocations(rows) {
  const allocations = new Map();
  for (const row of rows) {
    const key = `${row.receipt_id}:${row.invoice_id}`;
    if (!allocations.has(key)) {
      allocations.set(key, {receiptId: num(row.receipt_id), invoiceId: num(row.invoice_id), receivedOn: row.received_on, reversedOn: row.reversed_on ?? null,
        allocatedYen: num(row.allocated_yen), invoiceIncTaxYen: num(row.invoice_inc_tax), lines: new Map()});
    }
    const allocation = allocations.get(key);
    const saleId = num(row.sale_id);
    if (!allocation.lines.has(saleId)) allocation.lines.set(saleId, {exTaxYen: num(row.line_ex_tax), shares: []});
    allocation.lines.get(saleId).shares.push({work_id: num(row.work_id), allocation_bps: num(row.allocation_bps), projectId: num(row.project_id)});
  }
  return [...allocations.values()];
}

// 請求の税抜額を案件へ分ける（明細ごとに作品の配賦で分け、作品の案件へ足す）。配賦の和が 10000 でない明細があれば null（分けられない）
function exTaxByProject(allocation) {
  const out = new Map();
  for (const line of allocation.lines.values()) {
    if (line.shares.reduce((sum, s) => sum + s.allocation_bps, 0) !== 10000) return null;
    const parts = splitByAllocation(line.exTaxYen, line.shares);
    for (const share of line.shares) out.set(share.projectId, (out.get(share.projectId) ?? 0) + parts.get(share.work_id));
  }
  return out;
}

// 消込の行から、案件×月の入金を返す。projectIds は読む人が財務の権限を持つ案件の id（ほかの案件の分は返さない）。
// 返り値: settled（請求どおりの入金。{projectId, month: 月初の日, exTaxYen（取消は負）, receiptId, invoiceId}）、
// unsettled（請求額と違う入金。{projectId, month, amountYen（税込。取消は負）, reason: 'amount_differs'|'allocation_incomplete', receiptId, invoiceId}。
// 作品の配賦がそろわず案件へ分けられない消込は projectId が null で、その請求の全部の作品の案件が見てよい案件のときだけ返す）
export function linkReceiptsToProjects(rows, {projectIds}) {
  const permitted = new Set([...projectIds].map(Number));
  const settled = [];
  const unsettled = [];
  for (const allocation of groupAllocations(rows)) {
    const events = [{on: allocation.receivedOn, sign: 1}];
    if (allocation.reversedOn) events.push({on: allocation.reversedOn, sign: -1});
    const ids = {receiptId: allocation.receiptId, invoiceId: allocation.invoiceId};
    const byProject = exTaxByProject(allocation);
    if (byProject !== null && allocation.allocatedYen === allocation.invoiceIncTaxYen) {
      for (const [projectId, exTaxYen] of byProject) {
        if (!permitted.has(projectId)) continue;
        for (const e of events) settled.push({projectId, month: monthOf(e.on), exTaxYen: e.sign * exTaxYen, ...ids});
      }
      continue;
    }
    // 請求額と違う入金: 税込の額を、案件の税抜額の比で分ける（税抜への換算はしない。U-5）
    const parts = byProject === null ? null : splitByWeights(allocation.allocatedYen, [...byProject].map(([key, weight]) => ({key, weight})));
    if (parts === null) {
      // 作品の配賦がそろわない・税抜額が正の案件が無い消込は案件へ分けない（請求の全部の作品の案件が見てよい案件のときだけ返す）
      const projects = new Set([...allocation.lines.values()].flatMap((line) => line.shares.map((s) => s.projectId)));
      if (![...projects].every((id) => permitted.has(id))) continue;
      for (const e of events) unsettled.push({projectId: null, month: monthOf(e.on), amountYen: e.sign * allocation.allocatedYen, reason: 'allocation_incomplete', ...ids});
      continue;
    }
    for (const [projectId, amountYen] of parts) {
      if (!permitted.has(projectId)) continue;
      for (const e of events) unsettled.push({projectId, month: monthOf(e.on), amountYen: e.sign * amountYen, reason: 'amount_differs', ...ids});
    }
  }
  return {settled, unsettled};
}
