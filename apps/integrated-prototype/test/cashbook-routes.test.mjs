// 入出金の履歴（移行 0045_cashbook）を、DB の制約と受け口（src/accounting/cashbook/cashbook-routes.mjs）で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は会社ルートの plans/2026-10-22-folder-cashflow.md の「最優先」と、架空の明細から手で書いた。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {parseStatement} from '../src/accounting/cashbook/cashbook-model.mjs';

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

// 架空の銀行の明細（9月）。最後の行は振込手数料
const SEPTEMBER = [
  '取引日,摘要,お引出金額,お預入金額,残高',
  '2026/09/05,ｶ)ｶｸｳﾊｲｼﾝ,,"1,099,340","4,099,340"',
  '2026/09/10,ｶｸｳﾋﾞｼﾞﾕﾂ,"220,000",,"3,879,340"',
  '2026/09/25,ｶｸｳ ｻｯｶ,"89,790",,"3,789,550"',
  '2026/09/28,ﾌﾘｶｴ ｶｸｳｼﾝｷﾝ,"500,000",,"3,289,550"',
  '2026/09/28,ﾌﾘｺﾐﾃｽｳﾘﾖｳ,440,,"3,289,110"',
].join('\r\n');
// 9/25 から 10/2 までの明細（9/25・9/28 の3行は9月の明細と重なる）
const OVERLAP = [
  '日付,内容,金額,残高',
  '2026-09-25,ｶｸｳ ｻｯｶ,-89790,3789550',
  '2026-09-28,ﾌﾘｶｴ ｶｸｳｼﾝｷﾝ,-500000,3289550',
  '2026-09-28,ﾌﾘｺﾐﾃｽｳﾘﾖｳ,-440,3289110',
  '2026-10-02,ﾘｿｸ,12,3289122',
].join('\n');

test('明細の CSV を読む: 見出しの語・カンマ・符号つきの金額・読めない行', () => {
  const sep = parseStatement(SEPTEMBER);
  assert.deepEqual(sep.errors, []);
  assert.deepEqual(sep.lines.map((l) => [l.valueDate, l.direction, l.amountYen, l.balanceAfterYen]),
    [['2026-09-05', 'in', 1099340, 4099340], ['2026-09-10', 'out', 220000, 3879340], ['2026-09-25', 'out', 89790, 3789550],
      ['2026-09-28', 'out', 500000, 3289550], ['2026-09-28', 'out', 440, 3289110]]);
  const yen = parseStatement('取引日,入出金(円),取引後残高(円),入出金内容\n令和8年9月1日,"-1,000","9,000",ｶｸｳ\nR8.9.2,500,9500,ﾘｿｸ');
  assert.deepEqual(yen.errors, []);
  assert.deepEqual(yen.lines.map((l) => [l.valueDate, l.direction, l.amountYen, l.balanceAfterYen, l.description]),
    [['2026-09-01', 'out', 1000, 9000, 'カクウ'], ['2026-09-02', 'in', 500, 9500, 'リソク']]);
  const broken = parseStatement('日付,金額\n2026/13/01,100\n2026/09/01,1.5\n2026/09/02,300');
  assert.deepEqual(broken.errors.map((e) => e.row), [2, 3]);
  assert.equal(broken.lines.length, 1);
});

