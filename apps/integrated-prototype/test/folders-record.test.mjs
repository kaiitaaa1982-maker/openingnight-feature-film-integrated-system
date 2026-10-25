// FR-REV-FOLDER-010・013。実績と抜き取りは、表5・6に相当する架空の行（メモリ上の配列）から導く。
// 境界は問い7（30通。29は足りない）と問い8（10通に1通、30通ごとに半分、下限30通に1通）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFolderChecks} from '../src/revenue/folders/folders-checks.mjs';
import {deriveFolderRecord, isSamplingPick, judgeFolderIntake, samplingDenominator} from '../src/revenue/folders/folders-record.mjs';

const VERSION = 'cv-demo';

function at(index) {
  return `2026-05-01T00:00:${String(index).padStart(4, '0')}Z`;
}

function batch(n, {judgment, result = 'clean', idStart, atStart, version = VERSION, goldenMatched = 3, goldenTotal = 3, reviewed = true}) {
  const runs = [];
  const reviews = [];
  for (let i = 0; i < n; i += 1) {
    const id = idStart + i;
    runs.push({
      id, sourceFileId: `file-${id}`, checkVersionId: version, at: at(atStart + i), judgment,
      goldenMatched, goldenTotal,
    });
    if (reviewed) reviews.push({id, sourceFileId: `file-${id}`, checkRunId: id, at: at(atStart + i), result});
  }
  return {runs, reviews};
}

function merge(...parts) {
  return {runs: parts.flatMap(part => part.runs), reviews: parts.flatMap(part => part.reviews)};
}

function derive(part, checkVersionId = VERSION) {
  return deriveFolderRecord({checkVersionId, runs: part.runs, reviews: part.reviews});
}

const ready = {
  kind: 'fixed', checksAllPass: true, checksPassed: 14, checksTotal: 14,
  goldenMatched: 3, goldenTotal: 3, outOfForecast: false, hasOverlap: false, mastersChanged: false,
};

test('FR-REV-FOLDER-013 実績は29通では基準に届かず、30通で届き、見ていない自動確定は数えない', () => {
  const almost = derive(batch(29, {judgment: 'human_record', idStart: 1, atStart: 0}));
  assert.equal(almost.record, 29);
  assert.equal(almost.autoConfirmRecordMet, false);
  assert.equal(almost.samplingDenominator, null);
  assert.equal(almost.looked, 29);

  const met = derive(batch(30, {judgment: 'human_record', idStart: 1, atStart: 0}));
  assert.equal(met.record, 30);
  assert.equal(met.autoConfirmRecordMet, true);
  assert.equal(met.samplingClean, 0);
  assert.equal(met.samplingDenominator, 10);
  assert.equal(met.goldenComplete, true);

  const unseen = derive(merge(
    batch(30, {judgment: 'human_record', idStart: 1, atStart: 0}),
    batch(10, {judgment: 'auto', idStart: 101, atStart: 200, reviewed: false}),
  ));
  assert.equal(unseen.record, 30);
  assert.equal(unseen.looked, 30);
  assert.equal(unseen.samplingDenominator, 10);
});

test('FR-REV-FOLDER-013 原本の誤りは実績を切らず、型の誤りは0から数え直し、別の版には影響しない', () => {
  const continued = derive(merge(
    batch(29, {judgment: 'human_record', idStart: 1, atStart: 0}),
    batch(1, {judgment: 'human_record', result: 'source_error', idStart: 40, atStart: 40}),
    batch(1, {judgment: 'human_record', idStart: 41, atStart: 41}),
  ));
  assert.equal(continued.record, 30);
  assert.equal(continued.samplingClean, 0);

  const reset = derive(merge(
    batch(30, {judgment: 'human_record', idStart: 1, atStart: 0}),
    batch(1, {judgment: 'human_record', result: 'type_error', idStart: 80, atStart: 80}),
  ));
  assert.equal(reset.record, 0);
  assert.equal(reset.samplingClean, 0);
  assert.equal(reset.samplingDenominator, null);

  const after = derive(merge(
    batch(30, {judgment: 'human_record', idStart: 1, atStart: 0}),
    batch(1, {judgment: 'human_record', result: 'type_error', idStart: 80, atStart: 80}),
    batch(1, {judgment: 'human_record', idStart: 81, atStart: 81}),
  ));
  assert.equal(after.record, 1);

  const other = derive(batch(1, {judgment: 'human_record', idStart: 1, atStart: 0, version: 'cv-other'}), 'cv-other');
  const mine = derive(merge(
    batch(30, {judgment: 'human_record', idStart: 1, atStart: 0}),
    batch(5, {judgment: 'human_record', idStart: 201, atStart: 0, version: 'cv-other'}),
  ));
  assert.equal(other.record, 1);
  assert.equal(mine.record, 30);
});

