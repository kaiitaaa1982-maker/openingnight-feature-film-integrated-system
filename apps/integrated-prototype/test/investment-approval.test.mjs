// 稟議の版（移行 0019。行動指標の計画 段B #4）を、DB の制約・store・受け口と、会社への利益額（フェーズ1 #14b）への接続で確かめる。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-038・039・049、docs/requirements/accounting/company-profit.md の
// FR-ACCT-PROFIT-004・007 と、行動指標の計画の J-10 (a)・J-11b (a)、golden（test/fixtures/yojitsu/kpi-expected.json の出資の回収。src を読まずに作った値）から持ってくる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う（組織1・2と利用者は試作の行、案件は試験の中で作る架空の案件と、
// 案件収支の予実の架空の種 test/fixtures/yojitsu/seed.json）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import {loadYojitsuSeed, yojitsuSeed, SEED_OWNER} from './yojitsu-view-fixture.mjs';
import {loadProfitSeedCosts} from './profit-db-fixture.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const KPI_EXPECTED = JSON.parse(readFileSync(new URL('./fixtures/yojitsu/kpi-expected.json', import.meta.url), 'utf8'));

const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const createProject = (db, code, overrides = {}) => planning.createProject(db, 1, {
  code, title: `架空の案件 ${code}`, projectType: 'production', earningType: 'own_investment', baseAmountYen: null, revenueRateBps: null,
  counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null, ...overrides,
}, {createdBy: ADMIN});
const insert = (db, projectId, approvalNo, versionNo, status, amountYen, {paidOn = null, basis = status === 'applied' || status === 'rejected' ? '架空の根拠' : null, org = 1, by = ADMIN} = {}) => db.run(
  `INSERT INTO investment_approval_versions(org_id,project_id,approval_no,version_no,status,amount_yen,basis_reference,paid_on,note,created_by)
   VALUES(?,?,?,?,?,?,?,?,NULL,?)`, [org, projectId, approvalNo, versionNo, status, amountYen, basis, paidOn, by]);
const versionCount = async (db, projectId) => Number((await db.get('SELECT count(*) AS n FROM investment_approval_versions WHERE org_id=1 AND project_id=?', [projectId])).n);

