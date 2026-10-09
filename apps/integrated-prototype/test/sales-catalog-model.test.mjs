import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {labelOf, optionsOf} from '../src/ui/labels.mjs';
import {
  territoryKey, territoryLabel, resolveTerritory, territoryVariants, territoryOptions, territoryInput, territoryFromInput, OTHER_TERRITORY,
  availabilityStatusLabel, availabilityStatusOptions,
  periodState, distributionDisplay, distributionGroups, catalogGridRows, materialDraft, materialFromVersion,
} from '../src/sales-ops/sales-catalog-model.mjs';

// 1. 地域の名寄せ

test('地域: 日本・国内・Japan・全角・空白を同じ地域として名寄せし、表示名をそろえる', () => {
  for (const value of ['日本', '国内', 'Japan', ' ＪＡＰＡＮ ', 'jp', '日本国内']) {
    assert.equal(territoryKey(value), 'JP', value);
    assert.equal(territoryLabel(value), '日本', value);
  }
  assert.equal(territoryKey('Worldwide'), territoryKey('全世界'));
  assert.equal(territoryLabel('ワールドワイド'), '全世界');
  assert.equal(territoryLabel('海外'), '全世界（日本を除く）');
  assert.notEqual(territoryKey('全世界'), territoryKey('全世界（日本を除く）'), '日本を含むかどうかは別の地域');
  assert.equal(territoryKey('北 欧'), territoryKey('北欧'), '未知の値も空白の違いは同じ扱い');
  assert.equal(territoryLabel('北欧'), '北欧', '未知の値は推測で訳さない');
  assert.equal(territoryKey(''), '');
  assert.equal(territoryLabel(null), '未確認');
  assert.ok(territoryOptions().some((option) => option.value === '日本'));
  assert.equal(territoryOptions().at(-1).value, OTHER_TERRITORY);
  assert.ok(!territoryOptions({withOther: false}).some((option) => option.value === OTHER_TERRITORY));
});

test('地域の入力欄: 既知の地域は選択肢へ、未知の値は「その他」の文字へ戻し、入力から地域を取り出す', () => {
  assert.deepEqual(territoryInput('国内'), {select: '日本', other: ''});
  assert.deepEqual(territoryInput('北欧'), {select: OTHER_TERRITORY, other: '北欧'});
  assert.deepEqual(territoryInput(null), {select: '', other: ''});
  assert.equal(territoryFromInput('日本', 'x'), '日本');
  assert.equal(territoryFromInput(OTHER_TERRITORY, ' 北欧 '), '北欧');
  assert.equal(territoryFromInput('', ''), '');
});

test('地域: 保存前の解決は、保存済みの系列の文字をそのまま使い、新しい系列は正規の名前で保存する', () => {
  const existing = [{territory: '国内', version_no: 2}];
  assert.deepEqual(pick(resolveTerritory('Japan', existing)), {territory: '国内', match: 'alias'}, '既存の「国内」系列へ続ける（既存値は変えない）');
  assert.deepEqual(pick(resolveTerritory('国内', existing)), {territory: '国内', match: 'exact'});
  assert.deepEqual(pick(resolveTerritory('worldwide', existing)), {territory: '全世界', match: 'new'});
  assert.deepEqual(pick(resolveTerritory('Japan', [])), {territory: '日本', match: 'new'});
  assert.deepEqual(pick(resolveTerritory('北欧', [])), {territory: '北欧', match: 'new'});
  assert.ok(resolveTerritory('  ', []).error, '空は理由つきで拒否');
  assert.ok(resolveTerritory('x'.repeat(101), []).error);
  // すでに表記ゆれで分かれている場合は、版の進んだ系列へ続ける
  const split = [{territory: '日本', version_no: 1}, {territory: '国内', version_no: 3}];
  assert.equal(resolveTerritory('JP', split).territory, '国内');
  assert.equal(resolveTerritory('日本', split).territory, '日本', '完全一致を優先');
});

