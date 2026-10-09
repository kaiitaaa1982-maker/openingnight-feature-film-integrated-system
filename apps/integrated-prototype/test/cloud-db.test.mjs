// Worker の DB の選び分けとヘルス専用の経路（PG 計画 段2の準備。代表の決定 2026-10-04 の論点1・3・8・11。FR-CORE-DATA-031・032・034）。
// src/data-platform/cloud-db.mjs（openCloudDatabase）と src/data-platform/cloud-health.mjs を Node で確かめ、src/cloud-worker.mjs の fetch も動かす。
// cloud-worker.mjs は @cloudflare/containers（Workers の中だけで読める）を読むので、この試験のプロセスの中だけで、その import を空の部品へ差し替える
// （module.registerHooks。node --test はファイルごとに別のプロセスなので、ほかの試験には効かない）。Worker が postgres の要求で読む pg も、
// この試験の PGlite の Client へ差し替える（Worker の外の pg はそのまま）。Access の公開鍵の取得（certs）は、この試験の鍵を返す fetch に差し替える。
// PostgreSQL は ON_TEST_DB によらず PGlite（pg/schema.sql と pg/local-seed.sql の架空の行）。架空のデータだけを使う。
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import pg from 'pg';
import {SignJWT, exportJWK, generateKeyPair, createLocalJWKSet} from 'jose';
import {OUTPUT_PATH, SEED_PATH} from '../scripts/pg-ddl.mjs';
import {pgliteStream} from './pg-client.mjs';
import {openTestDb} from './test-db.mjs';
import {R2BackedD1Database, R2LargeValueDatabase} from '../src/cloud-r2-db.mjs';
import {PgDatabase, createPgSharedCache} from '../src/data-platform/pg-db.mjs';
import {CloudDatabaseConfigError, CloudDatabaseUnavailableError, openCloudDatabase, releaseCloudDatabase} from '../src/data-platform/cloud-db.mjs';
import {HEALTH_DB_PATH, respondDatabaseHealth} from '../src/data-platform/cloud-health.mjs';
import {cloudConfig, databaseEngine} from '../src/cloud-security.mjs';
import {createApp} from '../src/app.mjs';

