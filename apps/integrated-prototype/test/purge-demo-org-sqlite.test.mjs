// デモの組織を消す道具（scripts/purge-demo-org.mjs）。SQLite のファイルを道具が開き、sqlite_master と PRAGMA から表と外部キーを引き、
// 消せない記録を守るトリガーを同じトランザクションの中だけ外して当て直す SQLite だけの消し方を確かめる（test/pg-matrix.json の sqliteOnly）。
// 架空の組織だけを使う: 組織1（試作の初期の組織）を本番（real）にし、架空データの組織 DEMO-SALES（demo）を消す。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase} from '../src/db.mjs';
import {SALES_DEMO, seedSalesDemo} from '../scripts/seed-sales-demo.mjs';
import {deleteOrder, parseArgs, purgeDemoOrg} from '../scripts/purge-demo-org.mjs';

const script = fileURLToPath(new URL('../scripts/purge-demo-org.mjs', import.meta.url));
const REAL_ORG = 1;
let dir;
let base;
let copies = 0;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'purge-demo-'));
  base = join(dir, 'base.sqlite');
  const db = new LocalDatabase(base);
  try {
    await seedSalesDemo(db);
    await db.run("UPDATE organizations SET kind='real' WHERE id=?", [REAL_ORG]);
    // 本番の組織にも、消せない記録（DELETE を拒むトリガーのある表）の行を持たせる
    const admin = Number((await db.get('SELECT user_id FROM memberships WHERE org_id=? AND role=? ORDER BY user_id LIMIT 1', [REAL_ORG, 'admin'])).user_id);
    await db.run("INSERT INTO sales_sheet_views(org_id,name,created_by) VALUES(?,'架空の本番の見え方',?)", [REAL_ORG, admin]);
    const work = Number((await db.get('SELECT id FROM works WHERE org_id=? ORDER BY id LIMIT 1', [REAL_ORG])).id);
    await db.run("INSERT INTO work_contracts(org_id,work_id,contract_key) VALUES(?,?,'REAL-CONTRACT-1')", [REAL_ORG, work]);
  } finally {
    db.close();
  }
});
after(() => rmSync(dir, {recursive: true, force: true}));

// 試験ごとに、閉じた土台のファイルを写して使う
const fresh = () => {
  copies += 1;
  const file = join(dir, `copy-${copies}.sqlite`);
  copyFileSync(base, file);
  return file;
};
const open = (file) => {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys=ON');
  return raw;
};
const run = (args) => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const demoOrgId = (raw) => Number(raw.prepare('SELECT id FROM organizations WHERE code=?').get(SALES_DEMO.orgCode).id);

// 道具とは別に書いた数え方: org_id を持つ表ごとに、組織ごとの行の数。組織の表は id ごと。org_id の無い表は全部の行
function snapshot(raw) {
  const out = {};
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  for (const table of tables) {
    const hasOrg = raw.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(table, 'org_id');
    const key = table === 'organizations' ? 'id' : hasOrg ? 'org_id' : null;
    const rows = key
      ? raw.prepare(`SELECT ${key} AS org, COUNT(*) AS n FROM "${table}" GROUP BY ${key}`).all()
      : [{org: 'all', n: raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n}];
    for (const row of rows) out[`${table}@${row.org}`] = Number(row.n);
  }
  return out;
}
const without = (counts, orgId) => Object.fromEntries(Object.entries(counts).filter(([key]) => !key.endsWith(`@${orgId}`)));
const ofOrg = (counts, orgId) => Object.entries(counts).filter(([key, n]) => key.endsWith(`@${orgId}`) && n > 0);
const triggers = (raw) => raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((row) => `${row.name}\n${row.sql}`);

test('予行が既定で、消す行を表ごとに数えるだけで DB のファイルを1バイトも変えない', () => {
  const file = fresh();
  const raw = open(file);
  const counts = snapshot(raw);
  const demo = demoOrgId(raw);
  raw.close();
  const hash = digest(file);
  const result = run(['--db', file, SALES_DEMO.orgCode]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /予行です。何も消していません/);
  const expected = ofOrg(counts, demo);
  const total = expected.reduce((sum, [, n]) => sum + n, 0);
  assert.ok(expected.length > 20 && total > 1000, `架空データが入っている（${expected.length}表・${total}行）`);
  assert.match(result.stdout, new RegExp(`合計 ${total}行（${expected.length}表）`));
  for (const [key, n] of expected) assert.match(result.stdout, new RegExp(`\\n  ${key.split('@')[0]}\\t${n}\\n`), key);
  assert.equal(digest(file), hash, 'ファイルは変わらない');
  // --dry-run を明示しても同じ
  assert.equal(run(['--db', file, SALES_DEMO.orgCode, '--dry-run']).status, 0);
  assert.equal(digest(file), hash);
});

test('本番の組織（kind=real）を指すと、予行でも --apply でも終了コード2で止まり、何も消さない', () => {
  const file = fresh();
  const raw = open(file);
  const realCode = raw.prepare('SELECT code FROM organizations WHERE id=?').get(REAL_ORG).code;
  raw.close();
  const hash = digest(file);
  for (const args of [[], ['--apply'], ['--dry-run']]) {
    const result = run(['--db', file, realCode, ...args]);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /本番（kind=real）です/);
    assert.doesNotMatch(result.stdout, /消した行/);
  }
  assert.equal(digest(file), hash, 'ファイルは変わらない');
});

