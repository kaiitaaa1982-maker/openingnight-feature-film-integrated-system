// 予実管理のフォルダ（src/revenue/yojitsu/folder-model.mjs・folder-routes.mjs。会社ルートの plans/2026-10-22-folder-yojitsu.md の最初の一切れ）。
// 月の状態（締済・今月・未来・不足・締可）と締めの順、架空の種で開いたときの12か月のマスと4段、締める・戻す・目標を入れるの受け口を確かめる。
// 期待値の出どころは計画の「月のマス」「月を開いたとき」の節と問い6（足りないまま締めるときは理由が要る）。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildFolderView, closeCheck, fiscalYearLabel, monthState, reopenTarget} from '../src/revenue/yojitsu/folder-model.mjs';
import {loadYojitsuSeed, SEED_OWNER} from './yojitsu-view-fixture.mjs';

test('予実管理のフォルダ: 月の状態は締めた月・今月・未来・足りない件数から決まる', () => {
  const today = '2027-02-05';
  assert.equal(monthState({month: '2026-12-01', closedMonth: '2026-12-01', today, missing: 3}), 'closed');
  assert.equal(monthState({month: '2027-01-01', closedMonth: '2026-12-01', today, missing: 3}), 'missing');
  assert.equal(monthState({month: '2027-01-01', closedMonth: '2026-12-01', today, missing: 0}), 'closable');
  assert.equal(monthState({month: '2027-02-01', closedMonth: '2026-12-01', today, missing: 0}), 'current');
  assert.equal(monthState({month: '2027-03-01', closedMonth: null, today, missing: 9}), 'future');
  assert.equal(fiscalYearLabel('2026-11-01'), '2026年度');
});

test('予実管理のフォルダ: 締めは今月より前の月を1か月ずつ順に。戻すと前の月になる', () => {
  const today = '2027-02-05';
  assert.equal(closeCheck({month: '2027-01-01', closedMonth: '2026-12-01', today, firstMonth: '2026-11-01'}).ok, true);
  assert.equal(closeCheck({month: '2027-02-01', closedMonth: '2027-01-01', today, firstMonth: '2026-11-01'}).ok, false); // 今月
  assert.equal(closeCheck({month: '2027-01-01', closedMonth: null, today, firstMonth: '2026-11-01'}).ok, false); // 11月を飛ばす
  assert.equal(closeCheck({month: '2026-11-01', closedMonth: null, today, firstMonth: '2026-11-01'}).ok, true);
  assert.deepEqual(reopenTarget({closedMonth: '2027-01-01'}), {ok: true, value: '2026-12-01'});
  assert.equal(reopenTarget({closedMonth: null}).ok, false);
});

test('予実管理のフォルダ: 月の印は目標・計画の版、結果が空の活動、予測の版の無い着地の案件、未確定の入金を数え、今月と未来には出さない', () => {
  const months = Array.from({length: 12}, (_, i) => `${i < 2 ? 2026 : 2027}-${String(((10 + i) % 12) + 1).padStart(2, '0')}-01`);
  const row = (key, states) => ({key, label: key, unit: 'yen', role: 'main', months: Array(12).fill(null), periods: [null], hiddenYears: [], states});
  const view = {periods: [{yearNo: 1, startsOn: '2026-11-01', lastMonth: '2027-10-01'}], months,
    rows: [row('target_self', ['unset']), row('plan', ['visible']), row('landing'), row('actual'), row('actual_rate'), row('actual_progress'), row('weighted')]};
  const folder = buildFolderView({view, yearNo: 1, today: '2027-02-05', closedMonth: '2026-11-01', emptyResults: [{month: '2026-12', count: 2}],
    projects: [{id: 1, code: 'A', title: '架空A', probability_bps: 10000}, {id: 2, code: 'B', title: '架空B', probability_bps: 4000}, {id: 3, code: 'C', title: '架空C', probability_bps: 9000}],
    forecastProjectIds: [1], unsettled: [{month: '2027-01-01'}], landingBps: 8000});
  const by = new Map(folder.months.map((m) => [m.key, m]));
  assert.equal(folder.period.label, '2026年度');
  assert.equal(by.get('2026-11').state, 'closed');
  assert.deepEqual(by.get('2026-12').marks, {target: 1, action: 2, forecast: 1, actual: 0});
  assert.equal(by.get('2026-12').state, 'missing');
  assert.deepEqual(by.get('2027-01').marks, {target: 1, action: 0, forecast: 1, actual: 1});
  assert.equal(by.get('2027-02').state, 'current');
  assert.deepEqual(by.get('2027-02').marks, {target: 0, action: 0, forecast: 0, actual: 0});
  assert.equal(by.get('2027-03').state, 'future');
  assert.deepEqual(folder.details.forecast.map((p) => p.code), ['C']); // 確度 0.4 の B は着地に入らないので数えない
});

