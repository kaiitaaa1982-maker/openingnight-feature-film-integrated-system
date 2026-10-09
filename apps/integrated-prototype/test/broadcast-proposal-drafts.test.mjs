// 放送ウィンドウ提案から放送枠の下書きを作る・合意に至らず削除する API（POST/GET /api/broadcast/window-proposals/drafts、POST …/:slotId/delete）。
// 画面と同じ API で材料（放送の解禁・権利範囲・放送用の商品・取引先別リストの独占と非独占＋ホールドバック・局）を登録し、
// 期待する月・期間・理由は、この試験の中で日付を書き下して照合する（提案の区間計算は使わない）。
// 壊れたら: 塞がった月・範囲外の月に下書きができる、二重登録ができる、権限の無い人・別組織が作れる／消せる、申請中の枠が消える、
//           削除した枠が一覧・履歴表・二重登録の判定に残って同じ月・局をもう一度提案できない、削除の理由と人が残らない、
//           売上を紐付けた下書きを消して売上が突合から消える、放送枠のタブで直した局の種別が元の局のまま出る（局名だけを直したときも）、
//           合意して確定した枠に、その合意の契約（同じ局・独占）を入れると要確認になる、
//           同時の操作で負けた側に操作と合わない文言が出る、申請していない中止の枠が「申請中〜確定」に数えられる。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

