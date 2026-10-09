// 取引先別の配信・販売リスト（営業基幹）の試験。期待値は試験の中に手で書いた値・この試験の中で書き下した決まりで持ち、
// 試験対象の関数（partner-list-model.mjs）では作らない。
// ・リスト・明細・版（理由必須・版の照合・変更削除の禁止・追加の列の値の型のトリガー・値の引き継ぎ）
// ・状態は基準日から計算（開始前・期間中・終了間近・終了・自動更新・終了日未確認・予定・取り下げ）
// ・共通テンプレート（4シート）と取込（追加・修正・変更なし・取り下げ候補・エラー・版の衝突・別のリストのファイル・二重取込・
//   理由を書いて登録・1回限り・文の数は行数によらない・数百行が D1 の値の上限に収まる）
// ・全取引先の出力、作品×取引先の表（独占どうしは赤・ほかは注意）、確認（終了間近・再契約の空白・契約中の取引先が無い流通・期間外の売上）
// ・制作担当は API を使えない。管理者だけが追加の列を定義できる
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

const AS_OF = '2026-09-25';
let db, app, as, admin, editor, production, listA, listB, listC, ids;

// この試験の中で書き下した状態の決まり（基準日 2026-09-25・終了間近は30日）
function expectedState({status, start, end, rule}) {
  if (status === 'withdrawn') return 'withdrawn';
  if (status === 'planned') return 'planned';
  if (start > AS_OF) return 'upcoming';
  if (rule === 'date') {
    if (end < AS_OF) return 'ended';
    const days = (Date.parse(end) - Date.parse(AS_OF)) / 86400000;
    return days <= 30 ? 'ending_soon' : 'active';
  }
  return {auto_renew: 'auto_renew', perpetual: 'active', unknown: 'end_unknown'}[rule];
}

before(async (t) => {
  db = await openTestDb({t});
  app = createApp({db, mode: 'local'});
  const sessions = {};
  as = async (role) => {
    if (!sessions[role]) {
      const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: `${role}@openingnight.invalid`})});
      assert.equal(login.status, 200, role);
      sessions[role] = login.headers.get('set-cookie').split(';')[0];
    }
    const cookie = sessions[role];
    const call = async (method, path, payload) => {
      const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
      const type = response.headers.get('content-type') || '';
      return {status: response.status, body: type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer()), type};
    };
    return {get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload)};
  };
  admin = await as('admin');
  editor = await as('editor');
  production = await as('production');
  const created = async (response) => { assert.ok(response.status < 300, JSON.stringify(response.body)); return response.body; };
  listA = (await created(await editor.post('/partner-lists', {partnerId: 2, listKind: 'distribution', name: '見放題（試験）', serviceName: '架空配信の定額', reason: '取引先のリストを作る（試験）'}))).id;
  listB = (await created(await admin.post('/partner-lists', {partnerId: 3, listKind: 'distribution', name: '独占枠（試験）', reason: '独占の重なりの確認用（試験）'}))).id;
  listC = (await created(await admin.post('/partner-lists', {partnerId: 1, listKind: 'sales', name: '販売（試験）', reason: '注意の重なりの確認用（試験）'}))).id;
  const entry = async (list, values, reason = '許諾通知書を登録（試験）', extra = {}) => (await created(await editor.post(`/partner-lists/${list}/entries`, {workId: 1, values, reason, ...extra}))).entryId;
  ids = {};
  ids.soon = await entry(listA, {distribution_code: 'D005', contract_start: '2025-01-01', contract_end: '2026-10-10', end_rule: 'date', exclusivity: 'exclusive', status: 'contracted', settlement_method: 'RS', rate_percent: '50'});
  ids.upcoming = await entry(listA, {distribution_code: 'D004', contract_start: '2026-10-01', contract_end: '2027-09-30', status: 'contracted'});
  ids.ended = await entry(listA, {distribution_code: 'D003', contract_start: '2024-01-01', contract_end: '2025-12-31', status: 'contracted'});
  ids.renewal = await entry(listA, {distribution_code: 'D003', contract_start: '2026-02-01', contract_end: '2027-01-31', status: '契約済'}, '再契約（試験）', {renewsEntryId: ids.ended});
  ids.auto = await entry(listA, {distribution_code: 'D006', contract_start: '2025-04-01', contract_end: '2026-03-31', end_rule: 'auto_renew', status: 'contracted'});
  ids.perpetual = await entry(listA, {distribution_code: 'B001', contract_start: '2025-01-01', end_rule: '期限なし', status: 'contracted'});
  ids.unknown = await entry(listA, {distribution_code: 'R004', contract_start: '2025-01-01', status: 'contracted'});
  ids.planned = await entry(listA, {distribution_code: 'S003', contract_start: '2027-01-01'});
  ids.withdrawn = await entry(listA, {distribution_code: 'H002', contract_start: '2024-06-01', contract_end: '2024-12-31', status: 'contracted'});
  await created(await editor.post(`/partner-list-entries/${ids.withdrawn}/versions`, {baseVersion: 1, values: {status: 'withdrawn'}, reason: '配給は見送った（試験）'}));
  // 取引先3の独占（取引先2の独占と重なる）。請求先は取引先1（売上の相手が代理店のとき）
  ids.exclusive = (await created(await admin.post(`/partner-lists/${listB}/entries`, {workId: 1, values: {distribution_code: 'D005', contract_start: '2026-06-01', contract_end: '2027-05-31', exclusivity: '独占', status: 'contracted', billing_partner_code: 'PT-CINEMA'}, reason: '独占の打診（試験）'}))).entryId;
  // 取引先1の非独占（取引先2の TVOD と重なる）
  ids.caution = (await created(await admin.post(`/partner-lists/${listC}/entries`, {workId: 1, values: {distribution_code: 'D004', contract_start: '2026-11-01', contract_end: '2027-12-31', exclusivity: 'nonexclusive', status: 'contracted'}, reason: '非独占（試験）'}))).entryId;
});
after(() => db?.close());

