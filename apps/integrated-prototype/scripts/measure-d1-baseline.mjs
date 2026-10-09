#!/usr/bin/env node
// 段0「D1 の基準を測る」のローカルの計測（会社ルートの plans/2026-10-01-postgres-migration.md の香盤表 #5）。
// 売上報告の1通を、画面と同じ API の順（原本の受け取り → 見出しの行 → 商品コードの列で分割 → 作品ごとに確認と重なりの確認 → 登録）で
// 使い捨ての node:sqlite の DB に入れ、区切り①〜⑦の時刻（①からの経過 ms）を取る。
//   ① 報告のファイルを受け取った（アップロードの要求を出した時刻）
//   ② 取り出しが終わった（受け取りの応答。抽出と原本の保存が済み、画面に表を出せる時刻）
//   ③ 登録の要求を受けた（最初の作品の登録の要求を出した時刻）。②〜③は見出し・分割・作品ごとの確認と重なりの確認の API だけで、人の確認は0
//   ④ 記録が終わった（最後の作品の登録の応答）
//   ⑤ ロイヤリティの下書きが画面に出た（GET /api/royalty/periods の応答。速報はまだ無い（FR-REV-INTAKE-036）ので参考値）
//   ⑥ 売上管理の書類がそろった（会社売上管理表・報告受領台帳・請求書の下書き・入金予定（売掛）の API がすべて応答した。
//      会社売上管理表と報告受領台帳はまだ無いので、年間売上と原本の詳細で代える。請求書の下書きは作品ごとの請求の候補）
//   ⑦ 予実の画面に登録が反映された（GET /api/progress/matrix の応答）。売上の予実（FCST）は未実装なので、
//      帳票センターの月次の受領進捗（src/progress）で代える。FCST の画面ができたらその API に差し替えて測り直す
// 予実は④の直後にも読み、登録の応答の時点で反映されているか（即時の判定。はい・いいえ）を残す。⑤〜⑦の時刻はこの読み取りを含む。
// 書類と予実が新しい登録を載せているか（反映）は、計測の後に登録の結果を API で読み直して判定する（照らし合わせは計測の時間に入れない）。
// 計測の本体（API の順と区切り）は scripts/measure-common.mjs の measureRun で、動いているアプリへ向ける計測（scripts/measure-staging.mjs）と共通。
// ここは DB の呼び出しを数える（DB の呼び出し回数・1文の値の数・batch の文の数）ところと、回ごとに DB を作り直すところだけを持つ。
//
// 測る1通（既定）:
//   (a) 架空の原本のうち行数の最も多い1通 public/demo-fixtures/demo-sales-streaming-sample.xlsx（10行・6作品。要修正の1行は理由をつけて除く）
//   (b) 行数を増やした合成の1通（既定 2,000行 = 20作品×100行。いまの1通の上限 2,000行（src/import/limits.mjs の sourceRows）と、
//       クラウドの1回の登録の上限 100行（同 salesRows）の内に収め、remote の D1 でも同じ1通を測れるようにする）
// 前提のデータは架空データの組織 DEMO-SALES（scripts/seed-sales-demo.mjs）。1回ごとに DB を作り直す（同じ原本は二度受け取れないため）。
//
// 使い方: node scripts/measure-d1-baseline.mjs [--runs 3] [--rows 2000] [--works 20] [--as-of 2026-09-30] [--only a|b]
//                                            [--json <結果.json>] [--work-dir <一時フォルダ>] [--keep]
// ・本番の D1・Cloudflare・設定・秘密値には触れない。DB は --work-dir（既定は data/d1-baseline-<時刻>/。git に入らない）に作り、終わったら消す（--keep で残す）
// ・アプリは 127.0.0.1 の空いているポートで起動し（src/server.mjs と同じ @hono/node-server）、HTTP で呼ぶ
// ・表の読み取りは手元の Python（ON_PYTHON、無ければ python / python3）の実物を使う
// ・(a) の原本は git で追跡する部品（fixtures/xlsx-source/demo-sales-streaming/）から手元で組み立てる（npm test の前処理が書き出す XLSX と同じバイト）
// ・この値は参考値。DB はアプリと同じプロセスの中にあり、DB との往復を含まない。段2で比べる基準は remote の D1 の値（香盤表 #6）
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {cpus, platform, release} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {serve} from '@hono/node-server';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {extractDocument} from '../src/local-extractor.mjs';
import {seedSalesDemo, SALES_DEMO} from './seed-sales-demo.mjs';
import {MILESTONES, buildSyntheticWorkbook, createClock, formatMarkdown, measureRun, ms, must, streamingFixture, yesNo} from './measure-common.mjs';

