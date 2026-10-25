// node --test の reporter。指標の出口（scripts/metrics.mjs）が読む JSON を1つ書く。
// 所要時間と流れた順に依らない値だけを残す（同じコミットで2回流して同じ値。goals/README.md）。
//   node --test --test-reporter=<この file: URL> --test-reporter-destination=<出力> test/a.test.mjs …
import {relative} from 'node:path';

const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];

// 試験の場所は cwd からの相対（posix）
const where = (file, cwd) => (file ? relative(cwd, file).replaceAll('\\', '/') : '');

// 落ちた試験の名前は「ファイル › 試験名」。ファイルの読み込みに失敗した本は試験名がファイルのパス（OS の区切り）なので、ファイルだけにする
function failureName({file, name = ''}, cwd) {
  const path = where(file, cwd);
  return !path || name.replaceAll('\\', '/') === path ? path || name : `${path} › ${name}`;
}

// events は node:test の reporter が受け取る {type, data}。最後のファイルを持たない test:summary が全体の件数
export function summarize(events, {cwd = process.cwd()} = {}) {
  const total = events.filter(e => e.type === 'test:summary' && !e.data?.file).at(-1);
  const counts = total ? Object.fromEntries(COUNT_KEYS.map(k => [k, total.data.counts?.[k] ?? 0])) : null;
  const failures = [...new Set(events.filter(e => e.type === 'test:fail').map(e => failureName(e.data ?? {}, cwd)))].sort();
  return {counts, failures};
}

export default async function* metricsReporter(source) {
  const events = [];
  for await (const event of source) {
    if (event.type !== 'test:summary' && event.type !== 'test:fail') continue;
    const {file, name, counts} = event.data ?? {};
    events.push({type: event.type, data: {file, name, counts}});
  }
  yield JSON.stringify(summarize(events)) + '\n';
}
