// 表示モード（香盤表 #9・K-3・K-18）。代表モードは左メニューに出す画面を11画面に絞る。既定は全表示で、URL とボタンからは全画面を開ける。
// 期待値は計画 plans/2026-10-08-phase1-five-second-yojitsu.md の K-18 から作る。前半は nav-model.mjs の関数、後半は AppShell の描画（DOM は最小の代用品）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import React from 'react';
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {
  ALL_PAGES, NAV_GROUPS, AREA_HOME, TOP_AREAS, visibleGroups, menuGroups, subAreaTabs, hiddenPagesForRole, displayLabel, describePage, areaOf, slugOf, SUB_AREAS,
  VIEW_MODES, DEFAULT_VIEW_MODE, VIEW_MODE_KEY, REPRESENTATIVE_PAGES, isViewMode, viewModeHiddenPages, menuHiddenPages, areaHomeFor, readViewMode, rememberViewMode,
} from '../src/shell/nav-model.mjs';
import {parseLocation} from '../src/shell/url-state.mjs';

// K-18 の11画面。[計画の語, ページID]。計画の語はページIDか表示名のどちらかで書かれている
const K18 = [
  ['ホーム', 'ホーム'], ['企画・作品', '企画・作品'], ['作品・商品マスタ', '作品・商品マスタ'], ['商品・営業', '商品・営業'],
  ['売上明細', '売上'], ['請求・入金', '請求・入金'], ['月別入金表', '月別消込'], ['経費', '経費'],
  ['作品の月別収支', '収支'], ['PL・BS', 'PL・BS'], ['帳票センター', '帳票センター'],
];
const K18_PAGES = K18.map(([, page]) => page);
const AREAS = ['work', 'eigyo', 'sales', 'shared'];

// 4つの領域の左メニューに出る全画面（売上基幹は2段目の業務をまたいで全部）
const menuPages = (hidden) => AREAS.flatMap((area) => visibleGroups(area, hidden).flatMap((group) => group.items.map((item) => item.page)));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {data, getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }};
}

// ---- 表示モードの定義（nav-model.mjs）----

test('代表モードのメニューは K-18 の11項目だけで、計画の語は画面のページIDか表示名と一致する', () => {
  assert.equal(K18.length, 11);
  for (const [word, page] of K18) assert.ok(word === page || displayLabel(page) === word, `${word} は ${page} のページIDでも表示名でもない`);
  assert.deepEqual([...REPRESENTATIVE_PAGES], K18_PAGES, 'REPRESENTATIVE_PAGES は K-18 の順');
  const shown = menuPages(viewModeHiddenPages('representative'));
  assert.equal(shown.length, 11);
  assert.deepEqual([...shown].sort(), [...K18_PAGES].sort());
  // 領域ごとの内訳: 業務基幹3・営業基幹1・売上基幹7（全部が計上の中）。管理・設計は出ない
  const byArea = Object.fromEntries(AREAS.map((area) => [area, visibleGroups(area, viewModeHiddenPages('representative')).flatMap((group) => group.items.map((item) => item.page)).sort()]));
  assert.deepEqual(byArea.work, ['ホーム', '作品・商品マスタ', '企画・作品'].sort());
  assert.deepEqual(byArea.eigyo, ['商品・営業']);
  assert.deepEqual(byArea.sales, ['PL・BS', '売上', '帳票センター', '月別消込', '経費', '請求・入金', '収支'].sort());
  assert.deepEqual(byArea.shared, []);
});

test('代表モードで外す画面は11画面以外の全部で、新しい画面は足すまで代表モードに出ない', () => {
  const hidden = viewModeHiddenPages('representative');
  assert.equal(hidden.size, ALL_PAGES.length - 11);
  for (const page of K18_PAGES) assert.ok(!hidden.has(page), page);
  assert.deepEqual([...hidden, ...K18_PAGES].sort(), [...ALL_PAGES].sort(), '外す画面と11画面で全画面になる（重ならない）');
  for (const page of ['全作品のウィンドウ', '売上集計シート', 'MG契約・台帳', '制作', '設計・定義', 'チーム']) assert.ok(hidden.has(page), page);
});

