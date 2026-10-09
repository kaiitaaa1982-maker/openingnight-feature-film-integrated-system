// 売上集計シート（83列）の試験。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §4。
// 期待値はこの試験の中で、架空の入力（下の定数）から書き下した式で計算し直す（column-registry・sales-sheet-model の関数は使わない）。
// ・列カタログ: 元の並び1〜83がちょうど1回ずつ・まとまりの列数（識別8・日付10・数量12・単価6・料率5・取引先側の総額6・当社売上6・外貨4・計上と税6・前払保証3・劇場と券種7・備考1・監査9）
// ・取込（CSV）で拡張属性（attr_列キー）に値が入り、明細の値・切り口の集計（合計・期末・比率の再計算・最小〜最大・種類の数）・月を横に並べる・通貨・ページ送り・空の列
// ・権限（制作担当は使えない・財務の権限の無い作品は見えない）・版（古い版は 409）・トリガー（変更・削除・型・外貨の額・列の型）・出力（Excel・83列の CSV）・保存した形
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv, parseCsv} from '../src/csv.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {INITIAL_SHEET_COLUMNS, COLUMN_SETS, SOURCE_REFS} from '../src/sales-sheet/column-registry.mjs';
import {SALES_TARGETS, CORE_SALES_TARGETS} from '../src/import/column-synonyms.mjs';

// ---------- 架空の入力 ----------
const THEATRE = [ // 2026-04・取引先 PT-CINEMA（id 1）・商品なし・流通ID H001（配給 RS）
  {desc: '劇場 一般', ex: 900000, tax: 90000, ticket: '一般', admissions: 1000, gross: 1800000, theatre: '架空劇場A', unitInc: 1980},
  {desc: '劇場 シニア', ex: 260000, tax: 26000, ticket: 'シニア', admissions: 400, gross: 520000, theatre: '架空劇場B', unitInc: 1430},
];
const RENTAL = [ // 取引先 PT-STORE（id 3）・レンタル（流通ID R003）。在庫は本数
  {month: '2026-04', product: 2, desc: 'レンタル 4月', ex: 30000, tax: 3000, count: 120, avg: 400, holder: 250, inventory: 80, turnover: '2.4', overdue: 5, rate: '62.5'},
  {month: '2026-05', product: 2, desc: 'レンタル 5月', ex: 15000, tax: 1500, count: 60, avg: 400, holder: 250, inventory: 50, turnover: '1.5', overdue: 3, rate: '50'},
  {month: '2026-05', product: null, desc: 'レンタル 5月（商品未登録）', ex: 5000, tax: 500, count: 10, avg: 400, holder: 250, inventory: 20, turnover: '', overdue: '', rate: ''},
];
const SVOD = [ // 取引先 PT-DIGITAL（id 2）・商品 SKU-DIGI（id 1）・流通ID D005（SVOD）
  {month: '2026-04', desc: '見放題 4月', ex: 100000, tax: 10000, views: 5000, seconds: 1800000, holderUnit: '20', reported: '250000', uu: 1200, rate: '40'},
  {month: '2026-05', desc: '見放題 5月', ex: 50000, tax: 5000, views: 4000, seconds: 720000, holderUnit: '12.5', reported: '125000', uu: 900, rate: '40'},
];
const OVERSEAS = [ // 取引先 PT-OVERSEAS（この試験で足す）・免税・商品なし
  {month: '2026-04', desc: '海外 北米', ex: 1482500, code: 'A002', currency: 'USD', original: '10000.00', rate: '148.25'},
  {month: '2026-05', desc: '海外 台湾', ex: 461250, code: 'A001', currency: 'TWD', original: '100000.00', rate: '4.6125'},
  {month: '2026-05', desc: '海外 北米（追加）', ex: 750000, code: 'A001', currency: 'USD', original: '5000.00', rate: '150'},
];
const EXTRA = 12; // ページ送りの確認用に足す配信の小さい売上（2026-03・1件ずつ）

// ---------- 書き下した決まり ----------
const round = (value, digits) => { const f = 10 ** digits; return Math.sign(value) * Math.round(Math.abs(value) * f) / f; };
const sum = (list) => list.reduce((a, b) => a + b, 0);

let db, admin, editor, production, app, ids = {};
async function loginAs(email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()), type};
  };
  return {get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload)};
}
async function importReport(kind, workId, headers, rows) {
  const preview = await admin.post('/imports/preview', {kind, workId, text: toCsv(headers, rows)});
  assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 400));
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body.errors));
  const commit = await admin.post('/imports/commit', {token: preview.body.token});
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
}
const saleIdsOf = async (reportKey) => (await db.all('SELECT s.id FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key=? ORDER BY s.source_row', [reportKey])).map((row) => row.id);
async function classify(saleId, code, territory = '日本') {
  const out = await admin.post('/report-center/classifications', {saleId, distributionCode: code, baseVersion: 0, territory, serviceName: null, settlementMethod: 'unverified', reason: '試験の分類'});
  assert.equal(out.status, 201, JSON.stringify(out.body));
}
const byPartner = (rows, code) => rows.find((row) => row.dimkey_partner === code);

