// 営業基幹・売上集計シートのレビュー指摘（W10）の試験。期待値は試験の中に手で書いた値・DB を SQL で読み直した値で持ち、
// 試験対象の関数では作らない（試験対象の関数は入力を組み立てるのに使うことがあるが、結果は API・DB で確かめる）。
// 1. ウィンドウの種別を直した後も、1件入力・Excel 取込が通る（種別に無くなった告知・終了・追加項目を持ち越さない）
// 2. 地域が別表記の系列も、Excel 取込で登録できる（名寄せで見つけた系列の地域のまま登録する）
// 3. やめた種別と同じ表示名の種別の列を、使っている種別の列として読む
// 4. 料率の「50%」（Excel の 0.5・パーセント書式）を 50% として読む。テンプレートの料率の列は文字の書式
// 5. 切れ目なく続く契約・長い契約に覆われた短い契約は「契約の空白」にしない
// 6. 取込ウィザードは、組織が採用した拡張属性の列の中から、見出しが一致するものだけを自動で選ぶ
// 7. 売上集計シートの条件に、財務の権限の無い作品の名前を出さない（403）
// 8. 売上明細の列セットでも、請求・商品・取引区分の絞り込みが効く
// 9. 拡張属性の一括登録は、クラウドの1値の上限（約128KB）を超えると 413 で止める
import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync, zipSync, strFromU8, strToU8} from 'fflate';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {toCsv} from '../src/csv.mjs';
import {currentWindowInput} from '../src/sales-ops/release-window-model.mjs';
import {classifySale, renewalGaps, tableFromPartnerListSheets} from '../src/sales-ops/partner-list-model.mjs';
import {defaultFields} from '../src/import/wizard-model.mjs';

async function setup({t, mode = 'local'} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode});
  const sessions = {};
  const as = async (role) => {
    if (!sessions[role]) {
      const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: `${role}@openingnight.invalid`})});
      assert.equal(login.status, 200, role);
      sessions[role] = login.headers.get('set-cookie').split(';')[0];
    }
    const cookie = sessions[role];
    const call = async (method, path, payload) => {
      const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
      const type = response.headers.get('content-type') || '';
      return {status: response.status, body: type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer())};
    };
    return {get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload)};
  };
  return {db, app, as};
}

async function adoptedWindows({t} = {}) {
  const env = await setup({t});
  const admin = await env.as('admin');
  assert.equal((await admin.post('/release-window-types/adopt', {reason: '初期の種別を採用（試験）'})).status, 201);
  const types = new Map((await admin.get('/release-window-types')).body.types.map((type) => [type.type_key, type]));
  return {...env, admin, types};
}
const windowSheet = async (admin) => decodeXlsx((await admin.get('/release-windows/export.xlsx')).body).find((sheet) => sheet.name === 'ウィンドウ');
const versionCount = async (db, workId, typeId) => Number((await db.get(`SELECT COUNT(*) AS n FROM work_release_window_versions v JOIN work_release_windows w ON w.org_id=v.org_id AND w.id=v.window_id
  WHERE w.work_id=? AND w.type_id=?`, [workId, typeId])).n);

