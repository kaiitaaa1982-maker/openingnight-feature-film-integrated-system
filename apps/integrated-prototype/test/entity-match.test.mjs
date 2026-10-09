import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForMatch, matchEntities, exactMatch, findEntity, entityText, confirmationText, toEntityItems, MAX_CANDIDATES,
} from '../src/ui/entity-match.mjs';

const works = [
  {id: 1, code: 'WRK-DEMO', label: '風のあとさき', keywords: 'かぜのあとさき'},
  {id: 2, code: 'WRK-KAZE2', label: 'カゼの行方', hint: 'シリーズ'},
  {id: 3, code: 'WRK-NIGHT', label: '夜のあとさき'},
  {id: 4, code: 'KAZ-01', label: '海辺の映画館'},
  {id: 5, code: 'WRK-ＤＥＭＯ２', label: '風のあとさき 続編'},
];

test('正規化は全角半角・大小・空白・ひらがなカタカナの違いを吸収する', () => {
  assert.equal(normalizeForMatch('ｶｾﾞ'), 'かぜ', '半角カナと濁点');
  assert.equal(normalizeForMatch('カゼノアトサキ'), 'かぜのあとさき');
  assert.equal(normalizeForMatch('かぜのあとさき'), normalizeForMatch('カゼノアトサキ'));
  assert.equal(normalizeForMatch('ＷＲＫ－ＤＥＭＯ'), 'wrk-demo');
  assert.equal(normalizeForMatch(' Wrk -　Demo '), 'wrk-demo');
  assert.equal(normalizeForMatch(null), '');
});

test('「かぜのあとさき」「ｶｾﾞ」相当の入力で候補が出る', () => {
  const byReading = matchEntities(works, 'かぜのあとさき');
  assert.equal(byReading[0].id, 1, '読みの完全一致');
  assert.equal(byReading[0].match, 'exact');
  const byKana = matchEntities(works, 'ｶｾﾞ');
  assert.deepEqual(byKana.map((item) => item.id), [2, 1], 'カタカナ名称の前方一致 → 読みの前方一致');
  assert.equal(byKana[0].match, 'prefix');
  assert.deepEqual(matchEntities(works, 'ｶｾﾞﾉｱﾄｻｷ').map((item) => item.id), [1]);
});

test('候補は完全一致 → 前方一致 → 部分一致の順に並ぶ', () => {
  const items = [
    {id: 'a', code: 'X-KAZE', label: '部分に含む'},
    {id: 'b', code: 'KAZE-2', label: '前方一致'},
    {id: 'c', code: 'KAZE', label: '完全一致'},
    {id: 'd', code: 'Z9', label: 'かぜ'},
  ];
  const result = matchEntities(items, 'kaze');
  assert.deepEqual(result.map((item) => item.id), ['c', 'b', 'a']);
  assert.deepEqual(result.map((item) => item.match), ['exact', 'prefix', 'partial']);
  assert.deepEqual(matchEntities(works, 'あとさき').map((item) => item.id), [1, 3, 5], '部分一致は渡した並び順');
  assert.deepEqual(matchEntities(works, 'wrk').map((item) => item.id), [1, 2, 3, 5], '同じ順位は元の並び');
});

test('前方一致ではコードの一致を名称の一致より前に出す', () => {
  const items = [{id: 1, code: 'ZZ', label: 'kaz 名称'}, {id: 2, code: 'KAZ-9', label: '別名'}];
  assert.deepEqual(matchEntities(items, 'kaz').map((item) => item.id), [2, 1]);
});

test('空白区切りの複数語は、すべての語を含む項目を部分一致で出す', () => {
  assert.deepEqual(matchEntities(works, 'wrk 続編').map((item) => item.id), [5]);
  assert.deepEqual(matchEntities(works, 'シリーズ').map((item) => item.id), [2], '補足（hint）でも探せる');
});

test('候補は最大20件。空の問い合わせでは先頭20件', () => {
  const many = Array.from({length: 45}, (_, index) => ({id: index + 1, code: `W${String(index + 1).padStart(3, '0')}`, label: `作品${index + 1}`}));
  assert.equal(MAX_CANDIDATES, 20);
  assert.equal(matchEntities(many, '作品').length, 20);
  assert.equal(matchEntities(many, '').length, 20);
  assert.equal(matchEntities(many, '').every((item) => item.match === 'all'), true);
  assert.deepEqual(matchEntities(many, 'w04').map((item) => item.id), [40, 41, 42, 43, 44, 45]);
  assert.deepEqual(matchEntities(many, '該当なし'), []);
  assert.deepEqual(matchEntities(null, 'x'), []);
});

test('完全一致が1件ならその項目を自動確定し、同名が複数なら確定しない', () => {
  assert.equal(exactMatch(works, 'wrk-demo').id, 1);
  assert.equal(exactMatch(works, 'ＷＲＫ－ＤＥＭＯ').id, 1);
  assert.equal(exactMatch(works, 'カゼノアトサキ').id, 1, '読みの完全一致');
  assert.equal(exactMatch(works, '風のあとさき').id, 1);
  assert.equal(exactMatch(works, 'wrk-demo2').id, 5, '全角のコードも正規化して一致');
  assert.equal(exactMatch(works, '風の'), null, '前方一致だけでは確定しない');
  const twins = [{id: 1, code: 'A', label: '同名'}, {id: 2, code: 'B', label: '同名'}];
  assert.equal(exactMatch(twins, '同名'), null);
  assert.equal(exactMatch(twins, 'b').id, 2);
  assert.equal(exactMatch(works, ''), null);
});

test('確定状態の文と、一覧から候補への変換', () => {
  assert.equal(entityText(works[0]), '風のあとさき（WRK-DEMO）');
  assert.equal(confirmationText(works[0]), '確定：風のあとさき（WRK-DEMO）');
  assert.equal(confirmationText(null), '未確定');
  assert.equal(confirmationText(null, {emptyText: '指定なし（すべて）'}), '指定なし（すべて）');
  assert.equal(findEntity(works, '3').id, 3);
  assert.equal(findEntity(works, null), null);
  const items = toEntityItems([{id: 9, sku: 'SKU-1', name: '商品'}, {id: 10, code: 'P', title: '作品', kana: 'さくひん'}, {code: 'no-id'}], {hint: (row) => row.name ? '商品' : ''});
  assert.deepEqual(items, [
    {id: 9, code: 'SKU-1', label: '商品', hint: '商品', keywords: undefined},
    {id: 10, code: 'P', label: '作品', hint: '', keywords: 'さくひん'},
  ]);
});
