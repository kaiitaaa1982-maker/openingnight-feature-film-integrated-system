import test from 'node:test';
import assert from 'node:assert/strict';
import {channelGroupOf, channelMatches, isOverseasTerritory, COMMITTEE_WINDOW_OF, CHANNEL_GROUPS} from '../src/sales/channel-group.mjs';

test('流通の区分: 地域が日本以外なら海外、分類の family・utilization、分類が無ければ報告の種類', () => {
  assert.equal(channelGroupOf({family: 'digital', territory: '北米'}), 'overseas');
  assert.equal(channelGroupOf({family: 'digital', territory: '日本'}), 'digital');
  assert.equal(channelGroupOf({family: 'package', utilization: 'rental'}), 'rental');
  assert.equal(channelGroupOf({family: 'package', utilization: 'sell'}), 'sell');
  assert.equal(channelGroupOf({family: 'package'}), 'package', 'レンタル／セルが決まらないものは区分未確認のまま');
  assert.equal(channelGroupOf({kind: 'theatrical'}), 'theatrical');
  assert.equal(channelGroupOf({kind: 'broadcast'}), 'broadcast');
  assert.equal(channelGroupOf({kind: 'publicity'}), 'other');
  // 流通区分マスタのコード（family='unverified'）は流通名で決め、名前で決まらなければ報告の種類で決める
  assert.equal(channelGroupOf({family: 'unverified', kind: 'theatrical'}), 'theatrical');
  assert.equal(channelGroupOf({family: 'unverified', distributionName: 'レンタル', kind: 'package'}), 'rental');
  assert.equal(channelGroupOf({family: 'unverified', distributionName: '海外', kind: 'digital'}), 'overseas');
  assert.equal(channelGroupOf({family: 'unverified', distributionName: 'グッズ', kind: 'digital'}), 'other');
  assert.equal(isOverseasTerritory(null), false);
  assert.equal(isOverseasTerritory(' Japan '), false);
  for (const group of CHANNEL_GROUPS) assert.ok(COMMITTEE_WINDOW_OF[group], group);
});

test('対象流通の判定: 空は全流通、区分未確認のビデオグラムはレンタルとセルの両方が対象のときだけ入り、片方だけなら決められない', () => {
  assert.equal(channelMatches([], 'digital'), true);
  assert.equal(channelMatches(['digital'], 'theatrical'), false);
  assert.equal(channelMatches(['rental', 'sell'], 'package'), true);
  assert.equal(channelMatches(['rental'], 'package'), null);
  assert.equal(channelMatches(['digital'], 'package'), false);
});

test('流通マスタのどの流通IDも、取引先別リストの流通の照合と同じ区分になる（レンタル_RSS はレンタル）', async (t) => {
  const {openTestDb} = await import('./test-db.mjs');
  const {flowOf} = await import('../src/sales-ops/partner-list-model.mjs');
  const db = await openTestDb({t});
  try {
    const rows = await db.all('SELECT m.code, m.distribution_name, m.transaction_method, m.sales_type, t.family, t.utilization FROM distribution_master m JOIN distribution_types t ON t.code=m.code ORDER BY m.code');
    assert.ok(rows.length >= 40, `流通マスタの行 ${rows.length}`);
    for (const row of rows) {
      const group = channelGroupOf({family: row.family, utilization: row.utilization, territory: '日本', kind: 'other', distributionName: row.distribution_name});
      assert.equal(group, flowOf(row, '日本').group, `${row.code} ${row.distribution_name}`);
    }
    // レンタル_RSS（R001 LF・R002 MG・R004 RS）は、旧区分 package_rental と同じレンタル
    for (const code of ['R001', 'R002', 'R004']) {
      const row = rows.find((r) => r.code === code);
      assert.equal(channelGroupOf({family: row.family, kind: 'package', distributionName: row.distribution_name}), 'rental', code);
    }
  } finally { await db.close(); }
});
