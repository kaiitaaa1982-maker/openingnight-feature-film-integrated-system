import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {availsExportUrls, API_LINK_LIMIT, FILE_LIMIT_BYTES, PREVIEW_ALWAYS_GETS, checkOutDir, foreignEmailDomains, jstDate, normalizeLocation, outDirOf, parseArgs, resolveLink, restrictOrgs, seedLocations, requiredPreviewApiUrls, recordRequiredPreviewApis} from '../scripts/build-preview.mjs';
import {snapshotKey, createSnapshotFetch, mergePreviewData, splitPreviewData} from '../src/preview/snapshot-client.mjs';
import {REPORT_CATALOG} from '../src/reports/report-catalog.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));

test('全表の定義: APIリンクの上限を超える表数でも末尾まで記録し、分割・再生後に列の意味を読める', async () => {
  const tables = [{name: 'works'}, {name: 'work_master_profile_versions'}, {name: '表 / #（架空）'},
    ...Array.from({length: API_LINK_LIMIT}, (_, i) => ({name: `demo_table_${i}`}))];
  const responses = new Map();
  const calls = [];
  await recordRequiredPreviewApis(responses, async (url) => {
    calls.push(url);
    const body = url === '/api/admin/tables' ? {tables} : {columns: [{name: 'org_id', type: 'INTEGER', description: '所属する組織（架空）'}]};
    responses.set(snapshotKey('GET', url), {status: 200, body});
  });
  assert.equal(calls.length, tables.length + 1);
  assert.ok(calls.includes(`/api/admin/tables/${encodeURIComponent(tables[2].name)}/definition`));
  assert.ok(calls.every((url) => url === '/api/admin/tables' || url.endsWith('/definition')), '行APIは権限を拡大して取得しない');
  const split = splitPreviewData({}, responses, {limitBytes: 32000});
  const merged = mergePreviewData(JSON.parse(split.index), split.parts.map((part) => JSON.parse(part.text)));
  const fetch = createSnapshotFetch({responses: merged.responses});
  for (const table of [tables[0], tables[1], tables.at(-1)]) {
    const response = await fetch(`/api/admin/tables/${table.name}/definition`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).columns[0].description, '所属する組織（架空）');
  }
});

test('必須の定義: 一覧失敗・定義失敗・通信失敗を記録成功にしない', async () => {
  await assert.rejects(recordRequiredPreviewApis(new Map(), async () => {}), /表一覧/);
  const responses = new Map([['GET /api/admin/tables', {status: 200, body: {tables: [{name: 'works'}]}}]]);
  await assert.rejects(recordRequiredPreviewApis(responses, async (url) => {
    if (url.endsWith('/definition')) responses.set(snapshotKey('GET', url), {status: 500});
  }), /必須.*works/);
  await assert.rejects(recordRequiredPreviewApis(new Map(), async () => { throw new Error('通信失敗'); }), /通信失敗/);
});

test('売上の追加列: 既定条件と最新月の年度を記録する（期首4月・最新月が前年より古い場合）', async () => {
  const responses = new Map([
    ['GET /api/admin/tables', {status: 200, body: {tables: []}}],
    ['GET /api/settings/fiscal', {status: 200, body: {setting: {fiscalStartMonth: 4}}}],
    ['GET /api/sales-sheet?from=2026-04&set=basic&to=2027-03', {status: 200, body: {adopted: true, total: 0, latestMonth: '2023-03'}}],
    ['GET /api/sales-sheet?from=2026-04&set=basic&to=2027-03&workId=1', {status: 200, body: {adopted: true, latestMonth: '2021-01'}}],
    ['GET /api/sales-sheet?from=2019-04&set=basic&to=2020-03', {status: 403, body: {adopted: true, latestMonth: '2018-01'}}],
  ]);
  const urls = requiredPreviewApiUrls(responses);
  assert.equal(urls.length, 6);
  for (const set of ['basic', 'additional', 'all_plus']) {
    assert.ok(urls.includes(`/api/sales-sheet?from=2026-04&set=${set}&to=2027-03`));
    assert.ok(urls.includes(`/api/sales-sheet?from=2022-04&set=${set}&to=2023-03`));
  }
  await recordRequiredPreviewApis(responses, async (url) => {
    if (!responses.has(snapshotKey('GET', url))) responses.set(snapshotKey('GET', url), {status: 200, body: {columns: [{key: 'raw_quantity', label: '明細の原数量'}]}});
  });
  const fetch = createSnapshotFetch({responses});
  const replay = await fetch('/api/sales-sheet?to=2023-03&set=additional&from=2022-04');
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).columns[0].label, '明細の原数量');
});