before(async (t) => {
  db = await openTestDb({t});
  app = createApp({db, mode: 'local'});
  admin = await loginAs('admin@openingnight.invalid');
  editor = await loginAs('editor@openingnight.invalid');
  production = await loginAs('production@openingnight.invalid');
  assert.equal((await admin.post('/sales-sheet/columns/adopt', {reason: '試験で採用'})).status, 201);
  const partner = await admin.post('/partners', {code: 'PT-OVERSEAS', name: '架空海外（架空）', kind: 'agency'});
  ids.overseasPartner = partner.body.id;
  const base = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax'];
  await importReport('theatrical', 1, [...base, 'theatrical_model', 'ticket_type_code', 'admissions_count', 'gross_box_office_ex_tax', 'attr_theatre_name', 'attr_theatre_unit_inc_tax'],
    THEATRE.map((t) => ['SS-THR-2026-04', 1, '', '2026-04-01', '2026-04-30', '2026-04', t.desc, '', t.ex, t.tax, t.ex + t.tax, 'theatrical_rs', t.ticket, t.admissions, t.gross, t.theatre, t.unitInc]));
  ids.theatre = await saleIdsOf('SS-THR-2026-04');
  for (const id of ids.theatre) await classify(id, 'H001');
  const rentalHeaders = [...base, 'package_model', 'turns_count', 'average_rental_price_ex_tax', 'holder_unit_price_ex_tax', 'inventory_count', 'observation_unit', 'observation_scope', 'observation_basis', 'inventory_as_of',
    'attr_rental_turnover', 'attr_overdue_count', 'attr_rs_partner_rate'];
  ids.rental = [];
  for (const month of ['2026-04', '2026-05']) {
    const end = month === '2026-04' ? '30' : '31';
    await importReport('package', 1, rentalHeaders, RENTAL.filter((r) => r.month === month).map((r) => [`SS-RNT-${month}`, 3, r.product ?? '', `${month}-01`, `${month}-${end}`, month, r.desc, r.count, r.ex, r.tax, r.ex + r.tax,
      'rental', r.count, r.avg, r.holder, r.inventory, '本', '全店', '月末', `${month}-${end}`, r.turnover, r.overdue, r.rate]));
    ids.rental.push(...await saleIdsOf(`SS-RNT-${month}`));
  }
  for (const id of ids.rental) await classify(id, 'R003');
  ids.svod = [];
  for (const s of SVOD) {
    const end = s.month === '2026-04' ? '30' : '31';
    await importReport('digital', 1, [...base, 'digital_model', 'service_code', 'view_count', 'view_seconds', 'holder_unit_price_ex_tax', 'reported_actual_ex_tax', 'attr_unique_viewers', 'attr_vod_partner_rate'],
      [[`SS-SVOD-${s.month}`, 2, 1, `${s.month}-01`, `${s.month}-${end}`, s.month, s.desc, '', s.ex, s.tax, s.ex + s.tax, 'svod', 'SVC', s.views, s.seconds, s.holderUnit, s.reported, s.uu, s.rate]]);
    ids.svod.push(...await saleIdsOf(`SS-SVOD-${s.month}`));
  }
  for (const id of ids.svod) await classify(id, 'D005');
  ids.overseas = [];
  for (const [n, o] of OVERSEAS.entries()) {
    const end = o.month === '2026-04' ? '30' : '31';
    await importReport('other', 1, base, [[`SS-OS-${n}`, ids.overseasPartner, '', `${o.month}-01`, `${o.month}-${end}`, o.month, o.desc, '', o.ex, 0, o.ex]]);
    const [id] = await saleIdsOf(`SS-OS-${n}`);
    ids.overseas.push(id);
    await classify(id, o.code, o.currency === 'USD' ? '北米' : '台湾');
    const out = await admin.post(`/sales-sheet/sales/${id}/currency`, {baseVersion: 0, currencyCode: o.currency, originalAmount: o.original, exchangeRate: o.rate, rateDate: `${o.month}-01`, basis: '試験のレート', reason: '試験'});
    assert.equal(out.status, 201, JSON.stringify(out.body));
  }
  for (let n = 1; n <= EXTRA; n += 1) {
    const out = await admin.post('/sales', {workId: 1, report_key: `SS-EXTRA-${n}`, kind: 'digital', description: `追加の配信 ${n}`, quantity: '', partner_id: 2, product_id: 1,
      period_from: '2026-03-01', period_to: '2026-03-31', accounting_month: '2026-03', amount_ex_tax: 100 * n, tax_amount: 10 * n, amount_inc_tax: 110 * n});
    assert.equal(out.status, 200, JSON.stringify(out.body));
  }
});

test('列カタログ: 元の並び1〜83がちょうど1回ずつ、まとまりの列数が旧の意味どおり、取り方は許可リストのキーか式だけ', () => {
  const legacy = INITIAL_SHEET_COLUMNS.filter((column) => column.legacy_position);
  assert.deepEqual(legacy.map((column) => column.legacy_position).sort((a, b) => a - b), Array.from({length: 83}, (_, n) => n + 1));
  const groups = {};
  for (const column of legacy) groups[column.group_key] = (groups[column.group_key] || 0) + 1;
  assert.deepEqual(groups, {identity: 8, dates: 10, quantity: 12, unit_price: 6, rate: 5, partner_gross: 6, holder_sales: 6, currency: 4, booking: 6, mg_balance: 3, theatre: 7, note: 1, audit: 9});
  const keys = new Set(INITIAL_SHEET_COLUMNS.map((column) => column.column_key));
  assert.equal(keys.size, INITIAL_SHEET_COLUMNS.length, '列キーは重ならない');
  assert.equal(new Set(INITIAL_SHEET_COLUMNS.map((column) => column.label)).size, INITIAL_SHEET_COLUMNS.length, '見出しは重ならない（Excel の見出しで照合するため）');
  const walk = (node, out = []) => { if (node?.col) out.push(node.col); for (const arg of node?.args || []) walk(arg, out); return out; };
  for (const column of INITIAL_SHEET_COLUMNS) {
    if (column.source_kind === 'core') assert.ok(Object.hasOwn(SOURCE_REFS, column.source_ref), column.column_key);
    if (column.source_kind === 'attribute') assert.equal(column.source_ref, null, column.column_key);
    if (column.source_kind === 'derived') assert.ok(column.source_ref ? Object.hasOwn(SOURCE_REFS, column.source_ref) : walk(column.formula).length > 0, column.column_key);
    for (const ref of walk(column.formula)) assert.ok(keys.has(ref), `${column.column_key} の式が参照する ${ref}`);
    if (column.aggregation === 'ratio') assert.ok(keys.has(column.numerator_key) && keys.has(column.denominator_key) && [1, 100].includes(column.ratio_scale), column.column_key);
    assert.doesNotMatch(JSON.stringify(column), /SELECT|FROM |JOIN /i, 'SQL の文字列を持たない');
  }
  // 手で数えた ◎12・○45・×26 のうち、置き場所の無い列は 拡張属性か型で守る2表（外貨4・ロイヤリティ3）
  const attributes = legacy.filter((column) => column.source_kind === 'attribute').map((column) => column.legacy_position);
  assert.deepEqual(attributes, [11, 18, 24, 25, 29, 30, 31, 32, 33, 35, 41, 56, 59, 61, 63, 64, 65, 67, 72, 73, 82]);
  assert.equal(COLUMN_SETS.length, 7);
  assert.deepEqual(COLUMN_SETS.map((set) => set.label), ['基本', '劇場', 'ビデオグラム', '配信', 'MG・FLAT', '税・請求・入金', '監査・原本']);
  for (const set of COLUMN_SETS) for (const key of set.columns) assert.ok(keys.has(key), `${set.key}: ${key}`);
});

