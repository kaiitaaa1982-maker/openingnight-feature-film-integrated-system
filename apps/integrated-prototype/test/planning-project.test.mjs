// 案件の型・稼ぎ方・段階と確度・基準額・売上率・区分マスタ（フェーズ1の仕様書 #10、移行 0012）を、DB の制約と store で確かめる。
// 期待値は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md（YOJITSU）の対応表・FR と、contract-work.md（CWORK）の FR から持ってくる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う（組織1・2と利用者は試作の行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import {effectiveRevenueRate, rollUpStep} from '../src/planning/project/project-model.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const project = (overrides = {}) => ({
  code: 'FICT-P10-A', title: '架空の買付案件', projectType: 'acquisition', earningType: 'acquisition', baseAmountYen: 3141593, revenueRateBps: null,
  counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null, ...overrides,
});
const raw = (db, sql, params = []) => db.run(sql, params);

test('FR-REV-YOJITSU-018 FR-REV-YOJITSU-022 FR-REV-CWORK-014 稼ぎ方は参照表の5行で、案件の型との組・利益の源泉・基準額の中身・使う率が対応表どおり', async (t) => {
  const db = await openTestDb({t});
  const rows = await planning.listEarningTypes(db);
  assert.deepEqual(rows.map((r) => [r.code, r.label, r.project_type, Number(r.profit_source), r.base_amount_kind, r.rate_source]), [
    ['acquisition', '買付', 'acquisition', 4, 'rights_revenue', 'project'],
    ['consignment', '販売委託', 'agency', 5, 'rights_revenue', 'project'],
    ['own_investment', '自社出資', 'production', 2, 'rights_revenue', 'project'],
    ['committee', '製作委員会', 'production', 3, 'rights_revenue', 'project'],
    ['contract_work', '制作受託', 'contract_production', 1, 'production_cost', 'contract'],
  ]);
});

test('FR-REV-YOJITSU-018 FR-REV-CWORK-014 案件は作品なしで型と稼ぎ方を持って登録でき、型は6つだけ・稼ぎ方は型と対応表の組だけ', async (t) => {
  const db = await openTestDb({t});
  const id = await planning.createProject(db, 1, project(), {createdBy: ADMIN});
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM works WHERE org_id=1 AND project_id=?', [id])).n), 0, '作品は作らない');
  const [row] = await planning.readProjectClassifications(db, 1, [id]);
  assert.equal(row.project_type, 'acquisition');
  assert.equal(row.earning_type, 'acquisition');
  // 型は ontology の6つ（現場受託・製作・買付・受託配給・受託開発・受託制作）だけ。稼ぎ方の無い型は稼ぎ方なしで登録できる
  for (const [code, type] of [['FICT-T1', 'field_contract'], ['FICT-T2', 'sw_contract']]) {
    await raw(db, 'INSERT INTO projects(org_id,code,title,project_type) VALUES(1,?,?,?)', [code, '架空の案件', type]);
  }
  await rejects(raw(db, "INSERT INTO projects(org_id,code,title,project_type) VALUES(1,'FICT-T3','架空','distribution')"), 'check');
  // 組が対応表に無い・型が無い・稼ぎ方の無い型に稼ぎ方・参照表に無い稼ぎ方は、アプリを通さない書き込みでも断る
  const insert = (code, type, earning) => raw(db, 'INSERT INTO projects(org_id,code,title,project_type,earning_type) VALUES(1,?,?,?,?)', [code, '架空', type, earning]);
  await rejects(insert('FICT-M1', 'acquisition', 'consignment'), 'raise', /earning type does not match/);
  await rejects(insert('FICT-M2', null, 'acquisition'), 'raise', /earning type does not match/);
  await rejects(insert('FICT-M3', 'sw_contract', 'contract_work'), 'raise', /earning type does not match/);
  await rejects(insert('FICT-M4', 'field_contract', 'own_investment'), 'raise', /earning type does not match/);
  await rejects(insert('FICT-M5', 'production', 'crowdfunding'), 'raise', /earning type does not match/);
  // 2つの決まりに当たる書き込みは、前の決まり（稼ぎ方の組 → 売上率）の文で断る（D1 と PostgreSQL で同じ文）
  await rejects(raw(db, "INSERT INTO projects(org_id,code,title,project_type,earning_type,revenue_rate_bps) VALUES(1,'FICT-M6','架空','production','contract_work',1000)"), 'raise', /earning type does not match/);
  for (const [code, type, earning] of [['FICT-OK1', 'agency', 'consignment'], ['FICT-OK2', 'production', 'own_investment'], ['FICT-OK3', 'production', 'committee'], ['FICT-OK4', 'contract_production', 'contract_work']]) {
    await insert(code, type, earning);
  }
  // 稼ぎ方を対応表の外へ変えるのも断る（製作の型の中で自社出資⇔製作委員会は変えられる）
  await raw(db, "UPDATE projects SET earning_type='committee' WHERE org_id=1 AND code='FICT-OK2'");
  await rejects(raw(db, "UPDATE projects SET earning_type='acquisition' WHERE org_id=1 AND code='FICT-OK2'"), 'raise', /earning type does not match/);
});