// ---------- 差し替え（このプロセスの中だけ） ----------
const CONTAINERS_STUB = 'data:text/javascript,' + encodeURIComponent("export class Container{} export function getContainer(){throw new Error('試験では処理環境を使わない')}");
const PG_STUB = 'data:text/javascript,' + encodeURIComponent('export class Client{constructor(options){return new globalThis.__cloudDbTestClient(options)}} export default {Client};');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@cloudflare/containers') return {url: CONTAINERS_STUB, shortCircuit: true};
    if (specifier === 'pg' && /\/src\/cloud-worker\.mjs$/.test(context.parentURL ?? '')) return {url: PG_STUB, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

// ---------- 架空の束ね ----------
const DOMAIN = 'synthetic-team.cloudflareaccess.com';
const AUD = 'synthetic-aud';
const ORIGIN = 'https://integrated.openingnight.invalid';
// 架空の接続文字列（パスワードを持たない。PGlite の Client は読まずに捨てる）
const HYPERDRIVE = Object.freeze({connectionString: 'postgresql://hyperdrive.invalid:5432/synthetic'});

class Bucket {
  constructor() { this.values = new Map(); }
  async head(key) { const row = this.values.get(key); return row ? {size: row.bytes.byteLength, customMetadata: row.metadata} : null; }
  async put(key, value, options) { this.values.set(key, {bytes: new Uint8Array(value), metadata: options.customMetadata}); return {}; }
  async get(key) { const row = this.values.get(key); return row ? {body: true, arrayBuffer: async () => row.bytes.buffer.slice(row.bytes.byteOffset, row.bytes.byteOffset + row.bytes.byteLength)} : null; }
}
// D1 の束ねの模擬。SELECT 1 にだけ答え、受け取った SQL を残す（ヘルス専用の経路が業務の表を読まないことを見る）
class D1Binding {
  constructor() { this.sql = []; }
  prepare(sql) { this.sql.push(sql); return {bind: () => ({first: async () => (sql === 'SELECT 1 AS ok' ? {ok: 1} : null), all: async () => ({results: []}), run: async () => ({success: true, meta: {changes: 0}})})}; }
  async batch() { throw new Error('この試験では D1 の batch を使わない'); }
}
const cloudEnv = (extra = {}) => ({
  DEPLOYMENT_ENABLED: 'true', ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD, PUBLIC_ORIGIN: ORIGIN,
  ASSETS: {fetch: async () => new Response('<!doctype html><title>架空</title>', {headers: {'content-type': 'text/html'}})},
  PRIVATE_ARTIFACTS: new Bucket(), WORKBENCH_CONTAINER: {}, CONTAINER_SHARED_TOKEN: 'synthetic-token',
  CLOUD_ANALYTICS_REGISTRATION_ID: 'synthetic-1', CLOUD_ANALYTICS_DEFINITION_VERSION: 'cloud-1',
  ...extra,
});
const d1Env = (extra = {}) => cloudEnv({DB: new D1Binding(), ...extra});
const pgEnv = (extra = {}) => cloudEnv({DATABASE_ENGINE: 'postgres', HYPERDRIVE, ...extra});
const context = () => { const waits = []; return {waits, ctx: {waitUntil: (promise) => { waits.push(promise); }}}; };

// ---------- PGlite と pg の Client ----------
let instance = null;
const created = [];
// Hyperdrive の代わり。接続文字列は受け取って捨て、PGlite へつなぐ。作った Client と connect・end の回数を残す
class PgliteClient extends pg.Client {
  constructor({connectionString} = {}) {
    super({stream: () => pgliteStream(instance), user: 'postgres', database: 'postgres'});
    this.connectionString = connectionString;
    this.connects = 0;
    this.ends = 0;
    created.push(this);
  }
  async connect() { this.connects += 1; return super.connect(); }
  async end() { this.ends += 1; return super.end(); }
}
// 接続できない Client。元のエラーの文に、応答へ出してはいけない中身を入れる
class UnreachableClient {
  constructor() { this.ends = 0; created.push(this); }
  on() {}
  async connect() { throw new Error('connect ECONNREFUSED 10.0.0.9:5432 synthetic-secret'); }
  async query() { throw new Error('接続していない'); }
  async end() { this.ends += 1; }
}

// ---------- Access の JWT（この試験の鍵） ----------
let privateKey = null;
let keys = null;
const realFetch = globalThis.fetch;
const jwt = async (claims, {aud = AUD, key = privateKey} = {}) => new SignJWT(claims).setProtectedHeader({alg: 'RS256', kid: 'synthetic'})
  .setIssuer(`https://${DOMAIN}`).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(key);
const serviceToken = () => jwt({common_name: 'synthetic.access', type: 'app'}); // サービストークン（メールなし）
const userToken = (email = 'admin@openingnight.invalid') => jwt({email, type: 'app'});
const request = (path, {token, method = 'GET', headers = {}} = {}) => new Request(ORIGIN + path, {method, headers: {...(token ? {'Cf-Access-Jwt-Assertion': token} : {}), ...headers}});

let worker = null;
before(async () => {
  const {PGlite} = await import('@electric-sql/pglite');
  instance = await PGlite.create();
  await instance.exec(readFileSync(OUTPUT_PATH, 'utf8'));
  await instance.exec(readFileSync(SEED_PATH, 'utf8'));
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = {...await exportJWK(pair.publicKey), kid: 'synthetic', alg: 'RS256', use: 'sig'};
  keys = createLocalJWKSet({keys: [jwk]});
  globalThis.fetch = async (input, init) => (String(input?.url ?? input) === `https://${DOMAIN}/cdn-cgi/access/certs` ? Response.json({keys: [jwk]}) : realFetch(input, init));
  globalThis.__cloudDbTestClient = PgliteClient;
  worker = (await import('../src/cloud-worker.mjs')).default;
});
after(async () => {
  globalThis.fetch = realFetch;
  await instance?.close();
});

// ---------- DB の選び分け ----------

test('FR-CORE-DATA-031 DATABASE_ENGINE の無い env と d1 の env では、いままでと同じ R2BackedD1Database（D1 の束ね・文の数500・dialect なし）ができる', () => {
  for (const extra of [{}, {DATABASE_ENGINE: 'd1'}]) {
    const env = d1Env(extra);
    const {waits, ctx} = context();
    const db = openCloudDatabase(env, ctx, {Client: PgliteClient});
    assert.ok(db instanceof R2BackedD1Database);
    assert.equal(db.binding, env.DB);
    assert.equal(db.bucket, env.PRIVATE_ARTIFACTS);
    assert.equal(db.maxBatchStatements, 500);
    assert.equal(db.dialect, undefined);
    releaseCloudDatabase(db);
    assert.equal(waits.length, 0, 'D1 では後始末を waitUntil に渡さない');
  }
  assert.equal(openCloudDatabase(d1Env({D1_ATOMIC_STATEMENT_LIMIT: '200'}), context().ctx).maxBatchStatements, 200);
  assert.throws(() => openCloudDatabase(d1Env({D1_ATOMIC_STATEMENT_LIMIT: '1001'}), context().ctx), /^Error: D1_ATOMIC_STATEMENT_LIMIT must be 1\.\.1000$/);
  assert.equal(created.length, 0, 'D1 の道では pg の Client を作らない');
});

test('FR-CORE-DATA-031 DATABASE_ENGINE が postgres で HYPERDRIVE が無い・未知の値・DB の束ねの無い d1 は設定の誤り（cloudConfig は null、openCloudDatabase は CloudDatabaseConfigError）', () => {
  assert.equal(databaseEngine({}), 'd1');
  assert.equal(databaseEngine({DATABASE_ENGINE: 'd1'}), 'd1');
  assert.equal(databaseEngine({DATABASE_ENGINE: 'postgres'}), 'postgres');
  for (const value of ['mysql', 'Postgres', '', 'sqlite']) assert.equal(databaseEngine({DATABASE_ENGINE: value}), null, value);
  const broken = [pgEnv({HYPERDRIVE: undefined}), pgEnv({HYPERDRIVE: {}}), pgEnv({HYPERDRIVE: {connectionString: ''}}), d1Env({DATABASE_ENGINE: 'mysql'}), cloudEnv()];
  for (const env of broken) {
    assert.equal(cloudConfig(env), null);
    assert.throws(() => openCloudDatabase(env, context().ctx, {Client: PgliteClient}), CloudDatabaseConfigError);
  }
  // postgres には D1 の束ねが要らず、d1 には HYPERDRIVE が要らない
  assert.equal(cloudConfig(pgEnv()).engine, 'postgres');
  assert.equal(cloudConfig(d1Env()).engine, 'd1');
  assert.equal(created.length, 0);
});

test('FR-CORE-DATA-031 postgres では PgDatabase に R2 の層（文の数の上限なし・128KB の上限あり）がかぶさり、問い合わせの無い要求は接続を開かず、開いたら end を waitUntil に渡す', async () => {
  const before = created.length;
  const quiet = context();
  const idle = openCloudDatabase(pgEnv(), quiet.ctx, {Client: PgliteClient});
  assert.ok(idle instanceof R2LargeValueDatabase && !(idle instanceof R2BackedD1Database));
  assert.ok(idle.inner instanceof PgDatabase);
  assert.equal(idle.dialect, 'postgres');
  assert.equal(idle.maxBatchStatements, null);
  assert.equal(idle.maxInlineValueBytes, 128 * 1024);
  releaseCloudDatabase(idle);
  assert.equal(created.length, before, '問い合わせの無い要求では Client を作らない');
  assert.equal(quiet.waits.length, 0);

  const {waits, ctx} = context();
  const db = openCloudDatabase(pgEnv(), ctx, {Client: PgliteClient});
  assert.deepEqual({...await db.get('SELECT 1 AS ok')}, {ok: 1});
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM organizations')).n) > 0, true);
  assert.equal(created.length, before + 1, '1つの要求で Client は1つ');
  const client = created.at(-1);
  assert.equal(client.connects, 1, '接続は1回だけ開く');
  assert.equal(client.connectionString, HYPERDRIVE.connectionString, 'Hyperdrive の接続文字列で開く');
  // 逃がさない列の 128KB の上限は、本番の D1 と同じ文で断る（論点8）
  await assert.rejects(db.run('UPDATE organizations SET name=? WHERE id=?', ['x'.repeat(128 * 1024 + 1), 1]), /この項目はD1行内サイズ上限を超えています/);
  assert.equal(client.ends, 0, '要求の途中では閉じない');
  releaseCloudDatabase(db);
  assert.equal(waits.length, 1, 'end を waitUntil に1回渡す');
  await Promise.all(waits);
  assert.equal(client.ends, 1);
  releaseCloudDatabase(db);
  assert.equal(waits.length, 1, '2回目の後始末では何もしない');
});

test('FR-CORE-DATA-032 入口の段で、Client A で読む→書く→別の要求の Client B で同じ SQL を読むと新しい値が返る（要求をまたいで控えだけを共有する）', async () => {
  const shared = createPgSharedCache();
  const read = 'SELECT name FROM organizations WHERE id = ?';
  const first = context();
  const a = openCloudDatabase(pgEnv(), first.ctx, {Client: PgliteClient, shared});
  const old = (await a.get(read, [1])).name;
  assert.equal((await a.run('UPDATE organizations SET name = ? WHERE id = ?', [`${old}（書いた直後）`, 1])).changes, 1);
  assert.equal((await a.get(read, [1])).name, `${old}（書いた直後）`);
  const clientA = created.at(-1);
  releaseCloudDatabase(a);
  await Promise.all(first.waits);
  assert.equal(clientA.ends, 1);

  const second = context();
  const b = openCloudDatabase(pgEnv(), second.ctx, {Client: PgliteClient, shared});
  assert.equal((await b.get(read, [1])).name, `${old}（書いた直後）`, '別の接続でも書いた値を読む');
  assert.notEqual(created.at(-1), clientA, 'B は別の Client');
  assert.equal(b.inner.cache, a.inner.cache, '文の読み替えの控えは要求をまたいで同じ');
  assert.ok(shared.statements.has(read));
  assert.ok([...shared.statements.values()].every((found) => typeof found.text === 'string' && !('rows' in found)), '控えは文の読み替えだけ（行や接続を持たない）');
  await b.run('UPDATE organizations SET name = ? WHERE id = ?', [old, 1]);
  releaseCloudDatabase(b);
  await Promise.all(second.waits);
});

test('FR-CORE-DATA-031 接続できない postgres は、元のエラーの文を出さない CloudDatabaseUnavailableError になり、開こうとした Client は waitUntil で閉じる', async () => {
  const {waits, ctx} = context();
  const db = openCloudDatabase(pgEnv(), ctx, {Client: UnreachableClient});
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(db.get('SELECT 1 AS ok'), (error) => error instanceof CloudDatabaseUnavailableError && !/ECONNREFUSED|synthetic-secret|hyperdrive\.invalid/.test(`${error.message} ${error.stack}`) && error.cause === undefined);
  }
  assert.equal(created.filter((c) => c instanceof UnreachableClient).length, 1, '1つの要求で接続を開こうとするのは1回');
  releaseCloudDatabase(db);
  await Promise.all(waits);
  assert.equal(created.at(-1).ends, 1);
});