test('取込の変換先（SALES_TARGETS）は共通売上17列と、カタログの拡張属性の列（attr_列キー）から作る', () => {
  assert.equal(CORE_SALES_TARGETS.length, 17);
  const attributes = INITIAL_SHEET_COLUMNS.filter((column) => column.source_kind === 'attribute');
  assert.equal(SALES_TARGETS.length, 17 + attributes.length);
  for (const column of attributes) {
    const target = SALES_TARGETS.find((item) => item.key === `attr_${column.column_key}`);
    assert.ok(target, column.column_key);
    assert.equal(target.attribute, true);
    assert.ok(target.label.startsWith(column.label));
  }
});

test('取込の attr_ 列の値は、売上と同じ登録で拡張属性の版1になる（入れ方=取込・理由に報告番号）。知らない列・型の違う値は確認の段階で止める', async () => {
  const rows = await db.all("SELECT column_key,version_no,value_text,value_number,origin,reason FROM sale_attribute_values WHERE sale_id=? ORDER BY column_key", [ids.theatre[0]]);
  assert.deepEqual(rows.map((row) => [row.column_key, row.version_no, row.value_text ?? (row.value_number === null ? null : Number(row.value_number)), row.origin]), [['theatre_name', 1, '架空劇場A', 'report_import'], ['theatre_unit_inc_tax', 1, 1980, 'report_import']]);
  assert.match(rows[0].reason, /SS-THR-2026-04/);
  const headers = ['report_key', 'partner_id', 'period_from', 'period_to', 'accounting_month', 'description', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax'];
  const unknown = await admin.post('/imports/preview', {kind: 'digital', workId: 1, text: toCsv([...headers, 'attr_no_such_column'], [['SS-BAD-1', 2, '2026-04-01', '2026-04-30', '2026-04', 'x', 1, 0, 1, 'a']])});
  assert.equal(unknown.body.ok, false);
  assert.match(unknown.body.errors[0].message, /売上集計シートに無い列/);
  const wrongType = await admin.post('/imports/preview', {kind: 'digital', workId: 1, text: toCsv([...headers, 'attr_unique_viewers'], [['SS-BAD-2', 2, '2026-04-01', '2026-04-30', '2026-04', 'x', 1, 0, 1, '12人']])});
  assert.equal(wrongType.body.ok, false);
  assert.match(wrongType.body.errors[0].message, /視聴UU数は整数/);
  const coreColumn = await admin.post('/imports/preview', {kind: 'digital', workId: 1, text: toCsv([...headers, 'attr_amount_ex_tax'], [['SS-BAD-3', 2, '2026-04-01', '2026-04-30', '2026-04', 'x', 1, 0, 1, '5']])});
  assert.match(coreColumn.body.errors[0].message, /拡張属性の列ではありません/);
});

test('明細の値: 当社売上の列は流通のまとまりで分かれ、視聴時間（時間）・劇場別の単価・消費税率は行ごとに計算する', async () => {
  const all = (await admin.get('/sales-sheet?set=all&hideEmpty=0&pageSize=100')).body;
  assert.equal(all.total, 2 + 3 + 2 + 3 + EXTRA);
  const row = (id) => all.rows.find((item) => item.__id === id);
  // 劇場（H001 = 配給 RS → RS の当社売上）
  THEATRE.forEach((t, n) => {
    const r = row(ids.theatre[n]);
    assert.equal(r.rs_holder_ex_tax, t.ex);
    assert.equal(r.flat_holder_ex_tax, null);
    assert.equal(r.admissions, t.admissions);
    assert.equal(r.box_office_ex_tax, t.gross);
    assert.equal(r.theatre_unit_ex_tax, round(t.gross / t.admissions, 2));
    assert.equal(r.ticket_name, t.ticket);
    assert.equal(r.theatre_name, t.theatre);
    assert.equal(r.tax_rate, 10);
    assert.equal(r.distribution_code, 'H001');
  });
  // 配信（D005 = SVOD → 見放題・広告型・海外の当社売上）
  SVOD.forEach((s, n) => {
    const r = row(ids.svod[n]);
    assert.equal(r.vod_holder_ex_tax, s.ex);
    assert.equal(r.view_hours, round(s.seconds / 3600, 2));
    assert.equal(r.view_count, s.views);
    assert.equal(r.vod_partner_sales_ex_tax, Number(s.reported));
    assert.equal(r.unique_viewers, s.uu);
  });
  // 海外（A002 = 海外 RS → 視聴連動、A001 = 海外 FLAT → 定額）。免税は税率0
  OVERSEAS.forEach((o, n) => {
    const r = row(ids.overseas[n]);
    assert.equal(o.code === 'A001' ? r.flat_holder_ex_tax : r.vod_holder_ex_tax, o.ex);
    assert.equal(r.tax_rate, 0);
    assert.equal(r.currency_code, o.currency);
    assert.equal(r.foreign_amount, Number(o.original));
    assert.equal(r.exchange_rate, Number(o.rate));
  });
  // 記録の無い売上の通貨は円、ロイヤリティ計上月・額は計上月・計上額と同じ
  const extra = all.rows.find((item) => item.line_note === '追加の配信 3');
  assert.equal(extra.currency_code, 'JPY');
  assert.equal(extra.royalty_month, '2026-03');
  assert.equal(extra.royalty_amount_ex_tax, 300);
  // 流通の分類の無い明細は、流通ID列を「未分類」と出す（集計・絞り込みのキーは報告の種類の既定 digital_unknown のまま）
  assert.equal(extra.distribution_code, '未分類');
});

test('集計（取引先ごと）: 合計・期末の値・比率の再計算・最小〜最大・種類の数が、書き下した式と一致する', async () => {
  const body = (await admin.get('/sales-sheet?set=all&grain=aggregate&dims=partner&hideEmpty=0')).body;
  const store = byPartner(body.rows, 'PT-STORE');
  const counts = RENTAL.map((r) => r.count), holders = RENTAL.map((r) => r.ex);
  assert.equal(store.__count, RENTAL.length);
  assert.equal(store.amount_ex_tax, sum(holders));
  assert.equal(store.rs_holder_ex_tax, sum(holders));
  assert.equal(store.rs_count, sum(counts));
  assert.equal(store.rs_holder_unit_ex_tax, round(sum(holders) / sum(counts), 2), '当社の単価 = 当社売上の合計÷件数の合計');
  assert.equal(store.rs_partner_unit_ex_tax, round(sum(RENTAL.map((r) => r.avg * r.count)) / sum(counts), 2), '取引先の単価 = Σ(単価×件数)÷Σ件数');
  const withTurnover = RENTAL.filter((r) => r.turnover);
  assert.equal(store.rental_turnover, round(sum(withTurnover.map((r) => r.count)) / sum(withTurnover.map((r) => r.count / Number(r.turnover))), 2), '回転率 = Σ件数÷Σ(件数÷回転率)（平均の平均ではない）');
  assert.notEqual(store.rental_turnover, round((2.4 + 1.5) / 2, 2));
  const withRate = RENTAL.filter((r) => r.rate);
  assert.equal(store.rs_partner_rate, round(sum(withRate.map((r) => r.ex)) / sum(withRate.map((r) => r.ex * 100 / Number(r.rate))) * 100, 2), '料率 = Σ当社売上÷Σ(当社売上÷料率)');
  // 在庫は期末の値: 商品2は最後の月（5月）の50、商品の無い系列は20。月をまたいで足さない（80+50+20=150 ではない）
  assert.equal(store.stock_units, 50 + 20);
  assert.equal(store.overdue_count, sum(RENTAL.map((r) => Number(r.overdue || 0))));
  assert.equal(store.booking_month, '2026-04〜2026-05');
  assert.equal(store.product_code, 'SKU-PACK', '商品の種類が1つならその値（商品の無い行は数えない）');
  const cinema = byPartner(body.rows, 'PT-CINEMA');
  const admissions = sum(THEATRE.map((t) => t.admissions));
  assert.equal(cinema.admissions, admissions);
  assert.equal(cinema.theatre_unit_ex_tax, round(sum(THEATRE.map((t) => t.gross)) / admissions, 2));
  assert.equal(cinema.theatre_unit_inc_tax, round(sum(THEATRE.map((t) => t.unitInc * t.admissions)) / admissions, 2));
  assert.equal(cinema.theatre_name, '2種類');
  assert.equal(cinema.tax_rate, round(sum(THEATRE.map((t) => t.tax)) / sum(THEATRE.map((t) => t.ex)) * 100, 1));
  const digital = byPartner(body.rows, 'PT-DIGITAL');
  assert.equal(digital.view_hours, round(sum(SVOD.map((s) => round(s.seconds / 3600, 2))), 2));
  assert.equal(digital.vod_unit_ex_tax, round(sum(SVOD.map((s) => s.ex)) / sum(SVOD.map((s) => s.views)), 4), '見放題の単価 = 当社売上÷視聴回数');
  assert.equal(digital.vod_partner_rate, 40);
  assert.equal(digital.unique_viewers, sum(SVOD.map((s) => s.uu)));
  assert.equal(digital.amount_ex_tax, sum(SVOD.map((s) => s.ex)) + sum(Array.from({length: EXTRA}, (_, n) => 100 * (n + 1))));
  // 通貨が混ざる取引先では外貨の額・レートを空にし、混ざったことを返す
  const overseas = byPartner(body.rows, 'PT-OVERSEAS');
  assert.equal(overseas.foreign_amount, null);
  assert.equal(overseas.exchange_rate, null);
  assert.ok(overseas.__mixed.includes('foreign_amount'));
  assert.equal(overseas.currency_code, '2種類');
  // 合計行（条件に合う全行）
  assert.equal(body.totals.amount_ex_tax, sum([...THEATRE, ...RENTAL, ...SVOD, ...OVERSEAS].map((x) => x.ex)) + sum(Array.from({length: EXTRA}, (_, n) => 100 * (n + 1))));
});

test('集計（通貨ごと）: 外貨の額は通貨ごとに足し、為替レートは Σ(外貨×レート)÷Σ外貨', async () => {
  const body = (await admin.get('/sales-sheet?set=digital&grain=aggregate&dims=currency&hideEmpty=0')).body;
  for (const code of ['USD', 'TWD']) {
    const list = OVERSEAS.filter((o) => o.currency === code);
    const row = body.rows.find((item) => item.dimkey_currency === code);
    assert.equal(row.foreign_amount, round(sum(list.map((o) => Number(o.original))), 2), code);
    assert.equal(row.exchange_rate, round(sum(list.map((o) => Number(o.original) * Number(o.rate))) / sum(list.map((o) => Number(o.original))), 4), code);
  }
  assert.equal(body.rows.find((item) => item.dimkey_currency === 'JPY').foreign_amount, null);
});

test('集計で月を横に並べる（計上月・税抜／税込）。範囲の月はすべて出る', async () => {
  for (const tax of ['ex', 'inc']) {
    const body = (await admin.get(`/sales-sheet?set=basic&grain=aggregate&dims=partner&pivot=1&from=2026-03&to=2026-05&tax=${tax}`)).body;
    assert.deepEqual(body.months, ['2026-03', '2026-04', '2026-05']);
    const store = byPartner(body.rows, 'PT-STORE');
    const amount = (r) => (tax === 'inc' ? r.ex + r.tax : r.ex);
    assert.equal(store['m_2026-04'], sum(RENTAL.filter((r) => r.month === '2026-04').map(amount)));
    assert.equal(store['m_2026-05'], sum(RENTAL.filter((r) => r.month === '2026-05').map(amount)));
    assert.equal(store['m_2026-03'], null);
    assert.equal(byPartner(body.rows, 'PT-DIGITAL')['m_2026-03'], sum(Array.from({length: EXTRA}, (_, n) => (tax === 'inc' ? 110 : 100) * (n + 1))));
  }
});

test('ページ送り（サーバー側）: 計上月の新しい順→売上IDの大きい順。ページを合わせると全件、同じ行は2回出ない', async () => {
  const pages = [];
  let first;
  for (let page = 1; page <= 3; page += 1) {
    const body = (await admin.get(`/sales-sheet?set=basic&pageSize=10&page=${page}`)).body;
    first ??= body;
    pages.push(...body.rows);
  }
  const total = 2 + 3 + 2 + 3 + EXTRA;
  assert.equal(first.total, total);
  assert.equal(first.pages, Math.ceil(total / 10));
  assert.equal(pages.length, total);
  assert.equal(new Set(pages.map((row) => row.__id)).size, total);
  const expected = (await db.all("SELECT s.id FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE s.org_id=1 AND r.status='active' ORDER BY s.accounting_month DESC, s.id DESC")).map((row) => row.id);
  assert.deepEqual(pages.map((row) => row.__id), expected);
});

test('全行が空の列を隠す（条件に合う全行で判定）。隠さない指定では全列を返す', async () => {
  const hidden = (await admin.get('/sales-sheet?set=theatre&kind=package')).body;
  assert.ok(hidden.hiddenEmpty.includes('theatre_name'));
  assert.ok(!hidden.columns.some((column) => column.key === 'admissions'));
  assert.ok(hidden.columns.some((column) => column.key === 'amount_ex_tax'));
  const shown = (await admin.get('/sales-sheet?set=theatre&kind=package&hideEmpty=0')).body;
  assert.equal(shown.hiddenEmpty.length, 0);
  assert.equal(shown.columns.length, COLUMN_SETS.find((set) => set.key === 'theatre').columns.length);
});

test('権限: 制作担当は使えない。財務の権限の無い作品の売上は見えず、直せない。列の採用・追加は管理者だけ', async () => {
  for (const path of ['/sales-sheet', '/sales-sheet/columns', '/sales-sheet/views', `/sales-sheet/sales/${ids.theatre[0]}`]) assert.equal((await production.get(path)).status, 403, path);
  assert.equal((await production.post('/sales-sheet/values', {reason: 'x', changes: [{saleId: ids.theatre[0], columnKey: 'theatre_name', baseVersion: 1, value: 'x'}]})).status, 403);
  // 案件2（編集担当に権限なし）の作品の売上
  const project = await admin.post('/projects', {code: 'PRJ-SS-2', title: '架空の別案件', status: 'active', budget_yen: 1});
  const work = await admin.post('/works', {project_id: project.body.id, code: 'WRK-SS-2', title: '架空の別作品', format: 'film'});
  const sale = await admin.post('/sales', {workId: work.body.id, report_key: 'SS-HIDDEN-1', kind: 'digital', description: '見えない売上', quantity: '', partner_id: 2,
    period_from: '2026-04-01', period_to: '2026-04-30', accounting_month: '2026-04', amount_ex_tax: 777, tax_amount: 77, amount_inc_tax: 854});
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const hiddenId = (await saleIdsOf('SS-HIDDEN-1'))[0];
  const adminView = (await admin.get('/sales-sheet?set=basic&pageSize=500')).body;
  const editorView = (await editor.get('/sales-sheet?set=basic&pageSize=500')).body;
  assert.ok(adminView.rows.some((row) => row.__id === hiddenId));
  assert.ok(!editorView.rows.some((row) => row.__id === hiddenId));
  assert.equal(editorView.total, adminView.total - 1);
  assert.equal((await editor.get(`/sales-sheet/sales/${hiddenId}`)).status, 404);
  const denied = await editor.post('/sales-sheet/values', {reason: '試験', changes: [{saleId: hiddenId, columnKey: 'theatre_name', baseVersion: 0, value: 'x'}]});
  assert.equal(denied.status, 400);
  assert.match(JSON.stringify(denied.body.details), /財務の権限がありません/);
  assert.equal((await editor.post('/sales-sheet/columns/adopt', {reason: 'x'})).status, 403);
  assert.equal((await editor.post('/sales-sheet/columns', {columnKey: 'x_col', label: 'x', valueType: 'text', aggregation: 'distinct', reason: 'x'})).status, 403);
  // 別組織の管理者には何も見えない（列も未採用）
  const outsider = await loginAs('outsider@other.invalid');
  const other = (await outsider.get('/sales-sheet')).body;
  assert.equal(other.adopted, false);
  assert.equal(other.rows.length, 0);
});

test('拡張属性の版: 古い版からの登録は 409、同じ値は登録しない、空欄は値を消した版。前の値は履歴に残り、監査に記録する', async () => {
  const saleId = ids.svod[0];
  const stale = await admin.post('/sales-sheet/values', {reason: '試験', changes: [{saleId, columnKey: 'unique_viewers', baseVersion: 0, value: '1300'}]});
  assert.equal(stale.status, 409);
  const same = await admin.post('/sales-sheet/values', {reason: '試験', changes: [{saleId, columnKey: 'unique_viewers', baseVersion: 1, value: '1,200'}]});
  assert.deepEqual([same.status, same.body.saved, same.body.unchanged], [200, 0, 1]);
  const changed = await admin.post('/sales-sheet/values', {reason: '報告の訂正（試験）', changes: [{saleId, columnKey: 'unique_viewers', baseVersion: 1, value: '1300'}, {saleId, columnKey: 'ticket_campaign', baseVersion: 0, value: 'はい'}]});
  assert.deepEqual([changed.status, changed.body.saved], [201, 2]);
  const cleared = await admin.post('/sales-sheet/values', {reason: '誤って入れた（試験）', changes: [{saleId, columnKey: 'ticket_campaign', baseVersion: 1, value: ''}]});
  assert.equal(cleared.status, 201);
  const detail = (await admin.get(`/sales-sheet/sales/${saleId}`)).body;
  assert.equal(detail.values.unique_viewers, 1300);
  assert.equal(detail.values.ticket_campaign, null);
  assert.deepEqual(detail.history.attributes.filter((row) => row.column_key === 'unique_viewers').map((row) => [row.version_no, row.value_number]), [[2, 1300], [1, 1200]]);
  const bad = await admin.post('/sales-sheet/values', {reason: '試験', changes: [{saleId, columnKey: 'amount_ex_tax', baseVersion: 0, value: '1'}]});
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body.details), /拡張属性の列ではありません/);
  const audit = await db.get("SELECT detail_json FROM audit_log WHERE entity_type='sale_attribute_values' ORDER BY id DESC LIMIT 1");
  assert.match(audit.detail_json, /誤って入れた/);
});

