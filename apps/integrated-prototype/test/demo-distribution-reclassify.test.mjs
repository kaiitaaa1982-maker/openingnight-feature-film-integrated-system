// 架空データ（DEMO-SALES）の売上明細の流通の分類を、旧区分から流通マスタの流通IDへ付け替える節（scripts/seed-sales-distribution.mjs）の試験。
// ・2026-09-25 に本番へ入れた形（seed-sales-demo の legacyDistribution: 旧区分・精算方式は未確認）を作り、営業基幹・番販・PL・BS の seed も入れる。
// ・付け替えの前後で、ロイヤリティ（集計シート・報告書・期間の下書き・報告書の帳票）、委員会の月次収支、MG、流通別売上・年間売上、作品別収支、
//   PL・BS（作品別・会社）、売上集計シート・帳票センターの金額が1円も変わらないこと。区分の違う表示（流通ID・取引区分）だけが変わる。
// ・付け替えた後の分類は、白紙の DB に今の seed を入れたとき（最初から流通マスタの ID で分類）と明細ごとに同じになること。
// ・付け替えは旧区分のまま seed が入れた分類だけ。利用者が分類し直した明細・分類の無い明細・ほかの組織の旧区分の分類には触れない。2回目は何もしない。
// ・書き込みは API（分類の登録）を通り監査に残る。D1 の上限（DDL なし・1文100値・batch 480文）を守る。
// ・流通の表示名は流通IDごとに区別できる形（「D004｜配信｜RS｜TVOD」）で、年間売上・作品別収支のカードに同じ名前が並ばない。
// ・seed-all-demo の --check-api の流通IDの確認は、seed が入れた旧区分が残ると NG、利用者が残した旧区分は NG にせず件数と売上IDを出す。
//   --only で付け替えの節を外したとき（配備の前に入れる記録）は、seed の旧区分が残っていても NG にしない（req4-integration.md §3 の手順どおりに流して止まらない）。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv} from '../src/csv.mjs';
import {seedSalesDemo, SALES_DEMO, DEMO_CLASSIFY_REASON, DEMO_DISTRIBUTION} from '../scripts/seed-sales-demo.mjs';
import {reclassifyDemoSalesDistribution, RECLASSIFY_REASON} from '../scripts/seed-sales-distribution.mjs';
import {seedAllDemo, recordingDatabase, businessBatches, d1LimitViolations, tableCounts, countDifferences, checkDemoApis} from '../scripts/seed-all-demo.mjs';

const FIXTURE_ADMIN = 'admin@openingnight.invalid';
// 付け替えで分類の区分が変わってはいけない（独立に書いた対応。旧区分 → ロイヤリティ・委員会の区分、流通ID → 区分）
const LEGACY_GROUP = {theatrical: 'theatrical', package_rental: 'rental', package_sell: 'sell', tvod: 'digital', svod: 'digital', avod: 'digital',
  broadcast_bs: 'broadcast', broadcast_free: 'broadcast', other: 'overseas'};
const MASTER_GROUP = {H001: 'theatrical', R004: 'rental', S001: 'sell', S002: 'sell', D004: 'digital', D005: 'digital', D006: 'digital', B001: 'broadcast', A001: 'overseas', A003: 'overseas'};

let legacyDb, freshDb, app, orgId, cookie, fixtureCookie;
let before1, after1, first, second, recorded, countsBefore, countsAfter, countsSecond, userTouched, fixtureSale, idCheckBefore, idCheckAfter, idCheckDeferred, idCheckOnlyDistribution;
const idCheck = async (db, options = {}) => (await checkDemoApis(db, options)).find((row) => row.name.startsWith('売上集計シートの流通ID'));
const WITHOUT_DISTRIBUTION = ['sales', 'kouban', 'eigyo', 'broadcast', 'plbs'];

async function loginAs(email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200, email);
  return response.headers.get('set-cookie').split(';')[0];
}
async function call(who, path, payload) {
  const response = await app.request(`/api${path}`, {method: payload ? 'POST' : 'GET', headers: {cookie: who, 'content-type': 'application/json'}, body: payload ? JSON.stringify(payload) : undefined});
  const body = await response.json();
  assert.ok(response.status < 300 && body.ok !== false, `${path}: ${response.status} ${body.error || ''}`);
  return body;
}
// 時刻（作った時刻・データの時点）と、区分の表示（流通ID・流通名・取引区分）を除く。残るのは金額・件数・状態
const VOLATILE = new Set(['generatedAt', 'dataAsOf', 'latestImportAt']);
const DISPLAY = /^(distribution|distributionCode|distributionLabel|distribution_code|distribution_label|distribution_name|distribution_version|deal|deal_label|deals|settlement_method|settlementMethod|types)$/;
function strip(value, {display = true} = {}) {
  if (Array.isArray(value)) return value.map((item) => strip(item, {display}));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.has(key) && !(display && DISPLAY.test(key))).map(([key, item]) => [key, strip(item, {display})]));
  }
  return value;
}
const sum = (list) => list.reduce((n, v) => n + (Number(v) || 0), 0);

