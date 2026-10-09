import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerSalesImportRoutes, buildSelection} from '../src/import/sales-import-routes.mjs';
import {buildDefinition, defaultFields, guessPeriod} from '../src/import/wizard-model.mjs';

// デモの配信報告と同じ形の架空の表（抽出結果）。8行目は「総額 − PF手数料 ≠ 正味売上」の不良行。
const HEADERS = ['作品CD', '商品ｺｰﾄﾞ', '配信区分', '対象月', '視聴/契約数', '単価(税抜)', '総額', 'PF手数料', '正味売上', '備考'];
const DATA = [
  ['WRK-DEMO', 'SKU-DIGI', 'TVOD', '2026/08', '1250', '420', '525000', '157500', '367500', '正常'],
  ['WRK-DEMO', 'SKU-DIGI', 'SVOD', '2026/08', '1', '480000', '480000', '0', '480000', '月額固定・正常'],
  ['WRK-DEMO', 'SKU-DIGI', 'EST', '2026/08', '320', '1200', '384000', '76800', '307200', '正常'],
  ['WRK-DEMO', '', 'TVOD', '2026/08', '45', '500', '22500', '6750', '16000', '要修正: 商品コード欠落・正味額不一致'],
];
const sheetOf = (data) => [['配信プラットフォーム風 売上報告（架空）', '', '', '', '', '', '', '', '', ''], ['非公式・架空データ', '', '', '', '', '', '', '', '', ''], ['対象期間: 2026-08', '', '', '', '', '', '', '', '', ''], HEADERS, ...data];
const CHECK = {type: 'difference', left: '総額', right: 'PF手数料', result: '正味売上'};

