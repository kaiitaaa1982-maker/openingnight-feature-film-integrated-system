// 本人の倍率の API（行動指標の計画 段B #8。src/revenue/metrics/ の self-multiplier-model・self-multiplier-routes・money-metrics）と、年の目標・計画の
// 版の本人だけの値の守り（データ一覧・一括出力・監査の記録）を確かめる。期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の
// FR-REV-KPI-013〜016（J-1 (a)・J-5 (a)・K2-12・K2-18）と project-cashflow-forecast-actual.md の FR-REV-YOJITSU-006 から持ってくる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う（組織1・2と利用者は試作の行。倍率は架空の不規則な桁、
// 目標・計画・報酬・粗利の額は FR-REV-KPI-016 のとおりソースに書かず、test/personal-amount-fixture.mjs の fictionalYen で実行時に作る）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {BULK_ENTITIES} from '../src/bulk/bulk-entities.mjs';
import {HIDDEN_TABLES, OWNER_ONLY_TABLES} from '../src/admin/data-browser-routes.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {normalizeTargetInput, periodStarts} from '../src/revenue/yojitsu/yojitsu-model.mjs';
import {ownedTargets, selfMultiple, selfMultiplierView, SELF_MULTIPLIER_NOTES} from '../src/revenue/metrics/self-multiplier-model.mjs';
import {ratioX100} from '../src/revenue/metrics/money-metrics.mjs';
import {fictionalYen, COMPENSATION_TABLE_NAME} from './personal-amount-fixture.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const EDITOR = 2; // 組織1の編集担当（試作の行）
const PRODUCTION = 3; // 組織1の制作担当（試作の行）
const EMAIL = {[ADMIN]: 'admin@openingnight.invalid', [EDITOR]: 'editor@openingnight.invalid', [PRODUCTION]: 'production@openingnight.invalid',
  outsider: 'outsider@other.invalid'};
const NOT_OWNER = '本人の倍率と年の目標は、目標の版の持ち主（本人）だけが見られます';
const PATH = '/revenue/metrics/self-multiplier';

// 架空の額を実行時に作る（FR-REV-KPI-016。目標・計画・報酬の額を試験のソースにも書かない。personal-amount-fixture.mjs の fictionalYen）
const YEN = Object.freeze({compensation: fictionalYen(1), productionShare: fictionalYen(2), adminYear2: fictionalYen(3), editorYear3: fictionalYen(4),
  editorCompany: fictionalYen(5), productionYear2: fictionalYen(6), committeePlan: fictionalYen(7), contractPlan: fictionalYen(8)});

// 1〜5年目（1年目は 2026-10-01 始まり）を組織1に足し、年目 → 期間の id を返す
async function periods(db) {
  await store.definePeriods(db, 1, periodStarts('2026-10-01').map((startsOn, i) => ({yearNo: i + 1, startsOn})), {createdBy: ADMIN});
  return new Map((await store.listPeriods(db, 1)).map((p) => [p.yearNo, p.id]));
}
// 目標の版を1つ足す（既定は 本人・全体・額・仮置き）
async function addTarget(db, periodId, overrides) {
  const n = normalizeTargetInput({periodId, previousVersionNo: 0, kind: 'self', scope: 'all', unit: 'period_total', basisKind: 'amount', amountYen: null,
    status: 'provisional', decidedOn: '2026-10-02', decidedBy: '架空の代表', basis: '架空の目標', ownerUserId: ADMIN, ...overrides});
  assert.equal(n.ok, true, JSON.stringify(n.errors));
  await store.addTargetVersion(db, 1, n.value, {createdBy: ADMIN});
}

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path) => {
    const response = await app.request(`/api${path}`, {headers: {cookie}});
    const text = await response.text();
    return {status: response.status, text, body: JSON.parse(text)};
  };
  return {login, call};
}
const auditCount = async (db) => Number((await db.get('SELECT COUNT(*) AS n FROM audit_log WHERE org_id=1')).n);

test('FR-REV-KPI-016 試験の目標・計画・報酬の額は、ソースに書かず実行時に作る不規則な桁の9桁で、どれも違う額', () => {
  const values = Object.values(YEN);
  assert.ok(values.every((v) => Number.isSafeInteger(v) && v >= 100000000 && v <= 999999999), JSON.stringify(values));
  assert.equal(new Set(values).size, values.length);
});

