// Worker の DB の選び分け（PG 計画 段2の準備。代表の決定 2026-10-04 の論点1・8・11。FR-CORE-DATA-031・034）。
// src/cloud-runtime.mjs が要求ごとに呼ぶ。Node でも import できる（@cloudflare/containers・node:*・pg を import しない。pg の Client は呼ぶ側が渡す）。
//
// - var の DATABASE_ENGINE が無いか d1（本番の道）: いままでの R2BackedD1Database（env.DB と R2。文の数の上限は D1_ATOMIC_STATEMENT_LIMIT、既定500）をそのまま返す。
//   D1 へ送る SQL・応答は変えない
// - postgres: env.HYPERDRIVE の接続文字列で、要求ごとに pg の Client を作る（Cloudflare が Hyperdrive で勧める形。pg 8.16.3 以上）。
//   接続は最初の問い合わせのときに開く（静的ファイルの要求で接続を増やさない）。PgDatabase に R2 の層（R2LargeValueDatabase）をかぶせる。
//   文の数の上限は持ち込まない（maxBatchStatements: null。FR-CORE-DATA-007）。逃がさない列の 128KB の上限は本番の D1 と同じ断り方でかける（論点8）。
//   後始末は、開いたときだけ releaseCloudDatabase が ctx.waitUntil で client.end() を流す
// - それ以外の値・束ねの欠けは設定の誤り（CloudDatabaseConfigError）。呼ぶ側が securityHeaders 付きの 503 にする
// - 接続できなかったときは CloudDatabaseUnavailableError（文は固定。接続文字列・元のエラーの文を出さない）。呼ぶ側が 503 にする
//
// Hyperdrive は、トランザクションの外の文を別の接続へ振り分けうる（Cloudflare の資料 how-hyperdrive-works）。PgDatabase は
// batch と readBatch を BEGIN〜COMMIT の中で流し、1つの文で完結しない状態（SET など）をトランザクションの外に持たない。
import {R2BackedD1Database, R2LargeValueDatabase} from '../cloud-r2-db.mjs';
import {databaseEngine, hasDatabaseBinding} from '../cloud-security.mjs';
import {D1_INLINE_VALUE_BYTES} from '../d1-limits.mjs';
import {PgDatabase, createPgSharedCache} from './pg-db.mjs';

export {databaseEngine, hasDatabaseBinding};

export class CloudDatabaseConfigError extends Error {
  constructor(message) { super(message); this.name = 'CloudDatabaseConfigError'; }
}

export const DATABASE_UNAVAILABLE_MESSAGE = 'データベースに接続できません。';
export class CloudDatabaseUnavailableError extends Error {
  constructor() { super(DATABASE_UNAVAILABLE_MESSAGE); this.name = 'CloudDatabaseUnavailableError'; }
}

// 要求をまたいで共有する控え（文の読み替え・IDENTITY の列・列の型）。I/O を持たない Map だけ（Worker は要求をまたいで接続や Promise を共有できない）
const moduleShared = createPgSharedCache();

// 開いた入口 → 後始末（開いたときだけ client.end()）
const releases = new WeakMap();

// pg の Client を、最初の問い合わせで開く口。PgDatabase には Client（Pool でない）として渡り、文を1つずつ順に流す
function lazyClient({connectionString, Client, loadClient}) {
  let client = null;
  let opening = null;
  const open = () => opening ??= (async () => {
    try {
      const Ctor = Client ?? await loadClient();
      client = new Ctor({connectionString});
      // 開いたあとに切れた接続の error の知らせを拾う（拾わないと EventEmitter が投げて要求の外で落ちる。問い合わせの失敗は query が投げる）
      client.on?.('error', () => {});
      await client.connect();
      return client;
    } catch {
      throw new CloudDatabaseUnavailableError();
    }
  })();
  return {
    queryable: {query: async (config) => (await open()).query(config)},
    opened: () => client,
  };
}

// (env, ctx, {Client | loadClient, shared}) → 入口（all・get・run・batch・readBatch）
export function openCloudDatabase(env, ctx, {Client, loadClient, shared = moduleShared} = {}) {
  const engine = databaseEngine(env);
  if (!engine) throw new CloudDatabaseConfigError('DATABASE_ENGINE は d1 か postgres');
  if (!hasDatabaseBinding(env, engine)) throw new CloudDatabaseConfigError(engine === 'd1' ? 'Cloud workbench bindings are incomplete' : 'HYPERDRIVE の束ねがありません');
  if (!env.PRIVATE_ARTIFACTS) throw new CloudDatabaseConfigError('Cloud workbench bindings are incomplete');
  if (engine === 'd1') {
    const configured = Number(env.D1_ATOMIC_STATEMENT_LIMIT || 500);
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > 1000) throw new Error('D1_ATOMIC_STATEMENT_LIMIT must be 1..1000');
    return new R2BackedD1Database(env.DB, env.PRIVATE_ARTIFACTS, {maxBatchStatements: configured});
  }
  if (typeof Client !== 'function' && typeof loadClient !== 'function') throw new CloudDatabaseConfigError('postgres には pg の Client を渡す');
  if (typeof ctx?.waitUntil !== 'function') throw new CloudDatabaseConfigError('postgres には要求の ctx（waitUntil）を渡す');
  const connection = lazyClient({connectionString: env.HYPERDRIVE.connectionString, Client, loadClient});
  const inner = new PgDatabase(connection.queryable, {shared});
  const db = new R2LargeValueDatabase(inner, env.PRIVATE_ARTIFACTS, {maxBatchStatements: null, maxInlineValueBytes: D1_INLINE_VALUE_BYTES});
  releases.set(db, () => {
    const client = connection.opened();
    if (!client) return; // 問い合わせの無かった要求は接続を開いていない
    // 流れている文（PgDatabase の順番待ち）が終わってから閉じる。閉じる失敗は応答に関わらないので捨てる
    ctx.waitUntil(inner.lock.then(() => client.end()).catch(() => {}));
  });
  return db;
}

// 要求の終わりに呼ぶ。postgres で接続を開いていれば ctx.waitUntil(client.end())。d1 と、開いていない入口では何もしない
export function releaseCloudDatabase(db) {
  const release = releases.get(db);
  if (!release) return;
  releases.delete(db);
  release();
}

// /api/health・ヘルス専用の経路が返す DB の種類（worker では postgres か d1）
export const cloudDatabaseName = (db) => (db?.dialect === 'postgres' ? 'postgres' : 'd1');