test('制作担当はリスト・明細・表・確認・出力の API をどれも使えない', async () => {
  for (const path of ['/partner-lists', `/partner-lists/${listA}/entries`, '/partner-lists/matrix', '/partner-lists/checks', '/partner-lists/export', `/partner-lists/${listA}/template.xlsx`, '/partner-list-fields', `/partner-list-entries/${ids.soon}/history`]) {
    assert.equal((await production.get(path)).status, 403, path);
  }
  assert.equal((await production.post('/partner-lists', {partnerId: 2, listKind: 'sales', name: 'x', reason: 'x'})).status, 403);
  assert.equal((await production.post(`/partner-lists/${listA}/entries`, {workId: 1, values: {distribution_code: 'D005'}, reason: 'x'})).status, 403);
});

test('明細の状態は基準日から計算する（開始前・期間中・終了間近・終了・自動更新・終了日未確認・予定・取り下げ）', async () => {
  const result = await editor.get(`/partner-lists/${listA}/entries?asOf=${AS_OF}&soonDays=30`);
  assert.equal(result.status, 200);
  const plan = {
    soon: {status: 'contracted', start: '2025-01-01', end: '2026-10-10', rule: 'date'}, upcoming: {status: 'contracted', start: '2026-10-01', end: '2027-09-30', rule: 'date'},
    ended: {status: 'contracted', start: '2024-01-01', end: '2025-12-31', rule: 'date'}, renewal: {status: 'contracted', start: '2026-02-01', end: '2027-01-31', rule: 'date'},
    auto: {status: 'contracted', start: '2025-04-01', end: '2026-03-31', rule: 'auto_renew'}, perpetual: {status: 'contracted', start: '2025-01-01', rule: 'perpetual'},
    unknown: {status: 'contracted', start: '2025-01-01', rule: 'unknown'}, planned: {status: 'planned', start: '2027-01-01', rule: 'unknown'}, withdrawn: {status: 'withdrawn'},
  };
  const byId = new Map(result.body.entries.map((e) => [e.entry_id, e]));
  for (const [key, spec] of Object.entries(plan)) assert.equal(byId.get(ids[key]).state, expectedState(spec), key);
  assert.equal(byId.get(ids.soon).days_left, 15);
  assert.equal(byId.get(ids.soon).rate_bps, 5000);
  assert.equal(byId.get(ids.renewal).renews_entry_id, ids.ended);
  // 基準日を変えると状態も変わる（保存していない）
  const later = await editor.get(`/partner-lists/${listA}/entries?asOf=2026-11-01`);
  assert.equal(new Map(later.body.entries.map((e) => [e.entry_id, e])).get(ids.soon).state, 'ended');
  assert.equal(new Map(later.body.entries.map((e) => [e.entry_id, e])).get(ids.upcoming).state, 'active');
});

