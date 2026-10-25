import test from 'node:test';
import assert from 'node:assert/strict';
import {preprodSummary, meetingDocument, folderStatus, costumeGaps, characterDays, scriptStatus, pagesText, planChecks} from '../src/preprod/preprod-model.mjs';

// 架空の作品。S#1・2 は 11/3、S#3 は 11/4、S#4 は未割当。11/5 は予備日
const production = () => ({
  scenes: [
    {id: 1, scene_no: '1', day_night: 'D', location: '灯台', page_eighths: 12, estimated_minutes: 60, location_key: 'lh'},
    {id: 2, scene_no: '2', day_night: 'N', location: '灯台', page_eighths: 4, estimated_minutes: 30, location_key: 'lh'},
    {id: 3, scene_no: '3', day_night: 'D', location: '港の食堂', page_eighths: 9, estimated_minutes: null, location_key: 'port'},
    {id: 4, scene_no: '4', day_night: 'D', location: '岬', page_eighths: 8, estimated_minutes: 45, location_key: null},
  ],
  days: [
    {id: 11, shoot_date: '2026-11-03', unit: 'A', label: '1日目', assignments: [{scene_id: 1, sequence_order: 1, planned_start: '2026-11-03T08:00'}, {scene_id: 2, sequence_order: 2, planned_start: '2026-11-03T19:00'}]},
    {id: 12, shoot_date: '2026-11-04', unit: 'A', label: '2日目', assignments: [{scene_id: 3, sequence_order: 1, planned_start: null}]},
    {id: 13, shoot_date: '2026-11-05', unit: 'A', label: '予備日', assignments: []},
  ],
  characters: [{key: 'shiori', name: '汐里', actor_name: '架空俳優A'}, {key: 'keeper', name: '灯台守', actor_name: ''}],
  locations: [{key: 'lh', name: '灯台', address: '架空市1-1', green_room: '管理棟'}, {key: 'port', name: '港の食堂', address: ''}],
  appearances: [{scene_id: 1, character_key: 'shiori'}, {scene_id: 2, character_key: 'shiori'}, {scene_id: 2, character_key: 'keeper'}, {scene_id: 3, character_key: 'shiori'}],
  looks: [{key: 'sA', character_key: 'shiori', label: 'A'}, {key: 'kA', character_key: 'keeper', label: 'A'}],
  sceneLooks: [{scene_id: 1, look_key: 'sA'}, {scene_id: 2, look_key: 'sA'}, {scene_id: 3, look_key: 'sA'}],
});
const today = '2026-10-24';

test('未割当・衣装の不足・ロケ地・俳優・予定分を、既存の表から数えて要対応に出す', () => {
  const s = preprodSummary({production: production(), scripts: [{id: 1, review_id: 5, commit_id: 7}], field: {tasks: []}, today});
  const todo = Object.fromEntries(s.todos.map((t) => [t.key, t.count]));
  assert.deepEqual(todo, {unassigned: 1, minutes: 1, costume: 1, location: 1, address: 1, actor: 1});
  assert.equal(s.todos.find((t) => t.key === 'unassigned').detail, 'S#4');
  assert.equal(s.numbers.pages, 33);
  assert.equal(s.numbers.untilShoot, 10);
  assert.equal(s.done, false, '未割当があるので F03 は済にならない');
});

test('F03 は台本が香盤に確定し、未割当が 0 のときだけ済（問い3 A）', () => {
  const p = production();
  p.days[1].assignments.push({scene_id: 4, sequence_order: 2, planned_start: null});
  assert.equal(preprodSummary({production: p, scripts: [{id: 1, review_id: 5, commit_id: 7}], field: {}, today}).done, true);
  assert.equal(preprodSummary({production: p, scripts: [{id: 1, review_id: 5, commit_id: null}], field: {}, today}).done, false);
  assert.equal(preprodSummary({production: p, scripts: [], field: {}, today}).done, false);
});

test('台本の状態は 原本なし → 要確認 → 承認済 → 済 の順に導く', () => {
  assert.equal(scriptStatus([]).state, 'not_started');
  assert.equal(scriptStatus([{id: 1}]).state, 'needs_review');
  assert.equal(scriptStatus([{id: 1, review_id: 2}]).state, 'in_progress');
  assert.equal(scriptStatus([{id: 1, review_id: 2, commit_id: 3}, {id: 2}]).state, 'done');
});

test('衣装の不足は出演（シーン×役）ごとに、その役のルックがシーンに無いものを数える', () => {
  const g = costumeGaps(production());
  assert.deepEqual(g.rows, [{scene_id: 2, character_key: 'keeper'}]);
  assert.equal(g.scenes, 1);
});

