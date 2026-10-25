// 1通の原本の条件の版（移行 0021 の sales_source_file_terms。フォルダ型の画面の最初の一切れ 区切り U1・香盤表 #3）を、DB の制約とトリガーで確かめる。
// 期待値は要件 docs/requirements/revenue/report-intake.md の FR-REV-INTAKE-006（1通に取引先・対象期間・申告合計を持つ。受け取ったあとに決まる値は版で足す）・
// 023（申告合計は件数・税抜・税額・税込。入れていない項目は未検証のまま）・051（受領日と報告月を別の値として持つ。受領日で報告月を埋めない）と、
// 会社ルートの plans/2026-10-18-folder-ui-first-slice.md の「誤りからの戻し方」（版は追記だけ。登録を始めたら条件の版を足せない）。
// 受け口と画面はまだ無い（区切り U2）ので、行を直接書いて確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openTestDb} from './test-db.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const OUTSIDER = 4; // 組織2の管理者（試作の行）
const PARTNER_DIGITAL = 2; // 組織1の架空配信（試作の行）
const PARTNER_STORE = 3; // 組織1の架空ストア（試作の行）
const PARTNER_OTHER_ORG = 4; // 組織2の取引先（試作の行）
const sha = (label) => createHash('sha256').update(label).digest('hex');

const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});

// 受け取った原本（作品を持たない）。中身は架空の文字
async function receiveFile(db, label, {orgId = 1, by = ADMIN} = {}) {
  const row = await db.get(`INSERT INTO sales_source_files(org_id,storage,file_name,media_type,byte_length,raw_sha256,original_base64,extraction_json,
    extractor_name,extractor_version,extraction_status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  [orgId, 'inline', `${label}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label.length, sha(label),
    Buffer.from(label).toString('base64'), JSON.stringify({sheets: []}), 'test', '1', 'extracted', by]);
  return Number(row.id);
}

const TERMS_COLUMNS = ['org_id', 'file_id', 'version_no', 'partner_id', 'kind', 'period_from', 'period_to', 'received_on', 'report_month',
  'declared_row_count', 'declared_amount_ex_tax', 'declared_tax_amount', 'declared_amount_inc_tax', 'reason', 'created_by'];
function addTerms(db, {orgId = 1, fileId, versionNo = 1, partnerId = PARTNER_DIGITAL, kind = 'digital', periodFrom = '2026-08-01', periodTo = '2026-08-31',
  receivedOn = null, reportMonth = null, rowCount = null, exTax = null, tax = null, incTax = null, reason = '架空の配信の取引先のフォルダに置いた', by = ADMIN}) {
  return db.run(`INSERT INTO sales_source_file_terms(${TERMS_COLUMNS.join(',')}) VALUES(${TERMS_COLUMNS.map(() => '?').join(',')})`,
    [orgId, fileId, versionNo, partnerId, kind, periodFrom, periodTo, receivedOn, reportMonth, rowCount, exTax, tax, incTax, reason, by]);
}
const termsOf = async (db, fileId) => (await db.all(
  `SELECT version_no,partner_id,kind,period_from,period_to,received_on,report_month,declared_row_count,declared_amount_ex_tax,declared_tax_amount,
    declared_amount_inc_tax,reason,created_by FROM sales_source_file_terms WHERE org_id=1 AND file_id=? ORDER BY version_no`, [fileId]))
  .map((r) => ({...r, version_no: Number(r.version_no), partner_id: Number(r.partner_id), created_by: Number(r.created_by),
    declared_row_count: r.declared_row_count == null ? null : Number(r.declared_row_count),
    declared_amount_ex_tax: r.declared_amount_ex_tax == null ? null : Number(r.declared_amount_ex_tax),
    declared_tax_amount: r.declared_tax_amount == null ? null : Number(r.declared_tax_amount),
    declared_amount_inc_tax: r.declared_amount_inc_tax == null ? null : Number(r.declared_amount_inc_tax)}));
// 今の条件は、原本ごとの最新の版（状態の列は持たず、読むたびに導く）
const latestTerms = async (db, fileId) => (await termsOf(db, fileId)).at(-1);

