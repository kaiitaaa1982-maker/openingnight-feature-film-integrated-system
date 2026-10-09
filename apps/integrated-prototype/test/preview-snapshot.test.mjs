import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createApi, describeError, errorNotice, isApiError} from '../src/ui/api-client.mjs';
import {
  createSnapshotFetch, downloadName, encodeRecord, isApiPath, mergePreviewData, responseFromRecord, snapshotKey, sortedQuery, splitPreviewData,
  PREVIEW_DATA_FORMAT, PREVIEW_DATA_VERSION, PREVIEW_MISSING_MESSAGE, PREVIEW_READ_ONLY_MESSAGE,
} from '../src/preview/snapshot-client.mjs';
import {installPreviewClock} from '../src/preview/preview-clock.mjs';
import {PREVIEW_COMPUTED_POSTS, PREVIEW_COMPUTED_SOURCES} from '../src/preview/computed-posts.mjs';
import {availsMatchResult} from '../src/broadcast/avails-list-model.mjs';

const encode = (text) => new TextEncoder().encode(text);

test('プレビューの鍵: メソッド＋パス＋並べ替えた問い合わせ。並び順・相対／絶対・大小文字によらず同じ鍵', () => {
  assert.equal(snapshotKey('get', '/api/royalty/periods?holderId=3&asOf=2026-09-25'), 'GET /api/royalty/periods?asOf=2026-09-25&holderId=3');
  assert.equal(snapshotKey('GET', '/api/royalty/periods?asOf=2026-09-25&holderId=3'), snapshotKey('GET', 'http://127.0.0.1:9171/api/royalty/periods?holderId=3&asOf=2026-09-25'));
  assert.equal(snapshotKey('GET', '/api/session'), 'GET /api/session', '問い合わせが無ければ ? を付けない');
  assert.equal(snapshotKey('GET', '/api/session?'), 'GET /api/session');
  assert.equal(snapshotKey('POST', '/api/partners'), 'POST /api/partners');
  assert.equal(snapshotKey(undefined, '/api/bootstrap'), 'GET /api/bootstrap', 'メソッドの既定は GET');
  // 同じ名前が複数あるときは値でも並べる。空の値は残す（別の問い合わせとして扱う）
  assert.equal(sortedQuery('b=2&a=9&a=1'), 'a=1&a=9&b=2');
  assert.equal(snapshotKey('GET', '/api/x?a=&b=1'), 'GET /api/x?a=&b=1');
  assert.notEqual(snapshotKey('GET', '/api/x?a=&b=1'), snapshotKey('GET', '/api/x?b=1'));
  // 日本語・記号は URLSearchParams の形にそろう（%エンコードの違いを吸収）
  assert.equal(snapshotKey('GET', '/api/x?q=作品 A&z=1'), snapshotKey('GET', '/api/x?z=1&q=%E4%BD%9C%E5%93%81+A'));
  assert.equal(snapshotKey('GET', '/api/reports/committee-monthly?workId=1&from=2026-05&to=2027-04'), 'GET /api/reports/committee-monthly?from=2026-05&to=2027-04&workId=1');
  assert.ok(isApiPath('/api/session') && isApiPath('/api') && !isApiPath('/apix') && !isApiPath('/assets/api/x') && !isApiPath('/preview/api/x'));
});

const responses = {
  'GET /api/session': {status: 200, body: {ok: true, user: {id: 1, email: 'admin@openingnight.invalid', displayName: '架空管理者', role: 'admin', orgId: 1}}},
  'GET /api/royalty/periods?asOf=2026-09-25&holderId=3': {status: 200, body: {ok: true, periods: [{key: '3:2026-06'}]}},
  'GET /api/reports/committee-monthly?from=2026-09&to=2026-12&workId=9': {status: 404, body: {ok: false, error: '製作委員会の契約が登録されていません'}},
  'GET /api/billing/invoices/1/html': {status: 200, type: 'text/html; charset=utf-8', body: '<h1>架空の請求書</h1>'},
  'GET /api/broadcast/export.xlsx?workId=1': {status: 200, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'UEsDBA==', encoding: 'base64',
    disposition: "attachment; filename*=UTF-8''%E7%95%AA%E8%B2%A9.xlsx"},
};