test('--apply はデモの組織の行だけを全部の表から消し、本番の組織と別のデモの組織の行は1行も減らない', () => {
  const file = fresh();
  const raw = open(file);
  const demo = demoOrgId(raw);
  const before = snapshot(raw);
  const beforeTriggers = triggers(raw);
  raw.close();
  assert.ok(ofOrg(before, REAL_ORG).length > 10, '本番の組織にも行がある');
  // 消せない記録（DELETE を拒むトリガーのある表）に、本番の組織とデモの組織の行がある
  for (const key of ['sales_sheet_views@1', 'work_contracts@1', `royalty_agreements@${demo}`, `committee_term_funding@${demo}`]) assert.ok(before[key] > 0, key);
  const result = run(['--db', file, SALES_DEMO.orgCode, '--apply']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /消した行（表ごと）/);
  const check = open(file);
  const afterCounts = snapshot(check);
  assert.deepEqual(ofOrg(afterCounts, demo), [], 'デモの組織の行は残らない（組織の行を含む）');
  assert.deepEqual(without(afterCounts, demo), without(before, demo), 'ほかの組織の行と組織を持たない表（利用者など）は1行も変わらない');
  assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), [], '参照の切れた行が無い');
  assert.deepEqual(triggers(check), beforeTriggers, 'トリガーは元の定義のまま戻っている');
  // 戻したトリガーは、本番の組織の消せない記録をこれまでどおり守る
  assert.throws(() => check.prepare('DELETE FROM sales_sheet_views WHERE org_id=?').run(REAL_ORG), /sales sheet view immutable/);
  assert.throws(() => check.prepare('DELETE FROM work_contracts WHERE org_id=?').run(REAL_ORG), /master version immutable/);
  check.close();
  // 消したあとに同じコードを指すと、組織が無いので終了コード1
  const again = run(['--db', file, SALES_DEMO.orgCode, '--apply']);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /がありません/);
});

test('ほかの組織の行がデモの組織の行を指していると、消さずに終了コード1で止まる（組織の切替の記録）', () => {
  const file = fresh();
  const raw = open(file);
  const demo = demoOrgId(raw);
  // 両方に所属する架空の管理者が、デモから本番の組織へ切り替えた記録（行は本番の組織のもの）
  const user = Number(raw.prepare('SELECT id FROM users WHERE email=?').get(SALES_DEMO.fixtureAdminEmail).id);
  raw.prepare('INSERT INTO org_switch_events(org_id,user_id,from_org_id) VALUES(?,?,?)').run(REAL_ORG, user, demo);
  const before = snapshot(raw);
  raw.close();
  const result = run(['--db', file, SALES_DEMO.orgCode, '--apply']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /org_switch_events\(from_org_id,user_id\) → memberships\t1行/);
  const check = open(file);
  assert.deepEqual(snapshot(check), before, '何も消していない');
  check.close();
  // 予行でも同じ理由を出して1で終わる
  assert.equal(run(['--db', file, SALES_DEMO.orgCode]).status, 1);
});

test('印の列が無い DB（移行 0059 の前）は、本番かデモかを確かめられないので終了コード2で止まる', () => {
  const file = join(dir, 'no-kind.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE organizations(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL); INSERT INTO organizations VALUES(1,'DEMO-X','架空の組織');");
  raw.exec('CREATE TABLE works(org_id INTEGER NOT NULL REFERENCES organizations(id), id INTEGER PRIMARY KEY); INSERT INTO works VALUES(1,1);');
  const result = purgeDemoOrg(raw, 'DEMO-X', {apply: true});
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /印（kind。移行 0059）がありません/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM works').get().n, 1);
  raw.close();
  assert.equal(run(['--db', file, 'DEMO-X', '--apply']).status, 2);
});

test('消す順は、指す側の表を指される側より先にする', () => {
  const order = deleteOrder(['organizations', 'works', 'partners', 'sale_lines', 'notes'], [
    {child: 'works', parent: 'organizations'}, {child: 'partners', parent: 'organizations'},
    {child: 'sale_lines', parent: 'works'}, {child: 'sale_lines', parent: 'partners'}, {child: 'notes', parent: 'notes'},
  ]);
  assert.deepEqual(order, ['notes', 'sale_lines', 'partners', 'works', 'organizations']);
});

test('引数: 組織コードと --db は必須、--dry-run と --apply は一緒に使えず、既定は予行', () => {
  assert.deepEqual(parseArgs(['--db', 'x.sqlite', 'DEMO-A']), {db: 'x.sqlite', code: 'DEMO-A', apply: false, allowMainDb: false});
  assert.equal(parseArgs(['DEMO-A', '--apply', '--db', 'x.sqlite']).apply, true);
  for (const args of [['DEMO-A'], ['--db', 'x.sqlite'], ['--db', 'x.sqlite', 'A', 'B'], ['--db', 'x.sqlite', 'A', '--apply', '--dry-run'], ['--db', 'x.sqlite', 'A', '--force']]) {
    assert.throws(() => parseArgs(args), Error, args.join(' '));
  }
  assert.equal(run(['--db', join(dir, 'missing.sqlite'), 'DEMO-A']).status, 2, '無いファイルは作らずに止まる');
});