// 区切り・中央値・表の部品は scripts/measure-common.mjs（remote の計測 scripts/measure-staging.mjs と共通）。ここからも読めるように出す
export {MILESTONES, SEGMENTS, REFLECTED_LABELS, buildSyntheticWorkbook, formatMarkdown, median, streamingFixture, summarize} from './measure-common.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// D1 の上限（1文の値100個・1回の batch 480文）に収まるかと、DB の呼び出しの回数を数える。止めずに記録だけする
function observeDb(inner) {
  const seen = {calls: 0, statements: 0, maxParams: 0, maxBatch: 0};
  const note = (params = []) => { seen.maxParams = Math.max(seen.maxParams, params.length); };
  const one = (method) => (sql, params = []) => { seen.calls += 1; seen.statements += 1; note(params); return inner[method](sql, params); };
  const db = Object.assign(Object.create(inner), {
    all: one('all'), get: one('get'), run: one('run'),
    batch: (statements) => {
      seen.calls += 1; seen.statements += statements.length; seen.maxBatch = Math.max(seen.maxBatch, statements.length);
      statements.forEach((statement) => note(statement.params));
      return inner.batch(statements);
    },
  });
  const snapshot = () => ({calls: seen.calls, statements: seen.statements});
  const reset = () => Object.assign(seen, {calls: 0, statements: 0, maxParams: 0, maxBatch: 0});
  return {db, seen, snapshot, reset};
}

