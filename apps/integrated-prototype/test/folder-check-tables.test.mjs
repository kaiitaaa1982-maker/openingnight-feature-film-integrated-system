// 表3〜6（移行 0023。フォルダ型の画面 U2a 後半、香盤表 #5・#7）を、DB の制約とトリガーで確かめる。
// 期待値は docs/requirements/revenue/folder-entry.md の FR-REV-FOLDER-008（回ごとに残す。再検査は登録を変えない）・
// 009（検査の決まりの版と正解表は追加のみ。人の直しは代表か財務担当だけ。実在の原本は入れない）・
// 013（抜き取りの記録は追加のみ。結果は直し無し・型の誤り・原本の誤り）。
// 受け口と画面はまだ無い（U2b・U4・U5）ので、行を直接書いて確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {deriveFolderRecord} from '../src/revenue/folders/folders-record.mjs';
import {scoreStoredVersion, toRecordReview, toRecordRun} from '../src/revenue/folders/folders-cases.mjs';

const ADMIN = 1;
const FINANCE = 2;
const PRODUCTION = 3;
const OUTSIDER = 4;
const PARTNER_DIGITAL = 2;
const PARTNER_STORE = 3;
const sha = label => createHash('sha256').update(label).digest('hex');
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/folder-check-cases/cases.json', import.meta.url)), 'utf8'));
const digitalType = fixture.types.find(type => type.partnerName === '架空配信');

const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});

async function receiveFile(db, label, {orgId = 1, by = ADMIN} = {}) {
  const row = await db.get(`INSERT INTO sales_source_files(org_id,storage,file_name,media_type,byte_length,raw_sha256,original_base64,extraction_json,
    extractor_name,extractor_version,extraction_status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  [orgId, 'inline', `${label}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label.length, sha(label),
    Buffer.from(label).toString('base64'), JSON.stringify({sheets: []}), 'test', '1', 'extracted', by]);
  return Number(row.id);
}

async function addMapping(db, {orgId = 1, partnerId = PARTNER_DIGITAL, kind = 'digital', by = ADMIN, name = '架空の列対応'} = {}) {
  const profile = Number((await db.get(`INSERT INTO report_mapping_profiles(org_id,partner_id,kind,name,created_by) VALUES(?,?,?,?,?) RETURNING id`,
    [orgId, partnerId, kind, `${name} ${sha(name).slice(0, 8)}`, by])).id);
  return Number((await db.get(`INSERT INTO report_mapping_versions(org_id,profile_id,version_no,definition_json,definition_hash,created_by)
    VALUES(?,?,1,'{}',?,?) RETURNING id`, [orgId, profile, sha(`mapping-${profile}`), by])).id);
}

const VERSION_COLUMNS = ['org_id', 'partner_id', 'kind', 'version_no', 'mapping_version_id', 'checks_json', 'header_columns_json', 'skip_rules_json',
  'money_columns_json', 'split_by_product', 'reason', 'created_by'];
function addVersion(db, {orgId = 1, partnerId = PARTNER_DIGITAL, kind = 'digital', versionNo = 1, mappingId, checks = digitalType.checks,
  headers = digitalType.headerColumns, skipRules = [], money = digitalType.moneyColumns, split = 1, reason = '架空の検査の決まり', by = ADMIN} = {}) {
  return db.get(`INSERT INTO report_check_versions(${VERSION_COLUMNS.join(',')}) VALUES(${VERSION_COLUMNS.map(() => '?').join(',')}) RETURNING id`,
    [orgId, partnerId, kind, versionNo, mappingId, JSON.stringify(checks), JSON.stringify(headers), JSON.stringify(skipRules), JSON.stringify(money),
      split, reason, by]);
}

const CASE_COLUMNS = ['org_id', 'check_version_id', 'origin', 'fictional', 'input_json', 'expected_json', 'reason', 'created_by'];
function addCase(db, {orgId = 1, versionId, origin = 'normal', fictional = 1, input = digitalType.cases[0].input, expected = digitalType.cases[0].expected,
  reason = '架空の正解', by = ADMIN} = {}) {
  return db.run(`INSERT INTO report_check_cases(${CASE_COLUMNS.join(',')}) VALUES(${CASE_COLUMNS.map(() => '?').join(',')})`,
    [orgId, versionId, origin, fictional, JSON.stringify(input), JSON.stringify(expected), reason, by]);
}

