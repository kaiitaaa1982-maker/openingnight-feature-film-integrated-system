// 受託制作の契約の版（移行 0013）と売上の4区分（フェーズ1の仕様書 #10b）を、DB の制約・store・受け口で確かめる。
// 期待値は要件 docs/requirements/revenue/contract-work.md の FR-REV-CWORK-035・036 と、project-cashflow-forecast-actual.md の
// FR-REV-YOJITSU-022・044 と「稼ぎ方×案件の型×売上の4区分の対応表」から持ってくる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 架空のデータだけを使う（組織1・2と利用者は試作の行、案件と入金は test/fixtures/yojitsu/revenue-classes.json）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import {normalizeContractVersionInput} from '../src/planning/contract-production/contract-production-model.mjs';
import {revenueClassBases, summarizeRevenueClasses} from '../src/revenue/revenue-class/revenue-class-model.mjs';
import {loadRevenueClassFixture, seedRevenueClassFixture} from './revenue-class-fixture.mjs';
import {pgUniqueViolation, racingBatchDb} from './racing-db.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const raw = (db, sql, params = []) => db.run(sql, params);
const createProject = (db, overrides = {}) => planning.createProject(db, 1, {
  code: 'FICT-CW-1', title: '架空の制作受託', projectType: 'contract_production', earningType: 'contract_work', baseAmountYen: null, revenueRateBps: null,
  counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null, ...overrides,
}, {createdBy: ADMIN});
const version = (overrides = {}) => {
  const result = normalizeContractVersionInput({previousVersionNo: 0, budgetYen: 48271903, milestones: [{dueOn: '2026-05-01', shareBps: 3000}, {dueOn: '2026-08-01', shareBps: 7000}], ...overrides});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.value;
};
const insertVersion = (db, projectId, {versionNo = 1, budget = 1000000, markup = 1000, fee = 100000, count = 2} = {}) => raw(db,
  'INSERT INTO contract_production_versions(org_id,project_id,version_no,budget_yen,markup_bps,fee_yen,milestone_count,created_by) VALUES(1,?,?,?,?,?,?,1)',
  [projectId, versionNo, budget, markup, fee, count]);
const insertMilestone = (db, projectId, {versionNo = 1, seq, dueOn, share}) => raw(db,
  'INSERT INTO contract_production_milestones(org_id,project_id,version_no,seq,due_on,share_bps) VALUES(1,?,?,?,?,?)', [projectId, versionNo, seq, dueOn, share]);