const asOf = '2026-09-26';
let db, call, ok, product, digitalProduct, tvt, pt2, adminWork, cinema;
const count = async (table, where = '1=1', params = []) => Number((await db.get(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`, params)).n);
const propose = (body, as = 'editor') => call('/broadcast/window-proposals/drafts', {method: 'POST', as,
  body: {workId: 1, productId: product, asOf, stationPartnerId: tvt, runKind: 'first', ...body}});
const drafts = async (as = 'editor', query = '') => (await call(`/broadcast/window-proposals/drafts${query}`, {as})).data;

before(async (t) => {
  db = await openTestDb({t});
  // 閲覧だけの人（案件に「制作」の権限で入った編集担当。見られるが編集はできない）
  await db.run("INSERT INTO users(id,email,display_name) VALUES(5,'viewer@openingnight.invalid','閲覧担当')");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,5,'editor')");
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,1,5,'production')");
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const cookies = {admin: await login('admin@openingnight.invalid'), editor: await login('editor@openingnight.invalid'), production: await login('production@openingnight.invalid'),
    outsider: await login('outsider@other.invalid'), viewer: await login('viewer@openingnight.invalid')};
  call = async (path, {method = 'GET', body, as = 'admin'} = {}) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie: cookies[as], ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, data: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())};
  };
  ok = async (path, body, as = 'admin') => { const r = await call(path, {method: 'POST', body, as}); assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
  const project = await ok('/projects', {code: 'PRJ-ADMIN', title: '管理者だけの案件', status: 'active', budget_yen: 0});
  adminWork = (await ok('/works', {project_id: project.id, code: 'WRK-ADMIN', title: '管理者だけの作品', format: 'film'})).id;
  // 材料: 放送の解禁 2026-10-01〜2030-03-31、権利 2024-01-01〜2031-12-31（放送・日本）、放送用の商品
  await ok('/release-window-types/adopt', {reason: '試験の組織で初期の種別を採用'});
  const broadcastType = (await call('/release-window-types')).data.types.find((t) => t.type_key === 'broadcast');
  await ok('/release-windows', {workId: 1, typeId: broadcastType.id, baseVersion: 0, start: '2026-10-01', end: '2030-03-31', announce: '', status: 'confirmed', fields: {}, sourceReference: '架空の資料', reason: '放送の解禁'});
  await ok('/intakes', {workId: 1, caseCode: 'WRK-DEMO-TV', title: '放送の権利（架空）', intakeType: 'sole_owned', documents: [{title: '許諾書（架空）', reference: '架空', versionLabel: '第1版'}],
    scopes: [{channel: '放送', territory: '日本', rightsStart: '2024-01-01', rightsEnd: '2031-12-31', exclusivity: 'exclusive'}], participants: [{partyKind: 'current_org', role: '権利保有'}]});
  product = (await ok('/products', {sku: 'SKU-TV', name: '放送権（架空）', channel: 'broadcast'})).id;
  await ok('/product-works', {productId: product, allocations: [{workId: 1, allocationBps: 10000}]});
  digitalProduct = 1; // SKU-DIGI（配信の商品）
  // 取引先別リスト: 架空配信（取引先2）の独占 2027-01-01〜2027-06-30、非独占 2026-10-01〜2026-12-31＋ホールドバック3か月（2027-01-01〜2027-03-31）
  const list = await ok('/partner-lists', {partnerId: 2, listKind: 'distribution', name: '放送の許諾（架空）', reason: '試験'});
  const add = async (values) => (await ok(`/partner-lists/${list.id}/entries`, {workId: 1, values: {territory: '日本', source_reference: '架空の許諾通知', ...values}, reason: '試験'})).entryId;
  await add({distribution_code: 'B001', contract_start: '2027-01-01', contract_end: '2027-06-30', end_rule: 'date', exclusivity: 'exclusive', status: 'contracted'});
  const nonexclusive = await add({distribution_code: 'B002', contract_start: '2026-10-01', contract_end: '2026-12-31', end_rule: 'date', exclusivity: 'nonexclusive', status: 'contracted'});
  await ok(`/partner-list-entries/${nonexclusive}/broadcast-terms`, {baseVersion: 0, licensedRuns: 3, holdbackMonths: 3, reason: '許諾通知の条件'});
  // 局: 架空配信（取引先2）を BS、新しい取引先「架空テレビ（試験）」を地上波にする。架空シネマ（取引先1）は局ではない
  pt2 = 2;
  cinema = 1;
  tvt = (await ok('/partners', {code: 'TV-T', name: '架空テレビ（試験）', kind: 'other'})).id;
  await ok('/broadcast/station-types', {partnerId: pt2, stationType: 'bs', baseVersion: 0, reason: '局の種別（試験）'});
  await ok('/broadcast/station-types', {partnerId: tvt, stationType: 'terrestrial', baseVersion: 0, reason: '局の種別（試験）'});
});
after(() => db?.close());

test('提案から下書きを作る: 選んだ月ごとに放送枠（作品×月×局・下書き・第1版）を作り、どの提案から作ったかと作った人を残す', async () => {
  const before = {slots: await count('broadcast_slots'), audit: await count('audit_log')};
  const r = await propose({months: ['2027-07', '2026-11'], memo: '年末の枠で打診（試験）'});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.count, 2);
  // 期待値（書き下し）: 提案する期間は [2026-10-01〜2026-12-31]・[2027-07-01〜2028-09-26]。どちらの月もまるごと入る
  assert.deepEqual(r.data.slots.map((s) => [s.month, s.periodFrom, s.periodTo]), [['2026-11', '2026-11-01', '2026-11-30'], ['2027-07', '2027-07-01', '2027-07-31']]);
  assert.equal(await count('broadcast_slots'), before.slots + 2);
  for (const {slotId, month} of r.data.slots) {
    const v = await db.get('SELECT * FROM broadcast_slot_versions WHERE org_id=1 AND slot_id=?', [slotId]);
    assert.deepEqual([v.revision, v.status, v.work_id, v.broadcast_month, v.station_name, v.customer_partner_id, v.planned_runs, v.changed_by], [1, 'draft', 1, month, '架空テレビ（試験）', tvt, 1, 2]);
    assert.match(v.source_reference, /^放送ウィンドウ提案（基準日 2026\/09\/26・提案する期間 20\d\d\/\d\d\/\d\d〜20\d\d\/\d\d\/\d\d）$/);
    assert.equal(v.reason, '放送ウィンドウ提案から下書き（初回）：年末の枠で打診（試験）');
  }
  const rows = await db.all('SELECT * FROM broadcast_proposal_drafts WHERE org_id=1 ORDER BY broadcast_month');
  assert.deepEqual(rows.map((x) => [x.broadcast_month, x.product_id, x.station_partner_id, x.run_kind, x.as_of, x.proposal_from, x.proposal_to, x.created_by, x.memo]), [
    ['2026-11', product, tvt, 'first', asOf, '2026-10-01', '2026-12-31', 2, '年末の枠で打診（試験）'],
    ['2027-07', product, tvt, 'first', asOf, '2027-07-01', '2028-09-26', 2, '年末の枠で打診（試験）'],
  ]);
  assert.equal(rows[0].proposal_key, rows[1].proposal_key, '1回の提案で作った月は同じ目印');
  assert.match(rows[0].basis_text, /^提案する期間: 2026\/10\/01〜2026\/12\/31\nこの月の放送枠の期間: 2026\/11\/01〜2026\/11\/30\n権利: 2024\/01\/01〜2031\/12\/31/);
  assert.match(rows[0].basis_text, /塞がっている期間: 2027\/01\/01〜2027\/06\/30 架空配信（独占）/);
  assert.match(rows[0].basis_text, /塞がっている期間: 2027\/01\/01〜2027\/03\/31 架空配信（ホールドバック 3か月）/);
  // 監査: 放送枠の作成として、提案から作ったことと作った人が残る
  const audits = await db.all("SELECT * FROM audit_log WHERE org_id=1 AND action='create' AND entity_type='broadcast_slot' ORDER BY id DESC LIMIT 2");
  assert.equal(await count('audit_log'), before.audit + 2);
  for (const a of audits) {
    const detail = JSON.parse(a.detail_json);
    assert.deepEqual([a.user_id, detail.source, detail.revision, detail.runKind, detail.asOf, detail.proposalKey], [2, 'window_proposal', 1, 'first', asOf, rows[0].proposal_key]);
  }
  // 一覧: 放送枠のタブにも、提案から作った下書きの一覧にも出る
  const slots = (await call('/broadcast?workId=1', {as: 'editor'})).data.slots;
  assert.deepEqual(slots.filter((s) => r.data.slots.some((x) => x.slotId === s.slot_id)).map((s) => s.status), ['draft', 'draft']);
  const list = await drafts();
  assert.deepEqual(list.counts, {drafts: 2, inFlow: 0, rejected: 0, cancelled: 0, deleted: 0});
  const first = list.rows.find((x) => x.broadcast_month === '2026-11');
  assert.deepEqual([first.work_code, first.product_sku, first.station_name, first.station_type, first.run_label, first.created_by_name, first.status, first.can_delete],
    ['WRK-DEMO', 'SKU-TV', '架空テレビ（試験）', 'terrestrial', '初回', '編集担当', 'draft', true]);
  // 直していない下書きは、提案の後の修正・提案する期間の外の印が付かない
  assert.deepEqual(list.rows.map((row) => [row.changed_after_proposal, row.outside_proposal, row.needs_check, row.has_sales]), [[false, false, false, false], [false, false, false, false]]);
  assert.deepEqual([first.station_partner_id, first.proposed_station_partner_id, first.proposed_station_name, first.proposed_month], [tvt, tvt, '架空テレビ（試験）', '2026-11']);
  assert.ok(first.created_at);
  assert.deepEqual(list.stations.map((s) => [s.name, s.station_type]).sort(), [['架空テレビ（試験）', 'terrestrial'], ['架空配信', 'bs']]);
  // 月の一部だけが提案する期間なら、放送枠の期間はその重なり（基準日から24か月＝2028-09-26 まで）
  const partial = await propose({months: ['2028-09'], runKind: 'rerun'});
  assert.equal(partial.status, 201, JSON.stringify(partial.data));
  assert.deepEqual(partial.data.slots.map((s) => [s.month, s.periodFrom, s.periodTo]), [['2028-09', '2028-09-01', '2028-09-26']]);
  assert.equal((await db.get('SELECT run_kind FROM broadcast_proposal_drafts WHERE org_id=1 AND slot_id=?', [partial.data.slots[0].slotId])).run_kind, 'rerun');
});

test('二重登録: 同じ作品・月・局の生きている枠がある月は作らず、ほかの月も書かない（全角・半角のゆれも同じ局）', async () => {
  const before = await count('broadcast_slot_versions');
  let r = await propose({months: ['2026-11']});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /同じ放送局「架空テレビ（試験）」の放送枠がすでにあります（放送枠ID \d+・下書き）/);
  // 画面の「放送枠を追加」で全角の局名の枠を入れた月も、同じ局として止める
  assert.equal((await call('/broadcast/slots', {method: 'POST', as: 'editor', body: {workId: 1, broadcastMonth: '2026-12', stationName: '架空テレビ（試験）'.replace('テレビ', 'テレビ　'), periodFrom: '2026-12-01', periodTo: '2026-12-31', plannedRuns: 1}})).status, 201);
  r = await propose({months: ['2026-10', '2026-12']});
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /2026-12/);
  assert.equal(await count('broadcast_slot_versions'), before + 1, '止めた提案は1文も書かない（2026-10 も作らない）');
  // 別の局なら同じ月でも作れる（同じ月の別局は競合の判定に回る）
  r = await propose({months: ['2026-11'], stationPartnerId: pt2});
  assert.equal(r.status, 201, JSON.stringify(r.data));
});

test('範囲外の月: 提案する期間の外・独占・ホールドバックの月は理由を示して止め、形の違う月・重複・空も止める', async () => {
  const before = await count('broadcast_slot_versions');
  const reject = async (months, pattern, status = 400) => {
    const r = await propose({months});
    assert.equal(r.status, status, `${months}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, pattern, months.join(','));
  };
  // 独占（2027-01-01〜2027-06-30）とホールドバック（2027-01-01〜2027-03-31）
  await reject(['2027-02'], /^2027年2月は提案する期間の外なので選べません（独占契約中（架空配信・2027\/01\/01〜2027\/06\/30）・ホールドバック（架空配信・3か月・2027\/01\/01〜2027\/03\/31））$/);
  await reject(['2027-05'], /^2027年5月は提案する期間の外なので選べません（独占契約中（架空配信・2027\/01\/01〜2027\/06\/30））$/);
  // 放送の解禁（2026-10-01）より前
  await reject(['2026-09'], /2026年9月は提案する期間の外なので選べません（放送してよい期間の外（権利・放送の解禁・販売条件））/);
  // 基準日から24か月（2028-09-26）より先
  await reject(['2028-10'], /2028年10月は提案する期間の外なので選べません（提案の範囲（基準日から24か月・2026\/09\/26〜2028\/09\/26）の外）/);
  // 1つでも範囲外があれば、ほかの月も作らない
  await reject(['2026-10', '2027-03'], /2027年3月は提案する期間の外/);
  await reject(['2026-13'], /2026-11 の形/);
  await reject(['2026-10', '2026-10'], /2026年10月が2回選ばれています/);
  await reject([], /1つ以上選んでください/);
  assert.equal((await propose({months: '2026-10'})).status, 400, '配列でない');
  assert.equal(await count('broadcast_slot_versions'), before, '範囲外の提案は何も書かない');
  // 入力の確かめ: 局でない取引先・別の組織の取引先・放送用でない商品・初回／再放送・基準日
  assert.match((await propose({months: ['2026-10'], stationPartnerId: cinema})).data.error, /放送局を選んでください/);
  assert.equal((await propose({months: ['2026-10'], stationPartnerId: 4})).status, 400, '別組織の取引先は局の候補に無い');
  assert.match((await propose({months: ['2026-10'], productId: digitalProduct})).data.error, /放送用の商品を選んでください/);
  assert.match((await propose({months: ['2026-10'], runKind: 'first_run'})).data.error, /初回か再放送を選んでください/);
  assert.equal((await propose({months: ['2026-10'], asOf: '2026-02-30'})).status, 400);
  assert.equal((await propose({months: ['2026-10'], memo: 'あ'.repeat(1001)})).status, 400);
  // 提案なし（要確認）の作品からは作れない（放送の権利が無い）
  const blocked = await propose({workId: adminWork, productId: null, months: ['2026-10']}, 'admin');
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /提案なし（要確認）の商品からは下書きを作れません/);
  assert.equal(await count('broadcast_slot_versions'), before);
});