test('トリガー: 変更・削除の禁止、型の照合、外貨の額の照合、列の型と元の列番号は版で変えられない', async () => {
  const saleId = ids.svod[1];
  await assert.rejects(db.run("UPDATE sale_attribute_values SET value_number=1 WHERE sale_id=?", [saleId]), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run('DELETE FROM sale_attribute_values WHERE sale_id=?', [saleId]), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run("INSERT INTO sale_attribute_values(org_id,sale_id,column_key,version_no,value_text,origin,reason,created_by) VALUES(1,?,'unique_viewers',2,'九百','manual','x',1)", [saleId]), (e) => e.dbError?.kind === 'raise' && /type mismatch/.test(e.message));
  await assert.rejects(db.run("INSERT INTO sale_attribute_values(org_id,sale_id,column_key,version_no,value_number,origin,reason,created_by) VALUES(1,?,'amount_ex_tax',1,5,'manual','x',1)", [saleId]), (e) => e.dbError?.kind === 'raise' && /type mismatch/.test(e.message));
  await assert.rejects(db.run("INSERT INTO sale_attribute_values(org_id,sale_id,column_key,version_no,value_number,origin,reason,created_by) VALUES(1,?,'unique_viewers',5,5,'manual','x',1)", [saleId]), (e) => e.dbError?.kind === 'raise' && /stale/.test(e.message));
  await assert.rejects(db.run("INSERT INTO sale_currency_versions(org_id,sale_id,version_no,currency_code,original_amount_x100,exchange_rate_x10000,rate_date,basis,reason,created_by) VALUES(1,?,1,'USD',100000,1500000,'2026-05-01','x','x',1)", [saleId]), (e) => e.dbError?.kind === 'raise' && /does not match/.test(e.message));
  await assert.rejects(db.run("INSERT INTO sales_sheet_column_versions(org_id,column_key,version_no,label,legacy_position,group_key,value_type,aggregation,source_kind,sort_order,active,reason,created_by) VALUES(1,'theatre_name',2,'劇場名','56','theatre','integer','sum','attribute',1,1,'x',1)"), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run("INSERT INTO sales_sheet_column_versions(org_id,column_key,version_no,label,legacy_position,group_key,value_type,aggregation,source_kind,sort_order,active,reason,created_by) VALUES(1,'dup_position',1,'重ね','56','custom','text','distinct','attribute',1,1,'x',1)"), (e) => e.dbError?.kind === 'raise' && /legacy position/.test(e.message));
  const currency = await admin.post(`/sales-sheet/sales/${saleId}/currency`, {baseVersion: 0, currencyCode: 'USD', originalAmount: '1000', exchangeRate: '150', rateDate: '2026-05-01', basis: '試験', reason: '試験'});
  assert.equal(currency.status, 400);
  assert.match(currency.body.error, /合いません/);
});

