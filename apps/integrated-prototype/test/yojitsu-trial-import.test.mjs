// 企画の試算の写し（trials_snapshot.json の形）の取り込み（フェーズ1の仕様書 #13。要件 FR-REV-YOJITSU-023・026）を、純関数
// （src/revenue/yojitsu/trial-import-model.mjs）と受け口（POST /api/revenue/forecast-imports）で確かめる。
// 期待値は、架空の写し（test/fixtures/yojitsu/trials-snapshot*.json）を会社ルートの build_yojitsu.py の trial_rows に流した行と照合の結果
// （trials-expected.json。生成は同じフォルダの trials.py）。xlsx と Excel の COM は使わず、架空の JSON だけで CI の Linux で流れる。
// 受け口の 409（読んだあとにほかの書き込みが版を足した）と 413（D1 の1回の batch の文の数の上限）は、割り込む DB と行の多い架空の冊で確かめる。
// PostgreSQL の同時の書き込みでだけ起きる負け方（一意の制約の違反）は、test/racing-db.mjs の割り込みで再現する。
// ON_TEST_DB=pg で受け口の試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {chooseTrialBooks, planTrialImport, readTrialBook, trialValueToYen, TRIAL_IMPORT_PREFIX} from '../src/revenue/yojitsu/trial-import-model.mjs';
import {normalizeForecastVersionInput} from '../src/revenue/yojitsu/forecast-model.mjs';
import {pgUniqueViolation, racingBatchDb} from './racing-db.mjs';

