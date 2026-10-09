import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {seedReportDemo} from '../scripts/seed-report-demo.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {registerReportIssuanceRoutes, royaltyIssuanceContent, mgIssuanceContent} from '../src/report-issuance-routes.mjs';
import {
  normalizeConditions, conditionsQuery, keyFigures, compareIssued, changeMessage, changeDetails, issuanceSheets, issuanceFileParts,
  canIssue, voidReasonError, issueSummaryRows, issuanceStatus, periodText,
} from '../src/report-issuance.mjs';

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  registerReportIssuanceRoutes(app, app.ux);
  await seedReportDemo(db);
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const ok = (r) => { assert.ok(r.status < 300 && r.data.ok !== false, JSON.stringify(r.data)); return r.data; };
  const id = async (table, code) => (await db.get(`SELECT id FROM ${table} WHERE org_id=1 AND code=?`, [code])).id;
  return {db, app, req, ok, login, holderC: await id('partners', 'DEMO-RH-C'), platformA: await id('partners', 'DEMO-PF-A'), supplierD: await id('mg_suppliers', 'SUP-DEMO-D')};
}

const identityOf = async (db, email) => {
  const row = await db.get('SELECT u.id AS user_id, u.email, m.org_id, m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=?', [email]);
  return row;
};

test('FR-SETL-MGL-022 issuance content is built the same way as the royalty and MG report screens', async (t) => {
  const f = await fixture({t});
  const admin = await identityOf(f.db, 'admin@openingnight.invalid');
  const royalty = await royaltyIssuanceContent(f.app.ux, admin, {from: '2026-07', to: '2026-09', holderId: f.holderC, workId: null});
  const screen = f.ok(await f.req(`/reports/royalty-statement?from=2026-07&to=2026-09&holderId=${f.holderC}`));
  for (const key of ['rows', 'holders', 'details', 'hold', 'payments', 'checks', 'totals', 'assumptions']) assert.deepEqual(royalty.body[key], screen[key], key);
  assert.deepEqual(royalty.body.holder, screen.holder);
  assert.ok(royalty.body.totals.current > 0);
  for (const [direction, partyId] of [['incoming', f.platformA], ['outgoing', f.supplierD]]) {
    const mg = await mgIssuanceContent(f.app.ux, admin, {direction, month: '2026-08', partyId});
    const {generatedAt, ...report} = f.ok(await f.req(`/rights-reports/mg-portfolio?direction=${direction}&month=2026-08&partyId=${partyId}`)).report;
    assert.deepEqual(mg.body, report, direction);
    assert.equal(mg.recipient.type, direction === 'incoming' ? 'partner' : 'supplier');
    assert.ok(mg.body.totals.cumulative.appliedYen > 0, direction);
  }
});

