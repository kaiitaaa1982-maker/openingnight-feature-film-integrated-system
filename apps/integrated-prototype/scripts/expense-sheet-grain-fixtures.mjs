#!/usr/bin/env node
// 経費集計シートの粒度の試験（test/expense-sheet-grain.test.mjs）の fixture を、統合前のコードと架空データから作る
// （会社ルートの plans/2026-10-09-sheet-columns-by-grain.md の香盤表 #4b。受け入れ基準 E-1〜E-6 のうち33列の取込を除く部分）。
//
//   node scripts/expense-sheet-grain-fixtures.mjs [--out <フォルダ>] [--twice]
//
// ・メモリの SQLite（使い捨て）に seedExpenseGrain で架空データを入れ、架空の管理者で API を通して読み、grain-snapshot.json を書く
//   （既定 test/fixtures/expense-sheet/）:
//   sheet            明細の件数と、案件×作品×流通区分×支払先×費用区分（版）×計上月ごとの税抜・税額・税込・源泉・出金済の合計（E-1）
//   payouts          出金予定（支払先別）の行と除外の件数（E-1）
//   royalty          /royalty/periods の控除の結果（S5 の計測⑤の royaltyFingerprint と同じ項目に、件数と合計を足したもの。E-5）
//   categories       expenses.category（費目の自由文）ごとの件数（E-5「expenses.category に触れない」）
//   categoryMismatch 費目の自由文と費用区分の版の名前の食い違いの件数（この道具が SQL で数えた期待値。E-6）
//   imports          旧22列の xlsx（シート名「経費入力」）・旧25列の CSV の取込の下見・登録・再評価の件数と保留理由（E-3）
//   accountCheck     勘定科目（#21）に値を入れた旧22列の xlsx の下見・同じファイルの再下見・再評価の件数（E-3。統合前は検算しない）
//   roundTrip        往復の種（ROUND_TRIP）と、統合前の書き出し→取込の結果（参考。旧22列は通り、基本25列は見出しが合わず断られる。E-2・E-4）
// ・--twice は2つの DB で2回作り、同じ JSON になることを確かめる（違えば終了コード1で、書き出さない）
// ・統合後のコード（唯一の定義 EXPENSE_COLUMNS がある）では作らない（終了コード2）。統合前の値を固定する fixture を、統合後の出力で上書きしないため
// ・架空データは scripts/seed-all-demo.mjs の節のうち sales・distribution・expenses と、往復の種・費目の食い違い1件・ロイヤリティの控除に入る経費1件・取込の束（API で足す）。本番・staging・業務データ層には触れない
// ・ID は流すたびに変わる（expense-service の newId は乱数）。件数と合計は ID ではなくコード（案件・作品・支払先・費用区分）で束ねる
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {encodeXlsx} from '../src/xlsx.mjs';
import * as expenseColumns from '../src/expense-sheet/expense-columns.mjs';
import {seedAllDemo} from './seed-all-demo.mjs';
import {SALES_DEMO} from './seed-sales-demo.mjs';

export const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/expense-sheet/', import.meta.url));
export const GRAIN_SEED_STEPS = Object.freeze(['sales', 'distribution', 'expenses']);
export const GRAIN_REASON = '経費集計シートの粒度の試験（架空）';
export const ROYALTY_AS_OF = SALES_DEMO.asOf;

// 統合前の雛形の見出し（旧22列と、旧25列の末尾3列）とシート名。ダウンロード済みの旧雛形の形をそのまま作るために持つ（統合後は取込の別名）
export const OLD_SHEET_NAME = '経費入力';
export const OLD_HEADINGS_22 = Object.freeze(['ID', '流通名', '統一作品ID', '商品ID', '品番', '商品名', '計上日（YYYY/MM/DD）', '取引先名', '仕様', '請求項目', '数量', '単価',
  '金額(税別)', '消費税(自動)', '源泉徴収税額', '金額(税込)', '発注先', '請求日', 'メモ', '仕入先ID', '勘定科目', '費用区分']);
export const OLD_HEADINGS_25 = Object.freeze([...OLD_HEADINGS_22, '締め日', '出金予定日', '出金日']);

