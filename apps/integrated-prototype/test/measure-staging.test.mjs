// 段2の実測の計測（scripts/measure-staging.mjs・scripts/measure-common.mjs）の試験（PG 計画 段2の実測 S5）。
// ・手元のアプリを remote の形（http://127.0.0.1）で、作り直さない1つの DB に向け、既定の6回が全部登録でき、反映の6項目と予実の即時が「はい」。
//   届くはずの報告は取引先ごとに1つを使い回し（2回目以降が断られない）、流し終えたら使った最も遅い月で閉じる
// ・途中で失敗した回は「部分」として残り、再開すると飛ばす。--stop-after で止めて同じ計画で再開でき、予備の月（PF-C の 2026-04）も通る
// ・前の結果の引き継ぎは、DB の種類（S7 の postgres と S8 の d1 は同じ URL）・組織・原本が同じときだけ
// ・登録が全部済んだあとで止まった回は取れた区切りを残し、予備の月を案内しない。読み直しも失敗した回は「登録は残っていない」と言わない
// ・同じ月の (a) と (b) の report_key が違う
// ・https の形: すべての要求に cf-access-token、書き込みに Origin と JSON。Cookie を送らない。出力・JSON・Markdown・例外の文に
//   トークン・Cookie・メールが出ない。--check-only は読み取り（GET）だけ。トークンの残りが2時間を切っていたら書き込みの前に止め、
//   回のあいだで切れたら終了コード 1 で止める。計測の前からある届くはずの報告を使い回すときは、閉じる前に知らせる
// ・formatMarkdown は remote の数えられない欄を「—」で出す。(a) の月違いの原本は OOXML の部品の文字列だけを置き換える。
//   (a) の原本は git で追跡する部品から組み立て、生成物（public/demo-fixtures の XLSX）を読まない
// 架空データの組織 DEMO-SALES を試験の DB に作る。表の読み取りは手元の Python（ON_PYTHON）の実物。Access は fetch の差し替えで模す
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {serve} from '@hono/node-server';
import {openTestDb, testDbKind} from './test-db.mjs';
import {seedSalesDemo, SALES_DEMO} from '../scripts/seed-sales-demo.mjs';
import {createApp} from '../src/app.mjs';
import {extractDocument} from '../src/local-extractor.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {buildFixtureXlsx} from '../scripts/fixture-xlsx.mjs';
import {DEMO_ORG_CODE, MILESTONES, SEGMENTS, buildSyntheticWorkbook, formatMarkdown, retargetFixtureMonth, sha256Hex, streamingFixture} from '../scripts/measure-common.mjs';
import {MeasureStop, buildPlan, createRedactor, parseArgs, parseTarget, resolveOutputs, runMeasurement, tokenExpiry} from '../scripts/measure-staging.mjs';

const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ALL_REFLECTED = {royaltyDraft: true, companySales: true, receiptLedger: true, invoiceDraft: true, receivableBalance: true, forecast: true};
const STAGING = 'https://integrated-staging.example.invalid';
const EMAIL = SALES_DEMO.adminEmail;

async function startApp(t, db) {
  const app = createApp({db, mode: 'local', extractDocument: (args) => extractDocument({...args, pythonPath: python})});
  const {server, baseUrl} = await new Promise((done) => {
    const started = serve({fetch: app.fetch, hostname: '127.0.0.1', port: 0}, (info) => done({server: started, baseUrl: `http://127.0.0.1:${info.port}`}));
  });
  t.after(() => new Promise((done) => server.close(() => done())));
  return baseUrl;
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'measure-staging-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  return home;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const statuses = (report) => report.runs.map((run) => `${run.source}:${run.month}=${run.status}`);

// 架空の管理者として手元のアプリに入り、Cookie（on_session）を返す（Access の代わりに要求へ付けるため）
async function localSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/local/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: EMAIL})});
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map((line) => line.split(';')[0]).find((pair) => pair.startsWith('on_session='));
}

async function rulesOf(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/progress/rules`, {headers: {cookie}});
  return (await response.json()).rules;
}

// 試験だけの JWT の形（署名は無い。exp だけを読む）
function fakeJwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({alg: 'RS256', typ: 'JWT'})}.${part(payload)}.c2lnbmF0dXJlLXRlc3Qtb25seQ`;
}

// Access の代わり: cf-access-token が合えば、手元のアプリへ架空の管理者の Cookie を付けて渡す（Origin は手元に読み替える）。要求の見出しを記録する
function accessProxy({baseUrl, cookie, token, requests, tamper = null}) {
  return async (url, init = {}) => {
    const target = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    requests.push({method: init.method || 'GET', path: target.pathname, headers});
    if (tamper) {
      const replaced = tamper({method: init.method || 'GET', path: target.pathname});
      if (replaced) return replaced;
    }
    if (target.origin !== STAGING || headers['cf-access-token'] !== token) return new Response('<html>Access</html>', {status: 302, headers: {location: 'https://example.invalid/login'}});
    const forward = {...headers, cookie};
    delete forward['cf-access-token'];
    if (forward.origin) forward.origin = baseUrl;
    return fetch(`${baseUrl}${target.pathname}${target.search}`, {method: init.method, headers: forward, body: init.body, redirect: 'manual'});
  };
}