test('FR-CORE-DATA-034 Hyperdrive からつなぐドライバは pg 8.16.3 以上（入っている版と package.json の指定の下限）', () => {
  const atLeast = (version, floor) => { const a = version.split('.').map(Number), b = floor.split('.').map(Number); for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
  const installed = JSON.parse(readFileSync(new URL('../node_modules/pg/package.json', import.meta.url), 'utf8')).version;
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies.pg;
  assert.ok(atLeast(installed, '8.16.3'), `入っている pg ${installed}`);
  assert.match(declared, /^\^\d+\.\d+\.\d+$/);
  assert.ok(atLeast(declared.slice(1), '8.16.3'), `package.json の pg ${declared}`);
  assert.equal(declared.slice(1).split('.')[0], '8', '^ の指定で 9 以上へ上がらない');
});

// ---------- ヘルス専用の経路 ----------

const healthBody = async (response) => ({status: response.status, body: await response.json()});

test('FR-CORE-DATA-031 ヘルス専用の経路は、サービストークン（メールなし）で通り、DB の種類と SELECT 1 の成否だけを返す（業務の表を読まない）', async () => {
  const cfg = cloudConfig(d1Env());
  const env = d1Env();
  const db = openCloudDatabase(env, context().ctx);
  const service = await healthBody(await respondDatabaseHealth(request(HEALTH_DB_PATH, {token: await serviceToken()}), {cfg, db, keys}));
  assert.deepEqual(service, {status: 200, body: {ok: true, database: 'd1', db: 'ok'}});
  assert.deepEqual(env.DB.sql, ['SELECT 1 AS ok'], 'D1 へは SELECT 1 だけを送る');
  // メールのある利用者が呼んでも同じ中身
  assert.deepEqual(await healthBody(await respondDatabaseHealth(request(HEALTH_DB_PATH, {token: await userToken()}), {cfg, db, keys})), service);
  // JWT が無い・AUD が違う・別の鍵で署名した要求は断り、DB に触れない
  const other = await generateKeyPair('RS256');
  for (const token of [undefined, await jwt({}, {aud: 'other-aud'}), await jwt({}, {key: other.privateKey}), 'not-a-jwt']) {
    const response = await respondDatabaseHealth(request(HEALTH_DB_PATH, {token}), {cfg, db, keys});
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Cloudflare Accessを確認できません。');
  }
  // GET だけ
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const response = await respondDatabaseHealth(request(HEALTH_DB_PATH, {token: await serviceToken(), method}), {cfg, db, keys});
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'GET');
  }
  assert.deepEqual(env.DB.sql, ['SELECT 1 AS ok', 'SELECT 1 AS ok'], '断った要求では DB に触れない');
});