// 付け替えの前後で比べる帳票（どれも架空の管理者で読むだけ）
async function snapshot() {
  const out = {};
  const works = (await call(cookie, '/bootstrap')).works.filter((w) => w.code.startsWith('DEMO-W'));
  // ロイヤリティ
  out.ledger = strip(await call(cookie, '/royalty/ledger?from=2024-07&to=2026-09'));
  const list = await call(cookie, `/royalty/statements?asOf=${SALES_DEMO.asOf}`);
  out.statements = strip(list);
  out.statementDetails = [];
  for (const s of list.statements) out.statementDetails.push(strip(await call(cookie, `/royalty/statements/${s.id}?asOf=${SALES_DEMO.asOf}`)));
  out.periods = strip(await call(cookie, '/royalty/periods?asOf=2027-06-30')); // 基準日の後の期間の下書き（報告後の修正を含む）も計算し直す
  out.royaltyReport = strip(await call(cookie, '/reports/royalty-statement?from=2024-07&to=2026-12'));
  // 製作委員会の月次収支（8作品）
  out.committee = [];
  for (const w of (await call(cookie, '/reports/committee-monthly/works')).works) out.committee.push(strip(await call(cookie, `/reports/committee-monthly?workId=${w.id}&from=2024-01&to=2026-12`)));
  // MG
  out.mg = [];
  for (const direction of ['incoming', 'outgoing']) {
    for (const {month} of (await call(cookie, `/reports/mg-sales/months?direction=${direction}`)).months) out.mg.push(strip(await call(cookie, `/rights-reports/mg-portfolio?direction=${direction}&month=${month}`)));
  }
  out.mgLedger = strip(await call(cookie, '/mg/ledger'));
  // PL・BS（作品別・会社）
  out.plbs = [strip(await call(cookie, '/reports/pl-bs?from=2024-05&to=2025-04&asOf=2025-04')), strip(await call(cookie, '/reports/pl-bs?from=2025-05&to=2026-04&asOf=2026-06'))];
  // 年間売上・流通別売上（区分で分ける軸は、合計と月ごとの和だけを比べる）
  out.annual = {};
  out.annualDistributionCodes = new Set();
  for (const axis of ['total', 'work', 'partner', 'product', 'distribution', 'partner-distribution']) {
    for (const [from, to] of [['2024-07', '2025-06'], ['2025-07', '2026-06']]) {
      const body = await call(cookie, `/reports/annual-sales?from=${from}&to=${to}&axis=${axis}`);
      if (axis === 'distribution') for (const row of body.rows) out.annualDistributionCodes.add(row.keys[0]);
      out.annual[`${axis}:${from}`] = axis.includes('distribution')
        ? {totals: strip(body.totals), subtotals: strip(body.subtotals), integrity: body.integrity, rowSum: sum(body.rows.map((row) => row.total)), monthSums: body.months.map((_, i) => sum(body.rows.map((row) => row.values[i])))}
        : strip(body);
    }
  }
  // 作品別収支（20作品。流通別のカードは合計だけ）
  out.workPnl = [];
  for (const w of works) {
    const body = await call(cookie, `/reports/work-pnl?workId=${w.id}&from=2024-06&to=2026-09`);
    out.workPnl.push({code: w.code, totals: body.totals, monthly: body.monthly.map((row) => ({month: row.month, sales: row.sales, expense: row.expense, balance: row.balance})),
      cardSales: sum(body.cards.map((card) => card.sales)), checks: body.checks, lines: body.lines.map((line) => [line.id, line.month, line.amount])});
  }
  // 帳票センター（取引先別・作品別・商品別・流通別）
  out.reportCenter = [];
  for (const start of ['2024-07', '2025-07']) {
    const body = await call(cookie, `/report-center?start=${start}`);
    const byKey = (rows, key) => Object.fromEntries([...new Set(rows.map((row) => row[key]))].map((k) => [k, sum(rows.filter((row) => row[key] === k).map((row) => row.total))]));
    out.reportCenter.push({totals: body.totals, total: body.total, byWork: byKey(body.byWork, 'work_id'), byPartner: byKey(body.byPartner, 'partner_id'), byProduct: byKey(body.byProduct, 'product_id'),
      distributionSum: sum(body.byDistribution.map((row) => row.total)), lines: body.lines.map((line) => [line.id, line.work_id, line.amount])});
  }
  // 売上集計シート（全列の合計。当社売上の5つの列は、区分の読み方が変わるので別に比べる）
  out.sheet = {};
  for (const [from, to] of [['2024-07', '2025-06'], ['2025-07', '2026-06']]) {
    const body = await call(cookie, `/sales-sheet?set=all&from=${from}&to=${to}&pageSize=10&hideEmpty=0`);
    out.sheet[from] = {total: body.total, totals: body.totals};
  }
  out.sheetByDistribution = await call(cookie, '/sales-sheet?grain=aggregate&dims=distribution&columns=amount_ex_tax,tax_amount,amount_inc_tax,royalty_amount_ex_tax&from=2024-01&to=2026-12&pageSize=500');
  return out;
}

