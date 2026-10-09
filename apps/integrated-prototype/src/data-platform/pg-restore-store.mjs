// 空の PostgreSQL 専用の復旧。DDL・全行・制約の復帰まで1トランザクション。
import {createHash} from 'node:crypto';
import {cloudR2Internals} from '../cloud-r2-db.mjs';
import {EXPORT_FORMAT, MAX_PART_BYTES, quoteIdentifier as q, exportError, moneyColumns, addMoney, compareReconciliation} from './pg-export-format.mjs';
import {inPgTransaction, readExportCatalog, readFingerprint, scanExportTable, sha256} from './pg-export-store.mjs';

async function checkedObject(bucket, part, prefix) {
  if (!part || typeof part.key !== 'string' || !part.key.startsWith(`${prefix}/`) || part.key.split('/').some(p => !p || p === '.' || p === '..') ||
      !Number.isSafeInteger(part.bytes) || part.bytes < 0 || part.bytes > MAX_PART_BYTES || !/^[a-f0-9]{64}$/.test(part.sha256)) throw exportError('invalid_part');
  const object = await bucket.get(part.key);
  if (!object || object.size > MAX_PART_BYTES) throw exportError('part_missing_or_large');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== part.bytes || sha256(bytes) !== part.sha256) throw exportError('part_checksum');
  return bytes;
}

