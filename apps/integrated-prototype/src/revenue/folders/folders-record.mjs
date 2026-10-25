// フォルダからの受け取りの、型の実績と判定の語（純関数）。
// 要件は docs/requirements/revenue/folder-entry.md の FR-REV-FOLDER-010・013。
// 表5（検査の結果）と表6（抜き取りの記録）に相当する行は、呼び出し側がメモリ上の配列で渡す。数える列は持たない。
// DB・時刻・環境変数は読まない。確からしさの％は出さない（出すのは検査の合否の数・正答 100%・実績の通数）。

// 問い7は B。人が確かめて直しの出なかった通が30通続いたら、自動で確定に切り替える。
export const AUTO_CONFIRM_RECORD = 30;
// 問い8は A。10通に1通から始め、抜き取りの直し無しが30通続くごとに半分、下限は30通に1通。
export const SAMPLING_START_DENOMINATOR = 10;
export const SAMPLING_HALVE_EVERY = 30;
export const SAMPLING_FLOOR_DENOMINATOR = 30;

const REVIEW_RESULTS = new Set(['clean', 'type_error', 'source_error']);

const VIEW = Object.freeze({
  auto: {label: '自動で確定', mark: '✓ 確定'},
  human: {label: '人の確認', mark: '! 要確認'},
  human_record: {label: '人の確認（実績が足りない）', mark: '! 実績'},
  shape: {label: '形が違う', mark: '✕ 形違い'},
  unread: {label: '人が読む', mark: '人 要読'},
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// 正の整数どうしの切り捨ての商。金額ではないが、浮動小数の割り算を通さない。
function divFloor(numerator, denominator) {
  return Number(BigInt(numerator) / BigInt(denominator));
}

// 抜き取りの直し無しが n 通のときの分母。0〜29は10、30〜59は20、60以上は30（40にはしない）。
export function samplingDenominator(samplingClean) {
  const n = Number.isSafeInteger(samplingClean) && samplingClean > 0 ? samplingClean : 0;
  const steps = Math.min(divFloor(n, SAMPLING_HALVE_EVERY), 8);
  let denominator = SAMPLING_START_DENOMINATOR;
  for (let i = 0; i < steps; i += 1) {
    const next = denominator * 2;
    if (next > SAMPLING_FLOOR_DENOMINATOR) return SAMPLING_FLOOR_DENOMINATOR;
    denominator = next;
  }
  return denominator;
}

// 自動で確定した通の通し番号（1始まり）を、その時点の分母で割って割り切れる通を抜く。番号は分母が変わっても1から数え直さない。
export function isSamplingPick(ordinal, denominator) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return false;
  if (!Number.isSafeInteger(denominator) || denominator < 1) return false;
  return BigInt(ordinal) % BigInt(denominator) === 0n;
}

function isLater(a, b) {
  if (a.at > b.at) return true;
  if (a.at < b.at) return false;
  return a.id > b.id;
}

function validRun(run, checkVersionId) {
  return !!run && run.checkVersionId === checkVersionId && typeof run.sourceFileId === 'string' && run.sourceFileId !== ''
    && typeof run.at === 'string' && run.at !== '' && Number.isSafeInteger(run.id);
}

function validReview(review) {
  return !!review && Number.isSafeInteger(review.id) && Number.isSafeInteger(review.checkRunId)
    && typeof review.at === 'string' && review.at !== '' && typeof review.result === 'string';
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// 1つの型の版について、人が見た通だけから実績と抜き取りの連続を導く。
// 直し無しは実績を1増やす。原本の誤りは実績を増やさず0にも戻さない（続く）。型の誤りは両方を0に戻す。
// 自動で確定してレビューの無い通は数えない。抜き取りの連続（分母を下げる数）は、自動で確定した通の直し無しだけを数え、原本の誤りで切る。
export function deriveFolderRecord({checkVersionId, runs, reviews} = {}) {
  const versionRuns = asArray(runs).filter(run => validRun(run, checkVersionId));
  const latestRun = new Map();
  let goldenRun = null;
  for (const run of versionRuns) {
    const prev = latestRun.get(run.sourceFileId);
    if (!prev || isLater(run, prev)) latestRun.set(run.sourceFileId, run);
    if (!goldenRun || isLater(run, goldenRun)) goldenRun = run;
  }
  const runById = new Map([...latestRun.values()].map(run => [run.id, run]));
  const latestReview = new Map();
  let unreadable = 0;
  for (const review of asArray(reviews)) {
    if (!validReview(review)) continue;
    const run = runById.get(review.checkRunId);
    if (!run) continue;
    if (!REVIEW_RESULTS.has(review.result)) unreadable += 1;
    const prev = latestReview.get(run.sourceFileId);
    if (!prev || isLater(review, prev.review)) latestReview.set(run.sourceFileId, {review, run});
  }
  const ordered = [...latestReview.values()].sort((a, b) => (isLater(a.review, b.review) ? 1 : -1));
  let record = 0;
  let samplingClean = 0;
  for (const {review, run} of ordered) {
    if (review.result === 'type_error') {
      record = 0;
      samplingClean = 0;
      continue;
    }
    if (review.result === 'source_error') {
      if (run.judgment === 'auto') samplingClean = 0;
      continue;
    }
    if (review.result !== 'clean') {
      if (run.judgment === 'auto') samplingClean = 0;
      continue;
    }
    record += 1;
    if (run.judgment === 'auto') samplingClean += 1;
  }
  const goldenMatched = safeCount(goldenRun?.goldenMatched);
  const goldenTotal = safeCount(goldenRun?.goldenTotal);
  const goldenComplete = goldenMatched != null && goldenTotal != null && goldenTotal > 0 && goldenMatched === goldenTotal;
  return {
    checkVersionId: checkVersionId ?? null,
    record,
    samplingClean,
    samplingDenominator: record >= AUTO_CONFIRM_RECORD ? samplingDenominator(samplingClean) : null,
    autoConfirmRecordMet: record >= AUTO_CONFIRM_RECORD,
    looked: ordered.length,
    unreadable,
    goldenMatched: goldenMatched ?? 0,
    goldenTotal: goldenTotal ?? 0,
    goldenComplete,
  };
}

function fraction(passed, total) {
  return Number.isSafeInteger(passed) && Number.isSafeInteger(total) ? `${passed}/${total}` : null;
}

function presentation(key, src, record) {
  const ratio = fraction(src.checksPassed, src.checksTotal);
  if (key === 'auto') return {headline: ratio ? `✓ 確定 ${ratio}` : '✓ 確定', tags: ['正答 100%', `実績 ${record}`]};
  if (key === 'human_record') return {headline: `! 実績 ${record}/${AUTO_CONFIRM_RECORD}`, tags: ratio ? [`検査 ${ratio}`] : []};
  if (key === 'human') {
    const failed = ratio && src.checksTotal >= src.checksPassed ? src.checksTotal - src.checksPassed : null;
    return {headline: failed != null ? `! 要確認 ${failed}` : '! 要確認', tags: ratio ? [`検査 ${ratio}`] : []};
  }
  if (key === 'shape') return {headline: '✕ 形違い', tags: Array.isArray(src.shapeLabels) ? src.shapeLabels.filter(label => typeof label === 'string') : []};
  return {headline: '人 要読', tags: ['PDF']};
}

// この1通を確定してよいか。record と samplingClean は、この1通を見る前の型の実績（deriveFolderRecord の戻り）。
// 語の優先: 画像だけの PDF → 形が違う → 検査・正答率・予測外・重なり・確かめ後の変更 → 実績不足 → 自動で確定。
export function judgeFolderIntake(input) {
  const src = input && typeof input === 'object' ? input : {};
  const samplingClean = Number.isSafeInteger(src.samplingClean) && src.samplingClean >= 0 ? src.samplingClean : 0;
  if (src.kind === 'image_pdf') {
    return {judgment: 'unread', ...VIEW.unread, ...presentation('unread', src, 0), reasons: ['image_pdf'], samplingDenominator: null, record: 0};
  }
  if (src.kind === 'shape') {
    return {judgment: 'shape', ...VIEW.shape, ...presentation('shape', src, 0), reasons: ['shape'], samplingDenominator: null, record: 0};
  }
  const passed = Number.isSafeInteger(src.checksPassed) ? src.checksPassed : null;
  const total = Number.isSafeInteger(src.checksTotal) ? src.checksTotal : null;
  const countsOk = passed != null && total != null && total > 0 && passed === total;
  const checksOk = src.checksAllPass === true && countsOk;
  const matched = safeCount(src.goldenMatched);
  const goldenTotal = safeCount(src.goldenTotal);
  const goldenOk = matched != null && goldenTotal != null && goldenTotal > 0 && matched === goldenTotal;
  const record = safeCount(src.record);
  const recordOk = record != null && record >= AUTO_CONFIRM_RECORD;
  const gated = src.outOfForecast === true || src.hasOverlap === true || src.mastersChanged === true;
  const blockers = [];
  if (src.kind !== 'fixed') blockers.push('kind');
  if (!checksOk) blockers.push('checks');
  if (!goldenOk) blockers.push('accuracy');
  if (src.outOfForecast === true) blockers.push('forecast');
  if (src.hasOverlap === true) blockers.push('overlap');
  if (src.mastersChanged === true) blockers.push('masters');
  if (!recordOk) blockers.push('record');
  let key = 'auto';
  if (src.kind !== 'fixed' || !checksOk || !goldenOk || gated) key = 'human';
  else if (!recordOk) key = 'human_record';
  const reasons = key === 'auto' ? [] : key === 'human_record' ? ['record'] : blockers.filter(reason => reason !== 'record' || record == null);
  const shownRecord = record ?? 0;
  return {
    judgment: key,
    ...VIEW[key],
    ...presentation(key, src, shownRecord),
    reasons,
    samplingDenominator: key === 'auto' ? samplingDenominator(samplingClean) : null,
    record: shownRecord,
  };
}
