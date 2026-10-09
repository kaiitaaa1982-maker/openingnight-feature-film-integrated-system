#!/usr/bin/env node
// 段2の実測（会社ルートの plans/2026-10-08-pg-stage2-measure.md の香盤表 S5・S7・S8）。取込から予実までの時間を、動いているアプリ
// （staging の Worker、または手元のアプリ）へ HTTP で向けて測る。区切り①〜⑦と API の順は、手元の計測（scripts/measure-d1-baseline.mjs）と
// 同じ部品（scripts/measure-common.mjs の measureRun）で、意味を変えない。代表は scripts/measure-staging.ps1 から流す。
//
// 使い方: node --disable-warning=ExperimentalWarning scripts/measure-staging.mjs --url <origin> [--check-only]
//           [--plan a:2026-06,a:2026-07,...] [--months 2026-06,2026-07,2026-08] [--only a|b] [--partner-a DEMO-PF-B] [--partner-b DEMO-PF-C]
//           [--rows 2000] [--works 20] [--as-of 2026-09-30] [--out-dir <フォルダ>] [--json <ファイル>] [--md <ファイル>]
//           [--previous <前の結果.json>] [--stop-after <回数>]
// ・https の URL: 環境変数 ON_ACCESS_TOKEN（cloudflared access token の値）を cf-access-token ヘッダで送り、Origin を付ける。Cookie は送らない。
//   トークンは JWT の exp だけを値を出さずに読み、各回の前に残りが2時間を切っていたら止める。最初に GET /api/session（Access のメールで
//   入れたか。メールは出さない）と GET /api/session/orgs（今の組織が DEMO-SALES か）を確かめ、以後の要求に X-On-Org を付ける
// ・http://127.0.0.1:<port>・http://localhost:<port>: 手元のアプリ（試験用）。/api/local/login で架空の管理者として入る
// ・回の計画（既定の6回）: (a) 架空の原本（10行・6作品）を DEMO-PF-B で、(b) 合成の1通（2,000行・20作品）を DEMO-PF-C で、
//   それぞれ対象月 2026-06・07・08。(a) を先に流す。予備の月は (b) の 2026-04・05。予備へは自動で移らない（代表が --plan に足す）
// ・届くはずの報告: 取引先×種類で1つを、PF-B は 2026-06、PF-C は 2026-04 から作って使い回し、計画の回を流し終えたら、使った最も遅い月で閉じる。
//   再開のときは計画の月を覆う規則を GET /api/progress/rules で見つけて使い回す（作り直すと 409 になる）
// ・再開: 同じ原本（生バイトの SHA-256）が登録済みの回と重なりのある回は飛ばし、途中まで残った回は「部分」として結果に書く。
//   前の結果（同じ置き場の measure-*/measure.json か --previous）に同じ登録の回があれば、その計測を結果に引き継ぐ。引き継ぐのは、向き先・DB の種類
//   （S7 の postgres と S8 の d1 は同じ URL・同じ置き場）・組織・原本の SHA-256・報告の id がすべて同じときだけ。DB の種類が分からなければ引き継がない
// ・DB を直接読まない。DB の呼び出し回数・1文の値の数・batch の文の数・抽出の終わりの時刻は null（表は「—」）
// ・--check-only は読み取りだけ（組織・取引先・計画の各月の同じ原本と重なり・届くはずの報告の有無を表にする。手元のログインのほか書き込みをしない）
// ・結果の JSON と Markdown は UTF-8 で直接書く。既定は %USERPROFILE%\ondrill\measure-<時刻>\（リポジトリの中には書かない）。1回ごとに書き直す
// ・出力・JSON・例外の文に、トークン・Cookie・メールを出さない（下の createRedactor を必ず通す）
// ・計測は1人の直列の要求で、負荷試験ではない。登録は消せない（staging に残る）
// 終了コード: 0 終わった（--check-only・--stop-after を含む）・1 この起動で測り始めたあとで止まった（回の失敗、回のあいだのトークンの残り、
//   規則を閉じる段の誤りを含む）・2 測り始める前に止めた（引数・在籍・トークンの残り）
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir, platform, release} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DEMO_ORG_CODE, MILESTONES, REFLECTED_LABELS, buildSyntheticWorkbook, formatMarkdown, lastDayOf, measureRun, ms, must, sha256Hex,
  streamingFixture, workbookWorkCodes, yesNo} from './measure-common.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');

export const TOKEN_ENV = 'ON_ACCESS_TOKEN';
export const TOKEN_MIN_REMAINING_MS = 2 * 60 * 60 * 1000;
// Container（抽出）は2分で休止する。前の回の受け取りからこれより空いた回は、冷えた状態を含むものとして印を付ける
export const COLD_IDLE_MS = 2 * 60 * 1000;
export const KIND = 'digital';
export const SOURCES = Object.freeze({
  a: Object.freeze({partnerCode: 'DEMO-PF-B', ruleFrom: '2026-06', label: '(a) 架空の原本（10行・6作品）'}),
  b: Object.freeze({partnerCode: 'DEMO-PF-C', ruleFrom: '2026-04', label: '(b) 合成の1通'}),
});
export const DEFAULT_MONTHS = Object.freeze(['2026-06', '2026-07', '2026-08']);
// 予備の月は (b) だけ。途中まで登録が残った月は使い直せない（同じ原本・report_key・重なりで断られる）
export const SPARE_MONTHS = Object.freeze(['2026-04', '2026-05']);
export const STATUS_LABELS = Object.freeze({
  ready: '測る', measured: '測った', done: '登録済み（飛ばした）', partial: '部分（途中まで登録が残った。飛ばした）',
  overlap: '重なりあり（飛ばした）', blocked: '見られない原本（飛ばした）', failed: '失敗（登録は残っていない）', pending: '未着手',
  // 登録は全部済んだのに、⑤〜⑦か照らし合わせで止まった回。取れた区切りだけを partialMarks に残す（その月は使い直せない）
  'registered-unmeasured': '登録済み・計測は途中まで（取れた区切りだけ残した）',
  // 失敗のあと、登録が残ったかの読み直しも失敗した回（残ったかは --check-only で確かめる）
  unverified: '失敗（登録が残ったか確かめられなかった）',
});
// クラウドの1回の登録（作品ごと）の上限（src/import/limits.mjs の worker.salesRows）。remote の D1 でも同じ1通を測れるように守る
const MAX_ROWS_PER_COMMIT = 100;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CLOSE_REASON = '性能の計測（架空）を終えた。PG 計画 段2の実測';
// 計測が作る届くはずの報告の備考。これと違う規則は計測の前からある（画面で作ったなど）ものとして、閉じる前に代表へ知らせる
export const RULE_NOTE = '性能の計測（架空）。PG 計画 段2の実測';