test('FR-REV-KPI-015 本人の倍率は 年の粗利×100÷年の報酬 を0に向かって切り捨て、報酬か粗利が分からなければ null（未接続）、報酬が0円以下なら null', () => {
  const pay = YEN.compensation;
  // ちょうど3倍は 300、1円足りなければ 299（切り捨て）。負の粗利は0に向かって切り捨て（−299.99… → −299）
  assert.deepEqual(selfMultiple(pay * 3, pay), {x100: 300, resolution: 'computed'});
  assert.deepEqual(selfMultiple(pay * 3 - 1, pay), {x100: 299, resolution: 'computed'});
  assert.deepEqual(selfMultiple(-(pay * 3 - 1), pay), {x100: -299, resolution: 'computed'});
  assert.deepEqual(selfMultiple(0, pay), {x100: 0, resolution: 'computed'}, '粗利0円は0倍（報酬が分かっていれば割れる）');
  // 報酬の行（フェーズ1 #17）・5源泉の粗利（段B #2）が無い間は null で、0倍で埋めない
  for (const [profit, compensation] of [[pay * 3, null], [null, pay], [null, null], [pay * 3, undefined]]) {
    assert.deepEqual(selfMultiple(profit, compensation), {x100: null, resolution: 'unconnected'});
  }
  assert.deepEqual(selfMultiple(pay * 3, 0), {x100: null, resolution: 'no_compensation'});
  assert.deepEqual(selfMultiple(pay * 3, -1), {x100: null, resolution: 'no_compensation'});
  // 整数の円でない値は読まない
  assert.throws(() => selfMultiple(pay + 0.5, pay), /整数の円/);
  assert.throws(() => ratioX100(pay * 3, pay + 0.5), /整数の円/);
  // 途中（分子×100）は BigInt で、Number の小数を通さない。結果が安全な整数を超えたら止める
  assert.equal(ratioX100(Number.MAX_SAFE_INTEGER, 1000), 900719925474099);
  assert.throws(() => ratioX100(Number.MAX_SAFE_INTEGER, 1), /安全な整数/);
});