test('FR-REV-CWORK-035 受託制作の契約の版は型「受託制作」の案件にだけ足せて、版を足して残り、書き換え・削除・番号の飛ばし・古い画面からの書き込みを断る', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db);
  assert.equal(await planning.addContractVersion(db, 1, id, version({contractReference: 'FICT/契約書/架空_第1版.pdf'}), {createdBy: ADMIN}), 1);
  assert.equal(await planning.addContractVersion(db, 1, id, version({previousVersionNo: 1, budgetYen: 52364117, markupBps: 1250,
    milestones: [{dueOn: '2026-05-01', shareBps: 3333}, {dueOn: '2026-09-01', shareBps: 3334}, {dueOn: '2027-01-01', shareBps: 3333}]}), {createdBy: ADMIN}), 2);
  const {versions, milestones} = await planning.readContractVersions(db, 1, id);
  // 第1版は既定の受託費率 1000（10%）で 4,827,190.3 → 4,827,190、第2版は 12.5% で 6,545,514.625 → 6,545,514（truncate）
  assert.deepEqual(versions.map((v) => [Number(v.version_no), Number(v.budget_yen), Number(v.markup_bps), Number(v.fee_yen), Number(v.milestone_count), v.contract_reference]), [
    [1, 48271903, 1000, 4827190, 2, 'FICT/契約書/架空_第1版.pdf'],
    [2, 52364117, 1250, 6545514, 3, null],
  ]);
  assert.deepEqual(milestones.map((m) => [Number(m.version_no), Number(m.seq), m.due_on, Number(m.share_bps)]), [
    [1, 1, '2026-05-01', 3000], [1, 2, '2026-08-01', 7000],
    [2, 1, '2026-05-01', 3333], [2, 2, '2026-09-01', 3334], [2, 3, '2027-01-01', 3333],
  ]);
  // 古い画面（第1版を見ていた）からの書き込みは断り、節目の行も変更の記録（audit_log）も入らない（1回の batch）
  const auditRows = async () => Number((await db.get("SELECT count(*) AS n FROM audit_log WHERE org_id=1 AND entity_type='contract_production_version'")).n);
  assert.equal(await auditRows(), 2, '版を1つ足すごとに変更の記録が1行');
  await rejects(planning.addContractVersion(db, 1, id, version({previousVersionNo: 1}), {createdBy: ADMIN}), 'raise', /stale contract production version/);
  await rejects(insertVersion(db, id, {versionNo: 5}), 'raise', /stale contract production version/);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM contract_production_milestones WHERE org_id=1 AND project_id=?', [id])).n), 5);
  assert.equal(await auditRows(), 2, '断った書き込みは記録を残さない');
  // 版と節目は書き換えも削除もできない（アプリを通さない書き込みでも）
  await rejects(raw(db, 'UPDATE contract_production_versions SET markup_bps=1500 WHERE org_id=1 AND project_id=?', [id]), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM contract_production_versions WHERE org_id=1 AND project_id=?', [id]), 'raise', /append-only/);
  await rejects(raw(db, 'UPDATE contract_production_milestones SET share_bps=1 WHERE org_id=1 AND project_id=?', [id]), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM contract_production_milestones WHERE org_id=1 AND project_id=?', [id]), 'raise', /append-only/);
  // 型が受託制作でない案件（買付）と型の無い既存の案件（PRJ-DEMO）には足せない。別の組織の案件は外部キーで断る
  const acquisition = await createProject(db, {code: 'FICT-ACQ-1', title: '架空の買付', projectType: 'acquisition', earningType: 'acquisition'});
  await rejects(planning.addContractVersion(db, 1, acquisition, version(), {createdBy: ADMIN}), 'raise', /needs a contract production project/);
  await rejects(planning.addContractVersion(db, 1, 1, version(), {createdBy: ADMIN}), 'raise', /needs a contract production project/);
  // 版の番号と案件の型の両方に当たる書き込みは、前の決まり（版の番号）の文で断る（D1 と PostgreSQL で同じ文）
  await rejects(insertVersion(db, acquisition, {versionNo: 3}), 'raise', /stale contract production version/);
  const otherOrgProject = Number((await db.get("SELECT id FROM projects WHERE org_id=2 AND code='PRJ-OTHER'")).id);
  await rejects(planning.addContractVersion(db, 1, otherOrgProject, version(), {createdBy: ADMIN}), 'foreign_key');
  // 別の組織からは読めない（store が org_id で絞る）
  assert.deepEqual(await planning.readContractVersions(db, 2, id), {versions: [], milestones: []});
  assert.deepEqual(await planning.readLatestContractVersions(db, 2, [id]), []);
});

