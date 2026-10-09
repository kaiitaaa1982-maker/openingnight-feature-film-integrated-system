// 営業基幹「提案資料」の API（src/sales-ops/release-proposal-routes.mjs）の試験。組織1の架空 fixture に API で窓・契約を足して確かめる。
// 壊れたときに分かること: 権限（制作担当・案件の閲覧権限・別組織）、月別の件数と Excel・CSV の中身（見出し・件数・書式・隠しシート・枠の固定）、
// SVOD の提案金額、提案資料に出す作品情報の版（照合・検証・監査・変更と削除の禁止・組織の外の行）、D1 の上限（1文の値・batch の文・1行の大きさ）。
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync, strFromU8} from 'fflate';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {PROFILE_FIELDS} from '../src/sales-ops/release-proposal-routes.mjs';

let db, app, as, ids = {};
const D1 = {params: 100, statements: 480, rowBytes: 128 * 1024};
const captured = [];

async function login(email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())};
  };
  return {get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload)};
}

before(async (t) => {
  db = await openTestDb({t});
  // 書き込みの batch を記録する（D1 の上限の確認用）
  const batch = db.batch.bind(db);
  db.batch = async (statements) => { captured.push(statements); return batch(statements); };
  app = createApp({db, mode: 'local'});
  as = {admin: await login('admin@openingnight.invalid'), editor: await login('editor@openingnight.invalid'), production: await login('production@openingnight.invalid'), outsider: await login('outsider@other.invalid')};
  assert.equal((await as.admin.post('/release-window-types/adopt', {reason: '試験で初期の種別を採用'})).status, 201);
  const types = new Map((await as.admin.get('/release-window-types')).body.types.map((t) => [t.type_key, t.id]));
  // 編集担当が見られない案件と作品
  const project = await as.admin.post('/projects', {code: 'PRJ-HIDDEN', title: '見えない案件（架空）', status: 'active', budget_yen: 1000000});
  ids.hidden = (await as.admin.post('/works', {project_id: project.body.id, code: 'WRK-HIDDEN', title: '見えない作品（架空）', format: 'film'})).body.id;
  const put = async (workId, typeKey, start, extra = {}) => {
    const res = await as.admin.post('/release-windows', {workId, typeId: types.get(typeKey), baseVersion: 0, start, end: extra.end || '', announce: '', status: extra.status || 'draft', fields: extra.fields || {}, reason: '試験の窓（架空）'});
    assert.equal(res.status, 201, JSON.stringify(res.body));
  };
  await put(1, 'pvod_early', '2026-10-15', {end: '2026-11-14', status: 'confirmed', fields: {price_ex_tax: '2500', viewing_hours: '48', exclusivity: 'nonexclusive'}});
  await put(1, 'tvod_regular', '2026-10-01', {end: '2029-09-30'});
  await put(1, 'est_early', '2026-10');
  await put(1, 'tvod_early', '2026');
  await put(1, 'svod_regular', '2027-01-01', {end: '2028-12-31', fields: {price_ex_tax: '50000', exclusivity: 'nonexclusive'}});
  await put(ids.hidden, 'pvod_early', '2026-10-20', {status: 'confirmed'});
  // SVOD の契約（架空配信 = 取引先2 と WRK-DEMO、2026-12-31 に終わる）
  const list = await as.admin.post('/partner-lists', {partnerId: 2, listKind: 'distribution', name: '見放題の配信リスト（架空）', reason: '試験の取引先別リスト'});
  assert.equal(list.status, 201, JSON.stringify(list.body));
  const entry = await as.admin.post(`/partner-lists/${list.body.id}/entries`, {workId: 1, reason: '試験の契約', values: {distribution_code: 'D005', territory: '日本', contract_start: '2026-01-01',
    contract_end: '2026-12-31', end_rule: 'date', status: 'contracted', exclusivity: 'nonexclusive', settlement_method: 'RS', rate_percent: '50', amount_ex_tax: '', fields: {}}});
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
});