// 始める前・途中で止めるときの誤り。exitCode は CLI の終了コード
export class MeasureStop extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'MeasureStop';
    this.exitCode = exitCode;
  }
}

// 伏せる値（トークン・Cookie の値・メール）。出力・JSON・Markdown・例外の文はすべてここを通す。
// 知っている値のほか、JWT の形とメールの形も伏せる（API の誤りの文に混ざったときの備え）
export function createRedactor() {
  const secrets = new Set();
  const add = (value) => { if (typeof value === 'string' && value.length >= 4) secrets.add(value); };
  const text = (value) => {
    let out = String(value ?? '');
    for (const secret of [...secrets].sort((x, y) => y.length - x.length)) out = out.split(secret).join('［伏せた値］');
    return out.replace(/eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '［伏せたトークン］').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '［伏せたメール］');
  };
  return {add, text};
}

// --url を確かめる。https はどこでも（staging）、http は手元（127.0.0.1・localhost）だけ。origin だけを受け付ける
export function parseTarget(url) {
  let parsed;
  try { parsed = new URL(String(url ?? '')); } catch { throw new MeasureStop('--url は「https://…」か「http://127.0.0.1:<port>」の形で渡してください'); }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new MeasureStop('--url は origin だけにしてください（パス・問い合わせ・利用者名を付けない）');
  if (parsed.protocol === 'https:') return {origin: parsed.origin, https: true, loopback: false};
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return {origin: parsed.origin, https: false, loopback: true};
  throw new MeasureStop('http は手元（127.0.0.1・localhost）だけです。staging には https で向けてください');
}

// JWT の exp（ミリ秒）。値は出さない。読めなければ null
export function tokenExpiry(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

const relogin = (origin) => `cloudflared access login ${origin} からやり直し、同じコマンドで再開してください（登録済みの月は飛ばします）`;

// トークンの残り（ミリ秒）。2時間を切っていたら止める（計測の途中で切れると、登録が途中まで残る）
export function checkTokenTime({token, origin, now = Date.now(), min = TOKEN_MIN_REMAINING_MS}) {
  const expiry = tokenExpiry(token);
  if (expiry == null) throw new MeasureStop(`Access のトークンの有効期限を読めません。${relogin(origin)}`);
  const remaining = expiry - now;
  if (remaining < min) throw new MeasureStop(`Access のトークンの残りが2時間を切っています（残り約${Math.max(0, Math.floor(remaining / 60000))}分）。${relogin(origin)}`);
  return remaining;
}

const minutesText = (remaining) => `約${Math.floor(remaining / 3600000)}時間${Math.floor((remaining % 3600000) / 60000)}分`;

// HTTP の口。https は cf-access-token と Origin、手元はログインの Cookie（on_session だけ。on_org は送らない）。
// 3xx は追わない（Access のログイン画面へ転送されたら、HTML を読まずに止める）
export function createClient({target, token = null, fetchImpl = globalThis.fetch, redactor}) {
  let cookie = null;
  let orgId = null;
  async function call(method, path, payload) {
    const headers = {accept: 'application/json', origin: target.origin};
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (target.https) headers['cf-access-token'] = token;
    if (cookie) headers.cookie = cookie;
    if (orgId != null) headers['x-on-org'] = String(orgId);
    let response;
    try {
      response = await fetchImpl(`${target.origin}/api${path}`, {method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), redirect: 'manual'});
    } catch (error) {
      throw new Error(redactor.text(`${method} /api${path.split('?')[0]} に届きません（${error?.cause?.code || error?.name || '不明'}）`));
    }
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) return {status: response.status, data: {ok: false, error: 'Access のログインへ転送された（トークンが通っていない）'}};
    let data;
    try { data = JSON.parse(text); } catch { data = {ok: false, error: `JSON でない応答（${text.length}文字）`}; }
    return {status: response.status, data};
  }
  // 手元のアプリだけ。架空の管理者（.invalid）で入り、Cookie の on_session だけを持つ
  async function localLogin(email) {
    if (!target.loopback) throw new MeasureStop('手元のログインは http://127.0.0.1 のときだけです');
    redactor.add(email);
    const response = await fetchImpl(`${target.origin}/api/local/login`, {method: 'POST', headers: {'content-type': 'application/json', origin: target.origin}, body: JSON.stringify({email}), redirect: 'manual'});
    await response.text();
    if (response.status !== 200) throw new MeasureStop(`手元のアプリに架空の管理者で入れません（${response.status}）`);
    const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
    const session = lines.map((line) => line.split(';')[0].trim()).find((pair) => pair.startsWith('on_session='));
    if (!session) throw new MeasureStop('手元のアプリがセッションを返しません');
    redactor.add(session.slice('on_session='.length));
    cookie = session;
  }
  return {call, localLogin, pinOrg: (id) => { orgId = Number(id); }};
}

// 利用者と組織を確かめる（メールは出さない）。今の組織が DEMO-SALES でなければ止める。以後の要求は X-On-Org で組織を固定する
async function establish({client, target, redactor}) {
  if (target.loopback) {
    const {SALES_DEMO} = await import('./seed-sales-demo.mjs');
    await client.localLogin(SALES_DEMO.adminEmail);
  }
  const health = await client.call('GET', '/health');
  const session = await client.call('GET', '/session');
  if (session.status !== 200 || session.data?.ok !== true) {
    throw new MeasureStop(`利用者を確かめられません（GET /api/session が ${session.status}）。${target.https ? relogin(target.origin) : '手元のアプリを確かめてください'}`);
  }
  const email = session.data.user?.email;
  if (typeof email !== 'string' || !email.includes('@')) throw new MeasureStop('Access のメールで入れていません（GET /api/session に利用者のメールが無い。サービストークンでは業務の API を通れません）');
  redactor.add(email);
  const orgs = must(await client.call('GET', '/session/orgs'), 200, '在籍している組織', {redact: redactor.text});
  const current = (orgs.orgs || []).find((org) => Number(org.id) === Number(orgs.currentOrgId));
  if (!current || current.code !== DEMO_ORG_CODE) throw new MeasureStop(`今の組織が ${DEMO_ORG_CODE} ではありません（${current?.code ?? '不明'}）。計測を止めます`);
  client.pinOrg(current.id);
  return {database: health.status === 200 ? (health.data?.database ?? null) : null, mode: session.data.mode ?? null, role: session.data.user?.role ?? null,
    org: {code: current.code, memberships: (orgs.orgs || []).length}};
}