test('権限: 制作担当・閲覧だけの人・案件の権限が無い作品・別組織は作れず、見られる範囲の下書きだけが一覧に出る', async () => {
  const before = await count('broadcast_slot_versions');
  assert.equal((await propose({months: ['2027-08']}, 'production')).status, 403);
  assert.equal((await call('/broadcast/window-proposals/drafts', {as: 'production'})).status, 403);
  const viewer = await propose({months: ['2027-08']}, 'viewer');
  assert.equal(viewer.status, 403);
  assert.match(viewer.data.error, /作品の編集権限がありません/);
  const viewerList = await drafts('viewer');
  assert.ok(viewerList.rows.length > 0, '閲覧だけの人も一覧は見られる');
  assert.ok(viewerList.rows.every((row) => row.can_edit === false && row.can_delete === false));
  const viewerProposal = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`, {as: 'viewer'})).data.rows[0];
  assert.equal(viewerProposal.can_edit, false);
  assert.equal((await propose({workId: adminWork, productId: null, months: ['2027-08']}, 'editor')).status, 403, '案件の権限が無い作品');
  assert.equal((await propose({months: ['2027-08']}, 'outsider')).status, 403, '別組織の作品');
  assert.deepEqual((await drafts('outsider')).rows, [], '別組織の下書きは見えない');
  assert.equal((await call('/broadcast/window-proposals/drafts?workId=1', {as: 'outsider'})).status, 403);
  assert.equal(await count('broadcast_slot_versions'), before);
});

test('削除（合意に至らず）: 下書きのうちだけ理由を書いて削除でき、一覧・履歴表・二重登録の判定から外れ、同じ作品・月・局をもう一度提案できる。誰が・いつ・なぜは残る', async () => {
  const created = await propose({months: ['2027-09']});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const slotId = created.data.slots[0].slotId;
  const history = async () => (await call('/broadcast/history?from=2027-09&to=2027-09', {as: 'editor'})).data.rows.find((row) => row.work_code === 'WRK-DEMO')?.cells['2027-09']?.text || '';
  const inSlotExcel = async (id) => decodeXlsx((await call('/broadcast/export.xlsx?workId=1', {as: 'editor'})).data).some((sheet) => sheet.rows.some((row) => row.some((cell) => String(cell) === String(id))));
  const inHistoryExcel = async (id) => decodeXlsx((await call('/broadcast/history/export.xlsx?from=2027-09&to=2027-09', {as: 'editor'})).data)[1].rows.some((row) => row.some((cell) => String(cell) === String(id)));
  const inOpenApprovals = async (id) => (await call('/broadcast/approvals?scope=open', {as: 'editor'})).data.rows.some((row) => row.slotId === id);
  // 削除の前は、履歴表・放送枠の Excel・途中の枠の一覧・履歴表の Excel に下書きとして出る（外れたことを確かめる前の対照）
  assert.equal(await history(), '架空テレビ（試験）（下書き）');
  assert.deepEqual([await inSlotExcel(slotId), await inHistoryExcel(slotId), await inOpenApprovals(slotId)], [true, true, true]);
  const path = `/broadcast/window-proposals/drafts/${slotId}/delete`;
  assert.equal((await call(path, {method: 'POST', as: 'editor', body: {baseRevision: 1, reason: '  '}})).status, 400, '理由は必須');
  assert.equal((await call(path, {method: 'POST', as: 'editor', body: {baseRevision: 0, reason: '古い画面'}})).status, 409, '版の食い違い');
  assert.equal((await call(path, {method: 'POST', as: 'viewer', body: {baseRevision: 1, reason: '閲覧だけ'}})).status, 403);
  assert.equal((await call(path, {method: 'POST', as: 'production', body: {baseRevision: 1, reason: '制作'}})).status, 403);
  assert.equal((await call(path, {method: 'POST', as: 'outsider', body: {baseRevision: 1, reason: '別組織'}})).status, 404, '別組織の放送枠は無いものとして扱う');
  const r = await call(path, {method: 'POST', as: 'editor', body: {baseRevision: 1, reason: '局の編成と合わず合意に至らなかった'}});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.revision, r.data.deleted], [2, true]);
  // 版は消さず、中止の版を積み、削除の記録（理由・人）を足す
  const versions = await db.all('SELECT revision,status,reason,changed_by FROM broadcast_slot_versions WHERE org_id=1 AND slot_id=? ORDER BY revision', [slotId]);
  assert.deepEqual(versions.map((v) => [v.revision, v.status, v.changed_by]), [[1, 'draft', 2], [2, 'cancelled', 2]]);
  assert.equal(versions[1].reason, '削除（合意に至らず）：局の編成と合わず合意に至らなかった');
  const deletion = await db.get('SELECT * FROM broadcast_proposal_draft_deletions WHERE org_id=1 AND slot_id=?', [slotId]);
  assert.deepEqual([deletion.revision, deletion.reason, deletion.deleted_by], [2, '局の編成と合わず合意に至らなかった', 2]);
  assert.ok(deletion.deleted_at);
  const audit = await db.get("SELECT * FROM audit_log WHERE org_id=1 AND action='delete' AND entity_type='broadcast_slot' AND entity_id=?", [String(slotId)]);
  assert.equal(audit.user_id, 2);
  assert.deepEqual((({from, to, reason, revision, source, month}) => ({from, to, reason, revision, source, month}))(JSON.parse(audit.detail_json)),
    {from: 'draft', to: 'deleted', reason: '局の編成と合わず合意に至らなかった', revision: 2, source: 'window_proposal', month: '2027-09'});
  // 外れる: 放送枠の一覧・Excel・承認待ち（途中の枠）・放送履歴表・提案の同時期の他局
  assert.ok(!(await call('/broadcast?workId=1', {as: 'editor'})).data.slots.some((s) => s.slot_id === slotId), '放送枠の一覧から外れる');
  assert.equal(await inSlotExcel(slotId), false, '放送枠の Excel から外れる');
  assert.equal(await inOpenApprovals(slotId), false, '途中の枠の一覧から外れる');
  assert.equal(await history(), '', '放送履歴表から外れる');
  assert.equal(await inHistoryExcel(slotId), false, '放送履歴表の Excel の放送枠一覧から外れる');
  const proposal = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`, {as: 'editor'})).data.rows[0];
  assert.ok(!proposal.live_slots.some((s) => s.slot_id === slotId), '二重登録の材料（生きている枠）から外れる');
  assert.doesNotMatch(proposal.others_text, /2027年9月/);
  assert.doesNotMatch(proposal.recent_text, /架空テレビ/);
  // 提案から作った下書きの一覧では「削除した下書き」に理由・人・日時つきで残る
  const list = await drafts();
  assert.ok(!list.rows.some((row) => row.slot_id === slotId));
  const gone = list.deleted.find((row) => row.slot_id === slotId);
  assert.deepEqual([gone.deleted, gone.deleted_reason, gone.deleted_by_name, gone.status, gone.can_delete], [true, '局の編成と合わず合意に至らなかった', '編集担当', 'cancelled', false]);
  // もう一度は削除できず、削除した枠は直す・申請することもできない（表のトリガーでも止める）
  assert.equal((await call(path, {method: 'POST', as: 'editor', body: {baseRevision: 2, reason: '二度目'}})).status, 409);
  assert.equal((await call(`/broadcast/slots/${slotId}/transition`, {method: 'POST', as: 'editor', body: {baseRevision: 2, status: 'pending_first'}})).status, 409);
  await assert.rejects(db.run(`INSERT INTO broadcast_slot_versions(org_id,work_id,slot_id,revision,broadcast_month,station_name,period_from,period_to,planned_runs,status,changed_by)
    VALUES(1,1,?,3,'2027-09','架空テレビ（試験）','2027-09-01','2027-09-30',1,'draft',1)`, [slotId]), /deleted as a proposal draft/);
  // 削除した後は、同じ作品・月・局をもう一度提案できる（新しい放送枠になる）
  const again = await propose({months: ['2027-09'], memo: '条件を変えて再提案'});
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.notEqual(again.data.slots[0].slotId, slotId);
  assert.equal(await history(), '架空テレビ（試験）（下書き）');
});

