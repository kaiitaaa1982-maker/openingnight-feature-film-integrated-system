// 調達（移行 0052。会社ルートの plans/2026-10-24-folder-chotatsu.md）を、受け口と DB の制約で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 架空のデータだけを使う（組織1・2と利用者・試作の案件と作品は試作の行。取引先はこの試験で足す）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {estimateTotals, materialDueDate, stageStates} from '../src/acquisition/chotatsu/chotatsu-model.mjs';

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    const type = response.headers.get('content-type') || '';
    return {status: response.status, body: type.includes('json') ? await response.json() : await response.arrayBuffer()};
  };
  return {login, call};
}
const rejects = (promise, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), 'raise', error.message);
  assert.match(error.message, message);
  return true;
});

async function fixtures(db) {
  const partner = await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(1,'CH-HOLDER','架空の権利元','other') RETURNING id");
  const work = await db.get('SELECT id,project_id FROM works WHERE org_id=1 ORDER BY id LIMIT 1');
  return {holderId: Number(partner.id), workId: Number(work.id)};
}

test('調達の計算: 粗利の見込み（率は切り捨て）と素材の期限（発売月の3か月前の20日）', () => {
  assert.deepEqual(estimateTotals({quantity: 1200, unitRevenueExTaxYen: 2280, royaltyKind: 'rate', royaltyRateBps: 2000}, [{amountExTaxYen: 980000}]),
    {revenueYen: 2736000, costYen: 980000, royaltyYen: 547200, grossYen: 1208800});
  assert.equal(estimateTotals({quantity: 3, unitRevenueExTaxYen: 1001, royaltyKind: 'rate', royaltyRateBps: 3333}, []).royaltyYen, 1000);
  assert.equal(estimateTotals({quantity: 10, unitRevenueExTaxYen: 100, royaltyKind: 'per_unit', royaltyPerUnitYen: 15}, []).grossYen, 850);
  assert.equal(materialDueDate({releaseMonth: '2027-05'}), '2027-02-20');
  assert.equal(materialDueDate({releaseMonth: '2027-02'}), '2026-11-20');
  assert.equal(materialDueDate({releaseMonth: null}), null);
  const late = stageStates({estimates: [{}], agreements: [{}], ringi: [{result: 'approved'}], contract: {}, materials: [{seq: 1, materialKind: 'master', required: true,
    checkResult: 'pending'}], handoffs: [], events: [], today: '2027-02-21', releaseMonth: '2027-05'});
  assert.equal(late.states.materials, 'late');
});

