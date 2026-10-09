#!/usr/bin/env node
// 閲覧用プレビュー（記録した応答で動く静的な版）を作る。サーバーなしで、任意のパスに置いて開ける（index.html＋assets＋preview-data.json）。
// 使い方:
//   PLAYWRIGHT_MODULE_PATH=<playwright-core の場所> node scripts/build-preview.mjs --db <架空データのSQLite> --user <架空メール(.invalid)>
//     [--org <組織コードかID>] [--out dist-preview] [--works all|<数>] [--depth 2] [--max-pages 1500] [--now <ISO日時>] [--no-public] [--keep-temp]
//   --works: 作品を選んで使う画面を、何本の作品で開くか（既定 all）。--no-public: public/（デモ資料・操作デモ動画）を入れない
// 流れ: DB を一時フォルダへ写す（元の DB は読むだけ）→ 通常の画面を一時フォルダへビルド → アプリをこのプロセスで起動してログイン →
//   Playwright で全画面・帳票センターの全帳票・ロイヤリティ（権利者・期間・報告書）・委員会月次収支（委員会の作品ごと）を開き、
//   画面内のリンク（?p=…）をたどり（深さの上限つき）、タブを押して、GET /api の応答をすべて記録 →
//   提案資料（基準×月・SVOD）・放送ウィンドウ提案（全作品）・PL・BS と売上集計シート（前の年度）も開き、
//   保存しない照合の元（src/preview/computed-posts.mjs）と、放送アベイルズリストの Excel（放送履歴表の作品すべて）も記録 →
//   vite build --mode preview → preview-data.json を書く。合計の大きさと記録した応答の数を表示する。
// ・巡回中の GET 以外は通さない（プレビューと同じ「保存できません」を返す）。記録はプレビューで利用者が見るものと同じになる。
// ・ログインできるのは .invalid の架空メールだけ（ローカルログインの制約）。所属の一覧・組織ごとの機能の判定は記録する組織だけに絞る。
//   記録に .invalid・.example・.test 以外のメールアドレスが入っていれば書き出さずに止める。
// ・playwright は package.json に入れない。PLAYWRIGHT_MODULE_PATH（または --playwright）で場所を渡す。
import {createRequire} from 'node:module';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, extname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {encodeRecord, isApiPath, readOnlyResponse, snapshotKey, sortedQuery, splitPreviewData, PREVIEW_DATA_FILE} from '../src/preview/snapshot-client.mjs';
import {navItems, hiddenPagesForRole, pageOfSlug, pageScope, slugOf} from '../src/shell/nav-model.mjs';
import {REPORT_CATALOG} from '../src/reports/report-catalog.mjs';
import {PROPOSAL_BASES, shiftMonth} from '../src/sales-ops/release-proposal-model.mjs';
import {PREVIEW_COMPUTED_SOURCES} from '../src/preview/computed-posts.mjs';
import {fiscalSettingFrom, fiscalYearOf, fiscalYearRange} from '../src/ui/condition-model.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FILE_LIMIT_BYTES = 16_000_000;
export const MAX_FILES = 255;
// 画面にある <a href="/api/..." download>（Excel・CSV）を記録する数の上限
export const API_LINK_LIMIT = 800;
// 提案資料（月別）は、既定の月（翌月）の前1か月〜後5か月を基準ごとに開く（前月・翌月のボタンで移れる範囲）
export const PROPOSAL_MONTHS_BEFORE = 1;
export const PROPOSAL_MONTHS_AFTER = 5;
// 画面が条件しだいで読む GET で、いつも記録に入れておくもの。組織ごとの機能の判定（デモ資料・売上集計シートの「組織を切り替えて…」の案内）は、
// 今の組織に香盤のデモがあり売上集計シートも採用済みなら画面が読まないが、記録には入れておく（restrictOrgs で記録する組織だけに絞る）
export const PREVIEW_ALWAYS_GETS = Object.freeze(['/api/session/org-features']);
const ALLOWED_EMAIL_TLDS = ['.invalid', '.example', '.test', '.localhost'];