test('FR-REV-CWORK-037 案件の型は登録のあと変えられず、型の無い既存の案件には1回だけ入れられる', async (t) => {
  const db = await openTestDb({t});
  // 試作の案件（PRJ-DEMO）は移行の前からある行で、型は NULL（未登録）
  assert.equal((await db.get("SELECT project_type FROM projects WHERE org_id=1 AND code='PRJ-DEMO'")).project_type, null);
  await raw(db, "UPDATE projects SET project_type='production' WHERE org_id=1 AND code='PRJ-DEMO'");
  await rejects(raw(db, "UPDATE projects SET project_type='acquisition' WHERE org_id=1 AND code='PRJ-DEMO'"), 'raise', /project type is fixed/);
  await rejects(raw(db, "UPDATE projects SET project_type=NULL WHERE org_id=1 AND code='PRJ-DEMO'"), 'raise', /project type is fixed/);
  // 作品のある案件（PRJ-DEMO）を受託開発へ変えるのは、型の決まりと作品の決まりの両方に当たる。前の決まり（型）の文で断る
  await rejects(raw(db, "UPDATE projects SET project_type='sw_contract' WHERE org_id=1 AND code='PRJ-DEMO'"), 'raise', /project type is fixed/);
  const id = await planning.createProject(db, 1, project(), {createdBy: ADMIN});
  await rejects(raw(db, "UPDATE projects SET project_type='agency' WHERE org_id=1 AND id=?", [id]), 'raise', /project type is fixed/);
  // 型を変えない書き換え（名前）はできる
  await raw(db, "UPDATE projects SET title='架空の買付案件（改題）' WHERE org_id=1 AND id=?", [id]);
});

test('FR-REV-CWORK-016 受託開発の型の案件には作品を作れず、作品のある案件を受託開発にできず、作品を受託開発の案件へ移せない', async (t) => {
  const db = await openTestDb({t});
  const sw = await planning.createProject(db, 1, project({code: 'FICT-SW', title: '架空の受託開発', projectType: 'sw_contract', earningType: null, baseAmountYen: null}), {createdBy: ADMIN});
  await rejects(raw(db, "INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,'FICT-SW-W','架空の作品')", [sw]), 'raise', /cannot have works/);
  // 試作の案件（PRJ-DEMO）には作品がある
  await rejects(raw(db, "UPDATE projects SET project_type='sw_contract' WHERE org_id=1 AND code='PRJ-DEMO'"), 'raise', /cannot have works/);
  const other = await planning.createProject(db, 1, project({code: 'FICT-PROD', title: '架空の製作', projectType: 'production', earningType: 'own_investment'}), {createdBy: ADMIN});
  await raw(db, "INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,'FICT-PROD-W','架空の作品')", [other]);
  await rejects(raw(db, "UPDATE works SET project_id=? WHERE org_id=1 AND code='FICT-PROD-W'", [sw]), 'raise', /cannot have works/);
});