test('FR-CORE-DATA-031 業務の API の利用者の確かめは、いままでどおりメールを求める（サービストークンの JWT では通らない）', async () => {
  const {verifyAccessToken} = await import('../src/cloud-security.mjs');
  const cfg = cloudConfig(d1Env());
  assert.equal(await verifyAccessToken(request('/api/session', {token: await serviceToken()}), cfg, {keys}), null);
  assert.equal((await verifyAccessToken(request('/api/session', {token: await userToken()}), cfg, {keys})).email, 'admin@openingnight.invalid');
  assert.equal((await verifyAccessToken(request(HEALTH_DB_PATH, {token: await serviceToken()}), cfg, {keys, requireEmail: false})).common_name, 'synthetic.access');
});

// ---------- Worker の入口（src/cloud-worker.mjs の fetch） ----------

const SECURITY_HEADERS = ['Cache-Control', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy', 'Content-Security-Policy'];
const assertSecured = (response) => { for (const name of SECURITY_HEADERS) assert.ok(response.headers.get(name), `${name} がある`); };

test('FR-CORE-DATA-031 Worker: postgres で HYPERDRIVE が無い・未知の DATABASE_ENGINE は、securityHeaders 付きの 503 にする', async () => {
  const before = created.length;
  for (const env of [pgEnv({HYPERDRIVE: undefined}), d1Env({DATABASE_ENGINE: 'mysql'}), pgEnv({HYPERDRIVE: {connectionString: ''}})]) {
    const {waits, ctx} = context();
    const response = await worker.fetch(request('/api/health', {token: await userToken()}), env, ctx);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), '統合試作の配備は無効です。');
    assertSecured(response);
    assert.equal(waits.length, 0);
  }
  assert.equal(created.length, before);
});