test('remote の形（手元のアプリ）で既定の6回が全部登録でき、反映の6項目と予実の即時が「はい」。途中で失敗した回は「部分」、--stop-after で止めて再開でき、予備の月も通る', async (t) => {
  const db = await openTestDb({t});
  await seedSalesDemo(db);
  const baseUrl = await startApp(t, db);
  const base = join(tempHome(t), 'ondrill');
  const logs = [];
  const log = (line) => logs.push(line);
  const options = {url: baseUrl, rows: 200, works: 20, log};

  // 1回目: (b) の 2026-07 の2作品目の登録で、架空の障害を差し込む（登録が1作品だけ残る）
  let armed = false;
  let commits = 0;
  const failing = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/sales-import/files' && init.method === 'POST') armed = JSON.parse(init.body).name.includes('DEMO-PF-C-2026-07');
    if (armed && path === '/api/sales-import/commit') {
      commits += 1;
      if (commits === 2) return new Response(JSON.stringify({ok: false, error: '試験で差し込んだ架空の障害'}), {status: 500, headers: {'content-type': 'application/json'}});
    }
    return fetch(url, init);
  };
  await assert.rejects(runMeasurement({...options, outDir: join(base, 'measure-1'), fetchImpl: failing}),
    (error) => error instanceof MeasureStop && error.exitCode === 1 && error.message.includes('予備の月') && error.message.includes('b:2026-04'));
  const first = readJson(join(base, 'measure-1', 'measure.json'));
  assert.equal(first.outcome, 'failed');
  assert.deepEqual(statuses(first), ['a:2026-06=measured', 'a:2026-07=measured', 'a:2026-08=measured', 'b:2026-06=measured', 'b:2026-07=partial', 'b:2026-08=pending']);
  assert.deepEqual(first.runs.map((run) => run.partnerCode), ['DEMO-PF-B', 'DEMO-PF-B', 'DEMO-PF-B', 'DEMO-PF-C', 'DEMO-PF-C', 'DEMO-PF-C']);
  assert.deepEqual(first.runs[4].registration, {committed: 1, partitions: 20, reportIds: first.runs[4].registration.reportIds});
  assert.equal(first.runs[4].registration.reportIds.length, 1);
  assert.equal(first.session.org.code, DEMO_ORG_CODE);
  for (const run of first.runs.filter((row) => row.status === 'measured')) {
    assert.deepEqual(run.result.reflected, ALL_REFLECTED, `${run.source}:${run.month} の反映`);
    assert.equal(run.result.forecastImmediate, true, `${run.source}:${run.month} の予実の即時`);
    assert.deepEqual(run.result.problems, []);
    assert.deepEqual(run.result.registered, run.source === 'a' ? {works: 6, reports: 6, rows: 9, excludedRows: 1} : {works: 20, reports: 20, rows: 200, excludedRows: 0});
    assert.equal(run.result.accountingMonth, `${run.month.slice(0, 5)}${String(Number(run.month.slice(5)) + 1).padStart(2, '0')}`);
    // remote の形では DB を数えない（null）。区切りは順に並ぶ
    assert.equal(run.result.db.maxParams, null);
    assert.equal(run.result.extractedAt, null);
    const times = MILESTONES.map(({key}) => run.result.marks[key]);
    for (let index = 1; index < times.length; index += 1) assert.ok(times[index] >= times[index - 1], `${run.source}:${run.month} の区切りの順`);
    assert.ok(run.result.tokenSpanMs >= 0 && run.result.tokenSpanMs <= run.result.marks.m4);
  }
  // 最初に測った回は冷えた状態を含む印。回の前の件数は回を重ねると増える
  assert.equal(first.runs[0].cold, 'first');
  assert.notEqual(first.runs[1].cold, 'first');
  assert.ok(first.runs[1].result.before.activeReports > first.runs[0].result.before.activeReports, '回の前の有効な報告は積み上がる');
  // 同じ月の (a) と (b) の report_key が違う
  const keysOf = (source, month) => first.runs.find((run) => run.source === source && run.month === month).result.reportKeys;
  assert.deepEqual(keysOf('a', '2026-06'), ['DEMO-PF-B-2026-06-MEASA']);
  assert.deepEqual(keysOf('b', '2026-06'), ['DEMO-PF-C-2026-06-MEASB']);
  // 届くはずの報告は取引先ごとに1つ（PF-B は 2026-06、PF-C は 2026-04 から）。失敗したので閉じていない
  const cookie = await localSession(baseUrl);
  const partnerRules = (rules, code) => rules.filter((rule) => rule.partner_code === code && rule.kind === 'digital' && rule.work_id == null);
  let rules = await rulesOf(baseUrl, cookie);
  assert.deepEqual(partnerRules(rules, 'DEMO-PF-B').map((rule) => [rule.active_from, rule.last_month]), [['2026-06', null]]);
  assert.deepEqual(partnerRules(rules, 'DEMO-PF-C').map((rule) => [rule.active_from, rule.last_month]), [['2026-04', null]]);

  // 同じ向き先・同じ報告の id でも、DB の種類（S7 の postgres と S8 の d1 は同じ URL・同じ置き場）・組織・原本が違う結果からは引き継がない。
  // measure-1 の写しを、1か所だけ変えて新しい時刻で置く（引き継ぐなら新しい方を選ぶので、条件が欠けると 2回目の引き継ぎ元がこれになる）
  const decoy = (name, change) => {
    const data = structuredClone(first);
    data.environment.measuredAt = '2099-01-01T00:00:00.000Z';
    change(data);
    mkdirSync(join(base, name), {recursive: true});
    writeFileSync(join(base, name, 'measure.json'), JSON.stringify(data));
  };
  decoy('measure-decoy-db', (data) => { data.session.database = first.session.database === 'postgres' ? 'd1' : 'postgres'; });
  decoy('measure-decoy-org', (data) => { data.session.org.code = 'DEMO-OTHER'; });
  decoy('measure-decoy-sha', (data) => { for (const run of data.runs) run.sha256 = '0'.repeat(64); });

  // 2回目: 予備の月を足した計画で再開し、新しく1回測ったら止める（登録済みの月は飛ばし、前の結果から計測を引き継ぐ）
  const plan = 'a:2026-06,a:2026-07,a:2026-08,b:2026-06,b:2026-07,b:2026-08,b:2026-04';
  const second = await runMeasurement({...options, plan, outDir: join(base, 'measure-2'), stopAfter: 1});
  assert.equal(second.outcome, 'stopped');
  assert.ok(second.rules.every((rule) => rule.preexisting === false), '計測が作った規則は「計測の前からある」と言わない');
  assert.deepEqual(statuses(second), ['a:2026-06=measured', 'a:2026-07=measured', 'a:2026-08=measured', 'b:2026-06=measured', 'b:2026-07=partial', 'b:2026-08=measured', 'b:2026-04=pending']);
  assert.deepEqual(second.runs.map((run) => run.carriedFrom ?? null), ['measure-1', 'measure-1', 'measure-1', 'measure-1', null, null, null]);
  assert.deepEqual(second.runs[5].result.reflected, ALL_REFLECTED);
  assert.equal(second.runs[5].result.forecastImmediate, true, '2回目以降も届くはずの報告で断られず、即時に反映される');
  rules = await rulesOf(baseUrl, cookie);
  assert.equal(partnerRules(rules, 'DEMO-PF-C').length, 1, '再開しても届くはずの報告を作り直さない');
  assert.equal(partnerRules(rules, 'DEMO-PF-C')[0].last_month, null, '--stop-after で止めたときは閉じない');

  // 3回目: 同じ計画で残り（予備の月）を流し、流し終えたら規則を閉じる
  const third = await runMeasurement({...options, plan, outDir: join(base, 'measure-3')});
  assert.equal(third.outcome, 'complete');
  assert.deepEqual(statuses(third), ['a:2026-06=measured', 'a:2026-07=measured', 'a:2026-08=measured', 'b:2026-06=measured', 'b:2026-07=partial', 'b:2026-08=measured', 'b:2026-04=measured']);
  assert.deepEqual(third.runs.map((run) => run.carriedFrom ?? null), ['measure-1', 'measure-1', 'measure-1', 'measure-1', null, 'measure-2', null]);
  const spare = third.runs[6];
  assert.deepEqual(spare.result.reflected, ALL_REFLECTED, '予備の月の回も反映される');
  assert.equal(spare.result.forecastImmediate, true, '予備の月（2026-04）は PF-C の規則の開始月の内');
  rules = await rulesOf(baseUrl, cookie);
  assert.deepEqual(partnerRules(rules, 'DEMO-PF-B').map((rule) => [rule.active_from, rule.last_month]), [['2026-06', '2026-08']]);
  assert.deepEqual(partnerRules(rules, 'DEMO-PF-C').map((rule) => [rule.active_from, rule.last_month]), [['2026-04', '2026-08']]);
  assert.deepEqual(third.rules.map((rule) => [rule.partnerCode, rule.action, rule.lastMonth]).sort(), [['DEMO-PF-B', 'closed', '2026-08'], ['DEMO-PF-C', 'closed', '2026-08']]);
  const md = readFileSync(join(base, 'measure-3', 'measure.md'), 'utf8');
  assert.match(md, /\| 5 \| b \| DEMO-PF-C \| 2026-07 \| 部分（途中まで登録が残った。飛ばした）（1\/20 作品） \|/);

  // 4回目: 読み取りだけの確認。全回が登録済みか部分になり、手元のログインのほかに書き込みをしない
  const methods = [];
  const watching = async (url, init = {}) => {
    methods.push(`${init.method || 'GET'} ${new URL(url).pathname}`);
    return fetch(url, init);
  };
  const check = await runMeasurement({...options, plan, checkOnly: true, outDir: join(base, 'check'), fetchImpl: watching});
  assert.deepEqual(check.checks.map((row) => row.state), ['done', 'done', 'done', 'done', 'partial', 'done', 'done']);
  assert.deepEqual(methods.filter((line) => !line.startsWith('GET ')), ['POST /api/local/login']);
  // 計測が作った規則は「計測の前からある」と言わない
  assert.ok(third.rules.every((rule) => rule.preexisting === false), JSON.stringify(third.rules));
  assert.doesNotMatch(check.guidance.join('\n'), /計測で作った規則ではありません/);
  // 出力にメール・Cookie の値が出ない
  const texts = [...logs, ...['measure-1', 'measure-2', 'measure-3'].flatMap((dir) => ['measure.json', 'measure.md'].map((name) => readFileSync(join(base, dir, name), 'utf8')))].join('\n');
  assert.equal(texts.includes(EMAIL), false);
  assert.equal(texts.includes(cookie.slice('on_session='.length)), false);
});

