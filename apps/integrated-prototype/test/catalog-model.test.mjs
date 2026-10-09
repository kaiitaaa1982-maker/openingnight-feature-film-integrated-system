import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_TABS, catalogTab, searchTokens, matchesQuery, catalogRows, workCount, filterWorks, jstToday, windowState,
  parseYear, parseMonthNumber, monthBounds, stationsFor, stationText, distributionGroups, distributionLabel, profileChanged,
} from '../src/work/catalog-model.mjs';

// 架空の作品マスタ（作品2件・商品3件、うち1作品は商品なし）
function catalog() {
  return {
    works: [
      {id: 1, code: 'WRK-DEMO', title: '風のあとさき', profile: {editions: [{edition_key: 'main', name: '本編'}], bindings: [{product_id: 10, edition_key: 'main'}]}},
      {id: 2, code: 'wrk-sea', title: '海辺の上映会', profile: null},
      {id: 3, code: 'WRK-ﾃｽﾄ', title: 'カタカナ作品', profile: null},
    ],
    products: [
      {id: 10, work_id: 1, sku: 'SKU-PKG', name: 'パッケージ版'},
      {id: 11, work_id: 1, sku: 'SKU-DIGI', name: 'デジタル視聴'},
      {id: 12, work_id: 2, sku: 'SEA-001', name: '配信版'},
    ],
    windows: [{id: 5, work_id: 1, product_id: 10, distribution_code: 'S001', territory: '日本', release_on: '2026-10-01', sales_end_on: '2027-09-30', status: 'confirmed'}],
  };
}

test('検索の正規化: 全角半角・大文字小文字・かなの違いと空白区切りを吸収する', () => {
  assert.deepEqual(searchTokens('  ＳＫＵ　ぱっけ '), ['sku', 'ぱっけ']);
  assert.deepEqual(searchTokens(''), []);
  assert.deepEqual(searchTokens(null), []);
  assert.ok(matchesQuery(['パッケージ版'], 'ぱっけ'));
  assert.ok(matchesQuery(['パッケージ版'], 'ﾊﾟｯｹ'));
  assert.ok(matchesQuery(['WRK-DEMO'], 'wrk-demo'));
  assert.ok(matchesQuery(['WRK-DEMO'], 'ｗｒｋ'));
  assert.ok(matchesQuery(['SKU-PKG', 'パッケージ版'], 'pkg パッケ'));
  assert.ok(!matchesQuery(['SKU-PKG', 'パッケージ版'], 'pkg デジタル'));
  assert.ok(matchesQuery(['何でも'], '   '));
});

test('一覧の行: 商品名で当たればその商品の行だけ、作品名で当たれば作品の全商品を出す', () => {
  const data = catalog();
  const all = catalogRows(data, '');
  assert.deepEqual(all.map((row) => row.key), ['1:10', '1:11', '2:12', '3:0']);
  assert.equal(workCount(all), 3);
  assert.equal(all[0].edition.name, '本編');
  assert.equal(all[1].edition, null);
  assert.equal(all[0].windows.length, 1);
  assert.equal(all[3].product, null);
  // 「パッケ」では該当しない「デジタル視聴」の行を残さない
  assert.deepEqual(catalogRows(data, 'パッケ').map((row) => row.key), ['1:10']);
  assert.deepEqual(catalogRows(data, 'ぱっけ').map((row) => row.key), ['1:10']);
  // 作品名で当たると作品の全商品
  assert.deepEqual(catalogRows(data, 'かぜのあとさき').map((row) => row.key), []);
  assert.deepEqual(catalogRows(data, '風の').map((row) => row.key), ['1:10', '1:11']);
  // 大文字小文字・全角半角
  assert.deepEqual(catalogRows(data, 'WRK-SEA').map((row) => row.key), ['2:12']);
  assert.deepEqual(catalogRows(data, 'ｓｅａ－００１').map((row) => row.key), ['2:12']);
  assert.deepEqual(catalogRows(data, 'テスト').map((row) => row.key), ['3:0']);
  assert.deepEqual(catalogRows(data, '本編').map((row) => row.key), ['1:10']);
  assert.deepEqual(catalogRows(data, '存在しない'), []);
  assert.deepEqual(catalogRows(null, ''), []);
  assert.deepEqual(filterWorks(data.works, 'うみべ').map((work) => work.id), []);
  assert.deepEqual(filterWorks(data.works, '海辺').map((work) => work.id), [2]);
  assert.deepEqual(filterWorks(data.works, '').map((work) => work.id), [1, 2, 3]);
});