test('売上の追加列: 最新月なし・同年度の重複・未採用・権限なしから不要な条件を作らない', () => {
  for (const latestMonth of [null, '2026-12', '日付不明']) {
    const urls = requiredPreviewApiUrls(new Map([
      ['GET /api/sales-sheet?from=2026-05&set=basic&to=2027-04', {status: 200, body: {adopted: true, latestMonth}}],
    ]));
    assert.equal(urls.length, 3);
  }
  for (const entry of [{status: 403}, {status: 200, body: {adopted: false}}]) {
    assert.deepEqual(requiredPreviewApiUrls(new Map([['GET /api/sales-sheet?set=basic', entry]])), []);
  }
});

test('分割は10進16MB未満: 日本語を含む16MB超の記録を全件読み戻せる', () => {
  assert.equal(FILE_LIMIT_BYTES, 16_000_000);
  const responses = new Map(Array.from({length: 4}, (_, i) => [`GET /api/demo/${i}`, {status: 200, body: '架'.repeat(1_350_000)}]));
  for (const options of [undefined, {limitBytes: FILE_LIMIT_BYTES - 64 * 1024}]) {
    const split = splitPreviewData({recordedAt: '2026-09-28T00:00:00Z'}, responses, options);
    assert.ok(split.parts.length > 1, '16MiB未満でも16MBを超えると分割');
    for (const text of [split.index, ...split.parts.map((part) => part.text)]) assert.ok(Buffer.byteLength(text, 'utf8') < 16_000_000);
    const merged = mergePreviewData(JSON.parse(split.index), split.parts.map((part) => JSON.parse(part.text)));
    assert.deepEqual(merged.responses, responses);
  }
});

test('記録の指定: DB と .invalid の架空メールが必須。数の指定を確かめる', () => {
  const options = parseArgs(['--db', 'demo.sqlite', '--user', 'demo-admin@openingnight.invalid', '--works', '3', '--org', 'DEMO-SALES', '--no-public']);
  assert.equal(options.works, '3');
  assert.equal(options.org, 'DEMO-SALES');
  assert.equal(options.publicFiles, false);
  assert.equal(options.depth, 2);
  assert.throws(() => parseArgs(['--user', 'a@b.invalid']), /--db/);
  assert.throws(() => parseArgs(['--db', 'x']), /--user/);
  assert.throws(() => parseArgs(['--db', 'x', '--user', 'someone@example.com']), /\.invalid/, '架空でないメールでは記録しない');
  assert.throws(() => parseArgs(['--db', 'x', '--user', 'a@b.invalid', '--works', '0']), /--works/);
  assert.throws(() => parseArgs(['--db', 'x', '--user', 'a@b.invalid', '--now', 'きのう']), /--now/);
  assert.throws(() => parseArgs(['--db', 'x', '--user', 'a@b.invalid', '--bogus']), /知らない指定/);
  assert.throws(() => parseArgs(['--db']), /値を指定/);
});

test('巡回する URL: 並べ替えてそろえ、画面内のリンクは今の作品を引き継ぐ（会社全体の画面は最初の作品にそろえる）', () => {
  assert.equal(normalizeLocation('?work=3&p=sales&from='), '?p=sales&work=3');
  assert.equal(normalizeLocation('?work=3'), null, '画面の指定が無いものは巡回しない');
  // 作品を選んで使う画面（ホーム）: 今の作品を引き継ぐ
  assert.equal(resolveLink('?p=home', {currentSearch: '?p=planning&work=7', firstWorkId: 1}), '?p=home&work=7');
  // 会社全体の画面（帳票センター）: 作品の指定が無ければ最初の作品
  assert.equal(resolveLink('?p=report-center&report=mg-sales', {currentSearch: '?p=home&work=7', firstWorkId: 1}), '?p=report-center&report=mg-sales&work=1');
  // 作品の指定があるリンクはそのまま
  assert.equal(resolveLink('?p=report-center&work=5', {currentSearch: '?p=home&work=7', firstWorkId: 1}), '?p=report-center&work=5');
  assert.equal(resolveLink('/?p=home', {firstWorkId: 1}), '?p=home&work=1');
  for (const href of ['#app-main', '/api/broadcast/export.xlsx', 'https://example.com/?p=home', '?p=unknown-page', '/workflow-demo/', '']) {
    assert.equal(resolveLink(href, {firstWorkId: 1}), null, href);
  }
});