test('FR-REV-KPI-038 稟議の版は自社出資の案件にだけ足せて、版1は申請、承認の前に払込を入れられず、承認・却下は申請の額のまま、払込の累計は承認の額まで。最初の版を含めて書き換え・削除を断る', async (t) => {
  const db = await openTestDb({t});
  const own = await createProject(db, 'FICT-RG-1');
  const committee = await createProject(db, 'FICT-RG-2', {earningType: 'committee'});
  // 稼ぎ方が自社出資でない案件・別の組織の案件・無い案件は断る
  await rejects(insert(db, committee, 1, 1, 'applied', 1000), 'raise', /investment approval needs an own investment project/);
  await rejects(insert(db, 2, 1, 1, 'applied', 1000, {org: 2, by: 4}), 'raise', /investment approval needs an own investment project/);
  await rejects(insert(db, 999999, 1, 1, 'applied', 1000), 'raise', /investment approval needs an own investment project/);
  // 版1は申請（根拠の参照つき）だけ
  await rejects(insert(db, own, 1, 1, 'approved', 1000), 'check');
  await rejects(insert(db, own, 1, 1, 'applied', 1000, {basis: null}), 'check');
  await insert(db, own, 1, 1, 'applied', 3000000);
  // 番号の飛ばし・同じ番号の入れ直し（稟議の番号・版の番号）
  await rejects(insert(db, own, 1, 3, 'approved', 3000000), 'raise', /stale investment approval version/);
  await rejects(insert(db, own, 1, 1, 'applied', 3000000), 'raise', /stale investment approval version/);
  await rejects(insert(db, own, 3, 1, 'applied', 3000000), 'raise', /stale investment approval version/);
  // 承認の前の払込（申請のあと・却下のあと）
  await rejects(insert(db, own, 1, 2, 'paid', 1000, {paidOn: '2026-05-20'}), 'raise', /investment approval must be approved before payment/);
  // 承認は申請の額のまま
  await rejects(insert(db, own, 1, 2, 'approved', 2999999), 'raise', /investment approval decision must keep the applied amount/);
  await insert(db, own, 1, 2, 'approved', 3000000);
  // 承認のあとの申請し直し・却下・二度目の承認は版の流れが断る
  for (const status of ['applied', 'rejected', 'approved']) {
    await rejects(insert(db, own, 1, 3, status, 3000000), 'raise', /investment approval step is not allowed/);
  }
  // 払込は払った日が要り、累計は承認の額まで（ちょうどは通り、1円超えは断る）
  await rejects(insert(db, own, 1, 3, 'paid', 1000000), 'check');
  await insert(db, own, 1, 3, 'paid', 1000000, {paidOn: '2026-05-20'});
  await rejects(insert(db, own, 1, 4, 'paid', 2000001, {paidOn: '2026-06-20'}), 'raise', /investment approval payments exceed the approved amount/);
  await insert(db, own, 1, 4, 'paid', 2000000, {paidOn: '2026-06-20'});
  await rejects(insert(db, own, 1, 5, 'paid', 1, {paidOn: '2026-07-20'}), 'raise', /investment approval payments exceed the approved amount/);
  // 稟議2: 申請 → 却下（理由が要る）→ 却下のあとの払込は断る → 申請し直し
  await insert(db, own, 2, 1, 'applied', 500000);
  await rejects(insert(db, own, 2, 2, 'rejected', 500000, {basis: null}), 'check');
  await insert(db, own, 2, 2, 'rejected', 500000);
  await rejects(insert(db, own, 2, 3, 'paid', 500000, {paidOn: '2026-05-20'}), 'raise', /investment approval must be approved before payment/);
  await rejects(insert(db, own, 2, 3, 'approved', 500000), 'raise', /investment approval step is not allowed/);
  await insert(db, own, 2, 3, 'applied', 400000);
  // 最初の版を含めて、書き換え・削除は断る
  await rejects(db.run('UPDATE investment_approval_versions SET amount_yen=1 WHERE org_id=1 AND project_id=? AND approval_no=1 AND version_no=1', [own]), 'raise', /append-only/);
  await rejects(db.run('DELETE FROM investment_approval_versions WHERE org_id=1 AND project_id=? AND approval_no=1 AND version_no=1', [own]), 'raise', /append-only/);
  await rejects(db.run('DELETE FROM investment_approval_versions WHERE org_id=1 AND project_id=?', [own]), 'raise', /append-only/);
  assert.equal(await versionCount(db, own), 7);
  const rows = await planning.readProjectInvestmentApprovals(db, 1, own);
  assert.deepEqual(rows.map((r) => [Number(r.approval_no), Number(r.version_no), r.status, Number(r.amount_yen), r.paid_on]), [
    [1, 1, 'applied', 3000000, null], [1, 2, 'approved', 3000000, null], [1, 3, 'paid', 1000000, '2026-05-20'], [1, 4, 'paid', 2000000, '2026-06-20'],
    [2, 1, 'applied', 500000, null], [2, 2, 'rejected', 500000, null], [2, 3, 'applied', 400000, null],
  ]);
});