test('下書きでない枠（申請中・確定など）と、提案から作っていない枠は、この画面からは削除できない', async () => {
  const created = await propose({months: ['2027-10']});
  const slotId = created.data.slots[0].slotId;
  const moved = await call(`/broadcast/slots/${slotId}/transition`, {method: 'POST', as: 'editor', body: {baseRevision: 1, status: 'pending_first'}});
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const r = await call(`/broadcast/window-proposals/drafts/${slotId}/delete`, {method: 'POST', as: 'editor', body: {baseRevision: 2, reason: '申請中のもの'}});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /^一次承認待ちの放送枠はこの画面から削除できません（削除できるのは下書きのうちだけ）。放送枠のタブの承認の流れ（差し戻し・中止）で扱ってください$/);
  const row = (await drafts()).rows.find((x) => x.slot_id === slotId);
  assert.deepEqual([row.status, row.can_delete], ['pending_first', false], '一覧には申請中として残り、削除のボタンは出さない');
  // 画面の「放送枠を追加」で作った枠（提案の記録が無い）は、提案の下書きとしては削除しない
  const manual = await ok('/broadcast/slots', {workId: 1, broadcastMonth: '2027-11', stationName: '手入力の局（試験）', periodFrom: '2027-11-01', periodTo: '2027-11-30', plannedRuns: 1}, 'editor');
  assert.equal((await call(`/broadcast/window-proposals/drafts/${manual.slotId}/delete`, {method: 'POST', as: 'editor', body: {baseRevision: 1, reason: '手入力'}})).status, 404);
  // 表の決まり: 削除の記録は、下書きの版の次に積んだ中止の版にだけ付く
  await assert.rejects(db.run("INSERT INTO broadcast_proposal_draft_deletions(org_id,slot_id,revision,reason,deleted_by) VALUES(1,?,2,'直接',1)", [slotId]), /needs a cancelled draft/);
  // 提案の記録は、いま作った下書きの枠（第1版だけ）にだけ付く
  await assert.rejects(db.run(`INSERT INTO broadcast_proposal_drafts(org_id,slot_id,work_id,proposal_key,station_partner_id,broadcast_month,run_kind,as_of,proposal_from,proposal_to,basis_text,created_by)
    VALUES(1,?,1,'x',?,'2027-10','first','2026-09-26','2027-07-01','2028-09-26','直接',1)`, [slotId, tvt]), /needs a new draft slot|UNIQUE|PRIMARY KEY/);
  await assert.rejects(db.run(`INSERT INTO broadcast_proposal_drafts(org_id,slot_id,work_id,proposal_key,station_partner_id,broadcast_month,run_kind,as_of,proposal_from,proposal_to,basis_text,created_by)
    VALUES(1,?,1,'x',?,'2027-11','first','2026-09-26','2027-07-01','2028-09-26','直接',1)`, [manual.slotId, tvt]), /needs a new draft slot/, '取引先がその局でない枠（手入力の枠）には提案の記録を付けられない');
  // 変更・削除は禁止、別組織の行は指せない
  await assert.rejects(db.run("UPDATE broadcast_proposal_drafts SET memo='x'"), /immutable/);
  await assert.rejects(db.run('DELETE FROM broadcast_proposal_drafts'), /immutable/);
  await assert.rejects(db.run("UPDATE broadcast_proposal_draft_deletions SET reason='x'"), /immutable/);
  await assert.rejects(db.run('DELETE FROM broadcast_proposal_draft_deletions'), /immutable/);
  await assert.rejects(db.run(`INSERT INTO broadcast_proposal_drafts(org_id,slot_id,work_id,proposal_key,station_partner_id,broadcast_month,run_kind,as_of,proposal_from,proposal_to,basis_text,created_by)
    VALUES(2,?,1,'x',4,'2027-10','first','2026-09-26','2027-07-01','2028-09-26','別組織',4)`, [slotId]), /FOREIGN KEY|needs a new draft slot/, '別組織から組織1の放送枠は指せない');
});

