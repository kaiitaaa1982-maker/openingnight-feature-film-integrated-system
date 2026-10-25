import {createApp} from '../src/app.mjs';
import {loadPlBsInput} from '../src/pl-bs/pl-bs-data.mjs';
import {buildPlBs} from '../src/reports/pl-bs-model.mjs';
import {verifyDemoExpenseCompatibility} from './req6-expense-compat-fixture.mjs';
import {readFileSync} from 'node:fs';
import {splitByWeights} from '../src/reports/pl-bs-model.mjs';
// 架空データの一括投入（scripts/seed-all-demo.mjs）の試験。
// ・6つの節を決まった順（売上 → 売上の流通の分類 → 制作 → 営業基幹 → 番販・放送 → PL・BS）で、白紙の DB へ1回で入れられる。
//   白紙の DB では売上の seed が最初から流通マスタの流通IDで分類するので、流通の分類の付け替え（2番目）は何もしない。
// ・2回目はどの seed も入れ済みで、表の行数が変わらず、ログインのほかは書かない（本番の写しへ流し直しても増えない）。
// ・記録した書き込みは本番へ再生できる形（DDL なし・1文の値は100個まで・1回の batch は480文まで・1つの値は128KB未満・ログインの行を含まない）。
// ・入れた後、各画面の API（デモ資料の組織判定・提案資料・放送履歴表・アベイルズ・放送ウィンドウ提案・提案から作った下書き・PL・BS・売上集計シート・流通ID・香盤）が数字を返す。
// ・最後の節（シナリオの比較）が入れた商談・活動・委託・自社出資・委員会の行は、test/fixtures/scenario/compare-request.json の facts と同じ値で、
//   画面を全部見る利用者 demo-admin@openingnight.invalid の財務権限に全部入る。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {DEMO_SEED_STEPS, seedAllDemo, recordingDatabase, businessBatches, d1LimitViolations, recordLines, tableCounts, countDifferences, checkDemoApis,
  SEED_RECORD_FORMAT, isSessionWrite} from '../scripts/seed-all-demo.mjs';
import {INITIAL_SHEET_COLUMNS, ROYALTY_AMOUNT_KEYS} from '../src/sales-sheet/column-registry.mjs';
import {fictionalSeedAmounts, COMPENSATION_TABLE_NAME} from './personal-amount-fixture.mjs';

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
  assert.deepEqual(DEMO_SEED_STEPS.map((step) => step.key), ['sales', 'distribution', 'kouban', 'eigyo', 'broadcast', 'plbs', 'expenses', 'masters', 'expense-originals', 'scenario']);
  // 流通の分類の付け替えは、旧区分で入れた DB（2026-09-25 の本番）だけが対象。白紙の DB では売上の seed が流通マスタの ID で分類済み
  assert.deepEqual(first.map((row) => [row.key, row.skipped]), DEMO_SEED_STEPS.map((step) => [step.key, step.key === 'distribution']));
  assert.equal(first.find((row) => row.key === 'distribution').result.reclassified, 0);
  // どの seed の書き込みか分かるように記録する（順番どおりに並ぶ）
  const order = [...new Set(firstBatches.map((batch) => batch.step))];
  assert.deepEqual(order, ['sales', 'kouban', 'eigyo', 'broadcast', 'plbs', 'expenses', 'masters', 'expense-originals', 'scenario']);
});

test('2回目はどの seed も入れ済みで、表の行数が変わらず、ログインのほかは書かない', () => {
  assert.deepEqual(second.map((row) => [row.key, row.skipped]), DEMO_SEED_STEPS.map((step) => [step.key, true]));
  assert.deepEqual(countDifferences(before2, after2), []);
  assert.deepEqual(businessBatches(secondBatches), [], '2回目の書き込みはログイン（sessions）だけ');
  assert.ok(secondBatches.every((batch) => batch.statements.every((s) => isSessionWrite(s.sql))));
});

