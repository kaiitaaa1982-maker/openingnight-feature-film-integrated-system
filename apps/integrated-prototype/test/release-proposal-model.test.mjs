// 営業基幹「提案資料」の純関数（src/sales-ops/release-proposal-model.mjs）の試験。
// 期待値はこの試験の中で書き下した窓・契約から手で数えたもの（モデルの関数で期待値を作らない）。
// 壊れたときに分かること: 月に入れる窓（日付・月まで）と入れない窓（年まで・時期・未定・取り下げ）、並び、列の並び、提案金額の計算。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPOSAL_BASES, basisOf, selectProposalEntries, proposalMonthCounts, proposalColumns, proposalRow, emptyColumns, statusAllowed,
  svodProposal, svodSheetRows, monthsBetween, SVOD_COLUMNS, rangeYearSpan, nextSvodPeriod, shiftMonth, timingMonthSpans, rangeCoversMonth,
} from '../src/sales-ops/release-proposal-model.mjs';
import {INITIAL_WINDOW_TYPES, parseWindowDate} from '../src/sales-ops/release-window-model.mjs';

// 初期テンプレートの種別（DB の最新の版と同じ形）
const TYPES = new Map(INITIAL_WINDOW_TYPES.map((type, index) => [type.type_key, {...type, id: index + 1, active: true, fields: type.fields.map((f) => ({...f}))}]));
const v = (start, precision, status, extra = {}) => ({start_on: start, date_precision: precision, status, end_on: null, timing_raw: null, fields: {}, ...extra});
const works = [
  {id: 1, code: 'W-B', title: '作品B（架空）'},
  {id: 2, code: 'W-A', title: '作品A（架空）'},
  {id: 3, code: 'W-C', title: '作品C（架空）'},
  {id: 4, code: 'W-D', title: '作品D（架空）'},
];
const windows = new Map([
  [1, new Map([
    ['pvod_early', v('2026-10-15', 'day', 'confirmed', {end_on: '2026-11-14', fields: {price_ex_tax: {t: null, n: 2500}, viewing_hours: {t: null, n: 48}, exclusivity: {t: 'nonexclusive', n: null}}})],
    ['pvod_second', v('2026-10-01', 'day', 'draft', {end_on: '2026-12-31'})],
    ['est_regular', v('2026-10', 'month', 'draft', {fields: {price_ex_tax: {t: null, n: 2000}}})],
    ['svod_regular', v('2027-01-01', 'day', 'draft', {end_on: '2028-12-31', fields: {price_ex_tax: {t: null, n: 60000}}})],
    ['tvod_regular', v('2026-10-01', 'day', 'withdrawn')],
  ])],
  [2, new Map([
    ['pvod_early', v('2026-10', 'month', 'draft')],
    ['est_regular', v('2026-10-05', 'day', 'confirmed')],
    ['tvod_regular', v('2026', 'year', 'draft')],
  ])],
  [3, new Map([
    ['pvod_early', v('2026-10-15', 'day', 'draft')],
    ['est_regular', v('2026-11-01', 'day', 'confirmed')],
    ['tvod_regular', v('2026-10', 'range', 'draft', {timing_raw: '2026年秋'})],
  ])],
  [4, new Map([
    ['pvod_early', v(null, 'tbd', 'draft', {timing_raw: '未定'})],
    ['est_regular', v('2026-10-20', 'day', 'withdrawn')],
    ['tvod_regular', v('2026-10-10', 'day', 'confirmed')],
  ])],
]);
const windowsOf = (id) => windows.get(id) || new Map();
const codes = (list) => list.map((e) => `${e.work.code}:${e.typeKey}`);

test('月別: 解禁日（日付・月まで）が対象月の窓だけが入り、日付 → 同じ月の「月まで」→ 作品コード → 窓の順に並ぶ', () => {
  const pvod = selectProposalEntries(basisOf('pvod'), {month: '2026-10', works, windowsOf, types: TYPES});
  // 手で並べた順: 10/01 W-B PVOD② → 10/15 W-B PVOD先行・W-C PVOD先行（作品コード順）→ 月まで（2026-10）W-A PVOD先行。W-D は未定なので入らない
  assert.deepEqual(codes(pvod.rows), ['W-B:pvod_second', 'W-B:pvod_early', 'W-C:pvod_early', 'W-A:pvod_early']);
  assert.deepEqual(pvod.undated, [], '未定の窓は「月が決まっていない候補」にも入れない');
  const est = selectProposalEntries(basisOf('est'), {month: '2026-10', works, windowsOf, types: TYPES});
  // W-A 10/05（日付）→ W-B 2026-10（月まで）。W-C は11月、W-D は取り下げ
  assert.deepEqual(codes(est.rows), ['W-A:est_regular', 'W-B:est_regular']);
});

test('月別: 年まで・時期の原文の窓は表に入れず「月が決まっていない候補」になり、取り下げはどこにも入らない', () => {
  const tvod = selectProposalEntries(basisOf('tvod'), {month: '2026-10', works, windowsOf, types: TYPES});
  assert.deepEqual(codes(tvod.rows), ['W-D:tvod_regular'], 'W-B の 10/01 は取り下げ');
  assert.deepEqual(codes(tvod.undated), ['W-A:tvod_regular', 'W-C:tvod_regular'], '年まで（2026）と時期（2026年秋）');
  const other = selectProposalEntries(basisOf('tvod'), {month: '2027-10', works, windowsOf, types: TYPES});
  assert.deepEqual(other.undated, [], '別の年の月には候補を出さない');
});

