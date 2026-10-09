#!/usr/bin/env node
// staging 専用。空の移行済み DB で既存の売上デモを記録し、同じ記録から D1・PostgreSQL の SQL を作る。
// 外部へ接続しない。data/staging-seed/ は生成物で git に入れない。代表の在籍は別に入れる（runbook 13）。
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { LocalDatabase } from '../src/db.mjs';
import { recordingDatabase, businessBatches, recordLines, databaseFingerprint } from './seed-all-demo.mjs';
import { seedSalesDemo, SALES_DEMO } from './seed-sales-demo.mjs';
import { recordToSql, sqlValue } from './seed-record-to-sql.mjs';
import { convertMigrations, MIGRATIONS_DIR, pgType } from './pg-ddl.mjs';
import { rewriteLite, lexSql, insertTarget, jsonInsertItems } from '../src/data-platform/pg-db.mjs';

const app = fileURLToPath(new URL('..', import.meta.url));
export const STAGING_SEED_DIR = resolve(app, 'data/staging-seed');
const quote = s => `"${s.replaceAll('"', '""')}"`;
const guard = condition => `INSERT INTO transaction_guards(value) SELECT 0 WHERE ${condition};`;

export async function stagingRecord() {
  const db = new LocalDatabase(':memory:', { init: false });
  try {
    for (const name of readdirSync(MIGRATIONS_DIR).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort()) db.raw.exec(readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'));
    const fingerprint = await databaseFingerprint(db);
    const recorder = recordingDatabase(db);
    recorder.step = 'sales';
    await seedSalesDemo(recorder);
    const after = await databaseFingerprint(db);
    return recordLines(businessBatches(recorder.batches), { fingerprint, after, asOf: SALES_DEMO.asOf,
      steps: [{key: 'sales', skipped: false}], source: 'empty-migrations-staging' });
  } finally { db.close(); }
}

function pgGuards(fingerprint, identities) {
  const names = Object.keys(fingerprint.counts).sort();
  const out = [guard(`(SELECT count(*) FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p') AND relname NOT IN ('sessions','schema_source_fingerprint','d1_migrations'))<>${names.length}`)];
  for (const name of names) {
    const conditions = [`(SELECT count(*) FROM ${quote(name)})<>${fingerprint.counts[name]}`];
    const column = identities.get(name);
    if (Object.hasOwn(fingerprint.rowids ?? {}, name)) {
      if (!column) throw new Error(`IDENTITY がない表の rowid: ${name}`);
      conditions.push(`(SELECT coalesce(max(${quote(column)}),0) FROM ${quote(name)})<>${fingerprint.rowids[name]}`);
    }
    out.push(guard(conditions.join(' OR ')));
  }
  return out;
}

// 一般の本番移行には使わない。空の staging と .invalid の売上デモの記録だけを受け付ける。
export function stagingSql(record) {
  const converted = recordToSql(record); // sessions・DDL・R2 の値・D1 の上限・前後の指紋を既存の検査で守る
  const head = converted.head;
  if (head.source !== 'empty-migrations-staging' || !head.after || head.fingerprint.counts.organizations !== 0 || head.fingerprint.counts.users !== 0
      || head.after.orgs?.length !== 1 || head.after.orgs[0][0] !== 1 || head.after.orgs[0][1] !== 'DEMO-SALES'
      || head.after.users?.length !== 1 || head.after.users.some(([, email]) => !email.endsWith('.invalid'))) throw new Error('空の staging の架空売上記録だけを指定する');
  const generated = convertMigrations();
  if (generated.errors.length) throw new Error('DDL を生成できない');
  const identities = new Map(generated.identities.map(x => [x.table, x.column]));
  // 既存の変換器が作った1文1行の SQL のうち、記録の部分だけを共有する。
  const body = converted.sql.split('-- ---- 2. 記録 ----\n')[1].split('-- ---- 3. 当てた後の確かめ')[0];
  const statements = body.split('\n').filter(x => x && !x.startsWith('--'));
  const pg = [];
  for (const sql of statements) {
    const tokens = lexSql(sql);
    if (tokens.some(t => t.kind === 'word' && /^(rowid|sqlite_master|sqlite_sequence)$/i.test(t.text))) throw new Error('SQLite 専用の記録は使えない');
    if (sql.includes('char(0)') || /\bX'[0-9a-f]*'/i.test(sql)) throw new Error('staging の SQL に NUL・バイナリは入れない');
    const rewritten = rewriteLite(sql);
    const texts = rewritten.tokens.map(t => t.kind === 'word' && t.text.toLowerCase() === 'char' ? 'chr' : t.text);
    const json = jsonInsertItems(rewritten.tokens);
    if (json) {
      const columns = generated.tableDefs.get(json.table)?.columns;
      for (const {column, first, last} of json.items) {
        const definition = columns?.find(c => c.name === column);
        if (!definition) throw new Error(`列の型がない: ${json.table}.${column}`);
        const type = pgType(definition.declared);
        if (type === 'text') continue;
        texts[first] = `CAST(${texts[first]}`;
        texts[last] = `${texts[last]} AS ${type})`;
      }
    }
    const text = texts.join('');
    pg.push(text);
    const target = insertTarget(sql);
    const id = identities.get(target?.table);
    if (id && (!target.columns || target.columns.includes(id))) {
      pg.push(`SELECT setval(pg_get_serial_sequence(${sqlValue(target.table)},${sqlValue(id)}),coalesce(max(${quote(id)}),0)+1,false) FROM ${quote(target.table)};`);
    }
  }
  const banner = '-- 架空の売上デモ。scripts/seed-staging.mjs が同じ記録から生成。代表の在籍は別途入力。\n';
  const pgSql = [banner, '-- psql -1 -v ON_ERROR_STOP=1 で全体を1つのトランザクションとして当てる。',
    ...pgGuards(head.fingerprint, identities), ...pg, ...pgGuards(head.after, identities), ''].join('\n');
  return { d1: banner + converted.sql, pg: pgSql, counts: head.after.counts };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('引数は不要。空の staging 用 SQL だけを data/staging-seed に作る');
  const record = await stagingRecord();
  const sql = stagingSql(record);
  mkdirSync(STAGING_SEED_DIR, { recursive: true });
  writeFileSync(resolve(STAGING_SEED_DIR, 'record.jsonl'), record);
  writeFileSync(resolve(STAGING_SEED_DIR, 'd1.sql'), sql.d1);
  writeFileSync(resolve(STAGING_SEED_DIR, 'pg.sql'), sql.pg);
  writeFileSync(resolve(STAGING_SEED_DIR, 'counts.json'), JSON.stringify(sql.counts, null, 2) + '\n');
  console.log('data/staging-seed に record.jsonl・d1.sql・pg.sql・counts.json を作った（外部へは送っていない）');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