test('役の拘束日数は出番のある撮影日の数（同じ日の2シーンは1日）', () => {
  const d = characterDays(production());
  assert.equal(d.get('shiori'), 2);
  assert.equal(d.get('keeper'), 1);
});

test('期限を過ぎた準備タスクだけを要対応に出す（済のタスクは出さない）', () => {
  const s = preprodSummary({production: production(), scripts: [], field: {tasks: [{title: 'a', due_on: '2026-10-20', status: 'pending'}, {title: 'b', due_on: '2026-10-30', status: 'pending'}, {title: 'c', due_on: '2026-10-01', status: 'ready'}]}, today});
  assert.equal(s.todos.find((t) => t.key === 'tasks').count, 1);
});

test('資料は日ごとのシーン・頁・予定分・ロケ地と予備日、シーンの出演とルック、ロケ地の撮影日を返す', () => {
  const doc = meetingDocument({production: production(), scripts: [], field: {}, today});
  assert.deepEqual(doc.cover, {firstDay: '2026-11-03', lastDay: '2026-11-05', days: 3, reserveDays: 1, scenes: 4, pages: 33});
  assert.deepEqual(doc.schedule[0], {id: 11, date: '2026-11-03', unit: 'A', label: '1日目', notes: '', scenes: ['1', '2'], locations: ['灯台'], dayNight: 'D・N', pages: 16, minutes: 90, reserve: false});
  assert.equal(doc.schedule[2].reserve, true);
  const s2 = doc.scenes.find((s) => s.no === '2');
  assert.deepEqual([s2.cast, s2.looks, s2.days], [['汐里', '灯台守'], ['汐里 A'], ['2026-11-03']]);
  assert.deepEqual(doc.locations.find((l) => l.name === '灯台').days, ['2026-11-03']);
  assert.deepEqual(doc.cast.map((c) => [c.role, c.days]), [['汐里', 2], ['灯台守', 1]]);
});

test('共通の口 folderStatus の形と、何も無い作品は not_started', () => {
  const empty = preprodSummary({production: {}, scripts: [], field: {}, today});
  assert.deepEqual(folderStatus(empty), {folderId: 'F03', state: 'not_started', done: 0, total: 7, reason: ''});
  const s = folderStatus(preprodSummary({production: production(), scripts: [], field: {}, today}));
  assert.equal(s.state, 'needs_review');
});

test('頁は 1/8 単位で書く', () => {
  assert.equal(pagesText(0), '0');
  assert.equal(pagesText(8), '1');
  assert.equal(pagesText(33), '4 1/8');
});

test('手配・美術の噛み合い: 締切を過ぎた仮押さえ、期間の外の撮影（全日の機材と、シーンの要る機材）、未決と搬入の遅れを挙げる', () => {
  const plans = {
    arrangements: [
      {arrangement_key: 'r', kind: 'grip', item: 'レール', state: 'hold', starts_on: '2026-11-03', ends_on: '2026-11-03', deadline_on: '2026-10-20'},
      {arrangement_key: 'c', kind: 'camera', item: 'カメラ', state: 'confirmed', starts_on: '2026-11-03', ends_on: '2026-11-03'},
      {arrangement_key: 'x', kind: 'truck', item: '2t', state: 'cancelled', starts_on: '2026-11-01', ends_on: '2026-11-01', deadline_on: '2026-10-01'},
    ],
    shootPlans: [{scene_id: 3, equipment: 'レール 10m'}],
    artItems: [{item_key: 'a', scene_id: 1, kind: 'build', content: '灯台の光', state: 'open', delivery_on: '2026-11-04'}, {item_key: 'b', scene_id: 3, kind: 'prop', content: '手紙', state: 'done', delivery_on: '2026-11-01'}],
  };
  const todo = Object.fromEntries(planChecks({production: production(), plans, today}).map((t) => [t.key, t]));
  assert.equal(todo['arr-deadline'].count, 1, '取消した手配の締切は数えない');
  assert.deepEqual(todo['arr-period'].detail.split('・').sort(), ['S#3 レール', 'カメラ 11/4'].sort());
  assert.equal(todo['art-open'].count, 1);
  assert.equal(todo['art-late'].detail, '灯台の光', 'S#1 は 11/3 に撮るのに搬入が 11/4');
  assert.deepEqual(planChecks({production: production(), plans: undefined, today}), []);
  const doc = meetingDocument({production: production(), scripts: [], field: {}, plans, today});
  assert.equal(doc.art[0].scene_no, '1');
  assert.equal(doc.scenes.find((s) => s.no === '3').equipment, 'レール 10m');
});
