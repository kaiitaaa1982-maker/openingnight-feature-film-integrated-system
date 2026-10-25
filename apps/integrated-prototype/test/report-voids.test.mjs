// 報告の取消の記録（移行 0021 の report_voids。フォルダ型の画面の最初の一切れ 区切り U1・香盤表 #3）を、DB の制約とトリガーで確かめる。
// 期待値は要件 docs/requirements/revenue/report-intake.md の FR-REV-INTAKE-053（取消は取り違えに限り請求前だけ。理由を必須にして残す）と、
// 会社ルートの plans/2026-10-18-folder-ui-first-slice.md の「足す」の表2（同じ書き込みで report_imports.status を void にする。請求済みは既存の
// トリガー billed_report_locked_update が止める。取消の記録は変更も削除もできない）。
// 取り消す受け口・監査・画面はまだ無い（区切り U3・U5）ので、受け口が書くのと同じ1つの書き込み（batch）を直接流して確かめる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openTestDb} from './test-db.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const OUTSIDER = 4; // 組織2の管理者（試作の行）
const PARTNER_DIGITAL = 2; // 組織1の架空配信（試作の行）
const sha = (label) => createHash('sha256').update(label).digest('hex');

const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});

// 作品1・架空配信の報告1件と、その売上明細（[税抜, 税額] を並べる。税込は和）
async function registerReport(db, key, amounts, {status = 'active'} = {}) {
  const reportId = Number((await db.get(`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,
    content_hash,status,created_by) VALUES(1,1,?,?,'digital','2026-08-01','2026-08-31','2026-09','作品CD,正味売上',?,?,?) RETURNING id`,
  [PARTNER_DIGITAL, key, sha(key), status, ADMIN])).id);
  const saleIds = [];
  for (const [i, [exTax, tax]] of amounts.entries()) {
    saleIds.push(Number((await db.get(`INSERT INTO sale_lines(org_id,project_id,work_id,report_id,product_id,partner_id,sales_period_from,sales_period_to,
      accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax,source_row) VALUES(1,1,1,?,1,?,'2026-08-01','2026-08-31','2026-09',?,?,?,?,?) RETURNING id`,
    [reportId, PARTNER_DIGITAL, `架空の配信 ${key} ${i + 1}`, exTax, tax, exTax + tax, i + 3])).id));
  }
  return {reportId, saleIds};
}