// ---- 1. 種別を直した後の入力・取込 ------------------------------------------------------------
test('1: 放送の告知解禁日をやめた後も、出力したファイルで別の種別を直して取り込める（告知を持ち越さない・変えていない系列は版を積まない）', async (t) => {
  const {db, admin, types} = await adoptedWindows({t});
  const broadcast = types.get('broadcast');
  assert.equal((await admin.post('/release-windows', {workId: 1, typeId: broadcast.id, baseVersion: 0, start: '2027-04-01', end: '2028-03-31', announce: '2027-02-01', reason: '放送の予定（試験）'})).status, 201);
  assert.equal((await admin.post(`/release-window-types/${broadcast.id}/versions`, {baseVersion: 1, has_announce: false, reason: '告知は管理しない（試験）'})).status, 201);
  const sheet = await windowSheet(admin);
  const headers = sheet.rows[0];
  const row = [...sheet.rows[1]];
  // 手を入れていないファイルは「変更なし」（告知の値が消えたことを変更と数えない）
  const untouched = await admin.post('/release-windows/import/preview', {table: {headers, rows: [{rowNo: 2, cells: row}]}, fileName: 'a.xlsx'});
  assert.equal(untouched.status, 200, JSON.stringify(untouched.body));
  assert.equal(untouched.body.counts.unchanged, 1);
  assert.equal(untouched.body.token, null);
  // 劇場の公開日だけを直す
  row[headers.indexOf('劇場公開・配給開始 公開日')] = '2026-11-06';
  const preview = await admin.post('/release-windows/import/preview', {table: {headers, rows: [{rowNo: 2, cells: row}]}, fileName: 'a.xlsx'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.counts.errors, 0);
  assert.equal(preview.body.counts.windowsAppend, 1);
  assert.equal(preview.body.counts.windowsRevise, 0);
  assert.equal((await admin.post('/release-windows/import/commit', {token: preview.body.token, reason: '公開日を入れる（試験）', confirmed: true})).status, 201);
  assert.equal(await versionCount(db, 1, broadcast.id), 1);
  assert.equal(await versionCount(db, 1, types.get('theatrical').id), 1);
  // 放送の開始日を直すと、新しい版は告知を持たない（前の版の告知は履歴に残る）
  const again = await windowSheet(admin);
  const cells = [...again.rows[1]];
  cells[again.rows[0].indexOf('放送 放送解禁日')] = '2027-05-01';
  const second = await admin.post('/release-windows/import/preview', {table: {headers: again.rows[0], rows: [{rowNo: 2, cells}]}, fileName: 'b.xlsx'});
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal((await admin.post('/release-windows/import/commit', {token: second.body.token, reason: '放送の解禁日を直す（試験）', confirmed: true})).status, 201);
  const versions = await db.all(`SELECT v.version_no,v.start_on,v.announce_on FROM work_release_window_versions v JOIN work_release_windows w ON w.org_id=v.org_id AND w.id=v.window_id
    WHERE w.work_id=1 AND w.type_id=? ORDER BY v.version_no`, [broadcast.id]);
  assert.deepEqual(versions.map((v) => ({...v})), [{version_no: 1, start_on: '2027-04-01', announce_on: '2027-02-01'}, {version_no: 2, start_on: '2027-05-01', announce_on: null}]);
});

test('1: 期間の種別を1日の種別に直した後も、取込は終了を持ち越さない', async (t) => {
  const {db, admin, types} = await adoptedWindows({t});
  const overseas = types.get('overseas');
  assert.equal((await admin.post('/release-windows', {workId: 1, typeId: overseas.id, baseVersion: 0, start: '2027-01', end: '2029-12', reason: '海外の予定（試験）'})).status, 201);
  assert.equal((await admin.post(`/release-window-types/${overseas.id}/versions`, {baseVersion: 1, date_mode: 'point', start_label: '開始日', reason: '海外は開始日だけにする（試験）'})).status, 201);
  const sheet = await windowSheet(admin);
  const headers = sheet.rows[0];
  const row = [...sheet.rows[1]];
  assert.equal(headers.includes(`${overseas.label} ${overseas.end_label}`), false);
  row[headers.indexOf(`${overseas.label} 開始日`)] = '2027-02';
  const preview = await admin.post('/release-windows/import/preview', {table: {headers, rows: [{rowNo: 2, cells: row}]}, fileName: 'a.xlsx'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal((await admin.post('/release-windows/import/commit', {token: preview.body.token, reason: '開始を直す（試験）', confirmed: true})).status, 201);
  const latest = await db.get(`SELECT v.start_on,v.end_on FROM work_release_window_versions v JOIN work_release_windows w ON w.org_id=v.org_id AND w.id=v.window_id
    WHERE w.work_id=1 AND w.type_id=? ORDER BY v.version_no DESC LIMIT 1`, [overseas.id]);
  assert.deepEqual({...latest}, {start_on: '2027-02', end_on: null});
});

test('1: 追加項目を外した種別でも、画面の新しい版（今の版から作る下書き）は登録できる', async (t) => {
  const {db, admin, types} = await adoptedWindows({t});
  const svod = types.get('svod_early');
  assert.equal((await admin.post('/release-windows', {workId: 1, typeId: svod.id, baseVersion: 0, start: '2027-01-15', end: '2027-12', fields: {price_ex_tax: '1500', viewing_hours: '48'}, reason: '配信の予定（試験）'})).status, 201);
  assert.equal((await admin.post(`/release-window-types/${svod.id}/versions`, {baseVersion: 1, fields: svod.fields.filter((f) => f.field_key !== 'viewing_hours'), reason: '視聴時間は管理しない（試験）'})).status, 201);
  const history = (await admin.get(`/release-windows/history?workId=1&typeId=${svod.id}`)).body;
  const draft = currentWindowInput(history.versions[0], history.type);
  assert.deepEqual(Object.keys(draft.fields), ['price_ex_tax']);
  // 履歴には外した項目を「今は使っていない」列として出せるよう、見出しを返す（前の版の値は残る）
  assert.deepEqual(history.pastFields.map((f) => [f.field_key, f.label]), [['viewing_hours', svod.fields.find((f) => f.field_key === 'viewing_hours').label]]);
  assert.deepEqual(history.versions[0].fields.viewing_hours, {t: null, n: 48});
  const save = await admin.post('/release-windows', {workId: 1, typeId: svod.id, territory: history.territory, baseVersion: 1, ...draft, start: '2027-02-01', reason: '解禁日を直す（試験）'});
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const values = await db.all(`SELECT f.version_no,f.field_key,f.value_number FROM work_release_window_field_values f JOIN work_release_windows w ON w.org_id=f.org_id AND w.id=f.window_id
    WHERE w.work_id=1 AND w.type_id=? ORDER BY f.version_no,f.field_key`, [svod.id]);
  assert.deepEqual(values.map((v) => ({...v})), [
    {version_no: 1, field_key: 'price_ex_tax', value_number: 1500}, {version_no: 1, field_key: 'viewing_hours', value_number: 48},
    {version_no: 2, field_key: 'price_ex_tax', value_number: 1500},
  ]);
});

// ---- 2. 地域の別表記 ------------------------------------------------------------------------
test('2: 地域「国内」の劇場の系列も、出力→取込で同じ系列に版を積める。地域を省いた1件入力も同じ系列に積む', async (t) => {
  const {db, admin, types} = await adoptedWindows({t});
  const theatrical = types.get('theatrical');
  assert.equal((await admin.post('/release-windows', {workId: 1, typeId: theatrical.id, baseVersion: 0, territory: '国内', start: '2026-11', reason: '公開月（試験）'})).status, 201);
  const sheet = await windowSheet(admin);
  const headers = sheet.rows[0];
  const row = [...sheet.rows[1]];
  row[headers.indexOf('劇場公開・配給開始 公開日')] = '2026-11-06';
  const preview = await admin.post('/release-windows/import/preview', {table: {headers, rows: [{rowNo: 2, cells: row}]}, fileName: 'a.xlsx'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.counts.windowsRevise, 1);
  const commit = await admin.post('/release-windows/import/commit', {token: preview.body.token, reason: '公開日が決まった（試験）', confirmed: true});
  assert.equal(commit.status, 201, JSON.stringify(commit.body));
  const saved = await admin.post('/release-windows', {workId: 1, typeId: theatrical.id, baseVersion: 2, start: '2026-11-13', reason: '公開日を1週ずらす（試験）'});
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const series = await db.all('SELECT w.territory,MAX(v.version_no) AS n FROM work_release_windows w JOIN work_release_window_versions v ON v.org_id=w.org_id AND v.window_id=w.id WHERE w.work_id=1 AND w.type_id=? GROUP BY w.id', [theatrical.id]);
  assert.deepEqual(series.map((s) => ({...s})), [{territory: '国内', n: 3}]);
});

// ---- 3. やめた種別と同じ表示名 ----------------------------------------------------------------
test('3: やめた種別と同じ表示名の新しい種別の列は、使っている種別の列として読む', async (t) => {
  const {db, admin, types} = await adoptedWindows({t});
  const avod = types.get('avod');
  assert.equal((await admin.post(`/release-window-types/${avod.id}/versions`, {baseVersion: 1, active: false, reason: '作り直す（試験）'})).status, 201);
  assert.equal((await admin.post('/release-window-types', {type_key: 'avod2', label: 'AVOD', family: 'digital', date_mode: 'period', start_label: '解禁日', end_label: '配信期限', sort_order: 115, distributions: ['D006'], fields: [], reason: '作り直し（試験）'})).status, 201);
  const sheet = await windowSheet(admin);
  const headers = sheet.rows[0];
  const row = [...sheet.rows[1]];
  row[headers.indexOf('AVOD 解禁日')] = '2027-05-01';
  const preview = await admin.post('/release-windows/import/preview', {table: {headers, rows: [{rowNo: 2, cells: row}]}, fileName: 'a.xlsx'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.counts.windowsAppend, 1);
  assert.equal(preview.body.warnings.some((w) => /使っていない種別/.test(w)), false, JSON.stringify(preview.body.warnings));
  assert.equal((await admin.post('/release-windows/import/commit', {token: preview.body.token, reason: 'AVOD の解禁日（試験）', confirmed: true})).status, 201);
  const avod2 = await db.get("SELECT id FROM release_window_types WHERE type_key='avod2'");
  assert.equal(await versionCount(db, 1, avod2.id), 1);
  assert.equal(await versionCount(db, 1, avod.id), 0);
});

// ---- 4. 料率のパーセント書式 ------------------------------------------------------------------
// テンプレートの入力シートに、Excel が数値＋パーセント書式で保存した行を足す（styles の cellXfs に書式を足す）
function withPercentRows(bytes, rows) {
  const files = unzipSync(bytes);
  let styles = strFromU8(files['xl/styles.xml']);
  const count = Number(/<cellXfs count="(\d+)"/.exec(styles)[1]);
  const custom = 300;
  if (!/<numFmts/.test(styles)) styles = styles.replace('<fonts', '<numFmts count="0"></numFmts><fonts');
  styles = styles.replace(/<numFmts count="(\d+)">/, (_, n) => `<numFmts count="${Number(n) + 1}"><numFmt numFmtId="${custom}" formatCode="0.0%"/>`);
  styles = styles.replace(/<cellXfs count="\d+">/, `<cellXfs count="${count + 2}">`)
    .replace('</cellXfs>', `<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="${custom}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`);
  files['xl/styles.xml'] = strToU8(styles);
  const sheetPath = Object.keys(files).find((path) => /worksheets\/sheet1\.xml$/.test(path));
  const cell = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  const xml = rows.map((r, n) => {
    const at = n + 2;
    return `<row r="${at}">${cell(`C${at}`, r.work)}${cell(`E${at}`, r.code)}${cell(`G${at}`, '2026-04-01')}${cell(`H${at}`, '2027-03-31')}${cell(`L${at}`, '契約済')}${cell(`M${at}`, 'RS')}<c r="O${at}" s="${count + (r.custom ? 1 : 0)}"><v>${r.value}</v></c></row>`;
  }).join('');
  files[sheetPath] = strToU8(strFromU8(files[sheetPath]).replace(/(<row r="1"[\s\S]*?<\/row>)/, `$1${xml}`));
  return zipSync(files);
}

test('4: Excel で「50%」と入れた料率（0.5・パーセント書式）は 50%（5,000bps）として登録する', async (t) => {
  const {db, as} = await setup({t});
  const admin = await as('admin');
  const list = await admin.post('/partner-lists', {partnerId: 1, listKind: 'distribution', name: '料率の試験（架空）', reason: '試験のリスト'});
  assert.equal(list.status, 201);
  const work = await db.get('SELECT code FROM works WHERE id=1');
  const template = (await admin.get(`/partner-lists/${list.body.id}/template.xlsx`)).body;
  assert.equal(decodeXlsx(template).find((s) => s.name === '入力').rows[0][14], '料率（%）');
  const bytes = withPercentRows(template, [{work: work.code, code: 'D005', value: 0.5}, {work: work.code, code: 'D004', value: 0.125, custom: true}]);
  const table = tableFromPartnerListSheets(decodeXlsx(bytes, {formulas: 'sheet', percent: 'text'}));
  const preview = await admin.post(`/partner-lists/${list.body.id}/import/preview`, {table, fileName: 'rate.xlsx'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.counts.append, 2);
  assert.equal((await admin.post(`/partner-lists/${list.body.id}/import/commit`, {token: preview.body.token, reason: '料率を入れる（試験）', confirmed: true})).status, 201);
  const rates = await db.all('SELECT distribution_code,rate_bps FROM partner_list_entry_versions ORDER BY distribution_code');
  // 50% = 5,000bps、12.5% = 1,250bps（1% = 100bps）
  assert.deepEqual(rates.map((r) => ({...r})), [{distribution_code: 'D004', rate_bps: 1250}, {distribution_code: 'D005', rate_bps: 5000}]);
});

async function templateBytes({t} = {}) {
  const {as} = await setup({t});
  const admin = await as('admin');
  const list = await admin.post('/partner-lists', {partnerId: 1, listKind: 'sales', name: '書式の試験（架空）', reason: '試験のリスト'});
  assert.equal(list.status, 201);
  return (await admin.get(`/partner-lists/${list.body.id}/template.xlsx`)).body;
}

test('4: パーセント書式の読み替えは頼んだときだけ（既定の読み取りは数のまま）', async (t) => {
  const bytes = withPercentRows(await templateBytes({t}), [{work: 'W', code: 'D005', value: 0.5}, {work: 'W', code: 'D004', value: 0.125, custom: true}]);
  const plain = decodeXlsx(bytes).find((s) => s.name === '入力');
  assert.deepEqual([plain.rows[1][14], plain.rows[2][14]], [0.5, 0.125]);
  const asText = decodeXlsx(bytes, {percent: 'text'}).find((s) => s.name === '入力');
  assert.deepEqual([asText.rows[1][14], asText.rows[2][14]], ['50%', '12.5%']);
});

test('4: テンプレートの料率の列は、空の行まで文字の書式（@）にする', async (t) => {
  const template = await templateBytes({t});
  const files = unzipSync(template);
  const headers = decodeXlsx(template).find((s) => s.name === '入力').rows[0];
  const column = headers.indexOf('料率（%）') + 1;
  const sheet = strFromU8(files[Object.keys(files).find((path) => /worksheets\/sheet1\.xml$/.test(path))]);
  const col = new RegExp(`<col min="${column}" max="${column}"[^>]*style="(\\d+)"`).exec(sheet);
  assert.ok(col, '料率の列に列の書式がありません');
  const xfs = [...strFromU8(files['xl/styles.xml']).match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf [^>]*?numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(xfs[Number(col[1])], 49);
});

// ---- 5. 契約をつないだ範囲 --------------------------------------------------------------------
test('5: 切れ目なく続く2つの契約にまたがる売上は期間内。本当の切れ目にかかる売上だけを空白とする', () => {
  const flow = {group: 'digital', sub: 'SVOD'};
  const entry = (id, start, end) => ({entry_id: id, status: 'contracted', territory: '日本', distribution_code: 'D005', flow, contract_start: start, contract_end: end, end_rule: 'date'});
  const a = entry(1, '2025-04-01', '2026-01-31');
  const b = entry(2, '2026-02-01', '2027-01-31');
  const sale = (from, to, month) => ({sales_period_from: from, sales_period_to: to, accounting_month: month, territory: '日本', code: 'D005', flow});
  for (const basis of ['month', 'period']) {
    const result = classifySale(sale('2026-01-01', '2026-03-31', '2026-04'), [a, b], basis);
    assert.equal(result.status, 'in_period', basis);
    assert.deepEqual([...result.entryIds].sort(), [1, 2], basis);
  }
  // B が 2026-03-01 から（2月が空く）: 2月を含む売上は空白、1月だけ・3月だけの売上は期間内
  const late = entry(3, '2026-03-01', '2027-01-31');
  assert.equal(classifySale(sale('2026-01-01', '2026-03-31', '2026-04'), [a, late], 'period').status, 'gap');
  assert.equal(classifySale(sale('2026-02-01', '2026-02-28', '2026-03'), [a, late], 'month').status, 'gap');
  assert.equal(classifySale(sale('2026-01-01', '2026-01-31', '2026-02'), [a, late], 'month').status, 'in_period');
  assert.equal(classifySale(sale('2026-03-01', '2026-03-31', '2026-04'), [a, late], 'month').status, 'in_period');
  assert.equal(classifySale(sale('2025-03-01', '2025-04-30', '2025-05'), [a, late], 'period').status, 'before_start');
  assert.equal(classifySale(sale('2027-01-01', '2027-02-28', '2027-03'), [a, late], 'period').status, 'after_end');
});

test('5: 長い契約が覆っている短い契約どうしの間は、再契約の空白にしない（本当の切れ目だけを数える）', () => {
  const entry = (id, start, end, extra = {}) => ({entry_id: id, list_id: 1, work_id: 1, distribution_code: 'D005', territory: '日本', status: 'contracted', contract_start: start, contract_end: end, end_rule: 'date', ...extra});
  const main = entry(1, '2025-01-01', '2027-12-31');
  const shortB = entry(2, '2025-04-01', '2025-06-30');
  const shortC = entry(3, '2026-01-01', '2026-12-31', {renews_entry_id: 2});
  assert.deepEqual(renewalGaps([main, shortB, shortC]), []);
  // 本当の切れ目: 2025-12-31 で終わり、2026-03-01 から始まる → 2026-01-01〜2026-02-28 の 31+28=59日
  const first = entry(4, '2025-01-01', '2025-12-31');
  const next = entry(5, '2026-03-01', '2026-12-31');
  assert.deepEqual(renewalGaps([first, next, entry(6, '2025-03-01', '2025-05-31')]), [{work_id: 1, list_id: 1, prev: 4, next: 5, from: '2026-01-01', to: '2026-02-28', days: 59}]);
  // 期限なし（開いた終わり）の契約の後は空白にならない
  assert.deepEqual(renewalGaps([entry(7, '2024-01-01', null, {end_rule: 'perpetual'}), entry(8, '2026-01-01', '2026-12-31')]), []);
});

// ---- 6. 取込ウィザードの拡張属性の列 ----------------------------------------------------------
test('6: 取込ウィザードは採用していない組織では拡張属性の列を選ばず、採用していても部分一致は候補の表示だけにする', async () => {
  const theatre = ['劇場名', '動員数', '売上金額', '消費税', '税込金額'];
  const sample = [['架空劇場A', '100', '90000', '9000', '99000']];
  assert.equal(defaultFields({headers: theatre, sampleRows: sample, productIds: [], attributeTargets: []}).fields.attributes, undefined);
  assert.equal(defaultFields({headers: theatre, sampleRows: sample, productIds: []}).fields.attributes, undefined);
  assert.deepEqual(defaultFields({headers: theatre, sampleRows: sample, productIds: [], attributeTargets: ['attr_theatre_name']}).fields.attributes, {attr_theatre_name: '劇場名'});
  const code = defaultFields({headers: ['劇場コード', '動員数', '売上金額', '消費税', '税込金額'], sampleRows: sample, productIds: [], attributeTargets: ['attr_theatre_name']});
  assert.equal(code.fields.attributes, undefined);
  assert.match(code.notes.attr_theatre_name || '', /劇場コード/);
  // 前回の列対応にあっても、今は採用していない列は選ばない
  const previous = {definition: {ignoredColumns: [], mappings: [{target: 'attr_theatre_name', mode: 'source', source: '劇場名'}]}, versionNo: 3};
  assert.equal(defaultFields({headers: theatre, sampleRows: sample, productIds: [], previous, attributeTargets: []}).fields.attributes, undefined);
  assert.deepEqual(defaultFields({headers: theatre, sampleRows: sample, productIds: [], previous, attributeTargets: ['attr_theatre_name']}).fields.attributes, {attr_theatre_name: '劇場名'});
});

test('6: 取込の文脈は、組織が採用して使っている拡張属性の列だけを返す', async (t) => {
  const {db, as} = await setup({t});
  const admin = await as('admin');
  assert.deepEqual((await admin.get('/sales-import/context')).body.attributeTargets, []);
  assert.equal((await admin.post('/sales-sheet/columns/adopt', {reason: '採用（試験）'})).status, 201);
  const expected = (await db.all(`SELECT c.column_key FROM sales_sheet_column_versions c WHERE c.org_id=1 AND c.source_kind='attribute' AND c.active=1
    AND c.version_no=(SELECT MAX(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id=c.org_id AND x.column_key=c.column_key) ORDER BY c.column_key`)).map((r) => `attr_${r.column_key}`);
  assert.ok(expected.includes('attr_theatre_name'));
  const got = (await admin.get('/sales-import/context')).body.attributeTargets;
  assert.deepEqual([...got].sort(), expected);
});

// ---- 7. 権限の無い作品の名前 ------------------------------------------------------------------
test('7: 財務の権限の無い作品を条件にすると 403 で、作品名を返さない（画面・Excel・CSV）', async (t) => {
  const {db, as} = await setup({t});
  const admin = await as('admin');
  const editor = await as('editor');
  assert.equal((await admin.post('/sales-sheet/columns/adopt', {reason: '採用（試験）'})).status, 201);
  const project = (await db.get("INSERT INTO projects(org_id,code,title) VALUES(1,'P-W10-SECRET','非公開の案件（架空）') RETURNING id")).id;
  const secret = (await db.get("INSERT INTO works(org_id,project_id,code,title,format) VALUES(1,?,'W-W10-SECRET','未発表の作品名（架空）','film') RETURNING id", [project])).id;
  for (const path of [`/sales-sheet?workId=${secret}`, `/sales-sheet/export.xlsx?workId=${secret}`, `/sales-sheet/export.csv?workId=${secret}`]) {
    const response = await editor.get(path);
    assert.equal(response.status, 403, path);
    assert.doesNotMatch(JSON.stringify(response.body), /未発表の作品名/);
  }
  const own = await editor.get('/sales-sheet?workId=1');
  assert.equal(own.status, 200);
  const title = (await db.get('SELECT title FROM works WHERE id=1')).title;
  assert.deepEqual(own.body.conditions.find(([key]) => key === '作品'), ['作品', title]);
  const byAdmin = await admin.get(`/sales-sheet?workId=${secret}`);
  assert.equal(byAdmin.status, 200);
  assert.deepEqual(byAdmin.body.conditions.find(([key]) => key === '作品'), ['作品', '未発表の作品名（架空）']);
});

// ---- 8. 請求・商品・取引区分の絞り込み ---------------------------------------------------------
test('8: 売上集計シートでも 請求・商品・取引区分 で絞り、条件に出す', async (t) => {
  const {db, as} = await setup({t});
  const admin = await as('admin');
  assert.equal((await admin.post('/sales-sheet/columns/adopt', {reason: '採用（試験）'})).status, 201);
  const sale = async (key, productId, amount) => {
    const response = await admin.post('/sales', {workId: 1, report_key: key, kind: 'digital', partner_id: 2, product_id: productId, period_from: '2026-04-01', period_to: '2026-04-30',
      recognition_basis_id: 2, report_received_on: '2026-05-05', basis_reason: '架空の報告受領月', description: `${key}（架空）`, quantity: 1, amount_ex_tax: amount, tax_amount: amount / 10, amount_inc_tax: amount + amount / 10});
    assert.equal(response.status < 300, true, JSON.stringify(response.body));
    return db.get('SELECT s.id,s.report_id FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key=?', [key]);
  };
  const billed = await sale('W10-FILTER-A', '', 100000);
  const other = await sale('W10-FILTER-B', 1, 200000);
  const invoice = await admin.post('/billing/invoices', {workId: 1, reportIds: [billed.report_id], invoiceDate: '2026-05-10', dueDate: '2026-06-30', sourceAmountBasis: 'platform_net'});
  assert.equal(invoice.status < 300, true, JSON.stringify(invoice.body));
  const classified = await admin.post('/report-center/classifications', {saleId: other.id, distributionCode: 'D005', baseVersion: 0, territory: '日本', serviceName: null, settlementMethod: 'royalty', reason: '試験の分類'});
  assert.equal(classified.status, 201, JSON.stringify(classified.body));
  const ids = async (query) => {
    const response = await admin.get(`/sales-sheet?set=basic&${query}`);
    assert.equal(response.status, 200, `${query} ${JSON.stringify(response.body).slice(0, 300)}`);
    return {ids: response.body.rows.map((row) => row.__id).sort((x, y) => x - y), conditions: response.body.conditions};
  };
  assert.deepEqual((await ids('billing=unbilled')).ids, [other.id]);
  assert.deepEqual((await ids('billing=billed')).ids, [billed.id]);
  assert.deepEqual((await ids('productId=none')).ids, [billed.id]);
  assert.deepEqual((await ids('productId=1')).ids, [other.id]);
  assert.deepEqual((await ids('deal=royalty')).ids, [other.id]);
  assert.deepEqual((await ids('deal=unverified')).ids, [billed.id]);
  const conditions = (await ids('billing=unbilled&productId=1&deal=royalty')).conditions;
  assert.deepEqual(conditions.filter(([key]) => ['請求', '商品', '取引区分'].includes(key)).map(([key]) => key), ['請求', '商品', '取引区分']);
  assert.equal((await admin.get('/sales-sheet?billing=someday')).status, 400);
  assert.equal((await admin.get('/sales-sheet?deal=gift')).status, 400);
});

// ---- 9. 拡張属性の一括登録の大きさ -------------------------------------------------------------
test('9: クラウドでは、拡張属性の一括登録が1値の上限（約128KB）を超えると 413 で止め、何も登録しない', async (t) => {
  const {db, as} = await setup({t});
  const admin = await as('admin');
  assert.equal((await admin.post('/sales-sheet/columns/adopt', {reason: '採用（試験）'})).status, 201);
  const headers = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax'];
  const rows = Array.from({length: 100}, (_, n) => ['W10-BIG', 1, '', '2026-04-01', '2026-04-30', '2026-04', `劇場 ${n + 1}（架空）`, '', 1000, 100, 1100]);
  const preview = await admin.post('/imports/preview', {kind: 'theatrical', workId: 1, text: toCsv(headers, rows)});
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body).slice(0, 300));
  assert.equal((await admin.post('/imports/commit', {token: preview.body.token})).status, 200);
  const saleIds = (await db.all("SELECT s.id FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key='W10-BIG' ORDER BY s.id")).map((r) => r.id);
  assert.equal(saleIds.length, 100);
  const identity = {org_id: 1, user_id: 1, role: 'admin', email: 'admin@openingnight.invalid', expires_at: null};
  const worker = createApp({db, mode: 'worker', authenticate: async () => identity});
  const post = async (payload) => {
    const response = await worker.request('/api/sales-sheet/values', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
    return {status: response.status, body: await response.json()};
  };
  // 500文字（1文字3バイト）×100件 = 約150KB → 上限を超える
  const big = await post({reason: '劇場名を入れる（試験）', changes: saleIds.map((saleId) => ({saleId, columnKey: 'theatre_name', baseVersion: 0, value: '架'.repeat(500)}))});
  assert.equal(big.status, 413, JSON.stringify(big.body).slice(0, 300));
  assert.match(big.body.error, /KB/);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM sale_attribute_values')).n), 0);
  const small = await post({reason: '劇場名を入れる（試験）', changes: saleIds.slice(0, 2).map((saleId) => ({saleId, columnKey: 'theatre_name', baseVersion: 0, value: '架空劇場（架空）'}))});
  assert.equal(small.status, 201, JSON.stringify(small.body));
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM sale_attribute_values')).n), 2);
});