test('ロイヤリティ計上の基準: 税込＝税抜＋税額。月の基準をロイヤリティ計上月にすると、その月で絞り・並べる', async () => {
  const saleId = ids.theatre[0];
  const bad = await admin.post(`/sales-sheet/sales/${saleId}/royalty-basis`, {baseVersion: 0, royaltyMonth: '2026-06', amountExTax: '800000', taxAmount: '80000', amountIncTax: '1', reason: '試験'});
  assert.equal(bad.status, 400);
  const ok = await admin.post(`/sales-sheet/sales/${saleId}/royalty-basis`, {baseVersion: 0, royaltyMonth: '2026-06', amountExTax: '800,000', taxAmount: '80000', reason: '契約の計上時期（試験）'});
  assert.equal(ok.status, 201);
  const body = (await admin.get('/sales-sheet?set=tax&month=royalty&from=2026-06&to=2026-06')).body;
  assert.deepEqual(body.rows.map((row) => row.__id), [saleId]);
  assert.equal(body.rows[0].royalty_amount_ex_tax, 800000);
  assert.equal(body.rows[0].royalty_amount_inc_tax, 880000);
  assert.equal(body.rows[0].amount_ex_tax, THEATRE[0].ex, '計上額はそのまま');
  const stale = await admin.post(`/sales-sheet/sales/${saleId}/royalty-basis`, {baseVersion: 0, royaltyMonth: '2026-07', amountExTax: '1', taxAmount: '0', reason: '試験'});
  assert.equal(stale.status, 409);
});

