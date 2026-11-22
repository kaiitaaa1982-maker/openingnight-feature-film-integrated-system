// 制作の実費の画面の論理（src/expenses/production-actual/actual-sheet-model.mjs）と、その本文が受け口でそのまま通ることを確かめる。
// 期待値は会社ルートの plans/2026-11-20-genba-inbox.md の手順 14b と要件 docs/requirements/expenses/production-cost.md の
// FR-EXP-PCOST-048〜052 から手で書いた（合計は試験の中で手で足す）。ON_TEST_DB=pg で受け口の試験が PostgreSQL で流れる。
// 架空のデータだけを使う（組織1と利用者・案件1は試作の行。作品は試験の中で足す。店名は架空）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {sheetColumns, sheetCellText} from '../src/ui/edit-sheet-model.mjs';
import {buildActualLinesView} from '../src/expenses/production-actual/actual-lines-model.mjs';
import {hiddenPagesForRole, slugOf} from '../src/shell/nav-model.mjs';
import {folderOf} from '../src/shell/folder-nav.mjs';
import {CATEGORY_OPTIONS, checkTargets, detailColumns, detailRow, detailRows, draftReady, draftRow, failureText, headline, lineFromDraft, lineIdOfKey, selectionFromSheet,
  planDetailChange, summaryColumns, summaryRows, voidTargets} from '../src/expenses/production-actual/actual-sheet-model.mjs';

// 受け口の GET が返す形の行（架空）
const line = (id, overrides = {}) => ({id, entryKey: `k${id}`, spentOn: '2026-11-19', categoryCode: 'H', categoryName: 'ロケーション費', payeePartnerId: null,
  payeeName: '架空弁当店', description: '昼 18食', incTaxYen: 16200, exTaxYen: 15000, taxYen: 1200, taxUnknown: false, sourceDocumentId: null, shootingDayId: null,
  entryMethod: 'human', aiRead: null, createdBy: 1, createdAt: '2026-11-19 10:00:00', replaces: null, check: null, unconfirmed: true, ...overrides});
const LINES = [
  line(11, {spentOn: '2026-11-18', payeePartnerId: 3, payeeName: '架空駐車場', categoryCode: 'K', categoryName: 'プリント・制作諸費', description: null, incTaxYen: 2100,
    exTaxYen: null, taxYen: null, taxUnknown: true, sourceDocumentId: 7, entryMethod: 'ai', unconfirmed: false, check: {checkedBy: 1, checkedAt: '2026-11-18 20:00:00'}}),
  line(12),
  line(13, {payeeName: '架空交通', categoryCode: 'H', incTaxYen: 4180, exTaxYen: 3800, taxYen: 380}),
];
const cell = (key, field, after, before = '') => ({type: 'cell', key, field, before, after});