const RUN_COLUMNS = ['org_id', 'file_id', 'check_version_id', 'run_no', 'checks_passed', 'checks_total', 'judgment', 'golden_matched', 'golden_total', 'created_at'];
function addRun(db, {orgId = 1, fileId, versionId, runNo = 1, passed = 14, total = 14, judgment = 'human_record', matched = 3, goldenTotal = 3,
  at = '2026-05-02 00:00:00'} = {}) {
  return db.get(`INSERT INTO source_check_runs(${RUN_COLUMNS.join(',')}) VALUES(${RUN_COLUMNS.map(() => '?').join(',')}) RETURNING id`,
    [orgId, fileId, versionId, runNo, passed, total, judgment, matched, goldenTotal, at]);
}

function addReview(db, {orgId = 1, runId, result = 'clean', reason = '直しは無かった', by = FINANCE, at = '2026-05-02 00:00:01'} = {}) {
  return db.run(`INSERT INTO source_sampling_reviews(org_id,check_run_id,result,reason,created_by,created_at) VALUES(?,?,?,?,?,?)`,
    [orgId, runId, result, reason, by, at]);
}

async function commitOne(db, fileId) {
  const selection = Number((await db.get(`INSERT INTO sales_source_selections(org_id,file_id,version_no,sheet_name,header_row,canonical_csv,canonical_sha256,
    source_rows_json,suggestion_source,created_by) VALUES(1,?,1,'Details',2,?,?,'[3]','rule-based',?) RETURNING id`,
  [fileId, '作品CD,正味売上\n', sha(`selection-${fileId}`), ADMIN])).id);
  const binding = Number((await db.get(`INSERT INTO sales_source_bindings(org_id,file_id,version_no,mode,project_id,work_id,reason,created_by)
    VALUES(1,?,1,'single_work',1,1,'1つの作品の報告',?) RETURNING id`, [fileId, ADMIN])).id);
  const partition = Number((await db.get(`INSERT INTO sales_source_partitions(org_id,file_id,selection_id,binding_id,plan_sha256,project_id,work_id,row_count,
    source_rows_json,partition_sha256,created_by) VALUES(1,?,?,?,?,1,1,1,'[3]',?,?) RETURNING id`,
  [fileId, selection, binding, sha(`plan-${fileId}`), sha(`partition-${fileId}`), ADMIN])).id);
  const mapping = await addMapping(db, {name: `登録済み ${fileId}`});
  const report = Number((await db.get(`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,
    content_hash,created_by) VALUES(1,1,?,'CHK','digital','2026-05-01','2026-05-31','2026-06','架空',?,?) RETURNING id`,
  [PARTNER_DIGITAL, sha(`report-${fileId}`), ADMIN])).id);
  await db.run(`INSERT INTO sales_source_commits(org_id,file_id,partition_id,binding_id,selection_id,work_id,mapping_version_id,report_id,preview_token,created_by)
    VALUES(1,?,?,?,?,1,?,?,?,?)`, [fileId, partition, binding, selection, mapping, report, `token-${fileId}`, ADMIN]);
  return {mapping, report};
}

test('FR-REV-FOLDER-009 検査の決まりの版は取引先×種類の連番で、別の種類の列対応を指せず、変更も削除もできない', async (t) => {
  const db = await openTestDb({t});
  const mapping = await addMapping(db);
  const storeMapping = await addMapping(db, {partnerId: PARTNER_STORE, kind: 'package', name: '架空ストア'});
  const first = Number((await addVersion(db, {mappingId: mapping})).id);
  await rejects(addVersion(db, {mappingId: mapping, versionNo: 3}), 'raise', /連番ではありません/);
  await rejects(addVersion(db, {mappingId: storeMapping, versionNo: 2}), 'raise', /同じ取引先と報告の種類/);
  const second = Number((await addVersion(db, {mappingId: mapping, versionNo: 2, reason: '検算を空にした', checks: []})).id);
  assert.deepEqual((await db.all('SELECT version_no,partner_id,kind FROM report_check_versions WHERE org_id=1 ORDER BY version_no'))
    .map(row => [Number(row.version_no), Number(row.partner_id), row.kind]), [[1, PARTNER_DIGITAL, 'digital'], [2, PARTNER_DIGITAL, 'digital']]);
  await rejects(db.run('UPDATE report_check_versions SET reason=? WHERE org_id=1 AND id=?', ['書き換えた', first]), 'raise', /変更できません/);
  await rejects(db.run('DELETE FROM report_check_versions WHERE org_id=1 AND id=?', [second]), 'raise', /削除できません/);
  await rejects(addVersion(db, {mappingId: mapping, kind: 'publicity', versionNo: 1, partnerId: PARTNER_DIGITAL}), 'raise', /同じ取引先と報告の種類/);
  await rejects(addVersion(db, {mappingId: mapping, versionNo: 3, headers: []}), 'check');
  await rejects(addVersion(db, {mappingId: mapping, versionNo: 3, money: {amountExTax: '税抜'}}), 'check');
  const otherMapping = await addMapping(db, {orgId: 2, partnerId: 4, kind: 'digital', by: OUTSIDER, name: '別組織'});
  await rejects(addVersion(db, {mappingId: otherMapping, versionNo: 3}), 'raise', /同じ取引先と報告の種類/);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM report_check_versions WHERE org_id=2')).n), 0);
});