export async function restorePgDatabase({db, bucket, manifestKey, schemaSql, artifacts} = {}) {
  if (typeof manifestKey !== 'string' || !/^pg-daily\/[a-zA-Z0-9.-]+\/manifest\.json$/.test(manifestKey) || typeof schemaSql !== 'string') throw exportError('invalid_restore_options');
  const prefix = manifestKey.slice(0, -'/manifest.json'.length);
  const object = await bucket.get(manifestKey);
  if (!object || object.size > MAX_PART_BYTES) throw exportError('manifest_missing');
  let manifest;
  try { manifest = JSON.parse(await object.text()); } catch { throw exportError('manifest_invalid'); }
  if (manifest?.format !== EXPORT_FORMAT || !Array.isArray(manifest.tables) || !manifest.tables.length || !Array.isArray(manifest.blobs)) throw exportError('manifest_invalid');
  // 重複・欠落した件数/金額は挿入の前に断る。
  compareReconciliation(manifest, manifest);
  const blobTargets = new Set();
  for (const blob of manifest.blobs) {
    const target = `private/workbench/sha256/${blob.sha256?.slice(0, 2)}/${blob.sha256}`;
    if (blob.target !== target || blobTargets.has(target) || !Number.isSafeInteger(blob.bytes) || blob.bytes < 0 ||
        blob.bytes > cloudR2Internals.maxHydratedBytes || !artifacts?.put) throw exportError('invalid_artifact_target');
    blobTargets.add(target);
  }
  return inPgTransaction(db, 'BEGIN', async client => {
    const existing = await client.query(`SELECT 1 FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'S', 'f') LIMIT 1`);
    if (existing.rows.length) throw exportError('target_not_empty');
    // schema.sql は main の信頼した生成物を代表が指定する。アーカイブの SQL は実行しない。
    await client.query(schemaSql);
    const fingerprint = await readFingerprint(client);
    if (JSON.stringify(fingerprint) !== JSON.stringify(manifest.schema)) throw exportError('schema_mismatch');
    const catalog = await readExportCatalog(client);
    if (catalog.length !== manifest.tables.length || catalog.length !== Number(fingerprint.expected_tables)) throw exportError('table_set_mismatch');
    for (let i = 0; i < catalog.length; i += 1) {
      const table = manifest.tables[i];
      if (catalog[i].table_name !== table.table_name || JSON.stringify(catalog[i].columns) !== JSON.stringify(table.columns) ||
          !Array.isArray(table.parts) || !table.parts.length) throw exportError('table_shape_mismatch');
    }
    // DDL の初期行も復旧元の行に置き換える。空だった先へ今作った表に限る。
    await client.query(`TRUNCATE ${catalog.map(t => q(t.table_name)).join(', ')}`);
    const constraints = (await client.query(`SELECT c.conname AS name, t.relname AS table_name, c.condeferrable AS deferred, c.condeferred AS initially
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace`)).rows;
    const triggers = (await client.query(`SELECT t.tgname AS name, c.relname AS table_name, t.tgenabled AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal`)).rows;
    // 追記・版の業務トリガーを一時停止。FK は無効化せず最後まで遅延して全件を検査する。
    for (const table of catalog) await client.query(`ALTER TABLE ${q(table.table_name)} DISABLE TRIGGER USER`);
    for (const fk of constraints) await client.query(`ALTER TABLE ${q(fk.table_name)} ALTER CONSTRAINT ${q(fk.name)} DEFERRABLE INITIALLY DEFERRED`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const restored = [];
    const referencedBlobs = new Set();
    for (const table of manifest.tables) {
      const hash = createHash('sha256'), sums = Object.fromEntries(moneyColumns(table.columns).map(name => [name, '0']));
      let count = 0n;
      const columns = table.columns.filter(c => !c.generated);
      const sql = `INSERT INTO ${q(table.table_name)} (${columns.map(c => q(c.name)).join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
      for (let index = 0; index < table.parts.length; index += 1) {
        const part = table.parts[index];
        if (part.key !== `${prefix}/tables/${table.table_name}/${String(index).padStart(6, '0')}.ndjson`) throw exportError('part_order');
        const bytes = await checkedObject(bucket, part, prefix);
        hash.update(bytes);
        const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        if (text && !text.endsWith('\n')) throw exportError('invalid_ndjson');
        for (const line of text ? text.slice(0, -1).split('\n') : []) {
          let row;
          try { row = JSON.parse(line); } catch { throw exportError('invalid_ndjson'); }
          if (!row || JSON.stringify(Object.keys(row)) !== JSON.stringify(table.columns.map(c => c.name)) ||
              Object.values(row).some(v => v !== null && typeof v !== 'string')) throw exportError('invalid_row_shape');
          for (const column of cloudR2Internals.externalColumns.get(table.table_name) ?? []) {
            const ref = cloudR2Internals.parseMarker(row[column]);
            if (!ref) continue;
            const blob = manifest.blobs.find(b => b.target === ref.key);
            if (!blob || blob.bytes !== ref.size || blob.sha256 !== ref.hash) throw exportError('artifact_manifest_missing');
            referencedBlobs.add(ref.key);
          }
          await client.query(sql, columns.map(c => row[c.name]));
          addMoney(sums, row); count += 1n;
        }
      }
      if (hash.digest('hex') !== table.sha256) throw exportError('table_checksum');
      restored.push({table_name: table.table_name, row_count: count.toString(), money_sums: sums});
    }
    if (!compareReconciliation(manifest, restored).equal) throw exportError('restore_reconciliation');
    if (referencedBlobs.size !== manifest.blobs.length) throw exportError('artifact_manifest_extra');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    for (const fk of constraints) await client.query(`ALTER TABLE ${q(fk.table_name)} ALTER CONSTRAINT ${q(fk.name)} ${fk.deferred ? `DEFERRABLE INITIALLY ${fk.initially ? 'DEFERRED' : 'IMMEDIATE'}` : 'NOT DEFERRABLE'}`);
    for (const trigger of triggers) {
      const mode = {O: 'ENABLE', D: 'DISABLE', R: 'ENABLE REPLICA', A: 'ENABLE ALWAYS'}[trigger.enabled];
      if (!mode) throw exportError('trigger_state');
      await client.query(`ALTER TABLE ${q(trigger.table_name)} ${mode} TRIGGER ${q(trigger.name)}`);
    }
    // 戻した後に自動採番で既存 ID に衝突しない。業務行の最大値から再開する。
    for (const table of catalog) for (const column of table.columns.filter(c => c.identity)) {
      await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE(MAX(${q(column.name)}), 1), 1), COALESCE(MAX(${q(column.name)}), 0) >= 1) FROM ${q(table.table_name)}`, [q(table.table_name), column.name]);
    }
    // 挿入後のDB自体を読み直す（生成列も含む）。書き込み途中で算出した数字だけで成功にしない。
    const actual = [];
    for (const table of catalog) {
      const sums = Object.fromEntries(moneyColumns(table.columns).map(name => [name, '0']));
      let count = 0n;
      await scanExportTable(client, table, 16, row => { count += 1n; addMoney(sums, row); });
      actual.push({table_name: table.table_name, row_count: count.toString(), money_sums: sums});
    }
    if (!compareReconciliation(manifest, actual).equal) throw exportError('database_reconciliation');
    for (const blob of manifest.blobs) {
      if (blob.key !== `${prefix}/blobs/${blob.sha256}`) throw exportError('invalid_artifact_key');
      const bytes = await checkedObject(bucket, blob, prefix);
      if (!await artifacts.put(blob.target, bytes)) throw exportError('artifact_write_failed');
    }
    db.identities = null; db.types = null;
    return {tables: actual};
  });
}
