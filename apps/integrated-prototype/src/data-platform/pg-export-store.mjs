// PostgreSQL の一時点を分割して R2 に保存する。Node と Worker（nodejs_compat）で共用。
// SQL の値を text で受け、bigint・numeric・bytea・JSON の精度と NULL を保つ。
import {createHash, randomUUID} from 'node:crypto';
import {PgDatabase} from './pg-db.mjs';
import {PG_FINGERPRINT_TABLE} from './pg-fingerprint.mjs';
import {cloudR2Internals} from '../cloud-r2-db.mjs';
import {EXPORT_FORMAT, MAX_PART_BYTES, quoteIdentifier as q, exportError, moneyColumns, addMoney} from './pg-export-format.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
// 1行の上限（JSON 化して改行を足した UTF-8 の長さ）。超える行は書き出さずに断る。
export const MAX_EXPORT_ROW_BYTES = 1024 * 1024;
const MAX_EXPORT_BUFFER_BYTES = 1024 * 1024;
// 束で本文ごと取る小さい行の上限と、束の行数。束の大きさ（行数×小さい行の上限）は 1 MiB を超えない。
// 小さい行の上限を超える行は (tableoid, ctid) だけを束で受け、同じトランザクションの中で1行ずつ取り直す。
export const SMALL_EXPORT_ROW_BYTES = 16 * 1024;
export const EXPORT_BATCH_ROWS = MAX_EXPORT_BUFFER_BYTES / SMALL_EXPORT_ROW_BYTES;
export async function inPgTransaction(db, begin, action) {
  if (!(db instanceof PgDatabase)) throw exportError('postgres_required');
  return db.withConnection(async (client, discard) => {
    try { await client.query(begin); }
    catch (error) { discard(error); throw exportError('begin_failed'); }
    try {
      await client.query("SET LOCAL statement_timeout = '50s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
      await client.query("SET LOCAL TimeZone = 'UTC'");
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { discard(rollbackError); }
      throw error;
    }
  });
}

export async function readExportCatalog(client) {
  const {rows} = await client.query(`SELECT c.relname AS table_name, a.attname AS name, t.typname AS type,
      a.attgenerated AS generated, a.attidentity AS identity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> $1
    ORDER BY c.relname, a.attnum`, [PG_FINGERPRINT_TABLE]);
  const tables = new Map();
  for (const row of rows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, {table_name: row.table_name, columns: []});
    tables.get(row.table_name).columns.push({name: row.name, type: row.type, generated: row.generated, identity: row.identity});
  }
  return [...tables.values()];
}

export async function readFingerprint(client) {
  const {rows} = await client.query(`SELECT * FROM ${q(PG_FINGERPRINT_TABLE)}`);
  if (rows.length !== 1) throw exportError('schema_fingerprint_missing');
  // node-postgres の int8 を文字に統一する（PGlite も同じ形）。
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, String(value)]));
}

