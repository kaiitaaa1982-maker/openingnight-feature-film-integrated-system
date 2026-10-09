// docs/rules/database.md の「移行の決まり」のうち、機械で守れる部分を確かめる。
// main に入った移行は書き換えない（中身の指紋で守る）。番号は4桁の連番で、抜けも重複も無い。
// 新しい移行を足す PR では、下の一覧に指紋を1行足す（足し忘れもこのテストが見つける）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// ファイル名と、改行を LF にそろえた中身の SHA-256。
const MERGED = new Map([
  ['0011_cloud_analytics.sql', 'f2194222ccd3753187e16ecab3326c6f67f11e3f4b3f1670aea3025c08708a3f'],
  ['0001_initial.sql', '73ff55a61e48904c4c3306fb21dc43773a80fa209f77cd71bde3e2b44d36b423'],
  ['0002_ux_extensions.sql', 'b7bba18a3b029a18d7ff9cb13da20ec491d8d3a672a3eeefd2b5b89f068bdcc6'],
  ['0003_royalty_committee.sql', '0c5bb1e3dbfe10dec4442d9ad4f1028a513c8dd74f8bbb2321f4930382cd9b6b'],
  ['0004_eigyo_sales_sheet.sql', '40331ee69cb7ab23778828ea33f9f24d519f6ab9ce4895ace6cb5ff72f6ecb66'],
  ['0005_sales_proposals.sql', 'd5e15d3322766ce5e2eb398d51e49fda88733753866d6def9c2c72ddadb37704'],
  ['0006_broadcast_windows.sql', 'd36f3856eb1f0cea8d53f21a9e12e1e0da27da9036c909a616e4453dbf04b28a'],
  ['0007_pl_bs.sql', '54ab01f5421563686da06ac8c95a626d606f50a4aba4ff25fca600d5bff33652'],
  ['0008_broadcast_proposal_drafts.sql', '9f1f958667d4f53b208929a0d0f2daa0a74658a7304131eae598591ea0d14c14'],
  ['0009_req5_master_extensions.sql', '168cd4c050debbdc4cd5431a4775f830b48b92c8748f53c3df483e1fed0fb36e'],
  ['0010_req6_expenses.sql', 'e124b800c7199b73b8e4986c754f41f8ef3dac657fd4b8341147c336fa050ae7'],
]);

const fingerprint = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

export function numberingProblems(names) {
  const problems = [];
  names.forEach((name, i) => {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!m) problems.push(`${name}: 名前は「4桁の番号_英小文字.sql」にする`);
    else if (Number(m[1]) !== i + 1) problems.push(`${name}: ${String(i + 1).padStart(4, '0')} のはず（抜けか重複）`);
  });
  return problems;
}

const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();

test('移行の番号は4桁の連番で、抜けも重複も無い', () => {
  assert.deepEqual(numberingProblems(files), []);
});

test('main に入った移行は書き換えていない', () => {
  const changed = [...MERGED].filter(([name, hash]) =>
    files.includes(name) && fingerprint(readFileSync(join(dir, name), 'utf8')) !== hash).map(([name]) => name);
  assert.deepEqual(changed, [], '書き換えずに、次の番号の移行を足して直す');
});

test('main に入った移行は消していない', () => {
  assert.deepEqual([...MERGED.keys()].filter(name => !files.includes(name)), []);
});

test('新しい移行は指紋の一覧に載っている', () => {
  assert.deepEqual(files.filter(name => !MERGED.has(name)), [], '足した移行の指紋を MERGED に1行足す');
});

test('番号の検査は抜けと重複と名前の崩れを見逃さない', () => {
  assert.deepEqual(numberingProblems(['0001_a.sql', '0002_b.sql']), []);
  assert.equal(numberingProblems(['0001_a.sql', '0003_b.sql']).length, 1);
  assert.equal(numberingProblems(['0001_a.sql', '0001_b.sql']).length, 1);
  assert.equal(numberingProblems(['1_a.sql']).length, 1);
});
