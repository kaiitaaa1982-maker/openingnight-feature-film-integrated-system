#!/usr/bin/env node
// Apply every migration to a new, isolated local D1. This never reads the
// production Wrangler config or credentials and has no remote D1 operation.
// An existing production D1 must not receive this baseline automatically;
// its migration history requires separate representative-led reconciliation.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { compareManifest, compareSummaries, inspect, validateManifest } from '../../../scripts/ops/d1-reconcile.mjs';
import { LocalDatabase } from '../src/db.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(app, 'migration-manifest.json');
const wranglerPath = resolve(app, 'node_modules/wrangler/bin/wrangler.js');
const databaseName = 'ci-empty-d1';
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function isolatedEnvironment(temp) {
  const inherited = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec'].reduce((env, name) => {
    if (process.env[name]) env[name] = process.env[name];
    return env;
  }, {});
  return {
    ...inherited,
    HOME: temp,
    USERPROFILE: temp,
    XDG_CONFIG_HOME: join(temp, 'config'),
    XDG_CACHE_HOME: join(temp, 'cache'),
    APPDATA: join(temp, 'appdata'),
    LOCALAPPDATA: join(temp, 'localappdata'),
    TEMP: temp,
    TMP: temp,
    CLOUDFLARE_SEND_METRICS: 'false',
    NO_COLOR: '1',
    CI: 'true',
  };
}

function sqliteFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.sqlite')) files.push(path);
    }
  }
  walk(root);
  return files;
}

function schema(db) {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY type,name").all();
  const tables = objects.filter((item) => item.type === 'table').map((item) => item.name);
  const columns = Object.fromEntries(tables.map((table) => [table, db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))]));
  const foreignKeys = Object.fromEntries(tables.map((table) => [table, db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()]));
  const indexes = Object.fromEntries(tables.map((table) => [table, db.prepare(`PRAGMA index_list(${quote(table)})`).all().map(({ name, unique, origin, partial }) => ({ name, unique, origin, partial, columns: db.prepare(`PRAGMA index_xinfo(${quote(name)})`).all().map(({ seqno, cid, name: column, desc, coll, key }) => ({ seqno, cid, column, desc, coll, key })) })).sort((a, b) => a.name.localeCompare(b.name))]));
  const triggers = objects.filter((item) => item.type === 'trigger').map(({ name, sql }) => ({ name, sql: sql.replace(/\s+/g, ' ').trim() }));
  return { tables, columns, foreignKeys, indexes, triggers };
}

function assertSchemaMatches(sqlitePath) {
  const local = new LocalDatabase(':memory:');
  const migrated = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const expected = schema(local.raw);
    const actual = schema(migrated);
    for (const key of Object.keys(expected)) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
        const first = key === 'indexes' || key === 'columns' || key === 'foreignKeys'
          ? Object.keys(expected[key]).find((table) => JSON.stringify(actual[key][table]) !== JSON.stringify(expected[key][table]))
          : undefined;
        throw new Error(`LocalDatabase schema mismatch: ${key}${first ? ` at ${first}: expected ${JSON.stringify(expected[key][first])}, actual ${JSON.stringify(actual[key][first])}` : ''}`);
      }
    }
    const fkErrors = migrated.prepare('PRAGMA foreign_key_check').all();
    if (fkErrors.length) throw new Error(`Foreign key check failed: ${fkErrors.length} violations`);
  } finally {
    migrated.close();
    local.close();
  }
}

function applyLocal(config, state, env) {
  const args = [wranglerPath, 'd1', 'migrations', 'apply', databaseName, '--local', '--persist-to', state, '--config', config];
  const result = spawnSync(process.execPath, args, { cwd: app, env, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local Wrangler migration failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
}

export async function verifyMigrations() {
  if (!existsSync(wranglerPath)) throw new Error('Fixed local Wrangler dependency is missing; run npm ci in apps/integrated-prototype');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  if (Object.hasOwn(manifest, 'rowCounts')) throw new Error('migration-manifest.json must not contain rowCounts');
  const temp = mkdtempSync(join(tmpdir(), 'openingnight-ci-d1-'));
  const safeRoot = realpathSync(tmpdir());
  try {
    const config = join(temp, 'wrangler.local.json');
    const state = join(temp, 'state');
    writeFileSync(config, JSON.stringify({
      name: 'ci-local-only',
      compatibility_date: '2026-09-01',
      d1_databases: [{ binding: 'DB', database_name: databaseName, database_id: '00000000-0000-4000-8000-000000000000', migrations_dir: resolve(app, 'migrations') }],
    }));
    const env = isolatedEnvironment(temp);
    applyLocal(config, state, env);
    const databases = sqliteFiles(state).filter((file) => {
      const candidate = new DatabaseSync(file, { readOnly: true });
      try {
        return Boolean(candidate.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get());
      } finally {
        candidate.close();
      }
    });
    if (databases.length !== 1) throw new Error(`Expected one local D1 SQLite file; found ${databases.length}`);
    const database = databases[0];
    const before = await inspect(database);
    const differences = compareManifest(before, manifest);
    if (differences.length) throw new Error(`Migration manifest mismatch: ${differences.map((item) => item.message).join('; ')}`);
    if (!before.objects.tables.includes('d1_migrations')) throw new Error('d1_migrations is missing from the local D1');
    assertSchemaMatches(database);
    applyLocal(config, state, env);
    const after = await inspect(database);
    const replayDifferences = compareSummaries(before, after);
    if (replayDifferences.length) throw new Error(`Second apply changed D1: ${replayDifferences.map((item) => item.message).join('; ')}`);
    process.stdout.write(`Local D1 migrations verified: ${before.tables} tables, ${before.triggers} triggers, ${before.indexes} indexes, ${before.views} views; repeat apply unchanged.\n`);
  } finally {
    const realTemp = realpathSync(temp);
    if (!realTemp.startsWith(safeRoot + sep) || !realTemp.startsWith(join(safeRoot, 'openingnight-ci-d1-'))) throw new Error('Unsafe temporary directory cleanup target');
    rmSync(realTemp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No database or remote arguments are accepted');
  verifyMigrations().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
