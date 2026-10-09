// 外枠の文脈（ShellContext）。画面部品は API と URL の操作をここ（または props）経由でだけ使う。
// 設計キャンバスのプレビューでは LocalShellProvider が読み取り専用の request と、URL を書き換えない状態を与える。
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {createApi} from '../ui/api-client.mjs';
import {createUrlStore, parseLocation, paramsForWorkChange} from './url-state.mjs';
import {createUnsavedStore, shouldBlock, beforeUnloadHandler} from './unsaved.mjs';
import {redirectOf, rememberPage, rememberedPage, lastAreaKey} from './nav-model.mjs';

export const ShellContext = createContext(null);

let fallbackRequest = null;
const defaultRequest = (path, options) => {
  if (!fallbackRequest) fallbackRequest = createApi();
  return fallbackRequest(path, options);
};

// Provider が無いときの既定。URL を触らず、条件は呼び出し側のローカル状態に任せる。
const FALLBACK = Object.freeze({
  request: defaultRequest,
  navigate: () => {},
  readOnly: false,
  getParam: (key, fallback = null) => fallback,
  setParam: () => {},
  registerUnsaved: () => {},
  page: null,
  workId: null,
  isFallback: true,
});

export function useShell() {
  return useContext(ShellContext) || FALLBACK;
}

export function ShellProvider({value, children}) {
  return React.createElement(ShellContext.Provider, {value}, children);
}

function nextParams(params, key, value) {
  const next = {...params};
  if (value === null || value === undefined || value === '') delete next[key];
  else next[key] = String(value);
  return next;
}

// React の外（試験など）で使うローカルな文脈。setParam は内部の状態だけを変える。
export function createLocalShell({request = defaultRequest, readOnly = true, initialParams = {}, navigate = () => {}} = {}) {
  let params = {...initialParams};
  return {
    request, readOnly, navigate, isLocal: true, page: null, workId: null,
    getParam: (key, fallback = null) => (Object.hasOwn(params, key) ? params[key] : fallback),
    setParam: (key, value) => { params = nextParams(params, key, value); },
    registerUnsaved: () => {},
  };
}

// 設計キャンバスのプレビュー用。条件はこの中だけで保持し、URL・未保存登録・画面移動を外へ漏らさない。
export function LocalShellProvider({request, readOnly = true, initialParams = {}, onNavigate, children}) {
  const parent = useContext(ShellContext);
  const [params, setParams] = useState(initialParams);
  const value = useMemo(() => ({
    request: request || parent?.request || defaultRequest,
    navigate: onNavigate || (() => {}),
    readOnly,
    getParam: (key, fallback = null) => (Object.hasOwn(params, key) ? params[key] : fallback),
    setParam: (key, next) => setParams((previous) => nextParams(previous, key, next)),
    registerUnsaved: () => {},
    page: parent?.page ?? null,
    workId: parent?.workId ?? null,
    role: parent?.role ?? null,
    isLocal: true,
  }), [params, request, readOnly, onNavigate, parent]);
  return React.createElement(ShellContext.Provider, {value}, children);
}

function store(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch { /* 保存できない環境では無視 */ }
}

function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function lastPageOf(area) {
  try { return browserStorage()?.getItem(lastAreaKey(area)) ?? null; } catch { return null; }
}

// 売上基幹の業務（uriage・mg・royalty・committee）ごとに、最後に開いた画面
export function lastSubPageOf(sub) {
  return rememberedPage(browserStorage(), sub);
}

// URL の作品（requested）が今の組織の作品（works）にあるか。無ければ最初の作品に直し、missing に元の作品IDを入れる
// （作品を読み込む前＝works が空のときは判定しない）。黙って置き換えず、画面で知らせるために使う
export function resolveWork(requested, works = []) {
  const ids = (Array.isArray(works) ? works : []).map((work) => Number(work.id));
  const wanted = requested == null ? null : Number(requested);
  if (wanted != null && ids.includes(wanted)) return {workId: wanted, missing: null};
  return {workId: ids[0] ?? null, missing: wanted != null && ids.length ? wanted : null};
}

// 置き換えたときのお知らせ。canSwitchOrg は上部の「組織」の切替が出ているか（所属が2組織以上で一覧を読めたとき）。
// 切替が無い人には切替を案内せず、リンクを送った人に確かめるよう書く（権限の無い作品もあるので「この組織にありません」と言い切らない）
export function missingWorkNotice(missingWorkId, currentTitle = '', {canSwitchOrg = false} = {}) {
  const shown = currentTitle ? `いまは「${currentTitle}」を表示しています。` : '';
  if (!canSwitchOrg) return `指定の作品（作品ID ${missingWorkId}）は、いまの組織で開ける作品にありません。リンクを送った人に、作品と組織を確かめてください。${shown}`;
  return `指定の作品（作品ID ${missingWorkId}）は、いまの組織で開ける作品にありません。別の組織の作品かもしれません。上部の「組織」で切り替えてから、もう一度開いてください。${shown}`;
}

