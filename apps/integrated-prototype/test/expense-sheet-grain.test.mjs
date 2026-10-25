// 経費集計シートの列を唯一の定義（src/expense-sheet/expense-columns.mjs）に統合する前後で、粒度が変わらないことを確かめる
// （会社ルートの plans/2026-10-09-sheet-columns-by-grain.md の受け入れ基準 E-1〜E-6。香盤表 #4b のうち、33列の取込（#4c）を除く部分）。
//
// fixture（test/fixtures/expense-sheet/grain-snapshot.json）は統合前の main で scripts/expense-sheet-grain-fixtures.mjs が架空データから作った
// （2回作って同じ値）。期待値は fixture と計画（経費の対応表・既定値・E-1〜E-6）から取る。計画の列の位置・見出し・型はこの試験の中で書き下す（PLAN_COLUMNS）。
// 33列の新様式（standard33）の取込・雛形・effective_layout（E-2〜E-4・E-7 の33列）は香盤表 #4c で足す。ここでは standard33 は書き出しだけを見る。
// #26 の見出しは「明細の税込額」（代表の確定 2026-10-09。請求書の総額と読めない語）。
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {decodeXlsx, encodeXlsx} from '../src/xlsx.mjs';
import {parseCsv} from '../src/csv.mjs';
import * as columns from '../src/expense-sheet/expense-columns.mjs';
import * as sheetModel from '../src/expense-sheet/sheet-model.mjs';
import {
  seedExpenseGrain, measureExpenseGrain, sheetRows, royaltyResult, categoryTexts, previewSummary, accountCheckFile, oldXlsx, base64, preIntegrationProblem,
  ROUND_TRIP, GRAIN_REASON, OLD_HEADINGS_22, OLD_HEADINGS_25, OLD_22_ROWS, WRONG_ACCOUNT, UNRELATED_CATEGORY, ROYALTY_EXPENSE,
} from '../scripts/expense-sheet-grain-fixtures.mjs';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/expense-sheet/grain-snapshot.json', import.meta.url), 'utf8'));