test('FR-REV-FOLDER-009 正解表は追加のみで実在の印を持てず、人の直しは代表と財務担当だけが足せる', async (t) => {
  const db = await openTestDb({t});
  const mapping = await addMapping(db);
  const versionId = Number((await addVersion(db, {mappingId: mapping})).id);
  await addCase(db, {versionId, by: PRODUCTION, origin: 'normal'});
  await addCase(db, {versionId, by: PRODUCTION, origin: 'fractional', input: digitalType.cases[1].input});
  await addCase(db, {versionId, by: PRODUCTION, origin: 'excluded', input: digitalType.cases[2].input});
  await addCase(db, {versionId, by: ADMIN, origin: 'human_fix', reason: '代表が直した行を正解にした'});
  await addCase(db, {versionId, by: FINANCE, origin: 'human_fix', reason: '財務担当が直した行を正解にした'});
  await rejects(addCase(db, {versionId, by: PRODUCTION, origin: 'human_fix', reason: '制作担当の直し'}), 'raise', /代表か財務担当だけ/);
  const plain = Number((await db.get(`INSERT INTO users(email,display_name) VALUES('plain-editor@openingnight.invalid','財務の無い編集') RETURNING id`)).id);
  await db.run(`INSERT INTO memberships(org_id,user_id,role) VALUES(1,?,'editor')`, [plain]);
  await rejects(addCase(db, {versionId, by: plain, origin: 'human_fix', reason: '財務権限の無い編集'}), 'raise', /代表か財務担当だけ/);
  await db.run(`INSERT INTO project_memberships(org_id,project_id,user_id,permission,expires_at) VALUES(1,1,?,'edit','2000-01-01 00:00:00')`, [plain]);
  await rejects(addCase(db, {versionId, by: plain, origin: 'human_fix', reason: '期限の切れた財務'}), 'raise', /代表か財務担当だけ/);
  await rejects(addCase(db, {versionId, fictional: 0}), 'check');
  await rejects(addCase(db, {versionId, origin: 'real_file'}), 'check');
  await rejects(db.run('UPDATE report_check_cases SET reason=? WHERE org_id=1 AND check_version_id=?', ['書き換えた', versionId]), 'raise', /変更できません/);
  await rejects(db.run('DELETE FROM report_check_cases WHERE org_id=1 AND check_version_id=?', [versionId]), 'raise', /削除できません/);
  const stored = await db.all('SELECT origin,fictional,input_json,expected_json FROM report_check_cases WHERE org_id=1 AND check_version_id=? AND origin<>? ORDER BY id',
    [versionId, 'human_fix']);
  const version = await db.get('SELECT * FROM report_check_versions WHERE org_id=1 AND id=?', [versionId]);
  const score = scoreStoredVersion(version, stored);
  assert.deepEqual([score.matched, score.total, score.complete, score.label], [3, 3, true, '100%']);
  const empty = scoreStoredVersion(version, []);
  assert.equal(empty.complete, false);
  assert.equal(empty.label, '100%未満');
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM report_check_cases WHERE org_id=2')).n), 0);
});