test('既定は全表示で、全表示は何も外さず既存のメニューを変えない。不明な値も全表示として扱う', () => {
  assert.equal(DEFAULT_VIEW_MODE, 'all');
  assert.deepEqual(VIEW_MODES.map((mode) => [mode.id, mode.label]), [['all', '全表示'], ['representative', '代表モード']]);
  for (const mode of ['all', undefined, null, '', 'nope', '__proto__']) assert.equal(viewModeHiddenPages(mode).size, 0, String(mode));
  assert.equal(isViewMode('all'), true);
  assert.equal(isViewMode('representative'), true);
  assert.equal(isViewMode('nope'), false);
  assert.equal(isViewMode(undefined), false);
  const hidden = new Set(['チーム']);
  assert.equal(menuHiddenPages('all', hidden), hidden, '全表示は役割で隠す集合をそのまま返す');
  assert.equal(menuPages(viewModeHiddenPages('all')).length, ALL_PAGES.length);
  for (const area of ['work', 'eigyo', 'shared']) assert.deepEqual(visibleGroups(area, menuHiddenPages('all')), visibleGroups(area), area);
  for (const sub of SUB_AREAS) assert.deepEqual(menuGroups('sales', sub.id, menuHiddenPages('all')), menuGroups('sales', sub.id), sub.id);
  assert.deepEqual(Object.keys(NAV_GROUPS), ['work', 'eigyo', 'sales', 'shared'], '既存のメニュー定義に領域を足していない');
});

test('役割で隠す画面と代表モードは重ねて効く（制作担当は11画面のうち業務基幹の3つだけ）', () => {
  const merged = (role) => menuHiddenPages('representative', hiddenPagesForRole(role));
  assert.deepEqual(menuPages(merged('production')).sort(), ['ホーム', '作品・商品マスタ', '企画・作品'].sort());
  assert.deepEqual(menuPages(merged('editor')).sort(), [...K18_PAGES].sort());
  assert.deepEqual(menuPages(merged('admin')).sort(), [...K18_PAGES].sort());
  // 代表モードの集合は役割の集合を壊さない
  const role = hiddenPagesForRole('production');
  const before = [...role];
  menuHiddenPages('representative', role);
  assert.deepEqual([...role], before);
});

test('代表モードの売上基幹は計上だけなので2段目の切り替えは1つになり、ほかの業務のメニューは空', () => {
  const hidden = viewModeHiddenPages('representative');
  assert.deepEqual(subAreaTabs('uriage', hidden).map((tab) => [tab.id, tab.pageCount]), [['uriage', 7]]);
  for (const sub of ['mg', 'royalty', 'committee']) assert.deepEqual(menuGroups('sales', sub, hidden), [], sub);
  assert.equal(menuGroups('sales', 'uriage', hidden).flatMap((group) => group.items).length, 7);
});

test('営業基幹の既定の行き先は、代表モードで商品・営業、全表示では従来の全作品のウィンドウ', () => {
  assert.equal(areaHomeFor('eigyo', 'representative'), '商品・営業');
  assert.equal(areaHomeFor('eigyo', 'all'), '全作品のウィンドウ');
  assert.equal(areaHomeFor('eigyo'), AREA_HOME.eigyo);
  const hidden = viewModeHiddenPages('representative');
  for (const area of TOP_AREAS) {
    assert.equal(areaHomeFor(area, 'all'), AREA_HOME[area], area);
    const home = areaHomeFor(area, 'representative');
    assert.equal(areaOf(home), area, `${area} の行き先がその領域の画面`);
    assert.ok(!hidden.has(home), `${area} の行き先 ${home} が代表モードのメニューから外れている`);
  }
});

test('URL からは代表モードでも全画面を開ける（表示モードは画面の解決に関わらない）', () => {
  for (const page of viewModeHiddenPages('representative')) assert.equal(parseLocation(`?p=${slugOf(page)}&work=1`).page, page, page);
});

test('表示モードは on-view-mode に覚え、保存できない環境・壊れた値でも落ちずに全表示で始める', () => {
  assert.equal(VIEW_MODE_KEY, 'on-view-mode');
  assert.ok(!VIEW_MODE_KEY.startsWith('on-last-'), '最後に開いた画面の記録と名前が重ならない');
  const storage = memoryStorage();
  assert.equal(readViewMode(storage), 'all');
  rememberViewMode(storage, 'representative');
  assert.equal(storage.getItem('on-view-mode'), 'representative');
  assert.equal(readViewMode(storage), 'representative');
  rememberViewMode(storage, 'all');
  assert.equal(readViewMode(storage), 'all');
  // 知らないモードは覚えない
  rememberViewMode(storage, 'representative');
  rememberViewMode(storage, 'nope');
  rememberViewMode(storage, undefined);
  assert.equal(storage.getItem('on-view-mode'), 'representative');
  // 壊れた値・保存できない環境
  storage.setItem('on-view-mode', '壊れた値');
  assert.equal(readViewMode(storage), 'all');
  const broken = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }};
  assert.doesNotThrow(() => rememberViewMode(broken, 'representative'));
  assert.equal(readViewMode(broken), 'all');
  assert.doesNotThrow(() => rememberViewMode(null, 'representative'));
  assert.equal(readViewMode(null), 'all');
  assert.equal(readViewMode(undefined), 'all');
});

