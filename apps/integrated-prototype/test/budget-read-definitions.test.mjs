// 予算書の読み取りの定義（移行 0066・0067）を、DB の制約と取り込みの受け口（src/planning/budget/budget-routes.mjs）で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-035〜040 と、架空の予算書（test/fixtures/folder-budget/）から手で書いた。
// 架空のデータだけを使う（組織1・2と利用者・試作の案件1・2は試作の行。定義の版を足す受け口はまだ無いので、人が足した版は SQL で入れる）
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {BUDGET_READ_SEEDS} from '../src/planning/budget/budget-read-seeds.mjs';
import {addBudgetReadSeeds, addBudgetVersion} from '../src/planning/budget/budget-store.mjs';
import {buildBudgetXlsx, fictionalBudgetSheets, fictionalCodeDetailSheets} from './fixtures/folder-budget/build-budget-xlsx.mjs';

const DEMO_PROJECT = 1;
const SEED_MIGRATION = new URL('../migrations/0067_budget_read_seeds.sql', import.meta.url);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const rejects = (promise, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), 'raise', error.message);
  assert.match(error.message, message);
  return true;
});
const rejectsKind = (promise, kind) => assert.rejects(promise, (error) => { assert.equal(dbErrorKind(error), kind, error.message); return true; });

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
const importBudget = (call, cookie, sheets, projectId = DEMO_PROJECT) => call(cookie, `/planning/projects/${projectId}/budget/import`, {method: 'POST',
  payload: {fileName: '予算書_架空.xlsx', base64: Buffer.from(buildBudgetXlsx(sheets)).toString('base64')}});
const versionDetail = async (call, cookie, versionNo) => (await call(cookie, `/planning/projects/${DEMO_PROJECT}/budget?version=${versionNo}`)).body.version;

// 組織の定義の版と最後の判定（作った順）
const readRows = (db, orgId) => db.all(`SELECT p.id AS profile_id,p.name,p.source AS profile_source,p.created_by AS profile_by,v.id AS version_id,v.version_no,
    v.definition_json,v.definition_hash,v.source,v.created_by,
    (SELECT a.action FROM budget_read_approvals a WHERE a.org_id=v.org_id AND a.version_id=v.id ORDER BY a.seq DESC LIMIT 1) AS action,
    (SELECT a.source FROM budget_read_approvals a WHERE a.org_id=v.org_id AND a.version_id=v.id ORDER BY a.seq DESC LIMIT 1) AS action_source,
    (SELECT a.created_by FROM budget_read_approvals a WHERE a.org_id=v.org_id AND a.version_id=v.id ORDER BY a.seq DESC LIMIT 1) AS action_by
  FROM budget_read_profiles p JOIN budget_read_versions v ON v.org_id=p.org_id AND v.profile_id=p.id WHERE p.org_id=? ORDER BY p.id,v.version_no`, [orgId]);
const readVersionId = async (db, orgId, name, versionNo) => Number((await db.get(`SELECT v.id FROM budget_read_versions v JOIN budget_read_profiles p
  ON p.org_id=v.org_id AND p.id=v.profile_id WHERE v.org_id=? AND p.name=? AND v.version_no=?`, [orgId, name, versionNo])).id);
const BLOCKS = BUDGET_READ_SEEDS[0];
// 人（管理者 = 利用者1）が足した定義の版
async function addMemberVersion(db, orgId, profileName, versionNo, definition, userId = 1) {
  const json = JSON.stringify(definition);
  await db.run(`INSERT INTO budget_read_versions(org_id,profile_id,version_no,definition_json,definition_hash,source,reason,created_by)
    VALUES(?,(SELECT id FROM budget_read_profiles WHERE org_id=? AND name=?),?,?,?,'member','架空の版',?)`, [orgId, orgId, profileName, versionNo, json, sha256(json), userId]);
  return readVersionId(db, orgId, profileName, versionNo);
}
const decide = (db, orgId, versionId, seq, action, userId = 1) => db.run(`INSERT INTO budget_read_approvals(org_id,version_id,seq,action,source,reason,created_by)
  VALUES(?,?,?,?,'member','架空の判定',?)`, [orgId, versionId, seq, action, userId]);