function pythonPath() {
  return process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

async function startServer(app) {
  return new Promise((resolveServer) => {
    const server = serve({fetch: app.fetch, hostname: '127.0.0.1', port: 0}, (info) => resolveServer({server, baseUrl: `http://127.0.0.1:${info.port}`}));
  });
}

function httpClient(baseUrl) {
  let cookie = '';
  async function call(method, path, payload) {
    const response = await fetch(`${baseUrl}/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {raw: text.slice(0, 300)}; }
    return {status: response.status, data};
  }
  async function login(email) {
    const response = await fetch(`${baseUrl}/api/local/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    if (response.status !== 200) throw new Error(`架空の管理者でログインできません（${response.status}）`);
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  return {call, login};
}

// 1回の計測。db は使い捨ての LocalDatabase（DEMO-SALES を入れたもの）。区切りの時刻は ① からの経過 ms。
// 組織・取引先の引き当てと登録の照らし合わせは API で行う（remote の計測と同じ部品。DB は呼び出しを数えるためだけに包む）
export async function measureOnce({db: inner, workbook, asOf = '2026-09-30', python = pythonPath(), forecastKind = null}) {
  const observed = observeDb(inner);
  const clock = createClock();
  let extractedAt = null;
  const app = createApp({db: observed.db, mode: 'local', extractDocument: async (args) => {
    const result = await extractDocument({...args, pythonPath: python});
    extractedAt = clock.now();
    return result;
  }});
  const {server, baseUrl} = await startServer(app);
  try {
    const {call, login} = httpClient(baseUrl);
    await login(SALES_DEMO.adminEmail);
    // ---------- 準備（計測に入れない） ----------
    const orgs = must(await call('GET', '/session/orgs'), 200, '組織');
    if (!(orgs.orgs || []).some((org) => org.code === SALES_DEMO.orgCode && Number(org.id) === Number(orgs.currentOrgId))) throw new Error('DEMO-SALES がありません（scripts/seed-sales-demo.mjs を先に流してください）');
    const partner = (must(await call('GET', '/partners'), 200, '取引先').rows || []).find((row) => row.code === workbook.partnerCode);
    if (!partner) throw new Error(`取引先 ${workbook.partnerCode} がありません`);
    // 予実（売上の予実 FCST は未実装なので、代わりに帳票センターの月次の受領進捗）に、この取引先から毎月届くはずの報告を立てる
    const ruleId = must(await call('POST', '/progress/rules', {partnerId: partner.id, kind: forecastKind || workbook.kind, frequency: 'monthly', activeFrom: workbook.month, note: '性能の計測（架空）'}), 201, '届くはずの報告').id;
    const result = await measureRun({call, workbook, partner, ruleId, reportKey: `${workbook.partnerCode}-${workbook.month}-D1BASE`, asOf, counter: observed, clock});
    if (result.problems.length) throw new Error(result.problems.join(' ／ '));
    return {...result, extractedAt};
  } finally {
    await new Promise((done) => server.close(() => done()));
  }
}

function parseArgs(argv) {
  const args = {runs: 3, rows: 2000, works: 20, asOf: '2026-09-30', only: null, json: null, workDir: null, keep: false};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next == null || next.startsWith('--')) throw new Error(`${name} の値がありません`);
      index += 1;
      return next;
    };
    if (name === '--runs') args.runs = Number(value());
    else if (name === '--rows') args.rows = Number(value());
    else if (name === '--works') args.works = Number(value());
    else if (name === '--as-of') args.asOf = value();
    else if (name === '--only') args.only = value();
    else if (name === '--json') args.json = resolve(value());
    else if (name === '--work-dir') args.workDir = resolve(value());
    else if (name === '--keep') args.keep = true;
    else throw new Error(`知らない指定です: ${name}`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs は1以上の整数です');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.asOf)) throw new Error('--as-of は「2026-09-30」の形です');
  if (args.only && !['a', 'b'].includes(args.only)) throw new Error('--only は a か b です');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workDir = args.workDir || resolve(appRoot, 'data', `d1-baseline-${Date.now()}`);
  mkdirSync(workDir, {recursive: true});
  const workbooks = [];
  if (args.only !== 'b') workbooks.push(streamingFixture());
  if (args.only !== 'a') workbooks.push(buildSyntheticWorkbook({rows: args.rows, works: args.works}));
  let base = null;
  try {
    // 架空データを1回だけ作り、計測の1回ごとに写しを作る（同じ原本は二度受け取れないため）
    console.log('準備: 架空データの組織 DEMO-SALES を作ります（20秒ほど）');
    const baseFile = join(workDir, 'base.sqlite');
    base = new LocalDatabase(baseFile);
    await seedSalesDemo(base);
    const results = [];
    for (const workbook of workbooks) {
      const runs = [];
      for (let run = 1; run <= args.runs; run += 1) {
        const runFile = join(workDir, `run-${results.length + 1}-${run}.sqlite`);
        base.raw.exec(`VACUUM INTO '${runFile.replaceAll("'", "''")}'`);
        const db = new LocalDatabase(runFile);
        try {
          const result = await measureOnce({db, workbook, asOf: args.asOf});
          runs.push(result);
          console.log(`${workbook.label} ${run}回目: ${MILESTONES.map(({key, no}) => `${no}${ms(result.marks[key])}`).join(' ')} ms・予実の即時 ${yesNo(result.forecastImmediate)}`);
        } finally {
          db.close();
        }
      }
      results.push({workbook: {label: workbook.label, fileName: workbook.fileName}, runs});
    }
    base.close();
    base = null;
    const environment = {node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model?.trim() || '不明', cores: cpus().length, asOf: args.asOf, measuredAt: new Date().toISOString()};
    console.log('');
    console.log(`環境: Node ${environment.node}・${environment.platform}・${environment.cpu}（${environment.cores}論理コア）・基準日 ${environment.asOf}`);
    console.log('');
    console.log(formatMarkdown(results));
    if (args.json) writeFileSync(args.json, `${JSON.stringify({environment, results}, null, 2)}\n`);
  } finally {
    base?.close();
    if (!args.keep) rmSync(workDir, {recursive: true, force: true});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
