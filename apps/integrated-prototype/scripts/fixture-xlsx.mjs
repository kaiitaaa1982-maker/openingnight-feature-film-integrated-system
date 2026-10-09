// 架空の原本の XLSX を、読める OOXML の部品（fixtures/xlsx-source/<slug>/。git で追跡）から組み立てる。
// scripts/prepare-test-assets.mjs（public/demo-fixtures/<slug>-sample.xlsx へ書き出す。その XLSX は git に入らない）と、
// 計測（scripts/measure-common.mjs。書き出さずに手元で使う）が同じ道具を使い、同じ部品なら同じバイトになる
// （部品の並びは parts.json の順・時刻は 2000-01-01 に固定・fflate の level 6）。部品の SHA-256 が parts.json と違えば止める
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {zipSync} from 'fflate';

export const FIXTURE_SOURCE_ROOT = new URL('../fixtures/xlsx-source/', import.meta.url);
const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');

export function buildFixtureXlsx(slug, {root = FIXTURE_SOURCE_ROOT} = {}) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw Error('Invalid fixture slug');
  const dir = new URL(`${slug}/`, root);
  const manifest = JSON.parse(readFileSync(new URL('parts.json', dir), 'utf8'));
  const parts = {};
  for (const [name, expected] of Object.entries(manifest)) {
    if (!/^[A-Za-z0-9_\[\]./-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..')) throw Error('Invalid fixture path');
    const bytes = readFileSync(new URL(name, dir));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error(`Fixture changed: ${slug}/${name}`);
    parts[name] = [bytes, {mtime: FIXED_MTIME}];
  }
  return zipSync(parts, {level: 6});
}