test('FR-REV-YOJITSU-019 段階は10段階＋見送りの参照表で、確度は段階から導く（案件に確度の列を持たない）', async (t) => {
  const db = await openTestDb({t});
  const stages = await planning.listProjectStages(db);
  assert.deepEqual(stages.map((s) => [s.code, s.label, s.yomi === null ? null : Number(s.yomi), Number(s.probability_bps), Number(s.requires_reason)]), [
    ['declined', '見送り', null, 0, 1],
    ['memo', '企画メモ', 1, 1000, 0],
    ['met', '面談済み', 2, 2000, 0],
    ['exploring', '条件の探り', 3, 3000, 0],
    ['proposed', '提案済み', 4, 4000, 0],
    ['staff_agreed', '担当の合意', 5, 5000, 0],
    ['approver_agreed', '決裁者の合意', 6, 6000, 0],
    ['terms_agreed', '条件の合意', 7, 7000, 0],
    ['informal_offer', '内示', 8, 8000, 0],
    ['contract_drafting', '契約の調整', 9, 9000, 0],
    ['contracted', '契約済み', 10, 10000, 0],
  ]);
  // 段階と行動のステップの対応（面談済み↔面談・提案済み↔提案・契約済み↔契約）
  assert.deepEqual(stages.filter((s) => s.step_code).map((s) => [s.code, s.step_code]), [['met', 'meeting'], ['proposed', 'proposal'], ['contracted', 'contract']]);
  assert.ok(stages.every((s) => s.definition.length > 0), '段階ごとの定義（共通）を持つ');
  // 稼ぎ方ごとの意味は参照表の行として足せる
  await planning.addStageMeaning(db, {stageCode: 'contracted', earningType: 'own_investment', meaning: '架空の意味（資金の調達を始めた）'});
  assert.deepEqual((await planning.listStageMeanings(db)).map((m) => [m.stage_code, m.earning_type]), [['contracted', 'own_investment']]);

  const id = await planning.createProject(db, 1, project({stage: {code: 'proposed', enteredOn: '2026-04-01', evidence: '架空の言質', reason: null}}), {createdBy: ADMIN});
  const [row] = await planning.readProjectClassifications(db, 1, [id]);
  assert.equal(row.stage_code, 'proposed');
  assert.equal(Number(row.probability_bps), 4000);
  assert.ok(!('probability_bps' in (await db.get('SELECT * FROM projects WHERE org_id=1 AND id=?', [id]))), '確度は案件の列に無い');
  // 段階の無い案件は段階も確度も null（0 で埋めない）
  const bare = await planning.createProject(db, 1, project({code: 'FICT-P10-B'}), {createdBy: ADMIN});
  const [none] = await planning.readProjectClassifications(db, 1, [bare]);
  assert.equal(none.stage_code, null);
  assert.equal(none.probability_bps, null);
});