test('登録が全部済んだあとで止まった回は取れた区切りを残して「登録済み・計測は途中まで」とし、予備の月を案内せず、再開で引き継ぐ。読み直しも失敗した回は「確かめられなかった」とし、登録が残っていないとは言わない', async (t) => {
  const db = await openTestDb({t});
  await seedSalesDemo(db);
  const baseUrl = await startApp(t, db);
  const base = join(tempHome(t), 'ondrill');
  const options = {url: baseUrl, rows: 40, works: 20, log: () => {}};
  const fault = () => new Response(JSON.stringify({ok: false, error: '試験で差し込んだ架空の障害'}), {status: 500, headers: {'content-type': 'application/json'}});

  // 1回目: 20作品の登録が全部済んだあと（⑥の売掛金の一覧）で架空の障害
  let message = '';
  const afterCommits = async (url, init = {}) => (new URL(url).pathname === '/api/billing/receivables' ? fault() : fetch(url, init));
  await assert.rejects(runMeasurement({...options, plan: 'b:2026-06', outDir: join(base, 'measure-1'), fetchImpl: afterCommits}), (error) => {
    message = error.message;
    return error instanceof MeasureStop && error.exitCode === 1;
  });
  const first = readJson(join(base, 'measure-1', 'measure.json'));
  const run = first.runs[0];
  assert.equal(run.status, 'registered-unmeasured');
  assert.deepEqual([run.registration.committed, run.registration.partitions, run.registration.reportIds.length], [20, 20, 20]);
  assert.deepEqual(Object.keys(run.partialMarks).sort(), ['m1', 'm2', 'm3', 'm4', 'm5'], '⑤までの区切りを残す');
  for (const key of ['m2', 'm3', 'm4', 'm5']) assert.ok(run.partialMarks[key] >= run.partialMarks.m1, key);
  assert.ok(run.partialStartedAt);
  assert.equal(run.result ?? null, null);
  assert.match(message, /登録はすべて済みました/);
  assert.doesNotMatch(message, /予備の月/, '登録が全部済んだ回で予備の月を使わせない');
  assert.match(readFileSync(join(base, 'measure-1', 'measure.md'), 'utf8'),
    /\| 1 \| b \| DEMO-PF-C \| 2026-06 \| 登録済み・計測は途中まで（取れた区切りだけ残した）（20\/20 作品） \| {2}\| — \| — \| [\d,]+ \| — \| — \|/);

  // 2回目: 次の月の2作品目の登録で障害が起き、そのあと向き先に届かなくなる（登録が残ったかを読み直せない）
  let armed = false;
  let commits = 0;
  let down = false;
  const cutOff = async (url, init = {}) => {
    if (down) throw new TypeError('fetch failed');
    const path = new URL(url).pathname;
    if (path === '/api/sales-import/files' && init.method === 'POST') armed = JSON.parse(init.body).name.includes('DEMO-PF-C-2026-07');
    if (armed && path === '/api/sales-import/commit' && (commits += 1) === 2) {
      down = true;
      return fault();
    }
    return fetch(url, init);
  };
  await assert.rejects(runMeasurement({...options, plan: 'b:2026-06,b:2026-07', outDir: join(base, 'measure-2'), fetchImpl: cutOff}), (error) => {
    message = error.message;
    return error instanceof MeasureStop && error.exitCode === 1;
  });
  const second = readJson(join(base, 'measure-2', 'measure.json'));
  assert.deepEqual(statuses(second), ['b:2026-06=registered-unmeasured', 'b:2026-07=unverified']);
  assert.equal(second.runs[0].carriedFrom, 'measure-1');
  assert.deepEqual(second.runs[0].partialMarks, run.partialMarks, '取れた区切りを引き継ぐ');
  assert.equal(second.runs[1].registration, null);
  assert.match(message, /-CheckOnly/);
  assert.doesNotMatch(message, /登録は残っていません/, '確かめていないことを言わない');

  // 読み取りだけの確認で本当の状態が分かる（1作品だけ残った）
  const check = await runMeasurement({...options, plan: 'b:2026-06,b:2026-07', checkOnly: true, outDir: join(base, 'check')});
  assert.deepEqual(check.checks.map((row) => [row.state, row.sameFile]), [['done', '登録済み（20/20 作品）'], ['partial', '部分（1/20 作品）']]);

  // 3回目: 同じ計画で再開すると、両方を飛ばして流し終え、規則は使った最も遅い月（部分の 2026-07）で閉じる
  const third = await runMeasurement({...options, plan: 'b:2026-06,b:2026-07', outDir: join(base, 'measure-3')});
  assert.equal(third.outcome, 'complete');
  assert.deepEqual(statuses(third), ['b:2026-06=registered-unmeasured', 'b:2026-07=partial']);
  assert.equal(third.runs[0].carriedFrom, 'measure-1');
  assert.deepEqual(third.rules.map((rule) => [rule.partnerCode, rule.action, rule.lastMonth]), [['DEMO-PF-C', 'closed', '2026-07']]);
});