test('地域: 同じ作品・流通で表記ゆれにより分かれた系列を見つける', () => {
  const rows = [
    {work_id: 1, distribution_code: 'tvod', territory: '日本'},
    {work_id: 1, distribution_code: 'tvod', territory: 'Japan'},
    {work_id: 1, distribution_code: 'svod', territory: '日本'},
    {work_id: 2, distribution_code: 'tvod', territory: '国内'},
  ];
  const variants = territoryVariants(rows);
  assert.deepEqual(variants.get('1|tvod|日本'), ['Japan', '日本']);
  assert.equal(variants.get('1|svod|日本'), undefined);
  assert.equal(variants.get('2|tvod|国内'), undefined, '作品が違えば別の系列');
});

// 2. 状態の語彙と販売期間

test('状態の語彙は labels.mjs の availabilityStatus だけを使う', () => {
  for (const code of ['draft', 'confirmed', 'withdrawn']) assert.equal(availabilityStatusLabel(code), labelOf('availabilityStatus', code));
  assert.deepEqual(availabilityStatusOptions(), optionsOf('availabilityStatus'));
  assert.equal(availabilityStatusLabel('confirmed'), '条件確認済み');
  assert.equal(availabilityStatusLabel('withdrawn'), '取り下げ');
});

test('販売期間の状況: 解禁日・終了日の当日は販売期間中、日付が無ければ期間未確認', () => {
  const row = {status: 'confirmed', release_on: '2026-10-01', sales_end_on: '2027-09-30'};
  assert.equal(periodState(row, '2026-09-30').code, 'before');
  assert.equal(periodState(row, '2026-10-01').code, 'active');
  assert.equal(periodState(row, '2027-09-30').code, 'active');
  assert.equal(periodState(row, '2027-10-01').code, 'ended');
  assert.equal(periodState({...row, sales_end_on: null}, '2026-10-05').code, 'unknown');
  assert.equal(periodState({...row, status: 'withdrawn'}, '2026-10-05').code, 'withdrawn');
});

// 3. 流通の選択肢

test('流通: マスタの区分だけを流通名の見出しでまとめ、旧分類は登録済みの版のときだけ出す', () => {
  const types = [
    {code: 'H001', distribution_name: '配給', transaction_method: 'RS', sales_type: '劇場_RS', legacy: 0},
    {code: 'H003', distribution_name: '配給', transaction_method: 'RS', sales_type: '非劇場_RS', legacy: 0},
    {code: 'D001', distribution_name: '配信', transaction_method: 'RS', sales_type: '', legacy: 0},
    {code: 'tvod', label: '配信・TVOD', legacy: 1},
  ];
  const groups = distributionGroups(types);
  assert.deepEqual(groups.map((group) => group.label), ['配給', '配信']);
  assert.deepEqual(groups[0].options.map((option) => option.label), ['劇場・RS（H001）', '非劇場・RS（H003）'], '同じ流通名・取引方法でも販売種別で区別できる');
  assert.deepEqual(groups[1].options.map((option) => option.label), ['RS（D001）']);
  assert.ok(!groups.flatMap((group) => group.options).some((option) => option.value === 'tvod'));
  const withLegacy = distributionGroups(types, 'tvod');
  assert.equal(withLegacy.at(-1).options[0].value, 'tvod');
  assert.equal(distributionDisplay(types[0]), '配給・劇場・RS');
  assert.equal(distributionDisplay({code: 'R001', distribution_name: 'レンタル_RSS', transaction_method: 'LF', sales_type: 'レンタル_RSS'}), 'レンタル・RSS・LF');
  assert.equal(distributionDisplay({code: 'D003', distribution_name: '配信', transaction_method: 'RS', sales_type: 'EST'}), '配信・EST・RS');
  assert.equal(distributionDisplay(types[3]), '配信・TVOD');
  assert.equal(distributionDisplay(null), '未登録の流通');
});