test('調達の一周: 希望→試算→合意→稟議→契約（調達案件と配給委託の契約を作る）→素材→予告→受領。段の順番を飛ばせず、制作担当と別の組織は入れない', async (t) => {
  const db = await openTestDb({t});
  const {holderId, workId} = await fixtures(db);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');

  const created = await call(admin, '/chotatsu/cases', {method: 'POST', payload: {title: '架空の灯台', holderPartnerId: holderId, mediaFamily: 'videogram',
    releaseMonth: '2099-05', releaseSlot: 'first_wed', offerUntil: '2099-01-31'}});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.caseId;
  const path = (entry = '') => `/chotatsu/cases/${id}${entry}`;
  let detail = (await call(admin, path())).body;
  assert.deepEqual(detail.stages, {wish: 'done', estimate: 'now', agreement: 'todo', ringi: 'todo', contract: 'todo', materials: 'todo', handoff: 'todo'});

  // 試算の前に稟議は置けない（合意が無い）
  const early = await call(admin, path('/ringi'), {method: 'POST', payload: {estimateVersionNo: 1, result: 'approved', resultOn: '2098-12-01'}});
  assert.equal(early.status, 409);
  // MG の型は持てない
  const mg = await call(admin, path('/estimates'), {method: 'POST', payload: {format: 'sell_dvd', unitRevenueExTaxYen: 2000, quantity: 10, royaltyKind: 'mg'}});
  assert.equal(mg.status, 400);
  const estimate = await call(admin, path('/estimates'), {method: 'POST', payload: {format: 'sell_dvd', setCount: 1, listPriceExTaxYen: 3800, unitRevenueExTaxYen: 2280,
    quantity: 1200, royaltyKind: 'rate', royaltyRateBps: 2000, lines: [{expenseType: 'ビデオ製造費', name: 'プレス・印刷', amountExTaxYen: 980000}]}});
  assert.equal(estimate.status, 201, JSON.stringify(estimate.body));
  assert.equal((await call(admin, path('/agreements'), {method: 'POST', payload: {estimateVersionNo: 1, agreedOn: '2098-11-01'}})).status, 201);
  assert.equal((await call(admin, path('/ringi'), {method: 'POST', payload: {estimateVersionNo: 1, result: 'approved', resultOn: '2098-11-10'}})).status, 201);
  detail = (await call(admin, path())).body;
  assert.equal(detail.estimates[0].totals.grossYen, 1208800);
  assert.equal(detail.stages.contract, 'now');
  assert.equal(detail.canNotice, false);

  // 素材は契約のあと
  assert.equal((await call(admin, path('/materials'), {method: 'POST', payload: {materialKind: 'master', checkResult: 'pending'}})).status, 409);
  const contract = await call(admin, path('/contract'), {method: 'POST', payload: {workId, signedOn: '2098-12-01', scopes: [{channel: 'ビデオグラム（セル・レンタル）',
    territory: '日本', rightsStart: '2098-12-01', rightsEnd: '2105-11-30', exclusivity: 'exclusive'}], terms: {agencyFeeBps: 3000}}});
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  const intake = await db.get("SELECT id,intake_type FROM rights_intake_cases WHERE org_id=1 AND case_code=?", [`${created.body.caseCode}-R`]);
  assert.equal(intake.intake_type, 'entrusted');
  const settlement = await db.get('SELECT contract_type,holder_partner_id FROM settlement_contracts WHERE org_id=1 AND contract_code=?', [`${created.body.caseCode}-S`]);
  assert.deepEqual([settlement.contract_type, Number(settlement.holder_partner_id)], ['commission', holderId]);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM intake_settlement_links WHERE org_id=1 AND intake_case_id=?', [intake.id])).n), 1);
  assert.equal((await call(admin, path('/contract'), {method: 'POST', payload: {workId, signedOn: '2098-12-01', scopes: [{channel: 'セル'}], terms: {agencyFeeBps: 1}}})).status, 409);

  detail = (await call(admin, path())).body;
  assert.equal(detail.canNotice, true);
  assert.equal(detail.checks.every((x) => x.ok), true, JSON.stringify(detail.checks));
  assert.equal((await call(admin, path('/handoffs'), {method: 'POST', payload: {action: 'received'}})).status, 409);
  assert.equal((await call(admin, path('/handoffs'), {method: 'POST', payload: {action: 'notice'}})).status, 201);
  detail = (await call(admin, path())).body;
  assert.equal(detail.stages.handoff, 'notice');
  assert.equal(detail.handoffs[0].state, 'notice');
  assert.equal(detail.canReceive, false);
  // 製造が読む入口
  const handoffs = (await call(admin, '/chotatsu/handoffs')).body.handoffs;
  assert.deepEqual([handoffs.length, handoffs[0].state, handoffs[0].releaseMonth, handoffs[0].allowedFormats[0]], [1, 'notice', '2099-05', 'sell_dvd']);

  assert.equal((await call(admin, path('/materials'), {method: 'POST', payload: {materialKind: 'master', receivedOn: '2099-01-10', checkResult: 'ng'}})).status, 201);
  assert.equal((await call(admin, path())).body.canReceive, false);
  assert.equal((await call(admin, path('/materials'), {method: 'POST', payload: {materialKind: 'master', receivedOn: '2099-01-12', checkResult: 'ok'}})).status, 201);
  detail = (await call(admin, path())).body;
  assert.equal(detail.stages.materials, 'done');
  assert.equal(detail.canReceive, true);
  assert.equal((await call(admin, path('/handoffs'), {method: 'POST', payload: {action: 'received'}})).status, 201);
  detail = (await call(admin, path())).body;
  assert.equal(detail.stages.handoff, 'done');
  assert.deepEqual(detail.folder, {state: 'done', done: 3, total: 3, reason: '済'});

  const list = (await call(admin, '/chotatsu/cases')).body;
  assert.equal(list.cases.length, 1);
  assert.equal(list.cases[0].grossYen, 1208800);

  // 制作担当は入れない
  const production = await login('production@openingnight.invalid');
  assert.equal((await call(production, '/chotatsu/cases')).status, 403);

  // DB も断る: 記録の書き換え、契約の無い引き渡し、予告の前の受領
  await rejects(db.run('UPDATE chotatsu_estimates SET quantity=1 WHERE org_id=1'), /immutable/);
  await rejects(db.run('DELETE FROM chotatsu_case_versions WHERE org_id=1'), /immutable/);
});

test('見送りで閉じた案件には書けず、取消で戻せる。原本を置くと共通の原本の表に入り、同じ中身は二重にならない', async (t) => {
  const db = await openTestDb({t});
  const {holderId} = await fixtures(db);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const created = await call(admin, '/chotatsu/cases', {method: 'POST', payload: {title: '架空の水槽', holderPartnerId: holderId, mediaFamily: 'videogram'}});
  const path = (entry = '') => `/chotatsu/cases/${created.body.caseId}${entry}`;
  const base64 = Buffer.from('架空の見積書').toString('base64');
  const doc = await call(admin, path('/documents'), {method: 'POST', payload: {docKind: 'estimate', fileName: '見積_架空.pdf', mediaType: 'application/pdf', base64}});
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
  const again = await call(admin, path('/documents'), {method: 'POST', payload: {docKind: 'estimate', fileName: '見積_架空2.pdf', base64}});
  assert.deepEqual([again.body.duplicate, again.body.linked], [true, false]);
  const download = await call(admin, path(`/documents/${doc.body.sourceDocumentId}`));
  assert.equal(Buffer.from(download.body).toString(), '架空の見積書');

  assert.equal((await call(admin, path('/events'), {method: 'POST', payload: {event: 'dropped'}})).status, 400);
  assert.equal((await call(admin, path('/events'), {method: 'POST', payload: {event: 'dropped', reason: '架空の見送り'}})).status, 201);
  let detail = (await call(admin, path())).body;
  assert.equal(detail.closed.event, 'dropped');
  assert.equal(detail.stages.estimate, 'stop');
  const blocked = await call(admin, path('/estimates'), {method: 'POST', payload: {format: 'sell_dvd', unitRevenueExTaxYen: 1, quantity: 1, royaltyKind: 'none'}});
  assert.equal(blocked.status, 409);
  await rejects(db.run("INSERT INTO chotatsu_stage_events(org_id,case_id,seq,stage,event,on_date,created_by) VALUES(1,?,3,'estimate','done','2099-01-01',1)", [created.body.caseId]),
    /closed/);
  assert.equal((await call(admin, path('/events'), {method: 'POST', payload: {event: 'void', voidsSeq: detail.closed.seq, reason: '架空の取消'}})).status, 201);
  detail = (await call(admin, path())).body;
  assert.equal(detail.closed, null);
  assert.equal(detail.stages.estimate, 'now');
});
