import test from 'node:test';
import assert from 'node:assert/strict';
import {ownersOf, rowOwners, ownerSummary, ownerNames, shootDates, boardColumns, moveBody, canMoveTo, NO_DATE} from '../src/preprod/props/props-board-model.mjs';

// GET /api/props の品目の形（props-model の propRow）。架空の品目と人だけ
let seq = 0;
const row = (o) => ({id: ++seq, versionNo: 1, name: '架空の品目', state: 'unassigned', department: null, ownerLabel: null, shootOn: null, sceneLabel: null, ...o});

test('FR-PROD-BOARD-002 担当の名寄せ: 部（◯◯さん）はその人、ほかの括弧は外し、「・」は両方、空は未定', () => {
  assert.deepEqual(ownersOf('演出部（鈴木さん）'), ['鈴木さん']);
  assert.deepEqual(ownersOf('演出部(鈴木さん)'), ['鈴木さん']);
  assert.deepEqual(ownersOf('制作部（要確認）'), ['制作部']);
  assert.deepEqual(ownersOf('田中さん（11/13 までに）'), ['田中さん']);
  // 括弧の中が人名「◯◯さん」だけでなければ、括弧の前
  assert.deepEqual(ownersOf('制作部（鈴木さん・田中さん）'), ['制作部']);
  assert.deepEqual(ownersOf('制作部（鈴木）'), ['制作部']);
  assert.deepEqual(ownersOf('鈴木さん・田中さん'), ['鈴木さん', '田中さん']);
  assert.deepEqual(ownersOf('演出部（鈴木さん）・制作部'), ['鈴木さん', '制作部']);
  assert.deepEqual(ownersOf('鈴木さん・演出部（鈴木さん）'), ['鈴木さん']);
  assert.deepEqual(ownersOf(''), ['未定']);
  assert.deepEqual(ownersOf(null), ['未定']);
  assert.deepEqual(ownersOf('  '), ['未定']);
  assert.deepEqual(ownersOf('（要確認）'), ['未定']);
});

test('FR-PROD-BOARD-002 担当の文字が無い品目は部署の名前、どちらも無ければ未定。担当の文字があれば部署より先', () => {
  assert.deepEqual(rowOwners(row({ownerLabel: '鈴木さん', department: 'direction', state: 'arranging'})), ['鈴木さん']);
  assert.deepEqual(rowOwners(row({department: 'production', state: 'arranging'})), ['制作部']);
  assert.deepEqual(rowOwners(row({ownerLabel: ' ', department: 'producer', state: 'adjust'})), ['プロデューサー部']);
  assert.deepEqual(rowOwners(row({})), ['未定']);
});

test('FR-PROD-BOARD-003 担当ごとの件数は5状態と残り（全件−用意済み−不要）で、2人の品目は両方に数え、撮影日で絞れ、順位・％は持たない', () => {
  const rows = [
    row({ownerLabel: '演出部（鈴木さん）', department: 'direction', state: 'ready', shootOn: '2099-11-14'}),
    row({ownerLabel: '鈴木さん・田中さん', department: 'production', state: 'arranging', shootOn: '2099-11-14'}),
    row({ownerLabel: '田中さん', department: 'production', state: 'adjust', shootOn: '2099-11-15'}),
    row({state: 'unassigned', shootOn: '2099-11-15'}),
    row({department: 'production', state: 'unneeded'}),
    row({ownerLabel: '田中さん', department: 'production', state: 'unneeded'}),
  ];
  const all = ownerSummary(rows);
  assert.deepEqual(all, [
    {owner: '制作部', total: 1, ready: 0, arranging: 0, adjust: 0, unassigned: 0, unneeded: 1, remaining: 0},
    {owner: '田中さん', total: 3, ready: 0, arranging: 1, adjust: 1, unassigned: 0, unneeded: 1, remaining: 2},
    {owner: '鈴木さん', total: 2, ready: 1, arranging: 1, adjust: 0, unassigned: 0, unneeded: 0, remaining: 1},
    {owner: '未定', total: 1, ready: 0, arranging: 0, adjust: 0, unassigned: 1, unneeded: 0, remaining: 1},
  ]);
  assert.deepEqual(Object.keys(all[0]).sort(), ['adjust', 'arranging', 'owner', 'ready', 'remaining', 'total', 'unassigned', 'unneeded']);
  assert.deepEqual(ownerSummary(rows, {shootOn: '2099-11-14'}).map((n) => [n.owner, n.total, n.ready, n.remaining]), [['田中さん', 1, 0, 1], ['鈴木さん', 2, 1, 1]]);
  assert.deepEqual(ownerSummary(rows, {shootOn: NO_DATE}).map((n) => [n.owner, n.unneeded]), [['制作部', 1], ['田中さん', 1]]);
  assert.deepEqual(shootDates(rows), {dates: ['2099-11-14', '2099-11-15'], hasNone: true});
  assert.deepEqual(ownerNames(rows), ['制作部', '田中さん', '鈴木さん', '未定']);
});

