// 支払う MG（権利元へ払う MG。買付分）の回収の計算（純関数）。
// 要件は docs/requirements/planning/rights-acquisition.md の FR-PLAN-ACQ-010〜014・039・040・045〜048、
// 計画は会社ルートの plans/2026-10-22-folder-mg-buy.md（仮説 H1・H3・H4、必ず成り立つ検査1〜3・6〜8）。
// 回収の値は表に持たず、結んだ売上明細から開くたびにこの関数で計算する（FR-PLAN-ACQ-011）。
// 金額は整数の円、率は bp。料率の額は 0 に向かって切り捨て（royalty-model.mjs の signedRateAmount）。
// 外貨（FR-PLAN-ACQ-042・043）はまだ扱わない。JPY 以外の条件版は例外にする。
// DB・時刻・環境変数は読まない。
import {signedRateAmount} from '../royalty/royalty-model.mjs';
import {scaledInteger} from '../sales-sheet/sales-sheet-input.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const fail = (message) => { throw new Error(message); };

function int(value, name, {min = 0} = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${name}は${min}以上の整数です`);
  return value;
}
function bps(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 10000) fail(`${name}は0〜10000の bp です`);
  return value;
}
function safeSum(values, name) {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!Number.isSafeInteger(total)) fail(`${name}が整数の範囲を超えています`);
  return total;
}

// 条件版を確かめて、計算に使う形にする。
export function normalizeTerm(term) {
  if (!term || typeof term !== 'object') fail('条件版がありません');
  const consideration = term.consideration;
  if (!['mg', 'buyout'].includes(consideration)) fail('対価の型は mg か buyout です');
  if ((term.currency ?? 'JPY') !== 'JPY') fail('外貨建ての条件版はまだ計算できません（FR-PLAN-ACQ-043）');
  const mgAmount = int(term.mgAmount, 'MG の額');
  const recoupBasis = term.recoupBasis ?? 'platform_net';
  if (!['platform_net', 'after_fee'].includes(recoupBasis)) fail('回収の基礎は platform_net か after_fee です');
  const platformRateBps = bps(term.platformRateBps ?? 0, 'PF の率');
  const agencyFeeBps = term.agencyFeeBps == null ? null : bps(term.agencyFeeBps, '手数料の率');
  if (recoupBasis === 'after_fee' && agencyFeeBps === null) fail('手数料の控除後を選んだときは手数料の率が要ります');
  // 超過後の分配: null＝未登録（保留）、false＝無し、true＝有り（率が要る）。買切は持たない（FR-PLAN-ACQ-009）
  let overageEnabled = term.overageEnabled ?? null;
  if (consideration === 'buyout') overageEnabled = false;
  if (![null, true, false].includes(overageEnabled)) fail('超過後の分配の有無は null・true・false です');
  const overageRateBps = overageEnabled === true ? bps(term.overageRateBps, '超過後の分配の率') : null;
  const pooling = term.pooling ?? 'all_media';
  if (!['all_media', 'per_media'].includes(pooling)) fail('回収のまとめ方は all_media か per_media です');
  const mediaAllocations = pooling === 'per_media' ? (term.mediaAllocations ?? []).map((row) => ({media: String(row.media), amount: int(row.amount, '媒体の配分額')})) : [];
  if (pooling === 'per_media') {
    if (!mediaAllocations.length) fail('媒体ごとに配分する契約は配分が1件以上要ります');
    if (new Set(mediaAllocations.map((row) => row.media)).size !== mediaAllocations.length) fail('同じ媒体の配分が重なっています');
  }
  const multiWork = term.multiWork ?? 'single';
  if (!['single', 'actual', 'hold_until_total'].includes(multiWork)) fail('作品をまたぐときの分け方は single・actual・hold_until_total です');
  const works = (term.works ?? []).map((row) => ({workId: String(row.workId), presetAmount: row.presetAmount == null ? null : int(row.presetAmount, '作品ごとの額')}));
  if (!works.length) fail('対象の作品が1件以上要ります');
  if (new Set(works.map((row) => row.workId)).size !== works.length) fail('同じ作品が重なっています');
  if (multiWork === 'single' && works.length !== 1) fail('作品が1つの契約は single、2つ以上は actual か hold_until_total です');
  if (multiWork !== 'single' && works.length < 2) fail('作品をまたぐ分け方は、作品が2つ以上のときだけ使えます');
  if (multiWork === 'hold_until_total' && !String(term.holdAgreementRef ?? '').trim()) fail('全体の超過まで分配しない約束の根拠が要ります（FR-PLAN-ACQ-048）');
  const deductions = (term.deductions ?? []).map((row) => ({
    category: String(row.category),
    capAmount: row.capAmount == null ? null : int(row.capAmount, '費目の上限額'),
    capBps: row.capBps == null ? null : bps(row.capBps, '費目の上限の率'),
  }));
  if (new Set(deductions.map((row) => row.category)).size !== deductions.length) fail('同じ費目が重なっています');
  const paymentSchedule = (term.paymentSchedule ?? []).map((row) => ({installment: int(row.installment, '支払の回', {min: 1}), trigger: String(row.trigger), amount: int(row.amount, '支払予定の額')}));
  return {consideration, mgAmount, recoupBasis, platformRateBps, agencyFeeBps, overageEnabled, overageRateBps, pooling, mediaAllocations,
    shortfallFromOtherMedia: term.shortfallFromOtherMedia === true, multiWork, works, deductions, paymentSchedule};
}

// 売上明細1行の回収の元（app.mjs の settlementPreviewData と同じ段: 控除前なら PF の率を引き、after_fee なら手数料も引く）。
export function lineRecoupSource(term, line) {
  const amount = int(line.amountExTax, '当社売上（税抜）', {min: Number.MIN_SAFE_INTEGER});
  const reportBasis = line.reportBasis ?? 'net';
  if (!['gross', 'net'].includes(reportBasis)) fail('報告の額の基礎は gross か net です');
  const platformNet = reportBasis === 'gross' ? amount - signedRateAmount(amount, term.platformRateBps) : amount;
  const fee = term.agencyFeeBps == null ? 0 : signedRateAmount(platformNet, term.agencyFeeBps);
  return term.recoupBasis === 'after_fee' ? platformNet - fee : platformNet;
}

// 数量×単価＝当社売上（検査6）。単価は売上集計シートの桁（小数4桁まで）の文字のまま整数倍に読み、丸めずに比べる。差が1円以内なら合う。
// 数量か単価が読めない行は検査しない（null）
const UNIT_DIGITS = 4;
export function quantityPriceMismatch(line) {
  if (line.quantity == null || line.unitPrice == null || !Number.isSafeInteger(line.quantity)) return null;
  const unit = scaledInteger(line.unitPrice, UNIT_DIGITS);
  if (unit === null) return null;
  const scale = 10n ** BigInt(UNIT_DIGITS);
  const diff = BigInt(line.quantity) * BigInt(unit) - BigInt(line.amountExTax) * scale;
  return (diff < 0n ? -diff : diff) > scale ? {quantity: line.quantity, unitPrice: String(line.unitPrice), actual: line.amountExTax} : null;
}

// 最大剰余法: total を weights の比で整数に配る。剰余が同じなら並びの先を優先する。
export function largestRemainder(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum <= 0) return weights.map(() => 0);
  const big = BigInt(total), bigSum = BigInt(sum);
  const parts = weights.map((w, index) => {
    const num = big * BigInt(w);
    return {index, base: num / bigSum, rest: num % bigSum};
  });
  let left = Number(big - parts.reduce((a, p) => a + p.base, 0n));
  const order = [...parts].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const p of order) { if (left <= 0) break; p.base += 1n; left -= 1; }
  return parts.map((p) => Number(p.base));
}

// 分配の前に引く費目（FR-PLAN-ACQ-040、仮説 H3）。契約に無い費目は引かず、上限を超えた分も引かずに例外にする。
function applyDeductions(term, expenses, exceptions) {
  const byCategory = new Map();
  for (const row of expenses ?? []) {
    const category = String(row.category);
    byCategory.set(category, (byCategory.get(category) ?? 0) + int(row.amount, '経費の額'));
  }
  const rows = [];
  for (const [category, total] of byCategory) {
    const rule = term.deductions.find((d) => d.category === category);
    if (!rule) { exceptions.push({kind: 'deduction_not_in_contract', category, amount: total}); continue; }
    const caps = [rule.capAmount, rule.capBps == null ? null : signedRateAmount(term.mgAmount, rule.capBps)].filter((v) => v != null);
    const cap = caps.length ? Math.min(...caps) : null;
    const applied = cap == null ? total : Math.min(total, cap);
    if (applied < total) exceptions.push({kind: 'deduction_cap_exceeded', category, amount: total, cap, notDeducted: total - applied});
    rows.push({category, requested: total, applied, cap});
  }
  return rows;
}

// 1契約（1条件版）の回収を、asOfMonth までの計上月の売上と経費で計算する。
// lines: [{saleId, workId, media, accountingMonth, amountExTax, reportBasis?, quantity?, unitPrice?}]
// expenses: [{category, amount}]（asOfMonth までに分配の前に引く対象として記録したもの）
export function computeRecoup({term: rawTerm, lines = [], expenses = [], asOfMonth}) {
  const term = normalizeTerm(rawTerm);
  if (!MONTH.test(String(asOfMonth))) fail('締め月は YYYY-MM です');
  const exceptions = [];
  const workIds = new Set(term.works.map((w) => w.workId));
  const seen = new Set();
  const counted = [];
  for (const line of lines) {
    if (!MONTH.test(String(line.accountingMonth))) fail('売上の計上月は YYYY-MM です');
    if (line.accountingMonth > asOfMonth) continue;
    const saleId = String(line.saleId);
    if (seen.has(saleId)) fail(`同じ売上明細が2回あります: ${saleId}`);
    seen.add(saleId);
    if (!workIds.has(String(line.workId))) { exceptions.push({kind: 'work_not_in_term', saleId, workId: String(line.workId)}); continue; }
    if (term.pooling === 'per_media' && !term.mediaAllocations.some((m) => m.media === String(line.media))) {
      exceptions.push({kind: 'media_not_allocated', saleId, media: String(line.media)}); continue;
    }
    const mismatch = quantityPriceMismatch(line);
    if (mismatch) exceptions.push({kind: 'quantity_price_mismatch', saleId, ...mismatch});
    counted.push({...line, saleId, workId: String(line.workId), media: String(line.media), source: lineRecoupSource(term, line)});
  }
  const deductions = applyDeductions(term, expenses, exceptions);
  const deducted = safeSum(deductions.map((d) => d.applied), '控除の和');
  const gross = safeSum(counted.map((l) => l.source), '回収の元の和');
  const base = gross - deducted;

  let recouped, overage;
  const media = [];
  if (term.pooling === 'per_media' && !term.shortfallFromOtherMedia) {
    // 媒体ごとに配分した額だけをその媒体の売上で回収する（仮説 H1）。控除は配分の比で媒体に配る
    const sources = term.mediaAllocations.map((m) => safeSum(counted.filter((l) => l.media === m.media).map((l) => l.source), '媒体の回収の元'));
    const cuts = largestRemainder(deducted, term.mediaAllocations.map((m) => m.amount));
    recouped = 0; overage = 0;
    term.mediaAllocations.forEach((m, index) => {
      const mediaBase = sources[index] - cuts[index];
      const r = Math.min(Math.max(mediaBase, 0), m.amount);
      const o = Math.max(mediaBase - m.amount, 0);
      recouped += r; overage += o;
      media.push({media: m.media, allocation: m.amount, base: mediaBase, recouped: r, balance: m.amount - r, overage: o});
    });
  } else {
    recouped = Math.min(Math.max(base, 0), term.mgAmount);
    overage = Math.max(base - term.mgAmount, 0);
  }
  const balance = term.mgAmount - recouped;

  let status, distribution;
  if (term.consideration === 'buyout') { status = 'buyout'; distribution = 0; overage = 0; }
  else if (overage === 0) { status = 'recouping'; distribution = 0; }
  else if (term.overageEnabled === null) { status = 'hold'; distribution = null; }
  else if (term.overageEnabled === false) { status = 'recouped'; distribution = 0; }
  else { status = 'recouped'; distribution = signedRateAmount(overage, term.overageRateBps); }

  // 作品ごとの分配額（FR-PLAN-ACQ-046〜048）。どちらの分け方も、全体の超過のあとは回収の元の累計の比で配る
  const workBases = term.works.map((w) => safeSum(counted.filter((l) => l.workId === w.workId).map((l) => l.source), '作品の回収の元'));
  const workShares = distribution == null ? term.works.map(() => null)
    : term.works.length === 1 ? [distribution] : largestRemainder(distribution, workBases.map((b) => Math.max(b, 0)));
  const works = term.works.map((w, index) => ({workId: w.workId, base: workBases[index], distribution: workShares[index]}));

  // 報告書を出してよいか（FR-PLAN-ACQ-031・048。問い5 A: 全体の超過まで回収中の報告も止める）
  const statementAllowed = !(term.multiWork === 'hold_until_total' && overage === 0);

  const checks = [
    {key: 'recouped_plus_balance', ok: recouped + balance === term.mgAmount},
    {key: 'distribution_formula', ok: distribution == null || term.overageEnabled !== true || distribution === signedRateAmount(overage, term.overageRateBps)},
    {key: 'work_shares_sum', ok: distribution == null || works.reduce((a, w) => a + w.distribution, 0) === distribution},
    {key: 'quantity_price', ok: !exceptions.some((e) => e.kind === 'quantity_price_mismatch')},
    {key: 'deduction_cap', ok: !exceptions.some((e) => e.kind === 'deduction_cap_exceeded')},
    {key: 'allocation_sum', ok: term.pooling !== 'per_media' || safeSum(term.mediaAllocations.map((m) => m.amount), '配分の和') === term.mgAmount},
    {key: 'payment_schedule_sum', ok: !term.paymentSchedule.length || safeSum(term.paymentSchedule.map((p) => p.amount), '支払予定の和') === term.mgAmount},
  ];
  return {asOfMonth, status, mgAmount: term.mgAmount, gross, deducted, base, recouped, balance, overage, distribution,
    statementAllowed, media, works, deductions, exceptions, checks, lineCount: counted.length};
}

// 前回の締めとの差（報告書の発行で仕訳する当期の消化の増分と、作品ごとの分配額の増分。約束 F-2、FR-PLAN-ACQ-047）。
export function recoupIncrement(previous, current) {
  const prevWorks = new Map((previous?.works ?? []).map((w) => [w.workId, w.distribution ?? 0]));
  return {
    recouped: current.recouped - (previous?.recouped ?? 0),
    distribution: current.distribution == null ? null : current.distribution - (previous?.distribution ?? 0),
    works: current.works.map((w) => ({workId: w.workId, distribution: w.distribution == null ? null : w.distribution - (prevWorks.get(w.workId) ?? 0)})),
  };
}
