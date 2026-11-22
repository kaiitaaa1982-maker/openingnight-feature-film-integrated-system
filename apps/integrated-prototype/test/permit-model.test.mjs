// 撮影の許可申請の計算（src/preprod/permits/permit-model.mjs）。期待値は brain の wiki/10_manual/road-use-permit.md の決まりから作る:
// 「中N日」は申請の翌日から N 日をはさみ、その次の日から受け取れる。申請の最終日は、使う日の前の窓口の開く日に受け取れる日から逆算する。
// 窓口は土日と休みの日に開かない。日付は 2027 年の架空の予定（2027-01-01 は金曜）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDeadline, pickupFrom, checkSpan, spanDays, rowAlert, isOpenDay, permitRow, filterRows, latestVersions} from '../src/preprod/permits/permit-model.mjs';

test('中1日の提出先で土曜に使うなら、金曜に受け取り、その2つ前の窓口の日（水曜）が申請の最終日', () => {
  assert.deepEqual(applyDeadline({useOn: '2027-01-16', leadBusinessDays: 1}), {pickupBy: '2027-01-15', applyBy: '2027-01-13'});
});

test('中2日の提出先で日曜に使うなら、金曜に受け取り、申請の最終日は火曜', () => {
  assert.deepEqual(applyDeadline({useOn: '2027-01-17', leadBusinessDays: 2}), {pickupBy: '2027-01-15', applyBy: '2027-01-12'});
});

test('週末をまたぐ: 火曜に使うなら月曜に受け取り、中1日なら申請の最終日は前の週の木曜', () => {
  assert.deepEqual(applyDeadline({useOn: '2027-01-19', leadBusinessDays: 1}), {pickupBy: '2027-01-18', applyBy: '2027-01-14'});
  assert.deepEqual(applyDeadline({useOn: '2027-01-20', leadBusinessDays: 2}), {pickupBy: '2027-01-19', applyBy: '2027-01-14'});
});

test('休みの日を渡すと、その日も窓口の日として数えない', () => {
  assert.deepEqual(applyDeadline({useOn: '2027-01-19', leadBusinessDays: 1, holidays: ['2027-01-18']}), {pickupBy: '2027-01-15', applyBy: '2027-01-13'});
  assert.equal(isOpenDay('2027-01-18', ['2027-01-18']), false);
  assert.equal(isOpenDay('2027-01-18'), true);
  assert.equal(isOpenDay('2027-01-16'), false);
});

test('受け取りまでの日数が未確定の提出先は、最終日を出さない', () => {
  assert.deepEqual(applyDeadline({useOn: '2027-01-16', leadBusinessDays: null}), {pickupBy: null, applyBy: null});
  assert.throws(() => applyDeadline({useOn: '2027-02-30', leadBusinessDays: 1}), /使う日/);
});

test('申請した日から受け取れる最初の日: 水曜に中1日なら金曜、木曜に中1日なら週末をまたいで月曜', () => {
  assert.equal(pickupFrom({appliedOn: '2027-01-13', leadBusinessDays: 1}), '2027-01-15');
  assert.equal(pickupFrom({appliedOn: '2027-01-14', leadBusinessDays: 1}), '2027-01-18');
  assert.equal(pickupFrom({appliedOn: '2027-01-14', leadBusinessDays: null}), null);
});

test('期間でまとめて申請できる上限: 15日の提出先はちょうど15日まで通し、16日は断る。上限が未確定なら通す', () => {
  assert.equal(spanDays('2027-02-01', '2027-02-01'), 1);
  assert.deepEqual(checkSpan({startsOn: '2027-02-01', endsOn: '2027-02-15', maxSpanDays: 15}), {ok: true, days: 15, max: 15});
  assert.deepEqual(checkSpan({startsOn: '2027-02-01', endsOn: '2027-02-16', maxSpanDays: 15}), {ok: false, days: 16, max: 15, reason: 'over'});
  assert.deepEqual(checkSpan({startsOn: '2027-02-01', endsOn: '2027-03-31', maxSpanDays: null}), {ok: true, days: 59, max: null});
  assert.equal(checkSpan({startsOn: '2027-02-02', endsOn: '2027-02-01', maxSpanDays: 15}).ok, false);
});

test('赤の印は差戻と、申請の最終日を過ぎた準備だけ。最終日の当日と提出済みは赤にしない', () => {
  assert.equal(rowAlert({state: 'returned', applyBy: null}, '2027-01-01'), 'returned');
  assert.equal(rowAlert({state: 'draft', applyBy: '2027-01-13'}, '2027-01-14'), 'late');
  assert.equal(rowAlert({state: 'draft', applyBy: '2027-01-13'}, '2027-01-13'), null);
  assert.equal(rowAlert({state: 'submitted', applyBy: '2027-01-13'}, '2027-01-20'), null);
  assert.equal(rowAlert({state: 'draft', applyBy: null}, '2027-01-20'), null);
});

test('一覧の行は最新の版から作り、作品・種類・提出先・状態で絞れる', () => {
  const versions = [
    {application_id: 1, version_no: 1, office_id: 10, place: '架空町', starts_on: '2027-01-16', ends_on: '2027-01-16', state: 'draft'},
    {application_id: 1, version_no: 2, office_id: 10, place: '架空町2丁目', starts_on: '2027-01-16', ends_on: '2027-01-16', state: 'draft'},
  ];
  const latest = latestVersions(versions);
  const row = permitRow({application: {id: 1, work_id: 5, kind: 'road'}, version: latest.get(1), office: {name: '架空署', lead_business_days: 1, max_span_days: 15},
    work: {title: '架空作品'}, documentCount: 2}, {today: '2027-01-14'});
  assert.deepEqual([row.versionNo, row.place, row.applyBy, row.alert, row.documentCount, row.officeName, row.spanDays], [2, '架空町2丁目', '2027-01-13', 'late', 2, '架空署', 1]);
  const rows = [row, {...row, id: 2, kind: 'park', workId: 6, officeId: 11, state: 'submitted'}];
  assert.deepEqual(filterRows(rows, {kind: 'park'}).map((r) => r.id), [2]);
  assert.deepEqual(filterRows(rows, {workId: 5}).map((r) => r.id), [1]);
  assert.deepEqual(filterRows(rows, {officeId: 11, state: 'submitted'}).map((r) => r.id), [2]);
  assert.deepEqual(filterRows(rows, {}).map((r) => r.id), [1, 2]);
});