// 統合後のコードでは fixture を作らない。module は expense-columns.mjs（試験では差し替えて確かめる）
export const preIntegrationProblem = (module = expenseColumns) => (Array.isArray(module.EXPENSE_COLUMNS)
  ? 'src/expense-sheet/expense-columns.mjs に唯一の定義（EXPENSE_COLUMNS）があります。この fixture は統合前のコードの値を固定するものなので、統合後のコードでは作りません'
  : null);

// ---------- API ----------
// 架空のメンバーで入り、{get, post, raw} を返す。get・post は 2xx 以外で止める。raw は {status, body}（JSON 以外は Uint8Array）
export async function apiClient(app, email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  if (response.status !== 200) throw new Error(`${email} でログインできません（${response.status}）`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const raw = async (method, path, payload) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())};
  };
  const strict = async (method, path, payload) => {
    const out = await raw(method, path, payload);
    if (out.status >= 300 || out.body?.ok === false) throw new Error(`${method} ${path}: ${out.status} ${JSON.stringify(out.body).slice(0, 600)}`);
    return out.body;
  };
  return {raw, get: (path) => strict('GET', path), post: (path, payload) => strict('POST', path, payload)};
}

// ---------- 往復の種（E-2・E-4） ----------
// 出金日なし・源泉確定・費目の自由文＝費用区分の版の名前の明細3件（計画の E-2: 出金日・出金済額の行は保留、源泉未確認は差引の検算に落ちる。
// 自由文が版の名前と違うと取込で版の名前に置き換わり往復しない）。支払先・案件・発生日・税区分・源泉区分は3件で同じ（取込の補足入力は束で1つ）。
// 請求書 A は2明細（行範囲でまとめる）、B は番号の無い領収書。1件目は作品・商品・流通区分・受領表記・数量と単価を持ち、源泉 1,000円を控除する
export const ROUND_TRIP = Object.freeze({
  partner: {code: 'DEMO-EXP-GRAIN-PAYEE', name: '経費の往復の支払先（架空）'},
  incurredOn: '2026-09-14',
  category: 'DEMO-EXP-promotion',
  tax: 'DEMO-TAX-10',
  withholding: 'DEMO-WH-MANUAL',
  distribution: 'theatrical',
  invoices: {
    A: {code: 'DEMO-GRAIN-INV-A', invoice_number: 'DEMO-GRAIN-A（架空）', document_kind: 'invoice', invoice_on: '2026-09-14', closing_on: '2026-09-30', due_on: '2026-10-31'},
    B: {code: 'DEMO-GRAIN-INV-B', invoice_number: null, document_kind: 'receipt', invoice_on: '2026-09-20', closing_on: '2026-09-30', due_on: '2026-10-31'},
  },
  lines: [
    {invoice: 'A', description: '往復の明細1（架空）', recorded_on: '2026-09-14', actual_ex_tax: 12000, tax_amount: 1200, withholding_yen: 1000, work: true, product: true,
      distribution: true, quantity_x10000: 20000, unit_price_x10000: 60000000, specification: 'B2・4色（架空）', memo: '往復のメモ（架空）', supplier_text: '架空の印刷所',
      source_client_name: '架空の取引先'},
    {invoice: 'A', description: '往復の明細2（架空）', recorded_on: '2026-09-15', actual_ex_tax: 5000, tax_amount: 500, withholding_yen: 0, work: true},
    {invoice: 'B', description: '往復の領収書（架空）', recorded_on: '2026-09-20', actual_ex_tax: 3000, tax_amount: 300, withholding_yen: 0, work: false},
  ],
});
// 費目の自由文がどの費用区分の名前・別名とも違う明細（E-6 の「関係の無い食い違い」の1件）
export const UNRELATED_CATEGORY = Object.freeze({invoice: 'DEMO-GRAIN-UNRELATED', category: '未対応の費目（架空）', description: '費目の自由文が版と無関係（架空）'});
// ロイヤリティの控除に入る経費（E-5）。架空の作品 DEMO-W06 の監督・脚本の契約は「窓口手数料と経費を引いた額」で、控除する費目に
// 自由文「パッケージ製作費」を持ち、2026-12 締めの open の期間が 2026-09 を計上する。その月にこの費目の経費を1件置き、open の下書きの
// 控除の結果（royaltyYen）が経費の費目の自由文・額・計上月に依存するようにする。会計の版は別名「パッケージ製作費」が指す費用区分（直接費）
export const ROYALTY_EXPENSE = Object.freeze({work: 'DEMO-W06', category: 'パッケージ製作費', categoryCode: 'DEMO-EXP-direct_cost', invoice: 'DEMO-GRAIN-ROYALTY',
  recorded_on: '2026-09-10', actual_ex_tax: 400000, tax_amount: 40000, description: 'ロイヤリティの控除に入る経費（架空）'});