const seedRows = () => BUDGET_READ_SEEDS.map((seed) => ({name: seed.name, reason: seed.reason, definitionJson: JSON.stringify(seed.definition),
  definitionHash: sha256(JSON.stringify(seed.definition))}));
// 確定の印の色を外した定義（同じ原本で「主演」の行の確定の印が変わるので、どの版で読んだかが結果から分かる）
const noFill = {...BLOCKS.definition, confirmedFills: []};

test('FR-PLAN-BUDGET-040 移行 0067 は既存の全組織に初期値の定義2件を、種と同じ JSON と指紋の版1・初期値の承認で入れ、何度当てても増えない', async (t) => {
  const db = await openTestDb({t});
  // 試験の土台は移行のあとに組織を入れるので、まだ定義は無い（あとから作った組織と同じ）
  assert.deepEqual(await readRows(db, 1), []);
  const statements = readFileSync(SEED_MIGRATION, 'utf8').split('\n').filter((line) => !line.startsWith('--')).join('\n').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 6);
  for (let round = 0; round < 2; round += 1) for (const sql of statements) await db.run(sql);
  for (const orgId of [1, 2]) {
    const rows = await readRows(db, orgId);
    assert.deepEqual(rows.map((r) => [r.name, Number(r.version_no), r.profile_source, r.profile_by, r.source, r.created_by, r.action, r.action_source, r.action_by]),
      BUDGET_READ_SEEDS.map((seed) => [seed.name, 1, 'seed', null, 'seed', null, 'approve', 'seed', null]), `組織${orgId}`);
    for (const [i, seed] of BUDGET_READ_SEEDS.entries()) {
      assert.equal(rows[i].definition_json, JSON.stringify(seed.definition), `組織${orgId} ${seed.name} の JSON は種と同じ`);
      assert.equal(rows[i].definition_hash, sha256(JSON.stringify(seed.definition)));
    }
  }
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM budget_read_approvals')).n), 4);
});

test('FR-PLAN-BUDGET-040 FR-PLAN-BUDGET-038 定義を持たない組織で初めて予算書を読むと種が初期値として入り（読めない原本でも入れて変更の記録に残す）、読めた定義の版が予算書の版に結び付く（2つの書式とも）', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  // 形違いの原本で 422 でも、種は先に入り、入れたことを組織と件数だけで記録する（定義の中身は残さない）
  const shape = await importBudget(call, admin, [{name: '一覧', cells: [{ref: 'A1', value: '作品'}, {ref: 'B1', value: '金額'}]}]);
  assert.equal(shape.status, 422);
  assert.equal(shape.body.details.reason, 'no_header');
  const seedAudit = await db.all("SELECT user_id,action,entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='budget_read_seed'");
  assert.deepEqual(seedAudit.map((r) => [Number(r.user_id), r.action, r.entity_id, JSON.parse(r.detail_json)]), [[1, 'append', '1', {orgId: 1, definitionCount: 2}]]);
  const blocks = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(blocks.status, 201, JSON.stringify(blocks.body));
  assert.deepEqual(blocks.body.readDefinition, {name: '科目・金額(税抜)の区画', versionNo: 1});
  const rows = await readRows(db, 1);
  assert.deepEqual(rows.map((r) => [r.name, Number(r.version_no), r.source, r.created_by, r.action, r.action_source]),
    [['科目・金額(税抜)の区画', 1, 'seed', null, 'approve', 'seed'], ['Code・Detail・Description', 1, 'seed', null, 'approve', 'seed']]);
  assert.equal(rows[1].definition_json, JSON.stringify(BUDGET_READ_SEEDS[1].definition));
  assert.equal(rows[0].definition_hash, sha256(JSON.stringify(BUDGET_READ_SEEDS[0].definition)));
  const codeDetail = await importBudget(call, admin, fictionalCodeDetailSheets({noUnknown: true}));
  assert.equal(codeDetail.status, 201, JSON.stringify(codeDetail.body));
  assert.deepEqual(codeDetail.body.readDefinition, {name: 'Code・Detail・Description', versionNo: 1});
  assert.equal(codeDetail.body.verdict, 'draft_ok');
  assert.deepEqual((await versionDetail(call, admin, 1)).readDefinition, {name: '科目・金額(税抜)の区画', versionNo: 1, definitionHash: rows[0].definition_hash});
  assert.deepEqual((await versionDetail(call, admin, 2)).readDefinition, {name: 'Code・Detail・Description', versionNo: 1, definitionHash: rows[1].definition_hash});
  // 2回目の取り込みでは種を入れ直さない（変更の記録も1行のまま）。画面で作った版は定義を持たない
  assert.equal((await readRows(db, 1)).length, 2);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE org_id=1 AND entity_type='budget_read_seed'")).n), 1);
  const screen = await call(admin, `/planning/projects/${DEMO_PROJECT}/budget/versions`, {method: 'POST', payload: {reason: '架空', lines: [{categoryCode: 'A', name: '脚本料', amountExTaxYen: 1000}]}});
  assert.equal(screen.status, 201);
  assert.equal((await versionDetail(call, admin, 3)).readDefinition, null);
  assert.deepEqual((await db.all('SELECT v.version_no,r.read_version_id FROM budget_version_reads r JOIN budget_versions v ON v.org_id=r.org_id AND v.id=r.version_id WHERE r.org_id=1 ORDER BY v.version_no'))
    .map((r) => [Number(r.version_no), Number(r.read_version_id)]), [[1, Number(rows[0].version_id)], [2, Number(rows[1].version_id)]]);
});