// 受け口を試作の行の利用者で呼ぶ部品
async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const cookies = new Map();
  const login = async (email) => {
    if (cookies.has(email)) return cookies.get(email);
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200, email);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    cookies.set(email, cookie);
    return cookie;
  };
  const call = async (email, method, path, payload) => {
    const cookie = await login(email);
    const response = await app.request(path, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
  return {
    get: (email, path) => call(email, 'GET', path),
    post: (email, path, payload) => call(email, 'POST', path, payload),
  };
}
const ADMIN_EMAIL = 'admin@openingnight.invalid';
const EDITOR_EMAIL = 'editor@openingnight.invalid';

test('FR-REV-KPI-038 受け口: 申請・承認（申請した人と同じでよく記録が残る）・払込の往復。承認の前の払込と古い画面は 409 で版も記録も残さない。却下には理由が要り、申請し直せる', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db, 'FICT-RG-10');
  const api = await appWithLogin(db);
  const base = `/api/planning/projects/${id}/investment-approvals`;
  const audit = async () => (await db.all("SELECT user_id,action,entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='investment_approval_version' ORDER BY id"))
    .map((r) => [Number(r.user_id), r.action, r.entity_id, JSON.parse(r.detail_json)]);

  const applied = await api.post(ADMIN_EMAIL, base, {amountYen: 4837261, basisReference: '架空の企画書 v2・回収試算'});
  assert.deepEqual([applied.status, applied.body.approvalNo, applied.body.versionNo, applied.body.status], [201, 1, 1, 'applied']);
  // 承認の前の払込は 409 で、版も変更の記録も増えない
  const early = await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'pay', previousVersionNo: 1, amountYen: 1000000, paidOn: '2026-05-20'});
  assert.deepEqual([early.status, early.body.error], [409, '承認の前に払込は入れられません']);
  assert.equal(await versionCount(db, id), 1);
  // 申請した人（管理者）がそのまま承認できる（J-10 (a)）。承認は申請の額のまま
  const approved = await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'approve', previousVersionNo: 1});
  assert.deepEqual([approved.status, approved.body.versionNo, approved.body.status, approved.body.amountYen, approved.body.sameAsApplicant], [201, 2, 'approved', 4837261, true]);
  // 古い画面（第1版を見ていた）からの書き込みは 409
  const stale = await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'reject', previousVersionNo: 1, basisReference: '架空の理由'});
  assert.equal(stale.status, 409);
  // 払込は2回に分けて（払い切るまで）
  assert.equal((await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'pay', previousVersionNo: 2, amountYen: 4837262, paidOn: '2026-05-20'})).status, 400);
  assert.equal((await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'pay', previousVersionNo: 2, amountYen: 1837261, paidOn: '2026-05-20'})).status, 201);
  assert.equal((await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'pay', previousVersionNo: 3, amountYen: 3000000, paidOn: '2026-07-10',
    basisReference: '架空の振込の控え'})).status, 201);
  // 稟議2: 却下には理由が要り、却下のあとに申請し直せる
  assert.equal((await api.post(ADMIN_EMAIL, base, {amountYen: 1200000, basisReference: '架空の試算 v1'})).body.approvalNo, 2);
  const noReason = await api.post(ADMIN_EMAIL, `${base}/2/versions`, {action: 'reject', previousVersionNo: 1});
  assert.deepEqual([noReason.status, noReason.body.details.map((e) => e.field)], [400, ['basisReference']]);
  assert.equal((await api.post(ADMIN_EMAIL, `${base}/2/versions`, {action: 'reject', previousVersionNo: 1, basisReference: '回収の試算が届かない（架空）'})).body.sameAsApplicant, true);
  assert.equal((await api.post(ADMIN_EMAIL, `${base}/2/versions`, {action: 'apply', previousVersionNo: 2, amountYen: 900000, basisReference: '架空の試算 v2'})).status, 201);
  assert.equal((await api.post(ADMIN_EMAIL, `${base}/9/versions`, {action: 'approve', previousVersionNo: 1})).status, 404);

  // 一覧: 版の全部・記録した人・いまの状態・出資枠（稟議1は払い切り、稟議2は申請中で枠なし）
  const list = await api.get(ADMIN_EMAIL, '/api/planning/investment-approvals');
  assert.equal(list.status, 200);
  const row = list.body.rows.find((r) => r.projectId === id);
  assert.deepEqual(row.approvals.map((a) => [a.approvalNo, a.state, a.approvedYen, a.paidYen, a.remainingYen]), [[1, 'paid_in_full', 4837261, 4837261, 0], [2, 'applied', null, 0, null]]);
  assert.deepEqual(row.approvals[0].versions.map((v) => [v.versionNo, v.status, v.amountYen, v.createdBy, v.sameAsApplicant, v.paidOn]), [
    [1, 'applied', 4837261, ADMIN, null, null], [2, 'approved', 4837261, ADMIN, true, null], [3, 'paid', 1837261, ADMIN, null, '2026-05-20'], [4, 'paid', 3000000, ADMIN, null, '2026-07-10'],
  ]);
  assert.ok(row.approvals[0].versions.every((v) => typeof v.createdAt === 'string' && v.createdAt.length >= 19), '版の日時が残る');
  assert.deepEqual(row.approvals[1].versions.map((v) => [v.status, v.basisReference]), [['applied', '架空の試算 v1'], ['rejected', '回収の試算が届かない（架空）'], ['applied', '架空の試算 v2']]);
  assert.deepEqual(list.body.policy, {sameApproverAllowed: true, reason: 'J-10 (a)（2026-10-09）: いまは申請と承認が同じ人でよい。記録は残す'});
  // 版ごとに変更の記録が1行。額は残さない（docs/rules/logging.md）
  const logs = await audit();
  assert.deepEqual(logs.map(([user, action, entity, detail]) => [user, action, entity, detail.status]), [
    [ADMIN, 'append', `${id}:1:1`, 'applied'], [ADMIN, 'append', `${id}:1:2`, 'approved'], [ADMIN, 'append', `${id}:1:3`, 'paid'], [ADMIN, 'append', `${id}:1:4`, 'paid'],
    [ADMIN, 'append', `${id}:2:1`, 'applied'], [ADMIN, 'append', `${id}:2:2`, 'rejected'], [ADMIN, 'append', `${id}:2:3`, 'applied'],
  ]);
  assert.ok(logs.every(([, , , detail]) => !JSON.stringify(detail).match(/4837261|1837261|3000000|1200000|900000|amount/i)), JSON.stringify(logs));
});