// ---------- 取込の束（E-3） ----------
// 旧22列の xlsx（シート名「経費入力」）: 1行目は登録可、2行目は支払先が未登録、3行目は金額が未確認（雛形の記入例と同じ形）
export const OLD_22_ROWS = Object.freeze([
  [null, null, null, null, null, null, '2026-09-14', '月末締めの支払先（架空）', null, '旧雛形の取込1（架空）', 1, 12000, 12000, 1200, 0, 13200, null, '2026-09-14', '架空の入力例', 'DEMO-PARTNER-EOM', null, 'その他経費（架空）'],
  [null, null, null, null, null, null, '2026-09-14', '未登録の支払先（架空）', null, '旧雛形の取込2（架空）', 1, 12000, 12000, 1200, 0, 13200, null, '2026-09-14', null, 'DEMO-MISSING', null, 'その他経費（架空）'],
  [null, null, null, null, null, null, '2026-09-14', '月末締めの支払先（架空）', null, '旧雛形の取込3（架空）', null, null, null, null, null, null, null, '2026-09-14', null, 'DEMO-PARTNER-EOM', null, 'その他経費（架空）'],
]);
// 旧25列の CSV: 1行目は締め日・出金予定日つきで登録可、2行目は出金日に値があり保留
export const OLD_25_ROWS = Object.freeze([
  ['', '', '', '', '', '', '2026-09-21', '20日締めの支払先（架空）', '', '旧25列の取込1（架空）', '1', '7000', '7000', '700', '0', '7700', '', '2026-09-21', '', 'DEMO-PARTNER-20', '', 'その他経費（架空）', '2026-10-20', '2026-11-10', ''],
  ['', '', '', '', '', '', '2026-09-21', '20日締めの支払先（架空）', '', '旧25列の取込2（架空）', '1', '7000', '7000', '700', '0', '7700', '', '2026-09-21', '', 'DEMO-PARTNER-20', '', 'その他経費（架空）', '2026-10-20', '2026-11-10', '2026-10-05'],
]);
// 勘定科目（#21）に値を入れた旧22列の xlsx: 1行目は費用区分から導いた科目名、2行目は違う科目名、3行目は空（統合後は新しい束の下見だけで2行目を保留にする）
export const WRONG_ACCOUNT = 'DEMO-誤った科目（架空）';
export function accountCheckRows(accountName) {
  const base = (n, account) => [null, null, null, null, null, null, '2026-09-14', '月末締めの支払先（架空）', null, `科目の検算${n}（架空）`, 1, 12000, 12000, 1200, 0, 13200, null, '2026-09-14',
    null, 'DEMO-PARTNER-EOM', account, 'その他経費（架空）'];
  return [base(1, accountName), base(2, WRONG_ACCOUNT), base(3, null)];
}
export const oldXlsx = (headings, rows, name = OLD_SHEET_NAME) => encodeXlsx([{name, rows: [headings, ...rows]}]);
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
export const oldCsv = (headings, rows) => new TextEncoder().encode([headings, ...rows].map((row) => row.map(csvCell).join(',')).join('\n'));
export const base64 = (bytes) => Buffer.from(bytes).toString('base64');