// OFFSET や全表のソートは使わない。cursor を pageRows 行（1〜EXPORT_BATCH_ROWS）の束で読む。
// SQL側でtext化・JSONのエスケープ後のUTF8長（改行込み）を検査し、行の大きさで送るものを分ける:
//   小さい行の上限以下 → 本文。上限を超え maxRowBytes 以下 → (tableoid, ctid) だけ。maxRowBytes 超 → どちらも NULL（断る）。
// 束の大きさは pageRows×小さい行の上限 ≤ 1 MiB。大きい行は同じトランザクション（同じ snapshot）の中で ctid で1行ずつ取り直し、
// 束の中の元の順のまま accept に渡す。accept を待ってから次の行・次の束へ進む。
// maxRowBytes・smallRowBytes は小さな値で境界を試せるよう、既定の上限を下げることだけ許す。
export async function scanExportTable(client, table, pageRows, accept,
  {maxRowBytes = MAX_EXPORT_ROW_BYTES, smallRowBytes = SMALL_EXPORT_ROW_BYTES} = {}) {
  if (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1 || maxRowBytes > MAX_EXPORT_ROW_BYTES ||
      !Number.isSafeInteger(smallRowBytes) || smallRowBytes < 1 || smallRowBytes > SMALL_EXPORT_ROW_BYTES ||
      !Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > EXPORT_BATCH_ROWS) throw exportError('invalid_export_options');
  const small = Math.min(smallRowBytes, maxRowBytes);
  const columns = table.columns.map(c => `on_export_source.${q(c.name)}::text AS ${q(c.name)}`).join(', ');
  // 列の値だけを JSON にする（tableoid・ctid は JSON に入れない）。DECLARE では副問い合わせに OFFSET 0 を付け、
  // 平らにされて row_to_json が CASE ごとに何度も計算されるのを止める（行ごとに1回）。
  const encoded = `SELECT row_to_json(on_export_values)::text AS on_export_json,
      on_export_source.tableoid AS on_export_oid, on_export_source.ctid AS on_export_tid
    FROM ${q(table.table_name)} AS on_export_source
    CROSS JOIN LATERAL (SELECT ${columns}) AS on_export_values`;
  await client.query(`DECLARE on_export_cursor NO SCROLL CURSOR FOR
    SELECT CASE WHEN on_export_bytes <= ${small} THEN on_export_json END AS on_export_row,
      CASE WHEN on_export_bytes > ${small} AND on_export_bytes <= ${maxRowBytes} THEN on_export_oid::text END AS on_export_oid,
      CASE WHEN on_export_bytes > ${small} AND on_export_bytes <= ${maxRowBytes} THEN on_export_tid::text END AS on_export_tid
    FROM (SELECT on_export_json, octet_length(on_export_json) + 1 AS on_export_bytes, on_export_oid, on_export_tid
      FROM (${encoded} OFFSET 0) AS on_export_rows) AS on_export_sized`);
  const refetch = `SELECT CASE WHEN octet_length(on_export_json) + 1 <= ${maxRowBytes} THEN on_export_json END AS on_export_row
    FROM (${encoded}
      WHERE on_export_source.tableoid = $1::oid AND on_export_source.ctid = $2::tid) AS on_export_one`;
  for (;;) {
    const {rows} = await client.query(`FETCH FORWARD ${pageRows} FROM on_export_cursor`);
    for (let index = 0; index < rows.length; index += 1) {
      let text = rows[index].on_export_row;
      if (text == null) {
        const {on_export_oid: oid, on_export_tid: tid} = rows[index];
        if (oid == null || tid == null) throw exportError('row_too_large');
        const one = (await client.query(refetch, [oid, tid])).rows;
        if (one.length !== 1) throw exportError('row_refetch_missing');
        if (one[0].on_export_row == null) throw exportError('row_too_large');
        text = one[0].on_export_row;
      }
      rows[index] = null; // 渡し終えた行は束から外し、次の行の作業と重ねて持たない
      await accept(JSON.parse(text));
    }
    if (rows.length < pageRows) break;
  }
  await client.query('CLOSE on_export_cursor');
}

