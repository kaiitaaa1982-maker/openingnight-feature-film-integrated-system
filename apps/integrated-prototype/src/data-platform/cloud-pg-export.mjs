// scheduled の入口。HTTP 認証やアプリの初期化を通らないため、成否の1行もここで出す（docs/rules/logging.md の例外）。
// ログは固定の名前の JSON 1行。出すのは原因の種類（許可リスト。failureCause）・経過 ms・表と行の数・世代のキーだけで、
// 元のエラーの message・SQL・行の値・金額・接続文字列は出さない。
import {PgDatabase} from './pg-db.mjs';
import {exportPgDatabase} from './pg-export-store.mjs';
import {exportError, failureCause} from './pg-export-format.mjs';

export const PG_EXPORT_SUCCEEDED = 'pg_daily_export_succeeded';
export const PG_EXPORT_FAILED = 'pg_daily_export_failed';
export const PG_EXPORT_CLOSE_FAILED = 'pg_daily_export_close_failed';

// Workers Logs は console の JSON 1行を項目に分けて検索できる（runbooks/08 C-4・05 の見方）。
function writeLog(entry) {
  const line = JSON.stringify(entry);
  if (entry.event === PG_EXPORT_SUCCEEDED) console.log(line);
  else console.error(line);
}

export async function runScheduledPgExport(env, {loadClient, report = writeLog, clock = () => Date.now()} = {}) {
  if (env.DATABASE_ENGINE !== 'postgres' || !env.PG_EXPORTS) return {skipped: true};
  const started = clock();
  const elapsed = () => Math.max(0, clock() - started);
  // exportPgDatabase の外で進み具合を受ける。失敗したときに、どこまで終えたかをログへ出すため。
  const progress = {tables: 0, rows: 0};
  let client;
  try {
    if (!env.HYPERDRIVE?.connectionString) throw exportError('binding_missing');
    const Client = await loadClient();
    client = new Client({connectionString: env.HYPERDRIVE.connectionString});
    client.on?.('error', () => { /* query と end の失敗で通知する。生のエラーはログに出さない */ });
    await client.connect();
    const {manifestKey, manifest} = await exportPgDatabase({db: new PgDatabase(client), bucket: env.PG_EXPORTS, artifacts: env.PRIVATE_ARTIFACTS,
      onProgress: ({tables, rows}) => { progress.tables = tables; progress.rows = rows; }});
    // 世代のキー（manifest の置き場所）で、R2 の画面と練習 E・F の取得の起点を引ける。
    report({event: PG_EXPORT_SUCCEEDED, manifest_key: manifestKey, tables: manifest.tables.length,
      rows: manifest.tables.reduce((sum, table) => sum + Number(table.row_count), 0), elapsed_ms: elapsed()});
    return {skipped: false, manifestKey};
  } catch (error) {
    report({event: PG_EXPORT_FAILED, cause: failureCause(error), elapsed_ms: elapsed(), tables: progress.tables, rows: progress.rows});
    throw new Error(PG_EXPORT_FAILED);
  } finally {
    if (client) {
      try { await client.end(); }
      catch (error) {
        report({event: PG_EXPORT_CLOSE_FAILED, cause: failureCause(error), elapsed_ms: elapsed()});
        throw new Error(PG_EXPORT_CLOSE_FAILED);
      }
    }
  }
}