// 画面が読んだあとに、ほかの画面が先に版を足していた（同時の書き込み）とき。受け口が版を読む文（readProjectInvestmentApprovals）だけを、読んだ時点の古い行に
// 差し替えて呼ぶ: モデルは古い版の次として通し、DB（版の番号の取り合い・版の流れのトリガーか主キー）が断った書き込みを、受け口の append が 409 に変える。
// 版の行と変更の記録は同じ batch なので、どちらも増えない
// 壊れたら: append が DB の断りを 409 に変えないと 500 になり、記録だけ先に書くと変更の記録が増えて落ちる
test('FR-REV-KPI-038 受け口: 読んだあとにほかの画面が版を足していたら、DB が断った書き込みを 409 にして、版も変更の記録も残さない', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db, 'FICT-RG-15');
  const VERSIONS_OF_PROJECT = /FROM investment_approval_versions v WHERE v\.org_id=\? AND v\.project_id=\?/;
  let staleRows = null;
  const staleDb = new Proxy(db, {get(target, prop) {
    const value = target[prop];
    if (prop === 'all') return (sql, params) => (staleRows !== null && VERSIONS_OF_PROJECT.test(sql) ? Promise.resolve(staleRows) : value.call(target, sql, params));
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const api = await appWithLogin(staleDb);
  const base = `/api/planning/projects/${id}/investment-approvals`;
  assert.equal((await api.post(ADMIN_EMAIL, base, {amountYen: 2600000, basisReference: '架空の企画書'})).status, 201);
  // 画面が読んだ時点（稟議1の版1の申請だけ）。そのあとにほかの画面が稟議1を承認（版2）し、稟議2を申請（版1）する
  const seen = await planning.readProjectInvestmentApprovals(db, 1, id);
  assert.equal((await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'approve', previousVersionNo: 1})).status, 201);
  assert.equal((await api.post(ADMIN_EMAIL, base, {amountYen: 800000, basisReference: '架空の追加の企画書'})).status, 201);
  const auditCount = async () => Number((await db.get("SELECT count(*) AS n FROM audit_log WHERE org_id=1 AND entity_type='investment_approval_version'")).n);
  const [versionsBefore, auditBefore] = [await versionCount(db, id), await auditCount()];
  assert.deepEqual([versionsBefore, auditBefore], [3, 3]);
  staleRows = seen;
  const message = 'ほかの画面で稟議の版が足されました。読み直してから入れてください';
  // 古い画面から稟議1の却下（版2として）と、新しい稟議（稟議2として）
  const reject = await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'reject', previousVersionNo: 1, basisReference: '架空の理由'});
  assert.deepEqual([reject.status, reject.body.error], [409, message]);
  const apply = await api.post(ADMIN_EMAIL, base, {amountYen: 500000, basisReference: '架空の別の企画書'});
  assert.deepEqual([apply.status, apply.body.error], [409, message]);
  assert.deepEqual([await versionCount(db, id), await auditCount()], [versionsBefore, auditBefore]);
  const rows = await planning.readProjectInvestmentApprovals(db, 1, id);
  assert.deepEqual(rows.map((r) => [Number(r.approval_no), Number(r.version_no), r.status, Number(r.amount_yen)]),
    [[1, 1, 'applied', 2600000], [1, 2, 'approved', 2600000], [2, 1, 'applied', 800000]]);
});

