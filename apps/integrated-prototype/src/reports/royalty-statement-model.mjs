// ロイヤリティ報告書（権利元×期間）の集計。純関数で、サーバーと試験が使う。
// 元の数字は既存の権利・分配の試算（settlementPreviewData の lineResults）と支払記録。新しい計算式は作らない。
// 期間: 計上月が from より前＝前回まで、from〜to＝当期、to まで＝累計。支払は支払日の月で同じ区分にする。
// 権利元額を算定できない明細（MG契約の回収後の分配など）は保留（HOLD）にして対象売上を残し、0円として合計に混ぜない。
// MG契約への支払はMG前払（充当は未確認）として別に数え、手数料型の支払・未払残と相殺しない。
// 支払・取消の記録は支払日が期間の終了月までのものだけを載せる（期間後の記録で発行済みの内容が変わらないように）。

const TYPE_LABELS = {commission: '手数料型（権利元へ分配）', mg: 'MG型（回収後の分配は条件未確認）', self_owned: '自社保有'};
const add = (a, b) => (a ?? 0) + (b ?? 0);
const periodOf = (month, from, to) => (month < from ? 'prior' : month <= to ? 'current' : 'future');

function blankMetrics() {
  return {reported: 0, platformDeduction: 0, agencyFee: 0, holderAmount: 0, paid: 0, advance: 0, holdReported: 0, holdCount: 0};
}