async function setup(t) {
  const db = await openTestDb({t});
  await loadYojitsuSeed(db);
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SEED_OWNER})});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, body) => {
    const res = await app.request(path, body === undefined ? {headers: {cookie}}
      : {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: res.status, body: await res.json()};
  };
  return {db, call};
}

test('予実管理のフォルダ: 架空の種で開くと年度の12か月のマスと全体の4段と案件が出て、締める・戻す・目標を入れるが版として残る', async (t) => {
  const {call} = await setup(t);
  const asOf = '2027-02-05';
  const opened = await call(`/api/revenue/yojitsu/folder?year=1&asOf=${asOf}`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const folder = opened.body.folder;
  assert.equal(folder.months.length, 12);
  assert.equal(folder.period.yearNo, 1);
  assert.match(opened.body.periods[0].label, /^\d{4}年度$/);
  assert.equal(folder.closedMonth, '2026-11-01'); // 種の締めた月
  assert.equal(folder.months[0].state, 'closed');
  assert.ok(folder.rows.some((r) => r.key === 'landing') && folder.rows.some((r) => r.key === 'actual'));
  assert.ok(folder.projects.length > 0);
  // 値の無いセルは 0 でなく null
  assert.ok(folder.rows.find((r) => r.key === 'actual').months.some((v) => v === null));

  // 12月を締める（足りないものがあれば理由が要る）
  const dec = folder.months[1];
  if (dec.missing > 0) {
    const noReason = await call('/api/revenue/yojitsu/folder/close', {month: '2026-12', previousVersionNo: folder.closedVersionNo, asOf});
    assert.equal(noReason.status, 400);
  }
  const skip = await call('/api/revenue/yojitsu/folder/close', {month: '2027-01', previousVersionNo: folder.closedVersionNo, reason: '架空', asOf});
  assert.equal(skip.status, 409); // 12月を飛ばせない
  const closed = await call('/api/revenue/yojitsu/folder/close', {month: '2026-12', previousVersionNo: folder.closedVersionNo, reason: '架空の理由', asOf});
  assert.equal(closed.status, 201, JSON.stringify(closed.body));
  const after = (await call(`/api/revenue/yojitsu/folder?year=1&asOf=${asOf}`)).body.folder;
  assert.equal(after.closedMonth, '2026-12-01');
  assert.equal(after.months[1].state, 'closed');
  // 古い版の番号で押すと断る
  assert.equal((await call('/api/revenue/yojitsu/folder/close', {month: '2027-01', previousVersionNo: folder.closedVersionNo, reason: '架空', asOf})).status, 409);

  // 戻すには理由が要る。戻すと前の月になり、記録は両方残る
  assert.equal((await call('/api/revenue/yojitsu/folder/reopen', {previousVersionNo: after.closedVersionNo})).status, 400);
  const reopened = await call('/api/revenue/yojitsu/folder/reopen', {previousVersionNo: after.closedVersionNo, reason: '架空の戻しの理由'});
  assert.equal(reopened.status, 201, JSON.stringify(reopened.body));
  assert.equal(reopened.body.closedMonth, '2026-11-01');
  const closes = (await call('/api/revenue/yojitsu/folder/closes')).body.closes;
  assert.match(closes[0].basis, /^戻し 2026-12/);
  assert.match(closes[1].basis, /^締め 2026-12/);

  // 年度の目標（本人）を入れると新しい版になり、4段の目標の年の値が変わる
  const target = await call('/api/revenue/yojitsu/folder/target', {year: 1, amountYen: 12000000, previousVersionNo: after.targetVersionNo, reason: '架空の見直し'});
  assert.equal(target.status, 201, JSON.stringify(target.body));
  const withTarget = (await call(`/api/revenue/yojitsu/folder?year=1&asOf=${asOf}`)).body.folder;
  assert.equal(withTarget.rows.find((r) => r.key === 'target_self').annual, 12000000);
  assert.equal(withTarget.targetVersionNo, after.targetVersionNo + 1);
});