before(async (t) => {
  // 2026-09-25 の本番の形: 売上は旧区分で分類。営業基幹・番販・PL・BS も入れる（制作の台本は売上に関わらないので入れない）
  legacyDb = await openTestDb({t});
  await seedSalesDemo(legacyDb, {legacyDistribution: true});
  await seedAllDemo(legacyDb, {only: ['eigyo', 'broadcast', 'plbs']});
  app = createApp({db: legacyDb, mode: 'local'});
  orgId = (await legacyDb.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode])).id;
  cookie = await loginAs(SALES_DEMO.adminEmail);
  fixtureCookie = await loginAs(FIXTURE_ADMIN);
  // 利用者が画面で分類し直した明細（旧区分のまま・理由は利用者のもの）は付け替えない
  const svod = await legacyDb.get(`SELECT d.sale_id, d.version_no, d.territory, d.service_name FROM sale_distribution_versions d WHERE d.org_id=? AND d.distribution_code='svod' ORDER BY d.sale_id LIMIT 1`, [orgId]);
  await call(cookie, '/report-center/classifications', {saleId: svod.sale_id, distributionCode: 'svod', baseVersion: svod.version_no, territory: svod.territory, serviceName: svod.service_name,
    settlementMethod: 'unverified', reason: '報告書を見直して定額制の配信と確かめた（試験の利用者）'});
  userTouched = svod.sale_id;
  // ほかの組織（試作用の組織1）の旧区分の分類は、そのまま動く。組織1に配信の報告を1通入れ、旧区分 tvod で分類する（seed の目印と同じ理由）
  const headers = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'recognition_basis_id', 'sales_month', 'basis_reason', 'description', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax'];
  const preview = await call(fixtureCookie, '/imports/preview', {kind: 'digital', workId: 1, text: toCsv(headers, [['TEST-ORG1-TVOD-2025-08', 2, 1, '2025-08-01', '2025-08-31', 1, '2025-08', '試験の報告', '都度課金の配信（試験）', 123456, 12345, 135801]])});
  await call(fixtureCookie, '/imports/commit', {token: preview.token});
  const sale = await legacyDb.get("SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=1 AND r.report_key=?", ['TEST-ORG1-TVOD-2025-08']);
  assert.ok(sale, '組織1に売上明細がある');
  const last = Number((await legacyDb.get('SELECT COALESCE(MAX(version_no),0) AS n FROM sale_distribution_versions WHERE org_id=1 AND sale_id=?', [sale.id])).n);
  await call(fixtureCookie, '/report-center/classifications', {saleId: sale.id, distributionCode: 'tvod', baseVersion: last, territory: '日本', serviceName: '試験の配信',
    settlementMethod: 'unverified', reason: DEMO_CLASSIFY_REASON.legacy});
  fixtureSale = sale.id;

  idCheckBefore = await idCheck(legacyDb); // 読むだけ（ログインのほかは書かない）
  idCheckDeferred = await idCheck(legacyDb, {only: WITHOUT_DISTRIBUTION});
  before1 = await snapshot();
  countsBefore = await tableCounts(legacyDb);
  const recorder = recordingDatabase(legacyDb);
  first = await reclassifyDemoSalesDistribution(recorder);
  recorded = businessBatches(recorder.batches);
  countsAfter = await tableCounts(legacyDb);
  after1 = await snapshot();
  recorder.batches = [];
  second = await reclassifyDemoSalesDistribution(recorder);
  countsSecond = {counts: await tableCounts(legacyDb), writes: businessBatches(recorder.batches)};
  idCheckAfter = await idCheck(legacyDb);
  idCheckOnlyDistribution = await idCheck(legacyDb, {only: ['distribution']});

  freshDb = await openTestDb({t});
  await seedSalesDemo(freshDb);
});
after(() => { legacyDb?.close(); freshDb?.close(); });