test('FR-REV-KPI-013 FR-REV-KPI-014 期間ごとの行は、読む人が持ち主の有効な全体の目標がある期間だけで、本人以外の目標・制作の取り分・改めた前の版は入らない', () => {
  const periodRows = [{id: 11, yearNo: 1, startsOn: '2026-10-01'}, {id: 12, yearNo: 2, startsOn: '2027-10-01'}, {id: 13, yearNo: 3, startsOn: '2028-10-01'}];
  const t = (o) => ({periodId: 11, kind: 'self', scope: 'all', isOwner: true, effective: true, versionNo: 1, basisKind: 'labor_cost_multiple',
    multiplierX100: 300, amountYen: null, resolution: 'unconnected', status: 'provisional', decidedOn: '2026-10-02', ...o});
  const targets = [
    t({versionNo: 2, multiplierX100: 347}),
    t({versionNo: 1, effective: false, multiplierX100: 300}), // 改めた前の版
    t({kind: 'company', isOwner: false, multiplierX100: null, resolution: 'owner_only'}), // 本人以外の会社の目標
    t({scope: 'production_share', basisKind: 'amount', multiplierX100: null, amountYen: YEN.productionShare, resolution: 'amount'}), // 制作の取り分
    t({periodId: 13, isOwner: false, basisKind: 'amount', multiplierX100: null, resolution: 'owner_only'}),
  ];
  assert.deepEqual(ownedTargets(targets).map((x) => [x.periodId, x.kind, x.versionNo]), [[11, 'self', 2]]);
  const view = selfMultiplierView({periods: periodRows, targets, annualCompensations: new Map([[11, null]])});
  assert.equal(view.allowed, true);
  assert.deepEqual(view.periods, [{periodId: 11, yearNo: 1, startsOn: '2026-10-01',
    targets: {self: {versionNo: 2, basisKind: 'labor_cost_multiple', multiplierX100: 347, amountYen: null, resolution: 'unconnected', status: 'provisional',
      decidedOn: '2026-10-02'}, company: null},
    annualCompensationYen: null, compensationResolution: 'unconnected', annualProfitYen: null, profitResolution: 'unconnected',
    selfMultipleX100: null, selfMultipleResolution: 'unconnected'}]);
  assert.deepEqual(view.defaultMultiplierX100, {self: 300, company: 200});
  assert.deepEqual(view.notes.map((n) => n.code), ['compensation_unconnected', 'profit_unconnected']);
  // 報酬と粗利が分かれば本人の倍率が出て、端数の仮の注記が付く（#17・#2 が入ったあとの形）
  const pay = YEN.compensation;
  const connected = selfMultiplierView({periods: periodRows, targets, annualCompensations: new Map([[11, pay]]), annualProfits: new Map([[11, pay * 3 - 1]])});
  assert.deepEqual([connected.periods[0].annualCompensationYen, connected.periods[0].compensationResolution, connected.periods[0].annualProfitYen,
    connected.periods[0].profitResolution, connected.periods[0].selfMultipleX100, connected.periods[0].selfMultipleResolution],
  [pay, 'recorded', pay * 3 - 1, 'computed', 299, 'computed']);
  assert.deepEqual(connected.notes, [{code: 'rounding_provisional', text: SELF_MULTIPLIER_NOTES.rounding_provisional}]);
  // 年の報酬が0円なら割れず、倍率は null で、理由の注記が付く（未接続の null と注記で見分けられる）
  const zero = selfMultiplierView({periods: periodRows, targets, annualCompensations: new Map([[11, 0]]), annualProfits: new Map([[11, pay * 3]])});
  assert.deepEqual([zero.periods[0].annualCompensationYen, zero.periods[0].compensationResolution, zero.periods[0].selfMultipleX100,
    zero.periods[0].selfMultipleResolution], [0, 'recorded', null, 'no_compensation']);
  assert.deepEqual(zero.notes, [{code: 'no_compensation', text: SELF_MULTIPLIER_NOTES.no_compensation}]);
  // 持ち主の目標が1つも無ければ allowed が偽で、ほかの値を持たない
  assert.deepEqual(selfMultiplierView({periods: periodRows, targets: targets.filter((x) => !x.isOwner || !x.effective || x.scope !== 'all')}), {allowed: false});
  assert.deepEqual(selfMultiplierView({periods: periodRows, targets: []}), {allowed: false});
});

test('FR-REV-KPI-013 FR-REV-KPI-015 持ち主（本人）には期間ごとの年の目標の倍率（既定 本人3・会社2、改めた版）と額を返し、報酬の行が無い間は人件費・人件費×倍率の額・本人の倍率が null（未接続）', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await addTarget(db, period.get(1), {basisKind: 'labor_cost_multiple', multiplierX100: 347});
  await addTarget(db, period.get(1), {kind: 'company', basisKind: 'labor_cost_multiple'}); // 倍率を入れなければ会社は2倍
  await addTarget(db, period.get(2), {amountYen: YEN.adminYear2});
  await addTarget(db, period.get(3), {amountYen: YEN.editorYear3, ownerUserId: EDITOR});
  // 倍率を改めた版（K2-18。版として残り、最新の版が有効）
  await addTarget(db, period.get(1), {previousVersionNo: 1, basisKind: 'labor_cost_multiple', multiplierX100: 412, decidedOn: '2026-11-04'});
  const {login, call} = await appWithLogin(db);
  const admin = await login(EMAIL[ADMIN]);
  const before = await auditCount(db);
  const own = await call(admin, PATH);
  assert.equal(own.status, 200);
  assert.equal(own.body.ok, true);
  assert.equal(own.body.definitionVersion, 'self-multiplier.2026-10-11');
  assert.deepEqual(own.body.defaultMultiplierX100, {self: 300, company: 200});
  const labor = (versionNo, multiplierX100, decidedOn = '2026-10-02') => ({versionNo, basisKind: 'labor_cost_multiple', multiplierX100, amountYen: null,
    resolution: 'unconnected', status: 'provisional', decidedOn});
  const unconnected = {annualCompensationYen: null, compensationResolution: 'unconnected', annualProfitYen: null, profitResolution: 'unconnected',
    selfMultipleX100: null, selfMultipleResolution: 'unconnected'};
  assert.deepEqual(own.body.periods, [
    {periodId: period.get(1), yearNo: 1, startsOn: '2026-10-01', targets: {self: labor(2, 412, '2026-11-04'), company: labor(1, 200)}, ...unconnected},
    {periodId: period.get(2), yearNo: 2, startsOn: '2027-10-01', targets: {self: {versionNo: 1, basisKind: 'amount', multiplierX100: null, amountYen: YEN.adminYear2,
      resolution: 'amount', status: 'provisional', decidedOn: '2026-10-02'}, company: null}, ...unconnected},
  ], '3年目は編集担当の目標なので入らない');
  assert.deepEqual(own.body.notes.map((n) => n.code), ['compensation_unconnected', 'profit_unconnected']);
  // 改めた前の版も消えずに残る（目標の読み取り関数の history）
  const history = await store.readTargets(db, 1, {viewerUserId: ADMIN, history: true});
  assert.deepEqual(history.filter((r) => r.yearNo === 1 && r.kind === 'self').map((r) => [r.versionNo, r.multiplierX100, r.effective]), [[1, 347, false], [2, 412, true]]);
  // 読むだけで、監査の記録を足さない
  assert.equal(await auditCount(db), before);
  // 編集担当は自分が持ち主の3年目だけを読み、管理者の目標の額・倍率は応答に無い
  const editor = await call(await login(EMAIL[EDITOR]), PATH);
  assert.equal(editor.status, 200);
  assert.deepEqual(editor.body.periods.map((p) => [p.yearNo, p.targets.self.amountYen, p.targets.company]), [[3, YEN.editorYear3, null]]);
  for (const secret of [String(YEN.adminYear2), '412', '347']) assert.ok(!editor.text.includes(secret), `${secret} が持ち主でない人の応答に出る`);
});