test('FR-PLAN-BUDGET-037 判定の無い版と差し戻した版は取り込みに使わず、承認した最新の版で読み、使用中の版が無くなれば読まずに断る', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  await addBudgetReadSeeds(db, 1, seedRows(), {createdBy: 1});
  // 版2（確定の印の色を外した版）を足しただけでは使わない
  const v2 = await addMemberVersion(db, 1, BLOCKS.name, 2, noFill);
  const first = await importBudget(call, admin, fictionalBudgetSheets());
  assert.deepEqual(first.body.readDefinition, {name: BLOCKS.name, versionNo: 1});
  assert.equal((await versionDetail(call, admin, 1)).lines.find((l) => l.name === '主演').confirmedSource, 'fill');
  // 承認すると版2で読む
  await decide(db, 1, v2, 1, 'approve');
  const second = await importBudget(call, admin, fictionalBudgetSheets());
  assert.deepEqual(second.body.readDefinition, {name: BLOCKS.name, versionNo: 2});
  assert.equal((await versionDetail(call, admin, 2)).lines.find((l) => l.name === '主演').confirmedSource, 'none');
  // 版2を差し戻すと、承認したままの版1に戻る。版3（判定なし）は使わない
  await decide(db, 1, v2, 2, 'reject');
  await addMemberVersion(db, 1, BLOCKS.name, 3, noFill);
  const third = await importBudget(call, admin, fictionalBudgetSheets());
  assert.deepEqual(third.body.readDefinition, {name: BLOCKS.name, versionNo: 1});
  // 版1も差し戻すと、この書式を読める使用中の版が無い（Code・Detail・Description の定義では見出しが見つからない）
  await decide(db, 1, await readVersionId(db, 1, BLOCKS.name, 1), 2, 'reject');
  const shape = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(shape.status, 422);
  assert.equal(shape.body.details.reason, 'no_header');
  await decide(db, 1, await readVersionId(db, 1, 'Code・Detail・Description', 1), 2, 'reject');
  const none = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(none.status, 422);
  assert.equal(none.body.details.reason, 'no_definition');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM budget_versions WHERE org_id=1 AND project_id=1')).n), 3);
});