test('FR-REV-CWORK-035 受託費が総製作費×受託費率の truncate と違う版と、範囲の外の受託費率・総製作費は、アプリを通さない書き込みでも DB が断る', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db);
  await rejects(insertVersion(db, id, {budget: 48271903, markup: 1000, fee: 4827191}), 'check'); // 1円多い
  await rejects(insertVersion(db, id, {budget: 48271903, markup: 1000, fee: 4827189}), 'check'); // 1円少ない
  await rejects(insertVersion(db, id, {budget: 1000000, markup: 999, fee: 99900}), 'check');
  await rejects(insertVersion(db, id, {budget: 1000000, markup: 1501, fee: 150100}), 'check');
  await rejects(insertVersion(db, id, {budget: 0, markup: 1000, fee: 0}), 'check');
  await rejects(insertVersion(db, id, {budget: 1000000000001, markup: 1000, fee: 100000000000}), 'check');
  await rejects(insertVersion(db, id, {budget: 1000000.5, markup: 1000, fee: 100000}), 'check');
  await rejects(insertVersion(db, id, {count: 0}), 'check');
  await rejects(insertVersion(db, id, {count: 61}), 'check');
  // 受託費率を書かなければ既定の 1000（10%）で、受託費はその額でなければ断る
  await rejects(raw(db, 'INSERT INTO contract_production_versions(org_id,project_id,version_no,budget_yen,fee_yen,milestone_count,created_by) VALUES(1,?,1,1000000,150000,1,1)', [id]), 'check');
  await raw(db, 'INSERT INTO contract_production_versions(org_id,project_id,version_no,budget_yen,fee_yen,milestone_count,created_by) VALUES(1,?,1,1000000,100000,1,1)', [id]);
  assert.equal(Number((await db.get('SELECT markup_bps FROM contract_production_versions WHERE org_id=1 AND project_id=?', [id])).markup_bps), 1000);
  // 境界のちょうど（1500・1兆円）は通る
  await insertVersion(db, id, {versionNo: 2, budget: 1000000000000, markup: 1500, fee: 150000000000, count: 1});
});

test('FR-REV-CWORK-035 節目は月初の日の順に入り、行の数を超えず、最後の行で割合の和がちょうど 10000 になる（アプリを通さない書き込みでも）', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db);
  await insertVersion(db, id, {count: 2});
  await rejects(insertMilestone(db, id, {seq: 2, dueOn: '2026-05-01', share: 5000}), 'raise', /out of order/);
  await rejects(insertMilestone(db, id, {seq: 1, dueOn: '2026-05-15', share: 5000}), 'check');
  await rejects(insertMilestone(db, id, {seq: 1, dueOn: '2026-13-01', share: 5000}), 'check');
  await rejects(insertMilestone(db, id, {seq: 1, dueOn: '2026-05-01', share: 0}), 'check');
  await rejects(insertMilestone(db, id, {seq: 1, dueOn: '2026-05-01', share: 10001}), 'raise', /shares must total/);
  await insertMilestone(db, id, {seq: 1, dueOn: '2026-05-01', share: 6000});
  await rejects(insertMilestone(db, id, {seq: 2, dueOn: '2026-05-01', share: 4000}), 'raise', /month goes back/); // 同じ月
  await rejects(insertMilestone(db, id, {seq: 2, dueOn: '2026-04-01', share: 4000}), 'raise', /month goes back/);
  await rejects(insertMilestone(db, id, {seq: 2, dueOn: '2026-06-01', share: 3999}), 'raise', /shares must total/); // 最後の行で和が 9999
  await rejects(insertMilestone(db, id, {seq: 2, dueOn: '2026-06-01', share: 4001}), 'raise', /shares must total/); // 和が 10001
  // 月の順と割合の両方に当たる書き込みは、前の決まり（月の順）の文で断る
  await rejects(insertMilestone(db, id, {seq: 2, dueOn: '2026-04-01', share: 3999}), 'raise', /month goes back/);
  await insertMilestone(db, id, {seq: 2, dueOn: '2026-06-01', share: 4000});
  await rejects(insertMilestone(db, id, {seq: 3, dueOn: '2026-07-01', share: 1}), 'raise', /beyond the count/);
  await rejects(insertMilestone(db, id, {versionNo: 9, seq: 1, dueOn: '2026-07-01', share: 10000}), 'foreign_key');
  const [latest] = await planning.readLatestContractVersions(db, 1, [id]);
  assert.deepEqual([Number(latest.recorded_milestones), Number(latest.share_total_bps)], [2, 10000]);
});