// 報告の売上を請求に入れる（請求の受け口が書く行を、同じ順に直接書く）
async function bill(db, reportId) {
  const sales = await db.all('SELECT * FROM sale_lines WHERE org_id=1 AND report_id=? ORDER BY id', [reportId]);
  const exTax = sales.reduce((n, s) => n + Number(s.amount_ex_tax), 0);
  const tax = sales.reduce((n, s) => n + Number(s.tax_amount), 0);
  const invoiceId = Number((await db.get(`INSERT INTO billing_invoices(org_id,invoice_number,partner_id,invoice_date,due_date,source_amount_basis,amount_ex_tax,
    tax_amount,amount_inc_tax,snapshot_json,snapshot_hash,created_by) VALUES(1,?,?,'2026-09-30','2026-10-31','platform_net',?,?,?,'{}',?,?) RETURNING id`,
  [`ON-INV-TEST-${reportId}`, PARTNER_DIGITAL, exTax, tax, exTax + tax, sha(`invoice-${reportId}`), ADMIN])).id);
  for (const s of sales) {
    await db.run(`INSERT INTO billing_invoice_lines(org_id,invoice_id,sale_id,report_id,project_id,work_id,product_id,partner_id,description,accounting_month,
      source_row,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [invoiceId, s.id, s.report_id, s.project_id, s.work_id, s.product_id, s.partner_id, s.description, s.accounting_month, s.source_row,
      s.amount_ex_tax, s.tax_amount, s.amount_inc_tax]);
    await db.run('INSERT INTO billing_invoice_line_works(org_id,invoice_id,sale_id,work_id,allocation_bps) VALUES(1,?,?,1,10000)', [invoiceId, s.id]);
    await db.run('INSERT INTO billing_sale_claims(org_id,sale_id,invoice_id) VALUES(1,?,?)', [s.id, invoiceId]);
  }
  return invoiceId;
}

// 取消の受け口が書く1つの書き込み: 報告を void にしてから、取消の記録を足す
const voidReport = (db, reportId, {reason = '別の取引先の報告を取り違えて登録した', by = ADMIN, orgId = 1} = {}) => db.batch([
  {sql: "UPDATE report_imports SET status='void' WHERE org_id=? AND id=? AND status='active'", params: [orgId, reportId]},
  {sql: 'INSERT INTO report_voids(org_id,report_id,reason,created_by) VALUES(?,?,?,?)', params: [orgId, reportId, reason, by]},
]);
const statusOf = async (db, reportId) => (await db.get('SELECT status FROM report_imports WHERE org_id=1 AND id=?', [reportId])).status;
const voidCount = async (db) => Number((await db.get('SELECT count(*) AS n FROM report_voids')).n);
// 有効な報告だけを数える読み手の約束（status='active'）での、売上明細の件数と税抜の和
const activeSales = async (db) => {
  const row = await db.get(`SELECT count(*) AS n, COALESCE(SUM(s.amount_ex_tax),0) AS ex_tax FROM sale_lines s
    JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=1 AND r.status='active'`);
  return [Number(row.n), Number(row.ex_tax)];
};

test('FR-REV-INTAKE-053 請求前の報告は、1つの書き込みで void にして理由・誰が・いつを残して取り消せ、売上明細は消さずに有効な報告の数から外れる', async (t) => {
  const db = await openTestDb({t});
  const kept = await registerReport(db, 'VOID-KEEP', [[5000, 500]]);
  const mistaken = await registerReport(db, 'VOID-MISTAKE', [[12000, 1200], [3000, 300]]);
  assert.deepEqual(await activeSales(db), [3, 20000]);
  await voidReport(db, mistaken.reportId);
  assert.equal(await statusOf(db, mistaken.reportId), 'void');
  assert.equal(await statusOf(db, kept.reportId), 'active');
  const record = await db.get('SELECT report_id,reason,created_by,created_at FROM report_voids WHERE org_id=1 AND report_id=?', [mistaken.reportId]);
  assert.deepEqual([Number(record.report_id), record.reason, Number(record.created_by)], [mistaken.reportId, '別の取引先の報告を取り違えて登録した', ADMIN]);
  assert.match(record.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 売上明細は消さない（取消として辿れる）。有効な報告だけを数えると、取り消した報告の分（2件・15,000円）だけ減る
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM sale_lines WHERE org_id=1 AND report_id=?', [mistaken.reportId])).n), 2);
  assert.deepEqual(await activeSales(db), [1, 5000]);
});

test('FR-REV-INTAKE-053 請求済みの売上を含む報告は取り消せず、取消の書き込みの全体が戻る（既存のトリガー billed_report_locked_update）', async (t) => {
  const db = await openTestDb({t});
  const billed = await registerReport(db, 'VOID-BILLED', [[8000, 800], [2000, 200]]);
  await bill(db, billed.reportId);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM billing_sale_claims WHERE org_id=1')).n), 2);
  await rejects(voidReport(db, billed.reportId), 'raise', /report with billed sales is locked/);
  assert.equal(await statusOf(db, billed.reportId), 'active');
  assert.equal(await voidCount(db), 0, '取消の記録も残らない（1つの書き込みで戻る）');
  // void にしないまま記録だけを足すことも断る
  await rejects(db.run('INSERT INTO report_voids(org_id,report_id,reason,created_by) VALUES(1,?,?,?)', [billed.reportId, '請求のあとで気づいた取り違え', ADMIN]),
    'raise', /取消の記録は、同じ書き込みで報告を取消（void）にしてから足します/);
  assert.equal(await voidCount(db), 0);
  assert.deepEqual(await activeSales(db), [2, 10000]);
});

test('FR-REV-INTAKE-053 取消の記録は void にした報告にだけ足せ、理由は必須で、報告ごとに1つだけ、変更も削除もできない', async (t) => {
  const db = await openTestDb({t});
  const active = await registerReport(db, 'VOID-ACTIVE', [[1000, 100]]);
  const superseded = await registerReport(db, 'VOID-OLD', [[1000, 100]], {status: 'superseded'});
  // 有効な報告・置き換え済みの報告には、記録だけを足せない
  await rejects(db.run('INSERT INTO report_voids(org_id,report_id,reason,created_by) VALUES(1,?,?,?)', [active.reportId, '理由', ADMIN]), 'raise', /同じ書き込みで報告を取消/);
  await rejects(db.run('INSERT INTO report_voids(org_id,report_id,reason,created_by) VALUES(1,?,?,?)', [superseded.reportId, '理由', ADMIN]), 'raise', /同じ書き込みで報告を取消/);
  // 理由の無い取消は、void への更新も含めて全体が戻る
  await rejects(voidReport(db, active.reportId, {reason: '  '}), 'check');
  assert.equal(await statusOf(db, active.reportId), 'active');
  await rejects(voidReport(db, active.reportId, {reason: 'あ'.repeat(1001)}), 'check');
  assert.equal(await statusOf(db, active.reportId), 'active');
  // 理由のちょうど1000字は通る
  await voidReport(db, active.reportId, {reason: 'あ'.repeat(1000)});
  assert.equal(await statusOf(db, active.reportId), 'void');
  // 2つ目の記録は断る（報告ごとに1つ）
  await rejects(db.run('INSERT INTO report_voids(org_id,report_id,reason,created_by) VALUES(1,?,?,?)', [active.reportId, '二度目', ADMIN]), 'unique');
  // 変更・削除は DB が断る
  await rejects(db.run("UPDATE report_voids SET reason='書き換えた理由' WHERE org_id=1 AND report_id=?", [active.reportId]), 'raise', /報告の取消の記録は変更できません/);
  await rejects(db.run('UPDATE report_voids SET created_by=2 WHERE org_id=1 AND report_id=?', [active.reportId]), 'raise', /変更できません/);
  await rejects(db.run('DELETE FROM report_voids WHERE org_id=1 AND report_id=?', [active.reportId]), 'raise', /報告の取消の記録は削除できません/);
  const rows = await db.all('SELECT report_id,reason,created_by FROM report_voids');
  assert.deepEqual(rows.map((r) => [Number(r.report_id), r.reason.length, Number(r.created_by)]), [[active.reportId, 1000, ADMIN]]);
});

test('FR-REV-INTAKE-053 組織の境界: 別の組織の報告や利用者では取消の記録を作れない', async (t) => {
  const db = await openTestDb({t});
  const report = await registerReport(db, 'VOID-ORG', [[4000, 400]]);
  // 組織2として組織1の報告を取り消そうとしても、組織2に void の報告が無いので記録を足せず、組織1の報告も変わらない
  await rejects(voidReport(db, report.reportId, {orgId: 2, by: OUTSIDER}), 'raise', /同じ書き込みで報告を取消/);
  assert.equal(await statusOf(db, report.reportId), 'active');
  // 組織2の利用者を、組織1の取消をした人にはできない（書き込みの全体が戻る）
  await rejects(voidReport(db, report.reportId, {by: OUTSIDER}), 'foreign_key');
  assert.equal(await statusOf(db, report.reportId), 'active');
  assert.equal(await voidCount(db), 0);
});