test('月別: 「確定だけ」にすると予定の窓が消え、件数も同じ決まりで数える', () => {
  const confirmed = selectProposalEntries(basisOf('pvod'), {month: '2026-10', statusMode: 'confirmed', works, windowsOf, types: TYPES});
  assert.deepEqual(codes(confirmed.rows), ['W-B:pvod_early']);
  assert.equal(statusAllowed({status: 'withdrawn'}, 'all'), false);
  // 月ごとの件数（予定＋確定）: PVOD は 2026-10 に4件。EST は 2026-10 に2件・2026-11 に1件
  assert.deepEqual(proposalMonthCounts(basisOf('pvod'), {works, windowsOf}), [{month: '2026-10', count: 4}]);
  assert.deepEqual(proposalMonthCounts(basisOf('est'), {works, windowsOf}), [{month: '2026-10', count: 2}, {month: '2026-11', count: 1}]);
  assert.deepEqual(proposalMonthCounts(basisOf('est'), {works, windowsOf, statusMode: 'confirmed'}), [{month: '2026-10', count: 1}, {month: '2026-11', count: 1}]);
});

test('列: 基準 → 作品の基本 → ほかの窓（案の順）→ 権利 → 作品詳細 → 備考。EST と SVOD は視聴権利時間を出さず、SVOD の価格は月額単価', () => {
  assert.deepEqual(PROPOSAL_BASES.map((b) => b.label), ['PVOD基準', 'TVOD基準', 'TVOD先行基準', 'EST先行基準', 'EST基準']);
  const labels = proposalColumns(basisOf('tvod'), TYPES).map((c) => c.label);
  assert.deepEqual(labels, [
    '基準の種別', '基準の解禁日', '基準の配信期限', '基準の状態',
    '作品コード', '題名', 'フリガナ', '英題', 'ジャンル', '製作年', '尺（分）', 'レーティング', '製作国', '言語', 'コピーライト',
    'PVOD② 解禁日', 'PVOD② 配信期限', 'PVOD② 販売予定価格（税抜）', 'PVOD② 視聴権利時間', 'PVOD② 独占種別',
    'TVOD通常 解禁日', 'TVOD通常 配信期限', 'TVOD通常 販売予定価格（税抜）', 'TVOD通常 視聴権利時間', 'TVOD通常 独占種別',
    'SVOD通常 解禁日', 'SVOD通常 配信期限', 'SVOD通常 月額単価（税抜）', 'SVOD通常 独占種別',
    '権利期限', '配信権',
    'キャッチ', 'あらすじ（短）', 'あらすじ（長）', 'イントロダクション（短）', 'イントロダクション（長）', 'クレジット', '注意事項', '作品情報URL', '画像の参照', '画像のファイル名',
    '備考',
  ]);
  const estEarly = proposalColumns(basisOf('est_early'), TYPES).map((c) => c.label);
  assert.ok(estEarly.includes('EST先行 独占種別') && !estEarly.includes('EST先行 視聴権利時間') && !estEarly.includes('EST通常 視聴権利時間'));
  // 窓のまとまりは PVOD② → EST先行 → EST通常 → TVOD先行 → TVOD通常 → SVOD先行 → SVOD通常
  const groups = [...new Set(proposalColumns(basisOf('tvod_early'), TYPES).filter((c) => c.typeKey).map((c) => c.group))];
  assert.deepEqual(groups, ['PVOD②', 'EST先行', 'EST通常', 'TVOD先行', 'TVOD通常', 'SVOD先行', 'SVOD通常']);
  assert.deepEqual([...new Set(proposalColumns(basisOf('pvod'), TYPES).filter((c) => c.typeKey).map((c) => c.group))],
    ['PVOD先行', 'PVOD②', 'EST先行', 'EST通常', 'TVOD先行', 'TVOD通常', 'SVOD先行', 'SVOD通常']);
  // 使っていない種別のまとまりは出さない
  const without = new Map(TYPES);
  without.set('svod_regular', {...TYPES.get('svod_regular'), active: false});
  assert.ok(!proposalColumns(basisOf('tvod'), without).some((c) => c.group === 'SVOD通常'));
});