// pageRows は cursor の束の行数（1〜EXPORT_BATCH_ROWS。既定は最大の64行）。どの値でも束は 1 MiB を超えない。
// onProgress は進み具合（終えた表の数・読み終えた行の数）を外へ渡す口。値は件数だけで、行の値は渡さない。
export async function exportPgDatabase({db, bucket, artifacts, pageRows = EXPORT_BATCH_ROWS, partBytes = MAX_EXPORT_BUFFER_BYTES,
  now = new Date(), runId = randomUUID(), maxDurationMs = 12 * 60 * 1000, onProgress} = {}) {
  if (!bucket?.put || !Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > EXPORT_BATCH_ROWS ||
      !Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > MAX_PART_BYTES || !/^[a-zA-Z0-9-]+$/.test(runId) ||
      (onProgress !== undefined && typeof onProgress !== 'function')) throw exportError('invalid_export_options');
  // 大きなpartBytesを指定されてもWorkerの作業用バッファは広げない。旧形式の20MiBは復旧用に残す。
  partBytes = Math.min(partBytes, MAX_EXPORT_BUFFER_BYTES);
  // 1取得/保存の保守的な作業量の見積もり（MiB）。同時に持つ行は「束1つ（≤1 MiB）＋大きい行1本（≤1 MiB）」:
  // 束11 = wire/pg受信バッファの新旧・拡張8 + 受信した束の文字（UTF16。UTF8 の最大2倍）2
  //        + 束の行のオブジェクトと、渡し中の小さい行1本（≤16 KiB）の parse/stringify/改行/encode 1。
  // 大きい行24 = wire/pg受信バッファの新旧・拡張8 + UTF16の受信/parse/stringify/改行8
  //        + UTF8 encode1 + オブジェクト/列名/一時領域7（1 MiB の行1本の見積もり）。
  //   束の受信と大きい行の受信は時間で重ならない（束を受け終えてから取り直す）が、受信バッファも別々に足す。
  // part8 = UTF16の蓄積/連結/flatten6 + R2/hashのUTF8コピー2。
  // 原本48 = 最大16のarrayBuffer + 読込/保存側のコピー各16（1原本ずつawait）。
  // 合計91、ランタイム等の予備32を足して123 < 128。プロセスRSSの実測値ではなく、
  // 単一exportの行ペイロードの上限。カタログ/manifestの件数と他リクエストは別の予算。
  const progress = {tables: 0, rows: 0};
  const report = () => { if (onProgress) onProgress({...progress}); };
  const started = Date.now();
  const prefix = `pg-daily/${now.toISOString().replaceAll(':', '-')}-${runId}`;
  const guard = () => { if (Date.now() - started > maxDurationMs) throw exportError('export_deadline'); };
  const manifest = await inPgTransaction(db, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async client => {
    // RLSによる部分的な写しを成功にしない（権限が足りなければ読み取りが失敗する）。
    await client.query('SET LOCAL row_security = off');
    // 最初の SELECT がこの後のカタログ・全表と同じ snapshot を確保する。
    const snapshot = (await client.query('SELECT clock_timestamp()::text AS at, pg_current_snapshot()::text AS snapshot')).rows[0];
    const fingerprint = await readFingerprint(client);
    const tables = await readExportCatalog(client);
    if (tables.length !== Number(fingerprint.expected_tables)) throw exportError('schema_table_count');
    const blobs = new Map();
    const results = [];
    for (const table of tables) {
      guard();
      const hash = createHash('sha256'), parts = [];
      const sums = Object.fromEntries(moneyColumns(table.columns).map(name => [name, '0']));
      let lines = '', bytes = 0, count = 0n;
      const flush = async () => {
        const key = `${prefix}/tables/${table.table_name}/${String(parts.length).padStart(6, '0')}.ndjson`;
        guard();
        if (!await bucket.put(key, lines, {httpMetadata: {contentType: 'application/x-ndjson'}})) throw exportError('object_write_failed');
        parts.push({key, bytes, sha256: sha256(lines)});
        lines = ''; bytes = 0;
      };
      await scanExportTable(client, table, pageRows, async row => {
        guard();
        for (const [column, value] of Object.entries(row)) {
          if (!cloudR2Internals.externalColumns.get(table.table_name)?.has(column)) continue;
          const ref = cloudR2Internals.parseMarker(value);
          if (!ref) continue;
          const expected = `private/workbench/sha256/${ref.hash.slice(0, 2)}/${ref.hash}`;
          if (ref.key !== expected || ref.size < 0 || ref.size > cloudR2Internals.maxHydratedBytes) throw exportError('invalid_artifact_reference');
          if (blobs.has(ref.key)) {
            if (blobs.get(ref.key).bytes !== ref.size) throw exportError('artifact_checksum');
            continue;
          }
          const object = await artifacts?.get(ref.key);
          if (!object) throw exportError('artifact_missing');
          if (object.size !== ref.size) throw exportError('artifact_checksum');
          const data = new Uint8Array(await object.arrayBuffer());
          if (data.byteLength !== ref.size || sha256(data) !== ref.hash) throw exportError('artifact_checksum');
          const key = `${prefix}/blobs/${ref.hash}`;
          if (!await bucket.put(key, data)) throw exportError('object_write_failed');
          blobs.set(ref.key, {key, target: ref.key, bytes: ref.size, sha256: ref.hash});
        }
        const line = `${JSON.stringify(row)}\n`, size = new TextEncoder().encode(line).byteLength;
        if (size > MAX_EXPORT_ROW_BYTES) throw exportError('row_too_large');
        if (bytes && bytes + size > partBytes) await flush();
        lines += line; bytes += size; hash.update(line); count += 1n; addMoney(sums, row);
        progress.rows += 1;
        report();
      });
      if (bytes || !parts.length) await flush();
      results.push({...table, row_count: count.toString(), money_sums: sums, sha256: hash.digest('hex'), parts});
      progress.tables += 1;
      report();
    }
    return {format: EXPORT_FORMAT, generated_at: now.toISOString(), snapshot_at: snapshot.at, snapshot: snapshot.snapshot,
      schema: fingerprint, tables: results, blobs: [...blobs.values()]};
  });
  guard();
  // COMMIT と全オブジェクトの保存を終えたあとにだけ、復旧の入口を公開する。
  const manifestKey = `${prefix}/manifest.json`;
  const manifestText = JSON.stringify(manifest);
  if (new TextEncoder().encode(manifestText).byteLength > MAX_PART_BYTES) throw exportError('manifest_too_large');
  if (!await bucket.put(manifestKey, manifestText, {httpMetadata: {contentType: 'application/json'}})) throw exportError('manifest_write_failed');
  return {manifestKey, manifest};
}
