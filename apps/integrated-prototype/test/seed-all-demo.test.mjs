import {createApp} from '../src/app.mjs';
import {loadPlBsInput} from '../src/pl-bs/pl-bs-data.mjs';
import {buildPlBs} from '../src/reports/pl-bs-model.mjs';
import {verifyDemoExpenseCompatibility} from './req6-expense-compat-fixture.mjs';
// 架空データの一括投入（scripts/seed-all-demo.mjs）の試験。
// ・6つの節を決まった順（売上 → 売上の流通の分類 → 制作 → 営業基幹 → 番販・放送 → PL・BS）で、白紙の DB へ1回で入れられる。
//   白紙の DB では売上の seed が最初から流通マスタの流通IDで分類するので、流通の分類の付け替え（2番目）は何もしない。
// ・2回目はどの seed も入れ済みで、表の行数が変わらず、ログインのほかは書かない（本番の写しへ流し直しても増えない）。
// ・記録した書き込みは本番へ再生できる形（DDL なし・1文の値は100個まで・1回の batch は480文まで・1つの値は128KB未満・ログインの行を含まない）。
// ・入れた後、各画面の API（デモ資料の組織判定・提案資料・放送履歴表・アベイルズ・放送ウィンドウ提案・提案から作った下書き・PL・BS・売上集計シート・流通ID・香盤）が数字を返す。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {DEMO_SEED_STEPS, seedAllDemo, recordingDatabase, businessBatches, d1LimitViolations, recordLines, tableCounts, countDifferences, checkDemoApis,
  SEED_RECORD_FORMAT, isSessionWrite} from '../scripts/seed-all-demo.mjs';

const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let base, db, first, firstBatches, second, secondBatches, before2, after2, checks, checkBatches;
before(async (t) => {
  base = await openTestDb({t});
  db = recordingDatabase(base);
  first = await seedAllDemo(db, {python});
  firstBatches = db.batches;
  before2 = await tableCounts(base);
  db.batches = [];
  second = await seedAllDemo(db, {python});
  secondBatches = db.batches;
  after2 = await tableCounts(base);
  db.batches = [];
  checks = await checkDemoApis(db);
  checkBatches = db.batches;
});
after(() => base?.close());

test('流す順は 売上 → 売上の流通の分類 → 制作 → 営業基幹 → 番販・放送 → PL・BS で、白紙の DB へ1回で全部入る', () => {
  assert.deepEqual(DEMO_SEED_STEPS.map((step) => step.key), ['sales', 'distribution', 'kouban', 'eigyo', 'broadcast', 'plbs', 'expenses', 'masters', 'expense-originals']);
  // 流通の分類の付け替えは、旧区分で入れた DB（2026-09-25 の本番）だけが対象。白紙の DB では売上の seed が流通マスタの ID で分類済み
  assert.deepEqual(first.map((row) => [row.key, row.skipped]), DEMO_SEED_STEPS.map((step) => [step.key, step.key === 'distribution']));
  assert.equal(first.find((row) => row.key === 'distribution').result.reclassified, 0);
  // どの seed の書き込みか分かるように記録する（順番どおりに並ぶ）
  const order = [...new Set(firstBatches.map((batch) => batch.step))];
  assert.deepEqual(order, ['sales', 'kouban', 'eigyo', 'broadcast', 'plbs', 'expenses', 'masters', 'expense-originals']);
});

test('2回目はどの seed も入れ済みで、表の行数が変わらず、ログインのほかは書かない', () => {
  assert.deepEqual(second.map((row) => [row.key, row.skipped]), DEMO_SEED_STEPS.map((step) => [step.key, true]));
  assert.deepEqual(countDifferences(before2, after2), []);
  assert.deepEqual(businessBatches(secondBatches), [], '2回目の書き込みはログイン（sessions）だけ');
  assert.ok(secondBatches.every((batch) => batch.statements.every((s) => isSessionWrite(s.sql))));
});

test('記録は本番へ再生できる形: DDL なし・1文の値は100個まで・1回の batch は480文まで・1つの値は128KB未満。ログインの行は入れない', () => {
  const batches = businessBatches(firstBatches);
  assert.ok(batches.length > 1000, `書き込みの batch が少なすぎる（${batches.length}）`);
  assert.deepEqual(d1LimitViolations(batches), []);
  const lines = recordLines(batches, {asOf: '2026-09-25'}).trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].format, SEED_RECORD_FORMAT);
  assert.equal(lines.length, batches.length + 1);
  assert.ok(lines.slice(1).every((line) => line.statements.every((s) => !isSessionWrite(s.sql) && Array.isArray(s.params))));
  // 上限の判定そのもの: 101個の値・481文の batch・128KB の値・DDL はどれも止める
  const long = 'x'.repeat(128 * 1024);
  const bad = d1LimitViolations([
    {step: 't', statements: [{sql: 'INSERT INTO t VALUES(?)', params: Array(101).fill(1)}]},
    {step: 't', statements: Array.from({length: 481}, () => ({sql: 'INSERT INTO t VALUES(1)', params: []}))},
    {step: 't', statements: [{sql: 'INSERT INTO t VALUES(?)', params: [long]}, {sql: 'CREATE TABLE x(a)', params: []}]},
  ]);
  assert.equal(bad.length, 4, bad.join('\n'));
});