test('月別の件数: 管理者は全案件、編集担当は閲覧権限のある案件の作品だけを数え、制作担当は 403、別組織には組織1の窓が出ない', async () => {
  const admin = (await as.admin.get('/release-proposals')).body;
  const count = (body, key, month) => body.bases.find((b) => b.key === key).months.find((m) => m.month === month)?.count || 0;
  assert.deepEqual(admin.bases.map((b) => b.label), ['PVOD基準', 'TVOD基準', 'TVOD先行基準', 'EST先行基準', 'EST基準']);
  assert.equal(count(admin, 'pvod', '2026-10'), 2);
  assert.equal(count(admin, 'est_early', '2026-10'), 1, '月までの窓もその月に数える');
  assert.equal(count(admin, 'tvod_early', '2026-10'), 0, '年までの窓は月に数えない');
  const editor = (await as.editor.get('/release-proposals')).body;
  assert.equal(count(editor, 'pvod', '2026-10'), 1);
  assert.equal((await as.editor.get('/release-proposals/pvod?month=2026-10')).body.rows.some((r) => r.work_code === 'WRK-HIDDEN'), false);
  for (const path of ['/release-proposals', '/release-proposals/pvod?month=2026-10', '/release-proposals/pvod/export.xlsx?month=2026-10', '/svod-proposals', '/svod-proposals/export.csv']) {
    assert.equal((await as.production.get(path)).status, 403, path);
  }
  const other = await as.outsider.get('/release-proposals/pvod?month=2026-10');
  assert.equal(other.status, 409, '別組織は種別を採用していない');
  assert.equal((await as.outsider.get('/release-proposals')).body.bases.every((b) => b.total === 0), true);
  assert.equal((await as.admin.get('/release-proposals?status=confirmed')).body.bases.find((b) => b.key === 'tvod').total, 0, '確定だけにすると予定の TVOD は数えない');
});

test('月別の表: 対象月の窓だけが解禁日の順に並び、年までの窓は「月が決まっていない候補」、間違った基準・月は断る', async () => {
  const pvod = (await as.admin.get('/release-proposals/pvod?month=2026-10')).body;
  assert.deepEqual(pvod.rows.map((r) => [r.work_code, r.basis_start, r.basis_status]), [['WRK-DEMO', '2026-10-15', '確定'], ['WRK-HIDDEN', '2026-10-20', '確定']]);
  assert.equal(pvod.rows[0]['pvod_early:field:price_ex_tax'], 2500);
  assert.equal(pvod.rows[0]['tvod_regular:start'], '2026-10-01');
  assert.equal(pvod.fileName, '提案資料_PVOD基準_2026-10.xlsx');
  const early = (await as.admin.get('/release-proposals/tvod_early?month=2026-10')).body;
  assert.equal(early.count, 0);
  assert.deepEqual(early.undated.map((u) => u.work_code), ['WRK-DEMO']);
  assert.match(early.undated[0].text, /TVOD先行・2026年（予定）/);
  assert.equal((await as.admin.get('/release-proposals/avod?month=2026-10')).status, 404);
  assert.equal((await as.admin.get('/release-proposals/pvod?month=2026-13')).status, 400);
  assert.equal((await as.admin.get('/release-proposals/pvod?month=2026-10&status=planned')).status, 400);
});

test('月別の Excel: 提案リスト（1行目が見出し・見出しの下で固定・日付と価格の書式）・_条件・非表示の _meta、CSV は BOM 付きで同じ見出しと行', async () => {
  const json = (await as.admin.get('/release-proposals/pvod?month=2026-10')).body;
  const res = await as.admin.get('/release-proposals/pvod/export.xlsx?month=2026-10');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), new RegExp(encodeURIComponent('提案資料_PVOD基準_2026-10.xlsx')));
  const sheets = decodeXlsx(res.body);
  assert.deepEqual(sheets.map((s) => s.name), ['提案リスト', '_条件', '_meta']);
  const [header, ...rows] = sheets[0].rows;
  assert.deepEqual(header, json.columns.map((c) => c.label));
  assert.equal(rows.length, 2);
  const at = (row, label) => row[header.indexOf(label)];
  assert.equal(at(rows[0], '基準の解禁日'), '2026-10-15', '日付の書式のセル（読み戻すと日付）');
  assert.equal(at(rows[0], 'PVOD先行 販売予定価格（税抜）'), 2500, '価格は数');
  assert.equal(at(rows[0], 'EST先行 解禁日'), '2026年10月', '月までは文字');
  const conditions = Object.fromEntries(sheets[1].rows.slice(1).map(([k, v]) => [k, v]));
  assert.equal(conditions['件数'], '2件');
  assert.match(conditions['空の列の数'], new RegExp(`^${json.emptyColumns.length}列`));
  assert.equal(conditions['空の列'], json.emptyColumns.join('、'));
  const meta = Object.fromEntries(sheets[2].rows.slice(1));
  assert.deepEqual([meta.basis, meta.month, meta.rows], ['pvod', '2026-10', '2']);
  const files = unzipSync(res.body);
  assert.match(strFromU8(files['xl/workbook.xml']), /<sheet name="_meta" sheetId="3" state="hidden"/);
  const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.match(sheet1, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/, '見出しの下で固定（列は固定しない）');
  assert.match(strFromU8(files['xl/styles.xml']), /formatCode="yyyy\/mm\/dd"/);
  const csv = await as.admin.get('/release-proposals/pvod/export.csv?month=2026-10');
  assert.deepEqual([...csv.body.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = new TextDecoder().decode(csv.body).replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], header.map((h) => `"${h}"`).join(','));
});