// 計画の経費の対応表の #1〜33（基本33列。#1〜25 は今の25列と同じ位置、#26〜33 は足す8列。モック案A）。[key, 見出し, 型]。
// 見出しは対応表の新しい見出し（#1〜25 は統合前の基本25列の見出しのまま。旧22・25列の見出しは取込の別名）、#26〜33 は対応表の括弧の見出し。
// #26 の見出しは代表の確定待ちなので null（計画の例は「明細の税込額」、モックは「税込総額」）。型は値の型（text・yen・number・date）
const PLAN_COLUMNS = [
  ['id', '経費ID', 'text'], ['distribution_name', '流通区分', 'text'], ['work_code', '作品コード', 'text'], ['product_code', '商品コード', 'text'],
  ['product_number', '品番（受領表記）', 'text'], ['product_name', '商品名（受領表記）', 'text'], ['recorded_on', '計上日', 'date'], ['client_name', '取引先名（受領表記）', 'text'],
  ['specification', '仕様', 'text'], ['description', '請求項目', 'text'], ['quantity', '数量', 'number'], ['unit_price', '単価（税別）', 'number'],
  ['actual_ex_tax', '金額（税別）', 'yen'], ['tax_amount', '消費税額', 'yen'], ['withholding_yen', '源泉徴収税額（控除）', 'yen'], ['payable_yen', '差引支払額（税込）', 'yen'],
  ['supplier_text', '発注先（受領表記）', 'text'], ['invoice_on', '請求日', 'date'], ['memo', 'メモ', 'text'], ['partner_code', '支払先コード', 'text'],
  ['account_name', '勘定科目', 'text'], ['category_name', '費用区分', 'text'], ['closing_on', '締め日', 'date'], ['due_on', '出金予定日', 'date'], ['paid_on', '出金日', 'date'],
  ['amount_inc_tax', '明細の税込額', 'yen'], ['cash_paid_yen', '出金済額', 'yen'], ['incurred_on', '発生日', 'date'], ['project_code', '案件コード', 'text'],
  ['tax_name', '税区分', 'text'], ['withholding_name', '源泉区分', 'text'], ['invoice_number', '請求書番号', 'text'], ['document_kind', '証憑種別', 'text'],
];
// 位置を持たず列セット accounting・payout にだけ出る列
const SET_ONLY_COLUMNS = [['status', '状態', 'text'], ['partner_name', '支払先', 'text'], ['cash_due_yen', '支払残額', 'yen']];
const PLAN_KEYS = PLAN_COLUMNS.map(([key]) => key);
const PLAN_LABEL = new Map([...PLAN_COLUMNS, ...SET_ONLY_COLUMNS].map(([key, label]) => [key, label]));
const PLAN_TYPE = new Map([...PLAN_COLUMNS, ...SET_ONLY_COLUMNS].map(([key, , type]) => [key, type]));
const LABEL_PENDING = new Set(PLAN_COLUMNS.filter(([, label]) => label == null).map(([key]) => key));
const at = (key) => PLAN_KEYS.indexOf(key);
// 列セット accounting・payout の中身は統合前のまま（計画: status・partner_name・cash_due_yen は列セット accounting・payout に残る）
const ACCOUNTING_KEYS = ['id', 'category_name', 'account_name', 'tax_name', 'withholding_name', 'withholding_yen', 'status'];
const PAYOUT_KEYS = ['partner_code', 'partner_name', 'closing_on', 'due_on', 'paid_on', 'cash_due_yen'];
// 一覧・書き出しの列 {key,label,type} の期待値（日付は ISO の文字のまま出すので text）。見出しが確定待ちの列は label を null にして比べる
const gridColumns = (keys) => keys.map((key) => ({key, label: PLAN_LABEL.get(key), type: PLAN_TYPE.get(key) === 'date' ? 'text' : PLAN_TYPE.get(key)}));
const maskPending = (cols) => cols.map((c) => (LABEL_PENDING.has(c.key) ? {...c, label: null} : c));
// E-6 の期待値を手で数えた値（fixture の categoryMismatch は scripts の expectedCategoryMismatch（SQL）で作ったので、それと独立に照らす）。
// seed-all-demo の expenses の節の140件（P&A 40・パッケージ製作費 20・事務費 29・宣伝費 20・海外素材費 11・配信マスター制作費 20）は、どれも
//   費用区分の別名の自由文で、版の名前（「…（架空）」）とは違う。うち1件（事務費の DEMO-VOID）は取消済みで数えない → viaAlias 139。
// この道具の追加: 往復の種3件（自由文＝版の名前「宣伝費（架空）」）と取込で登録した1件（版の名前「その他経費（架空）」）→ matched 4、
//   費目の食い違い1件（どの名前・別名とも違う）→ unrelated 1、ロイヤリティの控除に入る経費1件（別名「パッケージ製作費」）→ viaAlias 1
const HAND_COUNTED_MISMATCH = {checked: 145, matched: 4, mismatched: 141, viaAlias: 140, unrelated: 1, unready: 0};
const VOIDED_EXPENSES = 1;

let seed;
let measured;
before(async (t) => {
  const db = await openTestDb({t});
  seed = await seedExpenseGrain(db);
  measured = await measureExpenseGrain(seed);
});

const withholdingColumn = (headers) => headers[at('withholding_yen')];
const exportFile = async (set, format, query = '') => (await seed.api.raw('GET', `/expense-sheet/export.${format}?set=${set}&partnerId=${seed.ids.payee}${query}`));
const csvTable = (bytes) => {
  const text = new TextDecoder().decode(bytes);
  const records = parseCsv(text);
  const headers = Object.keys(records[0].values);
  return [headers, ...records.map((r) => headers.map((h) => r.values[h]))];
};
const xlsxTable = (bytes) => decodeXlsx(bytes).find((s) => s.name === '経費集計').rows;