// 原本を1作品に割り当てて、分割を1件登録する（取込ウィザードの手順2〜6が書く行を、同じ順に直接書く）
async function commitOnePartition(db, fileId) {
  const selection = Number((await db.get(`INSERT INTO sales_source_selections(org_id,file_id,version_no,sheet_name,header_row,canonical_csv,canonical_sha256,
    source_rows_json,suggestion_source,created_by) VALUES(1,?,1,'Details',2,?,?,'[3]','rule-based',?) RETURNING id`,
  [fileId, '作品CD,正味売上\nWRK-DEMO,1000\n', sha(`selection-${fileId}`), ADMIN])).id);
  const binding = Number((await db.get(`INSERT INTO sales_source_bindings(org_id,file_id,version_no,mode,project_id,work_id,reason,created_by)
    VALUES(1,?,1,'single_work',1,1,'1つの作品の報告',?) RETURNING id`, [fileId, ADMIN])).id);
  const partition = Number((await db.get(`INSERT INTO sales_source_partitions(org_id,file_id,selection_id,binding_id,plan_sha256,project_id,work_id,row_count,
    source_rows_json,partition_sha256,created_by) VALUES(1,?,?,?,?,1,1,1,'[3]',?,?) RETURNING id`,
  [fileId, selection, binding, sha(`plan-${fileId}`), sha(`partition-${fileId}`), ADMIN])).id);
  const profile = Number((await db.get(`INSERT INTO report_mapping_profiles(org_id,partner_id,kind,name,created_by) VALUES(1,?,'digital',?,?) RETURNING id`,
    [PARTNER_DIGITAL, `架空配信の列対応 ${fileId}`, ADMIN])).id);
  const mapping = Number((await db.get(`INSERT INTO report_mapping_versions(org_id,profile_id,version_no,definition_json,definition_hash,created_by)
    VALUES(1,?,1,'{}',?,?) RETURNING id`, [profile, sha(`mapping-${fileId}`), ADMIN])).id);
  const report = Number((await db.get(`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,
    content_hash,created_by) VALUES(1,1,?,?,'digital','2026-08-01','2026-08-31','2026-09','作品CD,正味売上',?,?) RETURNING id`,
  [PARTNER_DIGITAL, `TERMS-${fileId}`, sha(`report-${fileId}`), ADMIN])).id);
  await db.run(`INSERT INTO sales_source_commits(org_id,file_id,partition_id,binding_id,selection_id,work_id,mapping_version_id,report_id,preview_token,created_by)
    VALUES(1,?,?,?,?,1,?,?,?,?)`, [fileId, partition, binding, selection, mapping, report, `token-${fileId}`, ADMIN]);
  return report;
}