test('FR-PLAN-BUDGET-037 FR-PLAN-BUDGET-038 別の組織の承認した版は使わず、別の組織の定義の版も承認していない版も予算書の版に結び付けられない（DB が断る）', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  // 組織2（別の組織。利用者4が管理者）に、色を外した版2を承認して入れる
  await addBudgetReadSeeds(db, 2, seedRows(), {createdBy: 4});
  const otherV2 = await addMemberVersion(db, 2, BLOCKS.name, 2, noFill, 4);
  await decide(db, 2, otherV2, 1, 'approve', 4);
  const imported = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.readDefinition, {name: BLOCKS.name, versionNo: 1});
  assert.equal((await versionDetail(call, admin, 1)).lines.find((l) => l.name === '主演').confirmedSource, 'fill');
  assert.equal((await readRows(db, 1)).every((r) => r.source === 'seed'), true);
  // 画面で作った版に、受け口を通さずに定義の版を結び付けようとする
  assert.equal((await call(admin, `/planning/projects/${DEMO_PROJECT}/budget/versions`, {method: 'POST', payload: {reason: '架空', lines: []}})).status, 201);
  const budgetVersion = Number((await db.get('SELECT id FROM budget_versions WHERE org_id=1 AND project_id=1 AND version_no=2')).id);
  const bind = (readId) => db.run('INSERT INTO budget_version_reads(org_id,project_id,version_id,read_version_id) VALUES(1,1,?,?)', [budgetVersion, readId]);
  await rejects(bind(otherV2), /budget read version not approved/); // 組織1から見て、組織2の版には組織1の判定が無い
  await rejectsKind(db.run('INSERT INTO budget_read_approvals(org_id,version_id,seq,action,source,reason,created_by) VALUES(1,?,1,\'approve\',\'member\',\'架空\',1)', [otherV2]), 'foreign_key');
  const pending = await addMemberVersion(db, 1, BLOCKS.name, 2, noFill);
  await rejects(bind(pending), /budget read version not approved/);
  await decide(db, 1, pending, 1, 'reject');
  await rejects(bind(pending), /budget read version not approved/);
  await bind(await readVersionId(db, 1, BLOCKS.name, 1));
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM budget_version_reads WHERE org_id=1')).n), 2);
});