test('付け替えは seed が旧区分で入れた分類だけに新しい版を足し、2回目は何もしない', async () => {
  const seededLegacy = Number((await legacyDb.get('SELECT COUNT(*) AS n FROM sale_distribution_versions WHERE org_id=? AND reason=?', [orgId, DEMO_CLASSIFY_REASON.legacy])).n);
  assert.equal(first.skipped, false);
  assert.equal(first.reclassified, seededLegacy - 1, '利用者が分類し直した1行を除く、seed の旧区分の分類すべて');
  // 足したのは分類の版と監査だけ。保存済みの行は書き換えない（版の表は UPDATE・DELETE をトリガーで止める）
  const changed = countDifferences(countsBefore, countsAfter).filter((row) => row.table !== 'sessions');
  assert.deepEqual(changed.map((row) => row.table).sort(), ['audit_log', 'sale_distribution_versions']);
  assert.equal(changed.find((row) => row.table === 'sale_distribution_versions').after - changed.find((row) => row.table === 'sale_distribution_versions').before, first.reclassified);
  assert.equal(Number((await legacyDb.get("SELECT COUNT(*) AS n FROM audit_log WHERE org_id=? AND action='classify' AND detail_json LIKE ?", [orgId, `%${RECLASSIFY_REASON}%`])).n), first.reclassified);
  assert.ok(recorded.every((batch) => batch.statements.every((s) => /^\s*INSERT INTO (sale_distribution_versions|audit_log)\b/i.test(s.sql))), '分類の版と監査の INSERT だけ');
  assert.deepEqual(d1LimitViolations(recorded), []);
  assert.equal(recorded.length, first.reclassified, '明細1行につき1回の batch（画面の分類の登録と同じ）');
  // 2回目: 対象が無く、ログインのほかは書かない
  assert.deepEqual(second, {skipped: true, orgId, reclassified: 0});
  assert.deepEqual(countDifferences(countsAfter, countsSecond.counts).filter((row) => row.table !== 'sessions'), []);
  assert.deepEqual(countsSecond.writes, []);
});

test('付け替えた分類は、白紙の DB に今の seed を入れたとき（最初から流通マスタの ID）と明細ごとに同じ', async () => {
  const latest = (db) => db.all(`SELECT r.report_key, s.source_row, d.distribution_code, d.settlement_method, d.territory, d.service_name
    FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN organizations o ON o.id=s.org_id AND o.code=?
    LEFT JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
    WHERE s.id<>? ORDER BY r.report_key, s.source_row`, [SALES_DEMO.orgCode, userTouched]);
  const mine = await latest(legacyDb);
  const fresh = (await latest(freshDb)).filter((row) => mine.some((m) => m.report_key === row.report_key && m.source_row === row.source_row));
  assert.equal(mine.length, fresh.length);
  assert.ok(mine.length > 700);
  assert.deepEqual(mine, fresh);
  // 使った流通ID と精算方式（流通マスタの取引方法と合う）
  const codes = [...new Set(mine.map((row) => row.distribution_code).filter(Boolean))].sort();
  assert.deepEqual(codes, ['A001', 'A003', 'B001', 'D004', 'D005', 'D006', 'H001', 'R004', 'S001', 'S002']);
  const master = new Map((await legacyDb.all('SELECT code, distribution_name, transaction_method FROM distribution_master')).map((row) => [row.code, row]));
  const methodOf = {RS: 'royalty', FLAT: 'FLAT', MG: 'MG', '委託': 'other', '委託返品': 'other'};
  for (const row of mine.filter((r) => r.distribution_code)) assert.equal(row.settlement_method, methodOf[master.get(row.distribution_code).transaction_method], `${row.report_key} ${row.distribution_code}`);
  // 分類しないまま残す明細（「風鈴と転校生」のセル＝レンタル／セル未確認）は、どちらも分類なし
  assert.deepEqual(mine.filter((row) => !row.distribution_code).map((row) => row.report_key), ['DEMO-W10-SEL-2025H2']);
});