test('一覧の行: 地域を正規化し、表記ゆれ・未登録の作品・状態の語彙を表示用にそろえる', () => {
  const result = {
    types: [{code: 'tvod', label: '配信・TVOD', legacy: 1}],
    rows: [
      {id: 1, work_id: 1, work_title: '架空作品A', distribution_code: 'tvod', territory: 'Japan', status: 'draft', exclusivity: 'unknown', version_no: 2, release_on: null, sales_end_on: null, overlaps: []},
      {id: 2, work_id: 1, work_title: '架空作品A', distribution_code: 'tvod', territory: '日本', status: 'confirmed', exclusivity: 'exclusive', version_no: 1, release_on: '2026-10-01', sales_end_on: '2027-09-30', overlaps: [{contract_code: 'C-1'}], intake_case_id: 7},
    ],
    missing: [{work_id: 3, work_title: '架空作品C', state: '流通条件未登録'}],
    intakes: [{id: 7, case_code: 'CASE-7'}],
  };
  const rows = catalogGridRows(result, '2026-10-02');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].territory, '日本');
  assert.equal(rows[0].territory_raw, 'Japan');
  assert.deepEqual(rows[0].territory_variants, ['Japan', '日本']);
  assert.equal(rows[0].status_label, labelOf('availabilityStatus', 'draft'));
  assert.equal(rows[1].period, '販売期間中');
  assert.equal(rows[1].overlaps, 'C-1');
  assert.equal(rows[1].intake, 'CASE-7');
  assert.equal(rows[1].exclusivity, '独占');
  assert.equal(rows[2].kind, 'missing');
  assert.equal(rows[2].status_label, '流通条件未登録');
  assert.deepEqual(catalogGridRows(null, '2026-10-02'), []);
});

// 4. 営業資料の下書き

test('営業資料: 作品マスタのキャッチ・あらすじ・クレジット・尺から作品概要を下書きする', () => {
  const profile = {
    catch_short: '架空のキャッチコピー', synopsis_long: '架空のあらすじ。', production_year: 2026,
    credits: [{role: 'director', name: '架空 監督'}, {role: 'cast', name: '架空 出演A'}, {role: 'cast', name: '架空 出演B'}],
    editions: [{runtime_seconds: 5400}],
  };
  const draft = materialDraft({work: {title: '架空作品'}, profile, partnerName: '架空配信'});
  assert.equal(draft.title, '架空作品のご提案（架空配信向け）');
  assert.match(draft.synopsis, /^架空のキャッチコピー\n\n架空のあらすじ。/);
  assert.match(draft.synopsis, /監督: 架空 監督/);
  assert.match(draft.synopsis, /出演: 架空 出演A、架空 出演B/);
  assert.match(draft.synopsis, /本編 90分／2026年製作/);
  assert.deepEqual(draft.missing, []);
  const empty = materialDraft({work: {title: '架空作品'}, profile: null});
  assert.equal(empty.synopsis, '');
  assert.equal(empty.hasProfile, false);
  assert.deepEqual(empty.missing, ['キャッチコピー', 'あらすじ', 'クレジット']);
  assert.equal(empty.title, '架空作品のご提案');
});

test('営業資料: 保存済みの版から次の版の入力値を作る', () => {
  const next = materialFromVersion({opportunity_id: 5, product_id: null, title: '架空の提案', synopsis: '概要', pitch: '提案', terms_text: '条件'});
  assert.deepEqual(next, {opportunityId: '5', productId: '', title: '架空の提案', synopsis: '概要', pitch: '提案', terms: '条件'});
});

// 5. サーバー: 名寄せして保存し、既存値は変えない

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  return {db, req, login};
}

const condition = (patch = {}) => ({workId: 1, distributionCode: 'tvod', territory: '日本', baseVersion: 0, releaseOn: '', salesEndOn: '', terms: '', sourceReference: '架空の根拠', exclusivity: 'unknown', status: 'draft', ...patch});

