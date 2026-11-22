// 外枠（AppShell）の左メニューを JSX のまま描いて確かめる。DOMとグリッド描画は軽量な代用品。
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import React from 'react';
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {hiddenPagesForRole} from '../src/shell/nav-model.mjs';

let active;
const shim = {...React,
  useState(initial) {const h = active, i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial; return [h.slots[i], (value) => {h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; h.dirty = true;}];},
  useId() {return 'test-id';}, useMemo(fn) {return fn();}, useCallback(fn) {return fn;}, useRef(value) {return shim.useState(() => ({current: value}))[0];},
  useEffect(fn, deps) {const h = active, i = h.cursor++, old = h.slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) {h.pending.push(() => {old?.cleanup?.(); h.slots[i] = {deps, cleanup: fn()};});}},
};
globalThis.__req5React = shim;
globalThis.__req5Shell = () => active.shell;
const output = await build({stdin: {contents: `export {AppShell} from './src/shell/AppShell.jsx';`, resolveDir: process.cwd()}, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'transform', plugins: [{name: 'view-test', setup(b) {
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

// 2026-11-02: 管理・設計の欄（設計・定義・設計キャンバス・表の構造・拡張項目・データ一覧）を外した。チーム・取込履歴は「共通」の欄に並び、管理者だけに出る。
const REMOVED_SLUGS = ['definitions', 'design-canvas', 'er', 'extensions', 'data'];
for (const role of ['admin', 'editor', 'production']) test(`メニュー/${role}: 管理・設計の欄と設計の画面は出ず、チーム・取込履歴は管理者だけ共通の欄に出る`, () => {
  globalThis.document = {title: ''};
  const baseShell = {getParam: (_key, fallback) => fallback, request: async () => ({}), navigate() {}};
  const h = mount('AppShell', {role, props: {session: {role, orgId: 1}, hiddenPages: hiddenPagesForRole(role), state: {page: 'ホーム', shell: baseShell, navigate() {}}, screens: {'ホーム': 'ホーム（架空）'}}});
  try {
    active = h;
    const all = nodes(h.tree);
    const hrefs = all.filter((n) => n?.type === 'a').map((n) => n.props.href);
    for (const slug of REMOVED_SLUGS) assert.ok(!hrefs.includes(`?p=${slug}`), slug);
    assert.equal(all.some((n) => n?.type === 'ul' && n.props.id === 'nav-group-admin'), false);
    assert.equal(all.some((n) => n?.type === 'button' && nodes(n.props.children).join('') === '管理・設計'), false);
    assert.deepEqual(all.filter((n) => n?.type === 'nav').map((n) => n.props['aria-label']), ['フォルダ', '共通']);
    const common = all.find((n) => n?.type === 'ul' && n.props.id === 'nav-group-common');
    const commonHrefs = nodes(common).filter((n) => n?.type === 'a').map((n) => n.props.href);
    for (const slug of ['team', 'import-history']) assert.equal(commonHrefs.includes(`?p=${slug}`), role === 'admin', slug);
  } finally {h.close(); delete globalThis.document;}
});