test('FR-REV-YOJITSU-044 制作受託の使う率は最新の契約の版の受託費率で、節目の欠けた版（アプリを通さない書き込み）は率を使わず理由を返す', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db);
  const rateOf = async () => {
    const inputs = await planning.readRevenueClassInputs(db, 1, [id]);
    return revenueClassBases(inputs).get(id).rate;
  };
  assert.deepEqual(await rateOf(), {bps: null, source: 'contract', status: null, versionNo: null, reason: 'contract_version_unregistered'});
  await planning.addContractVersion(db, 1, id, version(), {createdBy: ADMIN});
  assert.deepEqual(await rateOf(), {bps: 1000, source: 'contract', status: null, versionNo: 1, reason: null});
  await planning.addContractVersion(db, 1, id, version({previousVersionNo: 1, markupBps: 1350}), {createdBy: ADMIN});
  assert.deepEqual(await rateOf(), {bps: 1350, source: 'contract', status: null, versionNo: 2, reason: null}, '版を足すと新しい版の率');
  // 節目を3行と書いて1行しか入れていない第3版（アプリは1回の batch で書くので作らない形）
  await insertVersion(db, id, {versionNo: 3, budget: 1000000, markup: 1200, fee: 120000, count: 3});
  await insertMilestone(db, id, {versionNo: 3, seq: 1, dueOn: '2026-05-01', share: 5000});
  assert.deepEqual(await rateOf(), {bps: null, source: 'contract', status: null, versionNo: 3, reason: 'contract_version_incomplete'});
});

// 要件の対応表を写した期待値の作り方（実装を読まずに、fixture と表から独立に計算する）。
// 売上の数え方: 買付 MG つき＝入金×窓口手数料率（案件の値か既定）、買い切り＝入金そのもの（10000）、販売委託＝入金×手数料率、自社出資・製作委員会＝入金×売上率、
// 制作受託＝入金×最新の契約の版の受託費率（純額）。区分: MG つき→買付の手数料、買い切り・自社出資・製作委員会→自社作品の流通売上、販売委託→販売委託の手数料、制作受託→受託制作
function expectedFromTable(fixture) {
  const defaults = new Map(fixture.defaultRates.map((r) => [r.earningType, r.revenueRateBps]));
  const categories = new Map(fixture.categories.map((c) => [c.code, c]));
  const projects = new Map(fixture.projects.map((p) => [p.key, p]));
  const ruleOf = (p) => {
    if (!p.earningType) return null;
    if (p.earningType === 'acquisition') {
      const mg = p.works.some((w) => w.settlement?.contractType === 'mg');
      const buyout = !mg && p.works.some((w) => (w.purchaseYenByRevision?.at(-1) ?? null) !== null); // 作品の費用の最新の版に買付額
      if (mg) return {klass: 'acquisition_fee', rate: p.revenueRateBps ?? defaults.get('acquisition')};
      if (buyout) return {klass: 'own_distribution', rate: p.revenueRateBps ?? 10000};
      return null;
    }
    if (p.earningType === 'contract_work') {
      const last = p.contractVersions?.at(-1);
      return last ? {klass: 'contract_production', rate: last.markupBps ?? 1000} : null;
    }
    const klass = {consignment: 'consignment_fee', own_investment: 'own_distribution', committee: 'own_distribution'}[p.earningType];
    return {klass, rate: p.revenueRateBps ?? defaults.get(p.earningType)};
  };
  const byClass = {};
  const byEarningType = {};
  for (const line of fixture.lines) {
    const category = categories.get(line.category);
    const p = line.project === null ? null : projects.get(line.project);
    if (!category || category.direction !== 'in' || category.countsAsRevenue !== 1 || !p) continue;
    const rule = ruleOf(p);
    if (!rule) continue;
    const amount = BigInt(line.amountYen);
    const sign = amount < 0n ? -1n : 1n;
    const revenue = Number(sign * ((sign * amount) * BigInt(rule.rate) / 10000n)); // 0 の方へ切り捨て（truncate）
    byClass[rule.klass] = (byClass[rule.klass] ?? 0) + revenue;
    byEarningType[p.earningType] = (byEarningType[p.earningType] ?? 0) + revenue;
  }
  return {byClass, byEarningType};
}

