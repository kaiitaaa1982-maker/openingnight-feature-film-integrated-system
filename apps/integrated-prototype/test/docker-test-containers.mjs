// 手元の Docker を使う ps1 の試験（test/pg-drill-ps1.test.mjs・test/pg-drill-migrate-ps1.test.mjs）が、途中で殺されて残したコンテナを片づける。
// 試験のコンテナの名前は on-drill-test-<種類>-<pid>[-…] か on-migrate-test-<種類>-<pid>[-…] で、名前の pid のプロセスがもう無いものだけを
// docker rm -f -v で消す（生きているほかの試験のコンテナと、名前の形の違うコンテナは消さない）。2026-10-09〜10-11 に5つ残っていた前例
import { spawnSync } from 'node:child_process';

export const TEST_CONTAINER = /^(?:on-drill-test|on-migrate-test)-[a-z0-9]+-(\d+)(?:-[a-z0-9]+)*$/;

// そのプロセスがあるか（signal 0 は存在だけを確かめる。権限が無くて断られたときもあるとみなす）
export function processAlive(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const dockerRun = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });

// 消したコンテナの名前の一覧を返す。docker が応えなければ何もしない
export function removeStaleTestContainers({ run = dockerRun, alive = processAlive } = {}) {
  const listed = run(['ps', '-a', '--format', '{{.Names}}']);
  if (listed.status !== 0) return [];
  const removed = [];
  for (const name of String(listed.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const hit = TEST_CONTAINER.exec(name);
    if (!hit || alive(Number(hit[1]))) continue;
    if (run(['rm', '-f', '-v', name]).status === 0) removed.push(name);
  }
  return removed;
}
