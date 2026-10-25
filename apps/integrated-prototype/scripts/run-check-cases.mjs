// 正解表の正答率を出す（フォルダ型の画面 U2a 後半。画面は無い）。
// 架空の種は test/fixtures/folder-check-cases/cases.json。DB は開かない。実在の原本は読まない。
// 基準に達した型（一致＝件数かつ件数は1以上）は 100%、それ以外は 100%未満。
// 両方の行が無いと終了コード 1。入力が壊れていれば終了コード 2。
// 取り込まない行の規則（skipRules）は適用しない。
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {formatScoreLine, scoreCheckCases} from '../src/revenue/folders/folders-cases.mjs';

const fixturePath = fileURLToPath(new URL('../test/fixtures/folder-check-cases/cases.json', import.meta.url));

export function scoreFixture(fixture) {
  if (!fixture || fixture.fictional !== true || !Array.isArray(fixture.types)) {
    throw new Error('正解表の種は fictional: true と types を持ちます');
  }
  return fixture.types.map(type => {
    const score = scoreCheckCases({
      headerColumns: type.headerColumns,
      checks: type.checks,
      moneyColumns: type.moneyColumns,
      splitByProduct: type.splitByProduct,
      cases: type.cases,
    });
    return {type, score, line: formatScoreLine(type, score)};
  });
}

function main() {
  let scored;
  try {
    scored = scoreFixture(JSON.parse(readFileSync(fixturePath, 'utf8')));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  for (const row of scored) console.log(row.line);
  const complete = scored.some(row => row.score.complete);
  const under = scored.some(row => !row.score.complete);
  if (!complete || !under) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