test('組織の分離: 別組織の人には一覧も提案の下書きも出ず、組織1の人に別組織の下書きは出ない', async () => {
  const mine = await drafts('admin');
  assert.ok(mine.rows.length > 0);
  assert.ok(mine.rows.every((row) => row.work_code === 'WRK-DEMO'));
  const other = await drafts('outsider');
  assert.deepEqual([other.rows, other.deleted], [[], []]);
  assert.ok(other.stations.every((s) => s.name !== '架空テレビ（試験）'), '局の候補も組織の中だけ');
  // 別組織の人が組織1の放送枠IDを指しても削除できない
  const slotId = mine.rows.find((row) => row.status === 'draft').slot_id;
  assert.equal((await call(`/broadcast/window-proposals/drafts/${slotId}/delete`, {method: 'POST', as: 'outsider', body: {baseRevision: 1, reason: '別組織'}})).status, 404);
  assert.equal((await db.get('SELECT COUNT(*) n FROM broadcast_proposal_drafts WHERE org_id=2')).n, 0);
});

// ---- レビュー対応（2026-09-27）: 売上を紐付けた下書き・放送枠のタブで直した下書き・同時の操作・件数の分け方 ----
const SALES_LINKED = '放送報告の売上が紐付いている放送枠は削除できません。放送枠のタブで中止してください（売上突合に「中止枠に売上あり」で残ります）';
let reportSeq = 0;
// 放送報告の売上（架空）。report_imports と sale_lines を1行ずつ入れ、売上IDを返す（broadcast.test.mjs と同じ入れ方）
async function broadcastSale(month, amount) {
  reportSeq += 1;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const report = await db.get(`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by)
    VALUES(1,1,1,?,'broadcast',?,?,?,'架空の放送報告',?,1) RETURNING id`, [`BROADCAST-DRAFT-${reportSeq}`, `${month}-01`, last, month, `draft-sale-${reportSeq}`]);
  const sale = await db.get(`INSERT INTO sale_lines(org_id,project_id,work_id,report_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax)
    VALUES(1,1,1,?,1,?,?,?,'架空の放送料',?,?,?) RETURNING id`, [report.id, `${month}-01`, last, month, amount, amount / 10, amount + amount / 10]);
  return Number(sale.id);
}
const reconcile = async () => (await call('/broadcast/reconciliation?workId=1', {as: 'editor'})).data;
const draftOf = async (slotId) => [...(await drafts()).rows, ...(await drafts()).deleted].find((row) => row.slot_id === slotId);