test('FR-REV-FOLDER-013 抜き取りの直し無しは29のまま10通に1通、30で20通に1通、60で下限の30通に1通', () => {
  assert.equal(samplingDenominator(0), 10);
  assert.equal(samplingDenominator(29), 10);
  assert.equal(samplingDenominator(30), 20);
  assert.equal(samplingDenominator(59), 20);
  assert.equal(samplingDenominator(60), 30);
  assert.equal(samplingDenominator(90), 30);
  assert.equal(samplingDenominator(1000), 30);

  const human = batch(30, {judgment: 'human_record', idStart: 1, atStart: 0});
  const at29 = derive(merge(human, batch(29, {judgment: 'auto', idStart: 101, atStart: 100})));
  assert.equal(at29.record, 59);
  assert.equal(at29.samplingClean, 29);
  assert.equal(at29.samplingDenominator, 10);

  const at30 = derive(merge(human, batch(30, {judgment: 'auto', idStart: 101, atStart: 100})));
  assert.equal(at30.record, 60);
  assert.equal(at30.samplingClean, 30);
  assert.equal(at30.samplingDenominator, 20);

  const at59 = derive(merge(human, batch(59, {judgment: 'auto', idStart: 101, atStart: 100})));
  assert.equal(at59.samplingClean, 59);
  assert.equal(at59.samplingDenominator, 20);

  const at60 = derive(merge(human, batch(60, {judgment: 'auto', idStart: 101, atStart: 100})));
  assert.equal(at60.record, 90);
  assert.equal(at60.samplingClean, 60);
  assert.equal(at60.samplingDenominator, 30);

  const at90 = derive(merge(human, batch(90, {judgment: 'auto', idStart: 101, atStart: 100})));
  assert.equal(at90.samplingClean, 90);
  assert.equal(at90.samplingDenominator, 30);

  const cut = derive(merge(
    human,
    batch(10, {judgment: 'auto', idStart: 101, atStart: 100}),
    batch(1, {judgment: 'auto', result: 'source_error', idStart: 150, atStart: 150}),
    batch(1, {judgment: 'auto', idStart: 151, atStart: 151}),
  ));
  assert.equal(cut.record, 41);
  assert.equal(cut.samplingClean, 1);
  assert.equal(cut.samplingDenominator, 10);
});

test('FR-REV-FOLDER-013 抜き取りは10通に1通から選び、分母20と30の境界で1通だけを抜く', () => {
  const picks = [];
  for (let ordinal = 1; ordinal <= 10; ordinal += 1) if (isSamplingPick(ordinal, 10)) picks.push(ordinal);
  assert.deepEqual(picks, [10]);
  assert.equal(isSamplingPick(9, 10), false);
  assert.equal(isSamplingPick(10, 10), true);
  assert.equal(isSamplingPick(20, 10), true);
  assert.equal(isSamplingPick(10, 20), false);
  assert.equal(isSamplingPick(20, 20), true);
  assert.equal(isSamplingPick(29, 30), false);
  assert.equal(isSamplingPick(30, 30), true);
  assert.equal(isSamplingPick(60, 30), true);
});

