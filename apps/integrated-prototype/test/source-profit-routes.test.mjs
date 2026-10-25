// 源泉別の利益額の受け口（GET /api/accounting/profit/sources。src/accounting/profit/profit-routes.mjs と source-profit-model.mjs。行動指標の計画 段B #2）に、
// 案件収支の予実の架空の種（フェーズ1 #23a。請求は入金の無い請求も全部）と種の経費・委員会の払込・稟議の版（test/profit-db-fixture.mjs）、段B #15 の延長の種の
// 受託制作の契約の版（test/fixtures/yojitsu/kpi-seed.json の contractVersions）を入れ、源泉1・2が golden（kpi-expected.json の sourceProfit。段B #15）と
// 計上・入金とも一致し、源泉3〜5 は未接続（null）で、同じ窓・同じ基準の会社への利益額（GET /api/accounting/profit。フェーズ1 #14b）と突き合わせて
// 差に理由が付くことを確かめる。あわせて、稟議の払込の判定（締めた月より前は実績の側）と払った月に引くこと、源泉1が契約済みの案件の節目だけを数えること、
// SQL の本数が固定（10文）、権限と引数を確かめる。期待値の出どころは要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-005・006・007・039、
// docs/requirements/accounting/company-profit.md の FR-ACCT-PROFIT-013 と golden。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import {normalizeContractVersionInput} from '../src/planning/contract-production/contract-production-model.mjs';
import {loadYojitsuSeed, yojitsuSeed, SEED_OWNER} from './yojitsu-view-fixture.mjs';
import {DB_ITEM_OF_GOLDEN, loadProfitSeedCosts} from './profit-db-fixture.mjs';
import {SEED_ONLY_EXCLUDED} from './profit-fixture.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/yojitsu/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
const golden = read('kpi-expected.json');
const kpiSeed = read('kpi-seed.json');
const PERIOD = `from=${golden.period.from}&to=${golden.period.to}`;
const CONNECTED = ['contract_work', 'own_investment'];
const UNCONNECTED = ['committee', 'acquisition', 'consignment'];
const AMOUNTS = ['salesYen', 'costYen', 'profitYen', 'fourItemsYen', 'profitWithoutFourItemsYen'];
const sum = (list, f = (x) => x) => list.reduce((n, x) => n + f(x), 0);

// DB の入口の呼び出しを数える（all・get・run は1本、batch・readBatch は文の数）
function countingDb(db) {
  const counter = {n: 0};
  const proxy = new Proxy(db, {get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (['all', 'get', 'run'].includes(prop)) return (...args) => { counter.n += 1; return value.apply(target, args); };
    if (prop === 'readBatch' || prop === 'batch') return (statements, ...rest) => { counter.n += statements.length; return value.call(target, statements, ...rest); };
    return value.bind(target);
  }});
  return {db: proxy, counter};
}

// 段B #15 の延長の種の受託制作の契約の版を、種の案件の版（loadYojitsuSeed が売上率のために足した版1）の次の版として足す
async function loadKpiContractVersions(db, {seeded}) {
  for (const v of kpiSeed.contractVersions) {
    const projectId = seeded.projectId.get(v.projectCode);
    const latest = (await planning.readContractVersions(db, 1, projectId)).versions.at(-1);
    const n = normalizeContractVersionInput({previousVersionNo: Number(latest.version_no), budgetYen: v.budgetYen, markupBps: v.markupBps,
      contractReference: '架空の受託の契約書（延長の種）', milestones: v.milestones.map((m) => ({dueOn: m.dueOn, shareBps: m.shareBps}))});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await planning.addContractVersion(db, 1, projectId, n.value, {createdBy: seeded.owner});
  }
}

async function setup(t) {
  const raw = await openTestDb({t});
  const seed = yojitsuSeed();
  const seeded = await loadYojitsuSeed(raw, {seed, allInvoices: true});
  await loadProfitSeedCosts(raw, {seeded, seed});
  await loadKpiContractVersions(raw, {seeded});
  const {db, counter} = countingDb(raw);
  const app = createApp({db, mode: 'local'});
  async function as(email) {
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(login.status, 200, email);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return async (path) => {
      const before = counter.n;
      const res = await app.request(path, {headers: {cookie}});
      return {status: res.status, body: await res.json(), sql: counter.n - before};
    };
  }
  return {raw, seed, seeded, as};
}