// ---------- 架空データ ----------
// seed-all-demo の3つの節と、往復の種・費目の食い違い1件・ロイヤリティの控除に入る経費1件・取込の束2つ（下見・登録・再評価）。試験も同じ関数で入れるので、fixture と同じ件数・額になる
export async function seedExpenseGrain(db, {log = () => {}} = {}) {
  await seedAllDemo(db, {only: [...GRAIN_SEED_STEPS], log});
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  const api = await apiClient(createApp({db, mode: 'local'}), SALES_DEMO.adminEmail);
  const settings = (await api.get('/expense-accounting/settings')).settings;
  const latest = (rows, code) => rows.filter((r) => r.code === code).sort((a, b) => b.version_no - a.version_no)[0];
  const category = latest(settings.categories, ROUND_TRIP.category);
  const tax = latest(settings.taxes, ROUND_TRIP.tax);
  const withholding = latest(settings.withholding, ROUND_TRIP.withholding);
  const other = latest(settings.categories, 'DEMO-EXP-work_other_expense');
  const withholdingNone = latest(settings.withholding, 'DEMO-WH-NONE');
  const work = await db.get("SELECT id,code,project_id FROM works WHERE org_id=? AND code LIKE 'DEMO-W%' ORDER BY code LIMIT 1", [org.id]);
  const product = await db.get("SELECT id,sku,name FROM products WHERE org_id=? AND sku LIKE 'DEMO-%' ORDER BY sku LIMIT 1", [org.id]);
  const common = await db.get("SELECT id FROM projects WHERE org_id=? AND code='DEMO-EXP-COMMON'", [org.id]);
  const eom = await db.get("SELECT id FROM partners WHERE org_id=? AND code='DEMO-PARTNER-EOM'", [org.id]);
  // 往復の支払先（月末締め・翌月末払い。旧22列の取込は締め日・出金予定日をこの条件から出す）
  const payee = await api.post('/partners', {code: ROUND_TRIP.partner.code, name: ROUND_TRIP.partner.name, kind: 'vendor'});
  await api.post('/expense-accounting/payment-terms', {expectedVersion: 0, reason: GRAIN_REASON, partner_id: payee.id, effective_from: '2024-01-01', closing_rule: 'month_end',
    closing_day: null, payment_month_offset: 1, payment_rule: 'month_end', payment_day: null, payment_method: 'transfer'});
  const invoiceIds = {};
  for (const line of ROUND_TRIP.lines) {
    const inv = ROUND_TRIP.invoices[line.invoice];
    const body = {project_id: work.project_id, work_id: line.work ? work.id : null, partner_id: payee.id, incurred_on: ROUND_TRIP.incurredOn,
      accounting_month: line.recorded_on.slice(0, 7), category: category.name, description: line.description, actual_ex_tax: line.actual_ex_tax, tax_amount: line.tax_amount,
      actual_inc_tax: line.actual_ex_tax + line.tax_amount, reason: GRAIN_REASON,
      details: {recorded_on: line.recorded_on, product_id: line.product ? product.id : null, distribution_type_code: line.distribution ? ROUND_TRIP.distribution : null,
        source_product_number: line.product ? product.sku : null, source_product_name: line.product ? product.name : null, source_client_name: line.source_client_name ?? null,
        specification: line.specification ?? null, supplier_text: line.supplier_text ?? null, memo: line.memo ?? null, quantity_x10000: line.quantity_x10000 ?? null,
        unit_price_x10000: line.unit_price_x10000 ?? null},
      accounting: {expectedVersion: 0, reason: GRAIN_REASON, category_version_id: category.id, tax_category_version_id: tax.id, withholding_category_version_id: withholding.id,
        withholding_state: 'confirmed', withholding_yen: line.withholding_yen},
      ...(invoiceIds[line.invoice]
        ? {invoice_id: invoiceIds[line.invoice], expectedVersion: 1}
        : {invoice: {code: inv.code, invoice_number: inv.invoice_number, document_kind: inv.document_kind, invoice_on: inv.invoice_on, closing_on: inv.closing_on,
          due_on: inv.due_on, expectedVersion: 0, reason: GRAIN_REASON}})};
    const out = await api.post('/expenses', body);
    invoiceIds[line.invoice] ??= out.invoice_id;
  }
  await api.post('/expenses', {project_id: common.id, work_id: null, partner_id: eom.id, incurred_on: '2026-09-14', accounting_month: '2026-09', category: UNRELATED_CATEGORY.category,
    description: UNRELATED_CATEGORY.description, actual_ex_tax: 1000, tax_amount: 100, actual_inc_tax: 1100, reason: GRAIN_REASON, details: {recorded_on: '2026-09-14'},
    invoice: {code: UNRELATED_CATEGORY.invoice, invoice_on: '2026-09-14', expectedVersion: 0, reason: GRAIN_REASON},
    accounting: {expectedVersion: 0, reason: GRAIN_REASON, category_version_id: other.id, tax_category_version_id: tax.id, withholding_category_version_id: withholdingNone.id,
      withholding_state: 'confirmed', withholding_yen: 0}});
  const royaltyWork = await db.get('SELECT id,project_id FROM works WHERE org_id=? AND code=?', [org.id, ROYALTY_EXPENSE.work]);
  await api.post('/expenses', {project_id: royaltyWork.project_id, work_id: royaltyWork.id, partner_id: eom.id, incurred_on: ROYALTY_EXPENSE.recorded_on,
    accounting_month: ROYALTY_EXPENSE.recorded_on.slice(0, 7), category: ROYALTY_EXPENSE.category, description: ROYALTY_EXPENSE.description,
    actual_ex_tax: ROYALTY_EXPENSE.actual_ex_tax, tax_amount: ROYALTY_EXPENSE.tax_amount, actual_inc_tax: ROYALTY_EXPENSE.actual_ex_tax + ROYALTY_EXPENSE.tax_amount,
    reason: GRAIN_REASON, details: {recorded_on: ROYALTY_EXPENSE.recorded_on},
    invoice: {code: ROYALTY_EXPENSE.invoice, invoice_on: ROYALTY_EXPENSE.recorded_on, expectedVersion: 0, reason: GRAIN_REASON},
    accounting: {expectedVersion: 0, reason: GRAIN_REASON, category_version_id: latest(settings.categories, ROYALTY_EXPENSE.categoryCode).id, tax_category_version_id: tax.id,
      withholding_category_version_id: withholdingNone.id, withholding_state: 'confirmed', withholding_yen: 0}});
  // 取込の束（旧22列の xlsx は下見→登録→支払先を補って再評価、旧25列の CSV は下見→再評価）
  const supplement = {project_id: common.id, incurred_on: '2026-09-14', tax_category_version_id: tax.id, withholding_category_version_id: withholdingNone.id, common_expense: true, each_row_invoice: true};
  const imports = {};
  const b1 = await api.post('/expense-imports/preview', {expectedVersion: 0, reason: GRAIN_REASON, file_name: 'DEMO-grain-old-22.xlsx', original_base64: base64(oldXlsx(OLD_HEADINGS_22, OLD_22_ROWS)), supplement});
  imports.old22 = {preview: previewSummary(b1)};
  const committed = await api.post(`/expense-imports/${b1.id}/commit`, {expectedVersion: 1, hash: b1.hash, reason: GRAIN_REASON});
  imports.old22.commit = {registered: committed.registered, held: committed.held};
  const r1 = await api.post(`/expense-imports/${b1.id}/preview`, {expectedVersion: 1, reason: GRAIN_REASON, supplement: {...supplement, overrides: {3: {partner_id: eom.id}}}});
  imports.old22.revise = previewSummary(r1);
  const b2 = await api.post('/expense-imports/preview', {expectedVersion: 0, reason: GRAIN_REASON, file_name: 'DEMO-grain-old-25.csv', original_base64: base64(oldCsv(OLD_HEADINGS_25, OLD_25_ROWS)), supplement});
  imports.old25 = {preview: previewSummary(b2)};
  const r2 = await api.post(`/expense-imports/${b2.id}/preview`, {expectedVersion: 1, reason: GRAIN_REASON, supplement});
  imports.old25.revise = previewSummary(r2);
  return {api, db, orgId: org.id, supplement, imports, batches: {old22: b1.id, old25: b2.id},
    ids: {payee: payee.id, project: work.project_id, work: work.id, product: product.id, category: category.id, tax: tax.id, withholding: withholding.id, common: common.id, eom: eom.id, otherCategory: other.id, withholdingNone: withholdingNone.id}};
}