test('行: 日付は日付のまま、月までは「2026年10月」、取り下げのほかの窓は空欄、作品情報・権利・クレジットを1つの行に並べる', () => {
  const columns = proposalColumns(basisOf('pvod'), TYPES);
  const [entry] = selectProposalEntries(basisOf('pvod'), {month: '2026-10', works, windowsOf, types: TYPES}).rows.filter((e) => e.typeKey === 'pvod_early');
  const row = proposalRow(entry, columns, {
    windows: windowsOf(1), types: TYPES,
    catalog: {production_year: 2025, catch_short: 'キャッチ（架空）', synopsis_short: '短い（架空）', synopsis_long: null,
      credits: [{role: 'director', name: '監督A（架空）'}, {role: 'cast', name: '出演B（架空）'}, {role: 'cast', name: '出演C（架空）'}, {role: 'staff', name: '撮影D（架空）', detail: '撮影'}],
      editions: [{edition_key: 'main', runtime_seconds: 5430, rating_code: 'G', rating_authority: '映倫', country: ['日本'], language: ['日本語', '英語']}]},
    profile: {title_kana: 'サクヒンビー', title_en: 'Work B', image_key: 'demo/w-b.jpg', image_file_name: 'w-b.jpg'},
    scopes: [{channel: '配信', territory: '日本', rights_start: '2026-01-01', rights_end: '2032-12-31', exclusivity: 'exclusive'}, {channel: '放送', territory: '日本', rights_end: '2040-01-01'}],
  });
  assert.equal(row.basis_type, 'PVOD先行');
  assert.equal(row.basis_start, '2026-10-15');
  assert.equal(row.basis_status, '確定');
  assert.equal(row['pvod_early:field:price_ex_tax'], 2500);
  assert.equal(row['pvod_early:field:exclusivity'], '非独占');
  assert.equal(row['est_regular:start'], '2026年10月');
  assert.equal(row['svod_regular:field:price_ex_tax'], 60000);
  assert.equal(row['tvod_regular:start'], null, '取り下げの窓は出さない');
  assert.equal(row.runtime_minutes, 91, '5430秒 = 90.5分 → 四捨五入で91分');
  assert.equal(row.rating, 'G（映倫）');
  assert.equal(row.languages, '日本語・英語');
  assert.equal(row.credits, '監督: 監督A（架空）／キャスト: 出演B（架空）、出演C（架空）／スタッフ: 撮影 撮影D（架空）');
  assert.equal(row.rights_end, '2032-12-31', '権利期限は配信の権利だけ（放送の権利は見ない）');
  assert.equal(row.rights_scope, '配信・日本・独占（2026/01/01〜2032/12/31）');
  assert.equal(row.image_ref, 'demo/w-b.jpg');
  const empty = emptyColumns(columns, [row]).map((c) => c.label);
  for (const label of ['あらすじ（長）', 'ジャンル', 'コピーライト', '注意事項', '作品情報URL', 'TVOD先行 解禁日']) assert.ok(empty.includes(label), label);
  assert.ok(!empty.includes('題名'));
});