test('https の形: すべての要求に cf-access-token、書き込みに Origin と JSON がそろい Cookie を送らず、出力・JSON・Markdown・例外の文にトークン・Cookie・メールが出ない', async (t) => {
  const db = await openTestDb({t});
  await seedSalesDemo(db);
  const baseUrl = await startApp(t, db);
  const home = tempHome(t);
  const cookie = await localSession(baseUrl);
  const token = fakeJwt({exp: Math.floor(Date.now() / 1000) + 3 * 3600, email: EMAIL});
  const logs = [];
  const log = (line) => logs.push(line);

  // 読み取りだけの確認は GET だけ
  const checkRequests = [];
  const check = await runMeasurement({url: STAGING, token, checkOnly: true, plan: 'a:2026-06', outDir: join(home, 'check'), fetchImpl: accessProxy({baseUrl, cookie, token, requests: checkRequests}), log});
  assert.deepEqual(check.checks.map((row) => [row.state, row.sameFile, row.overlaps]), [['ready', 'なし', 0]]);
  assert.deepEqual([...new Set(checkRequests.map((row) => row.method))], ['GET']);
  assert.equal(check.rules[0].action, 'planned');
  assert.equal(check.token.enough, true);
  // 残りが2時間を切っていても、読み取りだけの確認は止めずに表を出し、計測を始められないことを残す（ps1 が見本取りの前に止める）
  const short = fakeJwt({exp: Math.floor(Date.now() / 1000) + 3600});
  const shortCheck = await runMeasurement({url: STAGING, token: short, checkOnly: true, plan: 'a:2026-06', outDir: join(home, 'check-short'), fetchImpl: accessProxy({baseUrl, cookie, token: short, requests: []}), log});
  assert.equal(shortCheck.token.enough, false);
  assert.equal(shortCheck.checks.length, 1);
  assert.match(shortCheck.guidance.join(' '), /cloudflared access login/);
  assert.equal(readJson(join(home, 'check-short', 'check-only.json')).token.enough, false);

  const requests = [];
  const report = await runMeasurement({url: STAGING, token, plan: 'a:2026-06', outDir: join(home, 'run'), fetchImpl: accessProxy({baseUrl, cookie, token, requests}), log});
  assert.equal(report.outcome, 'complete');
  assert.equal(report.session.database, testDbKind() === 'pg' ? 'postgres' : 'sqlite', '向き先の DB の種類を残す');
  assert.deepEqual(report.runs[0].result.reflected, ALL_REFLECTED);
  assert.equal(report.runs[0].result.forecastImmediate, true);
  assert.ok(requests.length > 20);
  for (const request of requests) {
    assert.equal(request.headers['cf-access-token'], token, `${request.method} ${request.path} に cf-access-token`);
    assert.equal(request.headers.cookie, undefined, `${request.method} ${request.path} に Cookie を送らない`);
    assert.equal(request.headers.origin, STAGING);
    if (request.method !== 'GET') assert.equal(request.headers['content-type'], 'application/json', `${request.method} ${request.path} は JSON`);
    if (!['/api/health', '/api/session', '/api/session/orgs'].includes(request.path)) assert.match(request.headers['x-on-org'] || '', /^\d+$/, `${request.path} は組織を固定する`);
  }
  assert.ok(requests.some((row) => row.method === 'POST' && row.path === '/api/sales-import/commit'));
  assert.ok(requests.some((row) => row.method === 'POST' && /\/api\/progress\/rules\/\d+\/close$/.test(row.path)), '流し終えたら届くはずの報告を閉じる');
  assert.deepEqual(report.rules.map((rule) => [rule.action, rule.preexisting]), [['closed', false]]);

  // 回のあいだでトークンの残りが2時間を切ったら、次の回を始めずに止める。この起動で測り始めたあとなので終了コード 1（始める前の 2 ではない）
  const midRequests = [];
  const shifted = () => Date.now() + (midRequests.some((row) => row.method === 'POST' && row.path === '/api/sales-import/commit') ? 90 * 60 * 1000 : 0);
  await assert.rejects(runMeasurement({url: STAGING, token, plan: 'b:2026-06,b:2026-07', rows: 40, works: 20, outDir: join(home, 'token-mid'),
    fetchImpl: accessProxy({baseUrl, cookie, token, requests: midRequests}), log, now: shifted}),
  (error) => error instanceof MeasureStop && error.exitCode === 1 && error.message.includes(`cloudflared access login ${STAGING}`) && !error.message.includes(token));
  const mid = readJson(join(home, 'token-mid', 'measure.json'));
  assert.equal(mid.outcome, 'stopped');
  assert.deepEqual(statuses(mid), ['b:2026-06=measured', 'b:2026-07=pending']);

  // API の誤りの文にトークンとメールが混ざっても、例外の文と結果のファイルには出ない
  const leaking = accessProxy({baseUrl, cookie, token, requests: [], tamper: ({path}) => (path === '/api/partners'
    ? new Response(JSON.stringify({ok: false, error: `架空の誤り ${EMAIL} ${token}`}), {status: 500, headers: {'content-type': 'application/json'}}) : null)});
  let message = '';
  await assert.rejects(runMeasurement({url: STAGING, token, plan: 'a:2026-07', outDir: join(home, 'leak'), fetchImpl: leaking, log}), (error) => {
    message = error.message;
    return error instanceof MeasureStop && error.exitCode === 2;
  });
  assert.match(message, /取引先: 500/);

  // 計測の前からある（画面で作った）開いた届くはずの報告を使い回すときは、流し終えると閉じる（戻せない）ことを、yes の前の確認で知らせる
  const partners = await (await fetch(`${baseUrl}/api/partners`, {headers: {cookie}})).json();
  const partnerId = partners.rows.find((row) => row.code === 'DEMO-PF-B').id;
  const made = await fetch(`${baseUrl}/api/progress/rules`, {method: 'POST', headers: {cookie, origin: baseUrl, 'content-type': 'application/json'},
    body: JSON.stringify({partnerId, kind: 'digital', frequency: 'monthly', activeFrom: '2026-07', note: '画面で作った規則（架空）'})});
  assert.equal(made.status, 201);
  const uiRuleId = (await made.json()).id;
  const reuse = await runMeasurement({url: STAGING, token, checkOnly: true, plan: 'a:2026-07', outDir: join(home, 'check-preexisting'), fetchImpl: accessProxy({baseUrl, cookie, token, requests: []}), log});
  assert.deepEqual(reuse.rules.map((rule) => [rule.id, rule.action, rule.preexisting]), [[Number(uiRuleId), 'reused', true]]);
  assert.match(reuse.guidance.join('\n'), new RegExp(`id ${uiRuleId}（2026-07 から・開いている）は、計測で作った規則ではありません.*閉じると戻せません`));
  assert.ok(logs.some((line) => line.includes('計測の前からある規則')), '表のあとの規則の行にも出す');

  const texts = [message, ...logs, ...['check/check-only', 'check-short/check-only', 'run/measure', 'token-mid/measure', 'leak/measure', 'check-preexisting/check-only']
    .flatMap((name) => ['json', 'md'].map((ext) => readFileSync(join(home, `${name}.${ext}`), 'utf8')))].join('\n');
  assert.equal(texts.includes(token), false, 'トークンが出ない');
  assert.equal(texts.includes(short), false, '残りの短いトークンも出ない');
  assert.equal(texts.includes(token.split('.')[1]), false, 'トークンの一部も出ない');
  assert.equal(texts.includes(cookie.slice('on_session='.length)), false, 'Cookie の値が出ない');
  assert.equal(texts.includes(EMAIL), false, 'メールが出ない');
  assert.doesNotMatch(texts, /[\w.+-]+@[\w-]+\.[\w.-]+/, 'メールの形の文字列が出ない');
});

