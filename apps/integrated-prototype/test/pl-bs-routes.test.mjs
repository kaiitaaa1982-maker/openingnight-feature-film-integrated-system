// PL・BS の API の試験（組織1の架空の管理者・編集担当・制作担当と、別組織2の担当）。
// 財務以外は見えない・会社の数字は会社全体を見られる人だけ・設定と手入力は管理者だけ・記録は追加だけで取消の行で直す・組織の外は指せない・監査に残る。
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {ensureExpenseDemoSettings,demoAccounting,fictionalInvoice} from '../scripts/seed-expense-support.mjs';
import {createApp} from '../src/app.mjs';

let db, app;
const cookies = {};
const login = async (email) => {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200, email);
  return response.headers.get('set-cookie').split(';')[0];
};
const call = async (who, method, path, payload) => {
  const response = await app.request(`/api${path}`, {method, headers: {cookie: cookies[who], 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
  return {status: response.status, body: await response.json()};
};
const get = (who, path) => call(who, 'GET', path);
let expenseSettings;let invoiceNo=0;
const post = async (who,path,payload) => {
  if(path==='/expenses' && who==='admin') {
    expenseSettings ??= await ensureExpenseDemoSettings(db,1,async(p,b)=>{const r=await call('admin','POST',p,b);assert.equal(r.status,201,JSON.stringify(r));return r.body;});
    payload={...payload,partner_id:expenseSettings.payee,reason:'請求書確認（架空）',invoice:fictionalInvoice('DEMO-TEST-PLBS-'+(++invoiceNo),payload.incurred_on),accounting:demoAccounting(expenseSettings,payload.category,payload.tax_amount)};
  }
  if(expenseSettings && (path==='/expense-payments'||/^\/expense-payments\/\d+\/reverse$/.test(path)))payload={expectedVersion:1,withheldYen:0,cashAccountClassVersionId:expenseSettings.classes['1100'],reason:'出金確認（架空）',...payload};
  if(path==='/expense-payments'&&payload.method==='card'){
    let card=await db.get("SELECT v.id FROM expense_card_versions v JOIN expense_cards c ON c.org_id=v.org_id AND c.id=v.card_id WHERE c.org_id=1 AND c.code='DEMO-PLBS-CARD'");
    if(!card){const r=await call('admin','POST','/expense-cards',{code:'DEMO-PLBS-CARD',name:'検証カード（架空）',effective_from:'2026-01-01',cash_account_class_version_id:expenseSettings.classes['1100'],closing_rule:'month_end',payment_rule:'month_end',payment_month_offset:1,expectedVersion:0,reason:'確認（架空）'});assert.equal(r.status,201,JSON.stringify(r));card=r.body;}
    payload={...payload,cardVersionId:card.id};
  }
  return call(who,'POST',path,payload);
};
const audits = async (entity) => Number((await db.get('SELECT COUNT(*) AS n FROM audit_log WHERE org_id=1 AND entity_type=?', [entity])).n);

before(async (t) => {
  db = await openTestDb({t});
  app = createApp({db, mode: 'local'});
  cookies.admin = await login('admin@openingnight.invalid');
  cookies.editor = await login('editor@openingnight.invalid');
  cookies.production = await login('production@openingnight.invalid');
  cookies.outsider = await login('outsider@other.invalid');
});

const Q = '/reports/pl-bs?from=2026-05&to=2026-09&asOf=2026-09';

test('制作担当は PL・BS・会社の設定・経費の出金を見られず、登録もできない', async () => {
  for (const path of [Q, '/pl-bs/settings', '/pl-bs/manual', '/expense-payments', '/committee-investments?workId=1']) {
    assert.equal((await get('production', path)).status, 403, path);
  }
  for (const [path, payload] of [['/pl-bs/profile-versions', {legalName: 'x', reason: 'x'}], ['/pl-bs/manual', {entries: []}], ['/expense-payments', {expenseId: 1}],
    ['/committee-investment-payments', {termVersionId: 1, partnerId: 1}], ['/pl-bs/accounts/defaults', {}]]) {
    assert.equal((await post('production', path, payload)).status, 403, path);
  }
});

test('会社の設定: 管理者だけが版を足せる。自社の取引先はこの組織の取引先だけ。古い版からの保存は止め、変更・削除はトリガーで止める', async () => {
  assert.equal((await post('editor', '/pl-bs/profile-versions', {legalName: '架空', reason: '架空'})).status, 403);
  const foreign = await post('admin', '/pl-bs/profile-versions', {legalName: '架空試作（架空）', selfPartnerId: 4, reason: '別組織の取引先を選ぶ（架空）'});
  assert.equal(foreign.status, 400, '組織2の取引先は選べない');
  assert.match(foreign.body.error, /この組織の取引先/);
  const bad = await post('admin', '/pl-bs/profile-versions', {legalName: '架空試作（架空）', invoiceRegistrationNumber: '1234', openingMonth: '2026-13', reason: 'x'});
  assert.equal(bad.status, 400);
  assert.equal(bad.body.details.errors.length, 2);
  const first = await post('admin', '/pl-bs/profile-versions', {legalName: '架空試作映像株式会社（架空）', selfPartnerId: 1, openingMonth: '2026-04', capitalYen: '10,000,000', postalCode: '1000000', baseVersion: 0, reason: '初めての登録（架空）'});
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.profile.postalCode, '100-0000');
  assert.equal(first.body.profile.capitalYen, 10000000);
  assert.equal((await post('admin', '/pl-bs/profile-versions', {legalName: '古い版から（架空）', baseVersion: 0, reason: 'x'})).status, 409, '他の人が先に版を作ったら止める');
  const second = await post('admin', '/pl-bs/profile-versions', {legalName: '架空試作映像株式会社（架空）', selfPartnerId: 1, openingMonth: '2026-04', baseVersion: 1, reason: '住所を足す（架空）', address: '東京都架空区1-1（架空）'});
  assert.equal(second.body.versionNo, 2);
  const settings = await get('admin', '/pl-bs/settings');
  assert.equal(settings.body.versions.length, 2, '前の版は残る');
  assert.equal(settings.body.profile.selfPartnerName, '架空シネマ');
  assert.equal(settings.body.fiscal.confirmed, false, '年度は既存の fiscal_settings（未確定）');
  assert.equal(await audits('org_profile'), 2);
  await assert.rejects(db.run("UPDATE org_profile_versions SET legal_name='書き換え' WHERE org_id=1"), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(db.run('DELETE FROM org_profile_versions WHERE org_id=1'), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
  assert.equal((await get('outsider', '/pl-bs/settings')).body.profile, null, '別組織には見えない');
});

test('勘定科目: 初期値は1回だけ入り、同じ科目コードは足せない。変更はトリガーで止める', async () => {
  const first = await post('admin', '/pl-bs/accounts/defaults', {});
  assert.equal(first.status, 201);
  assert.ok(first.body.added >= 40);
  const second = await post('admin', '/pl-bs/accounts/defaults', {});
  assert.equal(second.body.added, 0, '2回目は足さない');
  assert.equal((await post('admin', '/pl-bs/accounts', {code: '6240', name: '重複', section: 'sga'})).status, 409);
  const added = await post('admin', '/pl-bs/accounts', {code: '6300', name: '研究開発費（架空）', section: 'sga', cashEffect: true});
  assert.equal(added.status, 201);
  assert.ok(added.body.accounts.some((row) => row.code === '6300' && row.source === 'manual'));
  assert.equal((await post('editor', '/pl-bs/accounts', {code: '6301', name: 'x', section: 'sga'})).status, 403);
  await assert.rejects(db.run("UPDATE gl_accounts SET name='x' WHERE org_id=1"), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  assert.equal((await get('outsider', '/pl-bs/settings')).body.accounts.length, 0, '勘定科目は組織ごと');
});

test('手入力の額: PLの科目は発生額、BSの科目は月末の残高。システムの科目は期首の基準月の残高だけ。直すときは取消の行', async () => {
  const flowOnSystem = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '4100', month: '2026-05', amountYen: 100, basis: '売上を直接入れる（架空）'}]});
  assert.equal(flowOnSystem.status, 400);
  assert.match(flowOnSystem.body.error, /システムが計算する科目/);
  const cashLater = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '1100', month: '2026-06', amountYen: 5000, basis: '期首以外の現預金（架空）'}]});
  assert.equal(cashLater.status, 400);
  assert.match(cashLater.body.error, /期首残高の基準月/);
  const foreignWork = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '6240', month: '2026-05', amountYen: 100, workId: 2, basis: '別組織の作品（架空）'}]});
  assert.equal(foreignWork.status, 400, '組織2の作品は付けられない');
  const noBasis = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '6240', month: '2026-05', amountYen: 100, basis: ''}]});
  assert.equal(noBasis.status, 400);
  assert.equal((await post('editor', '/pl-bs/manual', {entries: [{accountCode: '6240', month: '2026-05', amountYen: 100, basis: 'x'}]})).status, 403, '手入力は管理者だけ');
  const ok = await post('admin', '/pl-bs/manual', {entries: [
    {accountCode: '1100', month: '2026-04', amountYen: 5000000, basis: '架空の期首残高', status: 'reviewed'},
    {accountCode: '3100', month: '2026-04', amountYen: 5000000, basis: '架空の資本金', status: 'reviewed'},
    {accountCode: '6240', month: '2026-05', amountYen: '120,000', basis: '架空の家賃'},
    {accountCode: '6240', month: '2026-06', amountYen: 120000, basis: '架空の家賃', workId: 1},
  ]});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const list = (await get('admin', '/pl-bs/manual?from=2026-04&to=2026-09')).body;
  const rent = list.rows.find((row) => row.accountCode === '6240' && row.month === '2026-05');
  assert.equal(rent.kind, 'flow');
  assert.equal(list.rows.find((row) => row.accountCode === '3100').kind, 'balance');
  assert.equal(rent.status, 'unverified', '状態を送らなければ未確認');
  const reversed = await post('admin', `/pl-bs/manual/${rent.id}/reverse`, {reason: '金額を読み違えた（架空）'});
  assert.equal(reversed.status, 201);
  assert.equal((await post('admin', `/pl-bs/manual/${rent.id}/reverse`, {reason: 'もう一度'})).status, 409, '取消は1回だけ');
  const after = (await get('admin', '/pl-bs/manual?from=2026-04&to=2026-09')).body;
  const reversal = after.rows.find((row) => row.reversesId === rent.id);
  assert.equal(reversal.amountYen, -120000);
  assert.equal(after.rows.find((row) => row.id === rent.id).live, false);
  assert.equal((await post('admin', `/pl-bs/manual/${reversal.id}/reverse`, {reason: '取消の取消'})).status, 409);
  // 表の決まり: BSの科目に発生額は入らず、取消の行は元と同じ科目・月・金額の符号違いだけ。変更・削除は止める
  const rentAccount = (await db.get("SELECT id FROM gl_accounts WHERE org_id=1 AND code='2500'")).id;
  await assert.rejects(db.run("INSERT INTO gl_manual_amounts(org_id,account_id,month,kind,amount_yen,basis,status,created_by) VALUES(1,?,'2026-05','flow',1,'x','reviewed',1)", [rentAccount]), (e) => e.dbError?.kind === 'raise' && /発生額はPLの科目/.test(e.message));
  await assert.rejects(db.run(`INSERT INTO gl_manual_amounts(org_id,account_id,month,kind,amount_yen,basis,status,reverses_id,created_by) VALUES(1,?,'2026-06','flow',-1,'x','reviewed',?,1)`,
    [rent.accountId, list.rows.find((row) => row.month === '2026-06').id]), (e) => e.dbError?.kind === 'raise' && /取消の行/.test(e.message));
  await assert.rejects(db.run('UPDATE gl_manual_amounts SET amount_yen=0 WHERE org_id=1'), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(db.run('DELETE FROM gl_manual_amounts WHERE org_id=1'), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
  assert.equal(await audits('gl_manual_amounts'), 1);
  assert.equal(await audits('gl_manual_amount'), 1);
  const tooMany = await post('admin', '/pl-bs/manual', {entries: Array.from({length: 201}, () => ({accountCode: '6240', month: '2026-07', amountYen: 1, basis: 'x'}))});
  assert.equal(tooMany.status, 413);
  assert.equal((await get('outsider', '/pl-bs/manual')).body.rows.length, 0, '別組織には見えない');
});