test('FR-REV-YOJITSU-022 FR-REV-CWORK-036 架空の fixture で、4区分の合計が対応表で写した稼ぎ方別の合計と一致する', async (t) => {
  const db = await openTestDb({t});
  const fixture = loadRevenueClassFixture();
  const {projectIds, lines} = await seedRevenueClassFixture(db, {fixture});
  const inputs = await planning.readRevenueClassInputs(db, 1, [...projectIds.values()]);
  // 買付の契約の形の材料: MG の分配契約だけを数え（委託の契約は数えない）、買付額は作品の費用の最新の版だけを見る（前の版の額は数えない）
  const evidence = new Map(inputs.acquisitionEvidence.map((e) => [Number(e.project_id), [Number(e.mg_contracts), Number(e.purchase_works)]]));
  assert.deepEqual(['ACQ-MG', 'ACQ-BUY', 'ACQ-COMM', 'ACQ-VOID'].map((key) => [key, evidence.get(projectIds.get(key))]), [
    ['ACQ-MG', [1, 0]], ['ACQ-BUY', [0, 1]], ['ACQ-COMM', [0, 0]], ['ACQ-VOID', [0, 0]],
  ]);
  const bases = revenueClassBases(inputs);
  const summary = summarizeRevenueClasses(lines, {bases, categories: await planning.listCashflowCategories(db, 1), earningTypes: inputs.earningTypes});
  const expected = expectedFromTable(fixture);
  const pick = (rows) => Object.fromEntries(rows.filter((r) => r.revenueYen !== null).map((r) => [r.code, r.revenueYen]));
  assert.deepEqual(pick(summary.classes), expected.byClass);
  assert.deepEqual(pick(summary.earningTypes), expected.byEarningType);
  // 4区分の合計＝稼ぎ方別の合計（区分の決まらない行は無い）。4区分はどれも行がある
  const total = Object.values(expected.byEarningType).reduce((a, b) => a + b, 0);
  assert.equal(summary.totals.classesRevenueYen, total);
  assert.equal(summary.totals.earningTypesRevenueYen, total);
  assert.deepEqual(summary.unclassified, []);
  assert.ok(summary.classes.every((c) => c.lineCount > 0), '4区分のどれにも架空の入金がある');
  // 仮の置き場（買い切り・製作委員会）の行は印が付く
  assert.equal(summary.classes.find((c) => c.code === 'own_distribution').provisionalLineCount, 2);
  // 売上に入れない行（支援金・出金・契約の版の無い制作受託・受託開発・案件不明・区分マスタに無い区分）は理由ごとに残り、0 円で埋めない
  assert.deepEqual(summary.excluded.map((e) => [e.reason, e.lineCount, e.amountYen]).sort(), [
    ['category_unregistered', 1, 123457], ['contract_version_unregistered', 1, 3000007], ['no_earning_type', 1, 1500003],
    ['not_revenue', 1, 900001], ['outflow', 1, 8000009], ['unknown_project', 1, 654321],
  ]);
  // 受託費は最新の契約の版の値（総製作費 52,364,117 × 12.5% → 6,545,514）。制作受託の売上は入金×受託費率の純額で、受託費を超えない
  const cw = projectIds.get('CW');
  const [latest] = await planning.readLatestContractVersions(db, 1, [cw]);
  assert.deepEqual([Number(latest.version_no), Number(latest.fee_yen)], [2, 6545514]);
  assert.ok(summary.classes.find((c) => c.code === 'contract_production').revenueYen <= Number(latest.fee_yen));
});

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
  return {login, call};
}