test('新しい版は理由必須・版の照合つき。版と明細は変更・削除できず、流通IDは流通マスタのものだけ', async () => {
  assert.equal((await editor.post(`/partner-list-entries/${ids.upcoming}/versions`, {baseVersion: 1, values: {contract_end: '2027-12-31'}, reason: ''})).status, 400);
  assert.equal((await editor.post(`/partner-list-entries/${ids.upcoming}/versions`, {baseVersion: 0, values: {contract_end: '2027-12-31'}, reason: '延長'})).status, 409);
  assert.equal((await editor.post(`/partner-list-entries/${ids.upcoming}/versions`, {baseVersion: 1, values: {contract_end: '2026-09-01'}, reason: '誤り'})).status, 400, '終了日が開始日より前');
  assert.equal((await editor.post(`/partner-lists/${listA}/entries`, {workId: 1, values: {distribution_code: 'svod'}, reason: '旧区分'})).status, 400, '旧区分の流通IDは使えない');
  assert.equal((await editor.post(`/partner-lists/${listA}/entries`, {workId: 1, values: {distribution_code: 'D005', status: 'contracted'}, reason: '開始日なし'})).status, 400);
  const ok = await editor.post(`/partner-list-entries/${ids.upcoming}/versions`, {baseVersion: 1, values: {contract_end: '2027-12-31', note: '延長の覚書（試験）'}, reason: '延長の覚書を受領（試験）'});
  assert.equal(ok.status, 201);
  const history = await editor.get(`/partner-list-entries/${ids.upcoming}/history`);
  assert.deepEqual(history.body.versions.map((v) => [v.version_no, v.contract_end]), [[2, '2027-12-31'], [1, '2027-09-30']]);
  await assert.rejects(db.run('UPDATE partner_list_entry_versions SET contract_end=? WHERE entry_id=?', ['2030-01-01', ids.upcoming]));
  await assert.rejects(db.run('DELETE FROM partner_list_entries WHERE id=?', [ids.upcoming]));
  await assert.rejects(db.run('UPDATE partner_lists SET name=? WHERE id=?', ['改名', listA]));
  await assert.rejects(db.run("INSERT INTO partner_list_entry_versions(org_id,list_id,entry_id,work_id,version_no,distribution_code,end_rule,exclusivity,status,reason,created_by) VALUES(1,?,?,1,4,'D005','unknown','unknown','planned','飛ばし',1)", [listA, ids.upcoming]), /stale/);
  const audits = await db.all("SELECT action FROM audit_log WHERE entity_type='partner_list_entry' AND entity_id=?", [String(ids.upcoming)]);
  assert.deepEqual(audits.map((a) => a.action), ['version']);
});

