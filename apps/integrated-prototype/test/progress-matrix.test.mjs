import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {expectedMonths, dueDate, coversPeriod, buildProgressMatrix, filterRows, monthsBetween} from '../src/progress/progress-model.mjs';

test('FR-REV-FCST-001 expected months follow the frequency from the start month and stop at the closure', () => {
  const months = monthsBetween('2026-05', '2027-04');
  assert.equal(expectedMonths({frequency: 'monthly', active_from: '2026-08'}, months).length, 9);
  assert.deepEqual(expectedMonths({frequency: 'quarterly', active_from: '2026-04'}, months), ['2026-07', '2026-10', '2027-01', '2027-04']);
  assert.deepEqual(expectedMonths({frequency: 'semiannual', active_from: '2026-06', last_month: '2026-12'}, months), ['2026-06', '2026-12']);
  assert.deepEqual(expectedMonths({frequency: 'annual', active_from: '2025-09'}, months), ['2026-09']);
  assert.deepEqual(expectedMonths({frequency: 'monthly', active_from: '2026-05', last_month: '2026-06'}, months), ['2026-05', '2026-06']);
});

test('FR-REV-FCST-001 due date is the due day of the month after the period, clamped to the month end', () => {
  assert.equal(dueDate({frequency: 'monthly', due_day: 20}, '2026-08'), '2026-09-20');
  assert.equal(dueDate({frequency: 'monthly', due_day: 31}, '2026-08'), '2026-09-30');
  assert.equal(dueDate({frequency: 'monthly', due_day: null}, '2027-01'), '2027-02-28');
  assert.equal(dueDate({frequency: 'quarterly', due_day: 15}, '2026-07'), '2026-10-15');
});

test('FR-REV-FCST-001 cells: missing before and after the due date, imported, billed, paid, and zero-line reports', () => {
  const rule = {id: 1, partner_id: 2, kind: 'digital', work_id: null, frequency: 'monthly', due_day: 20, active_from: '2026-07'};
  const reports = [
    {id: 10, partner_id: 2, kind: 'digital', work_id: 1, period_from: '2026-07-01', period_to: '2026-07-31'},
    {id: 11, partner_id: 2, kind: 'digital', work_id: 1, period_from: '2026-08-01', period_to: '2026-08-31'},
    {id: 12, partner_id: 2, kind: 'digital', work_id: 3, period_from: '2026-09-01', period_to: '2026-09-30'},
    {id: 13, partner_id: 2, kind: 'package', work_id: 1, period_from: '2026-10-01', period_to: '2026-10-31'},
    {id: 14, partner_id: 2, kind: 'digital', work_id: 1, period_from: '2026-11-01', period_to: '2026-11-30'},
  ];
  const billing = new Map([[10, {lines: 2, claimed: 2, openInvoices: 0}], [11, {lines: 2, claimed: 2, openInvoices: 1}], [12, {lines: 3, claimed: 1, openInvoices: 1}], [14, {lines: 0, claimed: 0, openInvoices: 0}]]);
  const months = monthsBetween('2026-07', '2026-12');
  const m = buildProgressMatrix({rules: [rule], reports, billing, months, today: '2026-11-25'});
  assert.deepEqual(m.rows[0].cells.map((c) => c.code), ['paid', 'billed', 'partly_billed', 'missing_overdue', 'no_invoice', 'missing'],
    'October has only a package report (different kind), so it is overdue after 11/20; December is not due yet');
  assert.equal(m.counts.missing_overdue, 1);
  assert.equal(m.expectedTotal, 6);
  assert.deepEqual(m.rows[0].cells[0].reportIds, [10]);
  // 報告の受領月で計上する報告（8月分・9月計上）は、欄から売上明細へ移るとき計上月の9月で絞る
  const late = buildProgressMatrix({rules: [rule], reports: [{id: 20, partner_id: 2, kind: 'digital', work_id: 1, period_from: '2026-08-01', period_to: '2026-08-31', accounting_month: '2026-09'}],
    billing: new Map([[20, {lines: 1, claimed: 0, openInvoices: 0}]]), months: ['2026-08'], today: '2026-09-25'});
  assert.deepEqual([late.rows[0].cells[0].code, late.rows[0].cells[0].accountingFrom, late.rows[0].cells[0].accountingTo], ['imported', '2026-09', '2026-09']);
  const workRule = {...rule, id: 2, work_id: 1};
  const w = buildProgressMatrix({rules: [workRule], reports, billing, months, today: '2026-11-25'});
  assert.equal(w.rows[0].cells[2].code, 'missing_overdue', 'a work-specific rule ignores the report of another work');
  assert.equal(filterRows(m.rows, 'missing_all').length, 1);
  assert.equal(filterRows(m.rows, 'imported').length, 0);
  assert.equal(coversPeriod({period_from: '2026-09-15', period_to: '2026-10-14'}, {frequency: 'monthly'}, '2026-10'), true, 'a report spanning two months covers both');
});