function parseMonths(text) {
  const list = String(text).split(',').map((item) => item.trim()).filter(Boolean);
  if (!list.length || list.some((month) => !MONTH.test(month))) throw new MeasureStop('--months は「2026-06,2026-07」の形です');
  return list;
}

// 回の計画。--plan（「a:2026-06,b:2026-04」の並び。順に流す）か、--months と --only から既定の並び（(a) を先に）を作る
export function buildPlan({plan = null, months = null, only = null, partnerA = SOURCES.a.partnerCode, partnerB = SOURCES.b.partnerCode} = {}) {
  const partnerOf = {a: partnerA, b: partnerB};
  let items;
  if (plan) {
    if (months || only) throw new MeasureStop('--plan と --months・--only は一緒に使えません');
    items = String(plan).split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
      const found = /^([ab]):(\d{4}-\d{2})$/.exec(item);
      if (!found || !MONTH.test(found[2])) throw new MeasureStop(`--plan の「${item}」は「a:2026-06」の形にしてください（a は架空の原本、b は合成の1通）`);
      return {source: found[1], month: found[2]};
    });
  } else {
    if (only && !['a', 'b'].includes(only)) throw new MeasureStop('--only は a か b です');
    const list = months ? parseMonths(months) : DEFAULT_MONTHS;
    items = (only ? [only] : ['a', 'b']).flatMap((source) => list.map((month) => ({source, month})));
  }
  if (!items.length) throw new MeasureStop('計画の回がありません');
  const seen = new Set();
  for (const {source, month} of items) {
    // 同じ取引先・同じ月の回が2つあると、2つ目は重なりで断られる
    const key = `${partnerOf[source]}|${month}`;
    if (seen.has(key)) throw new MeasureStop(`計画に同じ取引先（${partnerOf[source]}）・同じ月（${month}）の回が2つあります`);
    seen.add(key);
  }
  return items.map(({source, month}, index) => ({no: index + 1, source, month, partnerCode: partnerOf[source],
    reportKey: `${partnerOf[source]}-${month}-MEAS${source.toUpperCase()}`}));
}

export const planText = (runs) => runs.map((run) => `${run.source}:${run.month}`).join(',');

// 回ごとの原本。(a) は対象月を書き換えた架空の原本、(b) は合成の1通（取引先を本文にも入れる）。どちらも同じ引数なら同じバイト
function workbookFor(run, {rows, works}) {
  if (run.source === 'a') return {...streamingFixture({month: run.month}), partnerCode: run.partnerCode};
  return buildSyntheticWorkbook({rows, works, month: run.month, partnerCode: run.partnerCode});
}

const LOCAL_TIME = (date) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
};
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// 結果の置き場。既定は %USERPROFILE%\ondrill\measure-<時刻>\。リポジトリの中には書かない（main のフォルダに未追跡のファイルを残すと sync.py が止まる）
export function resolveOutputs({outDir = null, json = null, md = null, checkOnly = false, home = homedir(), now = new Date()} = {}) {
  const dir = outDir ? resolve(outDir) : join(home, 'ondrill', `measure-${LOCAL_TIME(now)}`);
  const name = checkOnly ? 'check-only' : 'measure';
  const paths = {dir, json: json ? resolve(json) : join(dir, `${name}.json`), md: md ? resolve(md) : join(dir, `${name}.md`)};
  for (const path of Object.values(paths)) {
    if (inside(repoRoot, path)) throw new MeasureStop(`結果をリポジトリの中（${path}）には書きません。--out-dir はリポジトリの外にしてください`);
  }
  return paths;
}

// 同じ原本の有無と重なり。state: ready（測れる）・done（登録済み）・partial（途中まで残った）・overlap（重なりあり）・blocked（見られない原本）
async function inspectRun({client, run, masters, redact, withOverlaps = false}) {
  const look = must(await client.call('GET', `/sales-import/artifacts/lookup?sha256=${run.sha256}`), 200, '同じ原本の有無', {redact});
  let state = 'ready';
  let registration = null;
  if (look.restricted) state = 'blocked';
  else if (look.file) {
    registration = {committed: Number(look.file.committed ?? 0), partitions: Number(look.file.partitions ?? 0), reportIds: (look.file.reportIds || []).map(Number)};
    state = look.file.complete ? 'done' : 'partial';
  } else if (look.artifact) {
    registration = {committed: look.artifact.committed ? 1 : 0, partitions: 1, reportIds: look.artifact.reportId ? [Number(look.artifact.reportId)] : []};
    state = look.artifact.committed ? 'done' : 'partial';
  }
  let overlaps = null;
  if (withOverlaps || state === 'ready') {
    const partner = masters.partners.get(run.partnerCode);
    const works = masters.works.get(run.partnerCode);
    const workIds = run.workCodes.map((code) => works.get(code)).filter(Boolean);
    if (!workIds.length) throw new MeasureStop(`${run.fileName} の作品が ${DEMO_ORG_CODE} にありません`);
    overlaps = 0;
    for (const workId of workIds) {
      const found = must(await client.call('GET', `/sales-import/overlaps?workId=${workId}&partnerId=${partner.id}&kind=${KIND}&from=${run.month}-01&to=${lastDayOf(run.month)}`), 200, '重なり', {redact});
      overlaps += (found.overlaps || []).length;
    }
    if (state === 'ready' && overlaps > 0) state = 'overlap';
  }
  return {state, registration, overlaps};
}

async function loadMasters({client, runs, redact}) {
  const rows = must(await client.call('GET', '/partners'), 200, '取引先', {redact}).rows || [];
  const partners = new Map(rows.map((row) => [row.code, {id: Number(row.id), name: row.name, code: row.code}]));
  const codes = [...new Set(runs.map((run) => run.partnerCode))];
  const missing = codes.filter((code) => !partners.has(code));
  if (missing.length) throw new MeasureStop(`取引先 ${missing.join('・')} がありません（${DEMO_ORG_CODE} の架空データか確かめてください）`);
  const works = new Map();
  for (const code of codes) {
    const context = must(await client.call('GET', `/sales-import/context?partnerId=${partners.get(code).id}&kind=${KIND}`), 200, '取込の文脈', {redact});
    works.set(code, new Map((context.works || []).map((work) => [work.code, Number(work.id)])));
  }
  return {partners, works};
}