async function fixture({t, mode = 'local', perRequestAuth = false} = {}) {
  const db = await openTestDb({t});
  const sheets = new Map();
  const extractDocument = async ({name, base64}) => {
    const bytes = Buffer.from(base64, 'base64');
    return {extractorName: 'test', extractorVersion: '1', rawSha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, name, documentType: 'workbook', status: 'extracted', text: '', sheets: [{name: 'Details', rows: sheets.get(bytes.toString('utf8'))}]};
  };
  const identity = {org_id: 1, user_id: 1, role: 'admin', email: 'admin@openingnight.invalid', expires_at: null};
  // perRequestAuth: 本番のサーバーと同じく、受け取った Request そのものに結び付けた利用者だけを認める
  const known = new WeakSet();
  const authenticate = perRequestAuth ? async (request) => (known.has(request) ? identity : null) : async () => identity;
  const app = createApp({db, mode, extractDocument, authenticate});
  registerSalesImportRoutes(app, app.ux);
  const cookies = {};
  async function login(email) {
    if (mode !== 'local') return '';
    if (!cookies[email]) {
      const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
      cookies[email] = response.headers.get('set-cookie').split(';')[0];
    }
    return cookies[email];
  }
  async function call(path, body, email = 'admin@openingnight.invalid') {
    const cookie = await login(email);
    if (perRequestAuth) {
      const request = new Request(`http://local.test/api${path}`, {method: body ? 'POST' : 'GET', headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
      known.add(request);
      const response = await app.fetch(request);
      return {status: response.status, data: await response.json()};
    }
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  }
  async function upload(label, data) {
    sheets.set(label, sheetOf(data));
    const result = await call('/workflow/artifacts/extract', {kind: 'sales_report', workId: 1, name: `${label}.xlsx`, base64: Buffer.from(label).toString('base64')});
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  return {db, app, call, upload};
}

function definitionFor(reportKey, {correction = null} = {}) {
  const headers = HEADERS;
  const {fields} = defaultFields({headers, sampleRows: DATA, productIds: [1], period: guessPeriod(headers, DATA)});
  fields.recognition_basis_id = {mode: 'literal', value: '2', source: '', operands: ['', '']};
  fields.basis_date = {mode: 'literal', value: '2026-09-05', source: '', operands: ['', '']};
  fields.basis_reason = {mode: 'literal', value: '月次報告を受領した月で計上', source: '', operands: ['', '']};
  fields.tax_amount = {mode: 'zero', value: '', source: '', operands: ['', '']};
  fields.amount_inc_tax = {mode: 'same_ex', value: '', source: '', operands: ['', '']};
  const built = buildDefinition(fields, {headers, partnerId: 2, autoKey: reportKey, correction});
  assert.deepEqual(built.errors, []);
  return built.definition;
}

async function prepare(f, label, data, reportKey, options) {
  const artifact = await f.upload(label, data);
  const profile = (await f.call('/sales-import/context?workId=1&partnerId=2&kind=digital')).data.profile
    || (await f.call('/mapping-profiles', {partnerId: 2, kind: 'digital', name: '架空配信｜配信'})).data;
  const version = await f.call(`/mapping-profiles/${profile.id ?? profile.profileId}/versions`, definitionFor(reportKey, options));
  assert.equal(version.status, 201, JSON.stringify(version.data));
  return {artifact, versionId: version.data.mappingVersionId};
}

async function previewOf(f, artifactId, versionId, excludedRows = []) {
  const selection = await f.call(`/sales-import/artifacts/${artifactId}/selection`, {sheetName: 'Details', headerRow: 4, excludedRows, mappingVersionId: versionId});
  assert.equal(selection.status, 201, JSON.stringify(selection.data));
  const preview = await f.call('/mapped-imports/preview', {workId: 1, mappingVersionId: versionId, text: selection.data.canonicalCsv, workflowSelectionId: selection.data.selectionId});
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  return {selection: selection.data, preview: preview.data};
}

test('FR-REV-INTAKE-009 FR-REV-INTAKE-010 FR-REV-INTAKE-011 取り込まない行は理由が必須で、除いた行番号・理由・件数・金額が監査と登録結果に残る。検算に合わない行が残る間は登録できない', async (t) => {
  const f = await fixture({t});
  const {artifact, versionId} = await prepare(f, 'demo-a', DATA, 'PT-DIGITAL-202608-a');
  const first = await previewOf(f, artifact.artifactId, versionId);
  assert.deepEqual(first.selection.sourceRowNumbers, [5, 6, 7, 8]);
  assert.equal(first.preview.ok, true, '8行目はサーバーの検証だけでは通ってしまう');
  const blocked = await f.call('/sales-import/commit', {token: first.preview.token, checks: [CHECK]});
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.data.details.map((row) => row.row), [8]);
  assert.match(blocked.data.details[0].message, /15,750.*16,000/);
  assert.equal((await f.db.get('SELECT count(*) n FROM report_imports')).n, 0);

  const noReason = await f.call(`/sales-import/artifacts/${artifact.artifactId}/selection`, {sheetName: 'Details', headerRow: 4, excludedRows: [{sourceRow: 8, reason: ' '}]});
  assert.equal(noReason.status, 400);
  assert.match(noReason.data.error, /理由/);
  assert.equal((await f.call(`/sales-import/artifacts/${artifact.artifactId}/selection`, {sheetName: 'Details', headerRow: 4, excludedRows: [{sourceRow: 3, reason: '表題'}]})).status, 400, '見出しより上の行は指定できない');
  assert.equal((await f.call(`/sales-import/artifacts/${artifact.artifactId}/selection`, {sheetName: 'Details', headerRow: 4, excludedRows: [5, 6, 7, 8].map((sourceRow) => ({sourceRow, reason: '全部'}))})).status, 400, '全行は除けない');

  const second = await previewOf(f, artifact.artifactId, versionId, [{sourceRow: 8, reason: '正味額が総額−手数料と合わないため取引先に確認中'}]);
  assert.deepEqual(second.selection.sourceRowNumbers, [5, 6, 7]);
  assert.deepEqual(second.selection.excluded.rows, [{sourceRow: 8, reason: '正味額が総額−手数料と合わないため取引先に確認中', amountExTax: 16000, taxAmount: 0, amountIncTax: 16000}]);
  assert.equal(second.selection.excluded.count, 1);
  const audit = await f.db.get("SELECT * FROM audit_log WHERE action='exclude_rows' AND entity_id=?", [String(second.selection.selectionId)]);
  assert.ok(audit, '除外は監査に残る');
  assert.equal(JSON.parse(audit.detail_json).totals.amountExTax, 16000);
  assert.equal(second.preview.rows.length, 3);
  assert.equal(second.preview.rows.reduce((sum, row) => sum + row.data.amount_ex_tax, 0), 1154700);

  const overlaps = await f.call(`/sales-import/overlaps?token=${second.preview.token}`);
  assert.equal(overlaps.status, 200);
  assert.deepEqual(overlaps.data.overlaps, []);
  const committed = await f.call('/sales-import/commit', {token: second.preview.token, checks: [CHECK]});
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  assert.ok(committed.data.reportId);
  assert.equal(committed.data.auditWarning, null);

  const result = await f.call(`/sales-import/reports/${committed.data.reportId}`);
  assert.equal(result.status, 200);
  assert.equal(result.data.report.lineCount, 3);
  assert.deepEqual(result.data.report.totals, {amountExTax: 1154700, taxAmount: 0, amountIncTax: 1154700});
  assert.equal(result.data.report.partnerName, '架空配信');
  assert.equal(result.data.exclusions.count, 1);
  assert.equal(result.data.exclusions.rows[0].sourceRow, 8);
  assert.equal(result.data.exclusions.amountExTax, 16000);
  assert.deepEqual(result.data.decision.checks, [CHECK]);
  assert.equal(result.data.source.headerRow, 4);
  assert.equal(result.data.source.fileName, 'demo-a.xlsx');
  const log = JSON.parse((await f.db.get("SELECT detail_json FROM audit_log WHERE action='sales_import'")).detail_json);
  assert.equal(log.excluded.count, 1);
  assert.equal(log.excluded.rows[0].reason, '正味額が総額−手数料と合わないため取引先に確認中');

  const context = await f.call('/sales-import/context?workId=1&partnerId=2&kind=digital');
  assert.equal(context.data.previous.id, committed.data.reportId);
  assert.equal(context.data.previous.lineCount, 3);
  assert.deepEqual(context.data.checks, [CHECK], '前回の検算を次の取込の初期値にできる');
  assert.equal(context.data.mapping.id, versionId);
  assert.deepEqual(context.data.pending, [], '登録済みの原本は再開の候補に出ない');
  const hash = createHash('sha256').update('demo-a').digest('hex');
  const lookup = await f.call(`/sales-import/artifacts/lookup?sha256=${hash}`);
  assert.equal(lookup.data.artifact.committed, true);
  assert.equal(lookup.data.artifact.reportId, committed.data.reportId);
  assert.equal((await f.call(`/sales-import/artifacts/${artifact.artifactId}/selection`, {sheetName: 'Details', headerRow: 4})).status, 409, '登録済みの原本は選び直せない');
});

test('FR-REV-INTAKE-029 FR-REV-INTAKE-030 重複検出: 同じ取引先・報告の種類で対象期間が重なる報告があると、訂正版か理由つきの別報告を選ぶまで登録しない', async (t) => {
  const f = await fixture({t});
  const a = await prepare(f, 'demo-a', DATA.slice(0, 3), 'PT-DIGITAL-202608-a');
  const aPreview = await previewOf(f, a.artifact.artifactId, a.versionId);
  const aCommit = await f.call('/sales-import/commit', {token: aPreview.preview.token});
  assert.equal(aCommit.status, 200, JSON.stringify(aCommit.data));

  const changed = DATA.slice(0, 3).map((row, index) => (index === 0 ? [...row.slice(0, 8), '367000', row[9]] : row));
  const b = await prepare(f, 'demo-b', changed, 'PT-DIGITAL-202608-b');
  const bPreview = await previewOf(f, b.artifact.artifactId, b.versionId);
  const overlaps = await f.call(`/sales-import/overlaps?token=${bPreview.preview.token}`);
  assert.deepEqual(overlaps.data.overlaps.map((row) => row.id), [aCommit.data.reportId]);
  assert.equal(overlaps.data.overlaps[0].lineCount, 3);
  const refused = await f.call('/sales-import/commit', {token: bPreview.preview.token});
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /訂正版として取り込むか、別の報告として取り込むか/);
  assert.equal((await f.call('/sales-import/commit', {token: bPreview.preview.token, decision: {mode: 'separate', reason: '  '}})).status, 409, '理由なしの別報告は止める');
  assert.equal((await f.call('/sales-import/commit', {token: bPreview.preview.token, decision: {mode: 'supersede'}})).status, 409, '訂正元を指定していない版では訂正版にできない');
  assert.equal((await f.db.get('SELECT count(*) n FROM report_imports')).n, 1, '止めている間は登録されない');
  const separate = await f.call('/sales-import/commit', {token: bPreview.preview.token, decision: {mode: 'separate', reason: '同じ月に追加分の報告を別に受領したため'}});
  assert.equal(separate.status, 200, JSON.stringify(separate.data));
  const decision = (await f.call(`/sales-import/reports/${separate.data.reportId}`)).data.decision;
  assert.equal(decision.mode, 'separate');
  assert.equal(decision.reason, '同じ月に追加分の報告を別に受領したため');
  assert.deepEqual(decision.overlaps, [aCommit.data.reportId]);

  // 訂正版: 元の報告（a）の報告番号と訂正元を持つ版。ほかにも重なる報告（b）があるので理由も要る
  const fixed = DATA.slice(0, 3).map((row, index) => (index === 2 ? [...row.slice(0, 8), '307000', row[9]] : row));
  const c = await prepare(f, 'demo-c', fixed, 'unused', {correction: {id: aCommit.data.reportId, reportKey: 'PT-DIGITAL-202608-a'}});
  const cPreview = await previewOf(f, c.artifact.artifactId, c.versionId);
  assert.equal(cPreview.preview.ok, true, JSON.stringify(cPreview.preview.errors));
  const cOverlaps = await f.call(`/sales-import/overlaps?token=${cPreview.preview.token}`);
  assert.equal(cOverlaps.data.supersedesId, aCommit.data.reportId);
  assert.equal(cOverlaps.data.overlaps.length, 2);
  const needReason = await f.call('/sales-import/commit', {token: cPreview.preview.token, decision: {mode: 'supersede'}});
  assert.equal(needReason.status, 409);
  assert.match(needReason.data.error, /ほかにも重なる報告が1件/);
  const corrected = await f.call('/sales-import/commit', {token: cPreview.preview.token, decision: {mode: 'supersede', reason: 'EST の正味額の訂正版を受領'}});
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal((await f.db.get('SELECT status FROM report_imports WHERE id=?', [aCommit.data.reportId])).status, 'superseded');
  const view = (await f.call(`/sales-import/reports/${corrected.data.reportId}`)).data;
  assert.equal(view.original.id, aCommit.data.reportId);
  assert.equal(view.decision.mode, 'supersede');
  assert.equal((await f.call(`/sales-import/reports/${aCommit.data.reportId}`)).data.replacedBy.id, corrected.data.reportId);
});

test('FR-REV-INTAKE-029 重複検出を条件で直接たずねる: 期間の重なり・種類・取引先で絞り、他作品の重なりは参考として分ける', async (t) => {
  const f = await fixture({t});
  const sale = (key, fields) => f.call('/sales', {workId: 1, report_key: key, kind: 'digital', description: '架空売上', quantity: 1, basis_reason: '架空の根拠', recognition_basis_id: 1, partner_id: 2, product_id: 1, amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100, ...fields});
  assert.equal((await sale('OV-1', {period_from: '2026-08-01', period_to: '2026-08-31', sales_month: '2026-08'})).status, 200);
  assert.equal((await sale('OV-2', {period_from: '2026-07-01', period_to: '2026-07-31', sales_month: '2026-07'})).status, 200);
  const ask = (query, email) => f.call(`/sales-import/overlaps?${query}`, null, email);
  const hit = await ask('workId=1&partnerId=2&kind=digital&from=2026-08-15&to=2026-09-10');
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.data.overlaps.map((row) => row.reportKey), ['OV-1']);
  assert.deepEqual(hit.data.otherWorks, []);
  assert.equal((await ask('workId=1&partnerId=2&kind=digital&from=2026-07-31&to=2026-08-01')).data.overlaps.length, 2, '境界の日も重なりに数える');
  assert.equal((await ask('workId=1&partnerId=2&kind=digital&from=2026-09-01&to=2026-09-30')).data.overlaps.length, 0);
  assert.equal((await ask('workId=1&partnerId=2&kind=package&from=2026-08-01&to=2026-08-31')).data.overlaps.length, 0);
  assert.equal((await ask('workId=1&partnerId=3&kind=digital&from=2026-08-01&to=2026-08-31')).data.overlaps.length, 0);
  assert.equal((await ask('workId=1&partnerId=2&kind=digital&from=2026-08-31&to=2026-08-01')).status, 400);
  assert.equal((await ask('workId=1&partnerId=2&kind=digital&from=2026/08/01&to=2026-08-31')).status, 400);
  assert.equal((await ask('workId=1&partnerId=2&kind=publicity&from=2026-08-01&to=2026-08-31')).status, 400);
  assert.equal((await ask('workId=1&partnerId=2&kind=digital&from=2026-08-01&to=2026-08-31', 'editor@openingnight.invalid')).data.overlaps.length, 1, '編集担当（財務権限あり）');
  assert.equal((await ask('workId=1&partnerId=2&kind=digital&from=2026-08-01&to=2026-08-31', 'production@openingnight.invalid')).status, 403);
  assert.equal((await ask('workId=1&partnerId=2&kind=digital&from=2026-08-01&to=2026-08-31', 'outsider@other.invalid')).status, 403, '別組織の作品は見えない');
  const reportId = hit.data.overlaps[0].id;
  assert.equal((await f.call(`/sales-import/reports/${reportId}`, null, 'outsider@other.invalid')).status, 404);
  assert.equal((await f.call(`/sales-import/reports/${reportId}`, null, 'production@openingnight.invalid')).status, 403);
  assert.equal((await f.call('/sales-import/context?workId=1', null, 'production@openingnight.invalid')).status, 403);
  assert.equal((await f.call('/sales-import/context?workId=1', null, 'outsider@other.invalid')).status, 403);
  assert.deepEqual((await f.call('/sales-import/context', null, 'outsider@other.invalid')).data.works.map((work) => work.code), ['WRK-OTHER']);
  const context = await f.call('/sales-import/context?workId=1&partnerId=2&kind=digital');
  assert.deepEqual(context.data.recent.map((row) => row.reportKey).sort(), ['OV-1', 'OV-2']);
  assert.equal(context.data.limits.salesRows, 2000);
});