test('最初に開く画面: ナビの全画面・帳票センターの全帳票・ロイヤリティの権利者/期間/報告書・委員会の作品ごとの月次収支', () => {
  const works = [{id: 1}, {id: 2}, {id: 3}];
  const extra = {
    holders: [{id: 8}, {id: 9}], statements: [{id: 11, holderId: 8, closeMonth: '2025-12'}], periods: [{holderId: 9, closeMonth: '2026-06', statementId: null}, {holderId: 8, closeMonth: '2025-12', statementId: 11}],
    agreements: [{id: 21}], committeeWorks: [{id: 2, title: '架空の委員会作品'}],
  };
  const seeds = seedLocations({works, role: 'admin', worksLimit: 'all', year: 2026, extra});
  const searches = new Set(seeds.map((seed) => seed.search));
  assert.equal(searches.size, seeds.length, '重複しない');
  for (const work of works) assert.ok(searches.has(`?p=home&work=${work.id}`), `作品${work.id}のホーム`);
  assert.ok(searches.has('?p=report-center&work=1'), '会社全体の画面は最初の作品で1回');
  assert.equal([...searches].filter((search) => search.startsWith('?p=report-center&work=')).length, 1);
  for (const report of REPORT_CATALOG) assert.ok(searches.has(`?p=report-center&report=${report.id}&work=1`), `帳票 ${report.id}`);
  assert.ok(searches.has('?fy=2025&p=report-center&report=annual-sales&work=1'), '年間の帳票は前の年度も');
  assert.ok(searches.has('?holder=8&p=royalty-ledger&work=1'));
  assert.ok(searches.has('?p=royalty-statements&statement=11&work=1'));
  assert.ok(searches.has('?close=2025-12&holder=8&p=report-center&report=royalty-cycle&statement=11&work=1'));
  assert.ok(searches.has('?close=2026-06&holder=9&p=royalty-statements&work=1'), '作成待ちの期間は下書きの報告書');
  assert.ok(searches.has('?agreement=21&p=royalty-agreements&work=1'));
  assert.ok(searches.has('?p=committee-monthly&work=1&workId=2'));
  assert.ok(searches.has('?fy=2024&p=committee-monthly&work=1&workId=2'));
  // 2026-09-26 に足した画面: 提案資料は SVOD と、基準ごとに既定の月の前1か月〜後5か月（最初の基準は ppbasis を付けない）と「確定だけ」。
  // 放送ウィンドウ提案は全作品、PL・BS と売上集計シートは前の年度も
  const withProposals = new Set(seedLocations({works, role: 'admin', year: 2026, extra: {proposalDefaultMonth: '2026-10'}}).map((seed) => seed.search));
  assert.ok(withProposals.has('?p=proposals&pptab=svod&work=1'));
  for (const month of ['2026-09', '2026-10', '2027-03']) assert.ok(withProposals.has(`?p=proposals&ppmonth=${month}&work=1`), `PVOD基準 ${month}`);
  assert.ok(!withProposals.has('?p=proposals&ppmonth=2027-04&work=1'), '後5か月まで');
  assert.ok(withProposals.has('?p=proposals&ppbasis=est_early&ppmonth=2026-12&work=1'));
  assert.ok(withProposals.has('?p=proposals&ppbasis=tvod&ppmonth=2026-10&ppstatus=confirmed&work=1'));
  assert.equal([...withProposals].filter((search) => search.startsWith('?p=proposals&')).length, 2 + 5 * 8, 'メニューの既定の表示・SVOD・5基準×(7か月＋確定だけ)');
  assert.ok(!searches.has('?p=proposals&ppmonth=2026-10&work=1'), '既定の月が分からなければ月別は既定の表示だけ');
  assert.ok(searches.has('?bpscope=all&p=broadcast&tab=proposals&work=1'));
  for (const fy of [2025, 2024]) {
    assert.ok(searches.has(`?fy=${fy}&p=pl-bs&work=1`));
    assert.ok(searches.has(`?fy=${fy}&p=sales-sheet&work=1`));
  }
  // 作品の数を絞る
  const limited = seedLocations({works, role: 'admin', worksLimit: '1', year: 2026});
  assert.ok(limited.some((seed) => seed.search === '?p=home&work=1'));
  assert.ok(!limited.some((seed) => seed.search === '?p=home&work=2'));
  // 制作担当は売上基幹の画面を開かない（見えない画面を記録しない）
  const production = seedLocations({works, role: 'production', year: 2026, extra: {...extra, proposalDefaultMonth: '2026-10'}});
  assert.ok(!production.some((seed) => /p=(report-center|royalty-[a-z]+|committee-monthly|sales|sales-sheet|pl-bs|proposals|broadcast)(&|$)/.test(seed.search)));
  assert.ok(production.some((seed) => seed.search === '?p=production&work=1'));
});