const partnerRules = (rules, partnerId) => rules.filter((rule) => Number(rule.partner_id) === Number(partnerId) && rule.kind === KIND && rule.work_id == null);
const covers = (rule, first, last) => rule.active_from <= first && (rule.last_month == null || rule.last_month >= last);
// 取引先ごとの規則の開始月: その取引先を使う原本の既定（PF-B 2026-06、PF-C 2026-04）と、計画の最も早い月の早い方
const ruleFromFor = (runs, partnerCode) => [...runs.filter((run) => run.partnerCode === partnerCode).flatMap((run) => [SOURCES[run.source].ruleFrom, run.month])].sort()[0];

// 届くはずの報告を見つける（create が true なら無いときに作る）。測る回（ready）のある取引先だけ。計画の月を覆う規則を使い回す。
// preexisting: 使い回す規則の備考が計測のもの（RULE_NOTE）と違う（計測の前からある）。流し終えると閉じ、閉じると戻せない
const preexisting = (rule) => (rule ? String(rule.note ?? '') !== RULE_NOTE : false);
async function resolveRules({client, runs, masters, redact, create}) {
  const out = new Map();
  let rules = must(await client.call('GET', '/progress/rules'), 200, '届くはずの報告', {redact}).rules || [];
  for (const partnerCode of [...new Set(runs.map((run) => run.partnerCode))]) {
    const months = runs.filter((run) => run.partnerCode === partnerCode && run.state === 'ready').map((run) => run.month).sort();
    const partner = masters.partners.get(partnerCode);
    const mine = partnerRules(rules, partner.id);
    const open = mine.find((rule) => rule.last_month == null) || null;
    if (!months.length) {
      out.set(partnerCode, {id: open?.id ?? null, activeFrom: open?.active_from ?? null, lastMonth: null, created: false, needed: false, preexisting: preexisting(open)});
      continue;
    }
    const [first, last] = [months[0], months.at(-1)];
    const found = mine.filter((rule) => covers(rule, first, last)).sort((x, y) => (x.last_month == null ? 0 : 1) - (y.last_month == null ? 0 : 1) || Number(x.id) - Number(y.id))[0];
    if (found) {
      out.set(partnerCode, {id: Number(found.id), activeFrom: found.active_from, lastMonth: found.last_month ?? null, created: false, needed: true, preexisting: preexisting(found)});
      continue;
    }
    if (open) throw new MeasureStop(`開いている届くはずの報告（${partnerCode}・${open.active_from} から）が、計画の月 ${first} を覆いません。閉じるかは代表が決めます`);
    const activeFrom = [ruleFromFor(runs, partnerCode), first].sort()[0];
    if (!create) {
      out.set(partnerCode, {id: null, activeFrom, lastMonth: null, created: false, needed: true, preexisting: false});
      continue;
    }
    const made = await client.call('POST', '/progress/rules', {partnerId: partner.id, kind: KIND, frequency: 'monthly', activeFrom, note: RULE_NOTE});
    if (made.status === 201) {
      out.set(partnerCode, {id: Number(made.data.id), activeFrom, lastMonth: null, created: true, needed: true, preexisting: false});
      continue;
    }
    // 作ると 409 なら、有効期間の重なる規則がある（閉じた規則を含む）。それが計画の月を覆えば使い回す
    if (made.status === 409 && made.data?.existingId) {
      rules = must(await client.call('GET', '/progress/rules'), 200, '届くはずの報告', {redact}).rules || [];
      const existing = rules.find((rule) => Number(rule.id) === Number(made.data.existingId));
      if (existing && covers(existing, first, last)) {
        out.set(partnerCode, {id: Number(existing.id), activeFrom: existing.active_from, lastMonth: existing.last_month ?? null, created: false, needed: true, preexisting: preexisting(existing)});
        continue;
      }
      throw new MeasureStop(`届くはずの報告（${partnerCode}）が計画の月 ${first}〜${last} を覆いません（${existing?.active_from ?? '?'}〜${existing?.last_month ?? '終了なし'}）。代表と Claude で相談してください`);
    }
    must(made, 201, '届くはずの報告を作る', {redact});
  }
  return out;
}

// 計画の回を流し終えたら、取引先ごとに使った最も遅い月で規則を閉じる（閉じるには lastMonth と reason が要り、応答は 201）
async function closeRules({client, runs, masters, redact}) {
  const rules = must(await client.call('GET', '/progress/rules'), 200, '届くはずの報告', {redact}).rules || [];
  const out = [];
  for (const partnerCode of [...new Set(runs.map((run) => run.partnerCode))]) {
    const used = runs.filter((run) => run.partnerCode === partnerCode && ['measured', 'done', 'partial', 'registered-unmeasured'].includes(run.status)).map((run) => run.month).sort();
    if (!used.length) continue;
    const [first, lastMonth] = [used[0], used.at(-1)];
    const mine = partnerRules(rules, masters.partners.get(partnerCode).id);
    const open = mine.find((rule) => rule.last_month == null && rule.active_from <= lastMonth);
    if (open) {
      must(await client.call('POST', `/progress/rules/${open.id}/close`, {lastMonth, reason: CLOSE_REASON}), 201, '届くはずの報告を閉じる', {redact});
      out.push({partnerCode, id: Number(open.id), activeFrom: open.active_from, lastMonth, action: 'closed', preexisting: preexisting(open)});
      continue;
    }
    const closed = mine.find((rule) => covers(rule, first, lastMonth));
    out.push(closed ? {partnerCode, id: Number(closed.id), activeFrom: closed.active_from, lastMonth: closed.last_month, action: 'already-closed', preexisting: preexisting(closed)}
      : {partnerCode, id: null, activeFrom: null, lastMonth: null, action: 'missing', preexisting: false});
  }
  return out;
}

const sameIds = (a = [], b = []) => JSON.stringify([...a].map(Number).sort((x, y) => x - y)) === JSON.stringify([...b].map(Number).sort((x, y) => x - y));

