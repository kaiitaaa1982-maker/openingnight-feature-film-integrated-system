// 日々スケの矛盾の確かめと食事の数（src/production/call-sheet-check.mjs）。データは架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkCallSheetDay, checkCallSheets} from '../src/production/call-sheet-check.mjs';

const D = '2026-12-01';
const t = (clock) => `${D}T${clock}`;
// 架空の1日: S1（9:00〜11:00）に A・B、S2（14:00〜17:00）に B・C
const day = {id: 1, crew_count: 20, assignments: [
  {scene_id: 11, planned_start: t('09:00'), planned_end: t('11:00')},
  {scene_id: 12, planned_start: t('14:00'), planned_end: t('17:00')},
]};
const appearances = [
  {scene_id: 11, character_key: 'A'}, {scene_id: 11, character_key: 'B'},
  {scene_id: 12, character_key: 'B'}, {scene_id: 12, character_key: 'C'},
  {scene_id: 99, character_key: 'D'}, // 別の日のシーン
];
const lunch = {day_id: 1, key: 'm1', kind: 'meal', label: '昼食', planned_start: t('12:00'), planned_end: t('13:00')};
const dinner = {day_id: 1, key: 'm2', kind: 'meal', label: '夕食', planned_start: t('18:00'), planned_end: t('19:00')};
const okCalls = [
  {day_id: 1, character_key: 'A', call_time: t('07:00'), ready_time: t('08:30'), wrap_time: t('11:30')},
  {day_id: 1, character_key: 'B', call_time: t('07:00'), ready_time: t('08:30'), wrap_time: t('17:30')},
  {day_id: 1, character_key: 'C', call_time: t('12:30'), ready_time: t('13:30'), wrap_time: t('18:30')},
];
const kinds = (r) => r.issues.map((i) => `${i.kind}:${i.characterKey}${i.sceneId ? `:${i.sceneId}` : ''}`).sort();

test('矛盾の無い日は何も出さず、食事の帯ごとに重なる人とスタッフを数える', () => {
  const r = checkCallSheetDay(day, {appearances, calls: okCalls, daySlots: [lunch, dinner]});
  assert.deepEqual(r.issues, []);
  // 昼食 12:00〜13:00: A は 11:30 にバラし、B は居る、C は 12:30 入りで重なる
  assert.deepEqual(r.meals.map((m) => [m.label, m.cast, m.castCount, m.crew, m.total, m.unknown]), [
    ['昼食', ['B', 'C'], 2, 20, 22, []],
    ['夕食', ['C'], 1, 20, 21, []],
  ]);
  assert.equal(r.crewMissing, false);
});

test('バラしが入りより前・支度完了が入りより前を出す', () => {
  const calls = [{...okCalls[0], wrap_time: t('06:00')}, {...okCalls[1], ready_time: t('06:30')}, okCalls[2]];
  const r = checkCallSheetDay(day, {appearances, calls});
  assert.ok(kinds(r).includes('wrap_before_call:A'));
  assert.ok(kinds(r).includes('ready_before_call:B'));
});

test('出るのに入りが無い・入りがあるのに出ないを出す', () => {
  const calls = [okCalls[0], okCalls[1], {day_id: 1, character_key: 'D', call_time: t('08:00'), wrap_time: t('12:00')}];
  assert.deepEqual(kinds(checkCallSheetDay(day, {appearances, calls})), ['call_without_scene:D', 'missing_call:C']);
});

test('シーンの開始が支度完了より前・終わりがバラしより後を、シーンごとに出す', () => {
  const calls = [
    {...okCalls[0], ready_time: t('09:30')}, // S1 の 9:00 に支度が間に合わない
    {...okCalls[1], wrap_time: t('16:00')}, // S2 の 17:00 より前にバラす
    okCalls[2],
  ];
  assert.deepEqual(kinds(checkCallSheetDay(day, {appearances, calls})), ['scene_after_wrap:B:12', 'scene_before_ready:A:11']);
  // 支度完了が無ければ入りと比べる
  const noReady = [{...okCalls[0], ready_time: null, call_time: t('09:15'), wrap_time: t('11:30')}, okCalls[1], okCalls[2]];
  assert.deepEqual(kinds(checkCallSheetDay(day, {appearances, calls: noReady})), ['scene_before_ready:A:11']);
});

test('入りかバラしが無い人は数に入れず未定に並べ、スタッフの数が無ければ合計にキャストだけを数えて印を付ける', () => {
  const calls = [okCalls[0], {...okCalls[1], wrap_time: null}, okCalls[2]];
  const r = checkCallSheetDay({...day, crew_count: null}, {appearances, calls, daySlots: [lunch]});
  assert.deepEqual([r.meals[0].cast, r.meals[0].unknown, r.meals[0].total], [['C'], ['B'], 1]);
  assert.equal(r.crewMissing, true);
});

test('時刻の無い食事の帯は数えず、全員を未定にする。別の日の帯と入りは見ない', () => {
  const r = checkCallSheetDay(day, {appearances, calls: [...okCalls, {day_id: 2, character_key: 'D', call_time: t('08:00')}],
    daySlots: [{...lunch, planned_end: null}, {...dinner, day_id: 2}]});
  assert.equal(r.meals.length, 1);
  assert.deepEqual([r.meals[0].castCount, r.meals[0].total, r.meals[0].unknown], [null, null, ['A', 'B', 'C']]);
  assert.deepEqual(r.issues, []);
});

test('境目ちょうどは重ならない（13:00 入りは 12:00〜13:00 の昼食に数えない）', () => {
  const calls = [{day_id: 1, character_key: 'C', call_time: t('13:00'), wrap_time: t('18:30')}];
  const r = checkCallSheetDay(day, {appearances: [{scene_id: 12, character_key: 'C'}], calls, daySlots: [lunch]});
  assert.deepEqual(r.meals[0].cast, []);
});

test('全日分をまとめて返す', () => {
  const r = checkCallSheets({days: [day, {id: 2, crew_count: 5, assignments: []}], appearances, calls: okCalls, daySlots: [lunch]});
  assert.deepEqual(r.map((x) => [x.dayId, x.meals.length]), [[1, 1], [2, 0]]);
});
