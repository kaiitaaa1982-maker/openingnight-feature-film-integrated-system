import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {openTestDb} from './test-db.mjs';
import {registerWorkflowRoutes} from '../src/workflow.mjs';
import {registerScriptStructuringRoutes} from '../src/production/script-structuring/script-structuring-routes.mjs';
import {R2LargeValueDatabase} from '../src/cloud-r2-db.mjs';

const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const sha256 = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const bad = (c, error, status = 400, details) => c.json({ok: false, error, details}, status);
const read = (reason = null) => ({status: 'read', reason});

// 架空の台本の読み取り（出どころつき）。2つ目のシーンは「同・」で場所と昼夜を補っている
const scriptExtraction = () => ({
  documentType: 'text', text: '1 駅前（夜）\n2 同・奥の書庫', scriptMeta: {episode: '8', rulesApplied: []},
  scenes: [
    {sceneNo: '8-1', location: '駅前', dayNight: 'N', cast: [], synopsis: '終電間際。', estimatedMinutes: null, pageEighths: 2, reviewNotes: [],
      source: {page: 1, box: {left: 0.7, top: 0.1, width: 0.05, height: 0.3}},
      fields: {sceneNo: read('柱の番号'), location: read(), dayNight: read('柱の末尾の時間帯'), cast: read('セリフの話者がいない'), pageEighths: read('柱から次の柱までの列の数で計算')}},
    {sceneNo: '8-2', location: '駅前・奥の書庫', dayNight: 'N', cast: ['千尋'], synopsis: '', estimatedMinutes: null, pageEighths: 3, reviewNotes: [],
      source: {page: 1, box: {left: 0.4, top: 0.1, width: 0.05, height: 0.2}},
      fields: {sceneNo: read('柱の番号'), location: {status: 'inferred', reason: '「同・」を直前の場所「駅前」で補った'},
        dayNight: {status: 'inferred', reason: '柱に昼夜が無いので、直前のシーン（8-1）の昼夜を引き継いだ'}, cast: read('セリフの話者から（ト書きだけの人物は入らない）'), pageEighths: read('柱から次の柱までの列の数で計算')}},
  ],
});

// 本番の R2 の代わり（test/cloud-r2-db.test.mjs と同じ形）。置いた値をそのまま返す
class Bucket {
  constructor() { this.values = new Map(); }
  async head(key) { const row = this.values.get(key); return row ? {customMetadata: row.metadata} : null; }
  async put(key, value, options) { this.values.set(key, {bytes: new Uint8Array(value), metadata: options.customMetadata}); return {key}; }
  async get(key) { const row = this.values.get(key); return row ? {body: true, arrayBuffer: async () => row.bytes.buffer.slice(row.bytes.byteOffset, row.bytes.byteOffset + row.bytes.byteLength)} : null; }
}

// 読み取りの代わり。.csv は売上報告の表、名前に legacy を含む台本は出どころの無い前の読み取り、ほかは出どころつきの台本
async function fakeExtract({name, base64}) {
  const head = {name, byteLength: Buffer.from(base64, 'base64').length, rawSha256: await sha256(base64), extractorName: 'test-local', status: 'extracted'};
  if (name.endsWith('.csv')) return {...head, extractorVersion: '1', documentType: 'workbook', text: '', sheets: [{name: 'CSV', rows: [['報告番号', '税抜売上'], ['R-1', '1000']]}]};
  if (name.includes('legacy')) return {...head, extractorVersion: 'workflow-extractor-3', ...scriptExtraction(), scenes: scriptExtraction().scenes.map(({fields, source, ...scene}) => scene)};
  return {...head, extractorVersion: 'workflow-extractor-4', ...scriptExtraction()};
}