test('FR-REV-KPI-016 種を流した DB の目標・計画の行は、架空の種（test/fixtures/yojitsu/seed.json）の fictional の印の行の額だけで、報酬の表に行を入れない', async () => {
  // 目標・計画の行を入れる種（フェーズ1 #23d）が入るまでは0行。入ったあとも、印の無い行の額（実額のおそれ）を入れない。値が実額かは見られない（人が PR で見る）
  const {targets, plans} = fictionalSeedAmounts();
  const targetValues = (await base.all('SELECT amount_yen, source1_yen, source2_yen, source3_yen, source4_yen, source5_yen FROM yojitsu_target_versions'))
    .flatMap((row) => Object.values(row)).filter((value) => value !== null).map(Number);
  assert.deepEqual(targetValues.filter((value) => !targets.has(value)), []);
  const planValues = (await base.all('SELECT amount_yen FROM yojitsu_plan_amounts')).map((row) => Number(row.amount_yen));
  assert.deepEqual(planValues.filter((value) => !plans.has(value)), []);
  // 報酬の表（フェーズ1 #17。名前は COMPENSATION_TABLE_NAME の取り決め）に、種は行を入れない（報酬の額は代表が DB に入れる）
  assert.ok(Object.keys(after2).includes('yojitsu_target_versions'), '表の行数を読めていない');
  assert.deepEqual(Object.entries(after2).filter(([name, count]) => COMPENSATION_TABLE_NAME.test(name) && count > 0), []);
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
  // 27作品＋シナリオの比較の4作品（DEMO-SCN-W1〜W4）。経費の相殺例では作品を増やさない
  assert.equal((await db.get("SELECT COUNT(*) n FROM works w JOIN organizations o ON o.id=w.org_id WHERE o.code='DEMO-SALES'")).n,31,'相殺例で作品を増やさない');
  assert.equal((await db.get("SELECT COUNT(*) n FROM works w JOIN organizations o ON o.id=w.org_id WHERE o.code='DEMO-SALES' AND w.code LIKE 'DEMO-SCN-W%'")).n,4);
  assert.equal(await db.get("SELECT id FROM works WHERE code='DEMO-EXP-OFFSET'"),null);
  const failed = checks.filter((row) => !row.ok);
  assert.deepEqual(failed, [], failed.map((row) => `${row.name}: ${row.detail}`).join('\n'));
  assert.deepEqual(checks.map((row) => row.name), ['デモ資料の組織判定（香盤のデモ・売上集計シート）', '提案資料（月別5種）', '提案資料（SVOD）', '放送履歴表', '放送アベイルズリスト（照合と Excel）',
    '放送ウィンドウ提案（全作品）', '放送ウィンドウ提案から作った下書き', '経費（請求書・未整備・出金予定）', 'PL・BS（作品別・会社）', '売上集計シート（単独の画面）', '売上集計シートの流通ID（流通マスタの ID）', '作品・商品マスタ（契約・費用・権利元・仕様）', '香盤（連続ドラマ DEMO-D78）']);
  assert.match(checks.find((row) => row.name.startsWith('売上集計シートの流通ID')).detail, /旧区分のまま seed の分 0行・利用者が残した分 0行・分類なし \d+行/);
  assert.deepEqual(businessBatches(checkBatches), []);
  // 列セット名 additional は全列の別名。全列は辞書の採用の列から補助の列（h_）を除いたもの（架空データはロイヤリティ計上の額の食い違いが0件なので、その4列も入らない）
  const allColumns = INITIAL_SHEET_COLUMNS.filter((column) => !ROYALTY_AMOUNT_KEYS.includes(column.column_key) && !column.column_key.startsWith('h_')).length;
  assert.match(checks.find((row) => row.name === '売上集計シート（単独の画面）').detail, new RegExp(`全列（additional）${allColumns}列`));
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

test('シナリオの比較の種: 商談・活動・委託・自社出資・委員会の行が fixture の facts と同じ値で、demo-admin の財務権限に全部入る', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/scenario/compare-request.json', import.meta.url), 'utf8'));
  const {facts, seed} = fixture;
  // 種に無い model だけの行（seed.workCodes に無い作品の商談と売上。fixture の seed.modelOnly）は DB と照らさない
  const seeded = (row) => Object.hasOwn(seed.workCodes, String(row.workId));
  const seededOpportunities = facts.opportunities.filter(seeded);
  const org = await db.get("SELECT id FROM organizations WHERE code='DEMO-SALES'");
  const workIdOf = new Map((await db.all("SELECT id, code FROM works WHERE org_id=? AND code LIKE 'DEMO-SCN-W%'", [org.id])).map((row) => [row.code, row.id]));
  const partnerIdOf = new Map((await db.all("SELECT id, code FROM partners WHERE org_id=? AND code LIKE 'DEMO-SCN-%'", [org.id])).map((row) => [row.code, row.id]));
  const work = (fixtureWorkId) => workIdOf.get(seed.workCodes[String(fixtureWorkId)]);
  const partner = (fixturePartnerId) => partnerIdOf.get(seed.partnerCodes[String(fixturePartnerId)]);
  // 画面を全部見る利用者で入り、財務権限で絞る商談の一覧に種の商談が全部出る
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'demo-admin@openingnight.invalid'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = async (path) => (await app.request(`/api${path}`, {headers: {cookie}})).json();
  const byName = new Map((await get('/opportunities')).rows.map((row) => [row.name, row]));
  for (const o of seededOpportunities) {
    const row = byName.get(seed.opportunityNames[String(o.id)]);
    assert.ok(row, `商談 ${o.id} が demo-admin の財務権限で見えない`);
    assert.deepEqual({workId: row.work_id, partnerId: row.partner_id, stage: row.stage, expectedYen: row.expected_yen, closeDate: row.close_date},
      {workId: work(o.workId), partnerId: partner(o.partnerId), stage: o.stage, expectedYen: o.expectedYen, closeDate: o.closeDate}, `商談 ${o.id}`);
  }
  const idOf = new Map(seededOpportunities.map((o) => [o.id, byName.get(seed.opportunityNames[String(o.id)]).id]));
  const activities = await db.all('SELECT opportunity_id, occurred_on, activity_type FROM sales_activities WHERE org_id=? ORDER BY id', [org.id]);
  assert.deepEqual(activities.map((row) => [row.opportunity_id, row.occurred_on, row.activity_type]),
    facts.activities.map((row) => [idOf.get(row.opportunityId), row.occurredOn, row.activityType]));
  // 売上（作品×取引先×月・税抜）
  const sales = await db.all(`SELECT r.work_id, s.partner_id, s.accounting_month AS month, SUM(s.amount_ex_tax) AS amount FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=? AND r.status='active' AND r.report_key LIKE 'DEMO-SCN-%' GROUP BY r.work_id, s.partner_id, s.accounting_month ORDER BY r.work_id, s.partner_id, s.accounting_month`, [org.id]);
  const expectSales = facts.salesByWorkPartner.filter(seeded).map((row) => [work(row.workId), partner(row.partnerId), row.month, row.amountYen])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  assert.deepEqual(sales.map((row) => [row.work_id, row.partner_id, row.month, row.amount]), expectSales);
  // 販売委託（W1）: 手数料と権利元へ渡る額、未紐付けの報告
  const preview = await get(`/settlement/preview?workId=${work(101)}`);
  const commission = preview.lineResults.filter((row) => row.contractType === 'commission');
  assert.deepEqual([commission.reduce((n, row) => n + row.agencyFee, 0), commission.reduce((n, row) => n + row.holderAmount, 0)],
    [facts.consignment[0].agencyFeePeriodYen, facts.consignment[0].holderAmountPeriodYen]);
  assert.equal(preview.unlinkedCount, facts.unlinkedReports.count);
  // 作品マスタ: 買付額（W2）と自社出資の出資額（W3）
  const finance = new Map((await db.all('SELECT work_id, own_investment_yen, sales_rights_purchase_yen FROM work_finance_versions WHERE org_id=? AND work_id IN (?,?)', [org.id, work(102), work(103)]))
    .map((row) => [row.work_id, row]));
  assert.equal(finance.get(work(102)).sales_rights_purchase_yen, facts.acquisition.find((row) => row.workId === 102).purchaseYen);
  assert.equal(finance.get(work(103)).own_investment_yen, facts.ownInvestment[0].investmentYen);
  // 自社出資の回収額（W3 の入金・税込）と委員会（W4）の自社の取得額・払込: 回収待ちと回収済みの両方
  const user = await db.get("SELECT id FROM users WHERE email='demo-admin@openingnight.invalid'");
  const input = await loadPlBsInput(db, {org_id: org.id, user_id: user.id, role: 'admin'}, app.ux, {from: '2026-04', to: '2027-03', asOf: '2026-09-25', workIds: [work(103), work(104)], includeCompany: false});
  let receipts = 0;
  for (const r of input.receipts) receipts += (splitByWeights(r.amount, r.weights.map((w) => ({key: w.workId, weight: w.weight}))) || new Map()).get(work(103)) || 0;
  assert.equal(receipts, facts.ownInvestment[0].receiptsTotalYen);
  assert.ok(receipts < facts.ownInvestment[0].investmentYen, '自社出資は回収待ち');
  const committee = input.committee.find((row) => row.workId === work(104));
  const fixtureCommittee = facts.committee.find((row) => row.workId === 104);
  assert.equal(committee.acquisitions.reduce((n, row) => n + row.acquisition, 0), fixtureCommittee.acquisitionsTotalYen);
  assert.equal(input.investmentPayments.filter((row) => row.workId === work(104)).reduce((n, row) => n + row.amount, 0), fixtureCommittee.paymentsTotalYen);
  assert.ok(fixtureCommittee.acquisitionsTotalYen > fixtureCommittee.paymentsTotalYen, '委員会は回収済み');
});