test('FR-CORE-DATA-031 Worker: postgres の env で、ヘルス専用の経路・/api/health（database は postgres）・静的ファイルが動き、DB に触れずに断る要求は接続を開かない', async () => {
  let before = created.length;
  let {waits, ctx} = context();
  // JWT の無い要求は、利用者の確かめ（DB を読む）の前に断るので、接続を開かない
  for (const path of ['/', '/api/health', HEALTH_DB_PATH]) {
    const response = await worker.fetch(request(path), pgEnv(), ctx);
    assert.equal(response.status, 403, path);
    assertSecured(response);
  }
  assert.equal(created.length, before, 'DB に触れない要求では Client を作らない');
  assert.equal(waits.length, 0);
  // 静的ファイルも、いままでどおり利用者の所属を DB で確かめてから返す（1つの要求で接続は1つ。応答のあと閉じる）
  const page = await worker.fetch(request('/', {token: await userToken()}), pgEnv(), ctx);
  assert.equal(page.status, 200);
  assertSecured(page);
  assert.equal(created.length, before + 1);
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.equal(created.at(-1).ends, 1);
  before = created.length;

  ({waits, ctx} = context());
  const health = await worker.fetch(request(HEALTH_DB_PATH, {token: await serviceToken()}), pgEnv(), ctx);
  assertSecured(health);
  assert.deepEqual(await healthBody(health), {status: 200, body: {ok: true, database: 'postgres', db: 'ok'}});
  assert.equal(created.length, before + 1);
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.equal(created.at(-1).ends, 1);

  // JWT の無い要求・POST は断る（POST はオリジンの検査か GET だけの検査で断る）
  for (const req of [request(HEALTH_DB_PATH), request(HEALTH_DB_PATH, {token: await serviceToken(), method: 'POST'}), request(HEALTH_DB_PATH, {token: await serviceToken(), method: 'POST', headers: {Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin'}})]) {
    const response = await worker.fetch(req, pgEnv(), context().ctx);
    assert.ok([403, 405].includes(response.status), `${req.method} ${response.status}`);
    assert.doesNotMatch(await response.text(), /"database"|"db"/);
  }

  // サービストークンでは業務の API に入れない（メールとチームの所属が要る）
  before = created.length;
  const denied = await worker.fetch(request('/api/health', {token: await serviceToken()}), pgEnv(), context().ctx);
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), 'Cloudflare Accessと有効なチーム所属を確認できません。');

  // メールのある利用者の /api/health は、入口の DB の種類（postgres）を返す
  ({waits, ctx} = context());
  const api = await worker.fetch(request('/api/health', {token: await userToken()}), pgEnv(), ctx);
  assert.equal(api.status, 200);
  assertSecured(api);
  const body = await api.json();
  assert.equal(body.mode, 'worker');
  assert.equal(body.database, 'postgres');
  await Promise.all(waits);
});

test('FR-CORE-DATA-031 Worker: 本番の形の env（DATABASE_ENGINE なし）では D1 の入口で動き、ヘルス専用の経路は d1 と SELECT 1 だけ、後始末を waitUntil に渡さない', async () => {
  const env = d1Env();
  const {waits, ctx} = context();
  const before = created.length;
  const health = await worker.fetch(request(HEALTH_DB_PATH, {token: await serviceToken()}), env, ctx);
  assertSecured(health);
  assert.deepEqual(await healthBody(health), {status: 200, body: {ok: true, database: 'd1', db: 'ok'}});
  assert.deepEqual(env.DB.sql, ['SELECT 1 AS ok']);
  // JWT の無い要求は、いままでどおり DB に触れずに 403
  const denied = await worker.fetch(request('/api/health'), env, ctx);
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), 'Cloudflare Accessと有効なチーム所属を確認できません。');
  assert.deepEqual(env.DB.sql, ['SELECT 1 AS ok']);
  assert.equal(waits.length, 0);
  assert.equal(created.length, before, 'D1 の道では pg を使わない');
});

