#!/usr/bin/env node
// The baseline is generated only from a fresh LocalDatabase(':memory:') and
// its static reference codes. No existing database path is accepted here.
// Never auto-apply this baseline to an existing production D1. Recording an
// existing database's migration history requires a separate representative-led
// schema/data reconciliation.

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDatabase } from '../src/db.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(app, 'migrations/0001_initial.sql');
const referenceTables = ['recognition_bases', 'distribution_types', 'distribution_master'];
const objectOrder = ['table', 'index', 'trigger', 'view'];
const quote = (value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const ident = (value) => `"${value.replaceAll('"', '""')}"`;

export function generateInitialMigration() {
  const local = new LocalDatabase(':memory:');
  try {
    const db = local.raw;
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const parts = [
      '-- Generated from an empty LocalDatabase(\':memory:\') schema and static reference codes.\n'
      + '-- No demo organization, user, project, work, or operational rows are seeded.\n'
      + '-- Do not apply automatically to an existing production database.\n',
    ];
    for (const kind of objectOrder) {
      for (const object of objects.filter((entry) => entry.type === kind)) {
        if (Buffer.byteLength(object.sql, 'utf8') > 100_000) throw new Error(`D1 statement exceeds 100 KB: ${object.name}`);
        parts.push(`${object.sql};`);
      }
    }
    for (const table of referenceTables) {
      const columns = db.prepare(`PRAGMA table_info(${ident(table)})`).all().map((column) => column.name);
      if (!columns.length) throw new Error(`Missing reference table: ${table}`);
      const rows = db.prepare(`SELECT * FROM ${ident(table)} ORDER BY ${ident(columns[0])}`).all();
      for (const row of rows) {
        const statement = `INSERT INTO ${ident(table)} (${columns.map(ident).join(',')}) VALUES (${columns.map((name) => quote(row[name])).join(',')});`;
        if (Buffer.byteLength(statement, 'utf8') > 100_000) throw new Error(`D1 seed statement exceeds 100 KB: ${table}`);
        parts.push(statement);
      }
    }
    return parts.join('\n\n') + '\n';
  } finally {
    local.close();
  }
}

export function writeInitialMigration() {
  if (existsSync(target)) throw new Error('0001_initial.sql already exists; numbered migrations are immutable');
  writeFileSync(target, generateInitialMigration(), { flag: 'wx' });
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No database path or generator arguments are accepted');
  process.stdout.write(`Generated ${writeInitialMigration()}\n`);
}
