#!/usr/bin/env node
// 閲覧用プレビュー（scripts/build-preview.mjs の出力）を、サーバーなしの静的な置き場所と同じ条件で開いて確かめる。
// 使い方: PLAYWRIGHT_MODULE_PATH=<playwright-core の場所> node scripts/verify-preview.mjs [--dir dist-preview] [--base /preview/] [--port 9171] [--shots <画面の保存先>]
// ・小さな静的サーバーで --dir を --base（任意のパス）の下に置く。/api などそれ以外は 404（API を持たない）。
// ・確かめること: 帯が出る・ログイン画面を通らない・画面にデータが出る・メニューとURL（?p=）での移動・帳票を開く・
//   Excel をブラウザの中で作って保存できる・保存の操作に「プレビューでは保存できません」・記録の無い表示に「含まれていない表示です」・
//   ブラウザから /api へ通信しない。2026-09-26 に足した画面（提案資料・放送履歴表・アベイルズリスト・放送ウィンドウ提案・PL・BS・
//   売上集計シート・デモ資料の組織判定）も開く。ファイルの数と大きさも表示する。
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync, mkdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {listFiles, mimeOf, FILE_LIMIT_BYTES, requiredPreviewApiUrls} from './build-preview.mjs';
import {PREVIEW_BANNER_TEXT, PREVIEW_MISSING_MESSAGE, PREVIEW_READ_ONLY_MESSAGE, snapshotKey} from '../src/preview/snapshot-client.mjs';
import {ADDITIONAL_SHEET_COLUMNS} from '../src/sales-sheet/column-registry.mjs';
import {fiscalSettingFrom, fiscalYearOf} from '../src/ui/condition-model.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {dir: resolve(appRoot, 'dist-preview'), base: '/preview/', port: 9171, shots: null};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`${arg} の値を指定してください`);
    if (arg === '--dir') options.dir = resolve(next);
    else if (arg === '--base') options.base = `/${next.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
    else if (arg === '--port') options.port = Number(next);
    else if (arg === '--shots') options.shots = resolve(next);
    else if (arg === '--playwright') options.playwright = next;
    else throw new Error(`知らない指定です: ${arg}`);
    i += 1;
  }
  return options;
}

// base の下だけを返す静的サーバー。ディレクトリは index.html。API も SPA の転送も持たない
export function startStaticServer({dir, base, port}) {
  const root = resolve(dir);
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    if (!url.pathname.startsWith(base)) {
      response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'}).end('not found');
      return;
    }
    let file = resolve(root, decodeURIComponent(url.pathname.slice(base.length)) || '.');
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'}).end('not found');
      return;
    }
    response.writeHead(200, {'content-type': mimeOf(file), 'cache-control': 'no-store'}).end(readFileSync(file));
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done({server, requests, origin: `http://127.0.0.1:${server.address().port}`}));
  });
}

// zip（xlsx）の終わりの目録（EOCD）が指す中央ディレクトリの位置と大きさが、ファイルの中で合っているか。
// 文字として保存して壊れた xlsx は先頭の PK が残っても長さが変わるので、ここで見分けられる
export function zipLooksIntact(bytes) {
  if (!bytes || bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at -= 1) {
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === 0x05 && bytes[at + 3] === 0x06) {
      const size = bytes.readUInt32LE(at + 12), offset = bytes.readUInt32LE(at + 16);
      return offset + size === at;
    }
  }
  return false;
}