test('FR-PLAN-BUDGET-035 FR-PLAN-BUDGET-039 定義・版・判定・結び付きは追加だけで、変更・削除・番号の飛び・入れ直し・初期値の印のなりすまし（人の定義への初期値の版を含む）・形の外れた中身を DB が断る', async (t) => {
  const db = await openTestDb({t});
  await addBudgetReadSeeds(db, 1, seedRows(), {createdBy: 1});
  const v1 = await readVersionId(db, 1, BLOCKS.name, 1);
  const json = JSON.stringify(noFill);
  const insertVersion = (versionNo, overrides = {}) => {
    const row = {definition: json, hash: sha256(json), source: 'member', by: 1, ...overrides};
    return db.run(`INSERT INTO budget_read_versions(org_id,profile_id,version_no,definition_json,definition_hash,source,reason,created_by)
      VALUES(1,(SELECT id FROM budget_read_profiles WHERE org_id=1 AND name=?),?,?,?,?,'架空',?)`, [BLOCKS.name, versionNo, row.definition, row.hash, row.source, row.by]);
  };
  await rejects(insertVersion(3), /stale budget read version/); // 版2を飛ばす
  await rejects(insertVersion(1), /stale budget read version/); // 同じ番号の入れ直し
  await rejectsKind(insertVersion(2, {definition: '{"kind":"expense"}'}), 'check');
  await rejectsKind(insertVersion(2, {definition: '[1,2]'}), 'check');
  await rejectsKind(insertVersion(2, {hash: 'ABC'}), 'check');
  await rejectsKind(insertVersion(2, {source: 'seed'}), 'check'); // 初期値の印は作った人を持たない
  await rejectsKind(insertVersion(2, {by: null}), 'check'); // 人の版は作った人を持つ
  await insertVersion(2);
  const v2 = await readVersionId(db, 1, BLOCKS.name, 2);
  // 判定: 連番・初期値の承認は初期値の版にだけ・差し戻しの初期値は無い
  await rejects(decide(db, 1, v2, 2, 'approve'), /stale budget read approval/);
  await rejects(decide(db, 1, v1, 1, 'reject'), /stale budget read approval/); // 版1には初期値の承認（seq 1）がある
  await rejects(db.run("INSERT INTO budget_read_approvals(org_id,version_id,seq,action,source,reason) VALUES(1,?,1,'approve','seed','架空')", [v2]), /seed approval only for seed version/);
  await rejectsKind(db.run("INSERT INTO budget_read_approvals(org_id,version_id,seq,action,source,reason) VALUES(1,?,2,'reject','seed','架空')", [v1]), 'check');
  await rejectsKind(decide(db, 1, v2, 1, 'hold'), 'check');
  await decide(db, 1, v2, 1, 'approve');
  // 書き換え・削除はどの表も断る
  for (const sql of ["UPDATE budget_read_profiles SET name='架空の改名' WHERE org_id=1", 'DELETE FROM budget_read_profiles WHERE org_id=1',
    "UPDATE budget_read_versions SET reason='架空の書き換え' WHERE org_id=1", 'DELETE FROM budget_read_versions WHERE org_id=1',
    "UPDATE budget_read_approvals SET action='reject' WHERE org_id=1", 'DELETE FROM budget_read_approvals WHERE org_id=1']) {
    await rejects(db.run(sql), /budget read record immutable/);
  }
  await rejectsKind(db.run("INSERT INTO budget_read_profiles(org_id,name,source,created_by) VALUES(1,?,'member',1)", [BLOCKS.name]), 'unique');
  // 初期値の版（source='seed'）は、人が足した定義には足せない（初期値の承認を付けて人の承認を飛ばす道を塞ぐ）
  await db.run("INSERT INTO budget_read_profiles(org_id,name,source,created_by) VALUES(1,'架空の人の定義','member',1)");
  await rejects(db.run(`INSERT INTO budget_read_versions(org_id,profile_id,version_no,definition_json,definition_hash,source,reason)
    VALUES(1,(SELECT id FROM budget_read_profiles WHERE org_id=1 AND name='架空の人の定義'),1,?,?,'seed','架空')`, [json, sha256(json)]), /seed version only for seed profile/);
  await db.run(`INSERT INTO budget_read_versions(org_id,profile_id,version_no,definition_json,definition_hash,source,reason,created_by)
    VALUES(1,(SELECT id FROM budget_read_profiles WHERE org_id=1 AND name='架空の人の定義'),1,?,?,'member','架空',1)`, [json, sha256(json)]);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  assert.equal((await importBudget(call, admin, fictionalBudgetSheets())).status, 201);
  for (const sql of ['UPDATE budget_version_reads SET read_version_id=read_version_id WHERE org_id=1', 'DELETE FROM budget_version_reads WHERE org_id=1']) {
    await rejects(db.run(sql), /budget record immutable/);
  }
  assert.deepEqual((await readRows(db, 1)).map((r) => [Number(r.version_no), r.action]), [[1, 'approve'], [2, 'approve'], [1, 'approve'], [1, null]]);
});

test('FR-PLAN-BUDGET-042 使用中の版が検査を通らない定義は飛ばして残りの定義で読み、飛ばした定義の名前と版を応答の警告と変更の記録に残す。読める定義が無ければ 422', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  await addBudgetReadSeeds(db, 1, seedRows(), {createdBy: 1});
  // 区画の定義の版2（DB の形の検査は通るが、読み方が決まった名前に無い）を承認して使用中にする
  const broken = {...BLOCKS.definition, read: {layout: 'any_grid', subtotal: 'marker_row', category: 'letter_prefix_then_order'}};
  await decide(db, 1, await addMemberVersion(db, 1, BLOCKS.name, 2, broken), 1, 'approve');
  // 区画の原本は、残りの Code・Detail・Description の定義では読めない（形違い）。飛ばした定義を応答に出す
  const shape = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(shape.status, 422);
  assert.equal(shape.body.details.reason, 'no_header');
  assert.deepEqual(shape.body.details.skippedDefinitions.map(({name, versionNo}) => [name, versionNo]), [[BLOCKS.name, 2]]);
  assert.match(shape.body.details.skippedDefinitions[0].errors.join(), /read\.layout「any_grid」/);
  // Code・Detail・Description の原本は読めて、警告と変更の記録に飛ばした定義（名前・版）が残る
  const imported = await importBudget(call, admin, fictionalCodeDetailSheets({noUnknown: true}));
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.readDefinition, {name: 'Code・Detail・Description', versionNo: 1});
  assert.deepEqual(imported.body.warnings.map(({kind, name, versionNo}) => [kind, name, versionNo]), [['skipped_definition', BLOCKS.name, 2]]);
  const audit = await db.get("SELECT detail_json FROM audit_log WHERE org_id=1 AND entity_type='budget_version' AND entity_id='1:1'");
  const brokenId = await readVersionId(db, 1, BLOCKS.name, 2);
  assert.deepEqual(JSON.parse(audit.detail_json).skippedDefinitions, [{name: BLOCKS.name, versionNo: 2, readVersionId: brokenId}]);
  assert.equal(audit.detail_json.includes('any_grid'), false, '定義の中身は記録に残さない');
  // もう1つの定義も壊れると、読める定義が無いので 422（版は増えない）
  await decide(db, 1, await addMemberVersion(db, 1, 'Code・Detail・Description', 2, {...BUDGET_READ_SEEDS[1].definition, categories: [{to: 'L', words: ['雑費']}]}), 1, 'approve');
  const none = await importBudget(call, admin, fictionalCodeDetailSheets({noUnknown: true}));
  assert.equal(none.status, 422);
  assert.match(none.body.error, /読み取りの定義が正しくありません/);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM budget_versions WHERE org_id=1 AND project_id=1')).n), 1);
});

