// 小道具の判定と並べ方（src/preprod/props/props-model.mjs。純関数）。架空の品目だけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVersion, normalizeMeeting, latestVersions, sceneOrder, sortRows, filterRows, meetingQueue, stateCounts, meetingDecisions, checkImport, formatProblem, IMPORT_LIMIT} from '../src/preprod/props/props-model.mjs';

const row = (id, over) => ({id, name: `架空の品目${id}`, sceneLabel: null, shootOn: null, state: 'unassigned', department: null, kind: 'hand', ...over});

test('版の中身: 既定は持ち道具・未割当・手入力。空白は null、未割当で部署を持てば断る', () => {
  const v = normalizeVersion({name: ' 架空のランタン ', quantity: ''});
  assert.deepEqual([v.name, v.kind, v.state, v.source, v.quantity, v.department], ['架空のランタン', 'hand', 'unassigned', 'manual', null, null]);
  assert.throws(() => normalizeVersion({name: 'x', department: 'production'}), /未割当/);
  assert.throws(() => normalizeVersion({name: 'x', shootOn: '2027-02-30'}), /撮影日/);
  assert.throws(() => normalizeVersion({name: 'x', kind: 'weapon'}), /種別/);
  assert.throws(() => normalizeVersion({}), /品目/);
  assert.equal(normalizeVersion({name: 'x', department: 'production', state: 'adjust'}).department, 'production');
});

test('打ち合わせ: 部署は重なりを消して並べる。知らない部署と日付の誤りは断る', () => {
  assert.equal(normalizeMeeting({heldOn: '2027-01-10', title: '架空', departments: ['production', 'production', 'direction']}).departments, 'production,direction');
  assert.equal(normalizeMeeting({heldOn: '2027-01-10', title: '架空'}).departments, null);
  assert.throws(() => normalizeMeeting({heldOn: '2027-13-01', title: '架空'}), /日付/);
  assert.throws(() => normalizeMeeting({heldOn: '2027-01-10', title: '架空', departments: ['sound']}), /部署/);
});

test('最新の版と並べ方: 撮影日（無いものは最後）→ シーンの先頭の番号 → 登録の順', () => {
  const latest = latestVersions([{item_id: 1, version_no: 1}, {item_id: 1, version_no: 3}, {item_id: 1, version_no: 2}, {item_id: 2, version_no: 1}]);
  assert.deepEqual([latest.get(1).version_no, latest.get(2).version_no], [3, 1]);
  assert.deepEqual([sceneOrder('#31・#32'), sceneOrder('#6Fla'), sceneOrder('—')], [31, 6, Number.MAX_SAFE_INTEGER]);
  const rows = [row(1, {shootOn: '2027-01-17', sceneLabel: '#2'}), row(2), row(3, {shootOn: '2027-01-16', sceneLabel: '#18〜#22'}), row(4, {shootOn: '2027-01-16', sceneLabel: '#9'})];
  assert.deepEqual(sortRows(rows).map((r) => r.id), [4, 3, 1, 2]);
});

test('絞り込み（案A）と、打ち合わせで決める列（案B）', () => {
  const rows = [row(1, {shootOn: '2027-01-16', state: 'adjust', department: 'production', kind: 'consumable', name: '架空の缶コーヒー'}),
    row(2, {shootOn: '2027-01-16', state: 'arranging', department: 'direction'}), row(3, {state: 'unassigned'}), row(4, {state: 'ready', department: 'producer', nextAction: '架空の倉庫で探す'})];
  assert.deepEqual(filterRows(rows, {shootOn: '2027-01-16'}).map((r) => r.id), [1, 2]);
  assert.deepEqual(filterRows(rows, {shootOn: 'none'}).map((r) => r.id), [3, 4]);
  assert.deepEqual(filterRows(rows, {department: 'none'}).map((r) => r.id), [3]);
  assert.deepEqual(filterRows(rows, {kind: 'consumable', state: 'adjust'}).map((r) => r.id), [1]);
  assert.deepEqual(filterRows(rows, {text: '倉庫'}).map((r) => r.id), [4]);
  assert.deepEqual(meetingQueue(rows).map((r) => r.id), [3, 1], '未割当を先に');
  assert.equal(meetingQueue(rows, {all: true}).length, 4);
  assert.deepEqual(stateCounts(rows), {unassigned: 1, adjust: 1, arranging: 1, ready: 1, unneeded: 0, open: 2});
});

test('打ち合わせで決めたことは版を足した順に並ぶ', () => {
  const out = meetingDecisions([{id: 9, item_id: 2, version_no: 2, name: '後', state: 'ready'}, {id: 5, item_id: 1, version_no: 4, name: '先', state: 'arranging'}], [{id: 1, item_key: 'k1'}, {id: 2, item_key: 'k2'}]);
  assert.deepEqual(out.map((d) => [d.name, d.key, d.versionNo]), [['先', 'k1', 4], ['後', 'k2', 2]]);
});

test('取込の検査: items が無い・空・多すぎ・key の重なり・中身の誤りを並べる', () => {
  assert.equal(checkImport({}).problems[0].message, 'items（品目の並び）がありません');
  assert.equal(checkImport({items: []}).problems[0].message, '品目が1件もありません');
  assert.match(checkImport({items: Array.from({length: IMPORT_LIMIT + 1}, (_, i) => ({key: `k${i}`, name: 'x'}))}).problems[0].message, /300件まで/);
  const {problems, rows} = checkImport({items: [{key: 'a', name: '架空'}, {key: 'a', name: '架空'}, {key: '', name: '架空'}, {key: 'b', name: ''}]});
  assert.deepEqual(problems.map(formatProblem), ['2件目: key「a」が重なっています', '3件目: key（1〜64字）を確認してください', '4件目: 品目を確認してください']);
  assert.equal(rows.length, 3);
});