// ---------- 唯一の定義 ----------
test('定義の1リストは位置1〜33が計画の対応表の並びで、列セットは様式名で位置の切り方だけで決まる', async () => {
  assert.ok(Array.isArray(columns.EXPENSE_COLUMNS), 'expense-columns.mjs に唯一の定義 EXPENSE_COLUMNS がある');
  assert.match(preIntegrationProblem() ?? '', /EXPENSE_COLUMNS/, '統合後のコードでは統合前の fixture を作り直さない');
  const placed = columns.EXPENSE_COLUMNS.filter((c) => c.position != null).sort((a, b) => a.position - b.position);
  assert.deepEqual(placed.map((c) => c.key), PLAN_KEYS);
  assert.deepEqual(placed.map((c) => c.position), PLAN_KEYS.map((_, n) => n + 1));
  assert.equal(new Set(columns.EXPENSE_COLUMNS.map((c) => c.key)).size, columns.EXPENSE_COLUMNS.length, 'キーは重ならない');
  // 旧22・25列の見出しは位置ごとの別名（計画: 旧名は取込の別名）
  OLD_HEADINGS_25.forEach((heading, n) => assert.ok(placed[n].label === heading || placed[n].aliases.includes(heading), `#${n + 1} ${heading}`));
  for (const [set, keys] of [['legacy22', PLAN_KEYS.slice(0, 22)], ['standard25', PLAN_KEYS.slice(0, 25)], ['standard33', PLAN_KEYS], ['basic', PLAN_KEYS], ['legacy', PLAN_KEYS.slice(0, 22)],
    ['accounting', ACCOUNTING_KEYS], ['payout', PAYOUT_KEYS]]) {
    const r = await seed.api.get(`/expense-sheet/columns?set=${set}`);
    assert.deepEqual(r.columns.map((c) => c.key), keys, set);
  }
  assert.equal((await seed.api.raw('GET', '/expense-sheet/columns?set=extended')).status, 400, '計画に無い列セットは断る');
  assert.equal(sheetModel.SET_LABELS.basic, '基本33列');
  // 会計の設定の応答（columnSets）も同じ定義から作る。キーは様式名3つ・accounting・payout と URL の別名 basic・legacy の7つ（統合前は legacy・basic・accounting・payout の4つ）
  const {columnSets} = await seed.api.get('/expense-accounting/settings');
  assert.deepEqual(Object.keys(columnSets).sort(), ['accounting', 'basic', 'legacy', 'legacy22', 'payout', 'standard25', 'standard33']);
  for (const [name, headings] of Object.entries(columnSets)) assert.deepEqual(headings, (await seed.api.get(`/expense-sheet/columns?set=${name}`)).columns.map((c) => c.label), name);
});

test('列の見出しと型は key ごとに計画の対応表のとおりで、一覧・書き出しの見出しもそれに従う（#26 の見出しは確定待ちで除く）', async () => {
  const byKey = new Map(columns.EXPENSE_COLUMNS.map((c) => [c.key, c]));
  for (const [key, label, type] of [...PLAN_COLUMNS, ...SET_ONLY_COLUMNS]) {
    const c = byKey.get(key);
    assert.ok(c, `定義に ${key} がある`);
    if (label != null) assert.equal(c.label, label, `${key} の見出し`);
    assert.equal(c.type, type, `${key} の型`);
  }
  assert.equal(byKey.size, PLAN_COLUMNS.length + SET_ONLY_COLUMNS.length, '計画に無い列を足していない');
  // 一覧の列（API）。旧22列は旧見出し、それ以外は新しい見出し
  for (const [set, keys] of [['standard33', PLAN_KEYS], ['basic', PLAN_KEYS], ['standard25', PLAN_KEYS.slice(0, 25)], ['accounting', ACCOUNTING_KEYS], ['payout', PAYOUT_KEYS]]) {
    const r = await seed.api.get(`/expense-sheet/columns?set=${set}`);
    assert.deepEqual(maskPending(r.columns), gridColumns(keys), set);
  }
  for (const set of ['legacy22', 'legacy']) assert.deepEqual((await seed.api.get(`/expense-sheet/columns?set=${set}`)).columns.map((c) => c.label), OLD_HEADINGS_22, `${set} は旧22列の見出し`);
  // 書き出しの見出し行（standard33 の csv・xlsx）
  for (const format of ['csv', 'xlsx']) {
    const file = (await exportFile('standard33', format)).body;
    const head = (format === 'csv' ? csvTable : xlsxTable)(file)[0];
    assert.deepEqual(head.map((h, n) => (LABEL_PENDING.has(PLAN_KEYS[n]) ? null : h)), PLAN_KEYS.map((key) => PLAN_LABEL.get(key)), `standard33.${format}`);
  }
});