test('FR-PLAN-BUDGET-038 読んだあと保存の前に、読んだ定義の版が差し戻されたら、版を足さずに 409 で読み直しを求める', async (t) => {
  const db = await openTestDb({t});
  await addBudgetReadSeeds(db, 1, seedRows(), {createdBy: 1});
  const v1 = await readVersionId(db, 1, BLOCKS.name, 1);
  // 予算書の版を書く batch（定義の版の結び付きを含む）の直前に、別の画面で版1が差し戻された場面を作る
  let fired = false;
  const racing = new Proxy(db, {get(target, prop) {
    if (prop === 'batch') {
      return async (statements, ...rest) => {
        if (!fired && statements.some((statement) => /INSERT INTO budget_version_reads/.test(statement.sql))) { fired = true; await decide(target, 1, v1, 2, 'reject'); }
        return target.batch(statements, ...rest);
      };
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const {login, call} = await appWithLogin(racing);
  const admin = await login('admin@openingnight.invalid');
  const stale = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(fired, true);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'ほかの画面で読み取りの定義が変わりました。もう一度置いてください');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM budget_versions WHERE org_id=1')).n), 0);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE org_id=1 AND entity_type='budget_version'")).n), 0);
});

test('FR-PLAN-BUDGET-014 FR-PLAN-BUDGET-043 合計の行の無い予算書は版になり、判定は例外なしのまま「総合計を読めなかった」を応答・1冊・一覧に出し、確定できる。画面で作った版と総合計を読めた版には出さない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const notice = {kind: 'total_unread', cell: null, label: '総合計を読めなかった'};
  const imported = await importBudget(call, admin, fictionalBudgetSheets({noTotals: true}));
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual([imported.body.verdict, imported.body.failed, imported.body.notices], ['draft_ok', 0, [notice]]);
  const v1 = await versionDetail(call, admin, 1);
  assert.deepEqual(v1.notices.filter((n) => n.kind === 'total_unread'), [notice]);
  assert.equal(v1.check.verdict, 'draft_ok');
  const listRow = async () => (await call(admin, '/planning/budgets')).body.budgets.find((row) => row.projectId === DEMO_PROJECT);
  assert.deepEqual((await listRow()).state, {state: 'needs_review', done: 0, total: 1, reason: '総合計を読めなかった', notice: true});
  assert.deepEqual((await call(admin, `/planning/projects/${DEMO_PROJECT}/budget`)).body.state.notice, true);
  // 確定は止めない
  const fixed = await call(admin, `/planning/projects/${DEMO_PROJECT}/budget/fixes`, {method: 'POST', payload: {action: 'fix', versionNo: 1, reason: '架空の確定'}});
  assert.equal(fixed.status, 201, JSON.stringify(fixed.body));
  assert.equal((await listRow()).state.state, 'done');
  // 画面で写した版（原本が無い）には知らせを出さない
  const copied = await call(admin, `/planning/projects/${DEMO_PROJECT}/budget/versions`, {method: 'POST', payload: {reason: '架空の写し', copyOf: 1,
    lines: v1.lines.map(({categoryCode, name, amountExTaxYen}) => ({categoryCode, name, amountExTaxYen}))}});
  assert.equal(copied.status, 201);
  assert.equal(copied.body.notices, undefined);
  assert.deepEqual((await versionDetail(call, admin, 2)).notices.filter((n) => n.kind === 'total_unread'), []);
  // 総合計を読めた原本には出さない（額の誤りは例外として出る）
  const withTotal = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(withTotal.status, 201);
  assert.equal(withTotal.body.notices, undefined);
  assert.deepEqual((await versionDetail(call, admin, 3)).notices.filter((n) => n.kind === 'total_unread'), []);
});

test('FR-PLAN-BUDGET-043 FR-PLAN-BUDGET-041 合計の行き先がどの行にも当たらない定義で、総合計の行のある原本を読んでも、照合を黙って飛ばさずに「総合計を読めなかった」を出す', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  await addBudgetReadSeeds(db, 1, seedRows(), {createdBy: 1});
  const blind = {...BLOCKS.definition, totals: [{to: 'total', equals: ['架空のどこにも無い総合計']}, {to: 'managementFee', equals: ['架空のどこにも無い管理費']}]};
  await decide(db, 1, await addMemberVersion(db, 1, BLOCKS.name, 2, blind), 1, 'approve');
  const imported = await importBudget(call, admin, fictionalBudgetSheets());
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.readDefinition, {name: BLOCKS.name, versionNo: 2});
  assert.deepEqual(imported.body.notices, [{kind: 'total_unread', cell: null, label: '総合計を読めなかった'}]);
  assert.deepEqual((await versionDetail(call, admin, 1)).notices.filter((n) => n.kind === 'total_unread').length, 1);
  // 当たらなかった合計の行（直接制作費・制作管理費・小計・予備費・総合計）は区分の無い行の例外になり、見出しの上の見積り・消費税・税込も明細と合わない。
  // 一覧の進み具合は例外のほうを出す
  const v1 = await versionDetail(call, admin, 1);
  assert.deepEqual(v1.check.checks.filter((c) => c.ok === false).map((c) => c.key), ['estimate', 'tax', 'total_inc_tax', 'uncategorized']);
  assert.deepEqual(v1.check.checks.find((c) => c.key === 'uncategorized').cells, ['J26', 'J27', 'J28', 'J29', 'J30']);
  assert.deepEqual((await call(admin, '/planning/budgets')).body.budgets.find((row) => row.projectId === DEMO_PROJECT).state,
    {state: 'needs_review', done: 0, total: 1, reason: '例外 4'});
});