test('架空データの確認: .invalid・.example・.test 以外のメールのドメインを見つける。所属の一覧は記録する組織だけにする', () => {
  const responses = new Map([
    ['GET /api/team', {status: 200, body: {members: [{email: 'demo-admin@openingnight.invalid'}, {email: 'x@sample.example'}]}}],
    ['GET /api/partners', {status: 200, body: {rows: [{note: '連絡先 someone@realcorp.co.jp'}, {icon: 'logo@2x.png'}]}}],
    ['GET /api/file', {status: 200, type: 'application/pdf', body: 'YUBiLmNvbQ==', encoding: 'base64'}],
    ['GET /api/csv', {status: 200, type: 'text/csv', body: '名前,メール\nA,a@partner.com\n'}],
  ]);
  assert.deepEqual(foreignEmailDomains(responses), ['partner.com', 'realcorp.co.jp']);
  assert.deepEqual(foreignEmailDomains(responses, ['realcorp.co.jp', 'partner.com']), []);

  const orgs = new Map([['GET /api/session/orgs', {status: 200, body: {ok: true, currentOrgId: 3, orgs: [{id: 1, name: '本物の組織'}, {id: 3, name: '架空データ（デモ）'}]}}]]);
  restrictOrgs(orgs);
  assert.deepEqual(orgs.get('GET /api/session/orgs').body.orgs, [{id: 3, name: '架空データ（デモ）'}]);
  const empty = new Map();
  restrictOrgs(empty);
  assert.equal(empty.size, 0);
  // デモ資料の組織の判定も、記録する組織だけ（ほかの組織の名前と「組織を切り替えて開く」の案内をプレビューに出さない）
  const features = new Map([['GET /api/session/org-features', {status: 200, body: {ok: true, currentOrgId: 3,
    koubanDemo: [{id: 1, name: '本物の組織'}, {id: 3, name: '架空データ（デモ）'}], salesSheet: [{id: 1, name: '本物の組織'}]}}]]);
  restrictOrgs(features);
  assert.ok(PREVIEW_ALWAYS_GETS.includes('/api/session/org-features'), '画面が読まない組織でも、判定はいつも記録に入れる（絞った上で）');
  assert.deepEqual(features.get('GET /api/session/org-features').body, {ok: true, currentOrgId: 3, koubanDemo: [{id: 3, name: '架空データ（デモ）'}], salesSheet: []});
});

test('放送アベイルズリストの Excel: 記録した放送履歴表の作品すべてを、表の順・記録した日で出す URL（画面の「すべて入れる」と同じ）', () => {
  const responses = new Map([
    ['GET /api/broadcast/history?from=2025-10&to=2027-09', {status: 200, body: {rows: [{work_id: 7}, {work_id: 3}, {work_id: 12}]}}],
    ['GET /api/broadcast/history?from=2020-01&to=2020-02', {status: 200, body: {rows: []}}],
    ['GET /api/broadcast/history?q=x', {status: 403, body: {ok: false}}],
  ]);
  const urls = availsExportUrls(responses, '2026-09-26');
  assert.deepEqual(urls, ['/api/broadcast/availability-list/export.xlsx?asOf=2026-09-26&workIds=7%2C3%2C12']);
  assert.equal(snapshotKey('GET', urls[0]), snapshotKey('GET', `/api/broadcast/availability-list/export.xlsx?${new URLSearchParams({asOf: '2026-09-26', workIds: [7, 3, 12].join(',')})}`),
    '画面が組み立てる URL と同じ鍵');
  assert.equal(jstDate('2026-09-25T20:00:00Z'), '2026-09-26', '記録した日は日本時間');
});