export async function verifyPreview(options, log = console.log) {
  if (!existsSync(join(options.dir, 'index.html')) || !existsSync(join(options.dir, 'preview-data.json'))) throw new Error(`${options.dir} にプレビュー（index.html と preview-data.json）がありません`);
  const location = options.playwright || process.env.PLAYWRIGHT_MODULE_PATH;
  if (!location) throw new Error('playwright-core の場所を環境変数 PLAYWRIGHT_MODULE_PATH（または --playwright）で指定してください');
  const {chromium} = createRequire(import.meta.url)(resolve(location));
  const files = listFiles(options.dir);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const largest = files.reduce((max, file) => (file.bytes > max.bytes ? file : max), {bytes: 0, path: ''});
  const data = files.filter((file) => /^preview-data(-\d+)?\.json$/.test(file.path));
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({name, ok: Boolean(ok), detail});
    log(`${ok ? '○' : '×'} ${name}${detail ? `（${detail}）` : ''}`);
  };
  check('どのファイルも16,000,000バイト未満', files.every((file) => file.bytes < FILE_LIMIT_BYTES), `${files.length}個・合計 ${(total / 1_000_000).toFixed(2)} MB・最大 ${largest.path} ${largest.bytes}バイト・データ ${data.map((file) => `${file.path} ${file.bytes}バイト`).join('、')}`);

  const {server, requests, origin} = await startStaticServer(options);
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext({locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: {width: 1440, height: 900}, acceptDownloads: true});
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)); });
    page.on('pageerror', (error) => consoleErrors.push(String(error?.message || error).slice(0, 200)));
    const home = `${origin}${options.base}`;
    const shot = async (name) => {
      if (!options.shots) return;
      mkdirSync(options.shots, {recursive: true});
      await page.screenshot({path: join(options.shots, `${name}.png`), fullPage: false});
    };
    const heading = () => page.locator('#app-main h1').first().textContent().catch(() => '');
    const gridRows = (scope = page) => scope.locator('#app-main [role="row"], #app-main tbody tr').count();

    await page.goto(home, {waitUntil: 'load'});
    await page.getByText(PREVIEW_BANNER_TEXT).waitFor({timeout: 15000}).catch(() => {});
    check('帯「閲覧用のプレビュー（架空データ・保存はできません）」が出る', await page.getByText(PREVIEW_BANNER_TEXT).isVisible().catch(() => false));
    await page.locator('#app-main').waitFor({timeout: 15000}).catch(() => {});
    check('ログイン画面を通らずに、記録した利用者で開く', await page.locator('#app-main').isVisible().catch(() => false) && !(await page.getByText('ローカルで参加').isVisible().catch(() => false)),
      `見出し「${(await heading())?.trim()}」・URL ${page.url().replace(origin, '')}`);
    check('サブパスの下で URL（?p=）を持つ', page.url().startsWith(`${home}?p=`), page.url().replace(origin, ''));
    await shot('01-home');

    // メニューで売上基幹 → ロイヤリティへ移る
    await page.getByRole('tab', {name: '売上基幹'}).click();
    await page.getByRole('tab', {name: 'ロイヤリティ'}).click();
    await page.waitForURL(/p=royalty-periods/, {timeout: 10000}).catch(() => {});
    await page.waitForTimeout(600);
    const royaltyRows = await gridRows();
    check('メニューの移動（売上基幹 → ロイヤリティ）で画面とURLが変わり、データが出る', /p=royalty-periods/.test(page.url()) && royaltyRows > 1, `${(await heading())?.trim()}・行 ${royaltyRows}`);
    await shot('02-royalty-periods');

    // 帳票センターの帳票を URL で開く（再読み込み・ブックマークと同じ）→ Excel をブラウザの中で作って保存する
    await page.goto(`${home}?p=report-center&report=annual-sales`, {waitUntil: 'load'});
    await page.getByRole('button', {name: 'Excel', exact: true}).first().waitFor({timeout: 15000}).catch(() => {});
    await page.waitForTimeout(600);
    const reportRows = await gridRows();
    const reportText = (await page.locator('#app-main').innerText().catch(() => '')) || '';
    const total = /期間計\s+(￥[0-9,]+)/.exec(reportText)?.[1] || '';
    check('帳票（年間売上）をURLで開くとデータが出る', reportRows >= 1 && /￥[1-9]/.test(total) && !reportText.includes(PREVIEW_MISSING_MESSAGE), `期間計 ${total || 'なし'}・行 ${reportRows}`);
    await shot('03-report-annual-sales');
    const downloadPromise = page.waitForEvent('download', {timeout: 15000});
    await page.getByRole('button', {name: 'Excel', exact: true}).first().click();
    const download = await downloadPromise.catch(() => null);
    let excel = '';
    if (download) {
      const path = await download.path();
      const bytes = path ? readFileSync(path) : Buffer.alloc(0);
      excel = `${download.suggestedFilename()}・${bytes.length}バイト`;
      check('Excel を保存できる（ブラウザの中で作る・中身は xlsx）', bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b && /\.xlsx$/.test(download.suggestedFilename()), excel);
    } else check('Excel を保存できる（ブラウザの中で作る・中身は xlsx）', false, 'ダウンロードが始まりません');

    // 委員会月次収支（委員会の作品があれば）
    await page.goto(`${home}?p=committee-monthly`, {waitUntil: 'load'});
    await page.waitForTimeout(1200);
    const committeeRows = await gridRows();
    const committeeText = (await page.locator('#app-main').textContent().catch(() => '')) || '';
    check('委員会月次収支を開ける（記録の無い表示の知らせが出ない）', !committeeText.includes(PREVIEW_MISSING_MESSAGE), `行 ${committeeRows}`);
    await shot('04-committee-monthly');

    // 香盤（架空の連続ドラマ・2話持ち）。記録に作品 DEMO-D78 があるときだけ確かめる
    const recorded = Object.assign({}, ...data.map((file) => JSON.parse(readFileSync(join(options.dir, file.path), 'utf8')).responses || {}));
    const drama = (recorded['GET /api/bootstrap']?.body?.works || []).find((work) => work.code === 'DEMO-D78');
    if (drama) {
      await page.goto(`${home}?p=production&work=${drama.id}&tab=kouban`, {waitUntil: 'load'});
      await page.locator('#app-main table.production-matrix').waitFor({timeout: 15000}).catch(() => {});
      const scenes = await page.locator('#app-main .production-scene-open').allInnerTexts().catch(() => []);
      check('香盤（架空の連続ドラマ・2話持ち）に第7話・第8話のシーンが撮影日ごとに出る', scenes.some((text) => text.startsWith('S#7-')) && scenes.some((text) => text.startsWith('S#8-')), `シーン ${scenes.length}件`);
      await shot('04b-kouban');
      await page.goto(`${home}?p=script&work=${drama.id}`, {waitUntil: 'load'});
      const history = page.getByRole('combobox', {name: /保存済み原本/});
      await history.waitFor({timeout: 10000}).catch(() => {});
      const labels = await history.locator('option').allInnerTexts().catch(() => []);
      const draft = labels.find((text) => text.includes('ep08-junbi'));
      if (draft) await history.selectOption({label: draft}).catch(() => {});
      await page.getByText(/文字化けの疑い/).first().waitFor({timeout: 10000}).catch(() => {});
      const opened = await page.getByText(/文字化けの疑い/).first().isVisible().catch(() => false);
      check('台本の取込で保存済みの原本（第8話の準備稿）を開ける', opened && !(await page.getByText(PREVIEW_MISSING_MESSAGE).first().isVisible().catch(() => false)), labels.filter((text) => text.includes('fukurodo')).join('・'));
      await shot('04c-script');
    } else check('香盤（架空の連続ドラマ・2話持ち）に第7話・第8話のシーンが撮影日ごとに出る', true, 'この記録には作品 DEMO-D78 がありません（確認を省略）');

    // 保存の操作 → 日本語の知らせ
    await page.goto(`${home}?p=partners`, {waitUntil: 'load'});
    await page.getByRole('button', {name: /＋取引先を登録/}).click({timeout: 15000});
    await page.getByRole('textbox', {name: /取引先コード/}).fill('DEMO-PREVIEW');
    await page.getByRole('textbox', {name: /^名称/}).fill('架空の取引先（プレビュー確認）');
    const kind = page.getByRole('combobox', {name: /^種類/});
    if (await kind.count()) await kind.first().selectOption({index: 1}).catch(() => {});
    await page.getByRole('button', {name: '登録', exact: true}).click();
    await page.getByText(PREVIEW_READ_ONLY_MESSAGE).first().waitFor({timeout: 10000}).catch(() => {});
    check('保存すると「プレビューでは保存できません（閲覧専用・架空データ）」が出る', await page.getByText(PREVIEW_READ_ONLY_MESSAGE).first().isVisible().catch(() => false));
    await shot('05-save-blocked');

    // 記録の無い表示
    await page.goto(`${home}?p=royalty-periods&asOf=2020-01-01`, {waitUntil: 'load'});
    await page.getByText(PREVIEW_MISSING_MESSAGE).first().waitFor({timeout: 10000}).catch(() => {});
    check('記録に無い条件で開くと「このプレビューに含まれていない表示です」が出る', await page.getByText(PREVIEW_MISSING_MESSAGE).first().isVisible().catch(() => false));
    await shot('06-missing');

    // 戻る（履歴）でも画面が戻る
    await page.goBack({waitUntil: 'load'});
    await page.waitForTimeout(800);
    check('ブラウザの「戻る」で前の画面に戻る', /p=partners/.test(page.url()), page.url().replace(origin, ''));

    // <a href="/api/..." download>（番販の Excel）は記録した内容を保存する。タブの中にあれば順に開いて探す
    await page.goto(`${home}?p=broadcast`, {waitUntil: 'load'});
    await page.waitForTimeout(800);
    let apiLink = page.locator('#app-main a[href^="/api/"][download]').first();
    const tabCount = await page.locator('#app-main [role="tab"]').count();
    for (let i = 0; i < tabCount && !(await apiLink.isVisible().catch(() => false)); i += 1) {
      await page.locator('#app-main [role="tab"]').nth(i).click().catch(() => {});
      await page.waitForTimeout(500);
      apiLink = page.locator('#app-main a[href^="/api/"][download]').first();
    }
    if (await apiLink.isVisible().catch(() => false)) {
      const href = await apiLink.getAttribute('href');
      const pending = page.waitForEvent('download', {timeout: 10000});
      await apiLink.click();
      const file = await pending.catch(() => null);
      const bytes = file && (await file.path()) ? readFileSync(await file.path()) : Buffer.alloc(0);
      const intact = !/\.xlsx$/.test(file?.suggestedFilename() || '') || zipLooksIntact(bytes);
      check('API のダウンロードリンク（番販のExcelなど）は記録した内容を保存する（xlsx は壊れていない）', bytes.length > 0 && intact, `${href}・${file?.suggestedFilename() || 'なし'}・${bytes.length}バイト${intact ? '' : '・xlsx が壊れている'}`);
    } else check('API のダウンロードリンク（番販のExcelなど）は記録した内容を保存する', true, 'この記録には該当するリンクがありません（確認を省略）');

    // / から始まる静的ファイルのリンク（デモ資料）は、置き場所からの相対に直して開く
    await page.goto(`${home}?p=demo`, {waitUntil: 'load'});
    const fixture = page.locator('#app-main a[href^="/demo-fixtures/"][download]').first();
    await fixture.waitFor({timeout: 10000}).catch(() => {});
    if (await fixture.isVisible().catch(() => false)) {
      const pending = page.waitForEvent('download', {timeout: 10000});
      await fixture.click();
      const file = await pending.catch(() => null);
      const bytes = file && (await file.path()) ? readFileSync(await file.path()) : Buffer.alloc(0);
      check('デモ資料のリンク（/demo-fixtures/…）は置き場所の下から保存する', bytes.length > 0 && file.url().startsWith(`${home}demo-fixtures/`), `${file?.url().replace(origin, '') || 'なし'}・${bytes.length}バイト`);
    } else check('デモ資料のリンク（/demo-fixtures/…）は置き場所の下から保存する', false, 'リンクが見つかりません');

    // ---- 2026-09-26 に足した画面（提案資料・放送履歴表・アベイルズ・放送ウィンドウ提案・PL・BS・売上集計シート・デモ資料の組織判定）----
    const indexMeta = JSON.parse(readFileSync(join(options.dir, 'preview-data.json'), 'utf8'));
    const recordedYear = Number(new Date(Date.parse(indexMeta.recordedAt) + 9 * 3600 * 1000).toISOString().slice(0, 4));
    const mainText = async () => (await page.locator('#app-main').innerText().catch(() => '')) || '';
    const saveLink = async (locator) => {
      const pending = page.waitForEvent('download', {timeout: 10000});
      await locator.click();
      const file = await pending.catch(() => null);
      const bytes = file && (await file.path()) ? readFileSync(await file.path()) : Buffer.alloc(0);
      return {name: file?.suggestedFilename() || '', bytes, intact: bytes.length > 1000 && zipLooksIntact(bytes)};
    };
    const wait = (ms = 900) => page.waitForTimeout(ms);

    // 営業基幹 › 提案資料（月別）: 表が出て、基準を変えても記録があり、Excel（記録した内容）を保存できる
    await page.goto(`${home}?p=proposals`, {waitUntil: 'load'});
    await page.getByRole('heading', {name: '月別の提案資料'}).waitFor({timeout: 15000}).catch(() => {});
    await wait();
    const proposalRows = await gridRows();
    const proposalExcel = await saveLink(page.getByRole('link', {name: 'Excelで出力'}).first()).catch(() => ({intact: false, name: '', bytes: []}));
    await page.getByRole('button', {name: /^TVOD基準/}).click().catch(() => {});
    await wait();
    const tvodText = await mainText();
    const tvodRows = await gridRows();
    check('提案資料（月別）: 表が出て、基準を TVOD に変えても記録があり、Excel を保存できる',
      proposalRows >= 1 && tvodRows >= 1 && tvodText.includes('TVOD基準・') && !tvodText.includes(PREVIEW_MISSING_MESSAGE) && proposalExcel.intact && /^提案資料_.+\.xlsx$/.test(proposalExcel.name),
      `PVOD 行 ${proposalRows}・TVOD 行 ${tvodRows}・${proposalExcel.name} ${proposalExcel.bytes.length}バイト`);
    await shot('07-proposals');
    await page.goto(`${home}?p=proposals&pptab=svod`, {waitUntil: 'load'});
    await page.getByRole('heading', {name: 'SVOD の提案資料'}).waitFor({timeout: 15000}).catch(() => {});
    await wait();
    const svodText = await mainText();
    check('提案資料（SVOD）: 継続・新規・注意の表と提案金額が出る', (await gridRows()) > 1 && /提案金額|合計/.test(svodText) && !svodText.includes(PREVIEW_MISSING_MESSAGE), `行 ${await gridRows()}`);

    // 番販・放送 › 放送履歴表: 全作品×年月の表に赤・黄のセルがあり、Excel を保存できる
    await page.goto(`${home}?p=broadcast`, {waitUntil: 'load'});
    await page.locator('#app-main table.bw-matrix').waitFor({timeout: 15000}).catch(() => {});
    const historyRows = await page.locator('#app-main table.bw-matrix tbody tr').count();
    const colored = await page.locator('#app-main table.bw-matrix td.is-red, #app-main table.bw-matrix td.is-yellow').count();
    const historyExcel = await saveLink(page.getByRole('link', {name: 'Excelで出力（全件）'})).catch(() => ({intact: false, name: '', bytes: []}));
    check('放送履歴表: 全作品×年月の表に赤・黄のセルがあり、Excel（全件）を保存できる', historyRows > 1 && colored > 0 && historyExcel.intact,
      `作品 ${historyRows}行・色つきのセル ${colored}・${historyExcel.name} ${historyExcel.bytes.length}バイト`);
    await shot('08-broadcast-history');

    // 放送アベイルズリスト: 放送履歴表の作品をすべて入れて Excel を保存できる。作品名の照合は記録からブラウザの中で行う（保存できないとは出さない）
    await page.getByText('放送アベイルズリストを作る', {exact: true}).first().click().catch(() => {});
    await page.getByRole('button', {name: /放送履歴表に出ている作品をすべて入れる/}).click().catch(() => {});
    const availsExcel = await saveLink(page.getByRole('link', {name: /放送アベイルズリストを Excel で出力/})).catch(() => ({intact: false, name: '', bytes: []}));
    await page.getByLabel(/作品名・作品コード・品番を1行に1つ/).fill('DEMO-W01\nDEMO-W02\n存在しない作品（架空）').catch(() => {});
    await page.getByRole('button', {name: '照合する'}).click().catch(() => {});
    const matchStatus = page.getByText(/^照合の結果:/);
    await matchStatus.waitFor({timeout: 10000}).catch(() => {});
    const matchText = (await matchStatus.textContent().catch(() => '')) || '';
    check('放送アベイルズリスト: 作品名を照合でき（一致2・見つからない1）、放送履歴表の作品すべての Excel を保存できる',
      /一致 2件/.test(matchText) && /見つからない 1件/.test(matchText) && !(await page.getByText(PREVIEW_READ_ONLY_MESSAGE).first().isVisible().catch(() => false)) && availsExcel.intact,
      `${matchText.slice(0, 60)}・${availsExcel.name} ${availsExcel.bytes.length}バイト`);
    await shot('09-avails');

    // 放送ウィンドウ提案（全作品）
    await page.goto(`${home}?p=broadcast&tab=proposals&bpscope=all`, {waitUntil: 'load'});
    await wait(1500);
    const proposalText = await mainText();
    check('放送ウィンドウ提案（全作品）: 作品・商品ごとの提案が出る', (await gridRows()) > 1 && !proposalText.includes(PREVIEW_MISSING_MESSAGE), `行 ${await gridRows()}`);
    // 提案から作った下書きの一覧も記録から出る（下書きを作る・削除するのはほかの保存と同じく「保存できません」になる）
    const draftCounts = /下書き \d+件・申請中〜確定 \d+件・(?:差し戻し \d+件・)?(?:中止 \d+件・)?削除した下書き \d+件/.exec(proposalText)?.[0] || '';
    const draftRows = await page.getByRole('table', {name: '提案から作った下書きの一覧', exact: true}).locator('tbody > tr[data-pos]').count().catch(() => 0);
    check('放送ウィンドウ提案: 提案から作った下書きの一覧が記録から出る', Boolean(draftCounts) && draftRows > 0 && !proposalText.includes(PREVIEW_MISSING_MESSAGE),
      `${draftCounts || '一覧なし'}・行 ${draftRows}`);
    await shot('10-window-proposals');

    // PL・BS（前の年度）: 帯「管理会計の試算」、会社BSの最後に説明のつかない差額
    await page.goto(`${home}?p=pl-bs&fy=${recordedYear - 1}`, {waitUntil: 'load'});
    await page.getByText(/管理会計の試算/).first().waitFor({timeout: 15000}).catch(() => {});
    const plRows = await gridRows();
    await page.getByRole('tab', {name: '会社BS'}).click().catch(() => {});
    await wait();
    const bsText = await mainText();
    check(`PL・BS（${recordedYear - 1}年度）: 作品別PLが出て、会社BSの最後に「説明のつかない差額」`, plRows > 1 && bsText.includes('説明のつかない差額') && !bsText.includes(PREVIEW_MISSING_MESSAGE), `作品別PL 行 ${plRows}`);
    await shot('11-pl-bs');
    check('PL・BS: カード未払・前払金・源泉預り金の行が出る',['未払金（カード）','前払金','預り金（源泉）'].every(label=>bsText.includes(label)),bsText.includes(PREVIEW_MISSING_MESSAGE)?'応答なし':'新しいBSの行');

    // 行を押したときにだけ読む応答: PL・BS の作品別の残高の委員会作品 → 出資と払込（記録が無いと「含まれていない表示」になる）
    await page.goto(`${home}?p=pl-bs&fy=${recordedYear - 1}&plbsTab=work-balances`, {waitUntil: 'load'});
    await page.getByText(/管理会計の試算/).first().waitFor({timeout: 15000}).catch(() => {});
    const committeeRow = page.locator('#app-main tbody tr').filter({hasText: '委員会作品'}).first();
    if (await committeeRow.count()) {
      await committeeRow.click().catch(() => {});
      await page.getByRole('table', {name: '出資と払込'}).waitFor({timeout: 10000}).catch(() => {});
      const investmentRows = await page.getByRole('table', {name: '出資と払込'}).locator('tbody tr').count().catch(() => 0);
      const investmentText = await mainText();
      check('PL・BS の作品別の残高で委員会作品の行を押すと、出資と払込の表が出る（記録がある）', investmentRows >= 1 && !investmentText.includes(PREVIEW_MISSING_MESSAGE), `行 ${investmentRows}`);
    } else check('PL・BS の作品別の残高で委員会作品の行を押すと、出資と払込の表が出る（記録がある）', true, 'この記録には委員会作品がありません（確認を省略）');

    // 取引先別リストの放送の明細を開くと、明細の履歴と放送の条件（許諾放送回数・ホールドバック）が出る
    const broadcastList = Object.entries(recorded).map(([key, value]) => ({match: /^GET \/api\/partner-lists\/(\d+)\/entries\?/.exec(key), value}))
      .find(({match, value}) => match && (value.body?.entries || []).some((entry) => entry.distribution_name === '放送'));
    if (broadcastList) {
      const listId = Number(broadcastList.match[1]);
      const entry = broadcastList.value.body.entries.find((row) => row.distribution_name === '放送');
      const partnerId = broadcastList.value.body.list?.partner_id ?? entry.partner_id;
      await page.goto(`${home}?p=partner-lists&plpartner=${partnerId}&pllist=${listId}`, {waitUntil: 'load'});
      await wait(1200);
      await page.locator('#app-main tbody tr').filter({hasText: entry.work_code || ''}).first().click().catch(() => {});
      await page.getByText('放送の条件（許諾放送回数・ホールドバック）').first().waitFor({timeout: 10000}).catch(() => {});
      const termsText = await mainText();
      check('取引先別リストで放送の明細を開くと、放送の条件（許諾放送回数・ホールドバック）が出る（記録がある）',
        termsText.includes('放送の条件（許諾放送回数・ホールドバック）') && !termsText.includes(PREVIEW_MISSING_MESSAGE), `リスト ${listId}・明細 ${entry.entry_id}`);
    } else check('取引先別リストで放送の明細を開くと、放送の条件（許諾放送回数・ホールドバック）が出る（記録がある）', true, 'この記録には放送の明細がありません（確認を省略）');

    await page.goto(`${home}?p=expense-sheet`,{waitUntil:'load'});await wait(1200);
    const expenseTable=page.getByRole('table',{name:'経費集計シート',exact:true});
    const headers=await expenseTable.getByRole('columnheader').allTextContents();
    check('経費集計シート: 基本25列の見出し',headers.length===25&&['締め日','出金予定日','出金日'].every(label=>headers.some(h=>h.includes(label))),headers.join('・'));
    const expenseTabs=page.getByRole('group',{name:'経費の業務'});
    await expenseTabs.getByRole('button',{name:'出金予定',exact:true}).click();await wait();
    const payoutRows=await page.getByRole('table',{name:'出金予定の明細',exact:true}).locator('tbody tr').count();
    check('経費の出金予定に行が出る',payoutRows>0&&!(await mainText()).includes(PREVIEW_MISSING_MESSAGE),`行 ${payoutRows}`);
    await expenseTabs.getByRole('button',{name:'会計の設定',exact:true}).click();await wait();
    check('会計の設定に費用区分が出る',(await mainText()).includes('版1')&&!(await mainText()).includes(PREVIEW_MISSING_MESSAGE),'費用区分の版');
    await expenseTabs.getByRole('button',{name:'仕訳の見え方',exact:true}).click();await wait();
    check('仕訳の見え方に借方・貸方合計が出る',(await mainText()).includes('借方合計')&&!(await mainText()).includes(PREVIEW_MISSING_MESSAGE),'保存しない仕訳表示');
    await shot('11-expense-sheet');

    // 売上集計シート（単独の画面・前の年度）
    await page.goto(`${home}?p=sales-sheet&fy=${recordedYear - 1}`, {waitUntil: 'load'});
    await page.getByRole('heading', {name: '売上集計シート', level: 1}).waitFor({timeout: 15000}).catch(() => {});
    await wait(1200);
    const sheetText = await mainText();
    check(`売上集計シート（単独の画面・${recordedYear - 1}年度）: 表が出る`, (await gridRows()) > 1 && !sheetText.includes(PREVIEW_MISSING_MESSAGE), `行 ${await gridRows()}`);
    await shot('12-sales-sheet');

    // 依頼5: 全表の定義が記録され、既存表・追加表とも定義の列と型を画面で読める。
    const recordedMap = new Map(Object.entries(recorded));
    const required = requiredPreviewApiUrls(recordedMap);
    const missingRequired = required.filter((href) => recorded[snapshotKey('GET', href)]?.status !== 200);
    check('全表の定義と売上の追加列の必要な応答が記録されている',
      recorded['GET /api/admin/tables']?.body?.tables?.length > 0 && missingRequired.length === 0,
      `${required.length}件・欠落 ${missingRequired.length}件 ${missingRequired.slice(0, 3).join('、')}`);
    for (const [table, column] of [['works', 'code'], ['work_master_profile_versions', 'production_category']]) {
      await page.goto(`${home}?p=data&table=${table}`, {waitUntil: 'load'});
      const definition = page.getByRole('region', {name: `表 ${table}`, exact: true});
      await definition.locator('th[data-key="type"]').waitFor({timeout: 15000}).catch(() => {});
      const text = await definition.innerText().catch(() => '');
      check(`データ一覧: ${table} を開くと表の定義が出る`,
        await definition.getByRole('button', {name: '表の定義', exact: true}).getAttribute('aria-pressed').catch(() => '') === 'true'
        && text.includes(column) && text.includes('TEXT') && text.includes('外部キー') && !text.includes(PREVIEW_MISSING_MESSAGE));
    }
    await shot('12b-table-definition');

    // 既定年度と最新年度の両方で、実際に列セットのボタンを選ぶ。
    const {fiscalStartMonth} = fiscalSettingFrom(recorded['GET /api/settings/fiscal']?.body);
    const latestYears = new Set(Object.entries(recorded).filter(([key, entry]) => key.startsWith('GET /api/sales-sheet?')
      && entry.status === 200 && new URLSearchParams(key.split('?')[1]).get('set') === 'basic'
      && [...new URLSearchParams(key.split('?')[1]).keys()].every((key) => ['from', 'to', 'set'].includes(key)))
      .map(([, entry]) => fiscalYearOf(entry.body?.latestMonth, fiscalStartMonth)).filter(Number.isInteger));
    for (const fy of [null, ...latestYears]) {
      await page.goto(`${home}?p=sales-sheet${fy === null ? '' : `&fy=${fy}`}`, {waitUntil: 'load'});
      for (const label of ['追加の列', '全列＋追加']) {
        const button = page.getByRole('group', {name: '列セット', exact: true}).getByRole('button', {name: new RegExp(`^${label.replace('+', '\\+')}`)});
        const clicked = await button.click({timeout: 15000}).then(() => true, () => false);
        await wait();
        const headers = await page.getByRole('table', {name: /^売上集計シート/}).first().locator('th').allInnerTexts();
        const additional = ADDITIONAL_SHEET_COLUMNS.filter((column) => headers.some((text) => text.includes(column.label)));
        const text = await mainText();
        const emptyDefault = fy === null && text.includes('この条件の売上明細はありません');
        check(`売上集計シート（${fy === null ? '既定年度' : `${fy}年度`}）: 「${label}」で追加の列が出る（既定年度の0件は空表示）`,
          clicked && await button.getAttribute('aria-pressed').catch(() => '') === 'true' && (additional.length > 0 || emptyDefault) && !text.includes(PREVIEW_MISSING_MESSAGE),
          `追加の見出し ${additional.length}列`);
      }
    }
    await shot('12c-sales-additional');

    // デモ資料: 表示中の組織が出て、ほかの組織の名前（組織を切り替えての案内）は出さない
    const features = recorded['GET /api/session/org-features']?.body;
    const otherOrgs = features ? [...(features.koubanDemo || []), ...(features.salesSheet || [])].filter((org) => org.id !== features.currentOrgId) : [];
    await page.goto(`${home}?p=demo`, {waitUntil: 'load'});
    await page.getByText(/表示中の組織/).first().waitFor({timeout: 10000}).catch(() => {});
    const demoText = await mainText();
    check('デモ資料: 表示中の組織が出て、組織の判定の記録はこの組織だけ（ほかの組織の名前・切替の案内を出さない）',
      Boolean(features) && otherOrgs.length === 0 && /表示中の組織: \S/.test(demoText) && !demoText.includes('組織を切り替えて'), (demoText.match(/表示中の組織: [^。]*/) || [''])[0]);
    await shot('13-demo');

    // 別の日に開いても、記録した日を「今日」として表示する（基準日を既定にする画面が記録に当たる）
    const later = await context.newPage();
    await later.clock.setFixedTime(new Date('2027-01-15T10:00:00+09:00'));
    await later.goto(`${home}?p=royalty-periods`, {waitUntil: 'load'});
    await later.waitForTimeout(1200);
    const laterText = (await later.locator('#app-main').innerText().catch(() => '')) || '';
    const asOf = await later.getByLabel('基準日').inputValue().catch(() => '');
    check('別の日（2027-01-15）に開いても記録した日の表示になる', !laterText.includes(PREVIEW_MISSING_MESSAGE) && (await later.locator('#app-main tbody tr').count()) > 1, `基準日 ${asOf}`);
    await later.close();

    const apiRequests = requests.filter((path) => path.startsWith('/api'));
    check('ブラウザから /api へ通信しない（すべて記録から返す）', apiRequests.length === 0, apiRequests.slice(0, 3).join('、'));
    const outside = requests.filter((path) => !path.startsWith(options.base) && !path.startsWith('/api') && path !== '/favicon.ico');
    check(`置き場所（${options.base}）の外のファイルを読まない`, outside.length === 0, outside.slice(0, 3).join('、'));
    const errors = consoleErrors.filter((text) => !/Failed to load resource/.test(text));
    check('画面のエラーが出ない', errors.length === 0, errors.slice(0, 3).join(' ／ '));
  } finally {
    await browser.close();
    await new Promise((done) => server.close(() => done()));
  }
  const failed = checks.filter((item) => !item.ok);
  log(failed.length ? `確認: ${checks.length - failed.length}／${checks.length} 件が通りました` : `確認: ${checks.length}件すべて通りました`);
  return {checks, failed: failed.length, files: files.length, totalBytes: total};
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
  verifyPreview(options).then((result) => process.exit(result.failed ? 1 : 0), (error) => {
    console.error(`確かめられませんでした: ${error.message}`);
    process.exit(1);
  });
}