test('売上を紐付けた下書き: 削除できず（API・表のトリガー）、中止にすると売上突合に「中止枠に売上あり」で金額ごと残る。同じ売上をほかの枠へは紐付けられない', async () => {
  const created = await propose({months: ['2027-12']});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const slotId = created.data.slots[0].slotId;
  const amount = 200000;
  const saleId = await broadcastSale('2027-12', amount);
  assert.ok((await reconcile()).surplus.some((sale) => sale.id === saleId), '紐付ける前は未紐付けの売上');
  const link = await call(`/broadcast/slots/${slotId}/sales`, {method: 'POST', as: 'editor', body: {saleId}});
  assert.equal(link.status, 201, JSON.stringify(link.data));
  // 一覧: 売上ありの下書きは削除のボタンを出さない
  const row = await draftOf(slotId);
  assert.deepEqual([row.status, row.has_sales, row.can_delete], ['draft', true, false]);
  // API: 削除は 409（理由を書いても）で、版も削除の記録も増えない
  const versions = await count('broadcast_slot_versions', 'org_id=1 AND slot_id=?', [slotId]);
  const refused = await call(`/broadcast/window-proposals/drafts/${slotId}/delete`, {method: 'POST', as: 'editor', body: {baseRevision: 1, reason: '合意に至らず'}});
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, SALES_LINKED);
  assert.equal(await count('broadcast_slot_versions', 'org_id=1 AND slot_id=?', [slotId]), versions);
  assert.equal(await count('broadcast_proposal_draft_deletions', 'org_id=1 AND slot_id=?', [slotId]), 0);
  // 突合: 下書きの行に売上が残り、未紐付けには出ない（金額は入れた売上そのもの）
  let r = await reconcile();
  let line = r.rows.find((x) => x.slot_id === slotId);
  assert.deepEqual([line.status, line.linked_amount_ex_tax, line.reconciliation], ['draft', amount, 'linked']);
  assert.ok(!r.surplus.some((sale) => sale.id === saleId));
  // 同じ売上をほかの枠（同じ月の別の局）へ紐付けると、日本語の 409
  const other = await propose({months: ['2027-12'], stationPartnerId: pt2});
  assert.equal(other.status, 201, JSON.stringify(other.data));
  const twice = await call(`/broadcast/slots/${other.data.slots[0].slotId}/sales`, {method: 'POST', as: 'editor', body: {saleId}});
  assert.equal(twice.status, 409);
  assert.equal(twice.data.error, 'この売上はすでに別の放送枠に紐付いています');
  // 放送枠のタブで中止にすると、突合に「中止枠に売上あり」で金額ごと残る
  const cancel = await call(`/broadcast/slots/${slotId}/transition`, {method: 'POST', as: 'editor', body: {baseRevision: 1, status: 'cancelled', reason: '合意に至らず（売上あり）'}});
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  r = await reconcile();
  line = r.rows.find((x) => x.slot_id === slotId);
  assert.deepEqual([line.status, line.linked_amount_ex_tax, line.reconciliation], ['cancelled', amount, 'cancelled_linked']);
  assert.ok(!r.surplus.some((sale) => sale.id === saleId));
  // 表の決まり: 下書きの次の中止の版でも、売上を紐付けた枠には削除の記録を付けられない
  await assert.rejects(db.run("INSERT INTO broadcast_proposal_draft_deletions(org_id,slot_id,revision,reason,deleted_by) VALUES(1,?,2,'直接',2)", [slotId]), /needs a cancelled draft/);
  // 対照: 売上の無い下書きを中止にした枠なら、同じ形の削除の記録が付く（止まったのは売上のため）。付いた後は、その枠に売上を紐付けられない
  const plain = await propose({months: ['2028-01']});
  const plainId = plain.data.slots[0].slotId;
  assert.equal((await call(`/broadcast/slots/${plainId}/transition`, {method: 'POST', as: 'editor', body: {baseRevision: 1, status: 'cancelled', reason: '対照'}})).status, 200);
  await db.run("INSERT INTO broadcast_proposal_draft_deletions(org_id,slot_id,revision,reason,deleted_by) VALUES(1,?,2,'対照（直接）',2)", [plainId]);
  const lateSale = await broadcastSale('2028-01', 50000);
  await assert.rejects(db.run('INSERT INTO broadcast_sale_links(org_id,work_id,slot_id,sale_id,created_by) VALUES(1,1,?,?,2)', [plainId, lateSale]), /deleted as a proposal draft/);
});