// 前の結果を読み、登録済みで飛ばした回に、同じ登録の計測（測った回と、登録は済んで計測が途中までの回）を引き継ぐ。
// 同じ向き先でも、DB の種類（S7 の postgres と S8 の d1 は同じ URL・同じ ~/ondrill）と組織が今の起動と同じ結果だけを読む。
// DB の種類が分からない（/api/health が答えない）ときは、取り違えを避けて何も引き継がない
function loadPrevious({paths, dir, origin, session, current}) {
  if (session?.database == null) return [];
  let files = paths.map((path) => resolve(path));
  if (!files.length && existsSync(dirname(dir))) {
    files = readdirSync(dirname(dir), {withFileTypes: true})
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('measure-') && join(dirname(dir), entry.name) !== dir)
      .map((entry) => join(dirname(dir), entry.name, 'measure.json')).filter((path) => existsSync(path) && resolve(path) !== current);
  }
  const found = [];
  for (const file of files) {
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    if (data?.tool !== 'measure-staging' || data.origin !== origin) continue;
    if (data.session?.database !== session.database || data.session?.org?.code !== session.org?.code) continue;
    for (const run of data.runs || []) {
      const usable = (run.status === 'measured' && run.result) || (run.status === 'registered-unmeasured' && run.partialMarks);
      if (usable) found.push({...run, carriedFrom: run.carriedFrom || basename(dirname(file)), measuredAt: data.environment?.measuredAt || ''});
    }
  }
  return found.sort((x, y) => String(y.measuredAt).localeCompare(String(x.measuredAt)));
}

const tag = (run) => `${run.no}. (${run.source}) ${run.partnerCode} ${run.month}`;
const spareHint = (runs) => `予備の月（(b) の ${SPARE_MONTHS.join('・')}）を使うかは代表が決めます。使うときは -Plan（--plan）に足して同じコマンドで流します。例: ${planText(runs)},b:${SPARE_MONTHS[0]}`;
// 飛ばした回（部分・重なり・見られない原本）の案内。(a) には予備の月が無い
function skippedGuidance(runs) {
  const skipped = runs.filter((run) => ['partial', 'overlap', 'blocked'].includes(run.status));
  const lines = [];
  if (skipped.some((run) => run.source === 'a')) lines.push(`(a) の回（${skipped.filter((run) => run.source === 'a').map((run) => run.month).join('・')}）を測れません。(a) には予備の月が無いので、Claude と相談してください`);
  if (skipped.some((run) => run.source === 'b')) lines.push(`(b) の回（${skipped.filter((run) => run.source === 'b').map((run) => run.month).join('・')}）を測れません。${spareHint(runs)}`);
  return lines;
}

function reflectedCount(result) {
  return Object.keys(REFLECTED_LABELS).filter((key) => result.reflected[key]).length;
}

// 結果の Markdown（数値と状態だけ。接続値・メール・トークンは持たない）
export function formatReport(report) {
  const out = ['## 取込から予実までの時間（動いているアプリに向けた計測）', ''];
  out.push(`- 向き先: ${report.origin}（DB: ${report.session?.database ?? '不明'}・mode: ${report.session?.mode ?? '不明'}）`,
    `- 組織: ${report.session?.org?.code ?? '不明'}（在籍 ${report.session?.org?.memberships ?? '?'}）`,
    `- 計画: ${report.options.plan}（基準日 ${report.options.asOf}、(b) は ${report.options.rows.toLocaleString('ja-JP')}行・${report.options.works}作品）`,
    `- 時刻: ${report.environment.measuredAt}〜${report.environment.finishedAt ?? ''}（Node ${report.environment.node}・${report.environment.platform}）`,
    `- 結果: ${report.outcome}`,
    '- 1人の直列の要求で、負荷試験ではない。②〜③の人の確認は0。予実は受領進捗で代えた参考値', '');
  if (report.token) out.push(`- Access のトークンの残り（始めたとき）: ${report.token.remainingText}`, '');
  out.push('### 回の一覧', '', '| # | 原本 | 取引先 | 対象月 | 状態 | 冷え | 回の前の有効な報告 | 回の前の年間売上（計上月） | ①→④ ms | ①→⑥ ms | ①→⑦ ms | 最初の確認→最後の登録 ms | 反映 | 即時 |',
    '|--:|---|---|---|---|---|--:|--:|--:|--:|--:|--:|---|---|');
  for (const run of report.runs) {
    const r = run.result;
    // 登録は済んで計測が途中までの回は、取れた区切りだけを出す（取れていない区切りは「—」）
    const marks = r?.marks ?? run.partialMarks ?? null;
    const status = `${STATUS_LABELS[run.status] || run.status}${run.carriedFrom ? `（${run.carriedFrom} から引き継ぎ）` : ''}${run.registration && run.status !== 'measured' ? `（${run.registration.committed}/${run.registration.partitions} 作品）` : ''}`;
    const cold = run.cold === 'first' ? '1回目' : run.cold === 'idle' ? '2分超の間' : '';
    out.push(`| ${run.no} | ${run.source} | ${run.partnerCode} | ${run.month} | ${status} | ${cold} | ${r ? (r.before.activeReports ?? '—') : '—'} | ${r ? ms(r.before.annualMonthTotal) : '—'} | ${marks ? ms(marks.m4) : '—'} | ${marks ? ms(marks.m6) : '—'} | ${marks ? ms(marks.m7) : '—'} | ${r ? ms(r.tokenSpanMs) : '—'} | ${r ? `${reflectedCount(r)}/6` : '—'} | ${r ? yesNo(r.forecastImmediate) : '—'} |`);
  }
  out.push('');
  if (report.rules?.length) {
    out.push('### 届くはずの報告', '', '| 取引先 | id | 開始月 | 閉じた月 | この回で |', '|---|--:|---|---|---|');
    const actions = {created: '作った', reused: '使い回した', closed: '閉じた', 'already-closed': '閉じてあった', missing: '見つからない', planned: '測る前に作る'};
    for (const rule of report.rules) out.push(`| ${rule.partnerCode} | ${rule.id ?? '—'} | ${rule.activeFrom ?? '—'} | ${rule.lastMonth ?? '—'} | ${actions[rule.action] || rule.action}${rule.preexisting ? '（計測の前からある規則）' : ''} |`);
    out.push('');
  }
  // 原本ごとの区切りの表（手元の計測と同じ形）。見出しは原本・取引先・月の並び
  for (const source of ['a', 'b']) {
    const measured = report.runs.filter((run) => run.source === source && run.status === 'measured' && run.result);
    if (!measured.length) continue;
    const label = `${source === 'b' ? `(b) 合成の1通（${report.options.rows.toLocaleString('ja-JP')}行・${report.options.works}作品）` : SOURCES.a.label}・${measured[0].partnerCode}・${measured.map((run) => run.month).join('・')}`;
    const fileName = `${measured[0].result.fileName}${measured.length > 1 ? ' ほか' : ''}`;
    out.push(formatMarkdown([{runs: measured.map((run) => ({...run.result, label, fileName}))}]));
  }
  if (report.checks) {
    out.push('### 事前の確認（読み取りだけ）', '', '| # | 原本 | 取引先 | 対象月 | 同じ原本 | 重なり | 判定 |', '|--:|---|---|---|---|--:|---|');
    for (const check of report.checks) out.push(`| ${check.no} | ${check.source} | ${check.partnerCode} | ${check.month} | ${check.sameFile} | ${check.overlaps ?? '—'} | ${STATUS_LABELS[check.state] || check.state} |`);
    out.push('');
  }
  if (report.guidance?.length) out.push('### 案内', '', ...report.guidance.map((line) => `- ${line}`), '');
  return out.join('\n');
}