test('列を足す（拡張属性）: 管理者が足すと列セットに入り、値を入れられる。見出しの重なりは断る。版で見出しを変え、やめた列には入れられない', async () => {
  const clash = await admin.post('/sales-sheet/columns', {columnKey: 'festival_name', label: '劇場名', groupKey: 'custom', valueType: 'text', aggregation: 'distinct', reason: '試験'});
  assert.equal(clash.status, 400);
  const created = await admin.post('/sales-sheet/columns', {columnKey: 'festival_name', label: '映画祭の名前', groupKey: 'custom', valueType: 'text', aggregation: 'distinct', reason: '映画祭の上映を分けたい（試験）'});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const catalog = (await admin.get('/sales-sheet/columns')).body;
  assert.ok(catalog.sets.find((set) => set.key === 'basic').columns.includes('festival_name'));
  assert.equal(catalog.columns.length, INITIAL_SHEET_COLUMNS.length + 1);
  const saved = await admin.post('/sales-sheet/values', {reason: '試験', changes: [{saleId: ids.theatre[1], columnKey: 'festival_name', baseVersion: 0, value: '架空映画祭'}]});
  assert.equal(saved.status, 201);
  const renamed = await admin.post('/sales-sheet/columns/festival_name/versions', {baseVersion: 1, label: '映画祭', active: false, reason: '使わなくなった（試験）'});
  assert.equal(renamed.status, 201);
  const stale = await admin.post('/sales-sheet/columns/festival_name/versions', {baseVersion: 1, label: 'x', reason: '試験'});
  assert.equal(stale.status, 409);
  const inactive = await admin.post('/sales-sheet/values', {reason: '試験', changes: [{saleId: ids.theatre[1], columnKey: 'festival_name', baseVersion: 1, value: '別'}]});
  assert.equal(inactive.status, 400);
  const derived = await admin.post('/sales-sheet/columns', {columnKey: 'box_office_per_ticket', label: '動員1人あたりの当社売上', groupKey: 'custom', valueType: 'decimal', aggregation: 'ratio', sourceKind: 'derived',
    formula: {op: 'div', args: [{col: 'rs_holder_ex_tax'}, {col: 'admissions'}]}, numeratorKey: 'rs_holder_ex_tax', denominatorKey: 'admissions', ratioScale: 1, digits: 2, reason: '試験の計算列'});
  assert.equal(derived.status, 201, JSON.stringify(derived.body));
  const sql = await admin.post('/sales-sheet/columns', {columnKey: 'bad_ref', label: '悪い参照', valueType: 'text', aggregation: 'distinct', sourceKind: 'derived', sourceRef: 'SELECT 1', reason: '試験'});
  assert.equal(sql.status, 400);
  const agg = (await admin.get('/sales-sheet?columns=box_office_per_ticket,admissions,rs_holder_ex_tax&grain=aggregate&dims=partner')).body;
  assert.equal(byPartner(agg.rows, 'PT-CINEMA').box_office_per_ticket, round(sum(THEATRE.map((t) => t.ex)) / sum(THEATRE.map((t) => t.admissions)), 2));
});