// ---------- E-1 件数・合計 ----------
// 行の並びは DB の照合順序で変わる（本物の PostgreSQL は日本語の並びが SQLite と違う）。比べるのは中身なので、両方を同じ順に並べ直す
const sortRows = (rows) => [...rows].sort((a, b) => { const x = JSON.stringify(a); const y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; });
const sortPayouts = (p) => ({...p, rows: sortRows(p.rows)});
test('E-1: 案件×作品×流通区分×支払先×費用区分×計上月の件数と税抜・税額・税込・源泉・出金済の合計が統合の前後で一致する', () => {
  assert.equal(measured.sheet.total, snapshot.sheet.total);
  assert.deepEqual(measured.sheet.groups, snapshot.sheet.groups);
  assert.deepEqual(measured.sheet.totals, snapshot.sheet.totals);
  assert.equal(measured.sheet.cashMismatch, 0);
  assert.deepEqual(sortPayouts(measured.payouts), sortPayouts(snapshot.payouts));
});

test('E-1: 足した列の出金済額は expense_payments の合計、明細の税込額は expenses.actual_inc_tax と一致する', async () => {
  const {rows} = await sheetRows(seed.api);
  const paid = new Map((await seed.db.all('SELECT expense_id,SUM(amount_yen) AS paid FROM expense_payments WHERE org_id=? GROUP BY expense_id', [seed.orgId])).map((r) => [r.expense_id, Number(r.paid)]));
  const inc = new Map((await seed.db.all('SELECT id,actual_inc_tax FROM expenses WHERE org_id=?', [seed.orgId])).map((r) => [r.id, Number(r.actual_inc_tax)]));
  assert.equal(rows.length, snapshot.sheet.total);
  assert.ok(paid.size > 0, '架空データに出金がある');
  for (const r of rows) {
    assert.equal(r.cash_paid_yen, paid.get(r.id) ?? 0, `経費 ${r.id} の出金済額`);
    assert.equal(r.amount_inc_tax, inc.get(r.id), `経費 ${r.id} の明細の税込額`);
  }
});