test('手入力の消費税額: 課税の費用の税額を入れ、残高と現預金を動かさない科目には入れられない。取消は税額の符号も逆', async () => {
  const onBalance = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '2500', month: '2026-05', amountYen: 100, taxYen: 10, basis: '借入金に税額（架空）'}]});
  assert.equal(onBalance.status, 400);
  assert.match(onBalance.body.error, /発生額（PLの科目）にだけ/);
  const onNonCash = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '6280', month: '2026-05', amountYen: 100, taxYen: 10, basis: '減価償却費に税額（架空）'}]});
  assert.equal(onNonCash.status, 400);
  assert.match(onNonCash.body.error, /現預金を動かさない科目/);
  const ok = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '6260', month: '2026-05', amountYen: 100000, taxYen: '10,000', basis: '架空の支払報酬（税込110,000）'}]});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const list = (await get('admin', '/pl-bs/manual?from=2026-05&to=2026-05')).body.rows;
  const fee = list.find((row) => row.accountCode === '6260');
  assert.equal(fee.taxYen, 10000);
  assert.equal((await post('admin', `/pl-bs/manual/${fee.id}/reverse`, {reason: '試しに入れた（架空）'})).status, 201);
  const reversal = (await get('admin', '/pl-bs/manual?from=2026-05&to=2026-05')).body.rows.find((row) => row.reversesId === fee.id);
  assert.deepEqual([reversal.amountYen, reversal.taxYen], [-100000, -10000]);
  // 表の決まり: 減価償却費（現預金を動かさない）の税額と、税額の符号が合わない取消はトリガーで止める
  const depreciation = (await db.get("SELECT id FROM gl_accounts WHERE org_id=1 AND code='6280'")).id;
  await assert.rejects(db.run("INSERT INTO gl_manual_amounts(org_id,account_id,month,kind,amount_yen,tax_yen,basis,status,created_by) VALUES(1,?,'2026-05','flow',1,1,'x','reviewed',1)", [depreciation]), (e) => e.dbError?.kind === 'raise' && /消費税額を入れられません/.test(e.message));
  const second = await post('admin', '/pl-bs/manual', {entries: [{accountCode: '6260', month: '2026-06', amountYen: 5000, taxYen: 500, basis: '架空の支払報酬'}]});
  assert.equal(second.status, 201);
  const secondRow = (await get('admin', '/pl-bs/manual?from=2026-06&to=2026-06')).body.rows.find((row) => row.accountCode === '6260');
  await assert.rejects(db.run("INSERT INTO gl_manual_amounts(org_id,account_id,month,kind,amount_yen,tax_yen,basis,status,reverses_id,created_by) VALUES(1,?,'2026-06','flow',-5000,500,'x','reviewed',?,1)", [secondRow.accountId, secondRow.id]), (e) => e.dbError?.kind === 'raise' && /税額の符号を逆/.test(e.message));
  assert.equal((await post('admin', `/pl-bs/manual/${secondRow.id}/reverse`, {reason: '試しに入れた（架空）'})).status, 201);
});