// 計測の本体（CLI と試験の共通）。結果の JSON と Markdown を書き、report を返す。止めるときは MeasureStop を投げる（その前に結果を書く）
export async function runMeasurement({url, token = null, checkOnly = false, plan = null, months = null, only = null, partnerA = SOURCES.a.partnerCode, partnerB = SOURCES.b.partnerCode,
  rows = 2000, works = 20, asOf = '2026-09-30', outDir = null, json = null, md = null, previous = [], stopAfter = null,
  fetchImpl = globalThis.fetch, log = (line) => console.log(line), now = () => Date.now(), home = homedir()} = {}) {
  const redactor = createRedactor();
  if (token) redactor.add(token);
  const say = (line) => log(redactor.text(line));
  const target = parseTarget(url);
  if (target.https && !token) throw new MeasureStop(`${TOKEN_ENV} がありません。scripts/measure-staging.ps1 から流してください（cloudflared access token の値を渡します）`);
  const accessToken = target.https ? token : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new MeasureStop('--as-of は「2026-09-30」の形です');
  if (!Number.isInteger(rows) || !Number.isInteger(works) || works < 1 || works > 20 || rows < works) throw new MeasureStop('--rows と --works は整数で、作品は1〜20、行数は作品の数以上です');
  if (Math.ceil(rows / works) > MAX_ROWS_PER_COMMIT) throw new MeasureStop(`(b) の1作品の行数が ${MAX_ROWS_PER_COMMIT} を超えます（クラウドの1回の登録の上限。--rows ÷ --works を ${MAX_ROWS_PER_COMMIT} 以下に）`);
  if (stopAfter != null && !(Number.isInteger(stopAfter) && stopAfter >= 1)) throw new MeasureStop('--stop-after は1以上の整数です');
  const runs = buildPlan({plan, months, only, partnerA, partnerB}).map((run) => {
    const workbook = workbookFor(run, {rows, works});
    return {...run, fileName: workbook.fileName, sha256: sha256Hex(workbook.bytes), workCodes: workbookWorkCodes(workbook), workbook};
  });
  const outputs = resolveOutputs({outDir, json, md, checkOnly, home, now: new Date(now())});
  const report = {
    tool: 'measure-staging', version: 1, origin: target.origin, checkOnly,
    environment: {node: process.version, platform: `${platform()} ${release()}`, measuredAt: new Date(now()).toISOString(), finishedAt: null},
    options: {plan: planText(runs), asOf, rows, works, stopAfter},
    session: null, token: null, outcome: 'started', runs: [], rules: [], checks: null, guidance: [],
  };
  const sync = () => {
    report.runs = runs.map(({workbook, workCodes, ...rest}) => rest);
    report.environment.finishedAt = new Date(now()).toISOString();
  };
  const persist = () => {
    sync();
    mkdirSync(dirname(outputs.json), {recursive: true});
    mkdirSync(dirname(outputs.md), {recursive: true});
    writeFileSync(outputs.json, `${redactor.text(JSON.stringify(report, null, 2))}\n`, 'utf8');
    writeFileSync(outputs.md, `${redactor.text(formatReport(report))}\n`, 'utf8');
  };
  try {
    if (accessToken) {
      const expiry = tokenExpiry(accessToken);
      const remaining = expiry == null ? null : expiry - now();
      // enough: 計測を始めてよい残りか（scripts/measure-staging.ps1 が check-only.json を読み、足りなければ見本取りの前に止める）
      report.token = {remainingMinutes: remaining == null ? null : Math.floor(remaining / 60000), remainingText: remaining == null ? '読めない' : minutesText(remaining),
        enough: remaining != null && remaining >= TOKEN_MIN_REMAINING_MS};
      say(`Access のトークン: 残り ${report.token.remainingText}（値は出さない。2時間を切ると計測を止める）`);
      if (checkOnly && !report.token.enough) report.guidance.push(`Access のトークンの残りが2時間を切っているので、このままでは計測を始められません。${relogin(target.origin)}`);
      if (!checkOnly) checkTokenTime({token: accessToken, origin: target.origin, now: now()});
    }
    const client = createClient({target, token: accessToken, fetchImpl, redactor});
    report.session = await establish({client, target, redactor});
    say(`利用者: 確かめた（${target.https ? 'Access のメールで入った。' : '手元の架空の管理者。'}メールは出さない）・役割 ${report.session.role}`);
    say(`組織: ${report.session.org.code}（在籍 ${report.session.org.memberships}）・DB: ${report.session.database ?? '不明'}`);
    const redact = redactor.text;
    const masters = await loadMasters({client, runs, redact});
    for (const run of runs) {
      const found = await inspectRun({client, run, masters, redact, withOverlaps: checkOnly});
      Object.assign(run, {state: found.state, status: found.state === 'ready' ? 'pending' : found.state, registration: found.registration, overlaps: found.overlaps});
    }

    if (checkOnly) {
      const rules = await resolveRules({client, runs, masters, redact, create: false});
      report.rules = [...rules.entries()].map(([partnerCode, rule]) => ({partnerCode, id: rule.id, activeFrom: rule.activeFrom, lastMonth: rule.lastMonth,
        action: rule.id == null ? (rule.needed ? 'planned' : 'missing') : 'reused', preexisting: rule.preexisting}));
      // 計測の前からある開いた規則を、測る回のために使い回すと、流し終えたときに閉じる（閉じると戻せない）。yes と打つ前に代表が決められるように知らせる
      for (const rule of report.rules.filter((row) => row.preexisting && row.id != null && row.lastMonth == null && rules.get(row.partnerCode).needed)) {
        report.guidance.push(`届くはずの報告 ${rule.partnerCode} の id ${rule.id}（${rule.activeFrom} から・開いている）は、計測で作った規則ではありません（備考が計測のものと違う）。計測を流し終えると、使った最も遅い月で閉じます（閉じると戻せません）。使い回してよいかを確かめてから yes と打ってください`);
      }
      report.checks = runs.map((run) => ({no: run.no, source: run.source, partnerCode: run.partnerCode, month: run.month, state: run.state, overlaps: run.overlaps,
        sameFile: run.registration ? `${run.state === 'done' ? '登録済み' : '部分'}（${run.registration.committed}/${run.registration.partitions} 作品）` : 'なし'}));
      report.guidance.push(...skippedGuidance(runs));
      report.outcome = 'check-only';
      persist();
      say('');
      say('| # | 原本 | 取引先 | 対象月 | 同じ原本 | 重なり | 判定 |');
      say('|--:|---|---|---|---|--:|---|');
      for (const check of report.checks) say(`| ${check.no} | ${check.source} | ${check.partnerCode} | ${check.month} | ${check.sameFile} | ${check.overlaps} | ${STATUS_LABELS[check.state]} |`);
      say('');
      for (const rule of report.rules) say(`届くはずの報告 ${rule.partnerCode}: ${rule.action === 'planned' ? `無い（最初の回の前に ${rule.activeFrom} から作る）` : rule.id == null ? '測る回が無いので使わない' : `id ${rule.id}（${rule.activeFrom} から・${rule.lastMonth ? `${rule.lastMonth} で閉じてある` : '開いている'}${rule.preexisting ? '・計測の前からある規則' : ''}）を使い回す`}`);
      for (const line of report.guidance) say(line);
      say(`読み取りだけで終えました。結果: ${outputs.json}`);
      return report;
    }

    // 前の結果から、登録済みで飛ばす回の計測を引き継ぐ（同じ DB の種類・組織・原本の SHA-256・報告の id のときだけ）
    const prior = loadPrevious({paths: previous, dir: outputs.dir, origin: target.origin, session: report.session, current: outputs.json});
    for (const run of runs.filter((item) => item.state === 'done')) {
      const match = prior.find((item) => item.source === run.source && item.partnerCode === run.partnerCode && item.month === run.month && item.sha256 === run.sha256
        && sameIds(item.result?.reportIds ?? item.registration?.reportIds, run.registration?.reportIds));
      if (!match) continue;
      const carried = {cold: match.cold ?? null, startedAt: match.startedAt ?? null, finishedAt: match.finishedAt ?? null, carriedFrom: match.carriedFrom};
      if (match.status === 'measured') Object.assign(run, {status: 'measured', result: match.result, ...carried});
      else Object.assign(run, {status: 'registered-unmeasured', partialMarks: match.partialMarks, partialStartedAt: match.partialStartedAt ?? null, error: match.error ?? null, ...carried});
    }
    const rules = await resolveRules({client, runs, masters, redact, create: true});
    report.rules = [...rules.entries()].filter(([, rule]) => rule.needed).map(([partnerCode, rule]) => ({partnerCode, id: rule.id, activeFrom: rule.activeFrom, lastMonth: rule.lastMonth, action: rule.created ? 'created' : 'reused', preexisting: rule.preexisting}));
    persist();

    let measuredNow = 0;
    let previousRun = null;
    let failure = null;
    let stopped = false;
    for (const run of runs) {
      if (run.state !== 'ready') {
        say(`${tag(run)}: ${STATUS_LABELS[run.status] || run.status}${run.carriedFrom ? `（計測は ${run.carriedFrom} から引き継ぎ）` : ''}`);
        continue;
      }
      if (stopAfter != null && measuredNow >= stopAfter) { stopped = true; break; }
      if (accessToken) checkTokenTime({token: accessToken, origin: target.origin, now: now()});
      const partner = masters.partners.get(run.partnerCode);
      run.startedAt = new Date(now()).toISOString();
      say(`${tag(run)}: 測ります`);
      const progress = {};
      try {
        const result = await measureRun({call: client.call, workbook: run.workbook, partner, ruleId: rules.get(run.partnerCode).id, reportKey: run.reportKey, asOf, redact, progress});
        run.finishedAt = new Date(now()).toISOString();
        const startedMs = Date.parse(result.startedAt);
        const idleMs = previousRun ? startedMs - (Date.parse(previousRun.result.startedAt) + previousRun.result.marks.m2) : null;
        Object.assign(run, {status: 'measured', state: 'measured', result, cold: measuredNow === 0 ? 'first' : idleMs > COLD_IDLE_MS ? 'idle' : null, idleBeforeMs: idleMs == null ? null : Math.round(idleMs)});
        measuredNow += 1;
        previousRun = run;
        if (result.problems.length) say(`  照らし合わせで気になる点: ${result.problems.join(' ／ ')}`);
        say(`  ${MILESTONES.map(({key, no}) => `${no}${ms(result.marks[key])}`).join(' ')} ms・反映 ${reflectedCount(result)}/6・予実の即時 ${yesNo(result.forecastImmediate)}${run.cold ? '・冷えた状態を含む' : ''}`);
      } catch (error) {
        run.finishedAt = new Date(now()).toISOString();
        run.error = redactor.text(error.message);
        // 登録が残ったかを読み直す（残っていれば、その月は使い直せない）。読み直しも失敗したら、残ったかは分からないとして残す
        let after = null;
        try { after = await inspectRun({client, run, masters, redact}); } catch { after = null; }
        run.registration = after?.registration ?? null;
        if (!after) run.status = 'unverified';
        else if (after.state === 'ready') run.status = 'failed';
        else if (after.state === 'done') {
          // 登録は全部済んだ（⑤〜⑦か照らし合わせで止まった）。取れた区切りを残す。予備の月では測り直さない
          run.status = 'registered-unmeasured';
          run.partialMarks = {...(progress.marks || {})};
          run.partialStartedAt = progress.startedAt ?? null;
        } else run.status = 'partial';
        run.state = run.status;
        failure = run;
      }
      persist();
      if (failure) break;
    }
    for (const run of runs) if (run.state === 'ready') run.status = 'pending';

    if (failure) {
      report.outcome = 'failed';
      report.guidance.push(`${tag(failure)} の回が失敗しました: ${failure.error}`);
      if (failure.status === 'failed') report.guidance.push('登録は残っていません。同じコマンドで流し直すと、この月から続けます（登録済みの月は飛ばします）');
      else if (failure.status === 'unverified') report.guidance.push('登録が残ったかを読み直せませんでした（向き先に届かないなど）。同じコマンドに -CheckOnly（node なら --check-only）を付けて流し、この月の判定を確かめてから続けてください');
      else if (failure.status === 'registered-unmeasured') {
        const got = MILESTONES.filter(({key}) => failure.partialMarks?.[key] != null).map(({no}) => no).join('');
        report.guidance.push(`登録はすべて済みましたが、計測が途中で止まりました（取れた区切り ${got || 'なし'} を結果に残しました）。同じコマンドで再開すると、この月は登録済みとして飛ばし、ほかの月を続けます。この月を測り直すかは Claude と相談してください`);
      } else if (failure.source === 'a') report.guidance.push('登録が途中まで残りました。(a) には予備の月が無いので、ここで止めて Claude と相談してください');
      else report.guidance.push(`登録が途中まで残りました（再開すると「部分」として飛ばします）。${spareHint(runs)}`);
      persist();
      throw new MeasureStop(report.guidance.join('\n'), 1);
    }
    if (stopped) {
      report.outcome = 'stopped';
      report.guidance.push(`--stop-after ${stopAfter} で止めました。届くはずの報告は閉じていません。同じコマンドで再開します（登録済みの月は飛ばします）`);
      persist();
      for (const line of report.guidance) say(line);
      say(`結果: ${outputs.json}`);
      return report;
    }
    const closed = await closeRules({client, runs, masters, redact});
    for (const rule of closed) {
      const index = report.rules.findIndex((row) => row.partnerCode === rule.partnerCode);
      const merged = {...(index >= 0 ? report.rules[index] : {}), ...rule};
      if (index >= 0) report.rules[index] = merged; else report.rules.push(merged);
    }
    if (closed.some((rule) => rule.action === 'missing')) report.guidance.push('閉じる届くはずの報告が見つからない取引先があります。Claude と相談してください');
    report.guidance.push(...skippedGuidance(runs));
    report.outcome = 'complete';
    persist();
    const measured = runs.filter((run) => run.status === 'measured');
    say('');
    const unmeasured = runs.filter((run) => run.status === 'registered-unmeasured').length;
    say(`測った回 ${measured.length}・飛ばした回 ${runs.filter((run) => ['done', 'overlap', 'blocked'].includes(run.status)).length}・部分 ${runs.filter((run) => run.status === 'partial').length}${unmeasured ? `・登録済みで計測は途中まで ${unmeasured}` : ''}`);
    for (const run of measured) say(`${tag(run)}: ①→④ ${ms(run.result.marks.m4)}・①→⑥ ${ms(run.result.marks.m6)}・①→⑦ ${ms(run.result.marks.m7)} ms・反映 ${reflectedCount(run.result)}/6・即時 ${yesNo(run.result.forecastImmediate)}`);
    for (const rule of closed) say(`届くはずの報告 ${rule.partnerCode}: ${rule.action === 'closed' ? `${rule.lastMonth} で閉じた` : rule.action === 'already-closed' ? `${rule.lastMonth} で閉じてあった` : '見つからない'}`);
    for (const line of report.guidance) say(line);
    say(`結果: ${outputs.json}`);
    say(`      ${outputs.md}`);
    return report;
  } catch (error) {
    // この起動で測り始めた回があれば「途中で止めた」（終了コード 1。回のあいだでトークンの残りが切れたときも）、無ければ「始める前に止めた」（2）
    const started = runs.some((run) => run.startedAt && !run.carriedFrom);
    if (report.outcome === 'started') report.outcome = started ? 'stopped' : 'stopped-before-run';
    if (!report.guidance.length) report.guidance.push(redactor.text(error.message));
    try { persist(); } catch { /* 結果を書けないときも、元の誤りを返す */ }
    if (error instanceof MeasureStop) throw new MeasureStop(redactor.text(error.message), started ? 1 : error.exitCode);
    throw new MeasureStop(redactor.text(`止まりました: ${error.message}`), started ? 1 : 2);
  }
}