// ---- 帳票センターの「よく使う」----

test('帳票センターの「よく使う」に作品別収支と月別入金表がある（予実は予実の画面ができるまで足さない）', async () => {
  const {featuredReports, REPORT_CATALOG} = await import('../src/reports/report-catalog.mjs');
  const featured = featuredReports().map((entry) => entry.id);
  assert.ok(featured.includes('work-pnl'), '作品別収支');
  assert.ok(featured.includes('receipts'), '月別入金表');
  assert.equal(REPORT_CATALOG.find((entry) => entry.id === 'work-pnl').label, '作品別収支');
  assert.equal(REPORT_CATALOG.find((entry) => entry.id === 'receipts').label, '月別入金表');
  // いまの画面に予実は無い。無い画面のカードを足していない。
  // 「よく使う」の予実のカードは、予実の画面ができる行（香盤表 #14・#15）で足す。足す行はこの表明を外し、予実のカードが featured であることを確かめる
  assert.ok(!REPORT_CATALOG.some((entry) => /予実/.test(entry.label)));
  // 月別入金表は専用画面（月別消込）を開くカードで、行き先が代表モードの11画面に入っている
  assert.equal(REPORT_CATALOG.find((entry) => entry.id === 'receipts').page, '月別消込');
  assert.ok(K18_PAGES.includes('月別消込'));
});

// ---- AppShell の描画 ----
// 画面の部品は react を差し替えた最小の代用品で動かす（test/req5-admin-ui.test.mjs と同じ方法）。localStorage はテストごとに差し込む。

let active;
const shim = {...React,
  useState(initial) {const h = active, i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial; return [h.slots[i], (value) => {h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; h.dirty = true;}];},
  useId() {return 'test-id';}, useMemo(fn) {return fn();}, useCallback(fn) {return fn;}, useRef(value) {return shim.useState(() => ({current: value}))[0];},
  useEffect(fn, deps) {const h = active, i = h.cursor++, old = h.slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) {h.pending.push(() => {old?.cleanup?.(); h.slots[i] = {deps, cleanup: fn()};});}},
};
globalThis.__viewModeReact = shim;
const output = await build({stdin: {contents: "export {AppShell} from './src/shell/AppShell.jsx';", resolveDir: process.cwd()}, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'transform', plugins: [{name: 'view-test', setup(b) {
  b.onResolve({filter: /^react$/}, () => ({path: 'react', namespace: 'mock'}));
  b.onResolve({filter: /shell\/context\.mjs$|^\.\/context\.mjs$/}, () => ({path: 'shell', namespace: 'mock'}));
  b.onResolve({filter: /\.css$/}, () => ({path: 'css', namespace: 'mock'}));
  b.onResolve({filter: /^\./}, (args) => ({path: resolve(args.resolveDir, args.path), namespace: 'source'}));
  b.onLoad({filter: /.*/, namespace: 'source'}, async ({path}) => ({contents: await readFile(path, 'utf8'), loader: path.endsWith('.jsx') ? 'jsx' : 'js', resolveDir: dirname(path)}));
  b.onLoad({filter: /.*/, namespace: 'mock'}, ({path}) => ({contents: path === 'react' ? 'export default globalThis.__viewModeReact; export const {useState,useMemo,useCallback,useRef,useEffect,useId,cloneElement,isValidElement,createContext,useContext,useSyncExternalStore}=globalThis.__viewModeReact;'
    : path === 'shell' ? 'export const useShell=()=>({}); export const LocalShellProvider=({children})=>children; export const ShellProvider=LocalShellProvider;'
    : ''}));
}}]});
const {AppShell} = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== 'object') return [tree];
  if (typeof tree.type === 'function' && !tree.type.prototype?.isReactComponent) return nodes(tree.type(tree.props));
  return [tree, ...nodes(tree.props?.children)];
}