test('FR-REV-CWORK-035 契約の版の受け口は財務の権限のある人だけが版を足して読め、制作担当・権限の無い案件・別の組織・受託制作でない案件には返さない', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db);
  const acquisition = await createProject(db, {code: 'FICT-ACQ-2', title: '架空の買付', projectType: 'acquisition', earningType: 'acquisition'});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const payload = {previousVersionNo: 0, budgetYen: 52364117, markupBps: 1250, milestones: [{dueOn: '2026-05-01', shareBps: 3333}, {dueOn: '2026-09-01', shareBps: 3334}, {dueOn: '2027-01-01', shareBps: 3333}]};
  const audits = () => db.all('SELECT user_id,action,entity_type,entity_id,detail_json FROM audit_log WHERE org_id=1 ORDER BY id');
  const auditBefore = (await audits()).length;
  const added = await call(admin, `/planning/projects/${id}/contract-versions`, {method: 'POST', payload});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body, {ok: true, projectId: id, versionNo: 1, budgetYen: 52364117, markupBps: 1250, feeYen: 6545514});
  // 版を足すと変更の記録（audit_log）が1行増える。組織・利用者・操作・対象と、版の番号・節目の数だけを残し、金額（総製作費・受託費率・受託費）は残さない
  const auditAfterAdd = await audits();
  assert.equal(auditAfterAdd.length, auditBefore + 1);
  const logged = auditAfterAdd.at(-1);
  assert.deepEqual([Number(logged.user_id), logged.action, logged.entity_type, logged.entity_id], [ADMIN, 'append', 'contract_production_version', `${id}:1`]);
  assert.deepEqual(JSON.parse(logged.detail_json), {projectId: id, versionNo: 1, milestoneCount: 3});
  assert.equal(/52364117|6545514|1250/.test(logged.detail_json), false, '記録に契約の金額を残さない');
  // 同じ版を見ていた別の画面からの書き込みは 409、入力の誤りは 400（項目つき）。どちらも記録を残さない
  const stale = await call(admin, `/planning/projects/${id}/contract-versions`, {method: 'POST', payload});
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /ほかの画面で契約の版が足されました/);
  const invalid = await call(admin, `/planning/projects/${id}/contract-versions`, {method: 'POST', payload: {...payload, previousVersionNo: 1, markupBps: 1600, milestones: [{dueOn: '2026-05-01', shareBps: 9999}]}});
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.details.map((e) => e.field), ['markupBps', 'milestones']);
  assert.equal((await audits()).length, auditBefore + 1);
  const read = await call(admin, `/planning/projects/${id}/contract-versions`);
  assert.equal(read.status, 200);
  assert.equal(read.body.latestVersionNo, 1);
  assert.deepEqual(read.body.versions.map((v) => [v.versionNo, v.budgetYen, v.markupBps, v.feeYen, v.complete]), [[1, 52364117, 1250, 6545514, true]]);
  // 節目ごとの制作費と受託費（和が総製作費・受託費）
  assert.deepEqual(read.body.versions[0].milestones.map((m) => [m.seq, m.dueOn, m.shareBps, m.budgetYen, m.feeYen]), [
    [1, '2026-05-01', 3333, 17452960, 2181620], [2, '2026-09-01', 3334, 17458197, 2182274], [3, '2027-01-01', 3333, 17452960, 2181620],
  ]);
  // 受託制作でない案件は 409、番号の読めない案件は 400
  assert.equal((await call(admin, `/planning/projects/${acquisition}/contract-versions`)).status, 409);
  assert.equal((await call(admin, '/planning/projects/abc/contract-versions')).status, 400);
  // 制作担当は、案件に編集の権限が付いていても読めも書けもしない（既存の案件の API が制作担当に budget_yen を返さないのと同じ線）。
  // 編集担当は案件の編集の権限があるときだけ
  const production = await login('production@openingnight.invalid');
  await raw(db, "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,3,'edit')", [id]);
  assert.equal((await call(production, `/planning/projects/${id}/contract-versions`)).status, 403);
  assert.equal((await call(production, `/planning/projects/${id}/contract-versions`, {method: 'POST', payload: {...payload, previousVersionNo: 1}})).status, 403);
  const editor = await login('editor@openingnight.invalid');
  assert.equal((await call(editor, `/planning/projects/${id}/contract-versions`)).status, 403);
  await raw(db, "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'production')", [id]);
  assert.equal((await call(editor, `/planning/projects/${id}/contract-versions`)).status, 403, '制作の権限だけでは財務の値を読めない');
  await raw(db, "UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=? AND user_id=2", [id]);
  const byEditor = await call(editor, `/planning/projects/${id}/contract-versions`, {method: 'POST', payload: {...payload, previousVersionNo: 1, markupBps: null}});
  assert.equal(byEditor.status, 201, JSON.stringify(byEditor.body));
  assert.deepEqual([byEditor.body.versionNo, byEditor.body.markupBps, byEditor.body.feeYen], [2, 1000, 5236411]);
  // 断った書き込み（制作担当・権限の無い編集担当）は記録を残さず、編集担当の版は編集担当の ID で残る
  const auditAfterEditor = await audits();
  assert.equal(auditAfterEditor.length, auditBefore + 2);
  assert.deepEqual([Number(auditAfterEditor.at(-1).user_id), auditAfterEditor.at(-1).entity_id, JSON.parse(auditAfterEditor.at(-1).detail_json)],
    [2, `${id}:2`, {projectId: id, versionNo: 2, milestoneCount: 3}]);
  // 別の組織の管理者には、この案件の有無も見せない（同じ 403）
  const outsider = await login('outsider@other.invalid');
  const hidden = await call(outsider, `/planning/projects/${id}/contract-versions`);
  assert.equal(hidden.status, 403);
  assert.equal(JSON.stringify(hidden.body).includes('52364117'), false);
});