test('放送枠のタブで直した下書き: 局・種別・月は放送枠の今の内容で出し、直した印と提案したときの局・月を返す。独占の月へ移すと要確認', async () => {
  const created = await propose({months: ['2028-02']});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const slotId = created.data.slots[0].slotId;
  const patch = async (revision, body) => {
    const r = await call(`/broadcast/slots/${slotId}`, {method: 'PATCH', as: 'editor', body: {baseRevision: revision, ...body}});
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  // 局名だけを「架空配信」（取引先2・局の種別は BS）へ直す。取引先（売上の相手）は元の局（架空テレビ・地上波）のまま残る
  await patch(1, {stationName: '架空配信'});
  const slotVersion = await db.get('SELECT station_name, customer_partner_id FROM broadcast_slot_versions WHERE org_id=1 AND slot_id=? AND revision=2', [slotId]);
  assert.deepEqual([slotVersion.station_name, slotVersion.customer_partner_id], ['架空配信', tvt], '売上の相手は元の局のまま');
  let row = await draftOf(slotId);
  // 局と種別は今の局名の放送局から引く（売上の相手の局の種別「地上波」を出さない）
  assert.deepEqual([row.station_name, row.station_type, row.station_partner_id, row.proposed_station_partner_id, row.proposed_station_name, row.proposed_month],
    ['架空配信', 'bs', pt2, tvt, '架空テレビ（試験）', '2028-02']);
  assert.deepEqual([row.changed_after_proposal, row.outside_proposal, row.needs_check], [true, false, false]);
  // 局名のゆれ（全角・空白）でも同じ局として引く
  await patch(2, {stationName: ' 架空配信 '.replace('架空', '架　空')});
  row = await draftOf(slotId);
  assert.deepEqual([row.station_type, row.station_partner_id], ['bs', pt2]);
  await patch(3, {stationName: '架空配信', customerPartnerId: pt2});
  row = await draftOf(slotId);
  assert.deepEqual([row.station_name, row.station_type, row.station_partner_id], ['架空配信', 'bs', pt2]);
  // 局の種別を登録していない局名・取引先なしへ直すと、種別は未登録（元の局の種別を出さない）
  await patch(4, {stationName: '未登録の局（試験）', customerPartnerId: ''});
  row = await draftOf(slotId);
  assert.deepEqual([row.station_name, row.station_type, row.station_partner_id, row.changed_after_proposal], ['未登録の局（試験）', null, null, true]);
  // 月を独占（架空配信 2027/01/01〜2027/06/30）の 2027-02 へ移すと、提案したときの期間の外・要確認（理由つき）
  await patch(5, {broadcastMonth: '2027-02', periodFrom: '2027-02-01', periodTo: '2027-02-28'});
  row = await draftOf(slotId);
  assert.deepEqual([row.broadcast_month, row.proposal_from, row.proposal_to, row.outside_proposal, row.needs_check], ['2027-02', '2027-07-01', '2028-09-26', true, true]);
  assert.match(row.check_reason, /^2027年2月は提案する期間の外です（独占契約中（架空配信・2027\/01\/01〜2027\/06\/30）・ホールドバック（架空配信・3か月・2027\/01\/01〜2027\/03\/31））$/);
  // ほかの行（直していない行）は、どの印も付かない
  const others = (await drafts()).rows.filter((x) => x.slot_id !== slotId && x.status !== 'cancelled');
  assert.ok(others.length > 3);
  assert.ok(others.every((x) => !x.changed_after_proposal && !x.outside_proposal && !x.needs_check), JSON.stringify(others.filter((x) => x.changed_after_proposal || x.needs_check).map((x) => x.slot_id)));
});

// 2つの要求が読み終えてから書く順を作る（本番の D1 で起きる順）。最初に batch へ来た要求は、2つ目が来るまで待ってから書く
function pairBatches() {
  const original = db.batch.bind(db);
  let release, n = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  db.batch = async (statements) => {
    n += 1;
    if (n === 1) { await gate; return original(statements); }
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return original(statements);
  };
  return () => { db.batch = original; };
}

test('同時の操作: 同じ下書きの削除・同じ月と局への提案で負けた側は、その操作に合った文言の 409。削除と申請が重なったら申請側に「削除されています」', async () => {
  // 同じ下書きを2人が同時に削除する
  const a = await propose({months: ['2028-03']});
  const slotA = a.data.slots[0].slotId;
  let restore = pairBatches();
  const deletes = await Promise.all([
    call(`/broadcast/window-proposals/drafts/${slotA}/delete`, {method: 'POST', as: 'editor', body: {baseRevision: 1, reason: '合意に至らず（1）'}}),
    call(`/broadcast/window-proposals/drafts/${slotA}/delete`, {method: 'POST', as: 'admin', body: {baseRevision: 1, reason: '合意に至らず（2）'}}),
  ]);
  restore();
  assert.deepEqual(deletes.map((r) => r.status).sort(), [200, 409]);
  assert.equal(deletes.find((r) => r.status === 409).data.error, '確かめた後に、別の人がこの下書きを直したか、売上を紐付けたか、削除しました。読み直してください');
  assert.equal(await count('broadcast_slot_versions', 'org_id=1 AND slot_id=?', [slotA]), 2);
  assert.equal(await count('broadcast_proposal_draft_deletions', 'org_id=1 AND slot_id=?', [slotA]), 1);
  // 同じ作品・月・局へ2人が同時に提案する
  restore = pairBatches();
  const proposals = await Promise.all([propose({months: ['2028-04']}), propose({months: ['2028-04']}, 'admin')]);
  restore();
  assert.deepEqual(proposals.map((r) => r.status).sort(), [201, 409]);
  assert.equal(proposals.find((r) => r.status === 409).data.error, '確かめた後に、別の人が同じ作品の放送枠を登録・更新しました。読み直してからもう一度提案してください');
  assert.equal(await count('broadcast_slot_versions', "org_id=1 AND work_id=1 AND broadcast_month='2028-04'"), 1);
  // 削除と「一次承認を申請」が同時: 勝ったほうが書き、負けたほうは相手の操作に合った文言
  const b = await propose({months: ['2028-05']});
  const slotB = b.data.slots[0].slotId;
  restore = pairBatches();
  const [removed, submitted] = await Promise.all([
    call(`/broadcast/window-proposals/drafts/${slotB}/delete`, {method: 'POST', as: 'editor', body: {baseRevision: 1, reason: '合意に至らず'}}),
    call(`/broadcast/slots/${slotB}/transition`, {method: 'POST', as: 'admin', body: {baseRevision: 1, status: 'pending_first'}}),
  ]);
  restore();
  assert.deepEqual([removed.status, submitted.status].sort(), [200, 409]);
  if (removed.status === 200) assert.equal(submitted.data.error, 'この放送枠は放送ウィンドウ提案の下書きとして削除されています。同じ作品・月・局は提案から作り直してください');
  else assert.equal(removed.data.error, '確かめた後に、別の人がこの下書きを直したか、売上を紐付けたか、削除しました。読み直してください');
  assert.equal(await count('broadcast_slot_versions', 'org_id=1 AND slot_id=?', [slotB]), 2);
});

test('件数の分け方: 下書き・申請中〜確定・差し戻し・中止・削除した下書きに分け、申請せずに中止した枠は「申請中〜確定」に数えない。中止・差し戻しの削除は状態に合った文言', async () => {
  const created = await propose({months: ['2028-06']});
  const cancelledId = created.data.slots[0].slotId;
  assert.equal((await call(`/broadcast/slots/${cancelledId}/transition`, {method: 'POST', as: 'editor', body: {baseRevision: 1, status: 'cancelled', reason: '申請せずに中止'}})).status, 200);
  const rejectedId = (await propose({months: ['2028-07']})).data.slots[0].slotId;
  assert.equal((await call(`/broadcast/slots/${rejectedId}/transition`, {method: 'POST', as: 'editor', body: {baseRevision: 1, status: 'pending_first'}})).status, 200);
  assert.equal((await call(`/broadcast/slots/${rejectedId}/transition`, {method: 'POST', as: 'admin', body: {baseRevision: 2, status: 'rejected', reason: '条件を見直す'}})).status, 200);
  const list = await drafts();
  // 期待値は DB から別に数える（提案の記録ごとに放送枠の最新版の状態。削除の記録がある枠は「削除した下書き」）
  const latest = await db.all(`SELECT v.status, EXISTS(SELECT 1 FROM broadcast_proposal_draft_deletions x WHERE x.org_id=d.org_id AND x.slot_id=d.slot_id) AS deleted
    FROM broadcast_proposal_drafts d JOIN broadcast_slot_versions v ON v.org_id=d.org_id AND v.slot_id=d.slot_id
      AND v.revision=(SELECT MAX(z.revision) FROM broadcast_slot_versions z WHERE z.org_id=d.org_id AND z.slot_id=d.slot_id)
    WHERE d.org_id=1`);
  const live = latest.filter((x) => !Number(x.deleted));
  const of = (...statuses) => live.filter((x) => statuses.includes(x.status)).length;
  assert.deepEqual(list.counts, {drafts: of('draft'), inFlow: of('pending_first', 'tentative', 'pending_final', 'confirmed'), rejected: of('rejected'), cancelled: of('cancelled'),
    deleted: latest.length - live.length});
  assert.ok(list.counts.cancelled >= 1 && list.counts.rejected >= 1 && list.counts.inFlow >= 1);
  // 申請せずに中止した枠は、中止として一覧に残り、削除のボタンは出ない。削除は中止の文言の 409
  const cancelled = list.rows.find((x) => x.slot_id === cancelledId);
  assert.deepEqual([cancelled.status, cancelled.can_delete, cancelled.needs_check], ['cancelled', false, false]);
  let r = await call(`/broadcast/window-proposals/drafts/${cancelledId}/delete`, {method: 'POST', as: 'editor', body: {baseRevision: 2, reason: '消したい'}});
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '中止の放送枠は削除できません（中止のまま一覧に残ります）');
  r = await call(`/broadcast/window-proposals/drafts/${rejectedId}/delete`, {method: 'POST', as: 'editor', body: {baseRevision: 3, reason: '消したい'}});
  assert.equal(r.status, 409);
  assert.equal(r.data.error, '差し戻しの放送枠はこの画面から削除できません。放送枠のタブで直して申請し直すか、中止にしてください');
});

