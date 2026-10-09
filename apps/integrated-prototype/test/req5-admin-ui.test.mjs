// JSXそのものの通信・表示・ボタンを検証する。DOMとグリッド描画は軽量な代用品。
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import React from 'react';
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {ApiError} from '../src/ui/api-client.mjs';
import {hiddenPagesForRole} from '../src/shell/nav-model.mjs';

let active;
const shim = {...React,
  useState(initial) {const h = active, i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial; return [h.slots[i], (value) => {h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; h.dirty = true;}];},
  useId() {return 'test-id';}, useMemo(fn) {return fn();}, useCallback(fn) {return fn;}, useRef(value) {return shim.useState(() => ({current: value}))[0];},
  useEffect(fn, deps) {const h = active, i = h.cursor++, old = h.slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) {h.pending.push(() => {old?.cleanup?.(); h.slots[i] = {deps, cleanup: fn()};});}},
};
globalThis.__req5React = shim;
globalThis.__req5Shell = () => active.shell;
const output = await build({stdin: {contents: `export {DataBrowser} from './src/admin/DataBrowser.jsx'; export {ErPage} from './src/admin/ErPage.jsx'; export {default as DesignCanvas} from './src/DesignCanvas.jsx'; export {default as Definitions} from './src/Definitions.jsx'; export {AppShell} from './src/shell/AppShell.jsx';`, resolveDir: process.cwd()}, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'transform', plugins: [{name: 'view-test', setup(b) {
  b.onResolve({filter: /^react$/}, () => ({path: 'react', namespace: 'mock'}));
  b.onResolve({filter: /shell\/context\.mjs$|^\.\/context\.mjs$/}, () => ({path: 'shell', namespace: 'mock'}));
  b.onResolve({filter: /DataGrid\.jsx$/}, () => ({path: 'grid', namespace: 'mock'}));
  b.onResolve({filter: /\.css$/}, () => ({path: 'css', namespace: 'mock'}));
  b.onResolve({filter: /^\./}, (args) => ({path: resolve(args.resolveDir, args.path), namespace: 'source'}));
  b.onLoad({filter: /.*/, namespace: 'source'}, async ({path}) => ({contents: await readFile(path, 'utf8'), loader: path.endsWith('.jsx') ? 'jsx' : 'js', resolveDir: dirname(path)}));
  b.onLoad({filter: /.*/, namespace: 'mock'}, ({path}) => ({contents: path === 'react' ? 'export default globalThis.__req5React; export const {useState,useMemo,useCallback,useRef,useEffect,useId,cloneElement,isValidElement,createContext,useContext,useSyncExternalStore}=globalThis.__req5React;'
    : path === 'shell' ? 'export const useShell=globalThis.__req5Shell; export const LocalShellProvider=({children})=>children; export const ShellProvider=LocalShellProvider; export const lastPageOf=()=>null; export const lastSubPageOf=()=>null;'
    : path === 'grid' ? 'export function DataGrid(props){return globalThis.__req5React.createElement("data-grid",props)}' : ''}));
}}]});
const views = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

function mount(name, {role = 'admin', request, selected = '', props = {}} = {}) {
  const h = {slots: [], cursor: 0, pending: [], dirty: false, tree: null};
  h.shell = {role, request, getParam: (key, fallback) => key === 'table' ? selected : fallback, setParam() {}, navigate() {}};
  h.render = () => {active = h; h.cursor = 0; h.pending = []; h.dirty = false; h.tree = views[name](props); for (const effect of h.pending) effect();};
  h.flush = async () => {for (let n = 0; n < 8; n++) {await Promise.resolve(); if (h.dirty) h.render();}};
  h.close = () => {for (const slot of h.slots) slot?.cleanup?.();};
  h.render(); return h;
}
function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== 'object') return [tree];
  if (typeof tree.type === 'function' && !tree.type.prototype?.isReactComponent) return nodes(tree.type(tree.props));
  return [tree, ...nodes(tree.props?.children)];
}
const textOf = (h) => nodes(h.tree).filter((n) => typeof n === 'string' || typeof n === 'number').join(' ');
function click(h, label) {
  active = h;
  const button = nodes(h.tree).find((n) => n?.type === 'button' && nodes(n.props.children).join('') === label);
  assert.ok(button, `ボタン ${label}: ${textOf(h)}`);
  button.props.onClick(); h.render();
}