test('追加の列は管理者だけが定義し、テンプレートの見出しに増え、値は型のトリガーで守られ次の版へ写る', async () => {
  assert.equal((await editor.post('/partner-list-fields', {fieldKey: 'sale_window', label: 'セール実施期間', valueType: 'text', reason: 'x'})).status, 403);
  assert.equal((await admin.post('/partner-list-fields', {fieldKey: 'bad', label: '作品コード', valueType: 'text', reason: '重なり'})).status, 400);
  assert.equal((await admin.post('/partner-list-fields', {fieldKey: 'sale_window', label: 'セール実施期間', valueType: 'text', listKind: 'distribution', reason: '取引先の書類にある列（試験）'})).status, 201);
  assert.equal((await admin.post('/partner-list-fields', {fieldKey: 'viewing_hours', label: '視聴期間（時間）', valueType: 'integer', partnerId: 2, reason: '取引先2だけの列（試験）'})).status, 201);
  assert.equal((await admin.post('/partner-list-fields', {fieldKey: 'store_rank', label: '店舗ランク', valueType: 'choice', options: 'A,B,C', listKind: 'sales', reason: '販売リストだけの列（試験）'})).status, 201);
  const fields = (await admin.get('/partner-list-fields')).body.fields;
  const id = (key) => fields.find((f) => f.field_key === key).id;
  // 当てはまる列: リストA（配信・取引先2）は セール実施期間・視聴期間、リストC（販売・取引先1）は 店舗ランク だけ
  assert.deepEqual((await editor.get(`/partner-lists/${listA}/entries`)).body.fields.map((f) => f.label), ['セール実施期間', '視聴期間（時間）']);
  assert.deepEqual((await admin.get(`/partner-lists/${listC}/entries`)).body.fields.map((f) => f.label), ['店舗ランク']);
  const template = decodeXlsx((await editor.get(`/partner-lists/${listA}/template.xlsx`)).body);
  assert.deepEqual(template.map((s) => s.name).filter((n) => !n.startsWith('選択肢')), ['入力', '記入例', '記入ガイド', '_meta']);
  const headers = template[0].rows[0];
  assert.deepEqual(headers.slice(0, 5), ['明細ID', '版', '作品コード', '商品SKU', '流通ID']);
  assert.deepEqual(headers.slice(-2), ['セール実施期間', '視聴期間（時間）']);
  assert.equal(headers.length, 22 + 2);
  // 値の型と引き継ぎ
  assert.equal((await editor.post(`/partner-list-entries/${ids.auto}/versions`, {baseVersion: 1, values: {fields: {[id('viewing_hours')]: '四十八'}}, reason: 'x'})).status, 400);
  assert.equal((await editor.post(`/partner-list-entries/${ids.auto}/versions`, {baseVersion: 1, values: {fields: {[id('viewing_hours')]: '48', [id('sale_window')]: '2026-12 年末セール'}}, reason: '視聴期間を登録（試験）'})).status, 201);
  assert.equal((await editor.post(`/partner-list-entries/${ids.auto}/versions`, {baseVersion: 2, values: {note: '更新の通知あり（試験）'}, reason: '備考（試験）'})).status, 201);
  const history = (await editor.get(`/partner-list-entries/${ids.auto}/history`)).body.versions;
  assert.equal(history[0].version_no, 3);
  assert.deepEqual(history[0].fields[id('viewing_hours')], {t: null, n: 48});
  assert.deepEqual(history[0].fields[id('sale_window')], {t: '2026-12 年末セール', n: null});
  const versionId = history[0].id;
  await assert.rejects(db.run('INSERT INTO partner_list_field_values(org_id,entry_version_id,definition_id,value_text) VALUES(1,?,?,?)', [history[1].id, id('store_rank'), 'A']), /type mismatch/, '販売リストの列は配信リストの明細に付かない');
  await assert.rejects(db.run('UPDATE partner_list_field_values SET value_number=72 WHERE entry_version_id=?', [versionId]));
  // やめた列は見出しから消える（登録済みの値は版に残る）
  const state = fields.find((f) => f.field_key === 'sale_window');
  assert.equal((await admin.post(`/partner-list-fields/${state.id}/versions`, {baseVersion: 1, active: false, reason: '使わなくなった（試験）'})).status, 201);
  assert.equal((await admin.post(`/partner-list-fields/${state.id}/versions`, {baseVersion: 1, active: true, reason: '古い版から'})).status, 409);
  const headersAfter = decodeXlsx((await editor.get(`/partner-lists/${listA}/template.xlsx`)).body)[0].rows[0];
  assert.ok(!headersAfter.includes('セール実施期間'));
  assert.equal((await admin.post(`/partner-list-fields/${state.id}/versions`, {baseVersion: 2, active: true, reason: '戻す（試験）'})).status, 201);
});

// 出力した「現在の明細」を表に直す
async function currentTable(user, list) {
  const sheets = decodeXlsx((await user.get(`/partner-lists/${list}/template.xlsx?kind=current&asOf=${AS_OF}`)).body);
  const input = sheets.find((s) => s.name === '入力');
  const meta = Object.fromEntries(sheets.find((s) => s.name === '_meta').rows.slice(1).map((r) => [r[0], r[1]]));
  return {headers: input.rows[0].map((h) => String(h ?? '')), rows: input.rows.slice(1).map((cells, index) => ({rowNo: index + 2, cells: [...cells]})), meta};
}