test('旧区分と付け替えた流通IDは、ロイヤリティ・委員会・PL・BS の流通の区分が同じ（明細ごと）', async () => {
  const pairs = await legacyDb.all(`SELECT a.distribution_code AS old_code, a.territory AS old_territory, b.distribution_code AS new_code, b.territory AS new_territory
    FROM sale_distribution_versions b JOIN sale_distribution_versions a ON a.org_id=b.org_id AND a.sale_id=b.sale_id AND a.version_no=b.version_no-1
    WHERE b.org_id=? AND b.reason=?`, [orgId, RECLASSIFY_REASON]);
  assert.equal(pairs.length, first.reclassified);
  const groupOf = (code, territory, table) => (territory && !['日本', '国内'].includes(territory) ? 'overseas' : table[code]);
  for (const row of pairs) {
    assert.equal(row.new_territory, row.old_territory);
    assert.equal(groupOf(row.new_code, row.new_territory, MASTER_GROUP), groupOf(row.old_code, row.old_territory, LEGACY_GROUP), `${row.old_code}→${row.new_code}`);
  }
  // 対応表（seed-sales-demo の DEMO_DISTRIBUTION）の流通ID はどれも流通マスタにある
  for (const {code} of Object.values(DEMO_DISTRIBUTION)) assert.ok(await legacyDb.get('SELECT 1 FROM distribution_master WHERE code=?', [code]), code);
});

test('ロイヤリティ（集計シート・報告書・期間の下書き・報告書の帳票）の金額は付け替えの前後で1円も変わらない', () => {
  assert.ok(before1.statementDetails.length > 100);
  assert.deepEqual(after1.ledger, before1.ledger);
  assert.deepEqual(after1.statements, before1.statements);
  assert.deepEqual(after1.statementDetails, before1.statementDetails);
  assert.deepEqual(after1.periods, before1.periods);
  assert.deepEqual(after1.royaltyReport, before1.royaltyReport);
  // 基準日の後の期間の下書き（売上から計算し直す。「報告後の修正」も入る）は、合計も計算の入力の照合値も前と同じ
  const drafts = (snap) => snap.periods.periods.filter((p) => p.draft).map((p) => [p.holderId, p.closeMonth, p.draft.totals, p.draft.lineCount, p.draft.inputHash]);
  assert.ok(drafts(before1).length >= 20, `下書き ${drafts(before1).length}件`);
  assert.deepEqual(drafts(after1), drafts(before1));
});

test('委員会の月次収支・MG・PL・BS（作品別・会社）は付け替えの前後で同じ', () => {
  assert.equal(before1.committee.length, 8);
  assert.deepEqual(after1.committee, before1.committee);
  assert.ok(before1.mg.length > 0);
  assert.deepEqual(after1.mg, before1.mg);
  assert.deepEqual(after1.mgLedger, before1.mgLedger);
  assert.deepEqual(after1.plbs, before1.plbs);
});

test('年間売上・流通別売上・作品別収支・帳票センターの金額は同じ（流通で分ける表は合計と月ごとの和が同じ）', () => {
  assert.deepEqual(after1.annual, before1.annual);
  // 流通別売上の行は、付け替えの後は流通マスタの ID（と、分類の無い明細の既定・利用者が残した旧区分）で分かれる
  assert.deepEqual([...before1.annualDistributionCodes].sort(), ['avod', 'broadcast_bs', 'broadcast_free', 'other', 'package_rental', 'package_sell', 'package_unknown', 'svod', 'theatrical', 'tvod']);
  assert.deepEqual([...after1.annualDistributionCodes].sort(), ['A001', 'A003', 'B001', 'D004', 'D005', 'D006', 'H001', 'R004', 'S001', 'S002', 'package_unknown', 'svod']);
  assert.deepEqual(after1.workPnl, before1.workPnl);
  assert.ok(after1.workPnl.every((row) => row.checks.every((c) => c.value === 0)));
  assert.deepEqual(after1.reportCenter, before1.reportCenter);
});

