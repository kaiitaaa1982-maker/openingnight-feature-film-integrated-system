// PostgreSQL の入口（src/data-platform/pg-db.mjs）の試験で使う、pg（node-postgres）の Client を開く道具。
//
// 既定は PGlite（手元・CI の npm test）。PGlite の公式の接続の部品（@electric-sql/pglite-socket）は、拡張7つを同じ版の
// 必須の peerDependencies に持つので入れず、試験の側に薄い口（pgliteStream）を作った。pg の Client は stream を
// 差し替えられるので、PGlite の execProtocolRaw にワイヤの文をそのまま渡す。pg の型の読み取り・エラーの SQLSTATE・
// 列の表の OID（tableID）が本物の PostgreSQL と同じ経路で届く（アダプタは PGlite 用の分かれ道を持たない）。
// ON_TEST_PG_URL（localhost だけ）を渡すと、同じ試験を手元の PostgreSQL（CI の postgres:18-alpine）で流す。
// どちらも使い捨ての schema を作り、生成した pg/schema.sql（migrations/ からの変換）を当てる。架空のデータだけを使う。
import { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { OUTPUT_PATH } from '../scripts/pg-ddl.mjs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// pg の Client の stream に渡す口。Sync・Query・Flush の区切りまで文をためてから PGlite に渡す
// （拡張の問い合わせの途中でエラーになったとき、PostgreSQL は Sync まで読み飛ばすので、区切りの途中で渡すと応答がずれる）
export function pgliteStream(db) {
  let queue = Promise.resolve();
  let pending = Buffer.alloc(0);
  let started = false;
  let ended = false;
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]);
      const batches = [];
      let offset = 0;
      let cut = 0;
      while (!ended) {
        if (!started) { // 最初の StartupMessage は型の1字を持たない
          if (pending.length - offset < 4) break;
          const length = pending.readInt32BE(offset);
          if (pending.length - offset < length) break;
          offset += length;
          cut = offset;
          started = true;
          continue;
        }
        if (pending.length - offset < 5) break;
        const type = String.fromCharCode(pending[offset]);
        const length = pending.readInt32BE(offset + 1);
        if (pending.length - offset < length + 1) break;
        if (type === 'X') { ended = true; break; } // Terminate は PGlite に渡さない
        offset += length + 1;
        if (type === 'S' || type === 'Q' || type === 'H') cut = offset;
      }
      if (cut) { batches.push(pending.subarray(0, cut)); pending = pending.subarray(cut); }
      if (ended) pending = Buffer.alloc(0);
      queue = queue.then(async () => {
        for (const batch of batches) {
          const out = await db.execProtocolRaw(new Uint8Array(batch));
          if (out?.length) stream.push(Buffer.from(out));
        }
      }).then(() => callback(), callback);
    },
    final(callback) { queue.then(() => { stream.push(null); callback(); }, callback); },
  });
  // pg は net.Socket と同じ形で呼ぶ
  stream.connect = () => { setImmediate(() => stream.emit('connect')); return stream; };
  for (const name of ['setNoDelay', 'setKeepAlive', 'ref', 'unref']) stream[name] = () => stream;
  return stream;
}

const schemaSql = () => readFileSync(OUTPUT_PATH, 'utf8');

// {client, kind, schema, pool(), close()}。pool() は本物の PostgreSQL のときだけ、同じ schema を見る Pool を返す（同時の接続の試験用）
export async function openPgClient({ applySchema = true } = {}) {
  const url = process.env.ON_TEST_PG_URL;
  const schema = `pgdb_${process.pid}_${Date.now()}`;
  if (url) {
    const { hostname } = new URL(url);
    if (!LOCAL_HOSTS.has(hostname)) throw new Error('ON_TEST_PG_URL は手元（localhost）の PostgreSQL だけを受け付ける');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    if (applySchema) await client.query(schemaSql());
    const pools = [];
    return {
      client, kind: 'postgres', schema,
      pool: () => { const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` }); pools.push(pool); return pool; },
      // DROP SCHEMA が落ちても（2つの試験のファイルを同時に流して out of shared memory になったときなど）接続を閉じ、試験を止めずに落とす
      close: async () => { try { for (const pool of pools) await pool.end(); await client.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await client.end(); } },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  const client = new pg.Client({ stream: () => pgliteStream(db), user: 'postgres', database: 'postgres' });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  if (applySchema) await client.query(schemaSql());
  return {
    client, kind: 'pglite', schema,
    pool: () => null,
    close: async () => { await client.end(); await db.close(); },
  };
}