test('入れた後、各画面の API が数字を返し、確かめる間はログインのほかは書かない', async () => {
  assert.equal((await db.get("SELECT COUNT(*) n FROM works w JOIN organizations o ON o.id=w.org_id WHERE o.code='DEMO-SALES'")).n,27,'相殺例で作品を増やさない');
  assert.equal(await db.get("SELECT id FROM works WHERE code='DEMO-EXP-OFFSET'"),null);
  const failed = checks.filter((row) => !row.ok);
  assert.deepEqual(failed, [], failed.map((row) => `${row.name}: ${row.detail}`).join('\n'));
  assert.deepEqual(checks.map((row) => row.name), ['デモ資料の組織判定（香盤のデモ・売上集計シート）', '提案資料（月別5種）', '提案資料（SVOD）', '放送履歴表', '放送アベイルズリスト（照合と Excel）',
    '放送ウィンドウ提案（全作品）', '放送ウィンドウ提案から作った下書き', '経費（請求書・未整備・出金予定）', 'PL・BS（作品別・会社）', '売上集計シート（単独の画面）', '売上集計シートの流通ID（流通マスタの ID）', '作品・商品マスタ（契約・費用・権利元・仕様）', '香盤（連続ドラマ DEMO-D78）']);
  assert.match(checks.find((row) => row.name.startsWith('売上集計シートの流通ID')).detail, /旧区分のまま seed の分 0行・利用者が残した分 0行・分類なし \d+行/);
  assert.deepEqual(businessBatches(checkBatches), []);
  assert.match(checks.find((row) => row.name === '売上集計シート（単独の画面）').detail, /追加の列 28列/);
  // DEMO-DAY-31: 2026-02の全社共通・事務費1,000円を区切り①で追加。計算式の変更ではない。
  const added=await base.get("SELECT e.accounting_month,e.category,e.actual_ex_tax,e.tax_amount,e.work_id FROM expenses e JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id JOIN expense_invoices i ON i.org_id=d.org_id AND i.id=d.invoice_id WHERE i.code='DEMO-DAY-31'");
  assert.deepEqual({...added},{accounting_month:'2026-02',category:'事務費',actual_ex_tax:1000,tax_amount:100,work_id:null});
  // PL・BS の数字は架空データの設計（pl-bs-design.md §6）の値と同じ
  // 現預金は期間を通してプラス（架空の追加借入）、差額は0（減価償却費に見合う固定資産の月末残高も入れる）
  assert.match(checks.find((row) => row.name.startsWith('PL・BS')).detail, /当期純利益 -142,944,560円.*現預金 77,941,484円・説明のつかない差額 0円/);
});

// 旧規則と独立に列挙した費目対応・四則演算で全27作品と会社の各月を照合。
test('依頼6③：架空の全作品・会社PLを円照合（各月・期間・累計・4科目・委員会取得額）',async()=>{
 const org=await db.get("SELECT id FROM organizations WHERE code='DEMO-SALES'"),workIds=(await db.all('SELECT id FROM works WHERE org_id=?',[org.id])).map(w=>w.id);
 const user=await db.get("SELECT user_id FROM memberships WHERE org_id=? AND role='admin'",[org.id]);
 const input=await loadPlBsInput(db,{org_id:org.id,user_id:user.user_id,role:'admin'},createApp({db,mode:'local'}).ux,{from:'2025-05',to:'2026-04',asOf:'2026-06',workIds,includeCompany:true});
 const result=verifyDemoExpenseCompatibility(input,buildPlBs(input));assert.equal(result.period,-142944560);assert.deepEqual(result.differences,[]);
 const full={...input,from:'2024-01'},cumulative=verifyDemoExpenseCompatibility(full,buildPlBs(full));assert.equal(cumulative.period,result.cumulative);
 console.log('REQ6_COMPAT '+JSON.stringify({...result,comparisons:result.comparisons+cumulative.comparisons,works:workIds.length,expenses:input.expenses.length}));
});