test('売上集計シート: 金額の列の合計は同じ。流通ID列は流通マスタの ID になり、当社売上の列は流通マスタの取引方法で分かれる', async () => {
  const amountKeys = ['amount_ex_tax', 'tax_amount', 'amount_inc_tax', 'royalty_amount_ex_tax', 'royalty_amount_inc_tax', 'foreign_amount', 'foreign_royalty_amount',
    'flat_deal_ex_tax', 'mg_guarantee_ex_tax', 'box_office_ex_tax', 'overdue_amount', 'overdue_share'];
  const blocks = ['flat_holder_ex_tax', 'mg_holder_ex_tax', 'rs_holder_ex_tax', 'rss_holder_ex_tax', 'vod_holder_ex_tax'];
  // 区分で変わる列（当社売上の5つ・それを分子に使う率と単価）のほかは、全列の合計が同じ
  const derivedOfBlocks = new Set(['flat_partner_rate', 'mg_partner_rate', 'rs_partner_rate', 'rss_partner_rate', 'vod_partner_rate', 'rs_holder_unit_ex_tax', 'vod_unit_ex_tax',
    'h_flat_implied_deal', 'h_mg_implied_gross', 'h_rs_implied_gross', 'h_rss_implied_declared', 'h_vod_implied_gross']);
  for (const from of Object.keys(before1.sheet)) {
    const b = before1.sheet[from], a = after1.sheet[from];
    assert.equal(a.total, b.total);
    for (const key of amountKeys) assert.equal(a.totals[key], b.totals[key], `${from} ${key}`);
    for (const key of Object.keys(b.totals).filter((k) => !blocks.includes(k) && !derivedOfBlocks.has(k) && k !== 'distribution_code' && k !== 'ref_transaction_method' && k !== 'ref_distribution_name' && k !== 'ref_sales_type')) {
      assert.deepEqual(a.totals[key], b.totals[key], `${from} ${key}`);
    }
    // 当社売上の5つの列: 付け替えの前は レンタルが RS、海外がどの列にも入らなかった。後は レンタルが レンタル（RSS）、海外が 定額（A001）・最低保証（A003）
    const rows = await legacyDb.all(`SELECT s.amount_ex_tax, p.code AS partner_code, w.code AS work_code FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
      JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id
      WHERE s.org_id=? AND r.status='active' AND s.accounting_month BETWEEN ? AND ?`, [orgId, from, from === '2024-07' ? '2025-06' : '2026-06']);
    const of = (test) => sum(rows.filter(test).map((row) => row.amount_ex_tax));
    const rental = of((row) => row.partner_code === 'DEMO-RNT-A');
    const overseasFlat = of((row) => row.partner_code === 'DEMO-OS-A' && row.work_code !== 'DEMO-W04');
    const overseasMg = of((row) => row.partner_code === 'DEMO-OS-A' && row.work_code === 'DEMO-W04');
    const v = (totals, key) => Number(totals[key] ?? 0);
    assert.ok(rental > 0 && overseasFlat > 0);
    assert.equal(v(a.totals, 'rs_holder_ex_tax'), v(b.totals, 'rs_holder_ex_tax') - rental, `${from} RS`);
    assert.equal(v(a.totals, 'rss_holder_ex_tax'), v(b.totals, 'rss_holder_ex_tax') + rental, `${from} RSS`);
    assert.equal(v(a.totals, 'flat_holder_ex_tax'), v(b.totals, 'flat_holder_ex_tax') + overseasFlat, `${from} 定額`);
    assert.equal(v(a.totals, 'mg_holder_ex_tax'), v(b.totals, 'mg_holder_ex_tax') + overseasMg, `${from} 最低保証`);
    assert.equal(v(a.totals, 'vod_holder_ex_tax'), v(b.totals, 'vod_holder_ex_tax'), `${from} 見放題・広告型・海外`);
  }
  // 流通IDで分けた集計: 金額の合計は同じ。付け替えの後の流通IDは流通マスタの ID（分類の無い明細は報告の種類の既定、利用者が残した旧区分 svod）
  const totalOf = (body) => body.totals;
  assert.deepEqual(totalOf(after1.sheetByDistribution), totalOf(before1.sheetByDistribution));
  const beforeKeys = before1.sheetByDistribution.rows.map((row) => row.dimkey_distribution).sort();
  const afterKeys = after1.sheetByDistribution.rows.map((row) => row.dimkey_distribution).sort();
  assert.deepEqual(beforeKeys, ['avod', 'broadcast_bs', 'broadcast_free', 'other', 'package_rental', 'package_sell', 'package_unknown', 'svod', 'theatrical', 'tvod']);
  assert.deepEqual(afterKeys, ['A001', 'A003', 'B001', 'D004', 'D005', 'D006', 'H001', 'R004', 'S001', 'S002', 'package_unknown', 'svod']);
  const svodRow = after1.sheetByDistribution.rows.find((row) => row.dimkey_distribution === 'svod');
  assert.equal(svodRow.__count, 1, '利用者が旧区分のまま分類し直した1行');
  const unknown = after1.sheetByDistribution.rows.find((row) => row.dimkey_distribution === 'package_unknown');
  assert.equal(unknown.__count, 1, '分類の無い「風鈴と転校生」のセルは報告の種類の既定（ビデオグラム・区分未確認）');
  // 見出しは英字のキーでなく「未分類（ビデオグラム・区分未確認）」。キーは package_unknown のまま（絞り込み・保存したシートと合う）
  assert.equal(unknown.dim_distribution, '未分類（ビデオグラム・区分未確認）');
  assert.equal(after1.sheetByDistribution.unclassifiedCount, 1);
  const unclassifiedSale = await legacyDb.get("SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=? AND r.report_key='DEMO-W10-SEL-2025H2'", [orgId]);
  const one = await call(cookie, `/sales-sheet?columns=sale_id,distribution_code,ref_distribution_name,ref_transaction_method&from=2026-01&to=2026-01&pageSize=500&distribution=package_unknown`);
  const shown = one.rows.find((row) => row.sale_id === unclassifiedSale.id);
  assert.deepEqual([shown.distribution_code, shown.ref_distribution_name, shown.ref_transaction_method], ['未分類', '未分類（ビデオグラム・区分未確認）', null], '流通ID列は英字のキーでなく「未分類」');
  assert.equal(one.unclassifiedCount, 1);
  // 明細の流通ID列（83列の2列目）も流通マスタの ID
  const detail = await call(cookie, '/sales-sheet?columns=sale_id,distribution_code,ref_distribution_name,ref_transaction_method,ref_sales_type&from=2025-07&to=2025-09&pageSize=500');
  const master = new Set((await legacyDb.all('SELECT code FROM distribution_master')).map((row) => row.code));
  assert.ok(detail.rows.length > 50);
  for (const row of detail.rows.filter((r) => r.sale_id !== userTouched)) {
    assert.ok(master.has(row.distribution_code), `売上 ${row.sale_id} の流通ID ${row.distribution_code}`);
    assert.ok(row.ref_distribution_name && row.ref_transaction_method, `売上 ${row.sale_id} の流通名・取引方法`);
  }
});