test('FR-REV-YOJITSU-022 4区分の受け口は財務の権限のある案件ごとに導いた区分と使う率を返し、制作担当と別の組織には返さない', async (t) => {
  const db = await openTestDb({t});
  const {projectIds} = await seedRevenueClassFixture(db);
  const pre = await createProject(db, {code: 'FICT-ACQ-PRE', title: '架空の買付（契約前）', projectType: 'acquisition', earningType: 'acquisition'});
  const {login, call} = await appWithLogin(db);
  const admin = await call(await login('admin@openingnight.invalid'), '/revenue/revenue-classes');
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.classes.map((c) => c.code), ['own_distribution', 'acquisition_fee', 'consignment_fee', 'contract_production']);
  const byCode = new Map(admin.body.projects.map((p) => [p.code, p]));
  assert.deepEqual([...projectIds.keys()].map((key) => {
    const p = byCode.get(loadRevenueClassFixture().projects.find((x) => x.key === key).code);
    return [key, p.revenueClass, p.provisional, p.rate.bps, p.rate.reason];
  }), [
    ['ACQ-MG', 'acquisition_fee', false, 2250, null],
    ['ACQ-BUY', 'own_distribution', true, 10000, null],
    ['ACQ-COMM', null, false, 2250, null],
    ['ACQ-VOID', null, false, 2250, null],
    ['CONS', 'consignment_fee', false, 1650, null],
    ['OWN', 'own_distribution', false, 6500, null],
    ['COMM', 'own_distribution', true, 3300, null],
    ['CW', 'contract_production', false, 1250, null],
    ['CW-NOVER', 'contract_production', false, null, 'contract_version_unregistered'],
    ['SW', null, false, null, 'earning_type_unregistered'],
  ]);
  // 契約の分からない買付は区分を決めない（理由つき）: 契約前、MG でない分配契約（委託）だけ、作品の費用の最新の版で買付額が空（前の版にはある）。
  // 委託の契約を MG つきに数えたり、古い版の買付額で買い切りにしたりしない。型の無い既存の案件（PRJ-DEMO）は返さない
  const codeOf = (key) => loadRevenueClassFixture().projects.find((x) => x.key === key).code;
  for (const code of ['FICT-ACQ-PRE', codeOf('ACQ-COMM'), codeOf('ACQ-VOID')]) {
    assert.deepEqual([code, byCode.get(code).acquisitionTerms, byCode.get(code).revenueClass, byCode.get(code).classReason], [code, null, null, 'acquisition_terms_unknown']);
  }
  assert.equal(byCode.get('FICT-ACQ-PRE').projectId, pre);
  assert.equal(byCode.has('PRJ-DEMO'), false);
  // 制作担当は、案件に編集の権限が付いていても返さない
  await raw(db, "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,3,'edit')", [projectIds.get('CW')]);
  assert.equal((await call(await login('production@openingnight.invalid'), '/revenue/revenue-classes')).status, 403);
  // 編集担当は案件の編集の権限のある案件だけ（権限の無い案件と、制作の権限だけの案件は返さない）
  const editorCookie = await login('editor@openingnight.invalid');
  assert.deepEqual((await call(editorCookie, '/revenue/revenue-classes')).body.projects, []);
  await raw(db, "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'production')", [projectIds.get('CONS')]);
  await raw(db, "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'edit')", [projectIds.get('CW')]);
  assert.deepEqual((await call(editorCookie, '/revenue/revenue-classes')).body.projects.map((p) => [p.code, p.revenueClass, p.rate.bps]), [['FICT-10B-CW', 'contract_production', 1250]]);
  const outsider = await call(await login('outsider@other.invalid'), '/revenue/revenue-classes');
  assert.deepEqual(outsider.body.projects, []);
});