test('FR-REV-KPI-004 FR-REV-KPI-038 制作担当は 403、財務の権限の無い案件と別の組織の案件は 403、稼ぎ方が自社出資でない案件は 409。一覧は見てよい案件だけ', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db, 'FICT-RG-20');
  const committee = await createProject(db, 'FICT-RG-21', {earningType: 'committee'});
  const api = await appWithLogin(db);
  assert.equal((await api.post(ADMIN_EMAIL, `/api/planning/projects/${id}/investment-approvals`, {amountYen: 1000, basisReference: '架空'})).status, 201);
  const body = {amountYen: 1000, basisReference: '架空'};
  assert.equal((await api.get('production@openingnight.invalid', '/api/planning/investment-approvals')).status, 403);
  assert.equal((await api.post('production@openingnight.invalid', `/api/planning/projects/${id}/investment-approvals`, body)).status, 403);
  // 編集担当（試作の行）は試作の案件1だけが edit。足した案件は権限が無く 403、別の組織の管理者にも 403（有無を見せない）
  assert.equal((await api.post(EDITOR_EMAIL, `/api/planning/projects/${id}/investment-approvals`, body)).status, 403);
  assert.equal((await api.post('outsider@other.invalid', `/api/planning/projects/${id}/investment-approvals`, body)).status, 403);
  assert.equal((await api.post(ADMIN_EMAIL, `/api/planning/projects/${committee}/investment-approvals`, body)).status, 409);
  assert.equal((await api.post(ADMIN_EMAIL, '/api/planning/projects/abc/investment-approvals', body)).status, 400);
  // 一覧: 編集担当は見てよい案件（試作の案件1。自社出資でなく稟議も無い）だけで行は無い。別の組織の管理者に組織1の稟議は出ない
  const editor = await api.get(EDITOR_EMAIL, '/api/planning/investment-approvals');
  assert.deepEqual([editor.status, editor.body.rows], [200, []]);
  const outsider = await api.get('outsider@other.invalid', '/api/planning/investment-approvals');
  assert.deepEqual([outsider.status, outsider.body.rows], [200, []]);
  const admin = await api.get(ADMIN_EMAIL, '/api/planning/investment-approvals');
  assert.deepEqual(admin.body.rows.map((r) => r.code), ['FICT-RG-20']);
  // 期間の誤りは 400
  assert.equal((await api.get(ADMIN_EMAIL, '/api/planning/investment-approvals?from=2026-13')).status, 400);
});

// 財務の権限は所属が edit の案件だけ（FR-REV-KPI-004。会社への利益額の FR-ACCT-PROFIT-009 と同じ絞り）。役割が編集担当で、自社出資の案件 A の所属が
// production だけの架空の利用者9は、A の稟議を申請も版の追加（承認）もできず（403。払込まで進めば会社への利益額に出資額として引かれる）、一覧も
// 財務の権限の案件が無いので 403。所属が edit の自社出資の案件 B を足すと、B には申請でき、一覧は B だけで A は出ない
// 壊れたら: 受け口の案件の絞り（permittedProjects・permittedProjectScope）を財務の権限なしで呼ぶと、A への申請・承認が 201 になり、一覧に A が出て落ちる
test('FR-REV-KPI-004 FR-REV-KPI-038 編集担当で所属が production だけの案件の稟議は、申請・版の追加が 403 で一覧にも出ない（所属が edit の案件だけ）', async (t) => {
  const db = await openTestDb({t});
  const a = await createProject(db, 'FICT-RG-40');
  const b = await createProject(db, 'FICT-RG-41');
  const VIEWER = 'approval-viewer@openingnight.invalid';
  await db.run("INSERT INTO users(id,email,display_name) VALUES(9,?,'架空の編集担当（稟議）')", [VIEWER]);
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,9,'editor')");
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,9,'production')", [a]);
  const api = await appWithLogin(db);
  assert.equal((await api.post(ADMIN_EMAIL, `/api/planning/projects/${a}/investment-approvals`, {amountYen: 2000000, basisReference: '架空の企画書'})).status, 201);
  const body = {amountYen: 1000, basisReference: '架空'};
  const approve = {action: 'approve', previousVersionNo: 1};
  assert.equal((await api.post(VIEWER, `/api/planning/projects/${a}/investment-approvals`, body)).status, 403);
  assert.equal((await api.post(VIEWER, `/api/planning/projects/${a}/investment-approvals/1/versions`, approve)).status, 403);
  assert.equal((await api.get(VIEWER, '/api/planning/investment-approvals')).status, 403);
  // 所属が edit の案件 B を足しても、A は production のまま
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,9,'edit')", [b]);
  assert.equal((await api.post(VIEWER, `/api/planning/projects/${b}/investment-approvals`, body)).status, 201);
  assert.equal((await api.post(VIEWER, `/api/planning/projects/${a}/investment-approvals/1/versions`, approve)).status, 403);
  const list = await api.get(VIEWER, '/api/planning/investment-approvals');
  assert.deepEqual([list.status, list.body.rows.map((r) => r.code)], [200, ['FICT-RG-41']]);
  // A の稟議は管理者が入れた版1の申請だけのまま
  assert.equal(await versionCount(db, a), 1);
});