test('トークンの残りが2時間を切っていたら、要求を1つも出さずに止め、cloudflared access login からやり直すよう出す（トークンの値は出さない）', async (t) => {
  const home = tempHome(t);
  const requests = [];
  const fetchImpl = async (url) => { requests.push(url); return new Response('{}', {status: 500}); };
  const short = fakeJwt({exp: Math.floor(Date.now() / 1000) + 3600});
  await assert.rejects(runMeasurement({url: STAGING, token: short, plan: 'a:2026-06', outDir: join(home, 'short'), fetchImpl, log: () => {}}),
    (error) => error instanceof MeasureStop && error.exitCode === 2 && error.message.includes(`cloudflared access login ${STAGING}`) && error.message.includes('同じコマンドで再開') && !error.message.includes(short));
  await assert.rejects(runMeasurement({url: STAGING, token: 'not-a-jwt-value', plan: 'a:2026-06', outDir: join(home, 'bad'), fetchImpl, log: () => {}}),
    (error) => error instanceof MeasureStop && /有効期限を読めません/.test(error.message) && !error.message.includes('not-a-jwt-value'));
  await assert.rejects(runMeasurement({url: STAGING, token: null, plan: 'a:2026-06', outDir: join(home, 'none'), fetchImpl, log: () => {}}),
    (error) => error instanceof MeasureStop && error.message.includes('ON_ACCESS_TOKEN'));
  assert.deepEqual(requests, []);
  assert.equal(tokenExpiry(short), (Math.floor(Date.now() / 1000) + 3600) * 1000);
  assert.equal(tokenExpiry('a.b'), null);
});

