// 製作委員会の契約の型・式・日程・台帳の受け口（src/committee/ledger/committee-ledger-routes.mjs）を、権限と DB と合わせて確かめる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。期待値は test/committee-ledger-model.test.mjs と同じ、実装と別に計算した値。
// 架空のデータだけを使う（組織1・2と利用者1〜4・試作の作品1・取引先1〜3は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

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

async function fictionalCommittee(db) {
  const intake = Number((await db.get(`INSERT INTO rights_intake_cases(org_id,project_id,work_id,case_code,title,intake_type,created_by)
    VALUES(1,1,1,'FIC-COMM-I','架空の委員会','committee',1) RETURNING id`)).id);
  const doc = Number((await db.get("INSERT INTO rights_intake_documents(org_id,intake_case_id,title,reference) VALUES(1,?,'架空の委員会契約','FICT-DOC') RETURNING id", [intake])).id);
  const contract = Number((await db.get(`INSERT INTO committee_contracts(org_id,project_id,work_id,intake_case_id,document_id,contract_code,title,created_by)
    VALUES(1,1,1,?,?,'FIC-COMM','架空の委員会「星の港」',1) RETURNING id`, [intake, doc])).id);
  const term = Number((await db.get("INSERT INTO committee_term_versions(org_id,contract_id,version_no,calculation_version,created_by) VALUES(1,?,1,'committee-v3-business-rights',1) RETURNING id", [contract])).id);
  const M = Number((await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(1,'FIC-M','架空M社','other') RETURNING id")).id);
  return {contract, term, p: {K: 1, L: 2, SELF: 3, M}};
}

// 第2回の報告書（架空。test/committee-ledger-model.test.mjs の report2 と同じ数字。相手は取引先の ID、事業化権利は表の語）
function report2(p) {
  const rights = (a, b, c) => [{holderRole: 'original', amountYen: a}, {holderRole: 'director', amountYen: b}, {holderRole: 'screenplay', amountYen: c}];
  return {
    businesses: [
      {business: 'theatrical', income: [{amountYen: 200000}], agent_fee: [{amountYen: 40000, counterparty: p.K}]},
      {business: 'home_video', income: [{amountYen: 400000}], secondary_royalty: rights(15000, 6000, 6000), agent_fee: [{amountYen: 111900, counterparty: p.SELF}]},
      {business: 'internet', income: [{amountYen: 2000000}], secondary_royalty: rights(60000, 30000, 30000), agent_fee: [{amountYen: 400000, counterparty: p.K}]},
      {business: 'tv', income: [{amountYen: 1500000}], secondary_royalty: rights(60000, 30000, 30000), agent_fee: [{amountYen: 300000, counterparty: p.L}]},
    ],
    overhead: [{amountYen: 1000, item: '振込手数料'}],
    manager_fee: [{amountYen: 149005, counterparty: p.K}],
    success_fee: [{amountYen: 225029, counterparty: p.K}],
    member_distribution: [{counterparty: p.K, amountYen: 1303033}, {counterparty: p.L, amountYen: 651517}, {counterparty: p.SELF, amountYen: 325758}, {counterparty: p.M, amountYen: 325758}],
  };
}

test('FR-SETL-COMM-024 制作担当と別の組織には、契約の有無を見せず同じ 403 を返す', async (t) => {
  const db = await openTestDb({t});
  const {contract} = await fictionalCommittee(db);
  const {login, call} = await appWithLogin(db);
  const production = await login('production@openingnight.invalid');
  const outsider = await login('outsider@other.invalid');
  for (const cookie of [production, outsider]) {
    assert.equal((await call(cookie, `/committee/ledger/contracts/${contract}`)).status, 403);
    assert.equal((await call(cookie, `/committee/ledger/contracts/999999`)).status, 403);
    assert.equal((await call(cookie, `/committee/ledger/contracts/${contract}/rounds/received`, {method: 'POST', payload: {}})).status, 403);
  }
  assert.equal((await call(production, '/committee/ledger/templates')).status, 403);
});

test('FR-SETL-COMM-025 FR-SETL-COMM-026 届いた報告書を受け口から台帳に入れ、契約の画面のデータに日程の回と収支報告書と累計が出る', async (t) => {
  const db = await openTestDb({t});
  const {contract, term, p} = await fictionalCommittee(db);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const tpl = await call(admin, '/committee/ledger/templates', {method: 'POST', payload: {code: 'STD-JOINT', name: '標準の共同製作', body: {kind: 'joint'}, reason: '架空の種'}});
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
  const formula = await call(admin, `/committee/ledger/contracts/${contract}/formula`, {method: 'POST', payload: {termVersionId: term, templateId: tpl.body.template.id,
    businesses: [{code: 'theatrical', operatorPartnerId: p.K, steps: [{kind: 'agent_fee', rateBps: 2000, base: 'income'}]}],
    committeeSteps: [{kind: 'overhead', label: '振込手数料'}, {kind: 'manager_fee', recipientPartnerId: p.K, rateBps: 500, base: 'remaining'}],
    budgetLines: [{item: 'production', amountYen: 70000000, taxBasis: 'ex_tax'}, {item: 'pa', amountYen: 30000000, taxBasis: 'ex_tax'}]}});
  assert.equal(formula.status, 201, JSON.stringify(formula.body));
  const schedule = await call(admin, `/committee/ledger/contracts/${contract}/schedule-versions`, {method: 'POST', payload: {effectiveFrom: '2031-01-01', baseKind: 'release', baseDate: '2031-05-01',
    reason: '架空の契約の別紙', phases: [{tier: 'to_members', fromYear: 1, toYear: null, closeMonths: [2, 5, 8, 11], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, holidayRule: 'previous_business_day'}]}});
  assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
  const posted = await call(admin, `/committee/ledger/contracts/${contract}/rounds/received`, {method: 'POST', payload: {tier: 'to_members', closeOn: '2031-11-30', report: report2(p)}});
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const view = await call(admin, `/committee/ledger/contracts/${contract}?asOf=2031-12-01&until=2032-03-31`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual(view.body.rounds.to_members.map((r) => [r.closeOn, r.payOn]), [['2031-05-31', '2031-08-29'], ['2031-08-31', '2031-11-28'], ['2031-11-30', '2032-02-27'], ['2032-02-29', '2032-05-31']]);
  assert.equal(view.body.closeOn, '2031-11-30');
  assert.equal(view.body.investmentTotalYen, 100000000);
  assert.deepEqual(view.body.statement.D, {prior: 0, current: 2606066, cumulative: 2606066});
  assert.deepEqual(view.body.cumulatives.members.find((m) => m.key === p.SELF), {key: p.SELF, prior: 0, current: 325758, cumulative: 325758});
  assert.equal(view.body.formula.businesses[0].steps[0].rateBps, 2000);
  // 同じ回をもう一度入れると 409、配分の和が合わない報告書は 400 で差を返す
  assert.equal((await call(admin, `/committee/ledger/contracts/${contract}/rounds/received`, {method: 'POST', payload: {tier: 'to_members', closeOn: '2031-11-30', report: report2(p)}})).status, 409);
  const broken = report2(p);
  broken.member_distribution[0].amountYen += 600;
  const unbalanced = await call(admin, `/committee/ledger/contracts/${contract}/rounds/received`, {method: 'POST', payload: {tier: 'to_members', closeOn: '2032-02-29', report: broken}});
  assert.equal(unbalanced.status, 400);
  assert.deepEqual(unbalanced.body.details, {code: 'committee_report_unbalanced', diffYen: 600});
});

test('FR-SETL-COMM-025 報告書の前回まで累計が台帳と合わなければ 409 で止め、取り消すと入れ直せる', async (t) => {
  const db = await openTestDb({t});
  const {contract, p} = await fictionalCommittee(db);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const first = await call(admin, `/committee/ledger/contracts/${contract}/rounds/received`, {method: 'POST', payload: {tier: 'to_members', closeOn: '2031-11-30', report: report2(p)}});
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const next = (prior) => call(admin, `/committee/ledger/contracts/${contract}/rounds/received`, {method: 'POST', payload: {tier: 'to_members', closeOn: '2032-02-29', report: report2(p),
    reportedPrior: [{business: 'theatrical', section: 'agent_fee', priorYen: prior}]}});
  const ng = await next(41000);
  assert.equal(ng.status, 409);
  assert.deepEqual(ng.body.details.checks.map((x) => [x.ledgerYen, x.diffYen]), [[40000, 1000]]);
  assert.equal((await next(40000)).status, 201);
  const reversed = await call(admin, `/committee/ledger/contracts/${contract}/rounds/reverse`, {method: 'POST', payload: {tier: 'to_members', closeOn: '2032-02-29', reason: '幹事の訂正版（架空）'}});
  assert.equal(reversed.status, 201, JSON.stringify(reversed.body));
  assert.equal((await next(40000)).status, 201);
  const view = await call(admin, `/committee/ledger/contracts/${contract}?asOf=2032-03-01`);
  assert.deepEqual(view.body.statement.D, {prior: 2606066, current: 2606066, cumulative: 5212132});
});