test('FR-SETL-MGL-022 issuing stores the server calculation, not numbers sent by the screen, and the record cannot be changed', async (t) => {
  const f = await fixture({t});
  const conditions = {from: '2026-07', to: '2026-09', holderId: f.holderC};
  const listed = f.ok(await f.req(`/reports/issuances?${conditionsQuery('royalty', conditions)}`));
  assert.equal(listed.active, null);
  assert.equal(listed.blocked, null);
  assert.ok(listed.current.contentHash);
  const screen = f.ok(await f.req(`/reports/royalty-statement?from=2026-07&to=2026-09&holderId=${f.holderC}`));
  const created = await f.req('/reports/issuances', {kind: 'royalty', conditions, expectedContentHash: listed.current.contentHash, note: '架空の送付メモ',
    content: {totals: {current: 1}}, figures: [{key: 'current', value: 1}], headlineYen: 1, body: {totals: {current: 1}}});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const issuance = created.data.issuance;
  assert.equal(issuance.versionNo, 1);
  assert.equal(issuance.status, 'active');
  assert.equal(issuance.headlineYen, screen.totals.current, 'the stored headline is the server calculation');
  assert.equal(issuance.recipient.name, '権利元C（架空）');
  assert.match(issuance.issuedOn, /^\d{4}-\d{2}-\d{2}$/);
  const detail = f.ok(await f.req(`/reports/issuances/${issuance.id}`)).issuance;
  assert.deepEqual(detail.content.body.totals, screen.totals);
  assert.deepEqual(detail.content.body.details, screen.details);
  assert.equal(detail.note, '架空の送付メモ');
  // 同じ条件の再発行は、取り消すまでできない
  const again = await f.req('/reports/issuances', {kind: 'royalty', conditions});
  assert.equal(again.status, 409);
  // 表の直接の変更・削除はトリガーで止まる
  await assert.rejects(() => f.db.run('UPDATE report_issuances SET headline_yen=1 WHERE id=?', [issuance.id]), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(() => f.db.run('DELETE FROM report_issuances WHERE id=?', [issuance.id]), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
  // トリガーは、画面を通さない二重の発行も止める
  const row = await f.db.get('SELECT * FROM report_issuances WHERE id=?', [issuance.id]);
  await assert.rejects(() => f.db.run(`INSERT INTO report_issuances(org_id, report_kind, conditions_json, conditions_hash, content_json, content_hash, recipient_type, recipient_id, recipient_name,
    work_ids_json, headline_yen, version_no, previous_issuance_id, note, issued_on, issued_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [1, 'royalty', row.conditions_json, row.conditions_hash, row.content_json, row.content_hash, 'partner', row.recipient_id, row.recipient_name, row.work_ids_json, 1, 2, row.id, null, row.issued_on, 1]), (e) => e.dbError?.kind === 'raise' && /発行済み|取り消されていない/.test(e.message));
  const audit = await f.db.get("SELECT * FROM audit_log WHERE entity_type='report_issuance' AND action='issue'");
  assert.equal(audit.entity_id, String(issuance.id));
  // 確認した内容と記録する内容が違えば止める
  const stale = await f.req('/reports/issuances', {kind: 'mg-sales', conditions: {direction: 'incoming', month: '2026-08', partyId: f.platformA}, expectedContentHash: 'x'.repeat(64)});
  assert.equal(stale.status, 409);
});

test('after the source data changes the issued version shows the difference; void needs a reason and allows re-issue', async (t) => {
  const f = await fixture({t});
  const conditions = {from: '2026-07', to: '2026-09', holderId: f.holderC};
  const first = f.ok(await f.req('/reports/issuances', {kind: 'royalty', conditions})).issuance;
  let listed = f.ok(await f.req(`/reports/issuances?${conditionsQuery('royalty', conditions)}`));
  assert.equal(listed.active.id, first.id);
  assert.equal(listed.comparison.changed, false);
  assert.equal(changeMessage(listed.comparison), null);
  // 元データを変える: 期間内の配信売上を1件追加し、手数料型の契約に紐付ける（控除前 50,000円 → 権利元額 31,500円）
  const work = await f.db.get("SELECT id FROM works WHERE code='WRK-DEMO'");
  f.ok(await f.req('/sales', {workId: work.id, report_key: 'ISSUE-ADD', kind: 'digital', partner_id: f.platformA, product_id: 1, period_from: '2026-09-01', period_to: '2026-09-28',
    recognition_basis_id: 1, sales_month: '2026-09', basis_reason: '架空の追加', description: '架空の追加売上', quantity: 1, amount_ex_tax: 50000, tax_amount: 5000, amount_inc_tax: 55000}));
  const reportId = (await f.db.get("SELECT id FROM report_imports WHERE report_key='ISSUE-ADD'")).id;
  const contract = await f.db.get("SELECT c.id, v.id AS version_id FROM settlement_contracts c JOIN settlement_term_versions v ON v.contract_id=c.id WHERE c.contract_code='DEMO-ROY-C'");
  f.ok(await f.req('/settlement/links', {reportId, workId: work.id, contractId: contract.id, termVersionId: contract.version_id, reportBasis: 'gross'}));
  listed = f.ok(await f.req(`/reports/issuances?${conditionsQuery('royalty', conditions)}`));
  assert.equal(listed.comparison.changed, true);
  assert.equal(listed.comparison.primaryDiff, 31500);
  assert.equal(changeMessage(listed.comparison), '発行後に元データが変わりました（差額+31,500円・当期の権利元額）');
  const detail = f.ok(await f.req(`/reports/issuances/${first.id}`));
  assert.equal(detail.comparison.primaryDiff, 31500);
  assert.equal(detail.issuance.content.body.totals.current, first.headlineYen, 'the issued content does not move');
  // 取消: 理由なしは止まる
  assert.equal((await f.req(`/reports/issuances/${first.id}/void`, {reason: '   '})).status, 400);
  const voided = await f.req(`/reports/issuances/${first.id}/void`, {reason: '売上の追加報告があったため'});
  assert.equal(voided.status, 201, JSON.stringify(voided.data));
  assert.equal(voided.data.issuance.status, 'voided');
  assert.equal(voided.data.issuance.void.reason, '売上の追加報告があったため');
  assert.equal((await f.req(`/reports/issuances/${first.id}/void`, {reason: 'もう一度'})).status, 409);
  await assert.rejects(() => f.db.run('UPDATE report_issuance_voids SET reason=? WHERE issuance_id=?', ['書き換え', first.id]), /変更できません/);
  await assert.rejects(() => f.db.run('DELETE FROM report_issuance_voids WHERE issuance_id=?', [first.id]), /削除できません/);
  // 再発行: 第2版は新しい数字で、前の版を指す
  const second = f.ok(await f.req('/reports/issuances', {kind: 'royalty', conditions})).issuance;
  assert.equal(second.versionNo, 2);
  assert.equal(second.previousIssuanceId, first.id);
  assert.equal(second.headlineYen, first.headlineYen + 31500);
  listed = f.ok(await f.req(`/reports/issuances?${conditionsQuery('royalty', conditions)}`));
  assert.deepEqual(listed.issuances.map((i) => [i.versionNo, i.status]), [[2, 'active'], [1, 'voided']]);
  assert.equal(listed.comparison.changed, false);
  const all = f.ok(await f.req('/reports/issuances?all=1'));
  assert.equal(all.issuances.length, 2);
  assert.ok(!('content' in all.issuances[0]), 'the list does not carry the content');
});

test('FR-SETL-MGL-022 issued versions can be exported to Excel again from the stored content', async (t) => {
  const f = await fixture({t});
  const royalty = f.ok(await f.req('/reports/issuances', {kind: 'royalty', conditions: {from: '2026-05', to: '2027-04', holderId: f.holderC}})).issuance;
  const mg = f.ok(await f.req('/reports/issuances', {kind: 'mg-sales', conditions: {direction: 'incoming', month: '2026-08', partyId: f.platformA}})).issuance;
  for (const [item, names] of [[royalty, ['表紙', '一覧', '明細', '保留（HOLD）', '支払記録', '照合']], [mg, ['表紙', '取引先別', '明細', '台帳', '照合']]]) {
    const detail = f.ok(await f.req(`/reports/issuances/${item.id}`)).issuance;
    const sheets = issuanceSheets(detail);
    assert.deepEqual(sheets.map((s) => s.name), names);
    const cover = sheets[0].rows.map((r) => [r.k, r.v]);
    assert.ok(cover.some(([k, v]) => k === '状態' && v === '発行済'));
    assert.ok(cover.some(([k, v]) => k === '版' && v === '第1版'));
    const bytes = encodeReportXlsx({sheets});
    const book = decodeXlsx(bytes);
    assert.deepEqual(book.map((s) => s.name), names);
    assert.ok(book[0].rows.some((row) => row.includes('発行済')), 'the cover sheet says it is the issued version');
    const parts = issuanceFileParts(detail);
    assert.match(parts.name, /発行第1版$/);
  }
  // MG の照合（累計実充当＝台帳の和、未消化残高の規則）が差0
  const mgDetail = f.ok(await f.req(`/reports/issuances/${mg.id}`)).issuance;
  const checks = issuanceSheets(mgDetail).at(-1).rows;
  assert.equal(checks[2].value, 0);
  assert.equal(checks[6].value, 0);
  assert.throws(() => issuanceSheets({kind: 'royalty'}), /読み込まれていません/);
});

test('issuance permissions: production is denied, other organizations see nothing, and conditions with works outside the permission are 403', async (t) => {
  const f = await fixture({t});
  const conditions = {from: '2026-07', to: '2026-09', holderId: f.holderC};
  const issued = f.ok(await f.req('/reports/issuances', {kind: 'royalty', conditions})).issuance;
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req(`/reports/issuances?${conditionsQuery('royalty', conditions)}`, null, production)).status, 403);
  assert.equal((await f.req('/reports/issuances', {kind: 'royalty', conditions}, production)).status, 403);
  assert.equal((await f.req(`/reports/issuances/${issued.id}/void`, {reason: '試し'}, production)).status, 403);
  const outsider = await f.login('outsider@other.invalid');
  assert.equal((await f.req(`/reports/issuances/${issued.id}`, null, outsider)).status, 404);
  assert.equal(f.ok(await f.req('/reports/issuances?all=1', null, outsider)).issuances.length, 0);
  assert.equal((await f.req(`/reports/issuances/${issued.id}/void`, {reason: '別組織'}, outsider)).status, 404);
  // 別組織の権利元IDでは作れない
  assert.equal((await f.req('/reports/issuances', {kind: 'royalty', conditions}, outsider)).status, 404);
  const editor = await f.login('editor@openingnight.invalid');
  assert.equal(f.ok(await f.req(`/reports/issuances/${issued.id}`, null, editor)).issuance.id, issued.id, 'an editor with finance rights can read');
  // 編集担当に権限のない案件の作品で、同じ権利元の契約を作る → 編集担当の発行・閲覧は403、管理者は可
  const project = f.ok(await f.req('/projects', {code: 'PRJ-ISSUE-2', title: '架空の別案件', status: 'active'}));
  const work = f.ok(await f.req('/works', {project_id: project.id, code: 'WRK-ISSUE-2', title: '架空の別作品', format: 'film'}));
  f.ok(await f.req('/settlement/contracts', {workId: work.id, contractCode: 'ISSUE-C-2', title: '架空の別契約', contractType: 'commission', holderPartnerId: f.holderC, terms: {platformRateBps: 0, agencyFeeBps: 1000}}));
  const wide = {from: '2026-05', to: '2027-04', holderId: f.holderC};
  const blocked = await f.req('/reports/issuances', {kind: 'royalty', conditions: wide}, editor);
  assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
  const listedByEditor = f.ok(await f.req(`/reports/issuances?${conditionsQuery('royalty', wide)}`, null, editor));
  assert.ok(listedByEditor.blocked, 'the panel says why issuing is not possible');
  assert.equal(listedByEditor.current, null);
  const byAdmin = f.ok(await f.req('/reports/issuances', {kind: 'royalty', conditions: wide})).issuance;
  assert.deepEqual(byAdmin.workIds.length, 2);
  assert.equal((await f.req(`/reports/issuances/${byAdmin.id}`, null, editor)).status, 403);
  assert.ok(!f.ok(await f.req('/reports/issuances?all=1', null, editor)).issuances.some((i) => i.id === byAdmin.id), 'the list hides issuances with works outside the permission');
  assert.equal((await f.req(`/reports/issuances/${byAdmin.id}/void`, {reason: '権限外'}, editor)).status, 403);
  // 作品を指定した条件は、その作品の権限で決まる
  assert.equal((await f.req('/reports/issuances', {kind: 'royalty', conditions: {...wide, workId: work.id}}, editor)).status, 403);
});

test('conditions are validated and normalized so the same conditions give the same record', async () => {
  assert.deepEqual(normalizeConditions('royalty', {from: '2026-05', to: '2026-07', holderId: '3', workId: ''}), {ok: true, conditions: {from: '2026-05', to: '2026-07', holderId: 3, workId: null}});
  assert.equal(normalizeConditions('royalty', {from: '2026-05', to: '2026-07'}).error, '発行を記録するには、権利元を1者選んでください');
  assert.equal(normalizeConditions('royalty', {from: '2026-08', to: '2026-07', holderId: 3}).ok, false);
  assert.equal(normalizeConditions('royalty', {from: '2026-5', to: '2026-07', holderId: 3}).ok, false);
  assert.equal(normalizeConditions('royalty', {from: '2026-05', to: '2026-07', holderId: 'x'}).ok, false);
  assert.deepEqual(normalizeConditions('mg-sales', {month: '2026-08', partyId: 4}), {ok: true, conditions: {direction: 'incoming', month: '2026-08', partyId: 4}});
  assert.equal(normalizeConditions('mg-sales', {direction: 'sideways', month: '2026-08', partyId: 4}).ok, false);
  assert.equal(normalizeConditions('mg-sales', {direction: 'outgoing', month: '2026-08'}).error, '発行を記録するには、取引先を1社選んでください');
  assert.equal(normalizeConditions('committee', {}).ok, false);
  assert.equal(conditionsQuery('royalty', {from: '2026-05', to: '2026-07', holderId: 3, workId: null}), 'kind=royalty&from=2026-05&to=2026-07&holderId=3');
  assert.equal(voidReasonError(''), '取消の理由を入力してください');
  assert.equal(voidReasonError('x'.repeat(1001)), '取消の理由は1000文字以内で入力してください');
  assert.equal(voidReasonError('金額誤り'), null);
  assert.deepEqual(canIssue({readOnly: true}), {allowed: false, reason: 'プレビューでは発行を記録できません'});
  assert.equal(canIssue({active: {versionNo: 2}}).allowed, false);
  assert.equal(canIssue({blocked: '権限がありません'}).reason, '権限がありません');
  assert.deepEqual(canIssue({conditionsResult: {ok: true}}), {allowed: true, reason: null});
  assert.deepEqual(issuanceStatus({void: {reason: 'x'}}), {code: 'voided', label: '取消済', tone: 'warn'});
  assert.equal(periodText('mg-sales', {direction: 'outgoing', month: '2026-08'}), '基準月 2026年8月・支払MG（仕入先）');
  const rows = issueSummaryRows('royalty', {conditions: {from: '2026-05', to: '2026-07'}, recipientName: '架空の権利元', figures: keyFigures('royalty', {totals: {current: 1000, holdCount: 2}})});
  assert.deepEqual(rows[1], ['宛先', '架空の権利元 様']);
  assert.ok(rows.some(([k, v]) => k === '保留（HOLD）の件数' && v === '2件'));
});

test('comparison messages name the difference and fall back when only the details changed', () => {
  const issued = keyFigures('mg-sales', {totals: {cumulative: {appliedYen: 1000, recognizedYen: 0}, current: {appliedYen: 0}, remainingAppliedYen: 500, guaranteeYen: 1500, contractCount: 1}});
  const current = keyFigures('mg-sales', {totals: {cumulative: {appliedYen: 800, recognizedYen: 0}, current: {appliedYen: 0}, remainingAppliedYen: 700, guaranteeYen: 1500, contractCount: 1}});
  const comparison = compareIssued({issuedHash: 'a', issuedFigures: issued, currentHash: 'b', currentFigures: current});
  assert.equal(comparison.primaryDiff, -200);
  assert.equal(changeMessage(comparison), '発行後に元データが変わりました（差額-200円・累計の実充当）');
  assert.deepEqual(changeDetails(comparison), ['累計の実充当: 発行時 ￥1,000 → 現在 ￥800（-200円）', '未消化残高: 発行時 ￥500 → 現在 ￥700（+200円）']);
  const same = compareIssued({issuedHash: 'a', issuedFigures: issued, currentHash: 'c', currentFigures: issued});
  assert.equal(changeMessage(same), '発行後に元データが変わりました（差額0円。金額の合計は同じで、明細の内容が変わっています）');
  assert.equal(changeMessage(compareIssued({issuedHash: 'a', issuedFigures: issued, currentHash: 'a', currentFigures: issued})), null);
  assert.equal(compareIssued({issuedHash: 'a', issuedFigures: issued}).available, false);
});