test('FR-EXP-PCOST-049 明細の行: 受け口の行を 日付・支払先・費目・内容・金額・税抜・証憑・入れ方・札 の行にし、直せるのは日付・支払先・費目・内容・金額だけ', () => {
  assert.deepEqual(detailRow(LINES[0]), {id: 'line:11', lineId: 11, d: '2026-11-18', payee: '架空駐車場', category: 'K', memo: '', amount: 2100, exTax: null, receipt: '有',
    method: 'AI', mark: '確認済'});
  assert.deepEqual(detailRow(LINES[1]).mark, '未確認');
  const columns = sheetColumns(detailColumns({year: 2026}));
  assert.deepEqual(columns.map((column) => column.label), ['日付', '支払先', '費目', '内容', '金額', '税抜', '証憑', '入れ方', '札']);
  assert.deepEqual(columns.filter((column) => column.editable).map((column) => column.key), ['d', 'payee', 'category', 'memo', 'amount']);
  // 費目は A〜K の候補から選ぶ（表示は名前）。税抜が分からない行は「不明」、分かる行は桁区切り。合計の行に税抜は足さない
  assert.deepEqual(CATEGORY_OPTIONS.map((option) => option.value), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
  const [unknown, known] = detailRows(LINES);
  assert.deepEqual([sheetCellText(byKey.category, unknown), sheetCellText(byKey.exTax, unknown), sheetCellText(byKey.exTax, known)], ['プリント・制作諸費', '不明', '15,000']);
  assert.deepEqual([byKey.amount.total, byKey.exTax.total], ['sum', 'none']);
  // 書けない人は全部の列が読むだけ
  assert.deepEqual(sheetColumns(detailColumns({year: 2026}), {readOnly: true}).filter((column) => column.editable), []);
  // 行の鍵から保存した行の番号を読む（下書き・知らない形は null）。部品の選択（onSelect）を確認・取消の対象の形にする
  assert.deepEqual(['line:12', 'line:7', 'new:3', 'line:0', 'line:x1', '12', null].map(lineIdOfKey), [12, 7, null, null, null, null, null]);
  assert.deepEqual(selectionFromSheet({sheet: 'detail', range: true, rowKeys: ['line:12', 'new:1'], visibleKeys: ['line:11', 'line:12', 'new:1']}),
    {range: true, selected: [12], visible: [11, 12]});
  assert.deepEqual(selectionFromSheet(), {range: false, selected: [], visible: []});
});

test('FR-EXP-PCOST-049 下書きの行: 日付・支払先・費目・金額がそろうまでは送らず「未保存」、そろった行だけを人の行として足す（50行ずつ）', () => {
  const draft = {...draftRow(1), d: '2026-11-20', payee: '架空商店'};
  assert.equal(draftRow(1).mark, '未保存');
  assert.equal(draftReady(draft), false);
  // そろっていない: 送らず下書きのまま
  let plan = planDetailChange({edits: [cell('new:1', 'payee', '架空商店')], rows: [...detailRows(LINES), draft], lines: LINES});
  assert.deepEqual([plan.posts, plan.voids, plan.drafts.map((row) => row.id)], [[], [], ['new:1']]);
  // 費目と金額が入ってそろった: 1回の POST に1行
  const full = {...draft, category: 'H', amount: 3300, memo: ' 果物 '};
  plan = planDetailChange({edits: [cell('new:1', 'amount', 3300)], rows: [...detailRows(LINES), full], lines: LINES});
  assert.deepEqual(plan.posts, [{keys: ['new:1'], lines: [{spentOn: '2026-11-20', payeeName: '架空商店', categoryCode: 'H', description: '果物', incTaxYen: 3300, entryMethod: 'human'}]}]);
  assert.deepEqual(lineFromDraft({...full, memo: ''}).description, null);
  // Excel から 51 行を貼った: そろった行を 50 行と 1 行の2回に分ける。そろわない行は下書きに残る
  const pasted = Array.from({length: 52}, (_, i) => ({...draftRow(100 + i), d: '2026-11-20', payee: `架空店${i}`, category: 'K', amount: i === 51 ? null : 1000 + i}));
  plan = planDetailChange({edits: pasted.map((row, index) => ({type: 'insert', index, key: row.id, row})), action: 'paste', rows: pasted, lines: []});
  assert.deepEqual(plan.posts.map((post) => post.lines.length), [50, 1]);
  assert.equal(plan.posts[1].keys[0], 'new:150');
  assert.deepEqual(plan.drafts.filter((row) => !draftReady(row)).map((row) => row.id), ['new:151']);
  // 断られて残った下書き（full）は、ほかの下書きをさわったときに一緒に送り直す。保存した行だけを直したときは送らない
  plan = planDetailChange({edits: [cell('new:2', 'payee', '架空')], rows: [full, {...draftRow(2), payee: '架空'}], lines: []});
  assert.deepEqual(plan.posts.map((post) => post.keys), [['new:1']]);
  plan = planDetailChange({edits: [cell('line:12', 'memo', '夜', '昼 18食')], rows: [...detailRows(LINES).map((row) => (row.id === 'line:12' ? {...row, memo: '夜'} : row)), full], lines: LINES});
  assert.deepEqual([plan.posts, plan.voids.map((item) => item.lineId)], [[], [12]]);
  // 全部の欄を空にした下書きは捨てる
  plan = planDetailChange({edits: [cell('new:2', 'payee', '', '架空')], rows: [draftRow(2)], lines: []});
  assert.deepEqual(plan.drafts, []);
});

test('FR-EXP-PCOST-049 保存した行を直すと、理由「表で直した: 列名」の取消と置き換えの行（人の行）になる。必須の欄を空にする・戻すでは送らない', () => {
  const rows = detailRows(LINES);
  const edited = (key, field, value) => rows.map((row) => (row.id === key ? {...row, [field]: value} : row));
  // 金額を直した: 元の税抜・税額は合わないので不明に戻す。取引先・証憑・撮影日は元の行のまま
  let plan = planDetailChange({edits: [cell('line:11', 'amount', 2400, 2100)], rows: edited('line:11', 'amount', 2400), lines: LINES});
  assert.deepEqual(plan.voids, [{key: 'line:11', lineId: 11, body: {reason: '表で直した: 金額', replacement: {spentOn: '2026-11-18', payeeName: '架空駐車場', categoryCode: 'K',
    description: null, incTaxYen: 2400, payeePartnerId: 3, exTaxYen: null, taxYen: null, sourceDocumentId: 7, shootingDayId: null, entryMethod: 'human'}}}]);
  // 支払先を直した: 取引先の結び付きを外す。税抜・税額は元のまま
  plan = planDetailChange({edits: [cell('line:13', 'payee', '架空タクシー', '架空交通'), cell('line:13', 'memo', '駅から', '昼 18食')],
    rows: edited('line:13', 'payee', '架空タクシー').map((row) => (row.id === 'line:13' ? {...row, memo: '駅から'} : row)), lines: LINES});
  assert.deepEqual(plan.voids.map((item) => [item.lineId, item.body.reason, item.body.replacement.payeeName, item.body.replacement.payeePartnerId,
    item.body.replacement.exTaxYen, item.body.replacement.taxYen]), [[13, '表で直した: 支払先・内容', '架空タクシー', null, 3800, 380]]);
  // 必須の欄を空にした: 送らずに理由を返す
  plan = planDetailChange({edits: [cell('line:12', 'amount', null, 16200)], action: 'clear', rows: edited('line:12', 'amount', null), lines: LINES});
  assert.deepEqual([plan.voids, plan.errors], [[], [{key: 'line:12', message: '金額は空にできません（行ごと消すときは「行を消す」）'}]]);
  // 戻す（部品の undo）は保存した行に何も送らない（記録は追記だけ）。保存した 2400 を表の履歴の 2100 へ戻しても送らない
  const savedAt2400 = LINES.map((row) => (row.id === 11 ? {...row, incTaxYen: 2400} : row));
  plan = planDetailChange({edits: [cell('line:11', 'amount', 2100, 2400)], action: 'undo', rows, lines: savedAt2400});
  assert.deepEqual([plan.voids, plan.posts, plan.errors], [[], [], []]);
  // 同じ変更でも戻すでなければ取消と置き換えになる（上の確かめが空振りでない）
  assert.equal(planDetailChange({edits: [cell('line:11', 'amount', 2100, 2400)], rows, lines: savedAt2400}).voids.length, 1);
  // 同じ値に直した（打ち直しても変わらない）ときは送らない
  plan = planDetailChange({edits: [cell('line:12', 'memo', '昼 18食', '昼 18食')], rows, lines: LINES});
  assert.deepEqual(plan.voids, []);
});

test('FR-EXP-PCOST-050 確認と取消の対象: 範囲を選べば選んだ行の未確認、選ばなければ見えている未確認の行すべて。件数と税込の合計を添え、200件ずつに分ける', () => {
  // 範囲を選んでいる: 選んだ 11（確認済み）・12 のうち未確認の 12 だけ
  assert.deepEqual(checkTargets({lines: LINES, selection: {range: true, selected: [11, 12], visible: [11, 12, 13]}}),
    {lineIds: [12], count: 1, incTaxYen: 16200, batches: [[12]]});
  // セル1つ（選んでいない）: 見えている行（絞り込んだ後）の未確認すべて
  assert.deepEqual(checkTargets({lines: LINES, selection: {range: false, selected: [11], visible: [12, 13]}}),
    {lineIds: [12, 13], count: 2, incTaxYen: 16200 + 4180, batches: [[12, 13]]});
  assert.deepEqual(checkTargets({lines: LINES, selection: {range: false, selected: [], visible: [11]}}).count, 0);
  const many = Array.from({length: 201}, (_, i) => line(1000 + i, {incTaxYen: 100}));
  const big = checkTargets({lines: many, selection: {range: false, visible: many.map((row) => row.id)}});
  assert.deepEqual([big.count, big.incTaxYen, big.batches.map((batch) => batch.length)], [201, 20100, [200, 1]]);
  // 取消は選んだ行（セル1つならその行）。確認済みも取り消せる。知らない番号は入れない
  assert.deepEqual(voidTargets({lines: LINES, selection: {range: false, selected: [11, 99]}}), {lineIds: [11], count: 1, incTaxYen: 2100});
});

test('FR-EXP-PCOST-051 集計のシートは受け口の合計（日別・支払先別・費目別）をそのまま使い、金額の和が明細の税込の和と一致する。上の1行は未確認の数・累計・今日', () => {
  const raw = (id, spentOn, partner, name, code, inc, ex, checked) => ({id, entry_key: `k${id}`, spent_on: spentOn, category_code: code, payee_partner_id: partner,
    payee_name: name, description: null, inc_tax_yen: inc, ex_tax_yen: ex, tax_yen: ex === null ? null : inc - ex, source_document_id: null, shooting_day_id: null,
    entry_method: 'human', ai_read_json: null, created_by: 1, created_at: '2026-11-19 10:00:00', checked});
  const rows = [raw(1, '2026-11-18', null, '架空弁当店', 'H', 30600, null, true), raw(2, '2026-11-19', null, '架空弁当店', 'H', 16200, 15000, false),
    raw(3, '2026-11-19', 3, '架空駐車場', 'K', 2400, 2200, false), raw(4, '2026-11-19', 3, '架空駐車場（東町）', 'K', 1800, null, false)];
  const view = buildActualLinesView({lines: rows, voids: [], checks: rows.filter((row) => row.checked).map((row) => ({line_id: row.id, checked_by: 1, checked_at: 'x'})),
    today: '2026-11-19'});
  const total = 30600 + 16200 + 2400 + 1800;
  const byDay = summaryRows(view.totals, 'byDay');
  assert.deepEqual(byDay.map((row) => [row.key, row.count, row.amount, row.unconfirmed]), [['2026-11-18', 1, 30600, 0], ['2026-11-19', 3, 20400, 3]]);
  const byPayee = summaryRows(view.totals, 'byPayee');
  assert.deepEqual(byPayee.map((row) => [row.key, row.count, row.amount]), [['架空弁当店', 2, 46800], ['架空駐車場・架空駐車場（東町）', 2, 4200]]);
  const byCategory = summaryRows(view.totals, 'byCategory');
  assert.deepEqual(byCategory.map((row) => [row.key, row.amount]), [['ロケーション費', 46800], ['プリント・制作諸費', 4200]]);
  for (const list of [byDay, byPayee, byCategory]) {
    assert.equal(list.reduce((sum, row) => sum + row.amount, 0), total);
    assert.equal(list.reduce((sum, row) => sum + row.count, 0), 4);
  }
  assert.equal(byCategory[0].share, 46800 / total);
  assert.deepEqual(summaryRows({all: {incTaxYen: 0}, byDay: []}, 'byDay'), []);
  assert.deepEqual(sheetColumns(summaryColumns('byPayee')).map((column) => [column.label, column.type, column.total]),
    [['支払先', 'text', 'none'], ['件数', 'int', 'sum'], ['金額', 'yen', 'sum'], ['構成比', 'rate', 'none'], ['未確認', 'int', 'sum']]);
  assert.deepEqual(summaryColumns('byDay', {year: 2026})[0], {key: 'key', label: '日', type: 'date', year: 2026, width: 120});
  assert.deepEqual(headline(view), {unconfirmed: 3, cumulative: total, confirmed: 30600, pending: 16200 + 2400 + 1800, today: 16200 + 2400 + 1800, count: 4});
  assert.deepEqual(headline(null), {unconfirmed: 0, cumulative: 0, confirmed: 0, pending: 0, today: 0, count: 0});
  // 断られた理由は、受け口の文と行ごとの最初の理由を1行にする
  assert.equal(failureText({message: '実費の行の入力を確かめてください', details: [{line: 0, field: 'incTaxYen', message: '税込は1円〜1兆円の整数の円で入れてください'}]}),
    '実費の行の入力を確かめてください（税込は1円〜1兆円の整数の円で入れてください）');
  assert.equal(failureText({message: 'この行はもう取り消してあります'}), 'この行はもう取り消してあります');
  assert.equal(failureText(null), '保存できませんでした');
});

async function setup(t) {
  const db = await openTestDb({t});
  const workId = Number((await db.get("INSERT INTO works(org_id,project_id,code,title) VALUES(1,1,'W-SHEET','表の作品（架空）') RETURNING id")).id);
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
  return {workId, login, call, url: (entry = '') => `/expenses/works/${workId}/actual-lines${entry ? `/${entry}` : ''}`};
}

test('FR-EXP-PCOST-049 FR-EXP-PCOST-050 画面の送り方のとおりに受け口へ送ると、足した行は未確認で入り、直した行は取消と置き換え（未確認）、確認で確認済みに移る', async (t) => {
  const {login, call, url} = await setup(t);
  const admin = await login('admin@openingnight.invalid');
  // 下書き2行を貼ってそろえた → 1回の POST
  const drafts = [{...draftRow(1), d: '2026-11-18', payee: '架空弁当店', category: 'H', amount: 30600, memo: '昼夜 34食'},
    {...draftRow(2), d: '2026-11-19', payee: '架空駐車場', category: 'K', amount: 2100}];
  let plan = planDetailChange({edits: drafts.map((row, index) => ({type: 'insert', index, key: row.id, row})), action: 'paste', rows: drafts, lines: []});
  assert.equal(plan.posts.length, 1);
  assert.equal((await call(admin, url(), {method: 'POST', payload: {lines: plan.posts[0].lines}})).status, 201);
  let view = (await call(admin, url())).body;
  assert.deepEqual(view.lines.map((row) => [row.payeeName, row.incTaxYen, row.entryMethod, row.unconfirmed, row.taxUnknown]),
    [['架空弁当店', 30600, 'human', true, true], ['架空駐車場', 2100, 'human', true, true]]);
  assert.deepEqual([view.canWrite, view.canCheck, view.unconfirmedCount, view.cumulative.all.incTaxYen], [true, true, 2, 32700]);
  // 先に1行を確かめてから、その行の金額を表で直す → 取消と置き換え。置き換えは未確認に戻る
  const parking = view.lines.find((row) => row.payeeName === '架空駐車場');
  assert.equal((await call(admin, url('checks'), {method: 'POST', payload: {lineIds: [parking.id]}})).status, 200);
  view = (await call(admin, url())).body;
  const rows = detailRows(view.lines).map((row) => (row.lineId === parking.id ? {...row, amount: 2400} : row));
  plan = planDetailChange({edits: [cell(`line:${parking.id}`, 'amount', 2400, 2100)], rows, lines: view.lines});
  assert.equal(plan.voids.length, 1);
  const voided = await call(admin, url(`${parking.id}/void`), {method: 'POST', payload: plan.voids[0].body});
  assert.equal(voided.status, 201);
  view = (await call(admin, url())).body;
  assert.deepEqual(view.lines.map((row) => [row.payeeName, row.incTaxYen, row.unconfirmed, row.replaces]),
    [['架空弁当店', 30600, true, null], ['架空駐車場', 2400, true, parking.id]]);
  assert.equal(view.cumulative.all.incTaxYen, 33000);
  // 確認（セル1つ＝見えている未確認すべて）→ 2件が確認済みに
  const target = checkTargets({lines: view.lines, selection: {range: false, selected: [], visible: view.lines.map((row) => row.id)}});
  assert.deepEqual([target.count, target.incTaxYen], [2, 33000]);
  const checked = await call(admin, url('checks'), {method: 'POST', payload: {lineIds: target.batches[0]}});
  assert.deepEqual([checked.status, checked.body.checked], [200, 2]);
  view = (await call(admin, url())).body;
  assert.deepEqual([view.unconfirmedCount, view.cumulative.confirmed.incTaxYen], [0, 33000]);
  // 取り消す（行を消す）→ 表から消え、合計から外れる
  assert.equal((await call(admin, url(`${view.lines[0].id}/void`), {method: 'POST', payload: {reason: '架空の二重入力'}})).status, 201);
  view = (await call(admin, url())).body;
  assert.deepEqual([view.lines.length, view.cumulative.all.incTaxYen], [1, 2400]);
});

test('FR-EXP-PCOST-052 書けない人には読むだけ: 編集担当は canWrite・canCheck が偽、制作担当は 403（画面は制作担当のメニューに出さない）', async (t) => {
  const {login, call, url} = await setup(t);
  // 編集担当（試作の行で案件1に編集の権限）は読めるが、書けず確かめられない（画面は読むだけの表と合計だけ）
  const editor = await call(await login('editor@openingnight.invalid'), url());
  assert.deepEqual([editor.status, editor.body.canWrite, editor.body.canCheck], [200, false, false]);
  const production = await call(await login('production@openingnight.invalid'), url());
  assert.deepEqual([production.status, production.body.error], [403, 'この作品の実費への権限がありません']);
  assert.deepEqual([hiddenPagesForRole('production').has('実費'), hiddenPagesForRole('editor').has('実費'), slugOf('実費'), folderOf('実費')?.id], [true, false, 'actual-lines', 'F04']);
});