test('Excel の取込: 追加・修正・変更なし・エラー・版の衝突・別のリスト・二重取込・理由必須・1回限り', async () => {
  const table = await currentTable(editor, listA);
  const h = (label) => table.headers.indexOf(label);
  assert.equal(table.meta.template, 'partner-list-v1');
  assert.equal(Number(table.meta.list_id), listA);
  const versionsBefore = Number((await db.get('SELECT COUNT(*) AS n FROM partner_list_entry_versions')).n);
  const rowOf = (entryId) => table.rows.find((row) => Number(row.cells[h('明細ID')]) === entryId);
  // 変更なしのまま読み込むと、登録するものは無い
  const unchanged = await editor.post(`/partner-lists/${listA}/import/preview`, {table, fileName: 'そのまま.xlsx'});
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body.failedRows || unchanged.body).slice(0, 1200));
  assert.equal(unchanged.body.token, null);
  assert.equal(unchanged.body.counts.unchanged, table.rows.length);
  // 1行修正（契約終了日）・1行追加・残りは変更なし
  const revised = rowOf(ids.renewal);
  revised.cells[h('契約終了日')] = '2027-03-31';
  const blank = table.headers.map(() => '');
  const added = [...blank];
  added[h('作品コード')] = 'WRK-DEMO'; added[h('流通ID')] = 'V001'; added[h('契約開始日')] = '2026-10-01'; added[h('契約終了日')] = '2027-09-30';
  added[h('状態')] = '予定'; added[h('取引方法')] = 'FLAT'; added[h('契約金額（税抜）')] = '1,200,000'; added[h('視聴期間（時間）')] = '72';
  const edited = {...table, rows: [...table.rows, {rowNo: table.rows.length + 2, cells: added}]};
  const preview = await editor.post(`/partner-lists/${listA}/import/preview`, {table: edited, fileName: '見放題_直し.xlsx'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 400));
  assert.deepEqual([preview.body.counts.append, preview.body.counts.revise, preview.body.counts.unchanged, preview.body.counts.errors], [1, 1, table.rows.length - 1, 0]);
  assert.deepEqual(preview.body.rows.find((row) => row.action === 'revise').parts, ['契約終了日']);
  assert.equal((await editor.post(`/partner-lists/${listA}/import/commit`, {token: preview.body.token, reason: '', confirmed: true})).status, 400);
  assert.equal((await admin.post(`/partner-lists/${listA}/import/commit`, {token: preview.body.token, reason: '別の人', confirmed: true})).status, 410, '確認した本人だけ');
  const commit = await editor.post(`/partner-lists/${listA}/import/commit`, {token: preview.body.token, reason: '取引先から届いた一覧を反映（試験）', confirmed: true});
  assert.equal(commit.status, 201, JSON.stringify(commit.body));
  assert.deepEqual([commit.body.appended, commit.body.revised, commit.body.withdrawn], [1, 1, 0]);
  assert.equal((await editor.post(`/partner-lists/${listA}/import/commit`, {token: preview.body.token, reason: 'もう一度', confirmed: true})).status, 410, '1回限り');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM partner_list_entry_versions')).n), versionsBefore + 2);
  const batch = await db.get('SELECT * FROM partner_list_import_batches WHERE list_id=?', [listA]);
  assert.deepEqual([batch.appended, batch.revised, batch.withdrawn, batch.unchanged, batch.mode], [1, 1, 0, table.rows.length - 1, 'partial']);
  const newEntry = await db.get('SELECT e.*,v.amount_ex_tax,v.settlement_method,v.import_batch_id FROM partner_list_entries e JOIN partner_list_entry_versions v ON v.entry_id=e.id WHERE e.created_batch_id=?', [batch.id]);
  assert.deepEqual([newEntry.amount_ex_tax, newEntry.settlement_method, newEntry.import_batch_id], [1200000, 'FLAT', batch.id]);
  const hoursField = (await admin.get('/partner-list-fields')).body.fields.find((f) => f.field_key === 'viewing_hours').id;
  assert.equal((await db.get('SELECT value_number FROM partner_list_field_values f JOIN partner_list_entry_versions v ON v.id=f.entry_version_id WHERE v.entry_id=? AND f.definition_id=?', [newEntry.id, hoursField])).value_number, 72);
  // 同じファイルは二度取り込めない
  assert.equal((await editor.post(`/partner-lists/${listA}/import/preview`, {table: edited, fileName: '見放題_直し.xlsx'})).status, 409);
  // 出力した後に別の人が直した明細（版が進んだ）はエラー。1行でもエラーがあれば何も登録しない
  const stale = await currentTable(editor, listA);
  const sh = (label) => stale.headers.indexOf(label);
  assert.equal((await editor.post(`/partner-list-entries/${ids.perpetual}/versions`, {baseVersion: 1, values: {note: '別の人の修正（試験）'}, reason: '別の人が直した（試験）'})).status, 201);
  const staleRow = stale.rows.find((row) => Number(row.cells[sh('明細ID')]) === ids.perpetual);
  staleRow.cells[sh('備考')] = 'ファイルでの修正';
  const badRow = [...stale.headers.map(() => '')];
  badRow[sh('作品コード')] = 'NO-SUCH-WORK'; badRow[sh('流通ID')] = 'D005';
  const failed = await editor.post(`/partner-lists/${listA}/import/preview`, {table: {...stale, rows: [...stale.rows, {rowNo: 99, cells: badRow}]}, fileName: '古い.xlsx'});
  assert.equal(failed.status, 400);
  assert.equal(failed.body.counts.errors, 2);
  assert.match(failed.body.failedRows.map((row) => row.errors.join()).join(' '), /第1版・いまは第2版/);
  assert.match(failed.body.failedRows.map((row) => row.errors.join()).join(' '), /NO-SUCH-WORK/);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM partner_list_entry_versions')).n), versionsBefore + 3);
  // 別のリストのファイルは、リストの名前を挙げて断る
  const other = await editor.post(`/partner-lists/${listB}/import/preview`, {table: stale, fileName: '取り違え.xlsx'});
  assert.equal(other.status, 400);
  assert.match(other.body.error, /見放題（試験）/);
});