test('FR-REV-FCST-001 FR-REV-FCST-009 FR-REV-FCST-010 progress API: register, list, matrix, close, immutability and permissions', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const r = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const bad = await req('/progress/rules', {partnerId: 2, kind: 'mail', frequency: 'weekly', activeFrom: '2026/08'});
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.data.details.errors.map((e) => e.field).sort(), ['activeFrom', 'frequency', 'kind']);
  const created = await req('/progress/rules', {partnerId: 2, kind: 'digital', frequency: 'monthly', dueDay: 20, activeFrom: '2026-08', note: '架空の月次報告'});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const sale = await req('/sales', {workId: 1, report_key: 'PROG-1', kind: 'digital', partner_id: 2, product_id: 1, period_from: '2026-08-01', period_to: '2026-08-31',
    recognition_basis_id: 2, report_received_on: '2026-09-05', basis_reason: '架空の報告受領月', description: '架空配信売上', quantity: 1, amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100});
  assert.ok(sale.status < 300, JSON.stringify(sale.data));
  const matrix = await req('/progress/matrix?from=2026-08&to=2026-10&today=2026-10-25');
  assert.equal(matrix.status, 200);
  const row = matrix.data.rows[0];
  assert.equal(row.partner_name.length > 0, true);
  assert.deepEqual(row.cells.map((c) => c.code), ['imported', 'missing_overdue', 'missing']);
  assert.equal(matrix.data.reportKeys[row.cells[0].reportIds[0]], 'PROG-1');
  assert.equal((await req(`/progress/rules/${created.data.id}/close`, {lastMonth: '2026-07', reason: '取引終了'})).status, 400, 'before the start month');
  assert.equal((await req(`/progress/rules/${created.data.id}/close`, {lastMonth: '2026-09', reason: ''})).status, 400, 'reason required');
  assert.equal((await req(`/progress/rules/${created.data.id}/close`, {lastMonth: '2026-09', reason: '架空の取引終了'})).status, 201);
  assert.equal((await req(`/progress/rules/${created.data.id}/close`, {lastMonth: '2026-09', reason: '二重'})).status, 409);
  const after = await req('/progress/matrix?from=2026-08&to=2026-10&today=2026-10-25');
  assert.deepEqual(after.data.rows[0].cells.map((c) => c.code), ['imported', 'missing_overdue', 'none']);
  assert.equal((await req('/progress/rules')).data.rules[0].last_month, '2026-09');
  await assert.rejects(() => db.run('UPDATE expected_reports SET due_day=1'), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(() => db.run('DELETE FROM expected_report_closures'), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
  const production = await login('production@openingnight.invalid');
  assert.equal((await req('/progress/matrix?from=2026-08&to=2026-10', null, production)).status, 403);
  assert.equal((await req('/progress/rules', {partnerId: 2, kind: 'digital', frequency: 'monthly', activeFrom: '2026-08'}, production)).status, 403);
  const outsider = await login('outsider@other.invalid');
  assert.equal((await req('/progress/rules', null, outsider)).data.rules.length, 0, 'another organization sees no rules');
  assert.equal((await req(`/progress/rules/${created.data.id}/close`, {lastMonth: '2026-09', reason: 'x'}, outsider)).status, 404);
});

test('FR-REV-FCST-009 without finance rights on any project, work-less progress rules and MG report months are not available', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const {seedReportDemo} = await import('../scripts/seed-report-demo.mjs');
  await seedReportDemo(db);
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const call = async (cookie, path, body) => {
    const r = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const admin = await login('admin@openingnight.invalid');
  const rule = await call(admin, '/progress/rules', {partnerId: 2, kind: 'digital', frequency: 'monthly', activeFrom: '2026-08'});
  assert.equal(rule.status, 201);
  assert.ok((await call(admin, '/reports/mg-sales/months')).data.months.length > 0, 'admin sees the months with ledger rows');
  const editorUser = await db.get("SELECT id FROM users WHERE email='editor@openingnight.invalid'");
  await db.run("UPDATE project_memberships SET permission='production' WHERE user_id=?", [editorUser.id]);
  const editor = await login('editor@openingnight.invalid');
  assert.equal((await call(editor, '/progress/rules', {partnerId: 2, kind: 'digital', frequency: 'monthly', activeFrom: '2026-09'})).status, 403);
  assert.equal((await call(editor, `/progress/rules/${rule.data.id}/close`, {lastMonth: '2026-09', reason: '権限なし'})).status, 403);
  assert.deepEqual((await call(editor, '/progress/rules')).data.rules, []);
  assert.deepEqual((await call(editor, '/reports/mg-sales/months')).data.months, [], 'no month counts leak from works without finance rights');
});

test('FR-REV-FCST-002 有効期間が重なる同じ取引先・種類・作品の「届くはずの報告」は登録できない（二重に数えない）', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const call = async (path, body) => {
    const r = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie: admin, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const rule = {partnerId: 2, kind: 'digital', frequency: 'monthly', activeFrom: '2026-07'};
  const first = await call('/progress/rules', rule);
  assert.equal(first.status, 201);
  const again = await call('/progress/rules', rule);
  assert.equal(again.status, 409);
  assert.match(again.data.error, /前の登録を終了してから/);
  assert.equal((await call('/progress/rules', {...rule, frequency: 'quarterly', activeFrom: '2026-10'})).status, 409, '頻度を変えても、終了前なら重なる');
  assert.equal((await call('/progress/rules', {...rule, workId: 1})).status, 201, '作品を指定した登録は別の対象');
  assert.equal((await call(`/progress/rules/${first.data.id}/close`, {lastMonth: '2026-09', reason: '四半期報告へ変更'})).status, 201);
  assert.equal((await call('/progress/rules', {...rule, frequency: 'quarterly', activeFrom: '2026-09'})).status, 409, '最後の対象月と重なる開始月は断る');
  assert.equal((await call('/progress/rules', {...rule, frequency: 'quarterly', activeFrom: '2026-10'})).status, 201, '終了の翌月からなら登録できる');
  await assert.rejects(db.run("INSERT INTO expected_reports(org_id, partner_id, kind, work_id, frequency, active_from, created_by) VALUES(1,2,'digital',NULL,'annual','2027-01',1)"), (e) => e.dbError?.kind === 'raise' && /有効期間中/.test(e.message), 'スキーマでも止める');
});