// ---------- E-2 往復（旧22列・標準25列。33列の取込は #4c） ----------
async function originals() {
  const {db, orgId} = seed;
  const ids = (await db.all(`SELECT e.id FROM expenses e JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id JOIN expense_invoices i ON i.org_id=d.org_id AND i.id=d.invoice_id
    WHERE e.org_id=? AND i.code IN (?,?) ORDER BY e.id`, [orgId, ROUND_TRIP.invoices.A.code, ROUND_TRIP.invoices.B.code])).map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const e = await db.get('SELECT * FROM expenses WHERE org_id=? AND id=?', [orgId, id]);
    const d = await db.get('SELECT * FROM expense_details WHERE org_id=? AND expense_id=?', [orgId, id]);
    const inv = await db.get('SELECT * FROM expense_invoice_versions WHERE org_id=? AND invoice_id=? ORDER BY version_no DESC LIMIT 1', [orgId, d.invoice_id]);
    const a = await db.get('SELECT * FROM expense_accounting_versions WHERE org_id=? AND expense_id=? ORDER BY version_no DESC LIMIT 1', [orgId, id]);
    out.push(comparable({...e, invoice: inv, details: d, accounting: a}));
  }
  return out;
}
const num = (v) => (v == null ? null : Number(v));
// 計画の E-2 の比べる項目（invoice.code・reason・expectedVersion・override_note・credit は比べない）
function comparable(p) {
  return {project_id: num(p.project_id), work_id: num(p.work_id), partner_id: num(p.partner_id), incurred_on: p.incurred_on, accounting_month: p.accounting_month,
    category: p.category, description: p.description, actual_ex_tax: num(p.actual_ex_tax), tax_amount: num(p.tax_amount), actual_inc_tax: num(p.actual_inc_tax),
    invoice: {invoice_number: p.invoice.invoice_number ?? null, document_kind: p.invoice.document_kind, invoice_on: p.invoice.invoice_on, closing_on: p.invoice.closing_on, due_on: p.invoice.due_on},
    details: Object.fromEntries(['recorded_on', 'product_id', 'source_product_number', 'source_product_name', 'source_client_name', 'specification', 'supplier_text', 'memo',
      'quantity_x10000', 'unit_price_x10000', 'distribution_type_code'].map((k) => [k, ['product_id', 'quantity_x10000', 'unit_price_x10000'].includes(k) ? num(p.details[k]) : (p.details[k] ?? null)])),
    accounting: {category_version_id: num(p.accounting.category_version_id), tax_category_version_id: num(p.accounting.tax_category_version_id),
      withholding_category_version_id: num(p.accounting.withholding_category_version_id), withholding_yen: num(p.accounting.withholding_yen)}};
}
// 補足入力は計画の E-2 (a): 旧22列・標準25列は案件・発生日・税区分・源泉区分・請求書のまとまり・共通経費の確認を固定値で渡す
const roundTripSupplement = () => ({project_id: seed.ids.project, incurred_on: ROUND_TRIP.incurredOn, tax_category_version_id: seed.ids.tax,
  withholding_category_version_id: seed.ids.withholding, common_expense: true,
  groups: [{key: 'A', from: 2, to: 3, invoice_number: ROUND_TRIP.invoices.A.invoice_number, document_kind: 'invoice'}, {key: 'B', from: 4, to: 4, document_kind: 'receipt'}]});

test('E-2: legacy22・standard25 で書き出した csv と xlsx を取込の下見に通すと、登録せずに payload が元の経費と一致する（勘定科目の検算あり）', async () => {
  const want = await originals();
  assert.equal(want.length, ROUND_TRIP.lines.length);
  assert.equal(want[0].details.distribution_type_code, ROUND_TRIP.distribution, '流通区分を持つ明細を往復させる');
  assert.ok(want[0].details.product_id, '商品を持つ明細を往復させる');
  const before = (await seed.db.get('SELECT COUNT(*) AS n FROM expenses WHERE org_id=?', [seed.orgId])).n;
  for (const set of ['legacy22', 'standard25']) {
    for (const format of ['csv', 'xlsx']) {
      const file = await exportFile(set, format);
      assert.equal(file.status, 200, `${set}.${format}`);
      const table = format === 'csv' ? csvTable : xlsxTable;
      if (set === 'legacy22') assert.deepEqual(table((await exportFile('legacy', format)).body), table(file.body), `URL の別名 legacy は legacy22 と同じ列と値（${format}）`);
      const p = await seed.api.post('/expense-imports/preview', {expectedVersion: 0, reason: GRAIN_REASON, file_name: `DEMO-grain-roundtrip-${set}.${format}`,
        original_base64: base64(file.body), supplement: roundTripSupplement()});
      assert.deepEqual([p.ready, p.held], [want.length, 0], `${set}.${format}: ${JSON.stringify(p.rows.map((r) => r.issues))}`);
      assert.deepEqual(p.rows.map((r) => comparable(r.payload)), want, `${set}.${format}`);
    }
  }
  assert.equal((await seed.db.get('SELECT COUNT(*) AS n FROM expenses WHERE org_id=?', [seed.orgId])).n, before, '下見は登録しない');
});

test('E-2: 統合前は書き出した xlsx（シート名「経費集計」）と基本25列が取り込めなかった。統合後は旧22列・標準25列とも下見できる', () => {
  // fixture の参考値（統合前）。統合後の通り方は上の試験で確かめる
  assert.equal(snapshot.roundTrip.before['legacy.csv'].status, 201);
  assert.equal(snapshot.roundTrip.before['legacy.xlsx'].status, 400);
  assert.equal(snapshot.roundTrip.before['basic.csv'].status, 400);
});

