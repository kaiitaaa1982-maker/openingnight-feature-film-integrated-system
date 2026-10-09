// 画面・作品・画面内の条件を URL の検索パラメータに持つ。形式: /?p=report-center&work=3&report=mg-sales&month=2026-09
// 画面の移動は pushState（戻るで前の画面へ）、条件の変更は replaceState（履歴を増やさない）。
// React に依存しない純粋なストア。ブラウザ以外（試験）では env を差し替える。
import {normalizePage} from '../navigation.mjs';
import {pageOfSlug, slugOf, HOME_PAGE} from './nav-model.mjs';

const RESERVED = new Set(['p', 'work']);

// 旧帳票センターの mode → 帳票カタログの id（PLAN §4.11）
export const LEGACY_REPORT_MODES = Object.freeze({
  trend: 'annual-sales', partner: 'sales-by-partner', work: 'sales-by-work', product: 'sales-by-product',
  distribution: 'sales-by-distribution', banpan: 'banpan', pnl: 'work-pnl', royalty: 'royalty-payments',
  committee: 'committee', joint: 'joint', mg: 'mg-work', 'mg-portfolio': 'mg-sales',
});

export function mapLegacyMode(mode) {
  return LEGACY_REPORT_MODES[String(mode || '')] || null;
}

function positiveId(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

// 作品に結び付く URL の条件（作品を替えたら外す）。artifact は台本・香盤の保存済み原本の ID
export const WORK_BOUND_PARAMS = Object.freeze(['artifact']);
export function paramsForWorkChange(params = {}) {
  return Object.fromEntries(Object.entries(params || {}).filter(([key]) => !WORK_BOUND_PARAMS.includes(key)));
}

export function parseLocation(search = '') {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const slug = sp.get('p');
  const page = slug ? pageOfSlug(slug) || HOME_PAGE : null;
  const workId = positiveId(sp.get('work'));
  const params = {};
  for (const [key, value] of sp) if (!RESERVED.has(key) && value !== '') params[key] = value;
  if (params.mode && !params.report) {
    const report = mapLegacyMode(params.mode);
    if (report) params.report = report;
    delete params.mode;
  }
  return {page, workId, params};
}

export function buildSearch({page, workId, params = {}} = {}) {
  const sp = new URLSearchParams();
  sp.set('p', slugOf(page || HOME_PAGE));
  if (positiveId(workId)) sp.set('work', String(workId));
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (RESERVED.has(key) || value === null || value === undefined || value === '') continue;
    sp.set(key, String(value));
  }
  return `?${sp.toString()}`;
}

// URL に画面がないとき（ブックマーク前の利用者）は、従来の localStorage の値を初期値に使う。
export function legacyInitial(storage) {
  const read = (key) => { try { return storage?.getItem?.(key) ?? null; } catch { return null; } };
  const raw = read('on-page');
  return {page: raw ? normalizePage(raw) : null, workId: positiveId(read('on-work'))};
}

export function initialLocation(search, storage) {
  const fromUrl = parseLocation(search);
  const legacy = legacyInitial(storage);
  return {page: fromUrl.page || legacy.page || HOME_PAGE, workId: fromUrl.workId ?? legacy.workId, params: fromUrl.params};
}

function sameState(a, b) {
  return a.page === b.page && a.workId === b.workId && JSON.stringify(a.params) === JSON.stringify(b.params);
}

function defaultEnv() {
  if (typeof window === 'undefined') return null;
  return {
    get search() { return window.location.search; },
    get pathname() { return window.location.pathname; },
    push: (url) => window.history.pushState(null, '', url),
    replace: (url) => window.history.replaceState(null, '', url),
    listen: (handler) => { window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); },
    storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  };
}

// URL ストア。subscribe/getSnapshot は React の useSyncExternalStore にそのまま渡せる。
// guard(next, prev) が false を返すと戻る操作を取り消し（URL を元に戻し）、onBlocked(next) を呼ぶ。
export function createUrlStore(env = defaultEnv(), {guard, onBlocked} = {}) {
  let state = initialLocation(env?.search || '', env?.storage);
  let guardFn = guard;
  let blockedFn = onBlocked;
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  const url = (next) => `${env?.pathname || '/'}${buildSearch(next)}`;
  if (env) env.replace(url(state));

  const store = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // 画面・作品の移動（履歴に積む）。params を省くと画面内の条件は消える。
    navigate({page = state.page, workId = state.workId, params = {}} = {}, {replace = false} = {}) {
      const next = {page: normalizePage(page), workId: positiveId(workId), params: {...params}};
      if (sameState(next, state)) return state;
      state = next;
      if (env) (replace ? env.replace : env.push)(url(state));
      emit();
      return state;
    },
    // 画面内の条件（タブ・帳票条件）の変更。既定は履歴を増やさない。
    setParam(key, value, {replace = true} = {}) {
      if (RESERVED.has(key)) return state;
      const params = {...state.params};
      if (value === null || value === undefined || value === '') delete params[key];
      else params[key] = String(value);
      const next = {...state, params};
      if (sameState(next, state)) return state;
      state = next;
      if (env) (replace ? env.replace : env.push)(url(state));
      emit();
      return state;
    },
    setWork(workId, {replace = false} = {}) {
      return store.navigate({page: state.page, workId, params: state.params}, {replace});
    },
    // 戻る・進む
    sync() {
      const next = initialLocation(env?.search || '', null);
      if (sameState(next, state)) return state;
      if (guardFn && guardFn(next, state) === false) {
        env?.push(url(state));
        blockedFn?.(next);
        return state;
      }
      state = next;
      emit();
      return state;
    },
    setGuard(nextGuard, nextBlocked) {
      guardFn = nextGuard;
      blockedFn = nextBlocked;
    },
    dispose: () => {},
  };
  if (env?.listen) store.dispose = env.listen(() => store.sync());
  return store;
}