test('FR-REV-FOLDER-013 最新の回だけを見、時刻の順で数え、古い回のレビューは実績に入れない', () => {
  const rechecked = derive({
    runs: [
      {id: 1, sourceFileId: 'file-1', checkVersionId: VERSION, at: at(1), judgment: 'human_record', goldenMatched: 3, goldenTotal: 3},
      {id: 2, sourceFileId: 'file-1', checkVersionId: VERSION, at: at(2), judgment: 'human_record', goldenMatched: 2, goldenTotal: 3},
    ],
    reviews: [{id: 1, sourceFileId: 'file-1', checkRunId: 1, at: at(1), result: 'clean'}],
  });
  assert.equal(rechecked.record, 0);
  assert.equal(rechecked.goldenMatched, 2);
  assert.equal(rechecked.goldenTotal, 3);
  assert.equal(rechecked.goldenComplete, false);

  const byTime = derive({
    runs: [
      {id: 1, sourceFileId: 'file-1', checkVersionId: VERSION, at: at(1), judgment: 'human_record', goldenMatched: 3, goldenTotal: 3},
      {id: 2, sourceFileId: 'file-2', checkVersionId: VERSION, at: at(2), judgment: 'human_record', goldenMatched: 3, goldenTotal: 3},
    ],
    reviews: [
      {id: 2, sourceFileId: 'file-2', checkRunId: 2, at: at(2), result: 'clean'},
      {id: 1, sourceFileId: 'file-1', checkRunId: 1, at: at(1), result: 'type_error'},
    ],
  });
  assert.equal(byTime.record, 1);
});

test('FR-REV-FOLDER-010 正解表が0件のときは一致していても goldenComplete を false にする', () => {
  const empty = derive(batch(1, {
    judgment: 'human_record', idStart: 1, atStart: 0, goldenMatched: 0, goldenTotal: 0,
  }));
  assert.equal(empty.goldenMatched, 0);
  assert.equal(empty.goldenTotal, 0);
  assert.equal(empty.goldenComplete, false);
});

test('FR-REV-FOLDER-010 検査が全部合い正答率が100%で実績が30通なら自動で確定し、29通は実績不足', () => {
  const confirmed = judgeFolderIntake({...ready, record: 30, samplingClean: 0});
  assert.equal(confirmed.judgment, 'auto');
  assert.equal(confirmed.label, '自動で確定');
  assert.equal(confirmed.mark, '✓ 確定');
  assert.equal(confirmed.headline, '✓ 確定 14/14');
  assert.deepEqual(confirmed.tags, ['正答 100%', '実績 30']);
  assert.deepEqual(confirmed.reasons, []);
  assert.equal(confirmed.samplingDenominator, 10);
  assert.equal(JSON.stringify(confirmed).includes('％'), false);

  const short = judgeFolderIntake({...ready, record: 29, samplingClean: 0});
  assert.equal(short.judgment, 'human_record');
  assert.equal(short.label, '人の確認（実績が足りない）');
  assert.equal(short.mark, '! 実績');
  assert.equal(short.headline, '! 実績 29/30');
  assert.deepEqual(short.tags, ['検査 14/14']);
  assert.deepEqual(short.reasons, ['record']);
  assert.equal(short.samplingDenominator, null);

  const halved = judgeFolderIntake({...ready, record: 60, samplingClean: 30});
  assert.equal(halved.judgment, 'auto');
  assert.equal(halved.samplingDenominator, 20);
  assert.deepEqual(halved.tags, ['正答 100%', '実績 60']);
  const floored = judgeFolderIntake({...ready, record: 90, samplingClean: 60});
  assert.equal(floored.samplingDenominator, 30);
});