test('FR-REV-KPI-014 FR-REV-KPI-015 本人の倍率の API は目標の版の持ち主以外に、管理者・制作担当・別の組織の利用者も含めて 403 を返し、目標・倍率の値を応答に入れない', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  const {login, call} = await appWithLogin(db);
  const admin = await login(EMAIL[ADMIN]);
  const editor = await login(EMAIL[EDITOR]);
  // 目標の版がまだ無いときも、版の有無を見せず同じ 403
  for (const cookie of [admin, editor]) assert.deepEqual(await call(cookie, PATH), {status: 403, text: JSON.stringify({ok: false, error: NOT_OWNER}),
    body: {ok: false, error: NOT_OWNER}});
  await addTarget(db, period.get(1), {basisKind: 'labor_cost_multiple', multiplierX100: 347, ownerUserId: EDITOR});
  await addTarget(db, period.get(1), {kind: 'company', amountYen: YEN.editorCompany, ownerUserId: EDITOR});
  await addTarget(db, period.get(2), {amountYen: YEN.productionYear2, ownerUserId: PRODUCTION}); // 制作担当が持ち主の版も、役割で断る
  const denied = [
    [admin, {ok: false, error: NOT_OWNER}],
    [await login(EMAIL.outsider), {ok: false, error: NOT_OWNER}],
    [await login(EMAIL[PRODUCTION]), {ok: false, error: 'この役割では財務データを参照できません'}],
  ];
  for (const [cookie, expected] of denied) {
    const out = await call(cookie, PATH);
    assert.equal(out.status, 403);
    assert.deepEqual(out.body, expected);
    for (const secret of ['347', String(YEN.editorCompany), String(YEN.productionYear2), '200', '300']) {
      assert.ok(!out.text.includes(secret), `${secret} が 403 の応答に出る`);
    }
  }
  // 持ち主（編集担当）には 200
  const own = await call(editor, PATH);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.periods.map((p) => [p.yearNo, p.targets.self.multiplierX100, p.targets.company.amountYen]), [[1, 347, YEN.editorCompany]]);
});

