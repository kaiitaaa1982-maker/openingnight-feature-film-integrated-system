import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocation, buildSearch, initialLocation, legacyInitial, createUrlStore, mapLegacyMode, LEGACY_REPORT_MODES} from '../src/shell/url-state.mjs';

function fakeEnv(search = '', storage = null) {
  const env = {
    search, pathname: '/', history: [], handlers: [], storage,
    push(url) { env.history.push(['push', url]); env.search = url.slice(1); },
    replace(url) { env.history.push(['replace', url]); env.search = url.slice(1); },
    listen(handler) { env.handlers.push(handler); return () => {}; },
    back(next) { env.search = next; for (const handler of env.handlers) handler(); },
  };
  return env;
}

test('buildSearch and parseLocation round-trip page, work and params', () => {
  const state = {page: '帳票センター', workId: 3, params: {report: 'mg-sales', month: '2026-09'}};
  const search = buildSearch(state);
  assert.equal(search, '?p=report-center&work=3&month=2026-09&report=mg-sales');
  assert.deepEqual(parseLocation(search), state);
  assert.deepEqual(parseLocation('?p=unknown-slug'), {page: 'ホーム', workId: null, params: {}});
  assert.deepEqual(parseLocation('?work=abc'), {page: null, workId: null, params: {}});
});

test('legacy report modes and legacy localStorage are migrated', () => {
  assert.equal(parseLocation('?p=report-center&mode=mg-portfolio').params.report, 'mg-sales');
  assert.equal(parseLocation('?p=report-center&mode=mg-portfolio').params.mode, undefined);
  assert.equal(mapLegacyMode('trend'), 'annual-sales');
  assert.equal(Object.keys(LEGACY_REPORT_MODES).length, 12);
  const storage = {getItem: (key) => ({'on-page': '流通マスタ', 'on-work': '2'}[key] ?? null)};
  assert.deepEqual(legacyInitial(storage), {page: '売上', workId: 2});
  assert.deepEqual(initialLocation('', storage), {page: '売上', workId: 2, params: {}});
  assert.deepEqual(initialLocation('?p=billing&work=5', storage), {page: '請求・入金', workId: 5, params: {}});
  const broken = {getItem: () => { throw new Error('blocked'); }};
  assert.deepEqual(legacyInitial(broken), {page: null, workId: null});
});

test('store pushes page moves, replaces param changes, and follows the back button', () => {
  const env = fakeEnv('?p=home&work=1');
  const store = createUrlStore(env);
  let changes = 0;
  store.subscribe(() => { changes += 1; });
  store.navigate({page: '帳票センター', workId: 1});
  assert.equal(env.history.at(-1)[0], 'push');
  store.setParam('report', 'annual-sales');
  assert.equal(env.history.at(-1)[0], 'replace');
  assert.equal(store.getSnapshot().params.report, 'annual-sales');
  store.setParam('p', 'x');
  assert.equal(store.getSnapshot().page, '帳票センター');
  env.back('p=home&work=1');
  assert.equal(store.getSnapshot().page, 'ホーム');
  assert.equal(changes, 3);
});

test('a guard can block the back button and report the blocked target', () => {
  const env = fakeEnv('?p=sales-data&work=1');
  const store = createUrlStore(env);
  let blocked = null;
  store.setGuard(() => false, (next) => { blocked = next; });
  env.back('p=home&work=1');
  assert.equal(store.getSnapshot().page, '売上データ編集');
  assert.equal(blocked.page, 'ホーム');
  assert.equal(env.history.at(-1)[0], 'push');
});

test('sales pages opened by URL or by the legacy localStorage keep their slug and sub-area', async () => {
  const {subAreaOf} = await import('../src/shell/nav-model.mjs');
  const royalty = parseLocation('?p=royalty-ledger&work=2&from=2025-04');
  assert.deepEqual(royalty, {page: 'ロイヤリティ集計', workId: 2, params: {from: '2025-04'}});
  assert.equal(subAreaOf(royalty.page), 'royalty');
  assert.equal(buildSearch(royalty), '?p=royalty-ledger&work=2&from=2025-04');
  assert.equal(subAreaOf(parseLocation('?p=committee-monthly').page), 'committee');
  const storage = {getItem: (key) => ({'on-page': 'MG契約・台帳'}[key] ?? null)};
  const initial = initialLocation('', storage);
  assert.equal(initial.page, 'MG契約・台帳');
  assert.equal(subAreaOf(initial.page), 'mg');
});