// 下見の結果のうち、統合の前後で比べるもの（保留の列の名前は見出しの版で変わるので、行と理由だけ）
export function previewSummary(p) {
  return {ready: p.ready, held: p.held, excluded: p.excluded, known_ex_tax: p.known_ex_tax, unknown: p.unknown,
    issues: p.rows.flatMap((r) => r.issues.map((x) => [x.row, x.reason]))};
}

// ---------- 読み取り ----------
export async function sheetRows(api, query = '') {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const r = await api.get(`/expense-sheet?pageSize=500&page=${page}${query ? `&${query}` : ''}`);
    rows.push(...r.rows);
    if (page * 500 >= r.total) return {rows, total: r.total, totals: r.totals};
  }
}
const add = (a, b) => a + (b ?? 0);
// 案件×作品×流通区分×支払先×費用区分（版）×計上月の束（E-1）。費用区分は「コード#版」、会計の版が無い明細は空
export async function sheetGroups(db, orgId, rows) {
  const projects = new Map((await db.all('SELECT id,code FROM projects WHERE org_id=?', [orgId])).map((r) => [r.id, r.code]));
  const categories = new Map((await db.all('SELECT v.id,c.code,v.version_no FROM expense_category_versions v JOIN expense_categories c ON c.org_id=v.org_id AND c.id=v.category_id WHERE v.org_id=?', [orgId]))
    .map((r) => [r.id, `${r.code}#${r.version_no}`]));
  const payments = new Map((await db.all('SELECT expense_id,SUM(amount_yen) AS paid FROM expense_payments WHERE org_id=? GROUP BY expense_id', [orgId])).map((r) => [r.expense_id, Number(r.paid)]));
  const groups = new Map();
  let cashMismatch = 0;
  for (const r of rows) {
    const key = [projects.get(r.project_id) ?? '', r.work_code ?? '', r.distribution_type_code ?? '', r.partner_code ?? '', categories.get(r.accounting?.category_version_id) ?? '', r.accounting_month];
    const id = JSON.stringify(key);
    const g = groups.get(id) ?? {key, count: 0, actual_ex_tax: 0, tax_amount: 0, actual_inc_tax: 0, withholding_yen: 0, withholding_unknown: 0, cash_paid_yen: 0};
    g.count += 1;
    g.actual_ex_tax = add(g.actual_ex_tax, r.actual_ex_tax);
    g.tax_amount = add(g.tax_amount, r.tax_amount);
    g.actual_inc_tax = add(g.actual_inc_tax, r.actual_inc_tax);
    if (r.withholding_yen == null) g.withholding_unknown += 1; else g.withholding_yen = add(g.withholding_yen, r.withholding_yen);
    g.cash_paid_yen = add(g.cash_paid_yen, r.balance?.cash_paid_yen);
    if ((r.balance?.cash_paid_yen ?? 0) !== (payments.get(r.id) ?? 0)) cashMismatch += 1;
    groups.set(id, g);
  }
  return {groups: [...groups.values()].sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key))), cashMismatch};
}
// /royalty/periods の控除の結果（S5 の計測⑤の royaltyFingerprint の項目＋権利者名・支払額・保留の件数・合計）。権利者は ID でなく名前で持つ
export async function royaltyResult(api, asOf = ROYALTY_AS_OF) {
  const data = await api.get(`/royalty/periods?asOf=${asOf}`);
  return (data.periods || []).map((p) => [p.holderName ?? null, p.closeMonth, p.status, p.royaltyYen ?? null, p.payableYen ?? null, p.draft?.lineCount ?? null,
    p.draft?.holdCount ?? null, p.draft?.totals ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export async function categoryTexts(db, orgId) {
  return (await db.all('SELECT category,COUNT(*) AS n FROM expenses WHERE org_id=? GROUP BY category ORDER BY category', [orgId])).map((r) => [r.category, Number(r.n)]);
}
// 費目の自由文（expenses.category）と、明細の最新の会計の版が指す費用区分の版の名前の食い違い（E-6 の期待値）。
// 取消した明細は数えない。会計の版が無いか無効な明細は unready。名前と完全一致は matched、違えば、自由文（NFKC・前後の空白を除く）が
// 同じ費用区分を指す有効な別名なら viaAlias、そうでなければ unrelated。mismatched＝viaAlias＋unrelated
export async function expectedCategoryMismatch(db, orgId) {
  const rows = await db.all(`SELECT e.id,e.category,a.active,a.category_version_id FROM expenses e
    LEFT JOIN expense_accounting_versions a ON a.org_id=e.org_id AND a.expense_id=e.id
      AND a.version_no=(SELECT MAX(x.version_no) FROM expense_accounting_versions x WHERE x.org_id=a.org_id AND x.expense_id=a.expense_id)
    WHERE e.org_id=? AND NOT EXISTS(SELECT 1 FROM expense_line_voids v WHERE v.org_id=e.org_id AND v.expense_id=e.id)`, [orgId]);
  const versions = new Map((await db.all('SELECT id,category_id,name FROM expense_category_versions WHERE org_id=?', [orgId])).map((r) => [r.id, r]));
  const aliasRows = await db.all('SELECT alias_text,version_no,active,category_version_id FROM expense_category_alias_versions WHERE org_id=? ORDER BY version_no', [orgId]);
  const aliases = new Map();
  for (const r of aliasRows) aliases.set(r.alias_text, r);
  const out = {checked: 0, matched: 0, mismatched: 0, viaAlias: 0, unrelated: 0, unready: 0};
  for (const r of rows) {
    const version = r.category_version_id == null ? null : versions.get(r.category_version_id);
    if (!version || Number(r.active) !== 1) { out.unready += 1; continue; }
    out.checked += 1;
    if (r.category === version.name) { out.matched += 1; continue; }
    out.mismatched += 1;
    const alias = aliases.get(String(r.category ?? '').normalize('NFKC').trim());
    const target = alias && Number(alias.active) === 1 ? versions.get(alias.category_version_id) : null;
    if (target && target.category_id === version.category_id) out.viaAlias += 1; else out.unrelated += 1;
  }
  return out;
}
export async function measureExpenseGrain(seed) {
  const {api, db, orgId} = seed;
  const sheet = await sheetRows(api);
  const {groups, cashMismatch} = await sheetGroups(db, orgId, sheet.rows);
  const payout = await api.get('/expense-payouts?groupBy=partner');
  return {
    sheet: {total: sheet.total, totals: sheet.totals, cashMismatch, groups},
    payouts: {excluded: payout.excluded, rows: payout.rows.map((g) => [g.label, g.count, g.cash_due_yen, g.debt_yen, g.withholding_due_yen]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))},
    royalty: await royaltyResult(api),
    categories: await categoryTexts(db, orgId),
    categoryMismatch: await expectedCategoryMismatch(db, orgId),
  };
}

// 費用区分（その他経費）から導いた勘定科目の名前（勘定科目の検算の束の1行目に入れる）
export async function derivedAccountName(db, orgId, categoryVersionId) {
  const row = await db.get(`SELECT g.name FROM expense_category_versions v JOIN gl_account_class_versions c ON c.org_id=v.org_id AND c.id=v.account_class_version_id
    JOIN gl_accounts g ON g.org_id=c.org_id AND g.id=c.account_id WHERE v.org_id=? AND v.id=?`, [orgId, categoryVersionId]);
  return row.name;
}
export async function accountCheckFile(seed) {
  return oldXlsx(OLD_HEADINGS_22, accountCheckRows(await derivedAccountName(seed.db, seed.orgId, seed.ids.otherCategory)));
}
// 統合前: 新しい束の下見・同じファイルの再下見・再評価のどれも勘定科目を検算しない
async function accountCheckBefore(seed) {
  const {api, supplement} = seed;
  const bytes = await accountCheckFile(seed);
  const body = {reason: GRAIN_REASON, file_name: 'DEMO-grain-account.xlsx', original_base64: base64(bytes), supplement};
  const first = await api.post('/expense-imports/preview', {...body, expectedVersion: 0});
  const again = await api.post('/expense-imports/preview', {...body, expectedVersion: 1});
  const revised = await api.post(`/expense-imports/${first.id}/preview`, {expectedVersion: 2, reason: GRAIN_REASON, supplement});
  return {preview: previewSummary(first), repreview: previewSummary(again), revise: previewSummary(revised)};
}
// 統合前の書き出し→取込（参考）: 旧22列（源泉は負）は通り、基本25列は見出しが旧25列の雛形と違うので断られる
async function roundTripBefore(seed) {
  const {api, ids, supplement} = seed;
  const groups = [{key: 'A', from: 2, to: 3, invoice_number: ROUND_TRIP.invoices.A.invoice_number, document_kind: 'invoice'}, {key: 'B', from: 4, to: 4, document_kind: 'receipt'}];
  const sup = {...supplement, project_id: ids.project, tax_category_version_id: ids.tax, withholding_category_version_id: ids.withholding, each_row_invoice: false, groups};
  const out = {};
  for (const [set, format] of [['legacy', 'csv'], ['legacy', 'xlsx'], ['basic', 'csv'], ['basic', 'xlsx']]) {
    const file = await api.raw('GET', `/expense-sheet/export.${format}?set=${set}&partnerId=${ids.payee}`);
    const r = await api.raw('POST', '/expense-imports/preview', {expectedVersion: 0, reason: GRAIN_REASON, file_name: `DEMO-grain-${set}.${format}`, original_base64: base64(file.body), supplement: sup});
    out[`${set}.${format}`] = r.status === 201 ? {status: r.status, ...previewSummary(r.body)} : {status: r.status, error: r.body.error ?? null};
  }
  return out;
}

// ---------- まとめて作る ----------
async function buildOnce(log) {
  const db = new LocalDatabase(':memory:');
  try {
    const seed = await seedExpenseGrain(db, {log});
    const measured = await measureExpenseGrain(seed);
    return {...measured, imports: seed.imports, accountCheck: await accountCheckBefore(seed), roundTripBefore: await roundTripBefore(seed)};
  } finally {
    db.raw?.close?.();
  }
}

const SOURCE = 'scripts/expense-sheet-grain-fixtures.mjs で、統合前の main のコードと架空データ（seed-all-demo の sales・distribution・expenses の節と、この道具の追加。組織 DEMO-SALES）から作った。手で直さない';
export function fixtureFile(built) {
  return {format: 'expense-sheet-grain-snapshot', source: SOURCE, org: SALES_DEMO.orgCode, seedSteps: GRAIN_SEED_STEPS, royaltyAsOf: ROYALTY_AS_OF,
    roundTrip: {seed: ROUND_TRIP, before: built.roundTripBefore}, unrelatedCategory: UNRELATED_CATEGORY, royaltyExpense: ROYALTY_EXPENSE,
    sheet: built.sheet, payouts: built.payouts, royalty: built.royalty, categories: built.categories, categoryMismatch: built.categoryMismatch,
    imports: built.imports, accountCheck: built.accountCheck};
}

// 読みやすく、差分が小さくなる JSON（数・文字だけの配列は1行、配列の配列は1行に1つ）
export function fixtureJson(value, indent = '') {
  const next = `${indent}  `;
  const flat = (v) => v === null || typeof v !== 'object';
  if (flat(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(flat)) return `[${value.map((v) => JSON.stringify(v)).join(',')}]`;
    return `[\n${value.map((v) => `${next}${fixtureJson(v, next)}`).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${fixtureJson(v, next)}`).join(',\n')}\n${indent}}`;
}

function parseArgs(argv) {
  const options = {out: FIXTURE_DIR, twice: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--twice') options.twice = true;
    else if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--out の値（フォルダ）を指定してください');
      options.out = resolve(next);
      i += 1;
    } else throw new Error(`知らない指定です: ${arg}`);
  }
  return options;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const problem = preIntegrationProblem();
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  const render = (built) => `${fixtureJson(fixtureFile(built))}\n`;
  const first = render(await buildOnce(() => {}));
  if (options.twice) {
    const second = render(await buildOnce(() => {}));
    if (first !== second) {
      console.error('2回作った fixture が違います（書き出していません）');
      process.exit(1);
    }
    console.log('2回作って同じでした: grain-snapshot.json');
  }
  mkdirSync(options.out, {recursive: true});
  writeFileSync(join(options.out, 'grain-snapshot.json'), first);
  console.log(`grain-snapshot.json: ${Buffer.byteLength(first).toLocaleString('ja-JP')} バイト`);
}