test('FR-PROD-BOARD-004 看板は小道具の5状態の列で、撮影日・シーンの順に並べ、担当と撮影日で絞る', () => {
  const rows = [
    row({id: 101, name: '湯のみ', ownerLabel: '鈴木さん', department: 'direction', state: 'arranging', shootOn: '2099-11-14', sceneLabel: '#31'}),
    row({id: 102, name: '新聞', ownerLabel: '鈴木さん・田中さん', department: 'production', state: 'arranging', shootOn: '2099-11-14', sceneLabel: '#2'}),
    row({id: 103, name: '花束', ownerLabel: '田中さん', department: 'production', state: 'adjust', shootOn: '2099-11-15', sceneLabel: '#40・#41'}),
    row({id: 104, name: '傘', state: 'unassigned'}),
  ];
  const view = boardColumns(rows);
  assert.deepEqual(view.map((c) => [c.id, c.label, c.cards.map((x) => x.name)]), [
    ['unassigned', '未割当', ['傘']], ['adjust', '要調整', ['花束']], ['arranging', '手配中', ['新聞', '湯のみ']], ['ready', '用意済み', []], ['unneeded', '不要', []]]);
  assert.deepEqual(boardColumns(rows, {owner: '田中さん'}).flatMap((c) => c.cards.map((x) => x.id)), [103, 102]);
  assert.deepEqual(boardColumns(rows, {shootOn: '2099-11-15'}).flatMap((c) => c.cards.map((x) => x.id)), [103]);
  assert.deepEqual(boardColumns(rows, {owner: '未定'}).flatMap((c) => c.cards.map((x) => x.id)), [104]);
});

test('FR-PROD-BOARD-005 状態を変える版の本文はほかの中身を読んだ版のまま写し、部署を持つ品目は未割当へ動かせない', () => {
  const r = row({id: 7, versionNo: 3, name: '湯のみ', sceneLabel: '#31', shootOn: '2099-11-14', place: '居間', quantity: '2（予備1）', kind: 'hand', department: 'direction',
    ownerLabel: '鈴木さん', state: 'arranging', nextAction: '架空の倉庫で探す', dueOn: '2099-11-10', source: 'both', scriptNote: '湯のみを置く', memo: '白いもの', meetingId: 4, key: 'k'});
  assert.deepEqual(moveBody(r, 'ready'), {sceneLabel: '#31', shootOn: '2099-11-14', place: '居間', name: '湯のみ', quantity: '2（予備1）', kind: 'hand', department: 'direction',
    ownerLabel: '鈴木さん', nextAction: '架空の倉庫で探す', dueOn: '2099-11-10', source: 'both', scriptNote: '湯のみを置く', memo: '白いもの', state: 'ready', baseVersionNo: 3});
  assert.throws(() => moveBody(r, 'done'), /状態を確認/);
  assert.equal(canMoveTo(r, 'unassigned'), false);
  assert.equal(canMoveTo(r, 'adjust'), true);
  assert.equal(canMoveTo(row({department: null}), 'unassigned'), true);
});