test('合意して確定まで進めた枠に、その合意の契約（同じ局・独占）を取引先別リストへ入れても要確認にしない。ほかの局の独占の契約は確定の枠でも要確認', async () => {
  const created = await propose({months: ['2028-08']});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const slotId = created.data.slots[0].slotId;
  const step = async (revision, status, as) => {
    const r = await call(`/broadcast/slots/${slotId}/transition`, {method: 'POST', as, body: {baseRevision: revision, status}});
    assert.equal(r.status, 200, `${status}: ${JSON.stringify(r.data)}`);
  };
  await step(1, 'pending_first', 'editor');
  await step(2, 'tentative', 'admin');
  await step(3, 'pending_final', 'editor');
  await step(4, 'confirmed', 'admin');
  // 合意の契約: 架空テレビ（試験）の独占 2028/08/01〜2028/08/31（取引先別リストの放送の明細・契約済）
  const values = (extra) => ({territory: '日本', source_reference: '架空の許諾書', distribution_code: 'B001', end_rule: 'date', exclusivity: 'exclusive', status: 'contracted', ...extra});
  const ownList = await ok('/partner-lists', {partnerId: tvt, listKind: 'distribution', name: '放送の許諾（架空テレビ・試験）', reason: '合意の契約'});
  await ok(`/partner-lists/${ownList.id}/entries`, {workId: 1, values: values({contract_start: '2028-08-01', contract_end: '2028-08-31'}), reason: '試験'});
  let row = await draftOf(slotId);
  assert.deepEqual([row.status, row.station_name, row.outside_proposal, row.needs_check, row.check_reason], ['confirmed', '架空テレビ（試験）', false, false, null]);
  // 対照: 局を指定しない提案（画面の提案）では、その契約が 2028年8月を塞ぐ（契約は計算に入っている）
  const proposal = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`, {as: 'editor'})).data.rows.find((r) => r.product_id === product);
  assert.match(proposal.blocked_text, /2028\/08\/01〜2028\/08\/31 架空テレビ（試験）（独占）/);
  // ほかの局（架空配信）の独占の契約が同じ月に重なると、確定の枠でも要確認。理由はほかの局の契約だけ（同じ局の合意の契約は出さない）
  const otherList = await ok('/partner-lists', {partnerId: pt2, listKind: 'distribution', name: '放送の許諾（架空配信・後から）', reason: '試験'});
  await ok(`/partner-lists/${otherList.id}/entries`, {workId: 1, values: values({contract_start: '2028-08-15', contract_end: '2028-09-30'}), reason: '試験'});
  row = await draftOf(slotId);
  assert.deepEqual([row.status, row.needs_check], ['confirmed', true]);
  assert.equal(row.check_reason, '2028年8月は提案する期間の外です（独占契約中（架空配信・2028/08/15〜2028/09/30））');
});
