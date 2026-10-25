// 支払う MG（買付分）の受け口の試験。表は移行 0026、計画は会社ルートの plans/2026-10-22-folder-mg-buy.md（香盤表 #3・#5）。
// 要件は docs/requirements/planning/rights-acquisition.md の FR-PLAN-ACQ-003・006〜008・010・012・045。架空のデータだけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

async function fixture(t) {
  const db = await openTestDb({t}), app = createApp({db});
  const login = async (email) => {
    const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const r = await app.request('/api' + path, {method: body ? 'POST' : 'GET', headers: {cookie, ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const ok = (r) => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.data; };
  let seq = 0;
  const report = async (amount, {from = '2026-09-01', to = '2026-09-30', month = '2026-09'} = {}) => {
    const key = `ACQ-MG-REPORT-${++seq}`;
    ok(await req('/sales', {workId: 1, kind: 'digital', report_key: key, partner_id: 2, period_from: from, period_to: to, accounting_month: month,
      description: '架空の買付分の検証', quantity: 1, amount_ex_tax: amount, tax_amount: 0, amount_inc_tax: amount}));
    return ok(await req('/reports?workId=1')).rows.find((x) => x.report_key === key).id;
  };
  return {db, login, req, ok, report};
}

const contractInput = (extra = {}) => ({
  code: 'ACQ-TEST-001', title: '架空の買付 MG', partnerId: 3, consideration: 'mg', mgAmount: 30000, startsOn: '2026-09-01', endsOn: '2031-08-31',
  recoupBasis: 'after_fee', platformRateBps: 5000, agencyFeeBps: 2000, overageEnabled: true, overageRateBps: 5000,
  works: [{workId: 1}], deductions: [{category: '字幕費', capAmount: 3000, sourceRef: '架空の契約 第8条'}],
  phases: [{startsMonth: '2026-09', cycleKind: 'quarterly', anchorMonth: 3, reportOffsetMonths: 1, paymentOffsetMonths: 1}],
  paymentSchedule: [{trigger: 'signing', amount: 6000}, {trigger: 'delivery', amount: 24000}],
  reason: '初回登録（架空）', ...extra,
});

test('FR-PLAN-ACQ-006 FR-PLAN-ACQ-008 FR-PLAN-ACQ-010 FR-PLAN-ACQ-012 FR-PLAN-ACQ-045 支払う MG を登録し、報告を自動で結ぶと売上明細から回収と分配額が出る', async (t) => {
  const f = await fixture(t);
  const created = f.ok(await f.req('/acq-mg/contracts', contractInput()));
  assert.equal(created.versionNo, 1);

  // 控除前 100,000 → PF 50% を引いて 50,000、手数料 20% を引いて回収の元 40,000 → 超過 10,000、分配額 5,000
  const reportId = await f.report(100000);
  const candidates = f.ok(await f.req('/acq-mg/link-candidates')).candidates;
  const candidate = candidates.find((x) => x.reportId === reportId);
  assert.equal(candidate.autoLinkable, true);
  assert.deepEqual(candidate.termVersionIds, [created.termVersionId]);
  f.ok(await f.req('/acq-mg/report-links', {reportId, workId: 1, termVersionId: created.termVersionId, decidedBy: 'auto', reportBasis: 'gross'}));
  assert.equal(f.ok(await f.req('/acq-mg/link-candidates')).candidates.some((x) => x.reportId === reportId), false, '結んだ報告は候補から消える');

  const detail = f.ok(await f.req(`/acq-mg/contracts/${created.contractId}?asOf=2026-09`));
  assert.equal(detail.recoup.base, 40000);
  assert.equal(detail.recoup.recouped, 30000);
  assert.equal(detail.recoup.balance, 0);
  assert.equal(detail.recoup.overage, 10000);
  assert.equal(detail.recoup.distribution, 5000);
  assert.equal(detail.latest.schedule.length, 2);
  assert.ok(detail.recoup.checks.every((x) => x.ok), JSON.stringify(detail.recoup.checks));

  // 締め月より前を指すと、その月の売上はまだ数えない
  assert.equal(f.ok(await f.req(`/acq-mg/contracts/${created.contractId}?asOf=2026-08`)).recoup.recouped, 0);

  const list = f.ok(await f.req('/acq-mg/contracts?asOf=2026-09')).contracts;
  assert.equal(list.length, 1);
  assert.equal(list[0].recoup.distribution, 5000);

  // 同じ報告と作品をもう一度結ぶのは DB が断る（直すときは前の結び付けを指す）
  assert.equal((await f.req('/acq-mg/report-links', {reportId, workId: 1, termVersionId: created.termVersionId, decidedBy: 'human', reason: '重ねて結ぶ'})).status, 409);
  const live = detail.links[0];
  f.ok(await f.req('/acq-mg/report-links', {reportId, workId: 1, termVersionId: created.termVersionId, decidedBy: 'human', decision: 'exclude', reason: '架空の取り違え', replacesLinkId: live.id}));
  assert.equal(f.ok(await f.req(`/acq-mg/contracts/${created.contractId}?asOf=2026-09`)).recoup.recouped, 0, '外したら回収の元に入らない');
  assert.deepEqual(await foreignKeyViolations(f.db), []);
});

test('契約期間の外の報告は自動で結べず、人が理由を書いて決める（問い3 A）', async (t) => {
  const f = await fixture(t);
  const created = f.ok(await f.req('/acq-mg/contracts', contractInput({code: 'ACQ-TEST-002', startsOn: '2026-10-01'})));
  const reportId = await f.report(20000);
  const candidate = f.ok(await f.req('/acq-mg/link-candidates')).candidates.find((x) => x.reportId === reportId);
  assert.equal(candidate.autoLinkable, false);
  assert.equal((await f.req('/acq-mg/report-links', {reportId, workId: 1, termVersionId: created.termVersionId, decidedBy: 'auto'})).status, 409);
  f.ok(await f.req('/acq-mg/report-links', {reportId, workId: 1, termVersionId: created.termVersionId, decidedBy: 'human', decision: 'exclude', reason: '契約前の旧ライセンスの売上（架空）'}));
});

test('条件版は版を足して直し、前の版と DB の行は変えられない', async (t) => {
  const f = await fixture(t);
  const created = f.ok(await f.req('/acq-mg/contracts', contractInput({code: 'ACQ-TEST-003'})));
  const v2 = f.ok(await f.req(`/acq-mg/contracts/${created.contractId}/versions`, {...contractInput(), overageRateBps: 10000, reason: '覚書で率を変更（架空）'}));
  assert.equal(v2.versionNo, 2);
  await assert.rejects(f.db.run('UPDATE acq_mg_term_versions SET reason=? WHERE id=?', ['改変', created.termVersionId]), /変更できません/);
  await assert.rejects(f.db.run('DELETE FROM acq_mg_contracts WHERE id=?', [created.contractId]), /削除できません/);
  const detail = f.ok(await f.req(`/acq-mg/contracts/${created.contractId}`));
  assert.deepEqual(detail.versions.map((v) => v.version_no), [1, 2]);
  assert.equal(detail.latest.row.overage_rate_bps, 10000);
});

test('入力の誤りは登録せず、batch ごと戻す', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req('/acq-mg/contracts', contractInput({multiWork: 'hold_until_total', works: [{workId: 1}, {workId: 2}]}))).status, 400, '約束の根拠が無い');
  assert.equal((await f.req('/acq-mg/contracts', contractInput({recoupBasis: 'after_fee', agencyFeeBps: null}))).status, 400);
  assert.equal((await f.req('/acq-mg/contracts', contractInput({deductions: [{category: '字幕費', capAmount: 3000}]}))).status, 400, '費目の根拠が無い');
  assert.equal((await f.req('/acq-mg/contracts', contractInput({partnerId: 999999}))).status, 404);
  f.ok(await f.req('/acq-mg/contracts', contractInput({code: 'ACQ-DUP'})));
  const dup = await f.req('/acq-mg/contracts', contractInput({code: 'ACQ-DUP'}));
  assert.equal(dup.status, 409);
  assert.match(dup.data.error ?? dup.data.message ?? JSON.stringify(dup.data), /登録済み/, '同じ番号は分かる言葉で断る');
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM acq_mg_contracts')).n, 1, '誤りの登録は1件も残らない（ACQ-DUP の1件だけ）');
});

test('FR-PLAN-ACQ-003 制作担当は 403、別の組織の人には契約が見えない', async (t) => {
  const f = await fixture(t);
  f.ok(await f.req('/acq-mg/contracts', contractInput({code: 'ACQ-TEST-004'})));
  const production = await f.login('production@openingnight.invalid');
  for (const path of ['/acq-mg/contracts', '/acq-mg/link-candidates']) assert.equal((await f.req(path, null, production)).status, 403, path);
  assert.equal((await f.req('/acq-mg/contracts', contractInput({code: 'ACQ-TEST-005'}), production)).status, 403);
  const outsider = await f.login('outsider@other.invalid');
  assert.deepEqual(f.ok(await f.req('/acq-mg/contracts', null, outsider)).contracts, []);
});