test('上限: Worker（D1）では1回100行まで。超えると理由つきの413', async (t) => {
  const f = await fixture({t, mode: 'worker'});
  const many = Array.from({length: 101}, (_, index) => ['WRK-DEMO', 'SKU-DIGI', 'TVOD', '2026/08', '1', '100', '100', '0', '100', `行${index + 1}`]);
  const artifact = await f.upload('many', many);
  const selection = await f.call(`/sales-import/artifacts/${artifact.artifactId}/selection`, {sheetName: 'Details', headerRow: 4});
  assert.equal(selection.status, 413);
  assert.match(selection.data.error, /100行まで/);
  assert.match(selection.data.error, /クラウド環境/);
  const limits = await f.call('/sales-import/limits');
  assert.deepEqual(limits.data.limits, {salesRows: 100, bulkRows: 200, bytes: 200000, batchStatements: 480, reportBytes: 128000, sourceRows: 2000, sourceBytes: 2000000});
  const fewer = await f.call(`/sales-import/artifacts/${artifact.artifactId}/selection`, {sheetName: 'Details', headerRow: 4, excludedRows: [{sourceRow: 105, reason: '上限に合わせて次回に回す'}]});
  assert.equal(fewer.status, 201, '除いて100行にすれば通る');
  assert.equal(fewer.data.sourceRowNumbers.length, 100);
});