test('リスト全件の取込ではファイルに無い明細を取り下げ候補にし、選んだときだけ取り下げる', async () => {
  const table = await currentTable(editor, listA);
  const h = (label) => table.headers.indexOf(label);
  const kept = table.rows.filter((row) => Number(row.cells[h('明細ID')]) !== ids.planned);
  kept[0].cells[h('備考')] = `全件の取込（試験）${Date.now()}`;
  const preview = await editor.post(`/partner-lists/${listA}/import/preview`, {table: {...table, rows: kept}, fileName: '全件.xlsx', mode: 'full'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 300));
  // 取り下げ候補は「予定」の明細1件だけ（取り下げ済みの明細は候補にしない）
  assert.deepEqual(preview.body.withdraw.map((item) => item.entryId), [ids.planned]);
  const commit = await editor.post(`/partner-lists/${listA}/import/commit`, {token: preview.body.token, reason: '取引先の全件の一覧（試験）', confirmed: true, withdrawMissing: true});
  assert.equal(commit.status, 201);
  assert.deepEqual([commit.body.revised, commit.body.withdrawn], [1, 1]);
  const planned = (await editor.get(`/partner-list-entries/${ids.planned}/history`)).body.versions;
  assert.deepEqual(planned.map((v) => v.status), ['withdrawn', 'planned']);
  assert.equal(planned[0].contract_start, '2027-01-01', '取り下げの版も前の値を写す');
});

test('数百行のファイルも1回の登録で入り、登録の文の数は行数によらない（D1 の480文・128KB の値に収まる）', async () => {
  const table = await currentTable(editor, listC);
  const h = (label) => table.headers.indexOf(label);
  const make = (n) => Array.from({length: n}, (_, k) => {
    const cells = table.headers.map(() => '');
    const start = new Date(Date.UTC(2030, 0, 1) + k * 86400000).toISOString().slice(0, 10);
    cells[h('作品コード')] = 'WRK-DEMO'; cells[h('流通ID')] = 'S003'; cells[h('契約開始日')] = start; cells[h('契約終了日')] = start;
    cells[h('状態')] = '契約済'; cells[h('取引方法')] = 'FLAT'; cells[h('契約金額（税抜）')] = String(1000 + k); cells[h('取引先側の作品コード')] = `SKU-${k}（架空）`;
    return {rowNo: k + 2, cells};
  });
  const small = await admin.post(`/partner-lists/${listC}/import/preview`, {table: {headers: table.headers, rows: make(2), meta: table.meta}, fileName: '2行.xlsx'});
  const large = await admin.post(`/partner-lists/${listC}/import/preview`, {table: {headers: table.headers, rows: make(400).slice(2), meta: table.meta}, fileName: '398行.xlsx'});
  assert.equal(large.status, 200, JSON.stringify(large.body).slice(0, 300));
  assert.equal(large.body.counts.append, 398);
  assert.ok(large.body.payloadBytes < 128_000, `確認の表の大きさ ${large.body.payloadBytes}`);
  const one = await admin.post(`/partner-lists/${listC}/import/commit`, {token: small.body.token, reason: '2行（試験）', confirmed: true});
  const many = await admin.post(`/partner-lists/${listC}/import/commit`, {token: large.body.token, reason: '398行（試験）', confirmed: true});
  assert.equal(many.status, 201, JSON.stringify(many.body));
  assert.equal(one.body.statements, many.body.statements);
  assert.ok(many.body.statements <= 10);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM partner_list_entry_versions WHERE list_id=? AND distribution_code='S003'", [listC])).n), 400);
});