test('ほかの組織（試作用の組織1）の旧区分の分類は付け替えず、今まで通り読める', async () => {
  const rows = await legacyDb.all('SELECT version_no, distribution_code, reason FROM sale_distribution_versions WHERE org_id=1 AND sale_id=? ORDER BY version_no', [fixtureSale]);
  assert.equal(rows.at(-1).distribution_code, 'tvod', '目印と同じ理由でも、組織が違えば付け替えない');
  assert.equal(Number((await legacyDb.get('SELECT COUNT(*) AS n FROM sale_distribution_versions WHERE org_id<>? AND reason=?', [orgId, RECLASSIFY_REASON])).n), 0);
  // 組織1の帳票は、旧区分の分類のまま数字を返す（配信の区分）
  const body = await call(fixtureCookie, `/report-center?start=${(await legacyDb.get('SELECT accounting_month FROM sale_lines WHERE id=?', [fixtureSale])).accounting_month}`);
  const line = body.lines.find((row) => row.id === fixtureSale);
  assert.equal(line.distribution_code, 'tvod');
  assert.equal(line.distribution_label, '配信・TVOD');
  const sheet = await call(fixtureCookie, '/sales-sheet?grain=aggregate&dims=distribution&columns=amount_ex_tax&pageSize=500').catch(() => null);
  if (sheet?.adopted) assert.ok(sheet.rows.some((row) => row.dimkey_distribution === 'tvod'));
});

test('seed-all-demo の流通IDの確認: seed が旧区分で入れた分類が残ると NG、付け替えの後は利用者が旧区分のまま残した明細を NG にせず件数と売上IDを出す', () => {
  // 付け替える前（本番の DEMO-SALES に 2026-09-25 に入れた形）: seed の旧区分が残っているので NG
  assert.equal(idCheckBefore.ok, false, idCheckBefore.detail);
  const seedLeft = Number(/旧区分のまま seed の分 (\d+)行/.exec(idCheckBefore.detail)?.[1]);
  assert.ok(seedLeft > 700, idCheckBefore.detail);
  assert.match(idCheckBefore.detail, new RegExp(`利用者が残した分 [1-9]\\d*行（売上 #${userTouched}）`));
  // 付け替えた後: seed の分は0行。利用者が svod のまま分類し直した明細は残るが、NG にはしない（件数と売上IDを出す）
  assert.equal(idCheckAfter.ok, true, idCheckAfter.detail);
  assert.match(idCheckAfter.detail, new RegExp(`旧区分のまま seed の分 0行・利用者が残した分 [1-9]\\d*行（売上 #${userTouched}）`));
  assert.match(idCheckAfter.detail, /売上集計シートでは未分類 1件/, '分類の無い「風鈴と転校生」のセル');
});