// 外枠を描き、遷移を反映する。block=true は未保存で移動が止まる場合。
function mount({page = 'フォルダ一覧', role = 'admin', storage, mode = null, block = false, works = []} = {}) {
  const destinations = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (storage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', typeof storage === 'function' ? {get: storage, configurable: true} : {value: storage, configurable: true, writable: true});
  globalThis.document = {title: ''};
  const h = {slots: [], cursor: 0, pending: [], dirty: false, tree: null, destinations};
  const baseShell = {getParam: (_key, fallback) => fallback, request: async () => ({}), navigate() {}};
  const props = {session: {role, orgId: 1}, mode, bootstrap: {works}, hiddenPages: hiddenPagesForRole(role),
    state: {page, shell: baseShell, navigate: (target, params, options) => {
      destinations.push(target); h.lastOptions = options;
      if (h.block) return false;
      props.state.page = target;
      if (options?.workId) props.state.workId = options.workId;
      return true;
    }}, screens: {[page]: `${page}（架空）`}};
  h.block = block;
  h.setPage = (next) => {props.state.page = next; h.render();};
  h.render = () => {active = h; h.cursor = 0; h.pending = []; h.dirty = false; h.tree = AppShell(props); for (const effect of h.pending) effect();};
  h.close = () => {
    for (const slot of h.slots) slot?.cleanup?.();
    delete globalThis.document;
    delete globalThis.localStorage;
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
  };
  h.all = () => { active = h; return nodes(h.tree); };
  h.allMenuLinks = () => h.all().filter((n) => n?.type === 'a' && /^app-nav-item/.test(n.props.className || ''));
  // 左の列の一番上の「フォルダ一覧」は常設の入口なので、フォルダの中身の比べからは外す（別の試験で位置を見る）
  h.menuLinks = () => h.allMenuLinks().filter((n) => n.props.href !== '?p=folder-home');
  h.folderButtons = () => h.withClass('button', 'app-folder-head');
  h.folderButton = (id) => h.folderButtons().find((n) => h.text(n).startsWith(id));
  h.openFolders = () => h.folderButtons().filter((n) => n.props['aria-expanded']).map((n) => h.text(n).slice(0, 3));
  h.chooseFolder = (id) => {const button = h.folderButton(id); assert.ok(button); if (!button.props.disabled) button.props.onClick(); h.render();};
  h.menuSlugs = () => h.menuLinks().map((n) => n.props.href.replace('?p=', ''));
  h.modeButtons = () => h.all().find((n) => n?.type === 'div' && n.props.role === 'group' && n.props['aria-label'] === 'メニューの表示')?.props.children;
  h.pressedMode = () => h.modeButtons().find((button) => button.props['aria-pressed']).props.children;
  h.modeGroup = () => h.all().find((n) => n?.type === 'div' && n.props.role === 'group' && n.props['aria-label'] === 'メニューの表示');
  h.modeNote = () => h.all().find((n) => n?.type === 'p' && n.props.className === 'app-view-mode-note');
  h.withClass = (type, name) => h.all().filter((n) => n?.type === type && String(n.props.className || '').split(' ').includes(name));
  h.text = (node) => nodes(node.props.children).filter((n) => typeof n === 'string').join('');
  h.click = (label) => {
    const button = h.all().find((n) => n?.type === 'button' && nodes(n.props.children).filter((part) => typeof part === 'string').join('') === label);
    assert.ok(button, `ボタン ${label} が無い`);
    button.props.onClick(); h.render();
  };
  h.render();
  return h;
}

test('AppShell: 全フォルダと共通・管理が並び、旧区分のタブは出ない', () => {
  const h = mount({page: 'ホーム', storage: memoryStorage(), mode: 'local'});
  try {
    assert.deepEqual(h.modeButtons().map((button) => button.props.children), ['全表示', '代表モード']);
    assert.equal(h.pressedMode(), '全表示');
    assert.equal(h.folderButtons().length, 20);
    assert.deepEqual(h.openFolders(), []);
    assert.deepEqual(h.all().filter((n) => n?.type === 'nav').map((n) => n.props['aria-label']), ['フォルダ', '共通', '管理・設計']);
    assert.equal(h.all().filter((n) => n?.props?.role === 'tablist').length, 0);
    // 代表 2026-10-25「フォルダ一覧が、左側の一番上がいい」
    assert.equal(h.allMenuLinks()[0].props.href, '?p=folder-home');
    assert.equal(h.text(h.allMenuLinks()[0]), 'フォルダ一覧');
    assert.deepEqual(h.menuSlugs(), ['partners', 'work-data', 'demo', 'definitions', 'design-canvas', 'er', 'extensions', 'team', 'data', 'import-history', 'folders']);
    assert.deepEqual(h.folderButtons().filter((n) => n.props.disabled).map((n) => h.text(n).slice(0, 3)), ['F16', 'F17']);
  } finally { h.close(); }
});

test('AppShell: フォルダを押すと最初の画面を開き、開くフォルダは常に1つ', () => {
  const h = mount({page: 'ホーム'});
  try {
    h.chooseFolder('F12');
    assert.deepEqual(h.destinations, ['経費']);
    assert.deepEqual(h.openFolders(), ['F12']);
    assert.ok(h.menuSlugs().includes('expense-sheet'));
    assert.ok(!h.menuSlugs().includes('kikaku'));
    h.chooseFolder('F01');
    assert.deepEqual(h.openFolders(), ['F01']);
    assert.equal(h.destinations.at(-1), '企画');
    h.chooseFolder('F16');
    assert.equal(h.destinations.length, 2);
  } finally { h.close(); }
});

test('AppShell: URLと戻るで現在ページのフォルダが開き、選択中の画面が示される', () => {
  const h = mount({page: '経費集計シート'});
  try {
    assert.deepEqual(h.openFolders(), ['F12']);
    assert.equal(h.menuLinks().find((n) => n.props['aria-current'] === 'page').props.href, '?p=expense-sheet');
    h.setPage('MG 買付');
    assert.deepEqual(h.openFolders(), ['F09']);
    h.setPage('経費集計シート');
    assert.deepEqual(h.openFolders(), ['F12']);
    h.chooseFolder('F12');
    assert.deepEqual(h.destinations, [], '同じフォルダでは現在の画面を保つ');
  } finally { h.close(); }
});

test('AppShell: 未保存で移動を止めたときは元のフォルダを保ち、確定後のページに追従する', () => {
  const h = mount({page: '経費集計シート', block: true});
  try {
    h.chooseFolder('F06');
    assert.deepEqual(h.destinations, ['全作品のウィンドウ']);
    assert.deepEqual(h.openFolders(), ['F12']);
    h.setPage('全作品のウィンドウ');
    assert.deepEqual(h.openFolders(), ['F06']);
  } finally { h.close(); }
});

test('AppShell: 全表示・代表モードとも一覧に20フォルダがあり、代表は既存の対象画面だけ出す', () => {
  const h = mount({storage: memoryStorage()});
  try {
    assert.equal(h.withClass('section', 'app-folder-card').length, 20);
    assert.ok(h.menuSlugs().includes('mg-buy'));
    h.click('代表モード');
    assert.equal(h.pressedMode(), '代表モード');
    assert.equal(h.withClass('section', 'app-folder-card').length, 20);
    assert.deepEqual(h.menuSlugs().sort(), K18_PAGES.filter((p) => p !== 'ホーム').map(slugOf).sort());
    assert.equal(h.all().filter((n) => n?.type === 'nav').length, 1);
    assert.equal(h.folderButton('F09').props.disabled, true);
    h.chooseFolder('F06');
    assert.equal(h.destinations.at(-1), '商品・営業');
  } finally { h.close(); }
});

test('AppShell: 代表モードで対象外の画面をURLで開いても閲覧でき、空のフォルダは押せない', () => {
  const h = mount({page: 'MG契約・台帳', storage: memoryStorage({'on-view-mode': 'representative'})});
  try {
    assert.equal(h.folderButton('F10').props.disabled, true);
    assert.deepEqual(h.menuSlugs(), []);
    assert.ok(h.all().includes('MG契約・台帳（架空）'));
    h.chooseFolder('F12');
    assert.deepEqual(h.openFolders(), ['F12']);
    assert.deepEqual(h.menuSlugs(), ['expenses']);
  } finally { h.close(); }
});

test('AppShell: 表示モードを保存し、切り替えても現在ページとフォルダを保つ', () => {
  const storage = memoryStorage();
  const h = mount({page: '経費', storage});
  try {
    const before = h.menuSlugs();
    h.click('代表モード');
    assert.equal(storage.getItem('on-view-mode'), 'representative');
    assert.deepEqual(h.menuSlugs(), ['expenses']);
    assert.deepEqual(h.openFolders(), ['F12']);
    h.click('全表示');
    assert.equal(storage.getItem('on-view-mode'), 'all');
    assert.deepEqual(h.menuSlugs(), before);
  } finally { h.close(); }
});

test('AppShell: localStorageが無い・壊れている・読み書き不能でも全表示で始められる', () => {
  const broken = {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}};
  for (const storage of [undefined, broken, () => {throw Error('SecurityError');}, memoryStorage({'on-view-mode': '{', 'on-last-sales': '壊れた値'})]) {
    const h = mount({page: '企画・作品', storage});
    try {
      assert.equal(h.pressedMode(), '全表示');
      h.click('代表モード');
      assert.equal(h.pressedMode(), '代表モード');
      assert.deepEqual(h.menuSlugs().sort(), ['catalog', 'planning']);
    } finally { h.close(); }
  }
});