test('経費の出金: 税込額までしか出金できず、取消の行で戻す。別組織の経費は指せない。未払が分かる', async () => {
  const created = await post('admin', '/expenses', {project_id: 1, work_id: 1, incurred_on: '2026-05-10', accounting_month: '2026-05', category: 'P&A', description: '架空の宣伝費',
    actual_ex_tax: 1000, tax_amount: 100, actual_inc_tax: 1100});
  assert.equal(created.status, 201);
  const expenseId = created.body.id;
  assert.equal((await post('admin', '/expense-payments', {expenseId, paidOn: '2026-06-30', amountYen: 600, method: 'transfer'})).status, 201);
  const over = await post('admin', '/expense-payments', {expenseId, paidOn: '2026-07-31', amountYen: 600});
  assert.equal(over.status, 409);
  assert.match(over.body.error, /税込額（1,100円）を超えます/);
  assert.equal((await post('admin', '/expense-payments', {expenseId, paidOn: '2026-02-30', amountYen: 1})).status, 400, 'ありえない日付');
  assert.equal((await post('editor', '/expense-payments', {expenseId, paidOn: '2026-07-31', amountYen: 500, method: 'card', note: '残り（架空）'})).status, 201, '案件の財務編集権限がある編集担当も記録できる');
  let row = (await get('admin', '/expense-payments?workId=1')).body.rows.find((item) => item.id === expenseId);
  assert.deepEqual({paid: row.paidYen, unpaid: row.unpaidYen, state: row.state, last: row.lastPaidOn}, {paid: 1100, unpaid: 0, state: '支払済み', last: '2026-07-31'});
  const first = row.payments.find((payment) => payment.amountYen === 600);
  assert.equal((await post('admin', `/expense-payments/${first.id}/reverse`, {reversedOn: '2026-06-01', reason: '日付の前'})).status, 400, '取消日は出金日以後');
  assert.equal((await post('admin', `/expense-payments/${first.id}/reverse`, {reversedOn: '2026-07-01', reason: '振込先を誤った（架空）'})).status, 201);
  assert.equal((await post('admin', `/expense-payments/${first.id}/reverse`, {reversedOn: '2026-07-01', reason: 'もう一度'})).status, 409);
  row = (await get('admin', '/expense-payments?workId=1')).body.rows.find((item) => item.id === expenseId);
  assert.deepEqual({paid: row.paidYen, unpaid: row.unpaidYen, state: row.state}, {paid: 500, unpaid: 600, state: '一部未払'});
  assert.ok(row.payments.find((payment) => payment.id === first.id).reversed);
  assert.equal((await post('outsider', '/expense-payments', {expenseId, paidOn: '2026-07-31', amountYen: 1})).status, 404, '組織2からは組織1の経費を指せない');
  assert.equal((await get('outsider', '/expense-payments')).body.rows.length, 0);
  await assert.rejects(db.run('UPDATE expense_payments SET amount_yen=1 WHERE org_id=1'), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(db.run('DELETE FROM expense_payments WHERE org_id=1'), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
  assert.equal(await audits('expense_payment'), 3);
  assert.equal((await post('admin', '/committee-investment-payments', {termVersionId: 999, partnerId: 1, paidOn: '2026-05-01', amountYen: 1})).status, 404, '出資額の登録の無い委員会には払い込めない');
});

test('帳票: 管理者と、組織のすべての案件に財務の権限がある編集担当は会社PL・BSまで見える。権限の無い案件ができると会社の数字は出さない', async () => {
  const admin = await get('admin', Q);
  assert.equal(admin.status, 200, JSON.stringify(admin.body).slice(0, 300));
  assert.equal(admin.body.heading, '管理会計の試算（決算書ではありません）');
  assert.ok(admin.body.companyPl && admin.body.companyBs);
  assert.equal(admin.body.companyBs.rows.at(-1).key, 'difference');
  const rent = admin.body.companyPl.rows.find((row) => row.label === '地代家賃');
  assert.equal(rent.values.period, 120000, '取り消した5月の家賃は入らず、作品に付けた6月の家賃だけ');
  const editor = await get('editor', Q);
  assert.ok(editor.body.companyPl, '編集担当は組織1のすべての案件（1件）に財務の権限がある');
  // 管理者が案件を足すと、編集担当はその案件の権限を持たないので会社の数字は見られない
  assert.equal((await post('admin', '/projects', {code: 'PRJ-PLBS', title: '架空の別案件', status: 'active'})).status, 201);
  const partial = await get('editor', Q);
  assert.equal(partial.status, 200);
  assert.equal(partial.body.companyPl, null);
  assert.equal(partial.body.companyBs, null);
  assert.match(partial.body.companyNote, /すべての案件/);
  assert.equal(partial.body.workPl.length, 1, '権限のある作品の作品別PLは見える');
  assert.equal((await get('editor', '/pl-bs/settings')).status, 403);
  assert.equal((await get('editor', '/pl-bs/manual')).status, 403);
  // 別組織の担当には組織1の作品が出ない
  const outsider = await get('outsider', Q);
  assert.deepEqual(outsider.body.workPl.map((row) => row.code), ['WRK-OTHER']);
  assert.equal(outsider.body.companyPl.rows.find((row) => row.label === '地代家賃'), undefined);
  // 期間の指定が壊れているとき
  assert.equal((await get('admin', '/reports/pl-bs?from=2026-09&to=2026-05')).status, 400);
  assert.equal((await get('admin', '/reports/pl-bs?from=2016-01&to=2026-05')).status, 400, '120か月を超える期間は止める');
});

test('作品が1本も無い案件の経費と出金は会社PL・現預金に入る。会社全体を見られない人には会社の注意・照合・数字を返さない', async () => {
  const before = (await get('admin', Q)).body;
  assert.ok(!before.notes.some((note) => note.includes('現預金がマイナス')), '管理者の現預金はプラス（期首500万円）');
  const project = (await db.get("SELECT id FROM projects WHERE org_id=1 AND code='PRJ-PLBS'")).id;
  const created = await post('admin', '/expenses', {project_id: project, work_id: null, incurred_on: '2026-06-10', accounting_month: '2026-06', category: '事務費', description: '全社の事務費（架空）',
    actual_ex_tax: 1000000, tax_amount: 100000, actual_inc_tax: 1100000});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await post('admin', '/expense-payments', {expenseId: created.body.id, paidOn: '2026-07-31', amountYen: 1100000, method: 'transfer'})).status, 201);
  const after = (await get('admin', Q)).body;
  const period = (body, key) => body.companyPl.rows.find((row) => row.key === key).values.period;
  const bs = (body, key) => body.companyBs.rows.find((row) => row.key === key).value;
  assert.equal(period(after, 'work_other_expense') - period(before, 'work_other_expense'), 1000000);
  assert.equal(period(after, 'netIncome') - period(before, 'netIncome'), -1000000);
  assert.equal(bs(after, 'cash') - bs(before, 'cash'), -1100000);
  assert.equal(bs(after, 'consumption_tax') - bs(before, 'consumption_tax'), -100000);
  assert.equal(after.companyBs.difference, before.companyBs.difference);
  assert.ok(after.checks.every((row) => row.value === 0), JSON.stringify(after.checks));
  // 案件の一部だけに財務権限がある編集担当: 会社の数字・会社の注意（現預金など）・会社の照合は出さない。作品別PLは変わらない
  const partial = (await get('editor', Q)).body;
  assert.equal(partial.companyPl, null);
  assert.ok(partial.notes.every((note) => !/現預金|期首残高/.test(note)), partial.notes.join());
  assert.ok(partial.checks.length > 0 && partial.checks.every((row) => row.scope === 'work'), JSON.stringify(partial.checks));
  assert.ok(partial.workPl.every((row) => row.period.workOther === before.workPl.find((item) => item.workId === row.workId).period.workOther));
  // その案件に後から作品を足しても、作品の無い経費の扱いは変わらない（遡って変わらない）
  assert.equal((await post('admin', '/works', {project_id: project, code: 'WRK-PLBS', title: '後から足した作品（架空）', format: 'feature'})).status, 201);
  const later = (await get('admin', Q)).body;
  assert.equal(period(later, 'netIncome'), period(after, 'netIncome'));
});