// 払込は払った月に引く（J-11b (a)）。架空の案件に稟議の払込を2回（2026-05 と 2026-07）入れると、会社への利益額の確定の経費に、計上・入金の両方で
// その月に同じ額が出て、自社出資の出資額は「未接続」に出ない。払込の版の無い自社出資の案件（もう1つの案件）は、引いていないと注記に出る
test('FR-REV-KPI-039 FR-ACCT-PROFIT-004 FR-ACCT-PROFIT-007 稟議の払込は会社への利益額の自社出資の出資額として計上・入金とも払った月に引かれ、払込の無い自社出資の案件の数を注記する', async (t) => {
  const db = await openTestDb({t});
  const id = await createProject(db, 'FICT-RG-30');
  await createProject(db, 'FICT-RG-31');
  const api = await appWithLogin(db);
  const base = `/api/planning/projects/${id}/investment-approvals`;
  await api.post(ADMIN_EMAIL, base, {amountYen: 7319024, basisReference: '架空の企画書'});
  await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'approve', previousVersionNo: 1});
  await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'pay', previousVersionNo: 2, amountYen: 2519024, paidOn: '2026-05-31'});
  await api.post(ADMIN_EMAIL, `${base}/1/versions`, {action: 'pay', previousVersionNo: 3, amountYen: 4800000, paidOn: '2026-07-01'});
  for (const basis of ['accrual', 'cash']) {
    const res = await api.get(ADMIN_EMAIL, `/api/accounting/profit?basis=${basis}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.months, ['2026-05', '2026-07'], basis);
    assert.deepEqual(res.body.settled.costYen, [2519024, 4800000], basis);
    assert.deepEqual(res.body.byProject.map((p) => [p.code, p.costYen]), [['FICT-RG-30', 7319024]], basis);
    assert.ok(!res.body.unconnected.some((u) => u.key === 'own_investment'), basis);
    assert.ok(res.body.notes.includes('自社出資の出資額は、稟議の払込の記録が無い案件 1件では引いていません。出資していれば、利益額はその分だけ大きく出ます'), JSON.stringify(res.body.notes));
    // データの時点（最後の入出金）は、ほかに入出金の無いこの組織では稟議の払込の日の最後
    assert.equal(res.body.dataAsOf.at, '2026-07-01', basis);
    // 期間で絞ると、払った月が期間に入る払込だけ（データの時点も期間の中の払込の日）
    const part = await api.get(ADMIN_EMAIL, `/api/accounting/profit?basis=${basis}&from=2026-06&to=2026-12`);
    assert.deepEqual([part.body.months, part.body.settled.costYen], [['2026-07'], [4800000]], basis);
    const may = await api.get(ADMIN_EMAIL, `/api/accounting/profit?basis=${basis}&from=2026-05&to=2026-06`);
    assert.deepEqual([may.body.months, may.body.dataAsOf.at], [['2026-05'], '2026-05-31'], basis);
  }
  // 出資の回収: 収益（入金）が無いので差額は −出資額で回収待ち、回収率 0
  const list = await api.get(ADMIN_EMAIL, '/api/planning/investment-approvals');
  const row = list.body.rows.find((r) => r.code === 'FICT-RG-30');
  assert.deepEqual([row.investmentYen, row.revenueYen, row.diffYen, row.recoveryRateBps, row.status], [7319024, 0, -7319024, 0, 'awaiting']);
  assert.deepEqual(list.body.rows.find((r) => r.code === 'FICT-RG-31').status, 'no_approval');
});

// 案件収支の予実の架空の種（請求・入金・経費・委員会の払込）に、種の自社出資の出資の記録から稟議（申請・承認・種の時点までの払込）を入れ、
// 出資の回収の自社出資の行が、行動指標の golden（kpi-expected.json の標準のシナリオの出資の回収。src を読まずに作った値）と一致することを確かめる。
// 締めた月は種の設定の 2026-11（loadYojitsuSeed が入れる）、期間は golden の 1年目（2026-10〜2027-09）
test('FR-REV-KPI-039 FR-REV-KPI-049 架空の種に稟議の払込を入れると、自社出資の出資額・収益（入金を案件に結ぶ #14b の規則）・差額・回収率・状態・期間の列が golden と一致し、回収率が null でない', async (t) => {
  const db = await openTestDb({t});
  const seed = yojitsuSeed();
  const seeded = await loadYojitsuSeed(db, {seed, allInvoices: true});
  const costs = await loadProfitSeedCosts(db, {seeded, seed});
  assert.equal(costs.approvals.size, seed.investments.filter((x) => x.kind === '自社出資').length);
  const api = await appWithLogin(db);
  const {period} = KPI_EXPECTED;
  const res = await api.get(SEED_OWNER, `/api/planning/investment-approvals?from=${period.from}&to=${period.to}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.closedMonth, KPI_EXPECTED.closedMonth);
  const want = KPI_EXPECTED.scenarios.standard.investmentRecovery.rows.filter((r) => r.kind === 'own_investment');
  assert.ok(want.length >= 4);
  const pick = (r) => [r.investmentYen, r.revenueYen, r.diffYen, r.recoveryRateBps, r.status, r.periodInvestmentYen, r.periodRevenueYen];
  const byCode = new Map(res.body.rows.map((r) => [r.code, r]));
  for (const w of want) {
    const got = byCode.get(w.projectCode);
    assert.ok(got, w.projectCode);
    assert.deepEqual(pick(got), pick(w), w.projectCode);
    assert.notEqual(got.recoveryRateBps, null, w.projectCode);
  }
  // 出資の記録の無い自社出資の案件（YJ-P11・P12）は稟議なしで、合計に入れない。合計は golden の自社出資の行の和
  assert.deepEqual(res.body.rows.filter((r) => !want.some((w) => w.projectCode === r.code)).map((r) => [r.code, r.status, r.recoveryRateBps]),
    [['YJ-P11', 'no_approval', null], ['YJ-P12', 'no_approval', null]]);
  const sum = (key) => want.reduce((n, w) => n + w[key], 0);
  assert.deepEqual([res.body.total.rowCount, res.body.total.investmentYen, res.body.total.revenueYen, res.body.total.diffYen],
    [want.length, sum('investmentYen'), sum('revenueYen'), sum('diffYen')]);
  // 種の払込はどれも締めた月より前なので実績の側。稟議は払い切りで出資枠は0
  const sides = res.body.rows.flatMap((r) => r.approvals.flatMap((a) => a.versions.filter((v) => v.status === 'paid').map((v) => v.side)));
  assert.ok(sides.length > 0 && sides.every((side) => side === 'actual'), JSON.stringify(sides));
  assert.equal(res.body.frameYen, 0);
  assert.match(res.body.sourceHash, /^[0-9a-f]{64}$/);
  // 同じ入力で同じ sourceHash
  assert.equal((await api.get(SEED_OWNER, `/api/planning/investment-approvals?from=${period.from}&to=${period.to}`)).body.sourceHash, res.body.sourceHash);
});