test('FR-REV-INTAKE-008 表の選択: 見出しの空欄・重複、右端の空の列、列が足りない行・見出しより右に値がある行を行番号つきで返す', () => {
  const rows = [['題'], ['明細', '金額', '', ''], ['A', '100', '', ''], ['', '', '', ''], ['B', '200', '', '']];
  const ok = buildSelection(rows, 2);
  assert.deepEqual(ok.headers, ['明細', '金額']);
  assert.deepEqual(ok.sourceRowNumbers, [3, 5], '空行は飛ばし、原本の行番号を保つ');
  assert.equal(ok.canonicalCsv, '明細,金額\r\nA,100\r\nB,200');
  const blank = buildSelection([['明細', '', '金額'], ['A', 'x', '1']], 1);
  assert.equal(blank.status, 422);
  assert.equal(blank.details[0].column, 'B');
  const wide = buildSelection([['明細', '金額'], ['A', '1', 'はみ出し'], ['B', '2']], 1);
  assert.equal(wide.status, 422);
  assert.deepEqual(wide.details.map((row) => row.row), [2]);
  assert.equal(buildSelection([['明細', '金額'], ['A', '1', 'はみ出し'], ['B', '2']], 1, [{sourceRow: 2, reason: '注記の行'}]).error, undefined, '除けば通る');
  const short = buildSelection([['明細', '金額', '数量'], ['A', '1']], 1);
  assert.equal(short.status, 422);
  assert.deepEqual(short.details.map((row) => row.row), [2]);
  assert.match(buildSelection(rows, 2, [{sourceRow: 3, reason: 'x'}, {sourceRow: 3, reason: 'y'}]).error, /2回/);
});