test('seed-all-demo の流通IDの確認と --only: 付け替えの節を外した記録（配備の前）は seed の旧区分が残っても NG にせず、付け替えの節を流したときは付け替え後で OK', () => {
  // 付け替える前・--only に distribution なし: 旧区分が残っている（件数は同じ）が NG にしない。req4-integration.md §3 の「配備より前に入れるとき」（--only で distribution を外して記録する）で止まらない
  assert.equal(idCheckDeferred.ok, true, idCheckDeferred.detail);
  assert.match(idCheckDeferred.detail, /^（--only に distribution が無いので、seed の旧区分の残りは NG にしない。配備の後に --only distribution で付け替える）/);
  assert.equal(/旧区分のまま seed の分 (\d+)行/.exec(idCheckDeferred.detail)?.[1], /旧区分のまま seed の分 (\d+)行/.exec(idCheckBefore.detail)?.[1]);
  // 付け替えの後・--only distribution: 付け替えの節を流したので、これまでどおり seed の旧区分が0行で OK
  assert.equal(idCheckOnlyDistribution.ok, true, idCheckOnlyDistribution.detail);
  assert.doesNotMatch(idCheckOnlyDistribution.detail, /--only に distribution が無い/);
  assert.match(idCheckOnlyDistribution.detail, /旧区分のまま seed の分 0行/);
});

test('FR-REV-ROLL-007 流通の表示名: 年間売上（流通別・取引先×流通）と作品別収支のカードは流通IDごとに別の名前で、/api/distribution-types と同じ。金額は流通IDごとに明細を足し直した額', async () => {
  const types = new Map((await call(cookie, '/distribution-types')).rows.map((row) => [row.code, row.label]));
  assert.equal(types.get('D004'), 'D004｜配信｜RS｜TVOD');
  assert.equal(types.get('R004'), 'R004｜レンタル_RSS｜RS｜レンタル_RSS');
  const KIND_CODE = {digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'};
  for (const [from, to] of [['2024-07', '2025-06'], ['2025-07', '2026-06']]) {
    const body = await call(cookie, `/reports/annual-sales?from=${from}&to=${to}&axis=distribution`);
    assert.equal(new Set(body.rows.map((row) => row.label)).size, body.rows.length, `${from}: 同じ名前の行がある（${body.rows.map((row) => row.label).join('・')}）`);
    for (const row of body.rows) assert.equal(row.label, types.get(row.keys[0]), row.keys[0]);
    // 独立に: 有効な報告の明細を、最新の流通の分類（無ければ報告の種類の既定）ごとに税抜で足す
    const sales = await legacyDb.all(`SELECT s.amount_ex_tax, r.kind, (SELECT d.distribution_code FROM sale_distribution_versions d WHERE d.org_id=s.org_id AND d.sale_id=s.id ORDER BY d.version_no DESC LIMIT 1) AS code
      FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=? AND r.status='active' AND s.accounting_month BETWEEN ? AND ?`, [orgId, from, to]);
    const expected = new Map();
    for (const sale of sales) { const code = sale.code || KIND_CODE[sale.kind] || 'other'; expected.set(code, (expected.get(code) || 0) + Number(sale.amount_ex_tax)); }
    // 行には前の年度との比べのために今年度が0の流通IDも出る（0の行は比べない）
    assert.deepEqual(Object.fromEntries(body.rows.filter((row) => row.total !== 0).map((row) => [row.keys[0], row.total])), Object.fromEntries([...expected].filter(([, n]) => n !== 0)));
    const pairs = await call(cookie, `/reports/annual-sales?from=${from}&to=${to}&axis=partner-distribution`);
    assert.equal(new Set(pairs.rows.map((row) => row.label)).size, pairs.rows.length, `${from}: 取引先×流通に同じ名前の行がある`);
  }
  // 作品別収支（DEMO-W01）のカード: 流通IDごとに別の名前。金額は返った明細を流通IDごとに足し直した額
  const w01 = (await call(cookie, '/bootstrap')).works.find((w) => w.code === 'DEMO-W01');
  const pnl = await call(cookie, `/reports/work-pnl?workId=${w01.id}&from=2024-06&to=2026-09`);
  const cards = pnl.cards.filter((card) => card.kind === 'distribution');
  assert.ok(cards.length >= 5, `カード ${cards.length}枚`);
  assert.equal(new Set(cards.map((card) => card.label)).size, cards.length, cards.map((card) => card.label).join('・'));
  for (const card of cards) {
    assert.equal(card.label, types.get(card.code), card.code);
    assert.equal(card.sales, sum(pnl.lines.filter((line) => line.distribution_code === card.code).map((line) => line.amount)), card.code);
  }
  // 委託返品（S002）はマイナスで、委託（S001）と名前で区別できる
  const returns = cards.find((card) => card.code === 'S002');
  if (returns) assert.ok(returns.sales < 0 && returns.label === 'S002｜セル｜委託返品｜セル_委託返品');
});