test('FR-REV-YOJITSU-019 段階の履歴は追記だけで、入った日・前後の段階・言質・見送りの理由を残し、案件の段階は最新の行から導く', async (t) => {
  const db = await openTestDb({t});
  const id = await planning.createProject(db, 1, project({stage: {code: 'memo', enteredOn: '2026-04-01', evidence: '架空の言質（やる意味がある）', reason: null}}), {createdBy: ADMIN});
  const step = (stageCode, previousStageCode, enteredOn, extra = {}) => planning.recordStageChange(db, 1, {projectId: id, stageCode, previousStageCode, enteredOn, evidence: null, reason: null, createdBy: ADMIN, ...extra});
  assert.deepEqual(await step('met', 'memo', '2026-05-01'), {seq: 2});
  // 古い画面からの書き込み（前の段階が最新と違う）と、日付の巻き戻しは断る
  await rejects(step('exploring', 'memo', '2026-05-02'), 'raise', /stale project stage/);
  await rejects(step('exploring', null, '2026-05-02'), 'raise', /stale project stage/);
  await rejects(step('exploring', 'met', '2026-04-30'), 'raise', /date goes back/);
  // 2つの決まりに当たる書き込みは、前の決まり（古い画面 → 日付 → 理由）の文で断る（D1 と PostgreSQL で同じ文）
  await rejects(step('exploring', 'memo', '2026-04-30'), 'raise', /stale project stage/);
  await rejects(step('declined', 'met', '2026-04-30'), 'raise', /date goes back/);
  // 同じ段階へは変えない
  await rejects(step('met', 'met', '2026-05-02'), 'check');
  // 見送りは理由が要る
  await rejects(step('declined', 'met', '2026-05-03'), 'raise', /needs a reason/);
  assert.deepEqual(await step('declined', 'met', '2026-05-03', {reason: '架空の理由（予算が合わない）'}), {seq: 3});
  const history = await planning.readStageHistory(db, 1, id);
  assert.deepEqual(history.map((e) => [Number(e.seq), e.stage_code, e.previous_stage_code, e.entered_on, e.evidence, e.reason]), [
    [1, 'memo', null, '2026-04-01', '架空の言質（やる意味がある）', null],
    [2, 'met', 'memo', '2026-05-01', null, null],
    [3, 'declined', 'met', '2026-05-03', null, '架空の理由（予算が合わない）'],
  ]);
  const [row] = await planning.readProjectClassifications(db, 1, [id]);
  assert.deepEqual([row.stage_code, Number(row.probability_bps), row.stage_entered_on], ['declined', 0, '2026-05-03']);
  // 見送りから戻すのも追記で残す
  assert.deepEqual(await step('exploring', 'declined', '2026-06-01'), {seq: 4});
  // 履歴は書き換えも削除もできない（アプリを通さない書き込みでも）
  await rejects(raw(db, "UPDATE project_stage_events SET evidence='書き換え' WHERE org_id=1 AND project_id=?", [id]), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM project_stage_events WHERE org_id=1 AND project_id=?', [id]), 'raise', /append-only/);
  // 別の組織からは、この案件の型・段階も履歴も読めない（store が org_id で絞る）
  assert.deepEqual(await planning.readProjectClassifications(db, 2, [id]), []);
  assert.deepEqual(await planning.readStageHistory(db, 2, id), []);
  // 別の組織の案件には書けない（組織と案件の組の外部キー）
  const otherOrgProject = (await db.get("SELECT id FROM projects WHERE org_id=2 AND code='PRJ-OTHER'")).id;
  await rejects(planning.recordStageChange(db, 1, {projectId: otherOrgProject, stageCode: 'memo', previousStageCode: null, enteredOn: '2026-04-01', evidence: null, reason: null, createdBy: ADMIN}), 'foreign_key');
});

test('FR-REV-YOJITSU-018 FR-REV-YOJITSU-019 稼ぎ方の組・利益の源泉・基準額の中身・率の出どころと、段階の確度・ステップ・理由の要否は、アプリを通さない書き込みでも変えられない', async (t) => {
  const db = await openTestDb({t});
  for (const sql of [
    "UPDATE earning_types SET project_type='agency' WHERE code='acquisition'",
    "UPDATE earning_types SET profit_source=9 WHERE code='acquisition'",
    "UPDATE earning_types SET base_amount_kind='production_cost' WHERE code='acquisition'",
    "UPDATE earning_types SET rate_source='contract' WHERE code='acquisition'",
  ]) await rejects(raw(db, sql), 'raise', /earning type kind is fixed/);
  for (const sql of [
    "UPDATE project_stages SET probability_bps=1500 WHERE code='memo'",
    "UPDATE project_stages SET step_code='meeting' WHERE code='memo'",
    "UPDATE project_stages SET requires_reason=0 WHERE code='declined'",
  ]) await rejects(raw(db, sql), 'raise', /project stage kind is fixed/);
  // 表示の名前と定義の文は直せる
  await raw(db, "UPDATE earning_types SET label='買付（架空の改名）' WHERE code='acquisition'");
  await raw(db, "UPDATE project_stages SET definition='架空の定義の文' WHERE code='memo'");
  assert.equal(Number((await planning.listProjectStages(db)).find((s) => s.code === 'memo').probability_bps), 1000);
});

test('FR-REV-YOJITSU-015 行動のステップは参照表の行（面談・提案・契約）で、細目の段は親の step を持つ行として足せて親へ畳む', async (t) => {
  const db = await openTestDb({t});
  assert.deepEqual((await planning.listActionSteps(db)).map((s) => [s.code, s.label, s.parent_code]), [['meeting', '面談', null], ['proposal', '提案', null], ['contract', '契約', null]]);
  // 細目は移行を足さずに行として足せる（CHECK で縛っていない）
  await planning.addActionStep(db, {code: 'fictional_pitch_memo', label: '架空の細目（企画メモ）', parentCode: 'meeting', sortOrder: 11});
  await planning.addActionStep(db, {code: 'fictional_quote', label: '架空の細目（見積）', parentCode: 'proposal', sortOrder: 21});
  const steps = await planning.listActionSteps(db);
  assert.equal(rollUpStep(steps, 'fictional_pitch_memo'), 'meeting');
  assert.equal(rollUpStep(steps, 'fictional_quote'), 'proposal');
  assert.equal(rollUpStep(steps, 'contract'), 'contract');
  assert.equal(rollUpStep(steps, 'unknown_step'), null);
  // 細目の下に細目は作れない（2段まで）。親の無いコードは外部キーで断る。コードと親は足したあと変えない
  await rejects(planning.addActionStep(db, {code: 'fictional_grandchild', label: '架空の孫', parentCode: 'fictional_quote', sortOrder: 22}), 'raise', /hang under a top step/);
  await rejects(planning.addActionStep(db, {code: 'fictional_orphan', label: '架空の迷子', parentCode: 'no_such_step', sortOrder: 23}), 'foreign_key');
  await rejects(raw(db, "UPDATE action_steps SET parent_code='contract' WHERE code='fictional_quote'"), 'raise', /fixed/);
  await rejects(raw(db, "INSERT INTO action_steps(code,label,parent_code,sort_order) VALUES('Bad Code','架空',NULL,9)"), 'check');
});

test('FR-REV-YOJITSU-020 案件は基準額・売上率・相手・キーパーソン・始めた日・企画フォルダ・メモを持ち、基準額の中身は稼ぎ方から決まる', async (t) => {
  const db = await openTestDb({t});
  const a = await planning.createProject(db, 1, project({revenueRateBps: 2345, counterpartyName: '架空の権利元', keyPerson: '架空の担当者', startedOn: '2026-04-01', planningFolder: 'FICT/企画/架空', note: '架空のメモ'}), {createdBy: ADMIN});
  const c = await planning.createProject(db, 1, project({code: 'FICT-CW', title: '架空の制作受託', projectType: 'contract_production', earningType: 'contract_work', baseAmountYen: 27182818}), {createdBy: ADMIN});
  const rows = await planning.readProjectClassifications(db, 1, [a, c]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const ra = byId.get(a);
  assert.deepEqual([Number(ra.base_amount_yen), Number(ra.revenue_rate_bps), ra.counterparty_name, ra.key_person, ra.started_on, ra.planning_folder, ra.note, ra.base_amount_kind],
    [3141593, 2345, '架空の権利元', '架空の担当者', '2026-04-01', 'FICT/企画/架空', '架空のメモ', 'rights_revenue']);
  assert.equal(byId.get(c).base_amount_kind, 'production_cost', '制作受託の基準額の中身は制作費（総製作費）');
  // 金額・率は整数（円・bp）で、範囲の外と小数は断る。日付は月日の範囲を見る
  const update = (sql, params) => raw(db, sql, params);
  await rejects(update('UPDATE projects SET base_amount_yen=? WHERE org_id=1 AND id=?', [-1, a]), 'check');
  await rejects(update('UPDATE projects SET base_amount_yen=? WHERE org_id=1 AND id=?', [1000.5, a]), 'check');
  await rejects(update('UPDATE projects SET revenue_rate_bps=? WHERE org_id=1 AND id=?', [10001, a]), 'check');
  await rejects(update('UPDATE projects SET revenue_rate_bps=? WHERE org_id=1 AND id=?', [1.5, a]), 'check');
  await rejects(update("UPDATE projects SET started_on='2026-13-01' WHERE org_id=1 AND id=?", [a]), 'check');
  await rejects(update("UPDATE projects SET started_on='２０２６-04-01' WHERE org_id=1 AND id=?", [a]), 'check');
  // 制作受託は案件の売上率を持たない（受託の契約の版の受託費率を使う。FR-REV-YOJITSU-044）。稼ぎ方の無い案件も持たない
  await rejects(update('UPDATE projects SET revenue_rate_bps=1000 WHERE org_id=1 AND id=?', [c]), 'raise', /revenue rate needs/);
  await rejects(raw(db, "INSERT INTO projects(org_id,code,title,project_type,revenue_rate_bps) VALUES(1,'FICT-NR','架空','sw_contract',1000)"), 'raise', /revenue rate needs/);
});

test('FR-REV-YOJITSU-020 売上率は案件の値、空なら稼ぎ方の既定（組織の最新の版・状態つき）、制作受託は受託の契約の版の率で既定を持たない', async (t) => {
  const db = await openTestDb({t});
  assert.deepEqual(await planning.readEffectiveRevenueRates(db, 1), [], '移行では既定の率を入れない（種か設定で足す）');
  assert.equal(await planning.addRevenueRateVersion(db, 1, {earningType: 'acquisition', revenueRateBps: 1234, status: 'provisional', basis: '架空の仮置き', createdBy: ADMIN}), 1);
  assert.equal(await planning.addRevenueRateVersion(db, 1, {earningType: 'acquisition', revenueRateBps: 2468, status: 'provisional', basis: '架空の仮置き（改め）', createdBy: ADMIN}), 2);
  assert.equal(await planning.addRevenueRateVersion(db, 2, {earningType: 'acquisition', revenueRateBps: 9999, status: 'confirmed', basis: null, createdBy: 4}), 1, '組織ごとに版を数える');
  const defaults = await planning.readEffectiveRevenueRates(db, 1);
  assert.deepEqual(defaults.map((r) => [r.earning_type, Number(r.version_no), Number(r.revenue_rate_bps), r.status]), [['acquisition', 2, 2468, 'provisional']]);
  const types = new Map((await planning.listEarningTypes(db)).map((e) => [e.code, e]));
  const rateOf = (row) => effectiveRevenueRate({project: row, earningType: types.get(row.earning_type), defaultRate: defaults.find((d) => d.earning_type === row.earning_type) ?? null});
  const own = await planning.createProject(db, 1, project({code: 'FICT-R1', revenueRateBps: 5000}), {createdBy: ADMIN});
  const dflt = await planning.createProject(db, 1, project({code: 'FICT-R2'}), {createdBy: ADMIN});
  const none = await planning.createProject(db, 1, project({code: 'FICT-R3', projectType: 'agency', earningType: 'consignment'}), {createdBy: ADMIN});
  const cw = await planning.createProject(db, 1, project({code: 'FICT-R4', projectType: 'contract_production', earningType: 'contract_work'}), {createdBy: ADMIN});
  const rows = new Map((await planning.readProjectClassifications(db, 1, [own, dflt, none, cw])).map((r) => [Number(r.id), r]));
  assert.deepEqual(rateOf(rows.get(own)), {bps: 5000, source: 'project', status: null, versionNo: null, reason: null});
  assert.deepEqual(rateOf(rows.get(dflt)), {bps: 2468, source: 'default', status: 'provisional', versionNo: 2, reason: null});
  assert.deepEqual(rateOf(rows.get(none)), {bps: null, source: 'default', status: null, versionNo: null, reason: 'default_unregistered'});
  // 受託の契約の版（移行 0013）がまだ無い制作受託の案件は null と理由（版のある場合は test/contract-production.test.mjs）
  assert.deepEqual(rateOf(rows.get(cw)), {bps: null, source: 'contract', status: null, versionNo: null, reason: 'contract_version_unregistered'});
  // 制作受託には既定の率を持たない。版は追記だけ（書き換え・削除・番号の飛ばしを断る）。状態は4つだけ
  await rejects(planning.addRevenueRateVersion(db, 1, {earningType: 'contract_work', revenueRateBps: 1000, status: 'confirmed', basis: null, createdBy: ADMIN}), 'raise', /contract rate/);
  await rejects(raw(db, 'UPDATE earning_type_rate_versions SET revenue_rate_bps=1 WHERE org_id=1'), 'raise', /immutable/);
  await rejects(raw(db, 'DELETE FROM earning_type_rate_versions WHERE org_id=1'), 'raise', /immutable/);
  await rejects(raw(db, "INSERT INTO earning_type_rate_versions(org_id,earning_type,version_no,revenue_rate_bps,status,created_by) VALUES(1,'acquisition',5,1000,'provisional',1)"), 'raise', /stale/);
  // 版の番号と率の出どころの両方に当たる書き込みは、前の決まり（版の番号）の文で断る
  await rejects(raw(db, "INSERT INTO earning_type_rate_versions(org_id,earning_type,version_no,revenue_rate_bps,status,created_by) VALUES(1,'contract_work',5,1000,'provisional',1)"), 'raise', /stale/);
  await rejects(planning.addRevenueRateVersion(db, 1, {earningType: 'committee', revenueRateBps: 1000, status: 'guess', basis: null, createdBy: ADMIN}), 'check');
});

test('FR-REV-YOJITSU-024 区分マスタは組織ごとに入金・出金と売上の元かを持ち、移行では行を入れず種かアプリで足す', async (t) => {
  const db = await openTestDb({t});
  assert.deepEqual(await planning.listCashflowCategories(db, 1), [], '移行では区分を入れない');
  // 入金4・出金5（要件の区分の表。コードは架空の種の形）
  const rows = [
    ['distribution_revenue', '流通売上', 'in', 1], ['consignment_revenue', '販売委託の売上', 'in', 1], ['contract_revenue', '受託収益', 'in', 1], ['crowdfunding_support', 'クラウドファンディングの支援金', 'in', 0],
    ['investment', '出資', 'out', 0], ['acquisition_payment', '買付', 'out', 0], ['production_actual', '制作の実費', 'out', 0], ['creator_share', '作り手・権利元への分配', 'out', 0], ['crowdfunding_cost', 'クラウドファンディングの費用', 'out', 0],
  ];
  for (const [i, [code, label, direction, countsAsRevenue]] of rows.entries()) await planning.addCashflowCategory(db, 1, {code, label, direction, countsAsRevenue, sortOrder: i + 1});
  const listed = await planning.listCashflowCategories(db, 1);
  assert.deepEqual(listed.map((r) => [r.code, r.label, r.direction, Number(r.counts_as_revenue)]), rows);
  assert.deepEqual(await planning.listCashflowCategories(db, 2), [], 'ほかの組織の区分は見えない');
  // 出金は売上の元にならない。入出金と売上の元は足したあと変えない（過去の符号が変わるため）
  await rejects(planning.addCashflowCategory(db, 1, {code: 'fictional_bad', label: '架空の出金', direction: 'out', countsAsRevenue: 1, sortOrder: 99}), 'check');
  await rejects(raw(db, "UPDATE cashflow_categories SET direction='out' WHERE org_id=1 AND code='distribution_revenue'"), 'raise', /fixed/);
  await rejects(raw(db, "UPDATE cashflow_categories SET counts_as_revenue=1 WHERE org_id=1 AND code='crowdfunding_support'"), 'raise', /fixed/);
  await rejects(planning.addCashflowCategory(db, 1, {code: 'distribution_revenue', label: '架空の重複', direction: 'in', countsAsRevenue: 1, sortOrder: 98}), 'unique');
  // 名前と並び順は直せる
  await raw(db, "UPDATE cashflow_categories SET label='流通売上（架空の改名）' WHERE org_id=1 AND code='distribution_revenue'");
});

test('既存の案件の API（bootstrap・/api/projects）は、移行0012で足した列を返さない（管理者にも、財務の権限の無い制作担当にも）', async (t) => {
  const db = await openTestDb({t});
  await planning.createProject(db, 1, project({revenueRateBps: 2345, counterpartyName: '架空の権利元', note: '架空のメモ'}), {createdBy: ADMIN});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const get = async (path, cookie) => (await app.request(`/api${path}`, {headers: {cookie}})).json();
  const base = ['id', 'org_id', 'code', 'title', 'status', 'budget_yen', 'version', 'created_at'];
  const admin = await login('admin@openingnight.invalid');
  for (const body of [await get('/bootstrap', admin), await get('/projects', admin)]) {
    const rows = body.projects ?? body.rows;
    assert.ok(rows.length >= 2);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), [...base].sort());
  }
  const production = await login('production@openingnight.invalid');
  for (const body of [await get('/bootstrap', production), await get('/projects', production)]) {
    const rows = body.projects ?? body.rows;
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), base.filter((k) => k !== 'budget_yen').sort());
  }
});