test('AppShell: 制作担当には財務のリンクが出ず、URLでも本文を見せない', () => {
  for (const viewMode of ['all', 'representative']) {
    const h = mount({page: '経費', role: 'production', storage: memoryStorage({'on-view-mode': viewMode})});
    try {
      assert.equal(h.folderButtons().length, 20);
      assert.equal(h.folderButton('F12').props.disabled, true);
      assert.ok(!h.menuSlugs().includes('expenses'));
      assert.ok(h.all().includes('この役割では表示しません'));
      assert.ok(!h.all().includes('経費（架空）'));
      h.chooseFolder('F02');
      if (viewMode === 'representative') assert.deepEqual(h.menuSlugs().sort(), ['catalog', 'planning']);
    } finally { h.close(); }
  }
});

test('AppShell: ロゴから一覧へ戻り、一覧のリンクから各画面へ移動できる', () => {
  const h = mount({page: '経費'});
  try {
    const logo = h.withClass('a', 'app-brand')[0];
    assert.equal(logo.props.href, '?p=folder-home');
    logo.props.onClick({preventDefault() {}}); h.render();
    assert.equal(h.destinations.at(-1), 'フォルダ一覧');
    assert.equal(h.withClass('section', 'app-folder-card').length, 20);
    h.menuLinks().find((n) => n.props.href === '?p=mg-buy').props.onClick({preventDefault() {}}); h.render();
    assert.equal(h.destinations.at(-1), 'MG 買付');
    assert.deepEqual(h.openFolders(), ['F09']);
  } finally { h.close(); }
});