export function parseArgs(argv) {
  const args = {url: null, checkOnly: false, plan: null, months: null, only: null, partnerA: SOURCES.a.partnerCode, partnerB: SOURCES.b.partnerCode,
    rows: 2000, works: 20, asOf: '2026-09-30', outDir: null, json: null, md: null, previous: [], stopAfter: null};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next == null || next.startsWith('--')) throw new MeasureStop(`${name} の値がありません`);
      index += 1;
      return next;
    };
    if (name === '--url') args.url = value();
    else if (name === '--check-only') args.checkOnly = true;
    else if (name === '--plan') args.plan = value();
    else if (name === '--months') args.months = value();
    else if (name === '--only') args.only = value();
    else if (name === '--partner-a') args.partnerA = value();
    else if (name === '--partner-b') args.partnerB = value();
    else if (name === '--rows') args.rows = Number(value());
    else if (name === '--works') args.works = Number(value());
    else if (name === '--as-of') args.asOf = value();
    else if (name === '--out-dir') args.outDir = value();
    else if (name === '--json') args.json = value();
    else if (name === '--md') args.md = value();
    else if (name === '--previous') args.previous.push(value());
    else if (name === '--stop-after') args.stopAfter = Number(value());
    else throw new MeasureStop(`知らない指定です: ${name}`);
  }
  if (!args.url) throw new MeasureStop('--url が要ります（例: --url https://staging.example.invalid。既定値は置かない）');
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    await runMeasurement({...args, token: process.env[TOKEN_ENV] || null});
  } catch (error) {
    // 誤りの文は runMeasurement の中で伏せてある。スタックは出さない（値が混ざらないように）
    console.error(error instanceof MeasureStop ? error.message : createRedactor().text(`止まりました: ${error?.message}`));
    process.exitCode = error instanceof MeasureStop ? error.exitCode : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