test('プレビューの再生: 記録にある GET は記録どおりの状態と本体を返す（createApi を通して画面と同じ経路）', async () => {
  const fetchImpl = createSnapshotFetch({responses, base: 'http://127.0.0.1:9171/preview/index.html'});
  const api = createApi({fetchImpl});
  const session = await api('/session');
  assert.equal(session.user.email, 'admin@openingnight.invalid');
  const periods = await api('/royalty/periods?holderId=3&asOf=2026-09-25');
  assert.deepEqual(periods.periods, [{key: '3:2026-06'}], '問い合わせの順が違っても記録に当たる');
  // 記録した時点で 404 だった応答は、そのまま 404 として再生する（記録の理由を出す）
  await assert.rejects(api('/reports/committee-monthly?workId=9&from=2026-09&to=2026-12'), (error) => isApiError(error) && error.status === 404 && /契約が登録されていません/.test(describeError(error)));
  // raw（請求書の HTML・CSV など）は Response のまま
  const html = await api('/billing/invoices/1/html', {raw: true});
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await html.text(), '<h1>架空の請求書</h1>');
  const xlsx = await fetchImpl('/api/broadcast/export.xlsx?workId=1');
  assert.deepEqual([...new Uint8Array(await xlsx.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(downloadName(responses['GET /api/broadcast/export.xlsx?workId=1'], '/api/broadcast/export.xlsx?workId=1'), '番販.xlsx');
  assert.equal(downloadName({}, '/api/broadcast/avails/export.csv?headers=ja'), 'export.csv');
  // 画面の直接の fetch('/api/...')（売上サンプルの取得）も同じ関数で再生される。HEAD は本体なし
  const head = await fetchImpl('/api/session', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('プレビューの再生: 記録にない GET は「このプレビューに含まれていない表示です」を通常のエラー表示で出す', async () => {
  const misses = [];
  const api = createApi({fetchImpl: createSnapshotFetch({responses, onMiss: (miss) => misses.push(miss.key)})});
  await assert.rejects(api('/royalty/periods?asOf=2020-01-01'), (error) => {
    assert.ok(isApiError(error));
    assert.equal(error.status, 404);
    assert.equal(describeError(error), PREVIEW_MISSING_MESSAGE);
    assert.equal(errorNotice(error).message, PREVIEW_MISSING_MESSAGE);
    return true;
  });
  assert.deepEqual(misses, ['GET /api/royalty/periods?asOf=2020-01-01']);
  const direct = await createSnapshotFetch({responses})('/api/downloads/digital?workId=1');
  assert.equal(direct.status, 404);
  assert.equal((await direct.json()).error, PREVIEW_MISSING_MESSAGE, '直接の fetch でも同じ理由（main.jsx のサンプル取得は本体の error を出す）');
});

test('プレビューの再生: GET 以外（保存・登録・取消・退出）は送らず「プレビューでは保存できません」を返す', async () => {
  const blocked = [];
  const fetchImpl = createSnapshotFetch({responses, onBlocked: (item) => blocked.push(item.key)});
  const api = createApi({fetchImpl});
  for (const [path, method] of [['/partners', 'POST'], ['/royalty/statements/generate', 'POST'], ['/session', 'DELETE'], ['/works/1', 'PUT'], ['/x', 'PATCH']]) {
    await assert.rejects(api(path, {method, body: {code: 'DEMO'}}), (error) => {
      assert.ok(isApiError(error));
      assert.equal(error.status, 403);
      assert.equal(describeError(error), PREVIEW_READ_ONLY_MESSAGE);
      assert.equal(errorNotice(error).retryable, false, '再試行を勧めない');
      return true;
    });
  }
  assert.deepEqual(blocked, ['POST /api/partners', 'POST /api/royalty/statements/generate', 'DELETE /api/session', 'PUT /api/works/1', 'PATCH /api/x']);
  // Request を渡したときもメソッドを読む
  const response = await fetchImpl(new Request('http://preview.invalid/api/partners', {method: 'POST', body: '{}'}));
  assert.equal(response.status, 403);
  // 記録にある鍵でも GET 以外は通さない
  assert.equal((await fetchImpl('/api/session', {method: 'POST'})).status, 403);
});

test('プレビューの再生: 保存しない照合（アベイルズの作品名）は、記録した照合の元から API と同じ純関数で組み立てる。元が無ければ「含まれていない表示」', async () => {
  const source = {works: [{id: 1, code: 'DEMO-W01', title: '夜明けの貨物線（架空）', production_year: 2020}, {id: 2, code: 'DEMO-W02', title: '夜明けの港（架空）', production_year: 2021}],
    products: [{work_id: 2, sku: 'DEMO-W02-TV', name: '放送権（架空）'}]};
  assert.deepEqual(PREVIEW_COMPUTED_SOURCES, ['/api/broadcast/availability-list/candidates'], '記録するときに一緒に読む GET');
  const table = new Map([['GET /api/broadcast/availability-list/candidates', {status: 200, body: {ok: true, ...source}}]]);
  const blocked = [];
  const fetchImpl = createSnapshotFetch({responses: table, computedPosts: PREVIEW_COMPUTED_POSTS, onBlocked: (item) => blocked.push(item.key)});
  const api = createApi({fetchImpl});
  const text = ['夜明けの貨物線（架空）', 'DEMO-W02-TV', '夜明け', '無い作品（架空）'].join('\n');
  const body = await api('/broadcast/availability-list/match', {method: 'POST', body: {text}});
  assert.deepEqual(body.counts, {matched: 2, ambiguous: 1, not_found: 1, prefix: 0, partial: 0});
  assert.deepEqual(body.rows.map((row) => [row.status, row.candidates.map((c) => c.code)]), [['matched', ['DEMO-W01']], ['matched', ['DEMO-W02']], ['ambiguous', ['DEMO-W01', 'DEMO-W02']], ['not_found', []]]);
  assert.deepEqual(body.rows, availsMatchResult(text, source).rows, 'API と同じ純関数の結果');
  // Request を渡したときも本文を読む
  const response = await fetchImpl(new Request('http://preview.invalid/api/broadcast/availability-list/match', {method: 'POST', body: JSON.stringify({text: 'DEMO-W01'})}));
  assert.equal((await response.json()).counts.matched, 1);
  // 空の貼り付けは API と同じく 400 と理由
  await assert.rejects(api('/broadcast/availability-list/match', {method: 'POST', body: {text: ' '}}), (error) => error.status === 400 && /1行に1つ/.test(describeError(error)));
  // 照合のほかの POST は今までどおり保存できないと返す
  await assert.rejects(api('/broadcast/station-types', {method: 'POST', body: {}}), (error) => error.status === 403);
  assert.deepEqual(blocked, ['POST /api/broadcast/station-types']);
  // 照合の元を記録していなければ「このプレビューに含まれていない表示です」
  const bare = createApi({fetchImpl: createSnapshotFetch({responses: new Map(), computedPosts: PREVIEW_COMPUTED_POSTS})});
  await assert.rejects(bare('/broadcast/availability-list/match', {method: 'POST', body: {text: 'x'}}), (error) => error.status === 404 && describeError(error) === PREVIEW_MISSING_MESSAGE);
});

test('プレビューの再生: /api/ 以外と別の起点の URL は元の fetch に渡す。中断済みの signal は投げる', async () => {
  const passed = [];
  const fallbackFetch = async (input) => { passed.push(String(input)); return new Response('{}', {status: 200}); };
  const fetchImpl = createSnapshotFetch({responses, fallbackFetch, base: () => 'http://127.0.0.1:9171/preview/?p=home'});
  await fetchImpl('./preview-data.json');
  await fetchImpl('https://ai.internal/api/suggest', {method: 'POST'});
  assert.deepEqual(passed, ['./preview-data.json', 'https://ai.internal/api/suggest']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchImpl('/api/session', {signal: controller.signal}), (error) => error.name === 'AbortError');
});

test('記録の形: JSON は解釈済みの値、文字はそのまま、文字でないものは base64。再生すると同じバイト列に戻る', async () => {
  const json = encodeRecord({status: 200, contentType: 'application/json; charset=UTF-8', bytes: encode('{"ok":true,"名":"架空"}')});
  assert.deepEqual(json, {status: 200, body: {ok: true, 名: '架空'}});
  const csv = encodeRecord({status: 200, contentType: 'text/csv; charset=utf-8', bytes: encode('作品,額\nA,1\n'), disposition: 'attachment; filename="a.csv"'});
  assert.deepEqual(csv, {status: 200, type: 'text/csv; charset=utf-8', body: '作品,額\nA,1\n', disposition: 'attachment; filename="a.csv"'});
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const binary = encodeRecord({status: 200, contentType: 'application/pdf', bytes});
  assert.equal(binary.encoding, 'base64');
  assert.deepEqual([...new Uint8Array(await responseFromRecord(binary).arrayBuffer())], [...bytes]);
  assert.equal(await responseFromRecord(csv).text(), '作品,額\nA,1\n');
  assert.equal(responseFromRecord(csv).headers.get('content-disposition'), 'attachment; filename="a.csv"');
  assert.deepEqual(await responseFromRecord(json).json(), {ok: true, 名: '架空'});
  const broken = encodeRecord({status: 500, contentType: 'application/json', bytes: encode('not json')});
  assert.deepEqual(broken, {status: 500, type: 'application/json', body: 'not json'}, '読めない JSON は文字として残す');
  assert.equal(responseFromRecord(encodeRecord({status: 204, contentType: '', bytes: new Uint8Array()})).status, 204);
  // Excel は型の名前に xml を含んでも中身は zip。文字として読むと壊れるので base64 で残す
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00, 0xe3, 0x45, 0x39, 0x5d, 0xd5, 0xb1]);
  const xlsx = encodeRecord({status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: zip});
  assert.equal(xlsx.encoding, 'base64');
  assert.deepEqual([...new Uint8Array(await responseFromRecord(xlsx).arrayBuffer())], [...zip]);
  assert.equal(encodeRecord({status: 200, contentType: 'application/xml', bytes: encode('<a/>')}).body, '<a/>');
  assert.equal(encodeRecord({status: 200, contentType: 'image/svg+xml', bytes: encode('<svg/>')}).body, '<svg/>');
  const big = new Uint8Array(200000).map((_, i) => i % 256);
  assert.deepEqual([...new Uint8Array(await responseFromRecord(encodeRecord({status: 200, contentType: 'image/png', bytes: big})).arrayBuffer())], [...big]);
});

test('データファイル: 小さければ1つ、大きければ上限未満に分け、読み戻すと同じ表になる。形式・件数・重複を確かめる', () => {
  const table = new Map();
  for (let i = 0; i < 300; i += 1) table.set(`GET /api/item?id=${String(i).padStart(3, '0')}`, {status: 200, body: {ok: true, text: '架'.repeat(200)}});
  const small = splitPreviewData({recordedAt: '2026-09-25T03:00:00.000Z'}, table);
  assert.equal(small.parts.length, 0);
  const index = JSON.parse(small.index);
  assert.equal(index.format, PREVIEW_DATA_FORMAT);
  assert.equal(index.version, PREVIEW_DATA_VERSION);
  assert.equal(index.count, 300);
  const back = mergePreviewData(index);
  assert.equal(back.responses.size, 300);
  assert.equal(back.meta.recordedAt, '2026-09-25T03:00:00.000Z');
  assert.equal(back.meta.responses, undefined);

  const limitBytes = 64 * 1024;
  const split = splitPreviewData({recordedAt: '2026-09-25T03:00:00.000Z'}, table, {limitBytes});
  assert.ok(split.parts.length > 1);
  for (const part of split.parts) assert.ok(new TextEncoder().encode(part.text).length < limitBytes, `${part.name} は上限未満`);
  const splitIndex = JSON.parse(split.index);
  assert.deepEqual(splitIndex.parts, split.parts.map((part) => part.name));
  const merged = mergePreviewData(splitIndex, split.parts.map((part) => JSON.parse(part.text)));
  assert.deepEqual([...merged.responses.keys()].sort(), [...table.keys()].sort());

  assert.throws(() => mergePreviewData({format: 'x', version: 1}), /形式/);
  assert.throws(() => mergePreviewData({format: PREVIEW_DATA_FORMAT, version: 2}), /版/);
  assert.throws(() => mergePreviewData({...splitIndex, count: 5}, split.parts.map((part) => JSON.parse(part.text))), /件数/);
  const first = JSON.parse(split.parts[0].text);
  assert.throws(() => mergePreviewData({...splitIndex, count: undefined}, [first, first]), /同じ鍵/);
  assert.throws(() => splitPreviewData({}, new Map([['GET /api/huge', {status: 200, body: 'x'.repeat(70000)}]]), {limitBytes}), /大きすぎ/);
  assert.throws(() => splitPreviewData({note: '架'.repeat(1000)}, new Map(), {limitBytes: 2000}), /索引.*大きすぎ/, '応答だけでなく索引も上限未満');
  const boundary = new Map([['GET /api/demo', {status: 200, body: '架'.repeat(1000)}]]);
  const exactBytes = new TextEncoder().encode(splitPreviewData({}, boundary).index).length;
  assert.throws(() => splitPreviewData({}, boundary, {limitBytes: exactBytes}), /大きすぎ/, '上限と同じバイト数を許可しない');
});

test('プレビューの時計: 引数なしの new Date()・Date.now() は記録した時点（＋開いてからの経過）、日付を渡したときは変えない', () => {
  const win = {Date};
  installPreviewClock(win, '2026-09-25T03:00:00.000Z');
  const recorded = Date.parse('2026-09-25T03:00:00.000Z');
  assert.ok(Math.abs(win.Date.now() - recorded) < 5000);
  const now = new win.Date();
  assert.ok(now instanceof Date && now instanceof win.Date);
  assert.ok(Math.abs(now.getTime() - recorded) < 5000);
  assert.equal(new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10), '2026-09-25', '日本時間の「今日」が記録した日になる');
  assert.equal(new win.Date('2020-01-02T00:00:00Z').toISOString(), '2020-01-02T00:00:00.000Z');
  assert.equal(new win.Date(2020, 0, 2).getFullYear(), 2020);
  assert.equal(win.Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 1));
  assert.equal(win.Date.parse('2020-01-01T00:00:00Z'), Date.parse('2020-01-01T00:00:00Z'));
  assert.equal(typeof win.Date(), 'string', 'new なしで呼んだときは文字列（標準の Date と同じ）');
  assert.match(win.Date(), /2026/);
  const untouched = {Date};
  installPreviewClock(untouched, 'きのう');
  assert.equal(untouched.Date, Date, '記録の時点が読めなければ時計を変えない');
});

test('通常のビルドに影響しない: index.html の入口は main.jsx のまま、プレビューの部品は preview/ の外から読まない', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="\/src\/main.jsx"><\/script>/);
  const walk = (dir) => readdirSync(dir, {withFileTypes: true}).flatMap((entry) => (entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)]));
  const src = new URL('../src/', import.meta.url);
  for (const file of walk(src)) {
    if (!/\.(mjs|jsx|js)$/.test(file.pathname) || file.pathname.includes('/src/preview/')) continue;
    assert.doesNotMatch(readFileSync(file, 'utf8'), /preview\/(snapshot-client|preview-boot|preview-main)/, `${file.pathname} がプレビューの部品を読んでいる`);
  }
  for (const file of walk(new URL('preview/', src))) {
    if (/\.(mjs|jsx|js)$/.test(file.pathname)) assert.doesNotMatch(readFileSync(file, 'utf8'), /from ['"]node:|import\(['"]node:/, `${file.pathname} は Worker でも読める形にする`);
  }
  const {default: config, previewEntry} = await import('../vite.config.mjs');
  const normal = config({mode: 'production', command: 'build'});
  assert.equal(normal.base, undefined);
  assert.deepEqual(normal.build, {outDir: 'dist', sourcemap: true, emptyOutDir: true});
  assert.deepEqual(normal.server, {host: '127.0.0.1', port: 9040, proxy: {'/api': 'http://127.0.0.1:9041'}});
  assert.equal(normal.plugins.flat().some((plugin) => plugin?.name === 'openingnight-preview-entry'), false);
  const preview = config({mode: 'preview', command: 'build'});
  assert.equal(preview.base, './', 'どのパスに置いても開けるよう相対パス');
  assert.equal(preview.build.outDir, 'dist-preview');
  const replaced = previewEntry().transformIndexHtml.handler(html);
  assert.match(replaced, /src="\/src\/preview\/preview-main.mjs"/);
  assert.doesNotMatch(replaced, /src="\/src\/main.jsx"/);
  assert.throws(() => previewEntry().transformIndexHtml.handler('<html></html>'), /入口/);
});