// アプリ本体の外枠の状態。URL（画面・作品・条件）、未保存の変更、移動の保留を持つ。
// works: 選べる作品（{id}）。URL の作品が選べないときは最初の作品に直し、missingWork で知らせる。
export function useAppShellState({request, works = []} = {}) {
  const storeRef = useRef(null);
  const unsavedRef = useRef(null);
  // 起動時に URL に作品が無く、前回の作品（localStorage）で始めたときは、その作品が今の組織に無くても知らせない（利用者が指定した作品ではない）
  const rememberedWorkRef = useRef(undefined);
  if (!storeRef.current) {
    const fromUrl = typeof window === 'undefined' ? null : parseLocation(window.location.search).workId;
    storeRef.current = createUrlStore();
    rememberedWorkRef.current = fromUrl == null ? storeRef.current.getSnapshot().workId : null;
  }
  if (!unsavedRef.current) unsavedRef.current = createUnsavedStore();
  const urlStore = storeRef.current;
  const unsaved = unsavedRef.current;
  const loc = useSyncExternalStore(urlStore.subscribe, urlStore.getSnapshot, urlStore.getSnapshot);
  const unsavedSnapshot = useSyncExternalStore(unsaved.subscribe, unsaved.getSnapshot, unsaved.getSnapshot);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    urlStore.setGuard(() => !shouldBlock(unsaved.total()), (next) => setPending({target: next, fromHistory: true}));
    return () => urlStore.setGuard(null, null);
  }, [urlStore, unsaved]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = beforeUnloadHandler(unsaved.total);
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [unsaved]);

  // 転送先の設定がある画面（統合で廃止した画面など）は、条件を引き継いで移す
  useEffect(() => {
    const redirect = redirectOf(loc.page);
    if (redirect) urlStore.navigate({page: redirect.page, workId: loc.workId, params: {...(redirect.params || {}), ...loc.params}}, {replace: true});
  }, [loc.page, loc.workId, loc.params, urlStore]);

  const resolved = resolveWork(loc.workId, works);
  const workId = resolved.workId;
  const [missingWork, setMissingWork] = useState(null);
  // 組織を切り替えるときは、読み直しが終わるまで前の組織の作品が works に残る。その間は URL に作品を書き戻さない
  // （前の組織の最初の作品IDを書き戻すと、読み直した後に「開ける作品にありません」が出てしまう）
  const worksRef = useRef(works);
  worksRef.current = works;
  const clearedWorksRef = useRef(null);
  useEffect(() => {
    if (!works.length) return;
    if (clearedWorksRef.current) {
      if (clearedWorksRef.current === works) return;
      clearedWorksRef.current = null;
    }
    const remembered = rememberedWorkRef.current;
    rememberedWorkRef.current = null;
    if (workId === loc.workId) return;
    // URL の作品が今の組織に無い（別の組織の作品のブックマーク・共有されたリンクなど）。置き換えたことを知らせる
    if (resolved.missing != null && resolved.missing !== remembered) setMissingWork(resolved.missing);
    urlStore.navigate({page: loc.page, workId, params: loc.params}, {replace: true});
  }, [works, works.length, workId, loc.workId, loc.page, loc.params, urlStore, resolved.missing]);

  useEffect(() => {
    store('on-page', loc.page);
    if (workId) store('on-work', String(workId));
    rememberPage(browserStorage(), loc.page);
  }, [loc.page, workId]);

  const go = useCallback((target, {force = false, replace = false} = {}) => {
    if (!force && shouldBlock(unsaved.total())) {
      setPending({target});
      return false;
    }
    setPending(null);
    urlStore.navigate(target, {replace});
    return true;
  }, [urlStore, unsaved]);

  // navigate(画面, 条件, {workId, replace, force, clearWork}) — workId を渡すと対象作品も同時に切り替える。
  // replace は履歴を積まない、force は未保存の確認を出さずに移る（退出のとき。呼ぶ側で先に確かめる）。
  // clearWork は対象作品を外す（組織を切り替えるとき。前の組織の作品IDを新しい組織へ持ち込まず、「この組織にありません」も出さない）
  const navigate = useCallback((page, params = {}, options = {}) => {
    const current = urlStore.getSnapshot();
    const target = {page, workId: options?.clearWork ? null : (options?.workId ?? current.workId), params: params || {}};
    if (options?.force) unsaved.clear();
    if (options?.clearWork) {
      setMissingWork(null);
      clearedWorksRef.current = worksRef.current;
    }
    return go(target, {replace: Boolean(options?.replace), force: Boolean(options?.force)});
  }, [go, urlStore, unsaved]);

  // 作品選択での移動では、作品に結び付く条件（台本の原本など）を持ち越さない（別の作品の原本IDで「指定の原本はこの作品にありません」が出ないように）
  const selectWork = useCallback((id) => {
    const current = urlStore.getSnapshot();
    setMissingWork(null);
    return go({page: current.page, workId: Number(id), params: paramsForWorkChange(current.params)});
  }, [go, urlStore]);

  const confirmPending = useCallback(() => {
    if (!pending) return;
    const target = pending.target;
    unsaved.clear();
    setPending(null);
    urlStore.navigate(target);
  }, [pending, unsaved, urlStore]);

  const cancelPending = useCallback(() => setPending(null), []);

  const shell = useMemo(() => ({
    request,
    navigate,
    readOnly: false,
    getParam: (key, fallback = null) => (Object.hasOwn(loc.params, key) ? loc.params[key] : fallback),
    setParam: (key, value, options) => urlStore.setParam(key, value, options),
    registerUnsaved: unsaved.register,
    page: loc.page,
    workId,
  }), [request, navigate, loc, urlStore, unsaved, workId]);

  const dismissMissingWork = useCallback(() => setMissingWork(null), []);
  return {page: loc.page, workId, params: loc.params, shell, navigate, selectWork, unsaved: unsavedSnapshot, pending, confirmPending, cancelPending, missingWork, dismissMissingWork};
}