const text = (name) => readFileSync(new URL(`./fixtures/yojitsu/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const read = (name) => JSON.parse(text(name));
const expected = read('trials-expected.json');
const snapshot = read('trials-snapshot.json');
const revised = read('trials-snapshot-revised.json');
const mismatch = read('trials-snapshot-mismatch.json');
const CATEGORY = {流通売上: 11, 出資: 12}; // 純関数の試験の区分の id（架空）
const SCENARIO = {even: 'even', good: 'good', MAX: 'max'};
const options = (overrides = {}) => ({projectByPrefix: expected.試算の案件, existing: new Map(), createdOn: '2026-10-20', status: 'director_reported',
  excludedItems: expected.除いた窓口, categories: {channel: CATEGORY.流通売上, investment: CATEGORY.出資}, ...overrides});
// build_yojitsu.py の行 → 統合システムの予測の行（状態は統合システムの語。相手の空は null）
const lineOf = (row, categoryId = (label) => CATEGORY[label]) => ({scenario: SCENARIO[row.シナリオ], month: row.月, categoryId: categoryId(row.区分), item: row.項目,
  counterparty: row.相手 === '' ? null : row.相手, amountYen: row['金額（円・税別）'], status: 'director_reported', useForForecast: row.予測に使う === 'はい'});
const checksOf = (rows) => rows.map((c) => ({name: c.試算, scenario: SCENARIO[c.シナリオ], diffYen: c.入金の行との差}));

test('架空の試算の写しと期待値は fictional の印を持ち、期待値の元の写しのハッシュが置いてある写しと一致する', () => {
  assert.equal(expected.fictional, true);
  assert.equal(expected.generator, 'trials.py');
  for (const [name, sha] of Object.entries(expected.sources)) {
    assert.equal(createHash('sha256').update(text(name)).digest('hex'), sha, `${name} を作り直したら trials.py で期待値も作り直す`);
  }
  // 架空の企画の名前だけ（実在の企画の試算のファイル名を持たない）
  for (const book of [...snapshot, ...revised, ...mismatch]) assert.match(book.path, /^ORG\/企画\/架空企画[AB]\/30_提出版\/売上試算_架空企画[AB]_\d{8}\.xlsx$/);
});

test('FR-REV-YOJITSU-026 試算の写しの窓口の売上は入金サイトだけ後ろの月の区分「流通売上」の行に、出資は区分「出資」の行になり、build_yojitsu.py の trial_rows と同じ行になる', () => {
  const plan = planTrialImport(snapshot, options());
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.versions.map((v) => [v.projectCode, v.previousVersionNo, v.label, v.createdOn, v.sourceKind]),
    [['TR-P01', 0, `${TRIAL_IMPORT_PREFIX} 2026-10-20`, '2026-10-20', 'trial_import'], ['TR-P02', 0, `${TRIAL_IMPORT_PREFIX} 2026-10-20`, '2026-10-20', 'trial_import']]);
  for (const v of plan.versions) {
    const rows = expected['1回目'].行.filter((r) => r.案件コード === v.projectCode);
    assert.deepEqual(v.lines, rows.map((r) => lineOf(r)), v.projectCode);
    // 版の名前・作った日・出所の文は build_yojitsu.py の行と同じ。SHA-256 は小文字の64桁を版に持つ
    assert.deepEqual([...new Set(rows.map((r) => [r.版, r.作った日, r.出所].join('|')))], [[v.label, v.createdOn, v.source].join('|')]);
    const book = snapshot.find((b) => v.source.startsWith(b.path));
    assert.equal(v.sourceSha256, book.sha256.toLowerCase());
  }
  // 照合（窓口の売上を入金の月で足した額と「入金」の行の差）は build_yojitsu.py と同じ。企画B は 0.30 円ずれていて、丸めて 0 円
  assert.deepEqual(plan.checks.map(({name, scenario, diffYen}) => ({name, scenario, diffYen})), checksOf(expected['1回目'].照合));
  // 同じ企画の古い冊（ファイル名の日付が前）は使わない
  assert.deepEqual(plan.skipped, [{name: '売上試算_架空企画A_20260901.xlsx', projectCode: 'TR-P01', reason: 'older_book'}]);
});

test('FR-REV-YOJITSU-026 写し済みの冊は足さず、改めた冊は前の版の次の版になる（build_yojitsu.py の2回目と同じ行）', () => {
  const first = planTrialImport(snapshot, options());
  const existing = new Map(first.versions.map((v) => [v.projectCode, {latestVersionNo: 1, sha256s: new Set([v.sourceSha256])}]));
  const plan = planTrialImport(revised, options({existing, createdOn: '2026-10-21'}));
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.versions.map((v) => [v.projectCode, v.previousVersionNo, v.label]), [['TR-P01', 1, `${TRIAL_IMPORT_PREFIX} 2026-10-21`]]);
  assert.deepEqual(plan.versions[0].lines, expected['2回目'].行.map((r) => lineOf(r)));
  assert.deepEqual(plan.skipped, [{name: '売上試算_架空企画B_20261005.xlsx', projectCode: 'TR-P02', reason: 'already_imported'}]);
  assert.deepEqual(plan.checks.map(({name, scenario, diffYen}) => ({name, scenario, diffYen})), checksOf(expected['2回目'].照合));
});

test('FR-REV-YOJITSU-026 窓口の売上と入金の行の差が1円を超える冊があれば、どの冊も足さない（build_yojitsu.py と同じ許容）', () => {
  const plan = planTrialImport([...snapshot.slice(2), ...mismatch], options());
  assert.deepEqual(plan.versions, []);
  assert.deepEqual(plan.checks.filter((c) => c.name.includes('20261101')).map(({name, scenario, diffYen}) => ({name, scenario, diffYen})), checksOf(expected.合わない.照合));
  assert.ok(expected.合わない.照合.every((c) => c.入金の行との差 === 2));
  assert.deepEqual(plan.errors.map((e) => e.message), ['even', 'good', 'max'].map((s) => `売上試算_架空企画A_20261101.xlsx の ${s} の窓口の売上と入金の行が合いません（差 2 円。許容は 1 円）`));
});

test('FR-REV-YOJITSU-026 試算の額は10進の値のまま足してから円に丸め、ちょうど半分は偶数へ寄せる（build_yojitsu.py の round と同じ。要確認17）', () => {
  assert.deepEqual([123456.5, 98765.5, 0.5, 1.5, 2.5, -2.5, -3.5, 2.5000001, 7.49999999, 1e3, 1.5e-7].map(trialValueToYen), [123456, 98766, 0, 2, 2, -2, -4, 3, 7, 1000, 0]);
  assert.equal(trialValueToYen('12'), null);
  assert.equal(trialValueToYen(null), null);
  assert.throws(() => trialValueToYen(1e21), /安全な整数/);
  // 架空の写しにもちょうど半分の額がある（good のパッケージ）。偶数へ寄せた額が build_yojitsu.py の行と同じ
  const good = expected['1回目'].行.filter((r) => r.シナリオ === 'good' && r.項目 === 'パッケージ').map((r) => r['金額（円・税別）']);
  assert.ok(good.includes(123456) && good.includes(98766));
});

test('FR-REV-YOJITSU-026 読めない写しは理由つきで断る（案件の決まらない冊・入金サイトや見出しの無い表・月初でない月・真偽の値・負の窓口の額）', () => {
  const base = snapshot[1];
  const withRows = (rows) => ({...base, rows});
  const errorsOf = (book) => readTrialBook(book, {categories: {channel: 1, investment: 2}, status: 'provisional'}).errors.map((e) => e.message);
  assert.deepEqual(chooseTrialBooks([{...base, path: 'ORG/企画/架空/売上試算_架空企画Z_20261001.xlsx'}], expected.試算の案件).errors.map((e) => e.message),
    ['案件コードが決まっていない試算です: 売上試算_架空企画Z_20261001.xlsx']);
  assert.deepEqual(chooseTrialBooks({}, expected.試算の案件).errors.map((e) => e.field), ['snapshot']);
  assert.deepEqual(chooseTrialBooks([{...base, sha256: 'abc'}], expected.試算の案件).errors.map((e) => e.field), ['snapshot.0.sha256']);
  assert.match(errorsOf(withRows(base.rows.filter((r) => r[0] !== '入金サイト（月）'))).join(), /入金サイト（月）」の行がありません/);
  assert.match(errorsOf(withRows(base.rows.filter((r) => r[0] !== 'シナリオ'))).join(), /見出し/);
  const header = base.rows.findIndex((r) => r[0] === 'シナリオ');
  const shifted = base.rows.map((r, i) => (i === header ? r.map((v) => (typeof v === 'number' ? v + 1 : v)) : r));
  assert.match(errorsOf(withRows(shifted)).join(), /見出しの月が月初の日ではありません: 2026-10-02/);
  const channelRow = base.rows.findIndex((r) => r[0] === 'even' && r[1] === '配信');
  const put = (value) => base.rows.map((r, i) => (i === channelRow ? r.map((v, j) => (j === 3 ? value : v)) : r));
  assert.match(errorsOf(withRows(put(true))).join(), /真偽の値/);
  assert.match(errorsOf(withRows(put(-1234.25))).join(), /額が正ではありません/);
  // 0.5 以下の値と数でない値は読まない（誤りにしない）
  assert.deepEqual(errorsOf(withRows(put(0.5))), []);
  assert.deepEqual(errorsOf(withRows(put('—'))), []);
});

// ---------- 期待値の作り直し（会社ルートの build_yojitsu.py と openpyxl がある手元だけ。CI は会社ルートを持たないので飛ばす） ----------
const fixtureDir = fileURLToPath(new URL('./fixtures/yojitsu/', import.meta.url));
const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function findBuildYojitsu() {
  if (process.env.ON_BUILD_YOJITSU) return existsSync(process.env.ON_BUILD_YOJITSU) ? process.env.ON_BUILD_YOJITSU : null;
  for (let d = fixtureDir; dirname(d) !== d; d = dirname(d)) {
    const p = join(d, 'ORG', '事業計画', '_build', 'build_yojitsu.py');
    if (existsSync(p)) return p;
  }
  return null;
}
const buildYojitsu = findBuildYojitsu();
const probe = buildYojitsu ? spawnSync(python, ['-c', 'import openpyxl'], {encoding: 'utf8'}) : null;
const skipRegen = !buildYojitsu ? '会社ルートの build_yojitsu.py が無い（ON_BUILD_YOJITSU で渡す。CI は会社ルートを持たない）'
  : (probe.error || probe.status !== 0) ? `Python か openpyxl が無い（${python}）` : false;

test('架空の写しと期待値は trials.py で作り直すと置いてあるものと同じバイト列になる（build_yojitsu.py の trial_rows に流し直す）', {skip: skipRegen}, () => {
  const run = spawnSync(python, [join(fixtureDir, 'trials.py'), '--build-yojitsu', buildYojitsu, '--check'],
    {encoding: 'utf8', env: {...process.env, PYTHONIOENCODING: 'utf-8'}, timeout: 600_000});
  assert.equal(run.status, 0, `${run.stdout}
${run.stderr}`);
});

// ---------- 受け口（DB に書く） ----------

// appDb は受け口が使う DB（既定は db。ほかの書き込みが割り込む形を作るときに包んだ DB を渡す）
async function setup(db, {appDb = db} = {}) {
  const categories = {
    channel: await planning.addCashflowCategory(db, 1, {code: 'distribution_sales', label: '流通売上', direction: 'in', countsAsRevenue: 1, sortOrder: 1}),
    investment: await planning.addCashflowCategory(db, 1, {code: 'investment', label: '出資', direction: 'out', countsAsRevenue: 0, sortOrder: 5}),
  };
  const project = (code, title) => planning.createProject(db, 1, {code, title, projectType: 'production', earningType: 'own_investment', baseAmountYen: null,
    revenueRateBps: null, counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null}, {createdBy: 1});
  const projects = {'TR-P01': await project('TR-P01', '架空企画A（架空）'), 'TR-P02': await project('TR-P02', '架空企画B（架空）')};
  const app = createApp({db: appDb, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const post = async (cookie, payload) => {
    const response = await app.request('/api/revenue/forecast-imports', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(payload)});
    return {status: response.status, body: await response.json()};
  };
  return {categories, projects, login, post};
}
const payload = (snap, overrides = {}) => ({snapshot: snap, projects: expected.試算の案件, categories: {channel: 'distribution_sales', investment: 'investment'},
  excludedItems: expected.除いた窓口, ...overrides});

test('FR-REV-YOJITSU-023 FR-REV-YOJITSU-026 受け口は写しを予測の版として足し、写し済みは足さず、改めた写しの前の版は「予測に使う＝いいえ」と読める（build_yojitsu.py の行と印）', async (t) => {
  const db = await openTestDb({t});
  const {categories, projects, login, post} = await setup(db);
  const admin = await login('admin@openingnight.invalid');
  const categoryId = (label) => (label === '流通売上' ? categories.channel : categories.investment);
  const first = await post(admin, payload(snapshot));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const today = first.body.imported[0].label.slice(TRIAL_IMPORT_PREFIX.length + 1);
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(first.body.imported.map((x) => [x.projectCode, x.projectId, x.versionNo, x.lineCount]), [
    ['TR-P01', projects['TR-P01'], 1, expected['1回目'].行.filter((r) => r.案件コード === 'TR-P01').length],
    ['TR-P02', projects['TR-P02'], 1, expected['1回目'].行.filter((r) => r.案件コード === 'TR-P02').length]]);
  assert.deepEqual(first.body.skipped.map((x) => x.reason), ['older_book']);
  // 同じ写しをもう一度送っても足さない（SHA-256 で見分ける）
  const again = await post(admin, payload(snapshot));
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.imported, again.body.skipped.map((x) => x.reason).sort()], [[], ['already_imported', 'already_imported', 'older_book']]);
  const second = await post(admin, payload(revised));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.deepEqual(second.body.imported.map((x) => [x.projectCode, x.versionNo]), [['TR-P01', 2]]);
  // DB の行（history で前の版も）と、build_yojitsu.py の2回目のあとの行・予測に使う印が同じ
  const versions = await store.readForecasts(db, 1, Object.values(projects), {history: true});
  assert.deepEqual(versions.map((v) => [v.projectId, v.versionNo, v.effective, v.sourceKind, v.label]), [
    [projects['TR-P01'], 1, false, 'trial_import', `${TRIAL_IMPORT_PREFIX} ${today}`], [projects['TR-P01'], 2, true, 'trial_import', `${TRIAL_IMPORT_PREFIX} ${today}`],
    [projects['TR-P02'], 1, true, 'trial_import', `${TRIAL_IMPORT_PREFIX} ${today}`]]);
  const superseded = new Set(expected['2回目'].前の行);
  const finalUse = (row) => (superseded.has(row.予測ID) ? false : row.予測に使う === 'はい');
  const pick = (code, versionNo) => versions.find((v) => v.projectId === projects[code] && v.versionNo === versionNo);
  const linesOf = (version) => version.lines.map(({scenario, month, categoryId: c, item, counterparty, amountYen, status, used}) => ({scenario, month, categoryId: c, item, counterparty, amountYen, status, used}));
  const expectLines = (rows, use) => rows.map((r) => {
    const {useForForecast, ...rest} = lineOf(r, categoryId);
    return {...rest, used: use(r)};
  });
  assert.deepEqual(linesOf(pick('TR-P01', 1)), expectLines(expected['1回目'].行.filter((r) => r.案件コード === 'TR-P01'), finalUse));
  assert.deepEqual(linesOf(pick('TR-P02', 1)), expectLines(expected['1回目'].行.filter((r) => r.案件コード === 'TR-P02'), finalUse));
  assert.deepEqual(linesOf(pick('TR-P01', 2)), expectLines(expected['2回目'].行, (r) => r.予測に使う === 'はい'));
  assert.ok(superseded.size > 0 && pick('TR-P01', 1).lines.every((l) => !l.used), '改めた写しの前の版の行は全部 予測に使う いいえ');
  // 有効な予測だけを読むと、前の版は出ない
  assert.deepEqual((await store.readForecasts(db, 1, Object.values(projects))).map((v) => [v.projectId, v.versionNo]), [[projects['TR-P01'], 2], [projects['TR-P02'], 1]]);
  // 変更の記録は版ごとに1行で、金額を残さない
  const audit = await db.all("SELECT entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='yojitsu_forecast_version' ORDER BY id");
  assert.deepEqual(audit.map((r) => r.entity_id), [`${projects['TR-P01']}:1`, `${projects['TR-P02']}:1`, `${projects['TR-P01']}:2`]);
  assert.ok(audit.every((r) => Object.keys(JSON.parse(r.detail_json)).every((key) => !/yen|amount/i.test(key))));
});

test('FR-REV-YOJITSU-026 照合が合わない写しは 400 で何も足さず、区分の選び方の誤りも 400', async (t) => {
  const db = await openTestDb({t});
  const {login, post} = await setup(db);
  const admin = await login('admin@openingnight.invalid');
  const count = async () => Number((await db.get('SELECT COUNT(*) AS n FROM yojitsu_forecast_versions WHERE org_id=1')).n);
  const bad = await post(admin, payload([snapshot[2], ...mismatch]));
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.details.errors.map((e) => e.field), ['snapshot', 'snapshot', 'snapshot']);
  assert.equal(await count(), 0, '合う冊（企画B）も足さない');
  // 窓口の売上を出金の区分に、出資を入金の区分に入れる選び方は断る
  assert.equal((await post(admin, payload(snapshot, {categories: {channel: 'investment', investment: 'distribution_sales'}}))).status, 400);
  assert.equal((await post(admin, payload(snapshot, {status: 'estimated'}))).status, 400);
  assert.equal((await post(admin, payload(snapshot, {excludedItems: '放送'}))).status, 400);
  assert.equal(await count(), 0);
});

// 受け口が案件の版のヘッダ（yojitsu_forecast_versions）を読んだ直後に、一度だけ race を流す DB（ほかの画面・取り込みが先に版を足した状況）
function racingDb(db) {
  const state = {race: null};
  const proxy = new Proxy(db, {get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    if (prop !== 'all') return value.bind(target);
    return async (sql, params) => {
      const rows = await value.call(target, sql, params);
      if (state.race && /FROM yojitsu_forecast_versions v WHERE/.test(sql)) {
        const run = state.race;
        state.race = null;
        await run();
      }
      return rows;
    };
  }});
  return {proxy, state};
}

// 窓口の売上だけの架空の試算の冊（入金サイト0か月・窓口 channels 本 × 月 months か月 × 3シナリオの行。入金の行は窓口の合計で照合が合う）
const serialOf = (iso) => Math.round((Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, 1) - Date.UTC(1899, 11, 30)) / 86_400_000);
function wideBook(name, sha256, {channels, months}) {
  const monthList = Array.from({length: months}, (_, i) => new Date(Date.UTC(2026, 9 + i, 1)).toISOString().slice(0, 10));
  const rows = [['入金サイト（月）', 0], ['シナリオ', '項目', '単位', ...monthList.map(serialOf)]];
  for (const scenario of ['even', 'good', 'MAX']) {
    for (let c = 1; c <= channels; c += 1) rows.push([scenario, `架空の窓口${c}`, '本', ...monthList.map(() => 1000 + c)]);
    rows.push([scenario, '入金', '円', ...monthList.map(() => Array.from({length: channels}, (_, c) => 1001 + c).reduce((a, b) => a + b, 0))]);
  }
  return {path: `ORG/企画/${name.includes('企画A') ? '架空企画A' : '架空企画B'}/30_提出版/${name}`, sha256, rows};
}

test('FR-REV-YOJITSU-026 版のヘッダを読んだあとにほかの書き込みが先に版を足していたら、受け口は 409 で、どの冊も足さない', async (t) => {
  const db = await openTestDb({t});
  const {proxy, state} = racingDb(db);
  const {categories, projects, login, post} = await setup(db, {appDb: proxy});
  const admin = await login('admin@openingnight.invalid');
  // 割り込む書き込み: 企画A の案件に手入力の版（行1つ）を足す
  state.race = async () => {
    const n = normalizeForecastVersionInput({projectId: projects['TR-P01'], previousVersionNo: 0, label: '架空の手入力', sourceKind: 'manual', source: '割り込んだ架空の手入力',
      createdOn: '2026-10-20', lines: [{scenario: 'good', month: '2026-12-01', categoryId: categories.channel, item: '架空の窓口', amountYen: 1000, status: 'provisional'}]},
    {categories: [{id: categories.channel}, {id: categories.investment}]});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addForecastVersion(db, 1, n.value, {createdBy: 1});
  };
  const res = await post(admin, payload(snapshot));
  assert.equal(state.race, null, '割り込みが流れた');
  assert.deepEqual([res.status, res.body.error], [409, 'ほかの画面で予測の版が足されました。読み直してから取り込んでください']);
  // 割り込んだ版だけが残り、企画B の版も足されない（1回の batch）
  const versions = await store.readForecasts(db, 1, Object.values(projects), {history: true});
  assert.deepEqual(versions.map((v) => [v.projectId, v.versionNo, v.sourceKind, v.source]), [[projects['TR-P01'], 1, 'manual', '割り込んだ架空の手入力']]);
  // 読み直して送れば、割り込んだ版の次の版として足せる
  const retry = await post(admin, payload(snapshot));
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.imported.map((x) => [x.projectCode, x.versionNo]), [['TR-P01', 2], ['TR-P02', 1]]);
});

test('FR-REV-YOJITSU-026 PostgreSQL で同じ案件の版を同時に足し、後の側が一意の制約の違反で落ちても、受け口は版の番号のトリガーと同じ 409 で、どの冊も足さない', async (t) => {
  const db = await openTestDb({t});
  const {proxy, state} = racingBatchDb(db, /INSERT INTO yojitsu_forecast_versions/);
  const {categories, projects, login, post} = await setup(db, {appDb: proxy});
  const admin = await login('admin@openingnight.invalid');
  // 割り込む書き込み: 受け口が版のヘッダを読んだあとに、企画A の案件に手入力の版1が先に入る。本物の PostgreSQL で同時に足すと、両方の版の番号の
  // トリガーが通り、後の側が一意の制約（組織・案件・版の番号）の違反（23505）で落ちる（SQLite・D1・PGlite では起きない）
  state.race = async () => {
    const n = normalizeForecastVersionInput({projectId: projects['TR-P01'], previousVersionNo: 0, label: '架空の手入力', sourceKind: 'manual', source: '割り込んだ架空の手入力',
      createdOn: '2026-10-20', lines: [{scenario: 'good', month: '2026-12-01', categoryId: categories.channel, item: '架空の窓口', amountYen: 1000, status: 'provisional'}]},
    {categories: [{id: categories.channel}, {id: categories.investment}]});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addForecastVersion(db, 1, n.value, {createdBy: 1});
  };
  state.error = pgUniqueViolation({table: 'yojitsu_forecast_versions', constraint: 'yojitsu_forecast_versions_org_id_project_id_version_no_key',
    columns: ['org_id', 'project_id', 'version_no'], values: [1, projects['TR-P01'], 1]});
  const res = await post(admin, payload(snapshot));
  assert.equal(state.race, null, '割り込みが流れた');
  assert.deepEqual([res.status, res.body.error, res.body.dbError?.kind], [409, 'ほかの画面で予測の版が足されました。読み直してから取り込んでください', 'unique']);
  // 割り込んだ版だけが残り、企画B の版も足されない
  const versions = await store.readForecasts(db, 1, Object.values(projects), {history: true});
  assert.deepEqual(versions.map((v) => [v.projectId, v.versionNo, v.sourceKind, v.source]), [[projects['TR-P01'], 1, 'manual', '割り込んだ架空の手入力']]);
});

test('FR-REV-YOJITSU-026 写しの冊の行を合わせると D1 の1回の batch（480文）を超えるときは、受け口は 413 で何も足さない', async (t) => {
  const db = await openTestDb({t});
  const {login, post} = await setup(db);
  const admin = await login('admin@openingnight.invalid');
  const count = async () => Number((await db.get('SELECT COUNT(*) AS n FROM yojitsu_forecast_versions WHERE org_id=1')).n);
  // 1冊 20窓口×40か月×3シナリオ = 2,400 行（1つの版の上限 3,824 行の内）。2冊で (1+300+1)×2 = 604 文
  const wide = [wideBook('売上試算_架空企画A_20261201.xlsx', 'a1'.repeat(32), {channels: 20, months: 40}),
    wideBook('売上試算_架空企画B_20261201.xlsx', 'b2'.repeat(32), {channels: 20, months: 40})];
  const plan = planTrialImport(wide, options());
  assert.deepEqual([plan.errors, plan.versions.map((v) => v.lines.length)], [[], [2400, 2400]]);
  const res = await post(admin, payload(wide));
  assert.deepEqual([res.status, res.body.error], [413, '試算の行が多すぎて1回で取り込めません（保存の処理 604件・上限 480件）。冊を分けて取り込んでください']);
  assert.equal(await count(), 0);
  // 1冊ずつなら取り込める
  const one = await post(admin, payload(wide.slice(0, 1)));
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.deepEqual(one.body.imported.map((x) => [x.projectCode, x.lineCount]), [['TR-P01', 2400]]);
  assert.equal(await count(), 1);
});

test('FR-REV-YOJITSU-005 試算の取り込みは財務の権限のある案件だけで、制作担当・権限の無い案件・別の組織には 403', async (t) => {
  const db = await openTestDb({t});
  const {login, post} = await setup(db);
  assert.equal((await post(await login('production@openingnight.invalid'), payload(snapshot))).status, 403);
  // 編集担当は試作の案件1にだけ edit を持つ。架空の企画の案件は権限が無い
  assert.equal((await post(await login('editor@openingnight.invalid'), payload(snapshot))).status, 403);
  // 別の組織の管理者には、組織1の案件コードは無いのと同じ（有無を見せず同じ 403）
  const outsider = await post(await login('outsider@other.invalid'), payload(snapshot));
  assert.deepEqual([outsider.status, outsider.body.error], [403, '試算を取り込む案件への権限がありません']);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM yojitsu_forecast_versions')).n), 0);
});