test('全取引先をまとめた出力は1明細1行・最新の版・全追加列（Excel と CSV）', async () => {
  const sheets = decodeXlsx((await editor.get(`/partner-lists/export?asOf=${AS_OF}`)).body);
  const sheet = sheets.find((s) => s.name === '全取引先');
  const headerIndex = sheet.rows.findIndex((row) => row.includes('明細ID'));
  const headers = sheet.rows[headerIndex];
  const rows = sheet.rows.slice(headerIndex + 1).filter((row) => row.some((cell) => cell !== null && cell !== ''));
  const total = Number((await db.get('SELECT COUNT(*) AS n FROM partner_list_entries')).n);
  assert.equal(rows.length, total);
  for (const label of ['セール実施期間', '視聴期間（時間）', '店舗ランク', '取引先コード', '状態（基準日）']) assert.ok(headers.includes(label), label);
  const idIndex = headers.indexOf('明細ID'), versionIndex = headers.indexOf('版');
  const perpetual = rows.find((row) => Number(row[idIndex]) === ids.perpetual);
  assert.equal(Number(perpetual[versionIndex]), 2);
  const csv = await editor.get('/partner-lists/export?format=csv');
  assert.match(csv.type, /text\/csv/);
  const text = new TextDecoder().decode(csv.body);
  assert.equal(text.trim().split('\r\n').length, total + 1);
});

test('作品×取引先の表: 独占どうしの重なりは赤（exclusive）、ほかの重なりは注意（caution）。登録は止めない', async () => {
  const matrix = await editor.get(`/partner-lists/matrix?asOf=${AS_OF}`);
  assert.equal(matrix.status, 200);
  const pairs = matrix.body.pairs.map((p) => [Math.min(p.a, p.b), Math.max(p.a, p.b), p.severity]).sort();
  // 手で数えた重なり: 取引先2と3の SVOD 独占どうし（2026-06-01〜2026-10-10）、取引先2の TVOD と取引先1の TVOD（非独占）
  assert.deepEqual(pairs, [[Math.min(ids.soon, ids.exclusive), Math.max(ids.soon, ids.exclusive), 'exclusive'], [Math.min(ids.upcoming, ids.caution), Math.max(ids.upcoming, ids.caution), 'caution']].sort());
  const exclusive = matrix.body.pairs.find((p) => p.severity === 'exclusive');
  assert.deepEqual([exclusive.from, exclusive.to], ['2026-06-01', '2026-10-10']);
  const row = matrix.body.rows.find((r) => r.work_code === 'WRK-DEMO');
  assert.equal(row.overlap, 'exclusive');
  const cell = row.cells['2|D005'];
  assert.equal(cell[0].overlap, 'exclusive');
  assert.ok(matrix.body.columns.some((c) => c.key === '3|D005' && c.partner_name === '架空ストア'));
  // 取り下げた明細は表に出さない
  assert.ok(!Object.values(row.cells).flat().some((item) => item.entry_id === ids.withdrawn));
});