test('formatMarkdown は remote の数えられない欄（DB の呼び出し・1文の値・batch・抽出の終わり）を「—」で出し、手元の数はそのまま出す', () => {
  const run = (scale, counted) => ({
    label: '架空', fileName: 'x.xlsx', byteLength: 1000, registered: {works: 2, reports: 2, rows: 5, excludedRows: 0},
    marks: Object.fromEntries(MILESTONES.map(({key}, index) => [key, index * scale])), extractedAt: counted ? scale : null, forecastImmediate: true, reflected: ALL_REFLECTED,
    steps: [{label: '登録', count: 2, ms: scale, calls: counted ? 7 : null, statements: counted ? 9 : null}],
    db: {segments: Object.fromEntries(SEGMENTS.map(({from, to}) => [`${from}-${to}`, {calls: counted ? 3 : null, statements: counted ? 4 : null}])), maxParams: counted ? 12 : null, maxBatch: counted ? 5 : null},
  });
  const remote = formatMarkdown([{runs: [run(10, false), run(20, false)]}]);
  assert.match(remote, /\| 登録 \| 2 \| 15 \| —（—） \|/);
  assert.match(remote, /\| ①→② 受け取り（抽出・原本の保存） \| 15 \| —（—） \|/);
  assert.match(remote, /抽出（Python）が終わるまで: 中央値 — ms/);
  assert.match(remote, /1文の値 —個（上限100）、1回の batch —文（上限480）/);
  const local = formatMarkdown([{runs: [run(10, true)]}]);
  assert.match(local, /\| 登録 \| 2 \| 10 \| 7（9） \|/);
  assert.match(local, /1文の値 12個（上限100）、1回の batch 5文（上限480）/);
});