test('FR-REV-KPI-016 FR-REV-YOJITSU-006 本人以外の管理者のデータ一覧・一括出力・監査の記録に、目標の版・計画の版と子表・採用の記録の行と額・倍率が出ない', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  // 目標・計画の持ち主は編集担当。管理者は持ち主でない
  await addTarget(db, period.get(1), {basisKind: 'labor_cost_multiple', multiplierX100: 347, ownerUserId: EDITOR});
  await addTarget(db, period.get(1), {kind: 'company', amountYen: YEN.editorCompany, ownerUserId: EDITOR});
  await store.addPlanVersion(db, 1, {periodId: period.get(1), previousVersionNo: 0, ownerUserId: EDITOR, status: 'provisional', basis: '架空の計画',
    createdOn: '2026-10-02', adoptedOn: '2026-10-02',
    amounts: [{earningType: 'committee', amountYen: YEN.committeePlan}, {earningType: 'contract_work', amountYen: YEN.contractPlan}]},
  {createdBy: EDITOR});
  const amounts = [YEN.editorCompany, YEN.committeePlan, YEN.contractPlan, YEN.committeePlan + YEN.contractPlan].map(String);
  const {login, call} = await appWithLogin(db);
  const admin = await login(EMAIL[ADMIN]);
  assert.equal((await call(await login(EMAIL[EDITOR]), PATH)).status, 200, '持ち主が読んだあとも、監査の記録に値は残らない');

  // データ一覧: 表名ごと出ず、行・定義も 404。出る表はどれも、額と倍率の列の値を持たない
  const list = await call(admin, '/admin/tables');
  assert.equal(list.status, 200);
  const names = list.body.tables.map((x) => x.name);
  for (const table of OWNER_ONLY_TABLES) {
    assert.ok(!names.includes(table), `${table} がデータ一覧に出る`);
    assert.equal((await call(admin, `/admin/tables/${table}`)).status, 404);
    assert.equal((await call(admin, `/admin/tables/${table}/definition`)).status, 404);
  }
  // データ一覧に出る表の行（受け口は表の行をそのまま返す）に、目標・計画の額が写っていない（記録や別の表へ写す書き込みが増えたら落ちる）
  for (const name of names) {
    const text = JSON.stringify(await db.all(`SELECT * FROM "${name}"`));
    for (const secret of amounts) assert.ok(!text.includes(secret), `${name} の行に目標・計画の額 ${secret} が出る`);
  }
  const auditRows = await call(admin, '/admin/tables/audit_log');
  assert.equal(auditRows.status, 200);
  assert.ok(!auditRows.body.columns.includes('multiplier_x100'));
  // 報酬の表（フェーズ1 #17 が足す。名前は COMPENSATION_TABLE_NAME の取り決め）も表名ごと除く。いまは表が無いので、足したときにこの検査が働く
  for (const name of names) assert.ok(!COMPENSATION_TABLE_NAME.test(name), `${name}（報酬の表）がデータ一覧に出る。HIDDEN_TABLES に足す`);

  // 監査の記録（管理者が /api/audit とデータ一覧で読む）: 目標・計画の行の記録に額・倍率の項目と値が無い
  const audit = await call(admin, '/audit');
  assert.equal(audit.status, 200);
  const details = audit.body.rows.filter((r) => ['yojitsu_target_version', 'yojitsu_plan_version', 'plan_adoption'].includes(r.entity_type))
    .map((r) => JSON.parse(r.detail_json));
  assert.equal(details.length, 4);
  const leaves = (value) => (value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value]);
  for (const detail of details) {
    assert.ok(Object.keys(detail).every((key) => !/yen|amount|multiplier|basis|source/i.test(key)), JSON.stringify(detail));
    for (const value of leaves(detail)) {
      assert.ok(![347, 200, YEN.editorCompany, YEN.committeePlan, YEN.contractPlan].includes(value), `${value} が監査の記録に残る`);
    }
  }
  for (const secret of amounts) assert.ok(!audit.text.includes(secret), `監査の記録に ${secret} が出る`);

  // 一括出力（Excel）: どの種類の行にも額が出ず、対象の表に目標・計画の表と報酬の表が無い
  const entities = await call(admin, '/bulk/entities');
  assert.equal(entities.status, 200);
  for (const {entity} of entities.body.entities) {
    const rows = await call(admin, `/bulk/${entity}/rows`);
    assert.equal(rows.status, 200, entity);
    for (const secret of amounts) assert.ok(!rows.text.includes(secret), `一括出力の ${entity} に ${secret} が出る`);
  }
  for (const entity of Object.values(BULK_ENTITIES)) {
    assert.ok(!OWNER_ONLY_TABLES.includes(entity.table) && !COMPENSATION_TABLE_NAME.test(entity.table), `一括出力の対象に ${entity.table} がある`);
  }
  assert.ok(OWNER_ONLY_TABLES.every((table) => HIDDEN_TABLES.has(table)));
});