// 締めた月（種の設定 2026-11）より後の入金と払込は、出資の回収の収益と出資額に入らない（締めていない側。段B #2・#16 が予測の側で扱う）。
// 種の YJ-P04 だけの入金の無い請求 RM-INV-202611-003（税込 268,315）に、締めた月の翌月 2026-12-01 に請求どおりの額の入金を入れ、YJ-P04 に稟議2
// （承認 3,000,000）を足して、締めた月の最後の日 2026-11-30 に 1,000,000、翌月の最初の日 2026-12-01 に 2,000,000 を払い込む。
// 期待値は golden の YJ-P04 の行（出資額 25,613,000・収益 5,067,396・期間の出資額 0）から手で動かす: 出資額は締めた月の払込だけを足して 26,613,000、
// 収益は golden のまま、差額 5,067,396−26,613,000＝−21,545,604、回収率 trunc(5067396×10000÷26613000)＝1904、期間の列（1年目）の出資額 1,000,000・収益は golden のまま
// 壊れたら: 収益を締めた月で絞らずに全期間の入金で出すと 2026-12 の入金の分だけ収益が増え、出資額に翌月の払込を入れると 2,000,000 増え、
// 締めた月の払込を落とすと 1,000,000 減って落ちる
test('FR-REV-KPI-039 FR-REV-KPI-049 締めた月より後の入金は収益に、後の払込は出資額に入らず、締めた月の払込は出資額に入る（受け口を通して）', async (t) => {
  const db = await openTestDb({t});
  const seed = yojitsuSeed();
  const seeded = await loadYojitsuSeed(db, {seed, allInvoices: true});
  await loadProfitSeedCosts(db, {seeded, seed});
  const api = await appWithLogin(db);
  const {period, closedMonth} = KPI_EXPECTED;
  assert.equal(closedMonth, '2026-11');
  // 締めた月の翌月の入金（請求どおりの額。消込で YJ-P04 の請求に結ぶ）
  const invoice = await db.get("SELECT id,partner_id,amount_inc_tax FROM billing_invoices WHERE org_id=1 AND invoice_number='RM-INV-202611-003'");
  assert.equal(Number(invoice.amount_inc_tax), 268315);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM billing_receipt_allocations WHERE org_id=1 AND invoice_id=?', [invoice.id])).n), 0, '入金の無い請求');
  const receipt = Number((await db.get(`INSERT INTO billing_receipts(org_id,partner_id,reference,received_on,amount_yen,allocation_count,created_by)
    VALUES(1,?,'FICT-RG-AFTER-CLOSE','2026-12-01',?,1,?) RETURNING id`, [invoice.partner_id, Number(invoice.amount_inc_tax), seeded.owner])).id);
  await db.run('INSERT INTO billing_receipt_allocations(org_id,receipt_id,invoice_id,amount_yen) VALUES(1,?,?,?)', [receipt, invoice.id, Number(invoice.amount_inc_tax)]);
  // 入金が YJ-P04 の 2026-12 の確定の売上に結ばれていること（足した記録が効く種であること）
  const december = await api.get(SEED_OWNER, '/api/accounting/profit?basis=cash&from=2026-12&to=2026-12');
  assert.ok(december.body.byProject.find((p) => p.code === 'YJ-P04')?.salesYen > 0, JSON.stringify(december.body.byProject));
  // 稟議2: 締めた月の払込と翌月の払込
  const p04 = seeded.projectId.get('YJ-P04');
  const base = `/api/planning/projects/${p04}/investment-approvals`;
  const applied = await api.post(SEED_OWNER, base, {amountYen: 3000000, basisReference: '架空の追加の企画書'});
  assert.deepEqual([applied.status, applied.body.approvalNo], [201, 2]);
  assert.equal((await api.post(SEED_OWNER, `${base}/2/versions`, {action: 'approve', previousVersionNo: 1})).status, 201);
  assert.equal((await api.post(SEED_OWNER, `${base}/2/versions`, {action: 'pay', previousVersionNo: 2, amountYen: 1000000, paidOn: '2026-11-30'})).status, 201);
  assert.equal((await api.post(SEED_OWNER, `${base}/2/versions`, {action: 'pay', previousVersionNo: 3, amountYen: 2000000, paidOn: '2026-12-01'})).status, 201);

  const res = await api.get(SEED_OWNER, `/api/planning/investment-approvals?from=${period.from}&to=${period.to}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.closedMonth, closedMonth);
  const want = KPI_EXPECTED.scenarios.standard.investmentRecovery.rows.filter((r) => r.kind === 'own_investment');
  const pick = (r) => [r.investmentYen, r.revenueYen, r.diffYen, r.recoveryRateBps, r.status, r.periodInvestmentYen, r.periodRevenueYen];
  const byCode = new Map(res.body.rows.map((r) => [r.code, r]));
  const golden04 = want.find((w) => w.projectCode === 'YJ-P04');
  assert.deepEqual(pick(golden04), [25613000, 5067396, -20545604, 1978, 'awaiting', 0, 5067396]);
  assert.deepEqual(pick(byCode.get('YJ-P04')), [26613000, 5067396, -21545604, 1904, 'awaiting', 1000000, 5067396]);
  assert.deepEqual([byCode.get('YJ-P04').approvedYen, byCode.get('YJ-P04').remainingYen], [28613000, 0]);
  assert.deepEqual(byCode.get('YJ-P04').approvals[1].versions.filter((v) => v.status === 'paid').map((v) => [v.paidOn, v.side]),
    [['2026-11-30', 'actual'], ['2026-12-01', 'open']]);
  // ほかの自社出資の行は golden のまま
  for (const w of want.filter((x) => x.projectCode !== 'YJ-P04')) assert.deepEqual(pick(byCode.get(w.projectCode)), pick(w), w.projectCode);
  const sum = (key) => want.reduce((n, w) => n + w[key], 0);
  assert.deepEqual([res.body.total.investmentYen, res.body.total.revenueYen], [sum('investmentYen') + 1000000, sum('revenueYen')]);
});