// ---- SVOD ----
// 提案期間 2026-10〜2027-09、提案先 P1。書き下した期待値:
//   S1: P1 と 2026-12-15 に終わる契約 → 継続。提案は 2026-12-16 から、窓（通常・〜2028）で 2027-09 まで → 10か月 × 50,000 = 500,000
//   S2: P1 と 2028 年まで続く契約 → 対象外
//   S3: P1 と契約なし、通常の窓が 2027-04-01 から → 新規。4〜9月の6か月 × 80,000 = 480,000
//   S4: P1 と契約なし、先行の窓 2026-07〜2027-06（単価なし）→ 新規・単価なし（提案は 2026-10〜2027-06 の9か月、金額は空欄）
//   S5: P1 と契約なし、通常の窓 2026-01〜、P2 の独占が 2026-06〜2027-03 → 注意。12か月 × 30,000 = 360,000
//   S6: P1 と 2027-03-31 に終わる契約があり、その後 2027-04-01 からの再契約もある → 対象外（もう更新済み）
//   S7: SVOD の窓が取り下げだけ → 対象外
const svWorks = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].map((code, index) => ({id: index + 11, code, title: `${code}（架空）`}));
const svWindows = {
  11: [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2026-01-01', 'day', 'confirmed', {end_on: '2028-12-31', fields: {price_ex_tax: {n: 50000, t: null}}})}],
  12: [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2026-01-01', 'day', 'confirmed', {end_on: '2028-12-31', fields: {price_ex_tax: {n: 40000, t: null}}})}],
  13: [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2027-04-01', 'day', 'draft', {end_on: '2029-03-31', fields: {price_ex_tax: {n: 80000, t: null}}})}],
  14: [{typeKey: 'svod_early', typeLabel: 'SVOD先行', version: v('2026-07-01', 'day', 'confirmed', {end_on: '2027-06-30', fields: {exclusivity: {t: 'exclusive', n: null}}})}],
  15: [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2026-01-01', 'day', 'confirmed', {end_on: '2029-12-31', fields: {price_ex_tax: {n: 30000, t: null}}})}],
  16: [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2026-01-01', 'day', 'confirmed', {end_on: '2029-12-31', fields: {price_ex_tax: {n: 70000, t: null}}})}],
  17: [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2026-01-01', 'day', 'withdrawn', {end_on: '2029-12-31'})}],
};
const contract = (entry_id, partner_id, work_id, start, end, extra = {}) => ({entry_id, partner_id, partner_name: `取引先${partner_id}（架空）`, work_id, contract_start: start, contract_end: end,
  end_rule: end ? 'date' : 'perpetual', exclusivity: 'nonexclusive', status: 'contracted', settlement_method: 'RS', amount_ex_tax: null, ...extra});
const svContracts = [
  contract(1, 1, 11, '2025-12-16', '2026-12-15'),
  contract(2, 1, 12, '2026-01-01', '2028-06-30'),
  contract(3, 2, 15, '2026-06-01', '2027-03-31', {exclusivity: 'exclusive'}),
  contract(4, 1, 16, '2026-04-01', '2027-03-31'),
  contract(5, 1, 16, '2027-04-01', '2028-03-31', {status: 'planned'}),
];

test('SVOD: 継続・新規・注意の区分と、月額単価×月数の提案金額が書き下した値と一致し、小計と合計は行の和', () => {
  const result = svodProposal({partnerId: 1, from: '2026-10', to: '2027-09', works: svWorks, svodWindowsOf: (id) => svWindows[id] || [], contracts: svContracts});
  const view = result.rows.map((r) => [r.category_label, r.work_code, r.proposal_start, r.proposal_end, r.months, r.unit_price, r.amount]);
  assert.deepEqual(view, [
    ['継続', 'S1', '2026-12-16', '2027-09-30', 10, 50000, 500000],
    ['新規', 'S3', '2027-04-01', '2027-09-30', 6, 80000, 480000],
    ['新規', 'S4', '2026-10-01', '2027-06-30', 9, null, null],
    ['注意', 'S5', '2026-10-01', '2027-09-30', 12, 30000, 360000],
  ]);
  assert.match(result.rows.find((r) => r.work_code === 'S5').blocking, /取引先2（架空） 2026\/06\/01〜2027\/03\/31（独占）/);
  assert.match(result.rows.find((r) => r.work_code === 'S4').note, /月額単価が無い/);
  assert.equal(result.rows.find((r) => r.work_code === 'S1').contract_end, '2026-12-15');
  assert.deepEqual(result.subtotals.renewal, {count: 1, months: 10, amount: 500000, priced: 1});
  assert.deepEqual(result.subtotals.new, {count: 2, months: 15, amount: 480000, priced: 1});
  assert.deepEqual(result.subtotals.caution, {count: 1, months: 12, amount: 360000, priced: 1});
  assert.deepEqual(result.total, {count: 4, months: 37, amount: 1340000, priced: 3});
  assert.equal(result.period.months, 12);
  // Excel の行は区分の後ろに小計の行
  const sheet = svodSheetRows(result);
  assert.deepEqual(sheet.map((r) => r.__kind === 'subtotal' ? `小計:${r.amount}` : r.work_code), ['S1', '小計:500000', 'S3', 'S4', '小計:480000', 'S5', '小計:360000']);
  assert.equal(SVOD_COLUMNS.find((c) => c.key === 'amount').label, '提案金額（税抜）');
});

test('SVOD: 提案先を選ばないと継続は出ず、新規は SVOD の窓だけで決まる（他社の独占は注意）', () => {
  const result = svodProposal({partnerId: null, from: '2026-10', to: '2027-09', works: svWorks, svodWindowsOf: (id) => svWindows[id] || [], contracts: svContracts});
  assert.deepEqual(result.rows.map((r) => `${r.category_label}:${r.work_code}`), ['新規:S1', '新規:S2', '新規:S3', '新規:S4', '新規:S6', '注意:S5']);
  assert.equal(monthsBetween('2026-10', '2027-09'), 12);
  assert.equal(monthsBetween('2027-01', '2027-01'), 1);
});

// ---- 見直しで足した試験 ----
const oneWork = [{id: 21, code: 'R1', title: 'R1（架空）'}];
const regular = (extra = {}) => [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2026-01-01', 'day', 'confirmed', {end_on: '2029-12-31', fields: {price_ex_tax: {n: 50000, t: null}}, ...extra})}];
const svod = (contracts, extra = {}) => svodProposal({partnerId: 1, from: '2026-10', to: '2027-09', works: oneWork, svodWindowsOf: () => regular(), contracts, ...extra});
const cat = (result) => result.rows.map((r) => [r.category_label, r.proposal_start, r.proposal_end, r.months, r.amount]);

test('SVOD の継続: 再契約（renews_entry_id）・同じ日に始まる明細があれば出さず、同じ作品の明細が2つでも1行（遅く終わる方の翌日から）', () => {
  // (a) 再契約元として指された明細は継続にしない（再契約が前の契約の終了日より前に始まっても）
  const renewedEarly = svod([contract(1, 1, 21, '2026-04-01', '2027-03-31'), contract(2, 1, 21, '2027-03-01', '2029-02-28', {renews_entry_id: 1})]);
  assert.deepEqual(renewedEarly.rows, []);
  assert.deepEqual(renewedEarly.subtotals.renewal, {count: 0, months: 0, amount: 0, priced: 0});
  // (b) renews_entry_id が無くても、終了日と同じ日に始まる明細があれば続いているので出さない
  assert.deepEqual(svod([contract(1, 1, 21, '2026-04-01', '2027-03-31'), contract(2, 1, 21, '2027-03-31', '2029-02-28')]).rows, []);
  // (c) 同じ提案先・同じ作品の明細（〜2026-12-31 と 〜2027-03-31）は1行、遅く終わる方の翌日から
  const two = svod([contract(1, 1, 21, '2026-01-01', '2026-12-31', {distribution_code: 'D005'}), contract(2, 1, 21, '2026-04-01', '2027-03-31')]);
  assert.deepEqual(cat(two), [['継続', '2027-04-01', '2027-09-30', 6, 300000]]);
  // (d) 同じ終了日の明細2つも1行
  const same = svod([contract(1, 1, 21, '2026-01-01', '2027-03-31'), contract(2, 1, 21, '2026-02-01', '2027-03-31')]);
  assert.equal(same.rows.length, 1);
  assert.equal(same.subtotals.renewal.count, 1);
  // 終わりの無い明細があれば出さない
  assert.deepEqual(svod([contract(1, 1, 21, '2026-01-01', '2027-03-31'), contract(2, 1, 21, '2027-04-01', null)]).rows, []);
});

test('SVOD: 配信・日本の権利範囲で提案の期間を狭め、期間の前に権利が切れた作品は注意（0か月・金額は空欄）にする', () => {
  const none = (scopes) => svodProposal({partnerId: null, from: '2026-10', to: '2027-09', works: oneWork, svodWindowsOf: () => regular(), contracts: [], rightsOf: () => scopes});
  // (a) 2026-12-31 まで → 3か月・150,000
  const a = none([{channel: '配信', territory: '日本', rights_start: '2024-01-01', rights_end: '2026-12-31'}]);
  assert.deepEqual(cat(a), [['新規', '2026-10-01', '2026-12-31', 3, 150000]]);
  assert.match(a.rows[0].note, /権利期限 2026\/12\/31 で終了日を狭めた/);
  assert.equal(a.total.amount, 150000);
  // (b) 2025-12-31 で切れている → 注意・0か月・金額は空欄
  const b = none([{channel: '配信', territory: '日本', rights_start: '2024-01-01', rights_end: '2025-12-31'}]);
  assert.deepEqual(cat(b), [['注意', null, null, 0, null]]);
  assert.match(b.rows[0].note, /権利期限 2025\/12\/31 を過ぎている/);
  assert.deepEqual(b.subtotals.caution, {count: 1, months: 0, amount: 0, priced: 0});
  // (c) 終了日の無い範囲と 2026-12-31 の範囲の2件 → 狭めない
  assert.deepEqual(cat(none([{channel: '配信', territory: '日本', rights_end: null}, {channel: '配信', territory: '日本', rights_end: '2026-12-31'}])), [['新規', '2026-10-01', '2027-09-30', 12, 600000]]);
  // (d) 放送の権利だけが切れる → 狭めない
  assert.deepEqual(cat(none([{channel: '放送', territory: '日本', rights_end: '2026-12-31'}])), [['新規', '2026-10-01', '2027-09-30', 12, 600000]]);
  // (e) 権利が無い → 狭めない
  assert.deepEqual(cat(none([])), [['新規', '2026-10-01', '2027-09-30', 12, 600000]]);
});

test('SVOD: 確定だけで予定の窓が除かれた継続の行は「予定のみ」と書き、窓そのものが無い行と分ける', () => {
  const works2 = [{id: 31, code: 'A', title: 'A（架空）'}, {id: 32, code: 'B', title: 'B（架空）'}];
  const windowsOf2 = (id) => (id === 31 ? [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version: v('2026-01-01', 'day', 'draft', {end_on: '2029-12-31', fields: {price_ex_tax: {n: 10000, t: null}}})}] : []);
  const contracts2 = [contract(1, 1, 31, '2026-01-01', '2026-12-31'), contract(2, 1, 32, '2026-01-01', '2026-12-31')];
  const confirmed = svodProposal({partnerId: 1, from: '2026-10', to: '2027-09', statusMode: 'confirmed', works: works2, svodWindowsOf: windowsOf2, contracts: contracts2});
  const a = confirmed.rows.find((r) => r.work_code === 'A'), b = confirmed.rows.find((r) => r.work_code === 'B');
  assert.deepEqual([a.category, a.window_type, a.amount, a.note], ['renewal', null, null, 'SVOD のウィンドウは予定のみ（確定だけの条件で除外）']);
  assert.equal(b.note, '期間に重なる SVOD のウィンドウが無い');
  const all = svodProposal({partnerId: 1, from: '2026-10', to: '2027-09', works: works2, svodWindowsOf: windowsOf2, contracts: contracts2}).rows.find((r) => r.work_code === 'A');
  assert.match(all.note, /SVOD のウィンドウは予定/);
  assert.equal(all.amount, 10000 * 9);
});

test('SVOD: 年まで・月まで・時期のウィンドウは備考に精度を書き、年までは1月1日から数える。取引方法は取引先別リストと同じ表示名', () => {
  const run = (version) => svodProposal({partnerId: null, from: '2026-10', to: '2027-09', works: oneWork, svodWindowsOf: () => [{typeKey: 'svod_regular', typeLabel: 'SVOD通常', version}], contracts: []}).rows;
  const year = run(v('2027', 'year', 'confirmed', {fields: {price_ex_tax: {n: 50000, t: null}}}));
  assert.deepEqual([year[0].proposal_start, year[0].months, year[0].amount], ['2027-01-01', 9, 450000]);
  assert.match(year[0].note, /年まで/);
  const range = run(v('2027-04', 'range', 'confirmed', {timing_raw: '2027年春', fields: {price_ex_tax: {n: 50000, t: null}}}));
  assert.match(range[0].note, /時期のみ（2027年春）/);
  const month = run(v('2027-03', 'month', 'confirmed', {fields: {price_ex_tax: {n: 50000, t: null}}}));
  assert.match(month[0].note, /月まで/);
  assert.equal(month[0].months, 7);
  assert.equal(run(v('2027-03-20', 'day', 'confirmed', {fields: {price_ex_tax: {n: 50000, t: null}}}))[0].months, 7, '日付 2027-03-20 の窓と同じ月数');
  assert.deepEqual(run(v(null, 'range', 'confirmed', {timing_raw: '2027年中'})), [], '月の無い時期の窓は行にならない');
  // 取引方法
  const methods = ['unverified', 'other', 'RS'].map((method, k) => contract(k + 1, 1, 41 + k, '2026-01-01', '2026-12-31', {settlement_method: method}));
  const three = svodProposal({partnerId: 1, from: '2026-10', to: '2027-09', works: [41, 42, 43].map((id) => ({id, code: `M${id}`, title: 'M（架空）'})), svodWindowsOf: () => regular(), contracts: methods});
  assert.deepEqual(three.rows.map((r) => r.contract_method), ['未確認', 'その他', 'RS']);
  assert.deepEqual(svodSheetRows(three).filter((r) => !r.__kind).map((r) => r.contract_method), ['未確認', 'その他', 'RS']);
});

test('月別: 時期の原文のウィンドウは、最も早い月の年から原文に書かれた最も遅い年までの月に「月が決まっていない候補」として出す', () => {
  const w = [{id: 51, code: 'Y1', title: 'Y1（架空）'}, {id: 52, code: 'Y2', title: 'Y2（架空）'}];
  const byWork = new Map([[51, new Map([['tvod_regular', v('2026-12', 'range', 'draft', {timing_raw: '2026年12月〜2027年3月'})]])], [52, new Map([['tvod_regular', v(null, 'range', 'draft', {timing_raw: '2027年内'})]])]]);
  const undated = (month) => selectProposalEntries(basisOf('tvod'), {month, works: w, windowsOf: (id) => byWork.get(id), types: TYPES}).undated.map((e) => e.work.code);
  assert.deepEqual(undated('2026-10'), ['Y1']);
  assert.deepEqual(undated('2027-02'), ['Y1', 'Y2']);
  assert.deepEqual(undated('2028-01'), []);
  assert.deepEqual(rangeYearSpan({timing_raw: '2026年12月〜2028年3月', start_on: '2026-12'}), [2026, 2028]);
  // 既存の「2026年秋」は 2027 年の月に出ない
  const autumn = selectProposalEntries(basisOf('tvod'), {month: '2027-10', works, windowsOf, types: TYPES});
  assert.deepEqual(autumn.undated, []);
});

test('月別: 年度・年度の上期／下期・年度末・四半期・年を1つだけ書いた月の範囲・冬の原文は、翌年にかかる月の「月が決まっていない候補」にも出す', () => {
  // 読める月の幅（手で書き下した値。年度は4月始まり）
  const spans = {
    '2026年度': ['2026-04', '2027-03'], '2026年度上期': ['2026-04', '2026-09'], '2026年度下期': ['2026-10', '2027-03'], '2026年度下半期': ['2026-10', '2027-03'],
    '2026年度末': ['2027-03', '2027-03'], '2026年度第1四半期': ['2026-04', '2026-06'], '2026年度第2四半期': ['2026-07', '2026-09'],
    '2026年度第3四半期': ['2026-10', '2026-12'], '2026年度第4四半期': ['2027-01', '2027-03'], '2026年度第3〜4四半期': ['2026-10', '2027-03'],
    '2026年12月〜3月': ['2026-12', '2027-03'], '2026年12〜3月': ['2026-12', '2027-03'], '2026年12月〜2027年3月': ['2026-12', '2027-03'], '2026年1〜3月': ['2026-01', '2026-03'],
    '2026年冬': ['2026-12', '2027-02'], '２０２６年　冬': ['2026-12', '2027-02'],
  };
  for (const [text, span] of Object.entries(spans)) assert.deepEqual(timingMonthSpans(text), [span], text);
  // 読まない書き方（年の幅だけで見る・候補に出ない）
  for (const text of ['2026年秋', '2026年末〜翌年初', '2027年4月以降', '令和8年度', '来年春', '未定']) assert.equal(timingMonthSpans(text), null, text);

  const texts = ['2026年度', '2026年度上期', '2026年度下期', '2026年度末', '2026年度第1四半期', '2026年度第4四半期', '2026年12月〜3月', '2026年冬', '2026年末〜翌年初', '令和8年度'];
  const w = texts.map((text, index) => ({id: 70 + index, code: `F${String(index).padStart(2, '0')}`, title: `${text}（架空）`}));
  // 入力と同じ読み方（parseWindowDate）で版を作る。start_on は最も早い月（読めない原文は null）
  const byWork = new Map(w.map((work, index) => {
    const parsed = parseWindowDate(texts[index]);
    assert.equal(parsed.precision, 'range', texts[index]);
    return [work.id, new Map([['tvod_regular', v(parsed.value, 'range', 'draft', {timing_raw: parsed.raw})]])];
  }));
  const undated = (month) => selectProposalEntries(basisOf('tvod'), {month, works: w, windowsOf: (id) => byWork.get(id), types: TYPES}).undated.map((e) => e.version.timing_raw);
  // 2026年の月は、原文に書かれた年（2026）で前からどれも出る（令和8年度は4桁の年が無いのでどの月にも出ない）
  assert.deepEqual(undated('2026-05'), texts.slice(0, 9));
  // 翌年の月: 月の幅が 2027年にかかる原文だけ
  assert.deepEqual(undated('2027-01'), ['2026年度', '2026年度下期', '2026年度第4四半期', '2026年12月〜3月', '2026年冬']);
  assert.deepEqual(undated('2027-02'), ['2026年度', '2026年度下期', '2026年度第4四半期', '2026年12月〜3月', '2026年冬']);
  assert.deepEqual(undated('2027-03'), ['2026年度', '2026年度下期', '2026年度末', '2026年度第4四半期', '2026年12月〜3月']);
  assert.deepEqual(undated('2027-04'), [], '年度の次の月には出さない');
  assert.equal(rangeCoversMonth({timing_raw: '2026年末〜翌年初', start_on: '2026-12'}, '2027-01'), false, '「年末」「年初」は月の幅を読まない（2027年の月には出ない）');
});

// 入力と同じ読み方（parseWindowDate）で時期の原文の版を作り、その月の「月が決まっていない候補」に出た作品の原文（texts の文字のまま）を返す
function undatedOf(texts, firstId) {
  const w = texts.map((text, index) => ({id: firstId + index, code: `T${String(index).padStart(2, '0')}`, title: `${text}（架空）`}));
  const byWork = new Map(w.map((work, index) => {
    const parsed = parseWindowDate(texts[index]);
    assert.equal(parsed.precision, 'range', texts[index]);
    return [work.id, new Map([['tvod_regular', v(parsed.value, 'range', 'draft', {timing_raw: parsed.raw})]])];
  }));
  return (month) => selectProposalEntries(basisOf('tvod'), {month, works: w, windowsOf: (id) => byWork.get(id), types: TYPES}).undated.map((e) => texts[e.work.id - firstId]);
}

test('月別: 年度の四半期の範囲（「第3四半期〜第4四半期」「第3四半期から第4四半期」）は全部の月、並び（「第2四半期・第4四半期」）はそれぞれの四半期の月の候補に出す', () => {
  // 後ろの四半期にも「四半期」を付けた書き方（前は最初の四半期しか読まなかった）
  const spans = {
    '2026年度第3四半期〜第4四半期': [['2026-10', '2027-03']], '2026年度第3四半期から第4四半期': [['2026-10', '2027-03']],
    '2026年度第3〜第4四半期': [['2026-10', '2027-03']], '2026年度Q3〜Q4': [['2026-10', '2027-03']], '2026年度第1四半期〜第2四半期': [['2026-04', '2026-09']],
    '2026年度第2四半期・第4四半期': [['2026-07', '2026-09'], ['2027-01', '2027-03']], '2026年度第2・4四半期': [['2026-07', '2026-09'], ['2027-01', '2027-03']],
    '2026年度第1四半期と第3四半期': [['2026-04', '2026-06'], ['2026-10', '2026-12']],
    '2026年度第1〜2四半期・第4四半期': [['2026-04', '2026-09'], ['2027-01', '2027-03']],
    // 区切りの後ろに同じ年度をもう一度書いた原文（前の版ではQ表記が年度全体に落ち、この版の途中では最初の四半期だけになっていた）
    '2026年度第3四半期〜2026年度第4四半期': [['2026-10', '2027-03']], '2026年度Q3〜2026年度Q4': [['2026-10', '2027-03']],
    '2026年度第2四半期・2026年度第4四半期': [['2026-07', '2026-09'], ['2027-01', '2027-03']],
  };
  for (const [text, span] of Object.entries(spans)) assert.deepEqual(timingMonthSpans(text), span, text);
  // 前からの書き方は変わらない
  assert.deepEqual(timingMonthSpans('2026年度第3〜4四半期'), [['2026-10', '2027-03']]);
  assert.deepEqual(timingMonthSpans('2026年度第4四半期'), [['2027-01', '2027-03']]);

  const texts = ['2026年度第3四半期〜第4四半期', '2026年度第3四半期から第4四半期', '2026年度第2四半期・第4四半期', '2026年度第1四半期・第3四半期'];
  const undated = undatedOf(texts, 90);
  // 翌年の1〜3月（第4四半期）には、範囲と、第4四半期を並べた原文が出る。第1・第3四半期だけの並びは出ない
  for (const month of ['2027-01', '2027-02', '2027-03']) assert.deepEqual(undated(month), texts.slice(0, 3), month);
  assert.deepEqual(undated('2027-04'), [], '年度の次の月には出さない');
  // 2026年の月は、原文に書かれた年（2026）でどれも出る（前からの決まり）
  assert.deepEqual(undated('2026-08'), texts);
});

test('月別: 年を1つだけ書いた月・季節の範囲（「翌3月」「下旬」「1日〜31日」「2026/12」、区切り —・―・～・-、「秋〜翌春」）も翌年の月の候補に出す', () => {
  const decToMar = ['2026年12月〜翌3月', '2026年12月〜翌年3月', '2026年12月下旬〜3月', '2026年12月1日〜3月31日', '2026/12〜3月', '2026-12〜3月',
    '2026年12月—3月', '2026年12月―3月', '2026年12月～3月', '2026年12月-3月', '2026年12月－3月', '2026年12—3月', '2026年12月から3月'];
  for (const text of decToMar) assert.deepEqual(timingMonthSpans(text), [['2026-12', '2027-03']], text);
  const spans = {
    '2026年12月中旬〜2月上旬': [['2026-12', '2027-02']], '2026年10月〜翌年2月': [['2026-10', '2027-02']], '2026年3月〜翌3月': [['2026-03', '2027-03']],
    // 季節は 春=3〜5月・夏=6〜8月・秋=9〜11月・冬=12〜翌2月。終わりに「翌」が無くても、始まりより前の季節は翌年
    '2026年秋〜翌春': [['2026-09', '2027-05']], '2026年秋〜春': [['2026-09', '2027-05']], '2026年夏〜冬': [['2026-06', '2027-02']],
    '2026年春〜夏': [['2026-03', '2026-08']], '2026年12月〜春': [['2026-12', '2027-05']], '2026年冬〜翌春': [['2026-12', '2027-05']],
  };
  for (const [text, span] of Object.entries(spans)) assert.deepEqual(timingMonthSpans(text), span, text);
  // 読まない書き方（sales-proposals.md §1 の表。年の幅だけで見る）
  for (const text of ['2026年12月〜来年3月', '2026年12月〜翌年', '2026年12月1日〜3日', '2026年12月〜2025年3月', '2026年12月以降']) assert.equal(timingMonthSpans(text), null, text);
  // 入力の読み方（parseWindowDate）の最も早い月も、区切りが —・―・から のときに前の月を読む（前は後ろの「3月」を読んでいた）
  assert.equal(parseWindowDate('2026年12—3月').value, '2026-12');
  assert.equal(parseWindowDate('2026年1から3月').value, '2026-01');
  assert.equal(parseWindowDate('2026年秋〜翌春').value, '2026-09');

  const texts = ['2026年12月〜翌3月', '2026年12月下旬〜3月', '2026年12月中旬〜2月上旬', '2026年12月1日〜3月31日', '2026/12〜3月',
    '2026年12月—3月', '2026年12月―3月', '2026年12月～3月', '2026年12月-3月', '2026年秋〜翌春'];
  const undated = undatedOf(texts, 110);
  assert.deepEqual(undated('2027-02'), texts);
  assert.deepEqual(undated('2027-03'), texts.filter((text) => text !== '2026年12月中旬〜2月上旬'), '2月上旬までの原文は3月に出ない');
  assert.deepEqual(undated('2027-05'), ['2026年秋〜翌春']);
  assert.deepEqual(undated('2027-06'), []);
});

test('月別: 状態の条件はほかのウィンドウの列にも当てる（確定だけなら予定のウィンドウは空欄、予定＋確定なら備考に書く）', () => {
  const columns = proposalColumns(basisOf('pvod'), TYPES);
  const [entry] = selectProposalEntries(basisOf('pvod'), {month: '2026-10', works, windowsOf, types: TYPES}).rows.filter((e) => e.typeKey === 'pvod_early' && e.work.id === 1);
  const confirmed = proposalRow(entry, columns, {windows: windowsOf(1), types: TYPES}, 'confirmed');
  assert.deepEqual([confirmed['svod_regular:field:price_ex_tax'], confirmed['est_regular:start'], confirmed['pvod_second:start'], confirmed['pvod_early:field:price_ex_tax']], [null, null, null, 2500]);
  assert.match(confirmed.note, /予定のウィンドウは出していません（PVOD②・EST通常・SVOD通常）/);
  const all = proposalRow(entry, columns, {windows: windowsOf(1), types: TYPES}, 'all');
  assert.deepEqual([all['svod_regular:field:price_ex_tax'], all['est_regular:start']], [60000, '2026年10月']);
  assert.match(all.note, /予定のウィンドウ: PVOD②・EST通常・SVOD通常/);
});

test('用語: 提案資料の見出し・区分・備考に「窓」を使わない（ウィンドウ。委員会の「窓口」とは別の語）', () => {
  for (const basis of PROPOSAL_BASES) for (const column of proposalColumns(basis, TYPES)) {
    for (const text of [column.group, column.part, column.label]) assert.doesNotMatch(String(text ?? ''), /窓(?!口)/, `${basis.key}: ${text}`);
  }
  for (const column of SVOD_COLUMNS) assert.doesNotMatch(column.label, /窓(?!口)/);
  const result = svodProposal({partnerId: 1, from: '2026-10', to: '2027-09', works: svWorks, svodWindowsOf: (id) => svWindows[id] || [], contracts: svContracts});
  for (const row of result.rows) assert.doesNotMatch(String(row.note ?? ''), /窓(?!口)/);
});

test('SVOD の提案期間の入力: 開始月を終了月より後にすると終了月を消し、60か月を超える終了月は切り詰め、打ちかけの年は書かない', () => {
  assert.deepEqual(nextSvodPeriod({from: '2026-10', to: '2027-09'}, 'from', '2027-12'), {from: '2027-12', to: null});
  assert.deepEqual(nextSvodPeriod({from: '2026-10', to: '2027-09'}, 'to', '2032-01'), {from: '2026-10', to: '2031-09'});
  assert.deepEqual(nextSvodPeriod({from: '2026-10', to: '2027-09'}, 'to', '2026-05'), {from: '2026-10', to: null});
  assert.deepEqual(nextSvodPeriod({from: '2026-10', to: '2027-09'}, 'from', '0002-09'), {from: '2026-10', to: '2027-09'});
  assert.deepEqual(nextSvodPeriod({from: '2026-10', to: '2027-09'}, 'to', '2028-03'), {from: '2026-10', to: '2028-03'});
  assert.equal(shiftMonth('0002-10', 59), '0007-09');
});