// golden の未確定・除外の行（費目は golden の語）を、統合システムが記録から決められる費目へ写して費目ごとに足す（DB_ITEM_OF_GOLDEN。写さない費目は落とす）
function mappedGroups(list) {
  const out = new Map();
  for (const r of list) {
    const label = DB_ITEM_OF_GOLDEN[r.item];
    if (label === null || r.item === SEED_ONLY_EXCLUDED) continue;
    out.set(label, (out.get(label) ?? 0) + r.amountYen);
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1));
}
const groups = (list) => list.map((r) => [r.label, r.amountYen]).sort(([a], [b]) => (a < b ? -1 : 1));

test('FR-ACCT-PROFIT-013 FR-REV-KPI-005 FR-REV-KPI-006 FR-REV-KPI-007 架空の種を入れると、源泉1・2の売上・経費・粗利・4費目は計上・入金とも golden と一致し、源泉3〜5 は未接続（null）で、SQL は固定の10文', async (t) => {
  const {as} = await setup(t);
  const owner = await as(SEED_OWNER);
  const baseline = (await owner('/api/session')).sql;
  const hashes = new Set();
  for (const basis of ['accrual', 'cash']) {
    const res = await owner(`/api/accounting/profit/sources?basis=${basis}&${PERIOD}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const view = res.body;
    assert.deepEqual([view.basis, view.basisLabel, view.taxLabel, view.closedMonth], [basis, basis === 'cash' ? '入金' : '計上', '税別', golden.closedMonth]);
    // 実績の窓は 期間の始まり〜締めた月（golden の「実績は期間の始まり〜締めた月」）
    assert.deepEqual(view.window, {from: golden.period.from, to: golden.closedMonth, clippedAtClosedMonth: true, empty: false});
    for (const key of CONNECTED) {
      const want = golden.sourceProfit[basis].bySource.find((r) => r.source === key);
      const got = view.sources.find((s) => s.key === key);
      assert.deepEqual([got.status, ...AMOUNTS.map((k) => got[k])], [want.status, ...AMOUNTS.map((k) => want[k])], `${basis} ${key}`);
      assert.deepEqual(groups(got.unsettled), mappedGroups(want.unconfirmed), `${basis} ${key} の未確定`);
      assert.deepEqual(groups(got.excluded), mappedGroups(want.excluded), `${basis} ${key} の除外`);
    }
    // 源泉1は延長の種の契約の版（YJ-P25。節目は 2026-12 から）で接続し、締めた月までの節目が無いので0円。制作の実費は除外のまま
    const s1 = view.sources.find((s) => s.key === 'contract_work');
    assert.deepEqual(s1.detail.counted.map((r) => [r.code, r.feeReceivedPeriodYen]), [['YJ-P25', 0]]);
    assert.deepEqual(s1.detail.scheduled.map((m) => m.month), kpiSeed.contractVersions[0].milestones.map((m) => m.dueOn.slice(0, 7)));
    assert.deepEqual(s1.excluded.map((r) => [r.label, r.amountYen]), [['制作の実費', 1750000]]);
    for (const key of UNCONNECTED) {
      const got = view.sources.find((s) => s.key === key);
      assert.deepEqual([got.status, ...AMOUNTS.map((k) => got[k]), got.investmentYen, got.expenseYen], ['unconnected', null, null, null, null, null, null, null], `${basis} ${key}`);
    }
    // 5つの合計は全部が接続するまで出さず、接続した源泉の和は golden の源泉1・2の和
    assert.deepEqual([view.total.complete, view.total.profitYen], [false, null]);
    const wantConnected = golden.sourceProfit[basis].bySource.filter((r) => CONNECTED.includes(r.source));
    assert.deepEqual([view.connectedTotal.salesYen, view.connectedTotal.profitYen], [sum(wantConnected, (r) => r.salesYen), sum(wantConnected, (r) => r.profitYen)], basis);
    assert.match(view.sourceHash, /^[0-9a-f]{64}$/);
    hashes.add(view.sourceHash);
    assert.equal((await owner(`/api/accounting/profit/sources?basis=${basis}&${PERIOD}`)).body.sourceHash, view.sourceHash, '同じ入力・同じ読む人で同じ sourceHash');
    // 締めた月の設定の1文と、読み取りの一括の9文（組織の集計と経費分類3種を1文にまとめる）
    assert.ok(res.sql - baseline <= 10, `源泉別の利益額の SQL（認証を除く）が ${res.sql - baseline} 本で上限10を超えています`);
  }
  assert.equal(hashes.size, 2);
});

test('FR-ACCT-PROFIT-013 源泉別の粗利を同じ窓・同じ基準の会社への利益額と突き合わせ、源泉ごとの利益額の和は利益額の受け口の合計と同じで、差のある行には理由が付く', async (t) => {
  const {as} = await setup(t);
  const owner = await as(SEED_OWNER);
  for (const basis of ['accrual', 'cash']) {
    const view = (await owner(`/api/accounting/profit/sources?basis=${basis}&${PERIOD}`)).body;
    const p1 = (await owner(`/api/accounting/profit?basis=${basis}&from=${golden.period.from}&to=${golden.closedMonth}`)).body;
    assert.equal(view.reconciliation.total.p1ProfitYen, p1.settled.totals.profitYen, `${basis}: 突き合わせの利益額は利益額の受け口の合計`);
    for (const row of view.reconciliation.rows) {
      const mine = p1.byProject.filter((p) => p.earningType === row.key);
      assert.deepEqual([row.p1SalesYen, row.p1CostYen, row.p1ProfitYen], [sum(mine, (p) => p.salesYen), sum(mine, (p) => p.costYen), sum(mine, (p) => p.profitYen)], `${basis} ${row.key}`);
      if (CONNECTED.includes(row.key)) {
        // 種では源泉1も源泉2も利益額と同じ額（受託の入金・節目が窓に無い）
        assert.deepEqual([row.diffYen, row.reason], [0, null], `${basis} ${row.key}`);
      } else {
        assert.deepEqual([row.profitYen, row.diffYen, row.reason], [null, 0 - row.p1ProfitYen, 'unconnected'], `${basis} ${row.key}`);
        assert.match(row.reasonLabel, /未接続/);
      }
    }
    assert.equal(view.reconciliation.total.diffYen, sum(view.reconciliation.rows, (r) => r.diffYen));
    assert.equal(view.reconciliation.total.sourceProfitYen, view.connectedTotal.profitYen);
    // 稼ぎ方の無い案件は種に無い（稼ぎ方の無い案件の行を作らない）
    assert.equal(view.reconciliation.rows.some((r) => r.key === 'none'), false);
    // 締めた月より後の月（期間の残り）の利益額は突き合わせに入れない: 期間の終わりまでの利益額とは合わせない
    assert.equal(view.unattributedYen, p1.unknownProject.total);
  }
});

// 種の自社出資の案件 YJ-P11（稟議が無い）に稟議を足す: 申請・承認 30,000,000、払込 10,000,000（2026-11-20。締めた月の中）と 5,000,000（2026-12-15。締めた月の翌月）。
// 期待値は golden の源泉2から手で動かす: 出資額と経費が 10,000,000 増え、粗利が同じだけ減る（払った月 2026-11 に。計上・入金とも）。12月の払込は実績に入らず
// 予測の側に払う月で出て、承認の額の残り 15,000,000 は月の無い予測の側。利益額とは差が出ない（1回だけ引く）。
// 壊れたら: 締めた月で切らないと出資額が 15,000,000 に、承認の額で引くと 30,000,000 になり、予測の側を実績からも引くと利益額と差が出る
test('FR-REV-KPI-007 FR-REV-KPI-039 FR-ACCT-PROFIT-013 稟議の払込は払った月の源泉2の出資額に1回だけ入り、締めた月より後の払込と承認したがまだ払っていない額は予測の側に出る', async (t) => {
  const {raw, seeded, as} = await setup(t);
  const owner = await as(SEED_OWNER);
  const sqlBefore = (await owner(`/api/accounting/profit/sources?basis=cash&${PERIOD}`)).sql;
  const project = seeded.projectId.get('YJ-P11');
  const add = (versionNo, status, amountYen, paidOn = null) => planning.addInvestmentApprovalVersion(raw, 1, project, {approvalNo: 1, versionNo, status, amountYen,
    basisReference: status === 'applied' ? '架空の企画書と試算' : null, paidOn, note: null}, {createdBy: seeded.owner});
  await add(1, 'applied', 30000000);
  await add(2, 'approved', 30000000);
  await add(3, 'paid', 10000000, '2026-11-20');
  await add(4, 'paid', 5000000, '2026-12-15');
  for (const basis of ['accrual', 'cash']) {
    const res = await owner(`/api/accounting/profit/sources?basis=${basis}&${PERIOD}`);
    assert.equal(res.status, 200);
    const s2 = res.body.sources.find((s) => s.key === 'own_investment');
    const want = golden.sourceProfit[basis].bySource.find((r) => r.source === 'own_investment');
    assert.deepEqual([s2.salesYen, s2.investmentYen, s2.costYen, s2.profitYen, s2.fourItemsYen, s2.profitWithoutFourItemsYen],
      [want.salesYen, 10000000, want.costYen + 10000000, want.profitYen - 10000000, want.fourItemsYen + 10000000, want.profitWithoutFourItemsYen], basis);
    assert.equal(s2.monthly.investmentYen[res.body.months.indexOf('2026-11')], 10000000, basis);
    assert.deepEqual(s2.detail.forecast.scheduled.map((s) => [s.code, s.month, s.amountYen]), [['YJ-P11', '2026-12', 5000000]]);
    assert.deepEqual([s2.detail.forecast.scheduledYen, s2.detail.forecast.unscheduledYen], [5000000, 15000000]);
    // 出資の回収（累計。締めた月まで）は 10,000,000 で、粗利とは別に出る
    const recovery = s2.detail.recovery.rows.find((r) => r.code === 'YJ-P11');
    assert.deepEqual([recovery.investmentYen, recovery.approvedYen, recovery.remainingYen], [10000000, 30000000, 15000000]);
    const row = res.body.reconciliation.rows.find((r) => r.key === 'own_investment');
    assert.deepEqual([row.diffYen, row.reason], [0, null], basis);
    // 期間を払った月の前で終えると、払込は窓の外で引かない（払った月に引く）
    const before = (await owner(`/api/accounting/profit/sources?basis=${basis}&from=${golden.period.from}&to=2026-10`)).body;
    assert.equal(before.sources.find((s) => s.key === 'own_investment').investmentYen, 0, basis);
    // 稟議の版が増えても SQL の本数は同じ
    assert.equal(res.sql, sqlBefore);
  }
});

// 種の受託制作: YJ-P25 は契約済み、YJ-P29 は見送り、ほかは契約前の段階（loadYojitsuSeed が売上率のために、始めた月に節目1つの版を足している）。
// YJ-P25 に節目 2026-11-01（3333 bp）と 2027-02-01（6667 bp）の版、YJ-P29 に節目 2026-10-01（10000 bp）の版を足す（総製作費・受託費率は架空）。
// 期待値は FR-REV-KPI-006 から独立に計算する: 受託費＝総製作費×受託費率の truncate、節目へは最大剰余法、入金した節目＝締めた月まで。
// 壊れたら: 段階を見ないと YJ-P29 の受託費と契約前の案件（YJ-P27・P28・P30。節目 2026-10・11）の受託費が実績に入り、節目の月で切らないと 2027-02 の分が入る
test('FR-REV-KPI-006 FR-ACCT-PROFIT-013 源泉1は契約済みの案件の締めた月までの節目を受託費の純額で数え、見送り・契約前の案件の節目は数えず、利益額との差に理由が付く', async (t) => {
  const {raw, seeded, as} = await setup(t);
  const addVersion = async (code, {budgetYen, markupBps, milestones}) => {
    const projectId = seeded.projectId.get(code);
    const latest = (await planning.readContractVersions(raw, 1, projectId)).versions.at(-1);
    const n = normalizeContractVersionInput({previousVersionNo: Number(latest.version_no), budgetYen, markupBps, contractReference: '架空の受託の契約書（改定）', milestones});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await planning.addContractVersion(raw, 1, projectId, n.value, {createdBy: seeded.owner});
  };
  await addVersion('YJ-P25', {budgetYen: 31415927, markupBps: 1150, milestones: [{dueOn: '2026-11-01', shareBps: 3333}, {dueOn: '2027-02-01', shareBps: 6667}]});
  await addVersion('YJ-P29', {budgetYen: 12345678, markupBps: 1000, milestones: [{dueOn: '2026-10-01', shareBps: 10000}]});
  // 受託費 trunc(31,415,927×1150/10000) と、3333・6667 bp への最大剰余法
  const fee = Number(31415927n * 1150n / 10000n);
  const floors = [3333, 6667].map((share) => ({floor: Number(BigInt(fee) * BigInt(share) / 10000n), rest: BigInt(fee) * BigInt(share) % 10000n}));
  let left = fee - floors[0].floor - floors[1].floor;
  for (const p of [...floors].sort((a, b) => (a.rest === b.rest ? 0 : a.rest > b.rest ? -1 : 1))) if (left > 0) { p.floor += 1; left -= 1; }
  const [november, february] = floors.map((p) => p.floor);
  assert.equal(november + february, fee);
  const owner = await as(SEED_OWNER);
  for (const basis of ['accrual', 'cash']) {
    const view = (await owner(`/api/accounting/profit/sources?basis=${basis}&${PERIOD}`)).body;
    const s1 = view.sources.find((s) => s.key === 'contract_work');
    const want = golden.sourceProfit[basis].bySource.find((r) => r.source === 'contract_work');
    assert.deepEqual([s1.status, s1.salesYen, s1.costYen, s1.profitYen], ['connected', november, want.costYen, november - want.costYen], basis);
    assert.equal(s1.monthly.salesYen[view.months.indexOf('2026-11')], november);
    assert.deepEqual(s1.detail.scheduled.map((m) => [m.code, m.month, m.feeYen]), [['YJ-P25', '2027-02', february]]);
    assert.deepEqual(s1.detail.notCounted.map((r) => [r.code, r.reason]),
      [['YJ-P26', 'not_contracted'], ['YJ-P27', 'not_contracted'], ['YJ-P28', 'not_contracted'], ['YJ-P29', 'declined'], ['YJ-P30', 'not_contracted']]);
    assert.equal(s1.detail.receiptBasis, 'milestone_month');
    assert.ok(s1.notes.some((n) => n.startsWith('売上は節目の月で数える（入金は未確認')), JSON.stringify(s1.notes));
    // 利益額の受託の売上（入金×受託費率）は窓に無いので、差は節目で数えた受託費そのもの
    const row = view.reconciliation.rows.find((r) => r.key === 'contract_work');
    assert.deepEqual([row.p1ProfitYen, row.diffYen, row.reason], [want.profitYen, november, 'milestone_basis'], basis);
  }
});

test('FR-ACCT-PROFIT-013 FR-ACCT-PROFIT-009 源泉別の受け口は制作担当と財務の権限の案件の無い編集担当に 403、引数の誤りは 400、編集担当は財務の権限の案件の分だけで、別の組織には組織1の額が出ない', async (t) => {
  const {raw, seeded, as} = await setup(t);
  assert.equal((await (await as('production@openingnight.invalid'))('/api/accounting/profit/sources')).status, 403);
  await raw.run("INSERT INTO users(id,email,display_name) VALUES(9,'source-viewer@openingnight.invalid','架空の編集担当（源泉別）')");
  await raw.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,9,'editor')");
  await raw.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,9,'production')", [seeded.projectId.get('YJ-P01')]);
  assert.equal((await (await as('source-viewer@openingnight.invalid'))('/api/accounting/profit/sources')).status, 403);
  const owner = await as(SEED_OWNER);
  for (const [query, field] of [['basis=gross', 'basis'], ['from=2026-13', 'from'], ['from=2026-11&to=2026-10', 'from']]) {
    const res = await owner(`/api/accounting/profit/sources?${query}`);
    assert.deepEqual([res.status, res.body.details.field], [400, field], query);
  }
  // 編集担当（試作の行）に自社出資の YJ-P01 と受託の YJ-P25 の edit を足すと、その2件の分だけ（案件不明は出さない）
  for (const code of ['YJ-P01', 'YJ-P25']) {
    await raw.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'edit')", [seeded.projectId.get(code)]);
  }
  const editor = await as('editor@openingnight.invalid');
  const res = await editor(`/api/accounting/profit/sources?basis=cash&${PERIOD}`);
  assert.equal(res.status, 200);
  const p1 = (await editor(`/api/accounting/profit?basis=cash&from=${golden.period.from}&to=${golden.closedMonth}`)).body;
  assert.deepEqual(res.body.sources.find((s) => s.key === 'own_investment').projects.map((p) => p.code), ['YJ-P01']);
  assert.deepEqual(res.body.sources.find((s) => s.key === 'contract_work').detail.counted.map((r) => r.code), ['YJ-P25']);
  assert.deepEqual(res.body.sources.find((s) => s.key === 'own_investment').detail.recovery.rows.map((r) => r.code), ['YJ-P01']);
  assert.equal(res.body.reconciliation.total.p1ProfitYen, p1.settled.totals.profitYen);
  assert.deepEqual([res.body.scope.company, res.body.unattributedYen], [false, null]);
  // 別の組織の管理者: 締めた月の設定も受託の契約の版も無いので、源泉1は未接続、源泉2は0円（組織1の額が出ない）
  const outsider = (await (await as('outsider@other.invalid'))(`/api/accounting/profit/sources?basis=cash&${PERIOD}`)).body;
  assert.deepEqual([outsider.closedMonth, outsider.sources[0].status, outsider.connectedTotal.salesYen, outsider.reconciliation.total.p1ProfitYen], [null, 'unconnected', 0, 0]);
});