test('計画と引数: 既定は (a) を先に 2026-06・07・08 の6回、--url は必須、http は手元だけ、結果はリポジトリの外、同じ取引先・同じ月の重複は断る', async (t) => {
  assert.deepEqual(buildPlan().map((run) => `${run.source}:${run.month}:${run.partnerCode}`),
    ['a:2026-06:DEMO-PF-B', 'a:2026-07:DEMO-PF-B', 'a:2026-08:DEMO-PF-B', 'b:2026-06:DEMO-PF-C', 'b:2026-07:DEMO-PF-C', 'b:2026-08:DEMO-PF-C']);
  assert.deepEqual(buildPlan({only: 'b', months: '2026-04'}).map((run) => run.reportKey), ['DEMO-PF-C-2026-04-MEASB']);
  assert.throws(() => buildPlan({plan: 'b:2026-06,b:2026-06'}), /同じ取引先/);
  assert.throws(() => buildPlan({plan: 'a:2026-06,b:2026-06', partnerA: 'DEMO-PF-C'}), /同じ取引先/);
  assert.throws(() => buildPlan({plan: 'c:2026-06'}), /a:2026-06/);
  assert.throws(() => parseArgs(['--check-only']), (error) => error instanceof MeasureStop && /--url が要ります/.test(error.message));
  assert.equal(parseArgs(['--url', 'https://x.example.invalid', '--plan', 'a:2026-06']).plan, 'a:2026-06');
  assert.deepEqual(parseTarget('http://127.0.0.1:9041'), {origin: 'http://127.0.0.1:9041', https: false, loopback: true});
  assert.deepEqual(parseTarget('https://integrated-staging.example.invalid/'), {origin: STAGING, https: true, loopback: false});
  assert.throws(() => parseTarget('http://integrated-staging.example.invalid'), /手元/);
  assert.throws(() => parseTarget('https://integrated-staging.example.invalid/api'), /origin だけ/);
  const repo = resolve(import.meta.dirname, '..', '..', '..');
  assert.throws(() => resolveOutputs({outDir: join(repo, 'apps', 'integrated-prototype', 'data', 'measure')}), /リポジトリの中/);
  const home = tempHome(t);
  const outputs = resolveOutputs({home, now: new Date(2026, 9, 9, 3, 4, 5)});
  assert.deepEqual(outputs, {dir: join(home, 'ondrill', 'measure-20261009-030405'), json: join(home, 'ondrill', 'measure-20261009-030405', 'measure.json'), md: join(home, 'ondrill', 'measure-20261009-030405', 'measure.md')});
  // (b) の1作品の行数がクラウドの1回の登録の上限（100行）を超える指定は、要求を出す前に断る
  const requests = [];
  await assert.rejects(runMeasurement({url: 'http://127.0.0.1:9', rows: 2100, works: 20, outDir: join(home, 'x'), fetchImpl: async (url) => { requests.push(url); return new Response('{}'); }, log: () => {}}), /上限/);
  assert.deepEqual(requests, []);
});