test('E-2: standard33（basic）の書き出しは基本33列を計画の並びで出し、流通区分・商品・足した8列の値を持つ', async () => {
  const want = (await originals())[0];
  for (const set of ['standard33', 'basic']) {
    const xlsx = xlsxTable((await exportFile(set, 'xlsx')).body);
    const csv = csvTable((await exportFile(set, 'csv')).body);
    for (const [label, table] of [['xlsx', xlsx], ['csv', csv]]) {
      assert.equal(table[0].length, 33, `${set}.${label}`);
      assert.equal(table.length, 1 + ROUND_TRIP.lines.length, `${set}.${label}`);
    }
    const row = xlsx[1];
    assert.equal(row[at('product_code')], want.details.source_product_number, '商品コード（作品×商品の軸）');
    assert.equal(row[at('distribution_name')], (await seed.db.get('SELECT label FROM distribution_types WHERE code=?', [ROUND_TRIP.distribution])).label, '流通区分');
    assert.equal(row[at('amount_inc_tax')], 13200);
    assert.equal(row[at('cash_paid_yen')], 0);
    assert.equal(row[at('incurred_on')], ROUND_TRIP.incurredOn);
    assert.equal(row[at('project_code')], (await seed.db.get('SELECT code FROM projects WHERE org_id=? AND id=?', [seed.orgId, seed.ids.project])).code);
    assert.equal(row[at('tax_name')], '10%（架空）');
    assert.equal(row[at('withholding_name')], '明示の控除（架空）');
    assert.equal(row[at('invoice_number')], ROUND_TRIP.invoices.A.invoice_number);
    assert.equal(row[at('document_kind')], 'invoice', '証憑種別は code で書き出す');
    assert.equal(xlsx[3][at('document_kind')], 'receipt');
    assert.equal(xlsx[3][at('invoice_number')] ?? null, null, '番号の無い領収書は空');
  }
});

// ---------- E-3 掘り下げ・取込済みの束 ----------
test('E-3: 旧雛形（シート名「経費入力」・旧22列・旧25列の見出し）の取込の下見・登録・再評価の件数と保留理由が統合の前後で同じ', () => {
  assert.deepEqual(seed.imports, snapshot.imports);
});

test('E-3: どの列の行からも 経費ID→請求書→取込の束→原行（raw_json。位置の配列のまま）に降りられる', async () => {
  const {rows} = await sheetRows(seed.api);
  for (const r of rows) for (const key of PLAN_KEYS) assert.ok(Object.hasOwn(r, key), `経費 ${r.id} の行に ${key} がある`);
  const imported = rows.find((r) => r.description === '旧雛形の取込1（架空）');
  const detail = await seed.api.get(`/expense-sheet/${imported.id}`);
  assert.equal(detail.row.invoice_id, imported.invoice_id);
  assert.ok(detail.row.invoice?.invoice_on, '請求書の版');
  assert.deepEqual(detail.imports.map((x) => [x.batch_id, x.row_no]), [[seed.batches.old22, 2]]);
  const batch = await seed.api.get(`/expense-imports/${seed.batches.old22}`);
  const raw = batch.rows.find((x) => x.row_no === 2);
  assert.deepEqual(JSON.parse(raw.raw_json), OLD_22_ROWS[0]);
});

test('E-3: 勘定科目（#21）は新しい束の下見だけで検算し（空は見ない）、同じファイルの再下見と再評価は統合前と同じ件数', async () => {
  const before = snapshot.accountCheck;
  const body = {reason: GRAIN_REASON, file_name: 'DEMO-grain-account.xlsx', original_base64: base64(await accountCheckFile(seed)), supplement: seed.supplement};
  const first = await seed.api.post('/expense-imports/preview', {...body, expectedVersion: 0});
  assert.deepEqual([first.ready, first.held], [before.preview.ready - 1, before.preview.held + 1]);
  const held = first.rows.filter((r) => r.issues.length);
  assert.deepEqual(held.map((r) => r.row_no), [3], '違う科目名の行だけ保留。導いた科目名の行と空の行は通る');
  assert.deepEqual(held[0].issues.map((x) => x.column), ['勘定科目']);
  assert.match(held[0].issues[0].reason, new RegExp(WRONG_ACCOUNT.replace(/[()（）]/g, '.')));
  const again = await seed.api.post('/expense-imports/preview', {...body, expectedVersion: 1});
  assert.deepEqual(previewSummary(again), before.repreview);
  const revised = await seed.api.post(`/expense-imports/${first.id}/preview`, {expectedVersion: 2, reason: GRAIN_REASON, supplement: seed.supplement});
  assert.deepEqual(previewSummary(revised), before.revise);
});