export function parseArgs(argv) {
  const options = {out: null, works: 'all', depth: 2, maxPages: 1500, keepTemp: false, headed: false, quietMs: 350, allowEmailDomains: [], publicFiles: true};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} の値を指定してください`);
      i += 1;
      return next;
    };
    if (arg === '--db') options.db = value();
    else if (arg === '--user') options.user = value();
    else if (arg === '--org') options.org = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--works') options.works = value();
    else if (arg === '--depth') options.depth = Number(value());
    else if (arg === '--max-pages') options.maxPages = Number(value());
    else if (arg === '--now') options.now = value();
    else if (arg === '--quiet-ms') options.quietMs = Number(value());
    else if (arg === '--playwright') options.playwright = value();
    else if (arg === '--allow-email-domain') options.allowEmailDomains.push(value().toLowerCase());
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--no-public') options.publicFiles = false;
    else if (arg === '--headed') options.headed = true;
    else throw new Error(`知らない指定です: ${arg}`);
  }
  if (!options.db) throw new Error('架空データの DB を --db で指定してください');
  if (!options.user) throw new Error('記録に使う架空メンバーを --user で指定してください（.invalid のメール）');
  if (!/^[^@\s]+@[^@\s]+\.invalid$/i.test(options.user)) throw new Error('--user は .invalid の架空メールだけです');
  if (options.works !== 'all' && !(Number.isInteger(Number(options.works)) && Number(options.works) > 0)) throw new Error('--works は all か1以上の数です');
  for (const key of ['depth', 'maxPages', 'quietMs']) if (!Number.isInteger(options[key]) || options[key] < 0) throw new Error(`--${key} は0以上の整数です`);
  if (options.now && !Number.isFinite(Date.parse(options.now))) throw new Error('--now は ISO 形式の日時です（例: 2026-09-25T12:00:00+09:00）');
  return options;
}

// 画面の URL（?p=…）を、並べ替えた問い合わせにそろえる。p が無ければ null
export function normalizeLocation(search) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (!params.get('p')) return null;
  for (const [key, value] of [...params]) if (value === '') params.delete(key);
  return `?${sortedQuery(params)}`;
}

// 画面内のリンクを巡回先にする。作品の指定が無いリンクは、アプリの移動と同じく今の作品を引き継ぐ。
// 作品を選ばない画面（会社全体・管理）へのリンクで作品の指定が無いものは、最初の作品にそろえる（同じ画面を作品の数だけ開かない）
export function resolveLink(href, {currentSearch = '', firstWorkId = null} = {}) {
  const text = String(href || '');
  let search;
  if (text.startsWith('?')) search = text;
  else {
    try {
      const url = new URL(text, 'http://preview.invalid/');
      if (url.origin !== 'http://preview.invalid' || url.pathname !== '/' || !url.search) return null;
      search = url.search;
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  const slug = params.get('p');
  if (!slug || !pageOfSlug(slug)) return null;
  if (!params.get('work')) {
    const page = pageOfSlug(slug);
    const current = new URLSearchParams(String(currentSearch).replace(/^\?/, '')).get('work');
    const work = pageScope(page) === 'work' ? current || firstWorkId : firstWorkId || current;
    if (work) params.set('work', String(work));
  }
  return normalizeLocation(`?${params}`);
}

const locationOf = (params) => normalizeLocation(`?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`);

// 最初に開く画面の一覧。works は作品（{id}）、role はログインした人の役割、extra は API から数えた権利者・報告書・委員会の作品
export function seedLocations({works = [], role = 'admin', worksLimit = 'all', year, extra = {}} = {}) {
  const hidden = hiddenPagesForRole(role);
  const firstWork = works[0]?.id ?? null;
  const picked = worksLimit === 'all' ? works : works.slice(0, Number(worksLimit));
  const seeds = [];
  const add = (label, params) => {
    const search = locationOf(params);
    if (search) seeds.push({label, search});
  };
  for (const item of navItems()) {
    if (hidden.has(item.page) || item.redirect || item.hidden) continue;
    if (item.scope === 'work' && picked.length) for (const work of picked) add(`画面:${item.label}`, {p: item.slug, work: work.id});
    else add(`画面:${item.label}`, {p: item.slug, work: firstWork});
  }
  if (!hidden.has('帳票センター')) {
    const years = Number.isInteger(year) ? [year - 1, year - 2] : [];
    for (const report of REPORT_CATALOG) {
      add(`帳票:${report.label}`, {p: slugOf('帳票センター'), report: report.id, work: firstWork});
      if (['annual', 'annual-dashboard', 'work-pnl', 'mg-sales', 'royalty-ledger', 'committee-monthly'].includes(report.component)) {
        for (const fy of years) add(`帳票:${report.label}（${fy}年度）`, {p: slugOf('帳票センター'), report: report.id, fy, work: firstWork});
      }
    }
  }
  const {holders = [], statements = [], periods = [], agreements = [], committeeWorks = [], proposalDefaultMonth = null} = extra;
  if (!hidden.has('ロイヤリティ作成')) {
    for (const holder of holders.slice(0, 4)) {
      add('ロイヤリティ作成（権利者）', {p: slugOf('ロイヤリティ作成'), holder: holder.id, work: firstWork});
      add('ロイヤリティ集計（権利者）', {p: slugOf('ロイヤリティ集計'), holder: holder.id, work: firstWork});
      add('ロイヤリティ報告書（権利者）', {p: slugOf('ロイヤリティ報告書'), holder: holder.id, work: firstWork});
    }
    for (const statement of statements.slice(0, 6)) {
      add('ロイヤリティ報告書（確定版）', {p: slugOf('ロイヤリティ報告書'), statement: statement.id, work: firstWork});
      add('帳票:ロイヤリティ報告書（確定版）', {p: slugOf('帳票センター'), report: 'royalty-cycle', holder: statement.holderId, close: statement.closeMonth, statement: statement.id, work: firstWork});
    }
    for (const period of periods.filter((row) => !row.statementId).slice(0, 4)) {
      add('帳票:ロイヤリティ報告書（下書き）', {p: slugOf('帳票センター'), report: 'royalty-cycle', holder: period.holderId, close: period.closeMonth, work: firstWork});
      add('ロイヤリティ報告書（下書き）', {p: slugOf('ロイヤリティ報告書'), holder: period.holderId, close: period.closeMonth, work: firstWork});
    }
    for (const agreement of agreements.slice(0, 6)) add('ロイヤリティ契約', {p: slugOf('ロイヤリティ契約'), agreement: agreement.id, work: firstWork});
  }
  if (!hidden.has('委員会月次収支')) {
    const years = Number.isInteger(year) ? [year - 1, year - 2] : [];
    for (const work of committeeWorks) {
      add(`委員会月次収支:${work.title}`, {p: slugOf('委員会月次収支'), workId: work.id, work: firstWork});
      for (const fy of years) add(`委員会月次収支:${work.title}（${fy}年度）`, {p: slugOf('委員会月次収支'), workId: work.id, fy, work: firstWork});
    }
  }
  // 営業基幹の提案資料: SVOD のタブと、月別の基準ごとに既定の月の前後（ボタンで移れる範囲）と、既定の月の「確定だけ」
  if (!hidden.has('提案資料')) {
    add('提案資料（SVOD）', {p: slugOf('提案資料'), pptab: 'svod', work: firstWork});
    if (proposalDefaultMonth) {
      for (const basis of PROPOSAL_BASES) {
        const ppbasis = basis.key === PROPOSAL_BASES[0].key ? null : basis.key;
        for (let n = -PROPOSAL_MONTHS_BEFORE; n <= PROPOSAL_MONTHS_AFTER; n += 1) {
          add(`提案資料:${basis.label}`, {p: slugOf('提案資料'), ppbasis, ppmonth: shiftMonth(proposalDefaultMonth, n), work: firstWork});
        }
        add(`提案資料:${basis.label}（確定だけ）`, {p: slugOf('提案資料'), ppbasis, ppmonth: proposalDefaultMonth, ppstatus: 'confirmed', work: firstWork});
      }
    }
  }
  // 番販・放送の放送ウィンドウ提案を全作品で（作品ごとの提案はタブを押して記録する）
  if (!hidden.has('番販・放送')) add('番販・放送:放送ウィンドウ提案（全作品）', {p: slugOf('番販・放送'), tab: 'proposals', bpscope: 'all', work: firstWork});
  // 取引先別リストは全部のリストを開く（明細の一覧と Excel のひな形のリンクを記録する。明細の履歴・放送の条件は detailApiUrls で足す）
  if (!hidden.has('取引先別リスト')) {
    for (const list of extra.partnerLists || []) add(`取引先別リスト:${list.name}`, {p: slugOf('取引先別リスト'), plpartner: list.partner_id, pllist: list.id, work: firstWork});
  }
  // PL・BS と売上集計シートは前の年度も（架空データの売上は前の年度まで）
  const pastYears = Number.isInteger(year) ? [year - 1, year - 2] : [];
  for (const page of ['PL・BS', '売上集計シート']) {
    if (hidden.has(page)) continue;
    for (const fy of pastYears) add(`${page}（${fy}年度）`, {p: slugOf(page), fy, work: firstWork});
  }
  const unique = new Map();
  for (const seed of seeds) if (!unique.has(seed.search)) unique.set(seed.search, seed);
  return [...unique.values()];
}

// 同梱のライブラリ（XML の名前に使える文字の範囲など）は U+FFFD をそのままの文字で出す。公開先によっては
// この文字を文字化けとみなして受け付けないため、同じ意味のエスケープ \uFFFD に置き換える（識別子には現れない字なので意味は変わらない）
export function escapeReplacementChars(dir) {
  if (!existsSync(dir)) return 0;
  let replaced = 0;
  for (const name of readdirSync(dir).filter((file) => /\.m?js$/.test(file))) {
    const file = join(dir, name);
    const text = readFileSync(file, 'utf8');
    if (!text.includes('\uFFFD')) continue;
    replaced += text.split('\uFFFD').length - 1;
    writeFileSync(file, text.replaceAll('\uFFFD', '\\uFFFD'));
  }
  return replaced;
}

// 記録に入ったメールアドレスのうち、架空のドメイン（.invalid など）でないもの。ドメインだけを返す（アドレスは表示しない）
export function foreignEmailDomains(responses, allowDomains = []) {
  const found = new Set();
  const pattern = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
  const fileLike = /\.(png|jpe?g|gif|svg|webp|css|m?js|json|csv|xlsx|pdf|html?)$/;
  for (const record of responses.values()) {
    if (record.encoding === 'base64') continue;
    const text = typeof record.body === 'string' ? record.body : JSON.stringify(record.body ?? null);
    for (const match of text.matchAll(pattern)) {
      const domain = match[1].toLowerCase();
      if (fileLike.test(domain) || ALLOWED_EMAIL_TLDS.some((tld) => domain.endsWith(tld)) || allowDomains.includes(domain)) continue;
      found.add(domain);
    }
  }
  return [...found].sort();
}

// 所属の一覧（/api/session/orgs）と組織ごとの機能の判定（/api/session/org-features）を、記録する組織だけにする
// （ほかの組織の名前をプレビューに出さない。デモ資料の「組織を切り替えて…」の案内も出さない）
export function restrictOrgs(responses) {
  const key = 'GET /api/session/orgs';
  const record = responses.get(key);
  if (record && record.body && Array.isArray(record.body.orgs)) {
    const current = record.body.currentOrgId;
    responses.set(key, {...record, body: {...record.body, orgs: record.body.orgs.filter((org) => org.id === current)}});
  }
  const featuresKey = 'GET /api/session/org-features';
  const features = responses.get(featuresKey);
  if (features && features.body && typeof features.body === 'object') {
    const current = features.body.currentOrgId;
    const body = {...features.body};
    for (const name of ['koubanDemo', 'salesSheet']) if (Array.isArray(body[name])) body[name] = body[name].filter((org) => org.id === current);
    responses.set(featuresKey, {...features, body});
  }
}

// 記録した放送履歴表（GET /api/broadcast/history?…）から、「放送履歴表に出ている作品をすべて入れる」ときの放送アベイルズリストの Excel の URL。
// 画面の既定と同じく、基準日は記録した日（日本時間）
export function availsExportUrls(responses, asOf) {
  const urls = new Set();
  for (const [key, entry] of responses) {
    if (!key.startsWith('GET /api/broadcast/history?') || entry.status !== 200) continue;
    const ids = (entry.body?.rows || []).map((row) => row.work_id).filter((id) => Number.isInteger(id));
    if (ids.length) urls.add(`/api/broadcast/availability-list/export.xlsx?${new URLSearchParams({asOf, workIds: ids.join(',')})}`);
  }
  return [...urls];
}

// 行を押したときにだけ読む応答（巡回では発行されない）の URL。記録した一覧から組み立てる:
// PL・BS の作品別の残高の委員会作品 → 出資と払込、取引先別リストの明細 → 明細の履歴（放送の明細は放送の条件も）
export function detailApiUrls(responses) {
  const urls = new Set();
  for (const [key, entry] of responses) {
    if (entry.status !== 200) continue;
    if (key.startsWith('GET /api/reports/pl-bs?')) {
      for (const row of entry.body?.workBalances || []) if (row.kind === 'committee' && Number.isInteger(row.workId)) urls.add(`/api/committee-investments?workId=${row.workId}`);
    }
    if (/^GET \/api\/partner-lists\/\d+\/entries\?/.test(key)) {
      for (const row of entry.body?.entries || []) {
        if (!Number.isInteger(row.entry_id)) continue;
        urls.add(`/api/partner-list-entries/${row.entry_id}/history`);
        if (row.distribution_name === '放送') urls.add(`/api/partner-list-entries/${row.entry_id}/broadcast-terms`);
      }
    }
  }
  return [...urls];
}

// 全表の定義と追加列は、リンク件数の上限で切らない必須の記録。
// 売上は画面で記録した基本列の年度条件を引き継ぎ、最新年度の案内も同じ期首設定でたどる。
export function requiredPreviewApiUrls(responses) {
  const urls = new Set();
  const tables = responses.get('GET /api/admin/tables');
  if (tables?.status === 200) {
    for (const table of tables.body?.tables || []) urls.add(`/api/admin/tables/${encodeURIComponent(table.name)}/definition`);
  }
  for(const [key,entry] of responses){
    if(entry.status!==200||!key.startsWith('GET /api/expense-sheet?'))continue;
    const q=new URLSearchParams(key.slice(key.indexOf('?')+1)),asOf=q.get('asOf');if(!asOf)continue;
    for(const path of ['expense-sheet/access','expense-sheet/options','expense-accounting/settings','expense-cards','expense-invoices','expense-imports','expense-imports/holds','expense-pending','expense-withholding-remittances','expense-card-debits','expense-refund-receipts'])urls.add('/api/'+path);
    if(responses.get('GET /api/expense-sheet/access')?.body?.admin)urls.add('/api/expense-accounting/adoption-preview');
    for(const set of ['basic','legacy','accounting','payout']){const p=new URLSearchParams(q);p.set('set',set);for(let page=1;page<=Math.max(1,Math.ceil((entry.body?.total??0)/100));page++){p.set('page',page);p.set('pageSize',100);urls.add('/api/expense-sheet?'+sortedQuery(p));}}
    for(const groupBy of ['partner','closing'])urls.add('/api/expense-payouts?'+sortedQuery(new URLSearchParams({groupBy,asOf})));
    urls.add('/api/expense-accounting/balances?asOf='+asOf);urls.add('/api/expense-journal?to='+asOf);
    for(const row of entry.body?.rows??[])urls.add(`/api/expense-sheet/${row.id}?asOf=${asOf}`);
  }
  const invoiceList=responses.get('GET /api/expense-invoices');if(invoiceList?.status===200)for(const row of invoiceList.body?.rows??[])urls.add('/api/expense-invoices/'+row.id);
  const batches=responses.get('GET /api/expense-imports');if(batches?.status===200)for(const row of batches.body?.rows??[])urls.add('/api/expense-imports/'+row.id);
  const fiscal = responses.get('GET /api/settings/fiscal');
  const {fiscalStartMonth} = fiscalSettingFrom(fiscal?.status === 200 ? fiscal.body : null);
  for (const [key, entry] of responses) {
    if (!key.startsWith('GET /api/sales-sheet?') || entry.status !== 200 || !entry.body?.adopted) continue;
    const params = new URLSearchParams(key.slice(key.indexOf('?') + 1));
    // 単独画面の既定条件だけ。作品別・保存した形・集計等の条件を混ぜない。
    if (params.get('set') !== 'basic' || [...params.keys()].some((name) => !['from', 'to', 'set'].includes(name))) continue;
    const periods = [params];
    const latestYear = fiscalYearOf(entry.body.latestMonth, fiscalStartMonth);
    if (Number.isInteger(latestYear)) periods.push(new URLSearchParams({...fiscalYearRange(latestYear, fiscalStartMonth), set: 'basic'}));
    for (const period of periods) {
      for (const set of ['basic', 'additional', 'all_plus']) {
        const query = new URLSearchParams(period);
        query.set('set', set);
        urls.add(`/api/sales-sheet?${sortedQuery(query)}`);
      }
    }
  }
  return [...urls];
}

// 必須の記録は取得失敗・エラー応答を成功扱いにしない。通常の API リンクと同じ GET 経路を使う。
export async function recordRequiredPreviewApis(responses, get) {
  await get('/api/admin/tables');
  if (responses.get('GET /api/admin/tables')?.status !== 200 || !Array.isArray(responses.get('GET /api/admin/tables')?.body?.tables)) {
    throw new Error('データ一覧の表一覧を記録できませんでした');
  }
  const urls=[];let pending=requiredPreviewApiUrls(responses);
  while(pending.length){for(const href of pending){const key=snapshotKey('GET',href);if(!responses.has(key))await get(href);if(responses.get(key)?.status!==200)throw new Error(`必須のプレビュー応答を記録できませんでした: ${href}`);urls.push(href);}
    const done=new Set(urls);pending=requiredPreviewApiUrls(responses).filter(href=>!done.has(href));
  }
  return urls;
}

const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.srt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'};
export const mimeOf = (file) => MIME[extname(file).toLowerCase()] || 'application/octet-stream';

export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({path: relative(dir, full).split(sep).join('/'), bytes: statSync(full).size});
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// 書き出し先。既定はアプリの dist-preview。vite が中身を消してから書くので、前回のプレビュー以外が入ったフォルダには書かない
export function outDirOf(out) {
  return out ? resolve(out) : resolve(appRoot, 'dist-preview');
}

export function checkOutDir(outDir) {
  const target = resolve(outDir);
  const inside = (parent) => target === parent || parent.startsWith(target + sep);
  if (dirname(target) === target || inside(appRoot) || inside(resolve(appRoot, 'src')) || inside(tmpdir())) throw new Error(`書き出し先に使えないフォルダです: ${target}`);
  if (!existsSync(target)) return;
  if (!statSync(target).isDirectory()) throw new Error(`書き出し先がファイルです: ${target}`);
  const entries = readdirSync(target);
  if (entries.length && !(entries.includes('index.html') && entries.includes(PREVIEW_DATA_FILE))) {
    throw new Error(`書き出し先に前回のプレビュー以外のものがあります（中身を消すため書き出しません）: ${target}`);
  }
}

const mb = (bytes) => `${(bytes / 1_000_000).toFixed(2)} MB`;

function copyDatabase(source, target) {
  try {
    const db = new DatabaseSync(source, {readOnly: true});
    try { db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); } finally { db.close(); }
  } catch {
    copyFileSync(source, target);
    for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix);
  }
}

function loadPlaywright(path) {
  const location = path || process.env.PLAYWRIGHT_MODULE_PATH;
  if (!location) throw new Error('playwright-core の場所を環境変数 PLAYWRIGHT_MODULE_PATH（または --playwright）で指定してください');
  return createRequire(import.meta.url)(resolve(location));
}

function cookieValue(setCookie, name) {
  const match = new RegExp(`(?:^|[;,]\\s*)${name}=([^;]*)`).exec(String(setCookie || ''));
  return match ? match[1] : null;
}

function jstYear(iso) {
  return Number(new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 4));
}

export function jstDate(iso) {
  return new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function buildPreview(options, log = console.log) {
  const startedAt = Date.now();
  const recordedAt = new Date(options.now ? Date.parse(options.now) : Date.now()).toISOString();
  const dbPath = resolve(options.db);
  if (!existsSync(dbPath)) throw new Error(`DB が見つかりません: ${dbPath}`);
  const outDir = outDirOf(options.out);
  checkOutDir(outDir);
  const {chromium} = loadPlaywright(options.playwright);
  const temp = mkdtempSync(join(tmpdir(), 'on-preview-'));
  const tempDb = join(temp, 'preview.sqlite');
  const uiDir = join(temp, 'ui');
  const {build} = await import('vite');
  const {serve} = await import('@hono/node-server');
  const {LocalDatabase} = await import('../src/db.mjs');
  const {createApp} = await import('../src/app.mjs');
  let server = null;
  let browser = null;
  let db = null;
  try {
    copyDatabase(dbPath, tempDb);
    log(`DB を一時フォルダへ写しました（元の DB は変えません）: ${tempDb}`);
    await import(pathToFileURL(resolve(appRoot, 'scripts/prepare-test-assets.mjs')).href);
    const configFile = resolve(appRoot, 'vite.config.mjs');
    await build({root: appRoot, configFile, mode: 'production', logLevel: 'error', build: {outDir: uiDir, emptyOutDir: true, sourcemap: false}});
    log('記録用に通常の画面をビルドしました');

    db = new LocalDatabase(tempDb);
    const app = createApp({db, mode: 'local'});
    const responses = new Map();
    const variants = new Set();  // 同じ問い合わせで内容が変わった鍵（時刻を含む応答など）
    const blocked = [];
    const tracker = {inflight: 0, last: Date.now(), count: 0, page: ''};
    const record = async (url, response) => {
      const key = snapshotKey('GET', url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const entry = encodeRecord({status: response.status, contentType: response.headers.get('content-type') || '', bytes, disposition: response.headers.get('content-disposition') || ''});
      if (!responses.has(key)) responses.set(key, entry);
      else if (JSON.stringify(responses.get(key)) !== JSON.stringify(entry)) variants.add(key);
    };
    const serveUi = (pathname) => {
      let file = resolve(uiDir, decodeURIComponent(pathname).replace(/^\/+/, ''));
      if (!file.startsWith(uiDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(uiDir, 'index.html');
      const cache = /[\\/]assets[\\/]/.test(file) ? 'public, max-age=3600' : 'no-store';
      return new Response(readFileSync(file), {headers: {'content-type': mimeOf(file), 'cache-control': cache}});
    };
    const handle = async (request) => {
      const url = new URL(request.url);
      if (!isApiPath(url.pathname)) return serveUi(url.pathname);
      tracker.inflight += 1;
      tracker.count += 1;
      tracker.last = Date.now();
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          blocked.push({method: request.method, path: url.pathname, page: tracker.page});
          return readOnlyResponse();
        }
        const response = await app.fetch(request);
        if (request.method === 'GET') await record(url, response.clone());
        return response;
      } finally {
        tracker.inflight -= 1;
        tracker.last = Date.now();
      }
    };
    const port = await new Promise((resolvePort, reject) => {
      server = serve({fetch: handle, hostname: '127.0.0.1', port: 0}, (info) => resolvePort(info.port));
      server.on?.('error', reject);
    });
    const origin = `http://127.0.0.1:${port}`;

    // ログイン（アプリの API を直接呼ぶ。記録には入れない）
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: options.user})});
    const loginBody = await login.json();
    if (!login.ok) throw new Error(`ログインできません（${options.user}）: ${loginBody.error || login.status}`);
    const cookies = {on_session: cookieValue(login.headers.get('set-cookie'), 'on_session')};
    const header = () => Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
    const call = async (path, init = {}) => {
      const response = await app.request(`/api${path}`, {...init, headers: {cookie: header(), 'content-type': 'application/json', ...(init.headers || {})}});
      const body = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(`${path}: ${body?.error || response.status}`), {status: response.status});
      return body;
    };
    if (options.org) {
      const {orgs} = await call('/session/orgs');
      const target = orgs.find((org) => String(org.id) === String(options.org) || String(org.code) === String(options.org));
      if (!target) throw new Error(`${options.user} は組織 ${options.org} に所属していません`);
      const switched = await app.request('/api/session/org', {method: 'POST', headers: {cookie: header(), 'content-type': 'application/json'}, body: JSON.stringify({orgId: target.id})});
      if (!switched.ok) throw new Error(`組織を切り替えられません: ${(await switched.json()).error}`);
      cookies.on_org = cookieValue(switched.headers.get('set-cookie'), 'on_org');
    }
    const {user} = await call('/session');
    const {orgs = [], currentOrgId} = await call('/session/orgs');
    const org = orgs.find((row) => row.id === currentOrgId) || {id: currentOrgId};
    log(`記録する組織: ${org.name || '名称未確認'}（${org.code || org.id}）・${user.displayName}（${user.role}）`);
    const bootstrap = await call('/bootstrap');
    const works = bootstrap.works || [];
    const optional = async (path, pick) => { try { return pick(await call(path)); } catch { return []; } };
    const extra = user.role === 'production' ? {} : {
      holders: await optional('/royalty/agreements', (body) => body.holders || []),
      agreements: await optional('/royalty/agreements', (body) => body.agreements || []),
      statements: await optional('/royalty/statements?includeVoided=1', (body) => body.statements || []),
      periods: await optional('/royalty/periods', (body) => body.periods || []),
      committeeWorks: await optional('/reports/committee-monthly/works', (body) => body.works || []),
      proposalDefaultMonth: (await optional('/release-proposals?status=all', (body) => [body.defaultMonth]))[0] || null,
      partnerLists: await optional(`/partner-lists?asOf=${jstDate(recordedAt)}&soonDays=30`, (body) => body.lists || []),
    };
    const seeds = seedLocations({works, role: user.role, worksLimit: options.works, year: jstYear(recordedAt), extra});
    log(`作品 ${works.length}本・権利者 ${extra.holders?.length ?? 0}者・確定版 ${extra.statements?.length ?? 0}件・委員会の作品 ${extra.committeeWorks?.length ?? 0}本。最初に開く画面 ${seeds.length}件`);

    browser = await chromium.launch({headless: !options.headed});
    const context = await browser.newContext({locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: {width: 1440, height: 900}, serviceWorkers: 'block'});
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    await context.addCookies(Object.entries(cookies).filter(([, value]) => value).map(([name, value]) => ({name, value, url: origin})));
    // 見る人ごとの保存（最後に開いた画面・表の列の幅など）を持ち越さない。プレビューを初めて開いた人と同じ状態で記録する
    await context.addInitScript(() => { try { window.localStorage.clear(); } catch { /* 保存できない環境 */ } });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(recordedAt));
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    context.on('page', (popup) => { if (popup !== page) popup.close().catch(() => {}); });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push({page: tracker.page, message: String(error?.message || error).slice(0, 200)}));

    const settle = async ({expectRequest = false} = {}) => {
      const begin = Date.now();
      const before = tracker.count;
      for (;;) {
        await sleep(60);
        const waited = Date.now() - begin;
        if (expectRequest && tracker.count === before && waited < 4000) continue;
        if (tracker.inflight === 0 && Date.now() - tracker.last >= options.quietMs) return true;
        if (waited > 20000) return false;
      }
    };

    const seen = new Set();
    const queued = new Set();
    const queue = [];
    const apiLinks = new Set();
    const firstWorkId = works[0]?.id ?? null;
    const enqueue = (search, depth, label) => {
      if (!search || seen.has(search) || queued.has(search) || depth > options.depth) return;
      queued.add(search);
      queue.push({search, depth, label});
    };
    for (const seed of seeds) enqueue(seed.search, 0, seed.label);
    const harvest = async (depth) => {
      const hrefs = await page.$$eval('a[href]', (anchors) => anchors.map((anchor) => anchor.getAttribute('href') || '')).catch(() => []);
      const currentSearch = new URL(page.url()).search;
      for (const href of hrefs) {
        if (href.startsWith('/api/')) apiLinks.add(href);
        else enqueue(resolveLink(href, {currentSearch, firstWorkId}), depth + 1, 'リンク');
      }
    };
    let clicks = 0;
    const clickTabs = async (depth) => {
      const done = new Set();
      for (let n = 0; n < 40; n += 1) {
        const tabs = await page.$$eval('#app-main [role="tab"]', (elements) => elements.map((element, index) => ({
          index,
          id: `${element.closest('[role="tablist"]')?.getAttribute('aria-label') || ''}|${(element.textContent || '').replace(/[0-9０-９,，]+/g, '#').trim()}`,
          selected: element.getAttribute('aria-selected') === 'true',
          disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
          visible: element.getClientRects().length > 0,
        }))).catch(() => []);
        for (const tab of tabs) if (tab.selected) done.add(tab.id);
        const next = tabs.find((tab) => !tab.selected && !tab.disabled && tab.visible && !done.has(tab.id));
        if (!next) return;
        done.add(next.id);
        const moved = await page.locator('#app-main [role="tab"]').nth(next.index).click({timeout: 5000}).then(() => true, () => false);
        if (!moved) continue;
        clicks += 1;
        await settle();
        const now = normalizeLocation(new URL(page.url()).search);
        if (now) seen.add(now);
        await harvest(depth);
      }
    };

    let visited = 0;
    while (queue.length && visited < options.maxPages) {
      const entry = queue.shift();
      queued.delete(entry.search);
      if (seen.has(entry.search)) continue;
      seen.add(entry.search);
      tracker.page = entry.search;
      tracker.last = Date.now();
      const loaded = await page.goto(`${origin}/${entry.search}`, {waitUntil: 'load', timeout: 30000}).then(() => true, (error) => {
        pageErrors.push({page: entry.search, message: `開けません: ${String(error?.message || error).slice(0, 160)}`});
        return false;
      });
      if (!loaded) continue;
      await settle({expectRequest: true});
      visited += 1;
      const landed = normalizeLocation(new URL(page.url()).search);
      if (landed) seen.add(landed);
      await harvest(entry.depth);
      await clickTabs(entry.depth);
      if (visited % 25 === 0) log(`  ${visited}画面（残り ${queue.length}）・タブ ${clicks}回・応答 ${responses.size}件・${Math.round((Date.now() - startedAt) / 1000)}秒`);
    }
    if (queue.length) log(`上限（--max-pages ${options.maxPages}）に達したため、${queue.length}件の画面は開いていません`);
    // 台本の取込の「保存済み原本」は選択肢から開くのでリンクが無い。記録した一覧から原本ごとの応答を足す
    for (const [key, entry] of responses) {
      if (!key.startsWith('GET /api/workflow/scripts?') || entry.status !== 200) continue;
      for (const row of entry.body?.rows || []) apiLinks.add(`/api/workflow/scripts/${row.id}`);
    }
    let fetchedLinks = 0;
    const requiredLinks = new Set(await recordRequiredPreviewApis(responses, async (href) => {
      tracker.page = href;
      await context.request.get(`${origin}${href}`);
      fetchedLinks += 1;
    }));
    // いつも記録する GET、保存しない照合の元（画面は POST で読むので、プレビューはこの GET から組み立てる）、放送アベイルズリストの Excel
    // （上限で切れないよう先に並べる）
    const links = [...new Set([...PREVIEW_ALWAYS_GETS, ...PREVIEW_COMPUTED_SOURCES, ...availsExportUrls(responses, jstDate(recordedAt)), ...detailApiUrls(responses), ...apiLinks])].filter((href) => !requiredLinks.has(href));
    if (links.length > API_LINK_LIMIT) log(`API のリンクが ${links.length}件あり、上限 ${API_LINK_LIMIT}件までを記録します`);
    for (const href of links.slice(0, API_LINK_LIMIT)) {
      tracker.page = href;
      await context.request.get(`${origin}${href}`).then(() => { fetchedLinks += 1; }, () => {});
    }
    await browser.close();
    browser = null;
    await new Promise((done) => server.close(() => done()));
    server = null;

    restrictOrgs(responses);
    const unauthorized = [...responses].filter(([, entry]) => entry.status === 401).map(([key]) => key);
    if (unauthorized.length) throw new Error(`ログインが切れた応答を記録しました（${unauthorized.length}件。例: ${unauthorized[0]}）。記録し直してください`);
    const foreign = foreignEmailDomains(responses, options.allowEmailDomains);
    if (foreign.length) throw new Error(`架空でないメールのドメインが記録に入っています（${foreign.join('、')}）。架空データの DB で記録してください`);

    await build({root: appRoot, configFile, mode: 'preview', logLevel: 'error', build: {outDir, emptyOutDir: true, copyPublicDir: options.publicFiles}});
    escapeReplacementChars(join(outDir, 'assets'));
    const meta = {recordedAt, timeZone: 'Asia/Tokyo', org: {code: org.code ?? null, name: org.name ?? null}, user: {displayName: user.displayName, role: user.role},
      pages: visited, generator: 'scripts/build-preview.mjs'};
    const {index, parts} = splitPreviewData(meta, responses, {limitBytes: FILE_LIMIT_BYTES - 64 * 1024});
    writeFileSync(join(outDir, PREVIEW_DATA_FILE), index);
    for (const part of parts) writeFileSync(join(outDir, part.name), part.text);

    const files = listFiles(outDir);
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    const largest = files.reduce((max, file) => (file.bytes > max.bytes ? file : max), {bytes: 0, path: ''});
    const oversized = files.filter((file) => file.bytes >= FILE_LIMIT_BYTES);
    if (oversized.length) throw new Error(`16MB 以上のファイルがあります: ${oversized.map((file) => `${file.path}（${mb(file.bytes)}）`).join('、')}`);
    if (files.length > MAX_FILES) throw new Error(`ファイルが ${files.length}個あります（上限 ${MAX_FILES}）`);
    const dataBytes = files.filter((file) => /^preview-data(-\d+)?\.json$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0);
    const byStatus = {};
    for (const entry of responses.values()) byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    const blockedPaths = [...new Set(blocked.map((row) => `${row.method} ${row.path}`))];
    const summary = {
      out: outDir, recordedAt, responses: responses.size, byStatus, pages: visited, tabClicks: clicks, apiLinks: fetchedLinks,
      files: files.length, totalBytes: total, dataBytes, dataFiles: 1 + parts.length, largest,
      blocked: blockedPaths, variants: variants.size, pageErrors, seconds: Math.round((Date.now() - startedAt) / 1000),
    };
    log(`記録した応答: ${responses.size}件（${Object.entries(byStatus).map(([status, count]) => `${status}: ${count}`).join('・')}）`);
    log(`開いた画面: ${visited}件・タブ ${clicks}回・APIのリンク ${fetchedLinks}件・${summary.seconds}秒`);
    log(`出力: ${outDir}（ファイル ${files.length}個・合計 ${mb(total)}・データ ${mb(dataBytes)}／${summary.dataFiles}ファイル・最大 ${largest.path} ${mb(largest.bytes)}）`);
    if (blockedPaths.length) log(`開いただけで保存（GET 以外）を送った画面があります（プレビューでは「保存できません」になります）: ${blockedPaths.slice(0, 8).join('、')}${blockedPaths.length > 8 ? ' ほか' : ''}`);
    if (variants.size) log(`同じ問い合わせで内容が変わった応答が ${variants.size}件あります（最初の応答を使います）: ${[...variants].slice(0, 6).join('、')}${variants.size > 6 ? ' ほか' : ''}`);
    if (pageErrors.length) log(`画面のエラー ${pageErrors.length}件: ${pageErrors.slice(0, 5).map((row) => `${row.page} ${row.message}`).join(' ／ ')}`);
    return summary;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((done) => server.close(() => done()));
    try { db?.close(); } catch { /* 閉じ済み */ }
    if (!options.keepTemp) rmSync(temp, {recursive: true, force: true, maxRetries: 3});
    else log(`一時フォルダを残しました: ${temp}`);
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  buildPreview(options).then(() => process.exit(0), (error) => {
    console.error(`プレビューを作れませんでした: ${error.message}`);
    process.exit(1);
  });
}