test('本番のように要求ごとに利用者を結び付ける環境でも、取込ウィザードの登録が通る（内部で要求を作り直さない）', async (t) => {
  const f = await fixture({t, mode: 'production', perRequestAuth: true});
  const {artifact, versionId} = await prepare(f, 'prod-a', DATA.slice(0, 3), 'PT-DIGITAL-202608-prod');
  const {preview} = await previewOf(f, artifact.artifactId, versionId);
  const committed = await f.call('/sales-import/commit', {token: preview.token, kind: 'digital', partnerId: 2});
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  assert.equal((await f.db.get('SELECT count(*) n FROM report_imports')).n, 1);
});

test('画面で選んでいる報告の種類・取引先が、確認した内容（列対応の版）と違えば登録しない', async (t) => {
  const f = await fixture({t});
  const {artifact, versionId} = await prepare(f, 'kind-a', DATA.slice(0, 3), 'PT-DIGITAL-202608-kind');
  const {preview} = await previewOf(f, artifact.artifactId, versionId);
  const wrongKind = await f.call('/sales-import/commit', {token: preview.token, kind: 'package', partnerId: 2});
  assert.equal(wrongKind.status, 409);
  assert.match(wrongKind.data.error, /「配信」の報告です/);
  const wrongPartner = await f.call('/sales-import/commit', {token: preview.token, kind: 'digital', partnerId: 3});
  assert.equal(wrongPartner.status, 409);
  assert.equal((await f.db.get('SELECT count(*) n FROM report_imports')).n, 0);
  const ok = await f.call('/sales-import/commit', {token: preview.token, kind: 'digital', partnerId: 2});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});