test('E-3: 取込はシート名「経費集計」を正とし旧名「経費入力」も読む。どちらも無い xlsx と、位置の違う見出しは断る', async () => {
  const preview = (bytes, name) => seed.api.raw('POST', '/expense-imports/preview', {expectedVersion: 0, reason: GRAIN_REASON, file_name: name, original_base64: base64(bytes), supplement: seed.supplement});
  const row = [...OLD_22_ROWS[0]];
  row[at('description')] = 'シート名の確認（架空）';
  const both = encodeXlsx([{name: '経費入力', rows: [['不明']]}, {name: '経費集計', rows: [OLD_HEADINGS_22, row]}]);
  const r = await preview(both, 'DEMO-grain-both.xlsx');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ready, 1, '両方あれば「経費集計」を読む');
  const none = oldXlsx(OLD_HEADINGS_22, [row], '別のシート');
  const missing = await preview(none, 'DEMO-grain-none.xlsx');
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /経費集計/);
  const swapped = [...OLD_HEADINGS_22];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal((await preview(oldXlsx(swapped, [row]), 'DEMO-grain-swapped.xlsx')).status, 400, '列の並び替えは断る');
});

// ---------- E-4 符号 ----------
test('E-4: 源泉は DB・基本セットの画面で正、書き出しの legacy22・standard25・standard33 では負', async () => {
  const sheet = await seed.api.get(`/expense-sheet?set=basic&partnerId=${seed.ids.payee}`);
  assert.deepEqual(sheet.rows.map((r) => r.withholding_yen), ROUND_TRIP.lines.map((l) => l.withholding_yen));
  // 画面の符号は統合前と同じ: 旧22列（URL の別名 legacy も）だけ負。基本33列は正、標準25列は統合前の基本25列と同じ正（代表の確定待ち）
  const screenSets = ['basic', 'standard33', 'standard25', 'legacy22', 'legacy', 'accounting', 'payout'];
  assert.deepEqual(screenSets.map((set) => sheetModel.negativeWithholding(set, {screen: true})), [false, false, false, true, true, false, false]);
  assert.deepEqual(screenSets.map((set) => sheetModel.negativeWithholding(set)), [true, true, true, true, true, false, false], '書き出しは3様式とも負');
  for (const set of ['legacy22', 'standard25', 'standard33']) {
    const csv = csvTable((await exportFile(set, 'csv')).body);
    const xlsx = xlsxTable((await exportFile(set, 'xlsx')).body);
    assert.equal(withholdingColumn(csv[0]), set === 'legacy22' ? '源泉徴収税額' : '源泉徴収税額（控除）', set);
    assert.deepEqual(csv.slice(1).map((r) => r[at('withholding_yen')]), ['-1000', '0', '0'], `${set}.csv`);
    assert.deepEqual(xlsx.slice(1).map((r) => r[at('withholding_yen')]), [-1000, 0, 0], `${set}.xlsx`);
  }
});

test('E-4: 雛形（legacy22・standard25）のシート名は「経費集計」、旧22列は旧見出し、標準25列は新しい見出しで、源泉の控除は負数と案内する', async () => {
  for (const [layout, headings] of [['legacy22', OLD_HEADINGS_22], ['standard25', null]]) {
    const file = await seed.api.raw('GET', `/expense-sheet/template.xlsx?layout=${layout}`);
    const book = decodeXlsx(file.body);
    assert.deepEqual(book.map((s) => s.name), ['経費集計', '入力ガイド', '記入例', '版情報']);
    const head = book[0].rows[0];
    assert.equal(head.length, layout === 'legacy22' ? 22 : 25);
    if (headings) assert.deepEqual(head, headings);
    else assert.deepEqual(head, (await seed.api.get('/expense-sheet/columns?set=standard25')).columns.map((c) => c.label));
    assert.match(JSON.stringify(book[1].rows), /源泉の控除は負数/);
  }
});