test('確認: 終了間近（30・60・90日）・再契約の空白・当社は売れるのに契約中の取引先が無い流通', async () => {
  // 当社の販売条件（流通別の販売条件）: SVOD・EST・AVOD・劇場。劇場の明細は取り下げだけなので「契約中の取引先が無い」
  for (const [code, release, end] of [['svod', '2025-01-01', '2030-12-31'], ['est', '2025-01-01', '2030-12-31'], ['avod', '2025-01-01', '2030-12-31'], ['theatrical', '2024-06-01', '2030-12-31'], ['broadcast_bs', '2027-01-01', '2030-12-31']]) {
    const r = await admin.post('/sales-catalog', {workId: 1, distributionCode: code, territory: '日本', baseVersion: 0, releaseOn: release, salesEndOn: end, terms: '架空の条件（試験）', sourceReference: '架空の許諾書（試験）', exclusivity: 'nonexclusive', status: 'confirmed'});
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const checks = await editor.get(`/partner-lists/checks?asOf=${AS_OF}`);
  assert.equal(checks.status, 200, JSON.stringify(checks.body).slice(0, 300));
  // 終了間近: 取引先2の SVOD（2026-10-10・あと15日）だけ
  assert.deepEqual(checks.body.endingSoon.map((e) => [e.entry_id, e.daysLeft, e.bucket]), [[ids.soon, 15, 30]]);
  assert.deepEqual(checks.body.soonCounts, {30: 1, 60: 0, 90: 0});
  // 再契約の空白: EST の 2025-12-31 終了 → 2026-02-01 開始（2026-01-01〜2026-01-31 の31日）
  assert.deepEqual(checks.body.gaps.map((g) => [g.prev, g.next, g.from, g.to, g.days]), [[ids.ended, ids.renewal, '2026-01-01', '2026-01-31', 31]]);
  // 契約中の取引先が無い流通: 劇場だけ（放送BSは解禁前なので対象外）
  assert.deepEqual(checks.body.uncovered.map((u) => u.distribution_code), ['theatrical']);
});

test('期間外の売上: 取引先（または請求先）・作品・流通の分類・販売期間で照合する', async () => {
  const sale = async (key, partnerId, from, to, month, amount, classify) => {
    const r = await admin.post('/sales', {workId: 1, kind: 'digital', report_key: key, partner_id: partnerId, period_from: from, period_to: to, accounting_month: month,
      description: `${key}（試験）`, quantity: 1, amount_ex_tax: amount, tax_amount: 0, amount_inc_tax: amount});
    assert.equal(r.status < 300, true, JSON.stringify(r.body));
    const id = (await db.get('SELECT s.id FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key=?', [key])).id;
    if (classify) assert.equal((await admin.post('/report-center/classifications', {saleId: id, baseVersion: 0, distributionCode: classify, territory: '日本', serviceName: '架空', settlementMethod: 'unverified', reason: '分類（試験）'})).status, 201);
    return id;
  };
  const expected = {};
  expected[await sale('PL-S1', 2, '2024-12-01', '2024-12-31', '2024-12', 1000, 'svod')] = 'before_start'; // SVOD は 2025-01-01 から
  expected[await sale('PL-S2', 2, '2025-06-01', '2025-06-30', '2025-06', 2000, 'svod')] = 'in_period';
  expected[await sale('PL-S3', 2, '2026-01-01', '2026-01-31', '2026-01', 3000, 'est')] = 'gap'; // EST の再契約の空白
  expected[await sale('PL-S4', 2, '2026-09-01', '2026-09-30', '2026-09', 4000, 'tvod')] = 'before_start'; // TVOD は 2026-10-01 から
  expected[await sale('PL-S5', 2, '2025-06-01', '2025-06-30', '2025-06', 5000, null)] = 'in_period'; // 分類なしは報告の種類（配信）で照合
  expected[await sale('PL-S6', 2, '2025-06-01', '2025-06-30', '2025-06', 6000, 'theatrical')] = 'flow_mismatch'; // 劇場の明細は取り下げだけ
  expected[await sale('PL-S7', 1, '2026-07-01', '2026-07-31', '2026-07', 7000, 'svod')] = 'in_period'; // 取引先1は取引先3の独占枠の請求先
  expected[await sale('PL-S8', 1, '2027-07-01', '2027-07-31', '2026-09', 8000, 'svod')] = 'after_end'; // 独占枠は 2027-05-31 まで
  expected[await sale('PL-S9', 3, '2025-06-01', '2025-06-30', '2025-06', 9000, 'svod')] = 'before_start'; // 取引先3の SVOD は 2026-06-01 から
  const checks = await editor.get(`/partner-lists/checks?asOf=${AS_OF}&from=2024-01&to=2026-12&basis=month`);
  assert.equal(checks.status, 200);
  const outOf = new Set(['before_start', 'after_end', 'gap', 'no_contract']);
  const got = new Map(checks.body.sales.rows.map((row) => [row.sale_id, row.status]));
  for (const [id, status] of Object.entries(expected)) {
    if (outOf.has(status) || status === 'flow_mismatch') assert.equal(got.get(Number(id)), status, `売上 ${id}`);
    else assert.ok(!got.has(Number(id)), `期間内の売上 ${id} は一覧に出さない`);
  }
  const tally = {};
  for (const status of Object.values(expected)) tally[status] = (tally[status] || 0) + 1;
  for (const [status, n] of Object.entries(tally)) assert.equal(checks.body.sales.counts[status], n, status);
  assert.equal(checks.body.sales.outOfPeriod, 5);
  // 期間内だけを選ぶと、期間内の売上が出る
  const inPeriod = await editor.get(`/partner-lists/checks?asOf=${AS_OF}&from=2024-01&to=2026-12&status=in_period`);
  assert.equal(inPeriod.body.sales.rows.length, 3);
  // 計上月で比べると、2027-07 の販売期間でも計上月 2026-09 は期間内
  const byMonth = await editor.get(`/partner-lists/checks?asOf=${AS_OF}&from=2024-01&to=2026-12&basis=accounting`);
  assert.ok(!byMonth.body.sales.rows.some((row) => row.sale_id === Number(Object.keys(expected).find((id) => expected[id] === 'after_end'))));
});
