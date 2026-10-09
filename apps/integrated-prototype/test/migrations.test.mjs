import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writeInitialMigration } from '../scripts/generate-initial-migration.mjs';
import { cloudAnalyticsSql } from '../src/cloud-analytics.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('FR-CORE-DATA-017 分析の2表と索引は移行だけで作られ、既存の行を変えず当て直せる', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync(resolve(app, 'migrations')).filter(x => x.endsWith('.sql')).sort()) db.exec(readFileSync(resolve(app, 'migrations', file), 'utf8'));
    const migration = readFileSync(resolve(app, 'migrations/0011_cloud_analytics.sql'), 'utf8');
    assert.equal(migration.trim(), cloudAnalyticsSql.trim());
    db.exec("INSERT INTO cloud_analytics_state(org_id,generation) VALUES(1,7)");
    db.exec("INSERT INTO cloud_analytics_jobs(id,org_id,generation,status,as_of,definition_version,created_at) VALUES('fictional-job',1,7,'running','2026-10-04','demo','2026-10-04')");
    db.exec(migration);
    assert.equal(db.prepare('SELECT generation FROM cloud_analytics_state').get().generation, 7);
    assert.equal(db.prepare('SELECT count(*) n FROM cloud_analytics_jobs').get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='cloud_analytics_jobs_org' AND type='index'").get().n, 1);
  } finally { db.close(); }
});

test('initial migration seeds only reference codes', () => {
  const migration = readFileSync(resolve(app, 'migrations/0001_initial.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(migration);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    for (const table of ['organizations', 'users', 'projects', 'works', 'partners', 'products']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0, `${table} must start empty`);
    }
    for (const table of ['recognition_bases', 'distribution_types', 'distribution_master']) {
      assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n > 0, `${table} needs static codes`);
    }
  } finally {
    db.close();
  }
});

test('initial migration generator refuses to overwrite numbered history', () => {
  assert.throws(() => writeInitialMigration(), /already exists/);
});

test('migration manifest has structure counts without row counts', () => {
  const manifest = JSON.parse(readFileSync(resolve(app, 'migration-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['indexes', 'tables', 'triggers', 'views']);
  for (const count of Object.values(manifest)) assert.ok(Number.isInteger(count) && count >= 0);
});