test('FR-PLAN-BUDGET-043 総合計の照合を持たない過去の形の検査の回を読んでも、1冊と一覧は落ちずに知らせを出さない', async (t) => {
  const db = await openTestDb({t});
  // 受け口を通さず、過去の形（総合計の照合の無い検査の JSON）の xlsx の版を入れる
  await addBudgetVersion(db, 1, DEMO_PROJECT, {versionNo: 1, sourceKind: 'file', sourceFileName: '架空.xlsx', taxRateBps: 1000, managementFeeYen: 0, contingencyYen: 0,
    reason: '架空の過去の版', lines: [{categoryCode: 'A', lineNo: 1, name: '脚本料', amountExTaxYen: 1000, confirmedSource: 'none'}],
    check: {verdict: 'draft_ok', passed: 1, failed: 0, checks: [{key: 'uncategorized', ok: true, label: '区分の無い行', count: 0, cells: []}]}}, {createdBy: 1});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const detail = await call(admin, `/planning/projects/${DEMO_PROJECT}/budget`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.version.notices, []);
  assert.deepEqual(detail.body.state, {state: 'in_progress', done: 0, total: 1, reason: '下書き rev1'});
  const list = await call(admin, '/planning/budgets');
  assert.equal(list.status, 200);
  assert.equal(list.body.budgets.find((row) => row.projectId === DEMO_PROJECT).state.state, 'in_progress');
});