test('BSの基準月が期首残高の基準月より前なら、PL は出して残高は出さない（理由を返す）', async () => {
  const res = await get('admin', '/reports/pl-bs?from=2026-01&to=2026-03');
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.ok(res.body.companyPl);
  assert.equal(res.body.companyBs.unavailable, true);
  assert.deepEqual(res.body.workBalances, []);
  assert.match(res.body.bsUnavailable, /期首残高の基準月（2026年4月末）より前/);
  assert.ok(res.body.notes.some((note) => note === res.body.bsUnavailable));
});

test('D1 の上限: 帳票と登録の1文の値は100個以下、1回の batch は480文以下', async () => {
  const seen = {maxParams: 0, maxBatch: 0, statements: 0};
  const recorder = new Proxy(db, {get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    if (['all', 'get', 'run'].includes(prop)) return (sql, params = []) => { seen.maxParams = Math.max(seen.maxParams, params.length); seen.statements += 1; return value.call(target, sql, params); };
    if (prop === 'batch') return (list) => { seen.maxBatch = Math.max(seen.maxBatch, list.length); for (const item of list) seen.maxParams = Math.max(seen.maxParams, (item.params || []).length); return value.call(target, list); };
    return value.bind(target);
  }});
  const local = createApp({db: recorder, mode: 'local'});
  const request = async (method, path, payload) => {
    const response = await local.request(`/api${path}`, {method, headers: {cookie: cookies.admin, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    return {status: response.status, body: await response.json()};
  };
  const entries = Array.from({length: 200}, (_, k) => ({accountCode: '6290', month: `2026-${String((k % 12) + 1).padStart(2, '0')}`, amountYen: k + 1, basis: `架空の雑費 ${k}`}));
  assert.equal((await request('POST', '/pl-bs/manual', {entries})).status, 201);
  assert.equal((await request('GET', Q)).status, 200);
  assert.equal((await request('GET', '/pl-bs/manual')).status, 200);
  assert.ok(seen.statements > 10);
  assert.ok(seen.maxParams <= 100, `1文の値 ${seen.maxParams}個`);
  assert.ok(seen.maxBatch <= 480, `1回の batch ${seen.maxBatch}文`);
});