test('FR-REV-CWORK-035 PostgreSQL で同じ案件の版を同時に足し、後の側が主キーの一意の違反で落ちても、受け口は版の番号のトリガーと同じ 409 を返し、版を足さない', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db);
  const {proxy, state} = racingBatchDb(db, /INSERT INTO contract_production_versions/);
  const {login, call} = await appWithLogin(proxy);
  const admin = await login('admin@openingnight.invalid');
  // 割り込む書き込み: 受け口が入力を読んだあとに、ほかの画面が同じ案件の版1を store で先に足す。本物の PostgreSQL で同時に足すと、
  // 両方の版の番号のトリガーが通り、後の側が主キー（組織・案件・版の番号）の一意の違反（23505）で落ちる（SQLite・D1・PGlite では起きない）
  state.race = () => planning.addContractVersion(db, 1, id, version({contractReference: 'FICT/契約書/割り込んだ架空.pdf'}), {createdBy: ADMIN});
  state.error = pgUniqueViolation({table: 'contract_production_versions', constraint: 'contract_production_versions_pkey', columns: ['org_id', 'project_id', 'version_no'], values: [1, id, 1]});
  const res = await call(admin, `/planning/projects/${id}/contract-versions`, {method: 'POST',
    payload: {previousVersionNo: 0, budgetYen: 52364117, markupBps: 1250, milestones: [{dueOn: '2026-05-01', shareBps: 3000}, {dueOn: '2026-09-01', shareBps: 7000}]}});
  assert.equal(state.race, null, '割り込みが流れた');
  assert.deepEqual([res.status, res.body.error, res.body.dbError?.kind], [409, 'ほかの画面で契約の版が足されました。読み直してから入れてください', 'unique']);
  // 割り込んだ版だけが残る
  const {versions} = await planning.readContractVersions(db, 1, id);
  assert.deepEqual(versions.map((v) => [Number(v.version_no), v.contract_reference]), [[1, 'FICT/契約書/割り込んだ架空.pdf']]);
});
