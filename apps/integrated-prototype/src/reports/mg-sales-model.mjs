// MG売上報告の表示用の整形（純関数）。/api/rights-reports/mg-portfolio の結果を、取引先別・明細・台帳・照合の表にする。
// 契約単位の値（MG保証額・未消化残高・到達月・状態）は明細の各行で合計してはいけないため、契約の先頭行だけに置き、
// 重複なしの合計は別に計算して示す。

export function contractStatus(contract) {
  if (contract.unverifiedCount > 0) return {code: 'unverified', label: '条件未確認'};
  if (!contract.guaranteeYen) return {code: 'zero', label: '保証額0円'};
  return contract.cumulative.appliedYen >= contract.guaranteeYen ? {code: 'reached', label: '到達済'} : {code: 'open', label: '未到達'};
}

export function partyRows(report) {
  return (report?.parties || []).map((party) => ({
    key: `${party.type}:${party.id}`, partyName: party.name, partyCode: party.code, contractCount: party.contractCount,
    guaranteeYen: party.guaranteeYen, currentApplied: party.current.appliedYen, cumulativeApplied: party.cumulative.appliedYen,
    remainingApplied: party.remainingAppliedYen, exceedApplied: party.exceedAppliedYen, currentRecognized: party.current.recognizedYen,
    cumulativeRecognized: party.cumulative.recognizedYen, appliedRate: party.appliedRate,
  }));
}

export function detailRows(report) {
  const rows = [];
  for (const contract of report?.contracts || []) {
    const status = contractStatus(contract);
    contract.rows.forEach((row, index) => {
      const first = index === 0;
      rows.push({
        key: `${contract.contractId}:${row.workId}:${row.productId}`, contractId: contract.contractId, productId: row.productId,
        partyName: contract.party.name, contractCode: contract.code, contractTitle: contract.title, termVersion: contract.termVersion,
        workName: row.workName, productLabel: `${row.productSku}｜${row.productName}`,
        priorApplied: row.prior.appliedYen, currentApplied: row.current.appliedYen, cumulativeApplied: row.cumulative.appliedYen,
        currentEligible: row.current.eligibleYen, cumulativeEligible: row.cumulative.eligibleYen,
        currentOverage: row.current.overageYen, cumulativeOverage: row.cumulative.overageYen,
        currentRecognized: row.current.recognizedYen, cumulativeRecognized: row.cumulative.recognizedYen,
        // 契約単位（先頭行だけ）
        guaranteeYen: first ? contract.guaranteeYen : null,
        remainingApplied: first ? contract.remainingAppliedYen : null,
        reachedMonth: first ? contract.appliedReachedMonth || '未到達' : null,
        status: first ? status.label : null,
        isContractHead: first,
      });
    });
  }
  return rows;
}

export function ledgerRows(report) {
  const rows = [];
  for (const contract of report?.contracts || []) {
    const products = new Map(contract.rows.map((row) => [row.productId, `${row.productSku}｜${row.productName}`]));
    for (const entry of contract.sourceEntries || []) {
      rows.push({
        key: `${contract.contractId}:${entry.id}`, entryId: entry.id, contractId: contract.contractId, productId: entry.product_id,
        partyName: contract.party.name, contractCode: contract.code, productLabel: products.get(entry.product_id) || `商品 ${entry.product_id}`,
        periodFrom: entry.period_from, periodTo: entry.period_to, accountingMonth: entry.accounting_month, sourceReference: entry.source_reference,
        eligible: entry.reported_eligible_yen, applied: entry.applied_recoup_yen, overage: entry.reported_overage_yen, recognized: entry.recognized_yen,
        status: entry.status === 'reviewed' ? '確認済' : '未確認', reverses: entry.reverses_entry_id ? `#${entry.reverses_entry_id}の訂正` : '',
      });
    }
  }
  return rows;
}

// 照合: 明細の累計実充当＝台帳（基準月までの有効な行）の和、未消化残高＝保証額−累計実充当（0未満は0）
export function reconcile(report) {
  const detail = detailRows(report);
  const ledger = ledgerRows(report).filter((row) => row.accountingMonth <= report.accountingMonth);
  const cumulative = detail.reduce((sum, row) => sum + row.cumulativeApplied, 0);
  const ledgerApplied = ledger.reduce((sum, row) => sum + row.applied, 0);
  const guaranteeOnce = (report?.contracts || []).reduce((sum, contract) => sum + contract.guaranteeYen, 0);
  const remainingByRule = (report?.contracts || []).reduce((sum, contract) => sum + Math.max(0, contract.guaranteeYen - contract.cumulative.appliedYen), 0);
  const remainingReported = (report?.contracts || []).reduce((sum, contract) => sum + contract.remainingAppliedYen, 0);
  return [
    {item: '累計実充当（明細の和）', value: cumulative},
    {item: '累計実充当（台帳の和・基準月まで）', value: ledgerApplied},
    {item: '差額（0であること）', value: cumulative - ledgerApplied},
    {item: 'MG保証額（契約ごとに1回）', value: guaranteeOnce},
    {item: '未消化残高（保証額−累計実充当、0未満は0）', value: remainingByRule},
    {item: '未消化残高（帳票の値）', value: remainingReported},
    {item: '差額（0であること）', value: remainingByRule - remainingReported},
  ];
}