export function buildRoyaltyStatement({lines = [], contracts = [], payments = [], from, to, holderId = null}) {
  const contractMap = new Map(contracts.map((c) => [c.id, c]));
  const byContract = new Map();
  const ensure = (contract) => {
    if (!byContract.has(contract.id)) {
      byContract.set(contract.id, {
        contractId: contract.id, contractCode: contract.contract_code, title: contract.title, contractType: contract.contract_type,
        typeLabel: TYPE_LABELS[contract.contract_type] || contract.contract_type, workId: contract.work_id, workTitle: contract.work_title,
        holderId: contract.holder_partner_id, holderName: contract.holder_name, holderCode: contract.holder_code,
        prior: blankMetrics(), current: blankMetrics(), cumulative: blankMetrics(),
      });
    }
    return byContract.get(contract.id);
  };
  const details = [];
  const hold = [];
  for (const line of lines) {
    const contract = contractMap.get(line.contractId);
    if (!contract || contract.contract_type === 'self_owned') continue;
    if (holderId && contract.holder_partner_id !== holderId) continue;
    const period = periodOf(line.accountingMonth, from, to);
    if (period === 'future') continue;
    const row = ensure(contract);
    const isHold = line.holderAmount === null || line.holderAmount === undefined;
    const detail = {
      key: `${line.contractId}:${line.saleId}:${line.reportId}:${line.allocationBps}`, period: period === 'prior' ? '前回まで' : '当期',
      accountingMonth: line.accountingMonth, holderName: contract.holder_name, contractCode: contract.contract_code, workTitle: contract.work_title,
      description: line.description, reportId: line.reportId, sourceRow: line.sourceRow, reportBasis: line.reportBasis === 'gross' ? '控除前' : '控除後',
      reportedAmount: line.reportedAmount, platformDeduction: line.platformDeduction, agencyFee: line.agencyFee,
      holderAmount: isHold ? null : line.holderAmount, status: isHold ? '保留（HOLD）' : 'OK',
      holdReason: isHold ? (contract.contract_type === 'mg' ? 'MG契約の回収後の分配（超過分配）条件が未確認のため、権利元額を算定していません' : '権利元額を算定できません') : '',
    };
    details.push(detail);
    if (isHold) hold.push(detail);
    for (const bucket of period === 'prior' ? ['prior', 'cumulative'] : ['current', 'cumulative']) {
      const m = row[bucket];
      m.reported = add(m.reported, line.reportedAmount);
      m.platformDeduction = add(m.platformDeduction, line.platformDeduction);
      m.agencyFee = add(m.agencyFee, line.agencyFee);
      if (isHold) { m.holdReported = add(m.holdReported, line.reportedAmount); m.holdCount += 1; } else m.holderAmount = add(m.holderAmount, line.holderAmount);
    }
  }
  const paymentRows = [];
  // 取消の記録も期間の終了月までのものだけを見る（期間末の時点で有効だった支払を「取消済み」にしない）
  const reversed = new Map(payments.filter((p) => p.reverses_event_id && p.paid_on.slice(0, 7) <= to).map((p) => [p.reverses_event_id, p]));
  for (const payment of payments) {
    const contract = contractMap.get(payment.settlement_contract_id);
    if (!contract || contract.contract_type === 'self_owned') continue;
    if (holderId && contract.holder_partner_id !== holderId) continue;
    const period = periodOf(payment.paid_on.slice(0, 7), from, to);
    if (period === 'future') continue;
    const signed = payment.reverses_event_id ? -payment.amount_yen : payment.amount_yen;
    const advance = contract.contract_type === 'mg';
    const kind = payment.reverses_event_id ? '取消の記録' : reversed.has(payment.id) ? '支払（取消済み）' : '支払';
    paymentRows.push({key: payment.id, paidOn: payment.paid_on, holderName: contract.holder_name, contractCode: contract.contract_code, reference: payment.reference,
      amount: signed, kind: advance ? `${kind}（MG前払・充当未確認）` : kind, advance, reason: payment.reason, period: period === 'prior' ? '前回まで' : '当期'});
    const row = ensure(contract);
    const metric = advance ? 'advance' : 'paid';
    for (const bucket of period === 'prior' ? ['prior', 'cumulative'] : ['current', 'cumulative']) row[bucket][metric] = add(row[bucket][metric], signed);
  }
  const rows = [...byContract.values()].map((row) => ({...row, unpaid: row.cumulative.holderAmount - row.cumulative.paid}))
    .sort((a, b) => (a.holderName || '').localeCompare(b.holderName || '', 'ja') || a.contractCode.localeCompare(b.contractCode));
  const holders = new Map();
  for (const row of rows) {
    const key = row.holderId;
    if (!holders.has(key)) holders.set(key, {holderId: key, holderName: row.holderName, holderCode: row.holderCode, contracts: 0, prior: 0, current: 0, cumulative: 0, paid: 0, unpaid: 0, advance: 0, holdCount: 0, holdReported: 0});
    const h = holders.get(key);
    h.contracts += 1; h.prior += row.prior.holderAmount; h.current += row.current.holderAmount; h.cumulative += row.cumulative.holderAmount;
    h.paid += row.cumulative.paid; h.unpaid += row.unpaid; h.advance += row.cumulative.advance; h.holdCount += row.cumulative.holdCount; h.holdReported += row.cumulative.holdReported;
  }
  const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) ?? 0), 0);
  const checks = [
    {item: '前回まで＋当期＝累計（権利元額）', value: sum(rows, (r) => r.prior.holderAmount + r.current.holderAmount - r.cumulative.holderAmount)},
    {item: '明細の権利元額の和−一覧の累計（差0）', value: sum(details, (d) => d.holderAmount) - sum(rows, (r) => r.cumulative.holderAmount)},
    {item: '支払記録の和−一覧の累計支払（差0）', value: sum(paymentRows.filter((p) => !p.advance), (p) => p.amount) - sum(rows, (r) => r.cumulative.paid)},
    {item: 'MG前払の記録の和−一覧の累計MG前払（差0）', value: sum(paymentRows.filter((p) => p.advance), (p) => p.amount) - sum(rows, (r) => r.cumulative.advance)},
  ];
  return {
    from, to, holderId, rows, holders: [...holders.values()], details, hold, payments: paymentRows, checks,
    totals: {prior: sum(rows, (r) => r.prior.holderAmount), current: sum(rows, (r) => r.current.holderAmount), cumulative: sum(rows, (r) => r.cumulative.holderAmount),
      paid: sum(rows, (r) => r.cumulative.paid), unpaid: sum(rows, (r) => r.unpaid), advance: sum(rows, (r) => r.cumulative.advance), holdCount: hold.length, holdReported: sum(hold, (h) => h.reportedAmount)},
    assumptions: ['金額は税抜・円。源泉徴収は計上していません', '1つの契約の権利元は1者です', 'MG契約への支払はMG前払として別に示し、未払残とは相殺していません（回収後の分配条件が未確認のため）', '権利種別ごとの先取り控除（権利料を先に引き、残りを原作料などの基礎にする形）には未対応です',
      '製作委員会の分配は「製作委員会収支報告」で確かめてください', '下書き（未発行）。送付は人が行います'],
  };
}