test('(a) の月違いの原本は OOXML の部品の文字列だけを置き換え（同じ月なら同じバイト、検証期待値のシートと他のセルは変えない）、(a)・(b) とも同じ引数なら同じバイト', (t) => {
  const original = streamingFixture();
  // (a) の原本は git で追跡する部品から組み立てる。生成物（public/demo-fixtures の XLSX。git に入らず、core の main のフォルダには無い）を読まない:
  // fixture-manifest.json だけを置いたフォルダでも作れ、生成物があればそれと同じバイト（再開の SHA-256 が変わらない）
  const manifestOnly = mkdtempSync(join(tmpdir(), 'measure-manifest-'));
  t.after(() => rmSync(manifestOnly, {recursive: true, force: true}));
  const publicDir = resolve(import.meta.dirname, '..', 'public', 'demo-fixtures');
  copyFileSync(join(publicDir, 'fixture-manifest.json'), join(manifestOnly, 'fixture-manifest.json'));
  assert.equal(Buffer.compare(streamingFixture({manifestDir: manifestOnly}).bytes, original.bytes), 0, '生成物の無いフォルダでも同じ原本');
  assert.equal(sha256Hex(streamingFixture({manifestDir: manifestOnly, month: '2026-06'}).bytes), sha256Hex(streamingFixture({month: '2026-06'}).bytes));
  assert.equal(Buffer.compare(Buffer.from(buildFixtureXlsx('demo-sales-streaming')), original.bytes), 0);
  const generated = join(publicDir, 'demo-sales-streaming-sample.xlsx');
  if (existsSync(generated)) assert.equal(Buffer.compare(readFileSync(generated), original.bytes), 0, 'npm test の前処理が書き出す XLSX と同じバイト');
  else t.diagnostic('public/demo-fixtures/demo-sales-streaming-sample.xlsx が無いので、生成物との突き合わせは省いた（npm test の前処理が作る）');
  assert.equal(Buffer.compare(retargetFixtureMonth(original.bytes, '2026-07', '2026-07'), original.bytes), 0, '作り直しの道具は部品と圧縮を変えない');
  const june = streamingFixture({month: '2026-06'});
  assert.equal(june.month, '2026-06');
  assert.equal(sha256Hex(streamingFixture({month: '2026-06'}).bytes), sha256Hex(june.bytes));
  assert.notEqual(sha256Hex(june.bytes), sha256Hex(original.bytes));
  const before = decodeXlsx(original.bytes, {formulas: 'sheet'});
  const after = decodeXlsx(june.bytes, {formulas: 'sheet'});
  assert.deepEqual(after.map((sheet) => sheet.name), before.map((sheet) => sheet.name));
  assert.deepEqual(after[1], before[1], '検証期待値のシートは変えない');
  const details = (sheet) => sheet.rows.map((row, index) => row.map((cell, column) => (index >= 4 && column === 3 ? '<月>' : index === 2 ? '<期間>' : cell)));
  assert.deepEqual(details(after[0]), details(before[0]), '対象月の列と対象期間の行のほかは変えない');
  assert.deepEqual([...new Set(after[0].rows.slice(4).map((row) => row[3]))], ['2026/06']);
  assert.match(String(after[0].rows[2][0]), /^対象期間: 2026-06 \//);
  const b = buildSyntheticWorkbook({rows: 40, works: 20, month: '2026-06', partnerCode: 'DEMO-PF-C'});
  assert.equal(sha256Hex(buildSyntheticWorkbook({rows: 40, works: 20, month: '2026-06', partnerCode: 'DEMO-PF-C'}).bytes), sha256Hex(b.bytes));
  assert.notEqual(sha256Hex(buildSyntheticWorkbook({rows: 40, works: 20, month: '2026-06', partnerCode: 'DEMO-PF-B'}).bytes), sha256Hex(b.bytes));
  assert.equal(b.partnerCode, 'DEMO-PF-C');
  assert.equal(DEMO_ORG_CODE, SALES_DEMO.orgCode);
});

test('伏せる口は、知っている値のほか JWT とメールの形の文字列も伏せる', () => {
  const redactor = createRedactor();
  redactor.add('secret-cookie-value');
  const out = redactor.text('a secret-cookie-value b eyJhbGciOi.eyJleHAiOjF9.sig c person@example.invalid d');
  assert.equal(out, 'a ［伏せた値］ b ［伏せたトークン］ c ［伏せたメール］ d');
});