// 子部品を実行せずに配線を調べる（EntityPicker 自体の操作は既存の試験に任せる）。
function elements(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}

test('AppShell: 一覧の作品選択はホームと作品IDを一度の遷移で渡す', () => {
  const h = mount({works: [{id: 7, title: '架空の作品'}]});
  try {
    const home = elements(h.tree).find((n) => n.type?.name === 'FolderHome');
    assert.ok(home);
    assert.deepEqual(home.props.works, [{id: 7, title: '架空の作品'}]);
    home.props.onSelectWork(7);
    assert.deepEqual(h.destinations, ['ホーム']);
    assert.deepEqual(h.lastOptions, {workId: 7});
  } finally { h.close(); }
});

test('AppShell: 説明文は画面に出さず、置き場所と並びで示す（全表示・代表モードとも。メニューの項目は title にだけ持つ）', () => {
  for (const [name, storage] of [['全表示', memoryStorage()], ['代表モード', memoryStorage({'on-view-mode': 'representative'})]]) {
    const h = mount({page: 'ホーム', storage});
    try {
      assert.equal(h.withClass('span', 'app-nav-desc').length, 0, `${name}: メニューの項目の下に説明が出ている`);
      assert.equal(h.withClass('p', 'app-page-desc').length, 0, `${name}: 見出しの下に説明が出ている`);
      assert.equal(h.withClass('details', 'app-page-note').length, 0, `${name}: 見出しの下に注記が出ている`);
      assert.equal(h.modeNote(), undefined, `${name}: 表示の切り替えに説明の文が出ている`);
      assert.equal(h.modeGroup().props['aria-describedby'], undefined, name);
      assert.equal(h.withClass('div', 'app-page-title')[0].props.title, undefined, name);
      for (const link of h.menuLinks()) {
        const page = [...ALL_PAGES].find((candidate) => `?p=${slugOf(candidate)}` === link.props.href);
        assert.equal(link.props.title, describePage(page), `${name}: ${page}`);
      }
    } finally { h.close(); }
  }
});