test('SVOD: 提案先との契約が期間の中に終わる作品は継続、提案金額は月額単価×月数（2027-01〜09 の9か月×50,000円）で、Excel に小計と合計が出る', async () => {
  const body = (await as.admin.get('/svod-proposals?partnerId=2&from=2026-10&to=2027-09')).body;
  assert.equal(body.partner.code, (await db.get('SELECT code FROM partners WHERE id=2')).code);
  assert.deepEqual(body.rows.map((r) => [r.category_label, r.work_code, r.proposal_start, r.proposal_end, r.months, r.unit_price, r.amount]),
    [['継続', 'WRK-DEMO', '2027-01-01', '2027-09-30', 9, 50000, 450000]]);
  assert.deepEqual(body.total, {count: 1, months: 9, amount: 450000, priced: 1});
  // 提案先を省くと SVOD の明細がある取引先が選ばれ、「none」は指定なし（継続は出ない）
  assert.equal((await as.admin.get('/svod-proposals?from=2026-10&to=2027-09')).body.partner.id, 2);
  const none = (await as.admin.get('/svod-proposals?partnerId=none&from=2026-10&to=2027-09')).body;
  assert.deepEqual(none.rows.map((r) => `${r.category_label}:${r.work_code}`), ['新規:WRK-DEMO'], '指定なしでは契約を見ずに SVOD の窓だけで新規になる');
  const xlsx = await as.admin.get('/svod-proposals/export.xlsx?partnerId=2&from=2026-10&to=2027-09');
  const sheets = decodeXlsx(xlsx.body);
  assert.deepEqual(sheets.map((s) => s.name), ['SVOD提案', '_条件', '_meta']);
  const [header, ...rows] = sheets[0].rows.filter((row) => row.length);
  const amountAt = header.indexOf('提案金額（税抜）');
  assert.deepEqual(rows.map((r) => [r[0], r[amountAt]]), [['継続', 450000], ['継続 小計（1件）', 450000], ['合計（1件）', 450000]]);
  assert.equal((await as.admin.get('/svod-proposals?partnerId=2&from=2027-09&to=2026-10')).status, 400);
  assert.equal((await as.admin.get('/svod-proposals?partnerId=999&from=2026-10&to=2027-09')).status, 404);
  const csv = await as.admin.get('/svod-proposals/export.csv?partnerId=2&from=2026-10&to=2027-09');
  assert.deepEqual([...csv.body.slice(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('提案資料に出す作品情報: 版を1から積み、古い版からの登録・URL の形・画像の二重指定を断り、監査に残して提案資料の列に出る', async () => {
  const empty = (await as.admin.get('/work-proposal-profiles/1')).body;
  assert.deepEqual([empty.profile, empty.versions.length, empty.canEdit], [null, 0, true]);
  const input = {baseRevision: 0, title_kana: 'カゼノアトサキ', title_en: 'After the Wind', genre: 'ドラマ', copyright_notice: '©2026 架空（架空）', info_url: 'https://example.invalid/works/1',
    image_key: 'demo/key-visual/WRK-DEMO.jpg', image_file_name: 'WRK-DEMO.jpg', source_reference: '試験の宣伝資料'};
  const first = await as.admin.post('/work-proposal-profiles/1', input);
  assert.equal(first.status, 201);
  assert.equal(first.body.revision, 1);
  assert.equal((await as.admin.post('/work-proposal-profiles/1', input)).status, 409, '第0版からの登録は2回目で止まる');
  assert.equal((await as.admin.post('/work-proposal-profiles/1', {...input, baseRevision: 1, info_url: 'example.invalid/works'})).status, 400);
  assert.equal((await as.admin.post('/work-proposal-profiles/1', {...input, baseRevision: 1, image_url: 'https://example.invalid/a.jpg'})).status, 400);
  assert.equal((await as.admin.post('/work-proposal-profiles/1', {...input, baseRevision: 1, source_reference: ' '})).status, 400);
  const second = await as.editor.post('/work-proposal-profiles/1', {...input, baseRevision: 1, genre: 'ヒューマンドラマ', source_reference: '編集担当が直した'});
  assert.equal(second.status, 201);
  const latest = (await as.admin.get('/work-proposal-profiles/1')).body;
  assert.deepEqual([latest.profile.revision, latest.profile.genre, latest.versions.length], [2, 'ヒューマンドラマ', 2]);
  assert.equal((await as.admin.get('/work-proposal-profiles/1?revision=1')).body.profile.genre, 'ドラマ');
  const audit = await db.all("SELECT action,entity_id FROM audit_log WHERE entity_type='work_proposal_profile' ORDER BY id");
  assert.deepEqual(audit.map((a) => `${a.action}:${a.entity_id}`), ['create:1', 'version:1']);
  const row = (await as.admin.get('/release-proposals/pvod?month=2026-10')).body.rows.find((r) => r.work_code === 'WRK-DEMO');
  assert.deepEqual([row.title_kana, row.genre, row.image_ref, row.image_file_name], ['カゼノアトサキ', 'ヒューマンドラマ', 'demo/key-visual/WRK-DEMO.jpg', 'WRK-DEMO.jpg']);
});

test('提案資料に出す作品情報の権限と表の決まり: 見えない作品・制作担当・別組織は直せず、行の変更・削除と組織の外の作品は DB が断る', async () => {
  const input = {baseRevision: 0, title_kana: 'ミエナイ', source_reference: '試験'};
  assert.equal((await as.editor.post(`/work-proposal-profiles/${ids.hidden}`, input)).status, 403);
  assert.equal((await as.editor.get(`/work-proposal-profiles/${ids.hidden}`)).status, 403);
  assert.equal((await as.production.post('/work-proposal-profiles/1', input)).status, 403);
  const readOnly = await as.production.get('/work-proposal-profiles/1');
  assert.equal(readOnly.status, 200, '制作担当は作品・商品マスタで読める');
  assert.equal(readOnly.body.canEdit, false);
  assert.equal((await as.outsider.get('/work-proposal-profiles/1')).status, 403);
  assert.equal((await as.outsider.post('/work-proposal-profiles/1', input)).status, 403);
  await assert.rejects(db.run("UPDATE work_proposal_profiles SET genre='x'"), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run('DELETE FROM work_proposal_profiles'), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  // 組織2の行から組織1の作品を指せない（外部キー）
  await assert.rejects(db.run('INSERT INTO work_proposal_profiles(org_id,work_id,revision,source_reference,created_by) VALUES(2,1,1,?,4)', ['組織の外']), (e) => e.dbError?.kind === 'foreign_key');
  // 版の飛ばし・重ねはトリガーが断る
  await assert.rejects(db.run('INSERT INTO work_proposal_profiles(org_id,work_id,revision,source_reference,created_by) VALUES(1,1,9,?,1)', ['飛ばし']), (e) => e.dbError?.kind === 'raise' && /stale/.test(e.message));
});

test('D1 の上限: 作品情報の登録は3文・1文の値は100個未満で、全項目を上限まで入れた行も128KB未満。提案資料の読み取りは作品IDを並べない', async () => {
  const max = Object.fromEntries(PROFILE_FIELDS.map(([key, , limit]) => [key, 'あ'.repeat(limit)]));
  Object.assign(max, {info_url: `https://example.invalid/${'a'.repeat(1000 - 24)}`, image_url: '', image_key: `k/${'a'.repeat(298)}`});
  const before = captured.length;
  const res = await as.admin.post(`/work-proposal-profiles/${ids.hidden}`, {...max, baseRevision: 0, source_reference: 'あ'.repeat(1000)});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const batches = captured.slice(before);
  assert.equal(batches.length, 1);
  assert.ok(batches[0].length <= D1.statements);
  for (const statement of batches[0]) assert.ok(statement.params.length < D1.params, statement.sql.slice(0, 60));
  const row = await db.get('SELECT * FROM work_proposal_profiles WHERE org_id=1 AND work_id=? AND revision=1', [ids.hidden]);
  const bytes = Object.values(row).reduce((n, value) => n + new TextEncoder().encode(String(value ?? '')).byteLength, 0);
  assert.ok(bytes < D1.rowBytes, `${bytes} bytes`);
  assert.ok(bytes > 20000, '上限まで入れた行（日本語は1文字3バイト）');
  // 読み取りの文に作品IDの並び（IN (?,?,…)）が無い
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/sales-ops/release-proposal-routes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /IN \(\$\{|IN \(\?,/);
});

test('SVOD: 前倒しの再契約（renewsEntryId）を登録すると継続から外れ、継続の小計がその行の分だけ減る。提案先の選択肢は明細のある取引先が先で自社は出さない', async () => {
  const before = (await as.admin.get('/svod-proposals?partnerId=2&from=2026-10&to=2027-09')).body;
  assert.equal(before.subtotals.renewal.amount, 450000);
  // 選択肢: SVOD の明細がある取引先（取引先2）が先頭で group は svod。自社（会社の設定の自社を表す取引先）は出さない
  assert.equal(before.partners[0].id, 2);
  assert.equal(before.partners[0].group, 'svod');
  assert.ok(before.partners.slice(1).every((p) => p.svodContracts === 0));
  assert.equal((await as.admin.post('/pl-bs/profile-versions', {legalName: '架空試作映像（架空）', selfPartnerId: 1, baseVersion: 0, reason: '自社を表す取引先（試験・架空）'})).status, 201);
  assert.ok(!(await as.admin.get('/svod-proposals?partnerId=2&from=2026-10&to=2027-09')).body.partners.some((p) => p.id === 1), '自社は提案先の選択肢に出さない');
  // 再契約: 前の契約（〜2026-12-31）の終了日より前の 2026-12-01 から2年
  const list = (await db.get('SELECT e.list_id, e.id FROM partner_list_entries e JOIN partner_lists l ON l.org_id=e.org_id AND l.id=e.list_id WHERE e.org_id=1 AND l.partner_id=2 AND e.work_id=1'));
  const renewal = await as.admin.post(`/partner-lists/${list.list_id}/entries`, {workId: 1, renewsEntryId: list.id, reason: '前倒しの再契約（試験・架空）', values: {distribution_code: 'D005', territory: '日本',
    contract_start: '2026-12-01', contract_end: '2028-11-30', end_rule: 'date', status: 'contracted', exclusivity: 'nonexclusive', settlement_method: 'RS', rate_percent: '50', amount_ex_tax: '', fields: {}}});
  assert.equal(renewal.status, 201, JSON.stringify(renewal.body));
  const after = (await as.admin.get('/svod-proposals?partnerId=2&from=2026-10&to=2027-09')).body;
  assert.deepEqual(after.rows.filter((r) => r.category === 'renewal'), [], '再契約で続いているので継続にしない');
  assert.equal(after.subtotals.renewal.amount, before.subtotals.renewal.amount - 450000);
  // 期間の年が 2000 年より前（打ちかけの値）は、60か月の検査を月の通し番号で比べて断る
  assert.equal((await as.admin.get('/svod-proposals?from=0002-10&to=2027-09')).status, 400);
});

test('月別: 時期の原文「2026年度下期」の窓は翌年の月（2027-02）の「月が決まっていない候補」に出て、年度の次の月（2027-04）には出ない。_条件に決め方を書く', async () => {
  const types = new Map((await as.admin.get('/release-window-types')).body.types.map((t) => [t.type_key, t.id]));
  const res = await as.admin.post('/release-windows', {workId: 1, typeId: types.get('est_regular'), baseVersion: 0, start: '2026年度下期', end: '', announce: '', status: 'draft', fields: {}, reason: '試験の窓（架空）'});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const undated = async (month) => (await as.admin.get(`/release-proposals/est?month=${month}`)).body.undated.map((u) => u.text);
  assert.deepEqual(await undated('2027-02'), ['WRK-DEMO 風のあとさき・EST通常・2026年度下期（予定）']);
  assert.deepEqual(await undated('2026-11'), ['WRK-DEMO 風のあとさき・EST通常・2026年度下期（予定）'], '原文の年（2026）の月にも前から出る');
  assert.deepEqual(await undated('2027-04'), []);
  const sheets = decodeXlsx((await as.admin.get('/release-proposals/est/export.xlsx?month=2027-02')).body);
  const conditions = sheets.find((s) => s.name === '_条件').rows.map((row) => row.join('：'));
  assert.ok(conditions.some((row) => row.includes('翌年の月にも出る')), conditions.join('\n'));
  assert.ok(conditions.some((row) => row.includes('WRK-DEMO 風のあとさき・EST通常・2026年度下期（予定）')));
});