test('タブ・年月・日付の読み取りと販売ウィンドウの状態', () => {
  assert.deepEqual(CATALOG_TABS.map((tab) => tab.id), ['details', 'broadcast', 'windows', 'history']);
  assert.equal(catalogTab('windows'), 'windows');
  assert.equal(catalogTab('bogus'), 'details');
  assert.equal(catalogTab(null), 'details');
  assert.equal(parseYear('2027', 2026), 2027);
  assert.equal(parseYear('abc', 2026), 2026);
  assert.equal(parseYear('20270', 2026), 2026);
  assert.equal(parseMonthNumber('12', 1), 12);
  assert.equal(parseMonthNumber('13', 1), 1);
  assert.equal(parseMonthNumber(null, 9), 9);
  assert.deepEqual(monthBounds(2028, 2), {from: '2028-02-01', to: '2028-02-29'});
  assert.deepEqual(monthBounds(2026, 12), {from: '2026-12-01', to: '2026-12-31'});
  assert.equal(jstToday(new Date('2026-09-23T15:30:00Z')), '2026-09-24');
  assert.equal(jstToday(new Date('2026-09-23T14:59:00Z')), '2026-09-23');
  const row = {status: 'confirmed', release_on: '2026-10-01', sales_end_on: '2026-12-31'};
  assert.equal(windowState(row, '2026-09-30'), '条件確認済み・解禁前');
  assert.equal(windowState(row, '2026-10-01'), '条件確認済み・期間内');
  assert.equal(windowState(row, '2026-12-31'), '条件確認済み・期間内');
  assert.equal(windowState(row, '2027-01-01'), '条件確認済み・期間終了');
  assert.equal(windowState({...row, status: 'draft'}, '2026-11-01'), '条件未確定');
  assert.equal(windowState({...row, sales_end_on: null}, '2026-11-01'), '条件確認済み・期間未確認');
  assert.equal(windowState({...row, status: 'withdrawn'}, '2026-11-01'), '取り下げ');
  assert.equal(windowState(null, '2026-11-01'), '未確認');
});

test('放送局: 作品と期間に重なる放送枠の局名を出し、差し戻し・中止は数えない', () => {
  const slots = [
    {work_id: 1, station_name: '架空テレビ', status: 'confirmed', period_from: '2026-10-01', period_to: '2026-10-31'},
    {work_id: 1, station_name: '架空テレビ', status: 'tentative', period_from: '2026-10-10', period_to: '2026-10-20'},
    {work_id: 1, station_name: 'あおぞら放送', status: 'pending_first', period_from: '2026-11-01', period_to: '2026-11-30'},
    {work_id: 1, station_name: '中止局', status: 'cancelled', period_from: '2026-10-01', period_to: '2026-10-31'},
    {work_id: 2, station_name: '別作品局', status: 'confirmed', period_from: '2026-10-01', period_to: '2026-10-31'},
  ];
  const october = stationsFor(slots, {workId: 1, month: monthBounds(2026, 10)});
  assert.deepEqual(october.map((station) => station.name), ['架空テレビ']);
  assert.deepEqual(october[0].statuses, ['確定', '仮押さえ']);
  assert.equal(october[0].count, 2);
  assert.equal(stationText(october), '架空テレビ（確定・仮押さえ・2枠）');
  const span = stationsFor(slots, {workId: 1, from: '2026-10-15', to: '2026-11-05'});
  assert.deepEqual(span.map((station) => station.name), ['あおぞら放送', '架空テレビ']);
  // 期間の片方が無いときは月で代える
  assert.deepEqual(stationsFor(slots, {workId: 1, from: null, to: null, month: monthBounds(2026, 11)}).map((station) => station.name), ['あおぞら放送']);
  assert.deepEqual(stationsFor(slots, {workId: 3, month: monthBounds(2026, 10)}), []);
  assert.deepEqual(stationsFor(null, {workId: 1}), []);
  assert.match(stationText([]), /放送枠は未登録/);
  assert.match(stationText(null, {loaded: false}), /読み込み中/);
});

test('流通の選択肢: 流通名ごとに分け、表示が重なるときだけコードを添える', () => {
  const types = [
    {code: 'H001', distribution_name: '配給', transaction_method: 'RS', sales_type: '劇場_RS'},
    {code: 'H003', distribution_name: '配給', transaction_method: 'RS', sales_type: '非劇場_RS'},
    {code: 'D003', distribution_name: '配信', transaction_method: 'RS', sales_type: 'EST'},
    {code: 'D001', distribution_name: '配信', transaction_method: 'MG', sales_type: '配信_MG'},
    {code: 'R001', distribution_name: 'レンタル_RSS', transaction_method: 'LF', sales_type: 'レンタル_RSS'},
    {code: 'X001', distribution_name: '調整', transaction_method: '調整', sales_type: ''},
    {code: 'X002', distribution_name: '調整', transaction_method: '調整', sales_type: ''},
  ];
  const groups = distributionGroups(types);
  assert.deepEqual(groups.map((group) => group.label), ['配給', '配信', 'レンタル・RSS', '調整']);
  assert.deepEqual(groups[0].options, [{value: 'H001', label: '劇場・RS'}, {value: 'H003', label: '非劇場・RS'}]);
  assert.deepEqual(groups[1].options.map((option) => option.label), ['EST・RS', 'MG']);
  assert.deepEqual(groups[2].options.map((option) => option.label), ['LF']);
  assert.deepEqual(groups[3].options.map((option) => option.label), ['調整（X001）', '調整（X002）']);
  assert.equal(distributionLabel(types, 'H001'), '配給・劇場・RS');
  assert.equal(distributionLabel(types, 'ZZZ'), '未登録の流通（ZZZ）');
  assert.equal(distributionLabel(types, ''), '未確認');
  assert.deepEqual(distributionGroups(null), []);
});

test('作品マスタの下書きの変更判定: 版番号と空文字の違いは変更とみなさない', () => {
  const saved = {revision: 2, synopsis_long: 'あらすじ', catch_short: null, credits: [{role: 'director', name: '架空 監督'}]};
  assert.equal(profileChanged(saved, {...saved, baseRevision: 2}), false);
  assert.equal(profileChanged(saved, {...saved, catch_short: ''}), false);
  assert.equal(profileChanged(saved, {...saved, synopsis_long: 'あらすじ（改）'}), true);
  assert.equal(profileChanged(saved, {...saved, credits: []}), true);
});