test('書き出し先: 既定はアプリの dist-preview。前回のプレビュー以外が入ったフォルダ・アプリのフォルダには書かない', () => {
  assert.equal(outDirOf(null), resolve(appRoot, 'dist-preview'));
  const base = mkdtempSync(join(tmpdir(), 'on-preview-out-'));
  try {
    assert.throws(() => checkOutDir(appRoot), /使えない/);
    assert.throws(() => checkOutDir(resolve(appRoot, 'src')), /使えない/);
    assert.throws(() => checkOutDir(resolve(appRoot, '..')), /使えない/, 'アプリを含むフォルダ');
    assert.throws(() => checkOutDir(tmpdir()), /使えない/);
    const other = join(base, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'memo.txt'), '架空');
    assert.throws(() => checkOutDir(other), /前回のプレビュー以外/);
    const previous = join(base, 'previous');
    mkdirSync(previous);
    writeFileSync(join(previous, 'index.html'), '');
    writeFileSync(join(previous, 'preview-data.json'), '{}');
    assert.doesNotThrow(() => checkOutDir(previous));
    assert.doesNotThrow(() => checkOutDir(join(base, 'new')));
  } finally {
    rmSync(base, {recursive: true, force: true});
  }
});

test('行を押したときにだけ読む応答: PL・BS の委員会作品の出資と払込、取引先別リストの明細の履歴（放送の明細は放送の条件も）を記録する', async () => {
  const {detailApiUrls} = await import('../scripts/build-preview.mjs');
  const responses = new Map([
    ['GET /api/reports/pl-bs?from=2025-05&to=2026-04&asOf=2026-06', {status: 200, body: {workBalances: [{workId: 31, kind: 'committee'}, {workId: 32, kind: 'own'}, {workId: 33, kind: 'committee'}]}}],
    ['GET /api/reports/pl-bs?from=2024-05&to=2025-04&asOf=2025-04', {status: 200, body: {workBalances: [{workId: 31, kind: 'committee'}]}}],
    ['GET /api/reports/pl-bs?from=2020-05&to=2021-04', {status: 400, body: {ok: false}}],
    ['GET /api/partner-lists/4/entries?asOf=2026-09-26&soonDays=30', {status: 200, body: {entries: [{entry_id: 50, distribution_name: '放送'}, {entry_id: 51, distribution_name: '配信'}]}}],
    ['GET /api/partner-lists/5/entries?asOf=2026-09-26&soonDays=30', {status: 403, body: {ok: false}}],
  ]);
  assert.deepEqual(detailApiUrls(responses), [
    '/api/committee-investments?workId=31', '/api/committee-investments?workId=33',
    '/api/partner-list-entries/50/history', '/api/partner-list-entries/50/broadcast-terms', '/api/partner-list-entries/51/history',
  ]);
  // 取引先別リストは全部のリストを開く（制作担当には出さない）
  const works = [{id: 1, code: 'W01', title: '一'}];
  const lists = [{id: 4, partner_id: 9, name: '放送の許諾（架空）'}, {id: 5, partner_id: 10, name: '配信（架空）'}];
  const admin = seedLocations({works, role: 'admin', year: 2026, extra: {partnerLists: lists}}).map((seed) => seed.search);
  assert.ok(admin.some((search) => /plpartner=9/.test(search) && /pllist=4/.test(search)), admin.join(' '));
  assert.ok(admin.some((search) => /pllist=5/.test(search)));
  const production = seedLocations({works, role: 'production', year: 2026, extra: {partnerLists: lists}}).map((seed) => seed.search);
  assert.ok(!production.some((search) => /pllist=/.test(search)));
});