async function fixture({t, bucket = null}) {
  const raw = await openTestDb({t});
  const db = bucket ? new R2LargeValueDatabase(raw, bucket) : raw;
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    c.set('identity', {org_id: Number(c.req.header('x-org') || 1), user_id: Number(c.req.header('x-user') || 1), role: c.req.header('x-role') || 'admin', noProjects: c.req.header('x-no-projects') === '1'});
    await next();
  });
  // 作品への権限: 組織の案件すべて。x-no-projects の人は案件の権限を持たない
  const permittedProjects = async (_db, identity) => (identity.noProjects ? [] : _db.all('SELECT id FROM projects WHERE org_id=?', [identity.org_id]));
  const settlementWork = async (identity, workId) => db.get('SELECT id,project_id FROM works WHERE org_id=? AND id=?', [identity.org_id, workId]);
  registerWorkflowRoutes(app, {db, bad, body: (c) => c.req.json(), canonical, sha256, nowIso: () => new Date().toISOString(), permittedProjects, settlementWork, extractDocument: fakeExtract});
  registerScriptStructuringRoutes(app, {db, bad, permittedProjects});
  async function req(path, {method = 'GET', payload, headers = {}} = {}) {
    const response = await app.request(`/api${path}`, {method, headers: {'content-type': 'application/json', ...headers}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    return {status: response.status, headers: response.headers, data: await response.json()};
  }
  const original = Buffer.from('%PDF-1.4 架空の台本（第8話）').toString('base64');
  const upload = await req('/workflow/artifacts/extract', {method: 'POST', payload: {kind: 'script', workId: 1, name: 'fukurodo-ep08.pdf', base64: original, mediaType: 'application/pdf'}});
  assert.equal(upload.status, 201);
  return {db, raw, req, original, artifactId: upload.data.artifactId};
}

test('FR-PROD-STRUCT-007 原本は同じ組織で作品への権限がある人にだけ返し、ほかは同じ 403 で断る', async (t) => {
  const {req, original, artifactId} = await fixture({t});
  const ok = await req(`/workflow/scripts/${artifactId}/original`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.base64, original);
  assert.equal(ok.data.fileName, 'fukurodo-ep08.pdf');
  assert.equal(ok.data.mediaType, 'application/pdf');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const otherOrg = await req(`/workflow/scripts/${artifactId}/original`, {headers: {'x-org': '2'}});
  assert.equal(otherOrg.status, 403);
  assert.equal(otherOrg.data.error, '台本原本への権限がありません');
  assert.equal(otherOrg.data.base64, undefined);
  const noProject = await req(`/workflow/scripts/${artifactId}/original`, {headers: {'x-no-projects': '1'}});
  assert.equal(noProject.status, 403);
  assert.equal(noProject.data.base64, undefined);
  const missing = await req(`/workflow/scripts/${artifactId + 100}/original`);
  assert.equal(missing.status, 403);
  assert.equal(missing.data.error, '台本原本への権限がありません');
  for (const id of ['abc', '0', '1.5']) assert.equal((await req(`/workflow/scripts/${id}/original`)).status, 400, id);
  // 台本でない原本（売上報告）は、管理者にも制作担当にも返さない（制作担当は売上の原本を扱えない）
  const report = await req('/workflow/artifacts/extract', {method: 'POST', payload: {kind: 'sales_report', workId: 1, name: 'report.csv', base64: Buffer.from('報告番号,税抜売上\nR-1,1000').toString('base64'), mediaType: 'text/csv'}});
  assert.equal(report.status, 201);
  for (const role of ['admin', 'production']) {
    const denied = await req(`/workflow/scripts/${report.data.artifactId}/original`, {headers: {'x-role': role}});
    assert.equal(denied.status, 403, role);
    assert.equal(denied.data.error, '台本原本への権限がありません');
    assert.equal(denied.data.base64, undefined);
  }
});

test('FR-PROD-STRUCT-007 本番と同じく原本を R2 に置いても、権限のある人には元の原本を返し、権限の無い人のために R2 を読まない', async (t) => {
  const bucket = new Bucket();
  let reads = 0;
  const get = bucket.get.bind(bucket);
  bucket.get = async (key) => { reads += 1; return get(key); };
  const {raw, req, original, artifactId} = await fixture({t, bucket});
  const stored = await raw.get('SELECT original_base64 FROM workflow_raw_artifacts WHERE id=?', [artifactId]);
  assert.match(stored.original_base64, /^@r2:v1:/);
  reads = 0;
  const denied = await req(`/workflow/scripts/${artifactId}/original`, {headers: {'x-no-projects': '1'}});
  assert.equal(denied.status, 403);
  assert.equal(reads, 0);
  const ok = await req(`/workflow/scripts/${artifactId}/original`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.base64, original);
  assert.equal(reads, 1);
});

test('FR-PROD-STRUCT-006 FR-PROD-STRUCT-008 確かめていない補った値があると承認を 409 で断り、確かめた項目を版に残す', async (t) => {
  const {db, req, artifactId} = await fixture({t});
  const scenes = scriptExtraction().scenes.map((s, i) => ({sceneNo: s.sceneNo, location: s.location, dayNight: s.dayNight, cast: s.cast, synopsis: s.synopsis, estimatedMinutes: 60, pageEighths: s.pageEighths, extractionIndex: i, checked: []}));
  const review = (body) => req(`/workflow/scripts/${artifactId}/review`, {method: 'PUT', payload: body});

  const none = await review({scenes});
  assert.equal(none.status, 409);
  assert.deepEqual(none.data.details.unchecked, [{sceneNo: '8-2', field: 'location'}, {sceneNo: '8-2', field: 'dayNight'}]);
  assert.match(none.data.error, /S#8-2の場所、S#8-2の昼夜/);

  // 場所だけ確かめた: 昼夜が残る
  const half = await review({scenes: scenes.map((s, i) => (i === 1 ? {...s, checked: ['location']} : s))});
  assert.equal(half.status, 409);
  assert.deepEqual(half.data.details.unchecked, [{sceneNo: '8-2', field: 'dayNight'}]);

  // 場所を確かめ、昼夜を直した（夜→夕）。人が1シーン足した（読み取りに無いので結び付きは null）: 承認できる
  const added = {sceneNo: '8-9', location: '倉庫', dayNight: 'D', cast: [], synopsis: '', estimatedMinutes: 30, pageEighths: null, extractionIndex: null, checked: []};
  const done = await review({scenes: [...scenes.map((s, i) => (i === 1 ? {...s, checked: ['location'], dayNight: 'DN'} : s)), added]});
  assert.equal(done.status, 201);
  const saved = await req(`/workflow/scripts/${artifactId}`);
  const latest = saved.data.reviews[0].scenes;
  assert.deepEqual(latest.map((s) => [s.sceneNo, s.extractionIndex, s.checked]), [['8-1', 0, []], ['8-2', 1, ['location']], ['8-9', null, []]]);
  assert.equal(latest[1].dayNight, 'DN');

  // 同じ内容の承認をくり返しても、最新の版と同じなら新しい版を作らずにその版を返す。前の版と同じ内容は断る
  const approved = [...scenes.map((s, i) => (i === 1 ? {...s, checked: ['location'], dayNight: 'DN'} : s)), added];
  const again = await review({scenes: approved});
  assert.deepEqual([again.status, again.data.reviewId, again.data.versionNo, again.data.unchanged], [200, done.data.reviewId, done.data.versionNo, true]);
  const edited = await review({scenes: approved.map((s, i) => (i === 2 ? {...s, estimatedMinutes: 45} : s))});
  assert.equal(edited.status, 201);
  const back = await review({scenes: approved});
  assert.equal(back.status, 409);
  assert.match(back.data.error, new RegExp(`同じ内容の確認済みの版（第${done.data.versionNo}版）が前にあります`));
  const approvedAgain = await review({scenes: approved.map((s, i) => (i === 2 ? {...s, estimatedMinutes: 30, synopsis: '直した'} : s))});
  assert.equal(approvedAgain.status, 201);

  // この形の版から確定しても、確定のシーンの記録は版のシーンの数と同じ（確定のトリガーが scenes_json を読む）
  const dates = [{date: '2026-10-20', budgetMinutes: 180}];
  const availability = {cast: {千尋: ['2026-10-20']}, locations: {駅前: ['2026-10-20'], '駅前・奥の書庫': ['2026-10-20'], 倉庫: ['2026-10-20']}};
  const preview = await req(`/workflow/scripts/${artifactId}/schedule-preview`, {method: 'POST', payload: {reviewId: approvedAgain.data.reviewId, unit: 'A班', dates, availability}});
  assert.equal(preview.status, 200);
  assert.equal(preview.data.proposal.commitAllowed, true);
  const commit = await req(`/workflow/scripts/${artifactId}/commit`, {method: 'POST', payload: {token: preview.data.token, confirmed: true}});
  assert.equal(commit.status, 201);
  assert.equal(commit.data.sceneCount, 3);
  assert.equal(Number((await db.get('SELECT COUNT(1) n FROM workflow_script_commit_scenes')).n), 3);
  assert.deepEqual((await db.all('SELECT scene_no FROM scenes WHERE org_id=1 AND work_id=1 AND scene_no IN (?,?,?) ORDER BY scene_no', ['8-1', '8-2', '8-9'])).map((r) => r.scene_no), ['8-1', '8-2', '8-9']);

  // 出どころのある原本では、読み取りとの結び付きを送らない版で印の確かめを飛ばせない
  const unlinked = await review({scenes: scenes.map(({extractionIndex, checked, ...s}) => s)});
  assert.equal(unlinked.status, 400);
  assert.match(unlinked.data.error, /extractionIndex/);

  // 読み取りに無いシーンを指す版・知らない項目の確かめは 400
  assert.equal((await review({scenes: scenes.map((s, i) => (i === 1 ? {...s, extractionIndex: 2, checked: ['location', 'dayNight']} : s))})).status, 400);
  assert.equal((await review({scenes: scenes.map((s, i) => (i === 1 ? {...s, checked: ['location', 'dayNight', 'synopsis']} : s))})).status, 400);
  assert.equal((await review({scenes: scenes.map((s, i) => (i === 1 ? {...s, extractionIndex: -1} : s))})).status, 400);
  // 結び付きは 0 以上の整数か null だけ（数字の文字・小数・真偽・空の文字は 400）。2つのシーンが同じ読み取りのシーンを指す版も 400
  for (const value of ['1', 1.5, true, '']) assert.equal((await review({scenes: scenes.map((s, i) => (i === 1 ? {...s, extractionIndex: value, checked: ['location', 'dayNight']} : s))})).status, 400, JSON.stringify(value));
  const twice = await review({scenes: scenes.map((s) => ({...s, extractionIndex: 0}))});
  assert.equal(twice.status, 400);
  assert.equal(twice.data.error, '8-2が、ほかのシーンと同じ読み取りのシーンを指しています');
  // 確かめた項目は文字の配列だけ（["location"] を入れ子にした配列を "location" と読まない）
  assert.equal((await review({scenes: scenes.map((s, i) => (i === 1 ? {...s, checked: [['location'], 'dayNight']} : s))})).status, 400);
});

test('FR-PROD-STRUCT-008 同じ台本の承認が同時に保存されたときは、SQL の文でなく、開き直しを求める 409 を返し、版を1つだけ残す', async (t) => {
  const {db, req, artifactId} = await fixture({t});
  const scenes = scriptExtraction().scenes.map((s, i) => ({sceneNo: s.sceneNo, location: s.location, dayNight: s.dayNight, cast: s.cast, synopsis: s.synopsis, estimatedMinutes: 60, pageEighths: s.pageEighths, extractionIndex: i, checked: i === 1 ? ['location', 'dayNight'] : []}));
  // 受け口が版の番号を決めてから保存するまでの間に、別の人の承認（同じ版の番号・別の内容）が先に保存された
  const run = db.run.bind(db);
  let raced = false;
  db.run = async (sql, params) => {
    if (!raced && /^INSERT INTO workflow_script_reviews\(/.test(sql)) {
      raced = true;
      await run(sql, [params[0] + 1000, ...params.slice(1, 6), `other-${params[6]}`, params[7]]);
    }
    return run(sql, params);
  };
  const clash = await req(`/workflow/scripts/${artifactId}/review`, {method: 'PUT', payload: {scenes}});
  assert.equal(raced, true);
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error, '同じ台本の承認が同時に保存されました。原本を開き直して、最新の版を確かめてください');
  const rows = await db.all('SELECT version_no,review_hash FROM workflow_script_reviews WHERE org_id=1 AND artifact_id=?', [artifactId]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].review_hash, /^other-/);
});

test('FR-PROD-STRUCT-006 FR-PROD-STRUCT-008 前の読み取り（出どころの無い原本）は、結び付きを送らない従来の版のまま保存できる', async (t) => {
  const {req} = await fixture({t});
  const upload = await req('/workflow/artifacts/extract', {method: 'POST', payload: {kind: 'script', workId: 1, name: 'legacy-draft.pdf', base64: Buffer.from('%PDF-1.4 前の読み取り').toString('base64'), mediaType: 'application/pdf'}});
  assert.equal(upload.status, 201);
  const scenes = scriptExtraction().scenes.map((s) => ({sceneNo: s.sceneNo, location: s.location, dayNight: s.dayNight, cast: s.cast, synopsis: s.synopsis, estimatedMinutes: 60, pageEighths: s.pageEighths}));
  const saved = await req(`/workflow/scripts/${upload.data.artifactId}/review`, {method: 'PUT', payload: {scenes}});
  assert.equal(saved.status, 201);
  const latest = (await req(`/workflow/scripts/${upload.data.artifactId}`)).data.reviews[0].scenes;
  assert.deepEqual(latest.map((s) => ['extractionIndex' in s, 'checked' in s]), [[false, false], [false, false]]);
});