test('FR-REV-FOLDER-010 正答率が100%でない、予測外、重なり、確かめ後の変更、形が違う、画像だけの PDF は確定しない', () => {
  const accuracy = judgeFolderIntake({...ready, record: 30, goldenMatched: 2, goldenTotal: 3});
  assert.equal(accuracy.judgment, 'human');
  assert.equal(accuracy.label, '人の確認');
  assert.deepEqual(accuracy.reasons, ['accuracy']);

  const emptyGolden = judgeFolderIntake({...ready, record: 30, goldenMatched: 0, goldenTotal: 0});
  assert.equal(emptyGolden.judgment, 'human');
  assert.deepEqual(emptyGolden.reasons, ['accuracy']);

  const forecast = judgeFolderIntake({...ready, record: 30, outOfForecast: true});
  assert.equal(forecast.judgment, 'human');
  assert.deepEqual(forecast.reasons, ['forecast']);

  const overlap = judgeFolderIntake({...ready, record: 30, hasOverlap: true});
  assert.equal(overlap.judgment, 'human');
  assert.deepEqual(overlap.reasons, ['overlap']);

  const masters = judgeFolderIntake({...ready, record: 30, mastersChanged: true});
  assert.equal(masters.judgment, 'human');
  assert.deepEqual(masters.reasons, ['masters']);

  const shape = judgeFolderIntake({...ready, kind: 'shape', record: 30, shapeLabels: ['売上金額']});
  assert.equal(shape.judgment, 'shape');
  assert.equal(shape.label, '形が違う');
  assert.equal(shape.mark, '✕ 形違い');
  assert.equal(shape.headline, '✕ 形違い');
  assert.deepEqual(shape.tags, ['売上金額']);

  const unread = judgeFolderIntake({...ready, kind: 'image_pdf', record: 30});
  assert.equal(unread.judgment, 'unread');
  assert.equal(unread.label, '人が読む');
  assert.equal(unread.mark, '人 要読');
  assert.equal(unread.headline, '人 要読');
  assert.deepEqual(unread.tags, ['PDF']);
  assert.equal(unread.samplingDenominator, null);
});

test('FR-REV-FOLDER-008 FR-REV-FOLDER-010 検査が1つでも落ちると自動で確定せず、人の確認になる', () => {
  const checks = evaluateFolderChecks({
    source: {
      headers: ['商品', '税抜', '税額', '税込'],
      rows: [{sourceRow: 2, values: {商品: 'A', 税抜: '1000', 税額: '100', 税込: '1100'}, date: '2026-05-15', month: '2026-05'}],
    },
    planned: {lines: [{sourceRow: 2, workId: 10, productId: 100, partnerId: 7, amountExTax: 1001, taxAmount: 100, amountIncTax: 1101}], excluded: []},
    terms: {partnerId: 7, kind: 'download', periodFrom: '2026-05-01', periodTo: '2026-05-31', declared: null},
    expected: {targetMonth: '2026-05'},
    typeVersion: {splitByProduct: true, moneyColumns: {amountExTax: '税抜', taxAmount: '税額', amountIncTax: '税込'}, checks: []},
    roundTrip: {headers: ['商品', '税抜', '税額', '税込'], rows: [{sourceRow: 2, values: {商品: 'A', 税抜: '1000', 税額: '100', 税込: '1100'}}]},
    activeReports: [],
  });
  assert.equal(checks.allPass, false);
  assert.equal(checks.passed, 7);
  assert.equal(checks.total, 9);
  const judged = judgeFolderIntake({
    kind: 'fixed', checksAllPass: checks.allPass, checksPassed: checks.passed, checksTotal: checks.total,
    goldenMatched: 3, goldenTotal: 3, record: 34, samplingClean: 4,
  });
  assert.equal(judged.judgment, 'human');
  assert.equal(judged.mark, '! 要確認');
  assert.equal(judged.headline, '! 要確認 2');
  assert.deepEqual(judged.tags, ['検査 7/9']);
  assert.equal(judged.samplingDenominator, null);

  const inconsistent = judgeFolderIntake({...ready, checksAllPass: true, checksPassed: 10, checksTotal: 12, record: 30});
  assert.equal(inconsistent.judgment, 'human');
  assert.equal(inconsistent.headline, '! 要確認 2');
});
