// FR-REV-FOLDER-009。正解表の正答率は、一致した件数÷件数。0件と、1件でも一致しない型は100%にしない。
// 期待する合否は、架空の原本の税込＝税抜＋税額と、行の内訳から決める。実装の戻りを写して期待にしない。
// 取り込まない行の規則は適用しない（形が文書に無い）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluateFolderChecks} from '../src/revenue/folders/folders-checks.mjs';
import {scoreCheckCases} from '../src/revenue/folders/folders-cases.mjs';
import {scoreFixture} from '../scripts/run-check-cases.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/folder-check-cases/cases.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/run-check-cases.mjs', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const byName = name => fixture.types.find(type => type.partnerName === name);

function scoreOf(type) {
  return scoreCheckCases({
    headerColumns: type.headerColumns,
    checks: type.checks,
    moneyColumns: type.moneyColumns,
    splitByProduct: type.splitByProduct,
    cases: type.cases,
  });
}

test('FR-REV-FOLDER-009 種の3通は、差し引きの検算で7つとも合い、端数の税抜は3004円、取り込まない行は合計に入らない', () => {
  const type = byName('架空配信');
  assert.deepEqual(type.cases.map(item => item.origin), ['normal', 'fractional', 'excluded']);
  const overlay = item => evaluateFolderChecks({
    ...item.input,
    typeVersion: {splitByProduct: type.splitByProduct, moneyColumns: type.moneyColumns, checks: type.checks},
  });
  const normal = overlay(type.cases[0]);
  const fractional = overlay(type.cases[1]);
  const excluded = overlay(type.cases[2]);
  assert.equal(normal.allPass, true);
  assert.equal(fractional.allPass, true);
  assert.equal(excluded.allPass, true);
  assert.equal(fractional.checks.find(check => check.key === 'totals').items.find(item => item.field === 'amountExTax').source, 3004);
  assert.equal(excluded.checks.find(check => check.key === 'totals').items.find(item => item.field === 'amountExTax').source, 3000);
  assert.equal(excluded.checks.find(check => check.key === 'row_count').pass, true);
});

test('FR-REV-FOLDER-009 基準に達した型は100%で、掛け算の型と0件の型は100%未満。規則の中身を変えても正答率は変わらない', () => {
  const met = scoreOf(byName('架空配信'));
  const short = scoreOf(byName('架空ストア'));
  const empty = scoreOf(byName('架空シネマ'));
  assert.deepEqual([met.matched, met.total, met.complete, met.label], [3, 3, true, '100%']);
  assert.equal(short.rows.every(row => row.checks.arithmetic === false), true);
  assert.deepEqual([short.matched, short.total, short.complete, short.label], [0, 3, false, '100%未満']);
  assert.deepEqual([empty.matched, empty.total, empty.complete, empty.label], [0, 0, false, '100%未満']);
  const withRule = scoreCheckCases({
    headerColumns: byName('架空配信').headerColumns,
    checks: byName('架空配信').checks,
    moneyColumns: byName('架空配信').moneyColumns,
    splitByProduct: true,
    cases: byName('架空配信').cases,
  });
  assert.deepEqual([withRule.matched, withRule.total], [met.matched, met.total]);
  const broken = scoreCheckCases({
    ...{
      headerColumns: byName('架空配信').headerColumns,
      checks: byName('架空配信').checks,
      moneyColumns: byName('架空配信').moneyColumns,
      splitByProduct: true,
    },
    cases: [{...byName('架空配信').cases[0], expected: {...byName('架空配信').cases[0].expected, totals: false}}],
  });
  assert.equal(broken.complete, false);
  assert.equal(broken.matched, 0);
});

test('FR-REV-FOLDER-009 run-check-cases.mjs は基準に達した型で100%、達していない型で100%未満を出す', () => {
  const lines = scoreFixture(fixture).map(row => row.line);
  assert.deepEqual(lines, [
    '架空配信 digital 3/3 100%',
    '架空ストア package 0/3 100%未満',
    '架空シネマ theatrical 0/0 100%未満',
  ]);
  const run = spawnSync(process.execPath, [scriptPath], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `${lines.join('\n')}\n`);
});