// ---------- E-5 ロイヤリティの控除・費目の自由文 ----------
test('E-5: /royalty/periods の控除の結果が統合の前後で同じ（書き出し・下見のあとも）。架空データには経費を控除した open の下書きがある', async () => {
  // 前提: 控除する費目（自由文）に ROYALTY_EXPENSE.category を持つ契約の権利者ごとに、open の下書きの額がその経費の控除で負になっている
  // （fixture の控除の結果が、経費の費目の自由文・額・計上月に依存する）
  const holders = (await seed.db.all(`SELECT DISTINCT p.name FROM royalty_agreements a JOIN partners p ON p.org_id=a.org_id AND p.id=a.holder_partner_id
    JOIN works w ON w.org_id=a.org_id AND w.id=a.work_id JOIN royalty_term_versions t ON t.org_id=a.org_id AND t.agreement_id=a.id
    JOIN royalty_term_expense_categories c ON c.org_id=t.org_id AND c.term_version_id=t.id
    WHERE a.org_id=? AND w.code=? AND c.category=? ORDER BY p.name`, [seed.orgId, ROYALTY_EXPENSE.work, ROYALTY_EXPENSE.category])).map((r) => r.name);
  assert.ok(holders.length > 0, '経費を控除する契約がある');
  const deducted = snapshot.royalty.filter(([holder, , status, royaltyYen]) => holders.includes(holder) && status === 'open' && royaltyYen < 0);
  assert.equal(deducted.length, holders.length, `経費を控除した open の下書き: ${JSON.stringify(deducted.map((r) => r.slice(0, 4)))}`);
  assert.deepEqual(sortRows(measured.royalty), sortRows(snapshot.royalty));
  assert.deepEqual(sortRows(await royaltyResult(seed.api)), sortRows(snapshot.royalty));
});

test('E-5: expenses.category（費目の自由文）ごとの件数が統合の前後で同じ（書き出し・下見のあとも）', async () => {
  assert.deepEqual(sortRows(measured.categories), sortRows(snapshot.categories));
  assert.deepEqual(sortRows(await categoryTexts(seed.db, seed.orgId)), sortRows(snapshot.categories));
});

// ---------- E-6 費目の食い違い ----------
test('E-6: expenseCategoryMismatch() が費目の自由文と費用区分の版の名前の食い違いの件数を返し、架空データの期待値と一致する', async () => {
  const store = await import('../src/expense-sheet/expense-store.mjs').catch(() => ({}));
  assert.equal(typeof store.expenseCategoryMismatch, 'function', 'expense-store.mjs（経費の DB の役）に expenseCategoryMismatch がある');
  const got = await store.expenseCategoryMismatch(seed.db, seed.orgId);
  // fixture の期待値（SQL で数えた値）を、手で数えた値と照らす。費目の自由文の件数（取消済みも含む）とも合う
  assert.deepEqual(snapshot.categoryMismatch, HAND_COUNTED_MISMATCH);
  assert.equal(snapshot.categories.reduce((n, [, count]) => n + count, 0), HAND_COUNTED_MISMATCH.checked + HAND_COUNTED_MISMATCH.unready + VOIDED_EXPENSES);
  const keys = Object.keys(snapshot.categoryMismatch);
  assert.deepEqual(Object.fromEntries(keys.map((k) => [k, got[k]])), snapshot.categoryMismatch);
  assert.equal(got.mismatched, got.viaAlias + got.unrelated);
  const unrelated = got.pairs.filter((p) => p.kind === 'unrelated');
  assert.deepEqual(unrelated.map((p) => [p.category, p.versionName, p.count]), [[UNRELATED_CATEGORY.category, 'その他経費（架空）', 1]]);
});