test('保存した形: 作り、名前の重なり・古い版・作った人以外の上書きを断る', async () => {
  const definition = {columns: ['booking_month', 'partner_code', 'amount_ex_tax'], grain: 'aggregate', dimensions: ['partner', 'distribution'], monthBasis: 'sales', taxBasis: 'inc', pivot: true, hideEmpty: true, filters: {kind: 'digital'}};
  const created = await admin.post('/sales-sheet/views', {name: '配信の取引先別', definition, reason: '試験'});
  assert.equal(created.status, 201);
  assert.equal((await admin.post('/sales-sheet/views', {name: '配信の取引先別', definition, reason: '試験'})).status, 409);
  const list = (await editor.get('/sales-sheet/views')).body.views;
  const view = list.find((item) => item.name === '配信の取引先別');
  assert.deepEqual(view.definition, definition);
  assert.equal(view.canEdit, false);
  assert.equal((await editor.post(`/sales-sheet/views/${view.id}/versions`, {baseVersion: 1, definition, reason: '試験'})).status, 403);
  assert.equal((await admin.post(`/sales-sheet/views/${view.id}/versions`, {baseVersion: 1, definition: {...definition, pivot: false}, reason: '試験'})).status, 201);
  assert.equal((await admin.post(`/sales-sheet/views/${view.id}/versions`, {baseVersion: 1, definition, reason: '試験'})).status, 409);
  assert.equal((await admin.post('/sales-sheet/views', {name: '悪い形', definition: {...definition, dimensions: ['partner', 'work', 'product', 'mg']}, reason: '試験'})).status, 400);
});