test('ビルドの結果: 通常のビルドにはプレビューの文言・データの読込が入らず、プレビューのビルドは相対パスでデータを読む', {timeout: 180000}, async () => {
  const {build} = await import('vite');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const configFile = fileURLToPath(new URL('../vite.config.mjs', import.meta.url));
  const text = (result) => (Array.isArray(result) ? result : [result]).flatMap((item) => item.output).map((chunk) => `${chunk.fileName}\n${chunk.code ?? String(chunk.source ?? '')}`).join('\n');
  // write:false で書き出さない（dist・dist-preview を消さない）
  const options = (mode) => ({root, configFile, mode, logLevel: 'silent', build: {write: false, emptyOutDir: false, sourcemap: false, copyPublicDir: false}});
  const normal = text(await build(options('production')));
  for (const marker of [PREVIEW_READ_ONLY_MESSAGE, PREVIEW_MISSING_MESSAGE, 'preview-data.json', 'on-preview-banner', 'openingnight-preview']) {
    assert.equal(normal.includes(marker), false, `通常のビルドに「${marker}」が入っている`);
  }
  assert.match(normal, /index\.html\n[\s\S]*src="\/assets\/index-[^"]+\.js"/, '通常のビルドは今までどおり / からの絶対パス');
  const preview = text(await build(options('preview')));
  for (const marker of [PREVIEW_READ_ONLY_MESSAGE, PREVIEW_MISSING_MESSAGE, 'preview-data.json', 'on-preview-banner']) assert.ok(preview.includes(marker), `プレビューのビルドに「${marker}」が無い`);
  assert.match(preview, /src="\.\/assets\/index-[^"]+\.js"/, 'プレビューは ./assets からの相対パス');
});
