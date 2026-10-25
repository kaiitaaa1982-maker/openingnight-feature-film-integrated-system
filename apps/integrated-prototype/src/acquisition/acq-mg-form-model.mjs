// 業務画面「MG 買付」の契約の登録フォームの入力を、受け口（POST /api/acq-mg/contracts）の形にする（純関数）。
// 率は % の文字のまま bp に直す（丸めない。royalty-model の percentToBps）。読めない値はここで止める。
import {percentToBps} from '../royalty/royalty-model.mjs';

// 画面の入力を受け口の形にする。読めない率・額は受け口に送らずにここで止める
export function contractPayload(f) {
  const rate = (text, name) => { const bps = percentToBps(text); if (bps === null || bps > 10000) throw new Error(`${name}は 0〜100（%、小数2桁まで）で入れてください`); return bps; };
  const yenOf = (text, name) => { const n = Number(String(text).replace(/,/g, '')); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name}は0以上の整数の円で入れてください`); return n; };
  if (!f.workIds.length) throw new Error('対象の作品を1つ以上選んでください');
  const mgAmount = yenOf(f.mgAmount, 'MG の額');
  const payload = {
    code: f.code, title: f.title, partnerId: Number(f.partnerId), consideration: f.consideration, mgAmount, startsOn: f.startsOn, endsOn: f.endsOn,
    recoupBasis: f.recoupBasis, platformRateBps: rate(f.platformRate || '0', 'PF の率'), agencyFeeBps: f.recoupBasis === 'after_fee' ? rate(f.agencyFee, '手数料の率') : null,
    overageEnabled: f.consideration === 'buyout' ? false : f.overage === 'yes' ? true : f.overage === 'no' ? false : null,
    overageRateBps: f.consideration === 'mg' && f.overage === 'yes' ? rate(f.overageRate, '超過後の分配の率') : undefined,
    works: f.workIds.map((workId) => ({workId: Number(workId)})),
    multiWork: f.workIds.length > 1 ? f.multiWork : 'single', holdAgreementRef: f.multiWork === 'hold_until_total' ? f.holdAgreementRef : null,
    paymentSchedule: f.schedule.filter((s) => s.amount !== '').map((s) => ({trigger: s.trigger, amount: yenOf(s.amount, '支払予定の額'), dueOn: s.dueOn || null})),
    deductions: f.deductions.filter((d) => d.category.trim()).map((d) => ({category: d.category.trim(), capAmount: d.capAmount === '' ? null : yenOf(d.capAmount, '費目の上限'), sourceRef: d.sourceRef})),
    phases: [{startsMonth: f.startsOn.slice(0, 7), cycleKind: f.cycleKind, anchorMonth: ['quarterly', 'semiannual', 'annual'].includes(f.cycleKind) ? Number(f.anchorMonth) : null, reportOffsetMonths: 1, paymentOffsetMonths: 1}],
    reason: f.reason,
  };
  const scheduled = payload.paymentSchedule.reduce((a, s) => a + s.amount, 0);
  if (payload.paymentSchedule.length && scheduled !== mgAmount) throw new Error(`支払予定の和（${scheduled} 円）を MG の額（${mgAmount} 円）にそろえてください`);
  return payload;
}