test('FR-REV-FOLDER-008 検査の結果は回ごとに残り、登録済みの通に新しい回を足しても登録は変わらない', async (t) => {
  const db = await openTestDb({t});
  const fileId = await receiveFile(db, '登録済みの架空報告');
  const {mapping} = await commitOne(db, fileId);
  const versionId = Number((await addVersion(db, {mappingId: mapping})).id);
  const before = await db.get('SELECT * FROM sales_source_commits WHERE org_id=1 AND file_id=?', [fileId]);
  const reportsBefore = await db.get('SELECT status,content_hash FROM report_imports WHERE org_id=1 AND id=?', [before.report_id]);
  await addRun(db, {fileId, versionId, runNo: 1, at: '2026-05-01 00:00:00', matched: 0, goldenTotal: 1, judgment: 'human'});
  await rejects(addRun(db, {fileId, versionId, runNo: 3}), 'raise', /連番ではありません/);
  const second = Number((await addRun(db, {fileId, versionId, runNo: 2, at: '2026-05-03 00:00:00', judgment: 'auto', matched: 3, goldenTotal: 3})).id);
  const after = await db.get('SELECT * FROM sales_source_commits WHERE org_id=1 AND file_id=?', [fileId]);
  const reportsAfter = await db.get('SELECT status,content_hash FROM report_imports WHERE org_id=1 AND id=?', [before.report_id]);
  assert.deepEqual(after, before);
  assert.deepEqual(reportsAfter, reportsBefore);
  await rejects(db.run('UPDATE source_check_runs SET judgment=? WHERE org_id=1 AND id=?', ['human', second]), 'raise', /変更できません/);
  await rejects(db.run('DELETE FROM source_check_runs WHERE org_id=1 AND id=?', [second]), 'raise', /削除できません/);
  await rejects(addRun(db, {fileId, versionId, runNo: 3, passed: 2, total: 1}), 'check');
  const runs = (await db.all('SELECT * FROM source_check_runs WHERE org_id=1 AND file_id=? ORDER BY run_no', [fileId])).map(toRecordRun);
  assert.deepEqual(runs.map(run => [run.sourceFileId, run.judgment, run.goldenMatched, run.goldenTotal]), [
    [String(fileId), 'human', 0, 1],
    [String(fileId), 'auto', 3, 3],
  ]);
  const derived = deriveFolderRecord({checkVersionId: versionId, runs, reviews: []});
  assert.equal(derived.goldenComplete, true);
  assert.equal(derived.record, 0);
});

test('FR-REV-FOLDER-013 抜き取りの記録は追加のみで、直し無し・型の誤り・原本の誤りの3つだけを残し、型の誤りは版を増やさない', async (t) => {
  const db = await openTestDb({t});
  const mapping = await addMapping(db);
  const versionId = Number((await addVersion(db, {mappingId: mapping})).id);
  const versionsBefore = Number((await db.get('SELECT count(*) AS n FROM report_check_versions WHERE org_id=1')).n);
  const fileA = await receiveFile(db, '見た通A');
  const fileB = await receiveFile(db, '見た通B');
  const fileC = await receiveFile(db, '見た通C');
  const runA = Number((await addRun(db, {fileId: fileA, versionId, judgment: 'auto', at: '2026-05-01 00:00:00'})).id);
  const runB = Number((await addRun(db, {fileId: fileB, versionId, judgment: 'auto', at: '2026-05-02 00:00:00'})).id);
  const runC = Number((await addRun(db, {fileId: fileC, versionId, judgment: 'human', at: '2026-05-03 00:00:00'})).id);
  await addReview(db, {runId: runA, result: 'clean', at: '2026-05-01 01:00:00'});
  await addReview(db, {runId: runB, result: 'type_error', reason: '列の対応が違った', at: '2026-05-02 01:00:00'});
  await addReview(db, {runId: runC, result: 'source_error', reason: '原本の合計が違った', at: '2026-05-03 01:00:00'});
  await rejects(addReview(db, {runId: runA, result: 'maybe'}), 'check');
  await rejects(db.run('UPDATE source_sampling_reviews SET result=? WHERE org_id=1 AND check_run_id=?', ['clean', runB]), 'raise', /変更できません/);
  await rejects(db.run('DELETE FROM source_sampling_reviews WHERE org_id=1 AND check_run_id=?', [runA]), 'raise', /削除できません/);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM report_check_versions WHERE org_id=1')).n), versionsBefore);
  const runs = (await db.all('SELECT * FROM source_check_runs WHERE org_id=1')).map(toRecordRun);
  const reviews = (await db.all('SELECT * FROM source_sampling_reviews WHERE org_id=1')).map(toRecordReview);
  const derived = deriveFolderRecord({checkVersionId: versionId, runs, reviews});
  assert.equal(derived.record, 0);
  assert.equal(derived.looked, 3);
  await addReview(db, {runId: runB, result: 'clean', reason: '見間違いだった', at: '2026-05-04 01:00:00'});
  const again = deriveFolderRecord({
    checkVersionId: versionId,
    runs,
    reviews: (await db.all('SELECT * FROM source_sampling_reviews WHERE org_id=1')).map(toRecordReview),
  });
  assert.equal(again.record, 2);
  assert.equal(again.samplingClean, 2);
});