test('口座を作り、明細を取り込むと、日付順の履歴と残高の累計ができ、銀行の残高と一致する。重なる明細は二重に数えない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const defaults = await call(admin, '/pl-bs/accounts/defaults', {method: 'POST', payload: {}});
  assert.ok([200, 201].includes(defaults.status), JSON.stringify(defaults.body));

  const created = await call(admin, '/cashbook/accounts', {method: 'POST', payload: {label: '架空銀行 普通', bankName: '架空銀行', last4: '1234', openedOn: '2026-09-01', openingBalanceYen: 3000000}});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accountId = created.body.id;
  assert.equal((await call(admin, '/cashbook/accounts', {method: 'POST', payload: {label: '架空銀行 普通', openedOn: '2026-09-01', openingBalanceYen: 0}})).status, 409);
  assert.equal((await call(admin, '/cashbook/accounts', {method: 'POST', payload: {label: '全桁', last4: '12345678', openedOn: '2026-09-01'}})).status, 400);

  const preview = await call(admin, `/cashbook/accounts/${accountId}/preview`, {method: 'POST', payload: {fileName: '9月.csv', text: SEPTEMBER}});
  assert.equal(preview.status, 200);
  assert.deepEqual([preview.body.lineCount, preview.body.newLineCount, preview.body.errors.length], [5, 5, 0]);

  const imported = await call(admin, `/cashbook/accounts/${accountId}/imports`, {method: 'POST', payload: {fileName: '9月.csv', text: SEPTEMBER}});
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const again = await call(admin, `/cashbook/accounts/${accountId}/imports`, {method: 'POST', payload: {fileName: '9月.csv', text: SEPTEMBER}});
  assert.equal(again.status, 409);

  let detail = await call(admin, `/cashbook/accounts/${accountId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.history.map((h) => [h.date, h.inYen, h.outYen, h.balanceYen]),
    [['2026-09-01', 3000000, null, 3000000], ['2026-09-05', 1099340, null, 4099340], ['2026-09-10', null, 220000, 3879340],
      ['2026-09-25', null, 89790, 3789550], ['2026-09-28', null, 500000, 3289550], ['2026-09-28', null, 440, 3289110]]);
  assert.deepEqual(detail.body.check, {bankBalanceYen: 3289110, asOf: '2026-09-28', bookBalanceYen: 3289110, diffYen: 0});
  assert.equal(detail.body.unclassified, 5);

  const overlap = await call(admin, `/cashbook/accounts/${accountId}/imports`, {method: 'POST', payload: {fileName: '10月.csv', text: OVERLAP}});
  assert.equal(overlap.status, 201, JSON.stringify(overlap.body));
  assert.deepEqual([overlap.body.lineCount, overlap.body.newLineCount, overlap.body.duplicateCount], [4, 1, 3]);
  detail = await call(admin, `/cashbook/accounts/${accountId}`);
  assert.equal(detail.body.history.length, 7);
  assert.deepEqual(detail.body.check, {bankBalanceYen: 3289122, asOf: '2026-10-02', bookBalanceYen: 3289122, diffYen: 0});

  // 項目を付ける: 手数料の行を支払手数料ではなく雑費（既定の科目）へ。履歴の残高は変わらず、未分類が1件減る
  const summary = await call(admin, '/cashbook');
  const misc = summary.body.items.find((i) => i.name === '雑費');
  const fee = detail.body.history.find((h) => h.outYen === 440);
  const classified = await call(admin, `/cashbook/entries/${fee.entryId}/classify`, {method: 'POST', payload: {accountId: misc.id}});
  assert.equal(classified.status, 201, JSON.stringify(classified.body));
  assert.equal((await call(admin, `/cashbook/entries/${fee.entryId}/classify`, {method: 'POST', payload: {accountId: misc.id}})).status, 409);
  detail = await call(admin, `/cashbook/accounts/${accountId}`);
  assert.equal(detail.body.history.length, 7);
  assert.equal(detail.body.unclassified, 5);
  assert.deepEqual(detail.body.history.find((h) => h.outYen === 440).items, ['雑費']);
  assert.equal(detail.body.check.diffYen, 0);

  // 明細の無い入出金を手で足すと、履歴に入り、銀行の残高との差になる
  const manual = await call(admin, `/cashbook/accounts/${accountId}/manual`, {method: 'POST', payload: {date: '2026-09-30', direction: 'out', amountYen: 1000, accountId: misc.id, memo: '架空の現金払い'}});
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  detail = await call(admin, `/cashbook/accounts/${accountId}`);
  assert.equal(detail.body.check.diffYen, 1000);

  const list = await call(admin, '/cashbook');
  assert.deepEqual(list.body.accounts.map((a) => [a.label, a.bookBalanceYen, a.bankBalanceYen, a.diffYen]), [['架空銀行 普通', 3288122, 3289122, 1000]]);
});

test('入出金の履歴は管理者だけ。制作担当は 403', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const production = await login('production@openingnight.invalid');
  assert.equal((await call(production, '/cashbook')).status, 403);
  assert.equal((await call(production, '/cashbook/accounts', {method: 'POST', payload: {label: 'x', openedOn: '2026-09-01'}})).status, 403);
});

test('DB が断る: 借方と貸方が合わない仕訳、口座と科目の食い違い、仕訳の書き換え', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  await call(admin, '/pl-bs/accounts/defaults', {method: 'POST', payload: {}});
  const created = await call(admin, '/cashbook/accounts', {method: 'POST', payload: {label: '架空', openedOn: '2026-09-01', openingBalanceYen: 100}});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const cash = await db.get("SELECT id FROM gl_accounts WHERE org_id=1 AND system_key='cash'");
  const other = await db.get("SELECT id FROM gl_accounts WHERE org_id=1 AND code='6290'");
  const rejects = (promise, message) => assert.rejects(promise, (error) => { assert.equal(dbErrorKind(error), 'raise', error.message); assert.match(error.message, message); return true; });
  await rejects(db.batch([
    {sql: "INSERT INTO journal_entries(org_id,entry_date,source_kind,line_count,memo,created_by) VALUES(1,'2026-09-02','manual',2,'架空の不一致',1)", params: []},
    {sql: "INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen) VALUES(1,(SELECT id FROM journal_entries WHERE memo='架空の不一致'),1,?,'debit',100)", params: [other.id]},
    {sql: "INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen) VALUES(1,(SELECT id FROM journal_entries WHERE memo='架空の不一致'),2,?,'credit',90)", params: [cash.id]},
  ]), /debit and credit differ/);
  await rejects(db.batch([
    {sql: "INSERT INTO journal_entries(org_id,entry_date,source_kind,line_count,memo,created_by) VALUES(1,'2026-09-02','manual',2,'架空の口座違い',1)", params: []},
    {sql: "INSERT INTO journal_lines(org_id,entry_id,line_no,account_id,side,amount_yen,bank_account_id) VALUES(1,(SELECT id FROM journal_entries WHERE memo='架空の口座違い'),1,?,'debit',100,?)", params: [other.id, created.body.id]},
  ]), /must match its account/);
  await rejects(db.run("UPDATE journal_lines SET amount_yen=1 WHERE org_id=1"), /journal immutable/);
});
