// 支払う MG の支払の集計（純関数）。要件は docs/requirements/planning/rights-acquisition.md の FR-PLAN-ACQ-015・019・042、
// 計画は会社ルートの plans の 2026-10-22-folder-mg-buy（仮説 H4、約束 F-1・Y-1）。
// MG の前払と超過の分配額は別々に数え、相殺しない（FR-PLAN-ACQ-015）。取り消した支払（元と取消の行の両方）は数えない。
import {scaledInteger} from '../sales-sheet/sales-sheet-input.mjs';

export const FX_RATE_DIGITS = 6;

// 取消の行と、取り消された元の行を除いた、生きている支払
export function livePayments(payments) {
  const reversed = new Set(payments.filter((p) => p.reverses_payment_id != null).map((p) => p.reverses_payment_id));
  return payments.filter((p) => p.reverses_payment_id == null && !reversed.has(p.id));
}

// schedule: acq_mg_payment_schedule の行、payments: acq_mg_payments の行、
// distributionOwed: 取り消されていない最新の発行の分配額の累計（発行が無ければ 0）
export function summarizePayments({mgAmount, schedule, payments, distributionOwed}) {
  const live = livePayments(payments);
  const sum = (rows) => rows.reduce((a, p) => a + p.amount_yen, 0);
  const mg = live.filter((p) => p.kind === 'mg_advance');
  const installments = schedule.map((s) => {
    const paid = sum(mg.filter((p) => p.installment === s.installment));
    return {installment: s.installment, trigger: s.trigger_kind, dueOn: s.due_on, amount: s.amount, paid, unpaid: Math.max(s.amount - paid, 0)};
  });
  const mgPaid = sum(mg);
  const distributionPaid = sum(live.filter((p) => p.kind === 'distribution'));
  return {
    mgAmount, mgPaid, mgUnpaid: Math.max(mgAmount - mgPaid, 0), installments,
    distributionOwed, distributionPaid, distributionUnpaid: Math.max(distributionOwed - distributionPaid, 0),
  };
}

// 支払の入力の確かめ（DB を読まずに決まる分）。レートは小数6桁までの文字のまま100万倍の整数にする（丸めない）
export function readPaymentInput(x) {
  const fail = (message) => Object.assign(new Error(message), {status: 400});
  const kind = String(x.kind ?? '');
  if (!['mg_advance', 'distribution'].includes(kind)) throw fail('支払の種類は MG の前払か分配額です');
  const amountYen = Number(x.amountYen);
  if (!Number.isSafeInteger(amountYen) || amountYen < 1) throw fail('円の額は1以上の整数です');
  const paidOn = String(x.paidOn ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw fail('支払日は YYYY-MM-DD で入力してください');
  const reference = String(x.reference ?? '').trim();
  if (!reference || reference.length > 160) throw fail('参照（振込の番号など）は1〜160文字です');
  const reason = String(x.reason ?? '').trim();
  if (!reason || reason.length > 1000) throw fail('理由は1〜1000文字です');
  const currency = String(x.currency ?? 'JPY').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw fail('通貨は3文字の通貨コードです');
  let foreignAmount = null, fxRateMicro = null, fxRateOn = null;
  if (currency !== 'JPY') {
    foreignAmount = Number(x.foreignAmount);
    if (!Number.isSafeInteger(foreignAmount) || foreignAmount < 1) throw fail('外貨の額は通貨の最小単位の1以上の整数です');
    fxRateMicro = scaledInteger(x.fxRate, FX_RATE_DIGITS);
    if (fxRateMicro === null || fxRateMicro < 1) throw fail('レートは小数6桁までの正の数です');
    fxRateOn = String(x.fxRateOn ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fxRateOn)) throw fail('レートの日は YYYY-MM-DD で入力してください');
  }
  const installment = x.installment == null || x.installment === '' ? null : Number(x.installment);
  if (installment !== null && (!Number.isInteger(installment) || installment < 1)) throw fail('支払の回を確認してください');
  const statementId = x.statementId == null || x.statementId === '' ? null : Number(x.statementId);
  if (kind === 'distribution' && !Number.isSafeInteger(statementId)) throw fail('分配額の支払は、分配報告書を選んでください');
  if (kind === 'mg_advance' && statementId !== null) throw fail('MG の前払に報告書は付けません');
  if (kind === 'distribution' && installment !== null) throw fail('分配額の支払に支払の回は付けません');
  return {kind, amountYen, paidOn, reference, reason, currency, foreignAmount, fxRateMicro, fxRateOn, installment, statementId};
}