for (const role of ['admin', 'editor', 'production']) for (const org of [1, 2]) for (const name of ['DataBrowser', 'ErPage', 'DesignCanvas']) {
  test(`${name}/${role}/組織${org}: 遅延→失敗理由→再試行→0件`, async () => {
    let reject, calls = 0;
    const request = () => {calls++; return calls === 1 ? new Promise((_resolve, fail) => {reject = fail;}) : Promise.resolve({tables: [], mapping: {}, canReadRows: role === 'admin'});};
    const h = mount(name, {role, request});
    try {
      assert.match(textOf(h), /読み込み中/);
      reject(new ApiError(`組織${org}の取得に失敗（架空）`, {status: 500, kind: 'server'})); await h.flush();
      assert.match(textOf(h), new RegExp(`組織${org}の取得に失敗`));
      assert.doesNotMatch(textOf(h), /読み込み中/);
      click(h, '再試行'); await h.flush();
      assert.equal(calls, 2);
      assert.match(textOf(h), /0\s*(件|表)/);
      assert.match(textOf(h), role === 'production' ? /制作担当/ : /絞り込みはありません/);
    } finally {h.close();}
  });
}

for (const role of ['admin', 'editor', 'production']) test(`DataBrowser/${role}: 定義を最初に開き、行は管理者の明示操作時だけ取得`, async () => {
  const paths = [];
  const request = async (path) => {paths.push(path); if (path === '/admin/tables') return {tables: [], canReadRows: role === 'admin'};
    if (path.endsWith('/definition')) return {columns: [{name: 'id', type: 'INTEGER', pk: 1, notnull: 0, dflt_value: null}], foreignKeys: [], meanings: []};
    return {columns: ['id'], rows: [], total: 0, limit: 2000};};
  const h = mount('DataBrowser', {role, request, selected: 'works'});
  try {
    await h.flush();
    assert.ok(paths.includes('/admin/tables/works/definition'));
    assert.equal(paths.filter((path) => path.endsWith('/definition')).length, 1, '一覧の取得完了で定義を二重取得しない');
    assert.ok(!paths.includes('/admin/tables/works'));
    click(h, '行の中身'); await h.flush();
    assert.equal(paths.includes('/admin/tables/works'), role === 'admin');
    assert.match(textOf(h), role === 'admin' ? /0件/ : /この組織の管理者だけ/);
  } finally {h.close();}
});

test('設計・定義は通信不要と明示し、表の構造・データ一覧へ移動できる', () => {
  const h = mount('Definitions', {role: 'production', request: () => {throw new Error('通信しない');}});
  try {
    assert.match(textOf(h), /通信による読み込みはありません/);
    const destinations = [];
    h.shell.navigate = (page) => destinations.push(page); h.render();
    click(h, '表の構造を見る'); click(h, 'データ一覧を見る');
    assert.deepEqual(destinations, ['ER', 'データ一覧']);
  } finally {h.close();}
});

for (const role of ['admin', 'editor', 'production']) test(`メニュー/${role}: 常設入口と展開済み管理メニューから全設計画面へ届く`, () => {
  globalThis.document = {title: ''};
  const destinations = [];
  const baseShell = {getParam: (_key, fallback) => fallback, request: async () => ({}), navigate() {}};
  const h = mount('AppShell', {role, props: {session: {role, orgId: 1}, hiddenPages: hiddenPagesForRole(role), state: {page: 'ホーム', shell: baseShell, navigate: (page) => destinations.push(page)}, screens: {'ホーム': 'ホーム（架空）'}}});
  try {
    active = h;
    const all = nodes(h.tree);
    for (const slug of ['definitions', 'design-canvas', 'er', 'data']) assert.ok(all.some((n) => n?.type === 'a' && n.props.href === `?p=${slug}`));
    assert.equal(all.find((n) => n?.type === 'ul' && n.props.id === 'nav-group-admin').props.hidden, false);
    click(h, '管理・設計');
    assert.deepEqual(destinations, ['設計・定義']);
  } finally {h.close(); delete globalThis.document;}
});

for (const name of ['DataBrowser', 'ErPage', 'DesignCanvas']) test(`${name}: 組織切替後は旧画面の遅い応答を破棄する`, async () => {
  let resolveOld;
  const h = mount(name, {request: () => new Promise((resolve) => {resolveOld = resolve;})});
  h.close();
  const next = mount(name, {role: 'production', request: async () => ({tables: [], mapping: {}})});
  try {
    await next.flush();
    resolveOld({tables: [{name: 'DEMO-OLD', columns: [], foreignKeys: []}], mapping: {}});
    await next.flush();
    assert.doesNotMatch(textOf(next), /DEMO-OLD/);
    assert.match(textOf(next), /制作担当/);
  } finally {next.close();}
});