test('販売条件の保存: 表記ゆれの地域は既存の系列へ続け、新しい系列は正規の名前で保存し、既存の行は書き換えない', async (t) => {
  const {db, req} = await fixture({t});
  try {
    assert.equal((await req('/sales-catalog', condition())).status, 201);
    const second = await req('/sales-catalog', condition({territory: '国内', baseVersion: 1, terms: '第2版'}));
    assert.equal(second.status, 201, JSON.stringify(second.data));
    assert.equal(second.data.territory, '日本');
    assert.equal(second.data.territoryMatch, 'alias');
    const stale = await req('/sales-catalog', condition({territory: 'Japan', baseVersion: 0}));
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /「Japan」は登録済みの「日本」と同じ地域です/);
    assert.deepEqual((await db.all("SELECT DISTINCT territory FROM sales_availability_versions WHERE work_id=1 AND distribution_code='tvod'")).map((row) => row.territory), ['日本']);
    const world = await req('/sales-catalog', condition({territory: 'Worldwide', distributionCode: 'svod'}));
    assert.equal(world.data.territory, '全世界');

    // 以前に表記ゆれで保存された行（直接投入）は書き換えず、その系列へ版を足す
    await db.run("INSERT INTO sales_availability_versions(org_id,work_id,distribution_code,territory,version_no,terms_text,source_reference,exclusivity,status,created_by) VALUES(1,1,'est','Japan',1,'','旧い表記','unknown','draft',1)");
    const legacy = await req('/sales-catalog', condition({distributionCode: 'est', territory: '日本', baseVersion: 1}));
    assert.equal(legacy.status, 201, JSON.stringify(legacy.data));
    assert.equal(legacy.data.territory, 'Japan');
    const est = await db.all("SELECT territory,version_no,source_reference FROM sales_availability_versions WHERE distribution_code='est' ORDER BY version_no");
    assert.deepEqual(est.map((row) => [row.territory, row.version_no, row.source_reference]), [['Japan', 1, '旧い表記'], ['Japan', 2, '架空の根拠']]);

    const catalog = (await req('/sales-catalog?asOf=2026-10-01')).data;
    const estRow = catalog.rows.find((row) => row.distribution_code === 'est');
    assert.equal(estRow.territory, 'Japan', 'API は保存値を返す');
    assert.equal(estRow.territory_label, '日本', '表示名は正規化する');
    assert.equal(catalog.rows.find((row) => row.distribution_code === 'tvod').state, labelOf('availabilityStatus', 'draft'), '状態の語彙は labels.mjs と同じ');
    assert.equal((await req('/sales-catalog', condition({territory: ' '}))).status, 400);
  } finally {
    await db.close();
  }
});

test('販売条件の版の履歴: 新しい順に返し、制作担当・別組織・権限外は読めない', async (t) => {
  const {db, req, login} = await fixture({t});
  try {
    await req('/sales-catalog', condition({terms: '第1版'}));
    await req('/sales-catalog', condition({baseVersion: 1, terms: '第2版'}));
    const path = `/sales-catalog/versions?workId=1&distributionCode=tvod&territory=${encodeURIComponent('日本')}`;
    const history = await req(path);
    assert.equal(history.status, 200);
    assert.deepEqual(history.data.rows.map((row) => [row.version_no, row.terms_text]), [[2, '第2版'], [1, '第1版']]);
    assert.equal(history.data.rows[0].created_by_name, '管理者');
    assert.equal((await req(path, null, await login('production@openingnight.invalid'))).status, 403);
    assert.equal((await req(path, null, await login('outsider@other.invalid'))).status, 403);
    assert.equal((await req(path, null, await login('editor@openingnight.invalid'))).status, 200);
  } finally {
    await db.close();
  }
});

function pick(result) {
  return {territory: result.territory, match: result.match};
}