test('出力: Excel は 売上集計シート・条件・_meta の3枚、83列の CSV は元の並び・日付 YYYY/MM/DD・月 YYYY/MM・率は%の数', async () => {
  const xlsx = await admin.get('/sales-sheet/export.xlsx?set=theatre&kind=theatrical');
  assert.equal(xlsx.status, 200);
  const sheets = decodeXlsx(xlsx.body);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['売上集計シート', '条件', '_meta']);
  const main = sheets[0].rows;
  const headerIndex = main.findIndex((row) => row.includes('劇場名'));
  assert.ok(headerIndex > 0, '見出しの行');
  const header = main[headerIndex];
  const nameAt = header.indexOf('劇場名');
  assert.deepEqual(main.slice(headerIndex + 1, headerIndex + 1 + THEATRE.length).map((row) => row[nameAt]).sort(), THEATRE.map((t) => t.theatre).sort());
  const csvResponse = await app.request('/api/sales-sheet/export.csv?kind=other', {headers: {cookie: (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})})).headers.get('set-cookie').split(';')[0]}});
  const text = (await csvResponse.text()).replace(/^﻿/, '');
  const rows = parseCsv(text);
  const labels = INITIAL_SHEET_COLUMNS.filter((column) => column.legacy_position).sort((a, b) => a.legacy_position - b.legacy_position).map((column) => column.label);
  assert.deepEqual(Object.keys(rows[0].values), labels);
  assert.equal(labels.length, 83);
  assert.equal(rows.length, OVERSEAS.length);
  const north = rows.find((row) => row.values['明細名・備考'] === '海外 北米');
  assert.equal(north.values['販売日（販売期間の初日）'], '2026/04/01');
  assert.equal(north.values['計上月'], '2026/04');
  assert.equal(north.values['消費税率（%）'], '0');
  assert.equal(north.values['通貨'], 'USD');
  assert.equal(Number(north.values['為替レート（1外貨あたりの円）']), 148.25);
  assert.equal(north.values['流通ID'], 'A002');
});

test('取込ウィザードの列対応: 売上集計シートの列は見出しの語から候補を出し、版に attr_ の列対応として入り、前回の版から戻る', async () => {
  const {buildDefinition, defaultFields, fieldsFromDefinition} = await import('../src/import/wizard-model.mjs');
  const headers = ['報告番号', '対象月', '劇場名', '延滞数', '税抜金額', '消費税', '税込金額'];
  const sample = [['R-1', '2026-04', '架空劇場', '3', '1000', '100', '1100']];
  // この組織は列を採用済み（before）。ウィザードは採用して使っている拡張属性の列（取込の文脈の attributeTargets）の中から選ぶ
  const attributeTargets = SALES_TARGETS.filter((target) => target.attribute).map((target) => target.key);
  const {fields, notes} = defaultFields({headers, sampleRows: sample, productIds: [], attributeTargets});
  assert.deepEqual(fields.attributes, {attr_theatre_name: '劇場名', attr_overdue_count: '延滞数'});
  assert.match(notes.attr_theatre_name, /劇場名/);
  const built = buildDefinition(fields, {headers, partnerId: 1, autoKey: 'AUTO'});
  const rules = built.definition.mappings.filter((rule) => rule.target.startsWith('attr_'));
  assert.deepEqual(rules.sort((a, b) => a.target.localeCompare(b.target)), [{target: 'attr_overdue_count', mode: 'source', source: '延滞数'}, {target: 'attr_theatre_name', mode: 'source', source: '劇場名'}]);
  assert.ok(!built.definition.ignoredColumns.includes('劇場名'));
  assert.deepEqual(fieldsFromDefinition(built.definition, headers).attributes, fields.attributes);
  const missing = buildDefinition({...fields, attributes: {attr_theatre_name: '無い列'}}, {headers, partnerId: 1, autoKey: 'AUTO'});
  assert.ok(missing.errors.some((error) => error.target === 'attr_theatre_name'));
  // 共通の列に先に使った元の列（区分を含む見出しは明細名の候補）は、売上集計シートの列の候補にしない
  assert.equal(defaultFields({headers: ['報告番号', '券種区分', '税抜金額'], sampleRows: [], productIds: [], attributeTargets}).fields.attributes, undefined);
  // 劇場名などが無い見出しでは attributes を持たない（既存の列対応を変えない）
  assert.equal(defaultFields({headers: ['報告番号', '税抜金額'], sampleRows: [], productIds: [], attributeTargets}).fields.attributes, undefined);
});

test('取引先別の列対応（マッピングの版）でも attr_ の列を変換先にでき、変換取込で拡張属性に入る', async () => {
  const profile = await admin.post('/mapping-profiles', {partnerId: 2, kind: 'digital', name: '試験の配信の対応'});
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  const definition = {ignoredColumns: [], mappings: [
    {target: 'report_key', mode: 'source', source: '報告番号'}, {target: 'partner_id', mode: 'literal', valueType: 'integer', value: '2'},
    {target: 'period_from', mode: 'source', source: '開始'}, {target: 'period_to', mode: 'source', source: '終了'}, {target: 'accounting_month', mode: 'source', source: '計上月'},
    {target: 'amount_ex_tax', mode: 'source', source: '税抜'}, {target: 'tax_amount', mode: 'source', source: '税'}, {target: 'amount_inc_tax', mode: 'source', source: '税込'},
    {target: 'attr_unique_viewers', mode: 'source', source: 'ユニーク視聴者'},
  ]};
  const version = await admin.post(`/mapping-profiles/${profile.body.id}/versions`, definition);
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const text = toCsv(['報告番号', '開始', '終了', '計上月', '税抜', '税', '税込', 'ユニーク視聴者'], [['SS-MAP-1', '2026-02-01', '2026-02-28', '2026-02', '800', '80', '880', '4321']]);
  const preview = await admin.post('/mapped-imports/preview', {workId: 1, mappingVersionId: version.body.id, text});
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body).slice(0, 400));
  const commit = await admin.post('/mapped-imports/commit', {token: preview.body.token});
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  const [saleId] = await saleIdsOf('SS-MAP-1');
  const detail = (await admin.get(`/sales-sheet/sales/${saleId}`)).body;
  assert.equal(detail.values.unique_viewers, 4321);
  assert.equal(detail.history.attributes[0].origin, 'report_import');
});