test('FR-REV-INTAKE-006 FR-REV-INTAKE-023 FR-REV-INTAKE-051 1通の条件は原本ごとの版で残り、分からない受領日・報告月・申告合計は空のまま持て、最新の版が今の条件になる', async (t) => {
  const db = await openTestDb({t});
  const fileId = await receiveFile(db, '架空の配信報告 2026年8月分');
  // 版1: 置いた時点の条件。受領日・報告月・申告合計はまだ分からないので空（0 や受取日で埋めない）
  await addTerms(db, {fileId});
  // 版2: 置き場所の取り違え（取引先）を、理由を書いて直す。受領日は入れたが、報告月は受領日から埋めない（FR-REV-INTAKE-068）。申告合計は税抜だけ
  await addTerms(db, {fileId, versionNo: 2, partnerId: PARTNER_STORE, kind: 'package', receivedOn: '2026-09-05', exTax: 2287040,
    reason: '架空ストアの報告を架空配信のフォルダに置いていたので移す'});
  // 版3: 報告書に書かれた報告月と、申告合計の4つを入れる（税込＝税抜＋税額）
  await addTerms(db, {fileId, versionNo: 3, partnerId: PARTNER_STORE, kind: 'package', receivedOn: '2026-09-05', reportMonth: '2026-08',
    rowCount: 9, exTax: 2287040, tax: 228704, incTax: 2515744, reason: '報告書の報告月と合計を写した'});
  const versions = await termsOf(db, fileId);
  assert.deepEqual(versions.map((v) => [v.version_no, v.partner_id, v.kind, v.received_on, v.report_month, v.declared_row_count, v.declared_amount_ex_tax,
    v.declared_tax_amount, v.declared_amount_inc_tax]), [
    [1, PARTNER_DIGITAL, 'digital', null, null, null, null, null, null],
    [2, PARTNER_STORE, 'package', '2026-09-05', null, null, 2287040, null, null],
    [3, PARTNER_STORE, 'package', '2026-09-05', '2026-08', 9, 2287040, 228704, 2515744],
  ]);
  assert.deepEqual(versions.map((v) => v.reason), ['架空の配信の取引先のフォルダに置いた', '架空ストアの報告を架空配信のフォルダに置いていたので移す', '報告書の報告月と合計を写した']);
  const latest = await latestTerms(db, fileId);
  assert.deepEqual([latest.version_no, latest.partner_id, latest.period_from, latest.period_to], [3, PARTNER_STORE, '2026-08-01', '2026-08-31']);
  // 受領日は取り込んだ日時（原本の created_at）と別の値として持つ
  const file = await db.get('SELECT created_at FROM sales_source_files WHERE org_id=1 AND id=?', [fileId]);
  assert.match(file.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(versions[0].received_on, null, '版1の受領日は取り込んだ日時で埋めていない');
  // 対象期間の分からない版も持てる（2つとも空）
  const other = await receiveFile(db, '期間の分からない架空の報告');
  await addTerms(db, {fileId: other, periodFrom: null, periodTo: null});
  assert.deepEqual([(await latestTerms(db, other)).period_from, (await latestTerms(db, other)).period_to], [null, null]);
});

test('FR-REV-INTAKE-006 1通の条件の版は原本ごとの連番で、番号の飛ばしと入れ直しを断り、変更も削除もできない', async (t) => {
  const db = await openTestDb({t});
  const fileId = await receiveFile(db, '連番を確かめる架空の報告');
  const otherId = await receiveFile(db, '別の架空の報告');
  await addTerms(db, {fileId});
  // 同じ番号の入れ直し（古い画面からの書き込み）と番号の飛ばしは、一意の制約より先にトリガーが同じ文で断る
  await rejects(addTerms(db, {fileId, versionNo: 1, partnerId: PARTNER_STORE}), 'raise', /1通の条件の版の番号が連番ではありません/);
  await rejects(addTerms(db, {fileId, versionNo: 3}), 'raise', /1通の条件の版の番号が連番ではありません/);
  await rejects(addTerms(db, {fileId, versionNo: 0}), 'raise', /連番ではありません/);
  await addTerms(db, {fileId, versionNo: 2, partnerId: PARTNER_STORE, reason: '取引先を直した'});
  // 番号は原本ごと（別の原本は1から）
  await addTerms(db, {fileId: otherId});
  // 変更・削除は DB が断り、版は残る
  await rejects(db.run('UPDATE sales_source_file_terms SET partner_id=? WHERE org_id=1 AND file_id=? AND version_no=1', [PARTNER_STORE, fileId]), 'raise', /1通の条件の版は変更できません/);
  await rejects(db.run("UPDATE sales_source_file_terms SET received_on='2026-09-01' WHERE org_id=1 AND file_id=? AND version_no=2", [fileId]), 'raise', /変更できません/);
  await rejects(db.run('DELETE FROM sales_source_file_terms WHERE org_id=1 AND file_id=? AND version_no=2', [fileId]), 'raise', /1通の条件の版は削除できません/);
  assert.deepEqual((await termsOf(db, fileId)).map((v) => [v.version_no, v.partner_id, v.received_on]), [[1, PARTNER_DIGITAL, null], [2, PARTNER_STORE, null]]);
  assert.deepEqual((await termsOf(db, otherId)).map((v) => v.version_no), [1]);
});

test('FR-REV-INTAKE-006 登録を始めた原本には1通の条件の版を足せない（置き場所の誤りは登録の前にだけ版で直せる）', async (t) => {
  const db = await openTestDb({t});
  const fileId = await receiveFile(db, '登録した架空の報告');
  const pendingId = await receiveFile(db, '登録していない架空の報告');
  await addTerms(db, {fileId});
  await addTerms(db, {fileId: pendingId});
  // 登録の前は、条件の版を足して取引先を直せる
  await addTerms(db, {fileId, versionNo: 2, receivedOn: '2026-09-05', reason: '受領日を入れた'});
  const reportId = await commitOnePartition(db, fileId);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM sales_source_commits WHERE org_id=1 AND file_id=? AND report_id=?', [fileId, reportId])).n), 1);
  // 登録を始めたあとは、正しい番号の版でも断る
  await rejects(addTerms(db, {fileId, versionNo: 3, partnerId: PARTNER_STORE, reason: '登録のあとで取引先を変えようとした'}), 'raise', /登録を始めた原本の1通の条件は変えられません/);
  // 番号の違う版は、登録の有無より先に連番の決まりで断る（D1 と PostgreSQL で同じ文になるよう、決まりの順を WHEN で固定している）
  await rejects(addTerms(db, {fileId, versionNo: 5}), 'raise', /連番ではありません/);
  assert.deepEqual((await termsOf(db, fileId)).map((v) => v.version_no), [1, 2]);
  // 登録していない原本は、引き続き版を足せる
  await addTerms(db, {fileId: pendingId, versionNo: 2, partnerId: PARTNER_STORE, reason: '取引先を直した'});
  assert.deepEqual((await termsOf(db, pendingId)).map((v) => [v.version_no, v.partner_id]), [[1, PARTNER_DIGITAL], [2, PARTNER_STORE]]);
});

test('FR-REV-INTAKE-023 FR-REV-INTAKE-051 条件の形と範囲は DB の CHECK が守る: 対象期間は2つそろえて終わりが始まり以後、日付と月の形、申告合計の税込＝税抜＋税額、件数は0以上、理由は必須', async (t) => {
  const db = await openTestDb({t});
  const fileId = await receiveFile(db, '形を確かめる架空の報告');
  const bad = (values) => rejects(addTerms(db, {fileId, ...values}), 'check');
  // 対象期間
  await bad({periodFrom: '2026-08-01', periodTo: null});
  await bad({periodFrom: null, periodTo: '2026-08-31'});
  await bad({periodFrom: '2026-09-01', periodTo: '2026-08-31'});
  await bad({periodFrom: '2026-13-01', periodTo: '2026-13-31'});
  await bad({periodFrom: '2026-8-1', periodTo: '2026-08-31'});
  await bad({periodFrom: '２０２６-08-01', periodTo: '2026-08-31'});
  // 受領日（YYYY-MM-DD）と報告月（YYYY-MM）
  await bad({receivedOn: '2026-09-32'});
  await bad({receivedOn: '2026/09/05'});
  await bad({receivedOn: '2026-09'});
  await bad({reportMonth: '2026-00'});
  await bad({reportMonth: '2026-08-01'});
  await bad({reportMonth: '２０２６-08'});
  // 申告合計: 3つの額がそろえば税込＝税抜＋税額。件数は0以上の整数、額は整数円
  await bad({exTax: 1000, tax: 100, incTax: 1101});
  await bad({rowCount: -1});
  await bad({exTax: 1000.5});
  // 取引先の種類の語と理由
  await bad({kind: 'streaming'});
  await bad({reason: '   '});
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM sales_source_file_terms WHERE org_id=1 AND file_id=?', [fileId])).n), 0);
  // 境目のちょうど: 1日だけの期間・月末・0件・額の一部だけ（残りは未検証）・返品で負の合計は通る
  await addTerms(db, {fileId, periodFrom: '2026-08-31', periodTo: '2026-08-31', receivedOn: '2026-12-31', reportMonth: '2026-12', rowCount: 0, exTax: -1200, tax: -120, incTax: -1320});
  await addTerms(db, {fileId, versionNo: 2, exTax: 1000, incTax: 1100, reason: '税額は報告書に無い'});
  assert.deepEqual((await termsOf(db, fileId)).map((v) => [v.version_no, v.declared_row_count, v.declared_amount_ex_tax, v.declared_tax_amount, v.declared_amount_inc_tax]),
    [[1, 0, -1200, -120, -1320], [2, null, 1000, null, 1100]]);
});

test('FR-REV-INTAKE-006 組織の境界: 別の組織の原本・取引先・利用者では1通の条件の版を作れない', async (t) => {
  const db = await openTestDb({t});
  const fileId = await receiveFile(db, '組織1の架空の報告');
  const outsideFile = await receiveFile(db, '組織2の架空の報告', {orgId: 2, by: OUTSIDER});
  await rejects(addTerms(db, {orgId: 2, fileId, by: OUTSIDER, partnerId: PARTNER_OTHER_ORG}), 'foreign_key');
  await rejects(addTerms(db, {fileId, partnerId: PARTNER_OTHER_ORG}), 'foreign_key');
  await rejects(addTerms(db, {fileId, by: OUTSIDER}), 'foreign_key');
  await rejects(addTerms(db, {fileId: outsideFile}), 'foreign_key');
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM sales_source_file_terms')).n), 0);
  // 組織2の原本には、組織2の取引先と利用者で作れる（行は組織2のものとして残る）
  await addTerms(db, {orgId: 2, fileId: outsideFile, partnerId: PARTNER_OTHER_ORG, by: OUTSIDER});
  assert.deepEqual((await db.all('SELECT org_id,file_id,partner_id FROM sales_source_file_terms')).map((r) => [Number(r.org_id), Number(r.file_id), Number(r.partner_id)]),
    [[2, outsideFile, PARTNER_OTHER_ORG]]);
});