test('FR-CORE-DATA-031 Worker: postgres に接続できないときは、中身を出さない securityHeaders 付きの 503（業務の API）か db: error（ヘルス専用の経路）', async () => {
  globalThis.__cloudDbTestClient = UnreachableClient;
  try {
    const {waits, ctx} = context();
    const api = await worker.fetch(request('/api/health', {token: await userToken()}), pgEnv(), ctx);
    assert.equal(api.status, 503);
    assertSecured(api);
    const text = await api.text();
    assert.equal(text, 'データベースに接続できません。');
    const health = await worker.fetch(request(HEALTH_DB_PATH, {token: await serviceToken()}), pgEnv(), ctx);
    assert.deepEqual(await healthBody(health), {status: 503, body: {ok: false, database: 'postgres', db: 'error'}});
    await Promise.all(waits);
    assert.equal(waits.length, 2);
  } finally {
    globalThis.__cloudDbTestClient = PgliteClient;
  }
});

// ---------- /api/health の database ----------

test('FR-CORE-DATA-031 /api/health の database は入口の DB の種類（worker の D1 は d1、PostgreSQL は postgres、手元は試験の DB の種類）', async (t) => {
  const health = async (db, mode) => (await (await createApp({db, mode, authenticate: async () => null}).fetch(new Request('http://localhost/api/health'))).json()).database;
  assert.equal(await health(new R2BackedD1Database(new D1Binding(), new Bucket()), 'worker'), 'd1');
  assert.equal(await health(openCloudDatabase(pgEnv(), context().ctx, {Client: PgliteClient}), 'worker'), 'postgres');
  const local = await openTestDb({t});
  assert.equal(await health(local, 'local'), local.kind === 'pg' ? 'postgres' : 'sqlite', '手元の LocalDatabase は sqlite（verify の doctor が見る）');
});
