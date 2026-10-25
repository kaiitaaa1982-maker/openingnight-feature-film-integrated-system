// 支払う MG の分配報告書の試験（発行・取消・作り直しの照合・当期の増分）。要件は docs/requirements/planning/rights-acquisition.md の
// FR-PLAN-ACQ-016・017・031・048、計画は会社ルートの plans の 2026-10-22-folder-mg-buy（問い4 A・問い5 A、約束 F-2）。架空のデータだけ。
import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildStatementBody, statementGate} from '../src/acquisition/acq-mg-statement-model.mjs';

async function fixture(t) {
  const db = await openTestDb({t}), app = createApp({db});
  const login = async (email) => {
    const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    return r.headers.get('set-cookie').split(';')[0];
  };
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const r = await app.request('/api' + path, {method: body ? 'POST' : 'GET', headers: {cookie, ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const ok = (r) => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.data; };
  let seq = 0;
  const report = async (amount, from, to, month) => {
    const key = `ACQ-ST-${++seq}`;
    ok(await req('/sales', {workId: 1, kind: 'digital', report_key: key, partner_id: 2, period_from: from, period_to: to, accounting_month: month,
      description: '架空の報告', quantity: 1, amount_ex_tax: amount, tax_amount: 0, amount_inc_tax: amount}));
    return ok(await req('/reports?workId=1')).rows.find((x) => x.report_key === key).id;
  };
  const contract = ok(await req('/acq-mg/contracts', {code: 'ACQ-ST-001', title: '架空の買付', partnerId: 3, consideration: 'mg', mgAmount: 100000,
    startsOn: '2026-06-01', endsOn: '2031-05-31', recoupBasis: 'platform_net', overageEnabled: true, overageRateBps: 5000, works: [{workId: 1}], reason: '架空'}));
  const link = async (reportId) => ok(await req('/acq-mg/report-links', {reportId, workId: 1, termVersionId: contract.termVersionId, decidedBy: 'auto'}));
  return {db, req, ok, login, report, link, contract};
}

test('FR-PLAN-ACQ-031 回収中の締め月は、分配額を0円の支払と分けて「回収中」と示す報告書を発行できる', async (t) => {
  const f = await fixture(t);
  await f.link(await f.report(60000, '2026-06-01', '2026-06-30', '2026-06'));
  const draft = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements?closeMonth=2026-06`)).draft;
  assert.equal(draft.gate.ok, true);
  assert.equal(draft.body.distributionLabel, '回収中');
  assert.deepEqual(draft.body.increment, {recouped: 60000, distribution: 0, works: [{workId: '1', distribution: 0}]});
  const issued = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06', expectedSha256: draft.sha256}));
  assert.equal(issued.sha256, draft.sha256);
  const list = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`)).statements;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'recouping');
  assert.equal(list[0].recouped, 60000);
});

test('FR-PLAN-ACQ-017 発行した本体は作り直すと同じハッシュになり、同じ締め月は二重に発行できず、取り消せば発行し直せる', async (t) => {
  const f = await fixture(t);
  await f.link(await f.report(60000, '2026-06-01', '2026-06-30', '2026-06'));
  const issued = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06'}));
  assert.equal(f.ok(await f.req(`/acq-mg/statements/${issued.statementId}/verify`)).same, true);
  assert.equal((await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06'})).status, 409, '生きた発行がある締め月');
  await assert.rejects(f.db.run('UPDATE acq_mg_statements SET distribution=1 WHERE id=?', [issued.statementId]), /変更できません/);
  assert.equal((await f.req(`/acq-mg/statements/${issued.statementId}/void`, {})).status, 400, '取消の理由が要る');
  f.ok(await f.req(`/acq-mg/statements/${issued.statementId}/void`, {reason: '架空の取り違え'}));
  assert.equal((await f.req(`/acq-mg/statements/${issued.statementId}/void`, {reason: '二度目'})).status, 409, '取消は1回だけ');
  f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06'}));
  const list = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`)).statements;
  assert.deepEqual(list.map((s) => `${s.kind}:${s.voided}`).sort(), ['issue:0', 'issue:1', 'void:0'], '取り消した発行・取消の行・発行し直した行');
  assert.deepEqual(await foreignKeyViolations(f.db), []);
});

test('当期の増分は、前の締め月の生きた発行との差（約束 F-2 の仕訳の元。FR-PLAN-ACQ-047）', async (t) => {
  const f = await fixture(t);
  await f.link(await f.report(60000, '2026-06-01', '2026-06-30', '2026-06'));
  f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06'}));
  // 7月に 70,000 → 回収累計 100,000（MG まで）・超過 30,000・分配額 15,000
  await f.link(await f.report(70000, '2026-07-01', '2026-07-31', '2026-07'));
  const draft = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements?closeMonth=2026-07`)).draft;
  assert.equal(draft.body.amounts.distribution, 15000);
  assert.deepEqual(draft.body.increment, {recouped: 40000, distribution: 15000, works: [{workId: '1', distribution: 15000}]});
});

test('見たあとに売上が変わった下書きは発行しない', async (t) => {
  const f = await fixture(t);
  await f.link(await f.report(60000, '2026-06-01', '2026-06-30', '2026-06'));
  const draft = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements?closeMonth=2026-06`)).draft;
  await f.link(await f.report(1000, '2026-06-01', '2026-06-30', '2026-06'));
  assert.equal((await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06', expectedSha256: draft.sha256})).status, 409);
});

test('FR-PLAN-ACQ-048 発行の関門: 全体の超過まで報告しない契約と、検査が合わないときは発行しない（問い5 A）', () => {
  const ok = {statementAllowed: true, checks: [{key: 'a', ok: true}]};
  assert.deepEqual(statementGate(ok), {ok: true, reason: null});
  assert.equal(statementGate({...ok, statementAllowed: false}).ok, false);
  assert.match(statementGate({...ok, checks: [{key: 'deduction_cap', ok: false}]}).reason, /deduction_cap/);
  assert.equal(statementGate(null).ok, false);
  // 本体に日時と発行した人を入れない（同じ入力なら同じ本体）
  const body = buildStatementBody({contract: {id: 1, code: 'C', title: 'T', partner_id: 3, partner_name: 'P'}, version: {id: 2, version_no: 1}, closeMonth: '2026-06',
    recoup: {status: 'recouping', works: [{workId: '1', distribution: 0}], checks: [], exceptions: [], deductions: [], media: [], recouped: 1, distribution: 0}, previous: null});
  assert.equal(JSON.stringify(body).includes('issued'), false);
});

test('制作担当は報告書を見られず、発行もできない', async (t) => {
  const f = await fixture(t);
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, null, production)).status, 403);
  assert.equal((await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06'}, production)).status, 403);
});
