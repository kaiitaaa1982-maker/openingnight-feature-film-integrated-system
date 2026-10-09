// 作品・商品マスタ（WorkCatalog.jsx）の画面の論理。React に依存しない純関数。
// - 検索は全角半角・大文字小文字・ひらがなとカタカナ・空白の違いを吸収し、空白で区切った語をすべて含む行だけを残す。
// - 一覧は「作品×商品」の行。作品名で当たれば作品の全商品、商品名で当たればその商品の行だけを出す。
// - 放送局は番販・放送の放送枠（broadcast_slot_versions の最新版）から引く。差し戻し・中止の枠は数えない。

import {normalizeForMatch} from '../ui/entity-match.mjs';
import {labelOf} from '../ui/labels.mjs';

export const CATALOG_TABS = Object.freeze([
  Object.freeze({id: 'details', label: '作品情報'}),
  Object.freeze({id: 'broadcast', label: '放送ウィンドウ'}),
  Object.freeze({id: 'windows', label: '販売ウィンドウ'}),
  Object.freeze({id: 'history', label: '改訂履歴'}),
]);

// URL に持つ条件の名前（作品を切り替えても、戻る・再読込でも残す）
export const CATALOG_PARAMS = Object.freeze({tab: 'tab', query: 'q', year: 'year', month: 'month', flow: 'flow', matrixQuery: 'bq'});

export function catalogTab(value) {
  return CATALOG_TABS.some((tab) => tab.id === value) ? value : CATALOG_TABS[0].id;
}

// 検索語を正規化した語の配列にする。全角空白も区切りとして扱う。
export function searchTokens(query) {
  if (query === null || query === undefined) return [];
  return String(query).normalize('NFKC').split(/\s+/).map(normalizeForMatch).filter(Boolean);
}

// 文字列の配列（または1つの文字列）が、検索語をすべて含むか。検索語が空なら常に真。
export function matchesQuery(texts, query) {
  const tokens = Array.isArray(query) ? query : searchTokens(query);
  if (!tokens.length) return true;
  const haystack = (Array.isArray(texts) ? texts : [texts]).map(normalizeForMatch).join('\u0001');
  return tokens.every((token) => haystack.includes(token));
}

function editionFor(work, product) {
  if (!product || !work?.profile) return null;
  const binding = (work.profile.bindings || []).find((item) => item.product_id === product.id);
  if (!binding) return null;
  return (work.profile.editions || []).find((edition) => edition.edition_key === binding.edition_key) || null;
}

// 一覧の行。catalog = /api/work-catalog の応答（works, products, windows）。
// 戻り値: [{key, work, product|null, edition|null, windows:[...]}]
export function catalogRows(catalog, query = '') {
  const tokens = searchTokens(query);
  const works = catalog?.works || [];
  const products = catalog?.products || [];
  const windows = catalog?.windows || [];
  const rows = [];
  for (const work of works) {
    const own = products.filter((product) => product.work_id === work.id);
    for (const product of own.length ? own : [null]) {
      const edition = editionFor(work, product);
      const texts = [work.code, work.title, product?.sku, product?.name, edition?.name];
      if (!matchesQuery(texts, tokens)) continue;
      rows.push({
        key: `${work.id}:${product?.id ?? 0}`,
        work,
        product,
        edition,
        windows: product ? windows.filter((item) => item.work_id === work.id && item.product_id === product.id) : [],
      });
    }
  }
  return rows;
}

// 一覧に出た作品の数（行は商品単位なので作品は重複する）
export function workCount(rows) {
  return new Set((rows || []).map((row) => row.work.id)).size;
}

// 作品の検索（放送ウィンドウの作品×月の表）
export function filterWorks(works, query = '') {
  const tokens = searchTokens(query);
  return (works || []).filter((work) => matchesQuery([work.code, work.title], tokens));
}

const pad = (n) => String(n).padStart(2, '0');

// 日本時間の今日（YYYY-MM-DD）
export function jstToday(date = new Date()) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// 販売ウィンドウの状態（確認日 asOf 時点）。語彙は labels.mjs の availabilityStatus（条件未確定・条件確認済み・取り下げ）にそろえる。
export function windowState(row, asOf) {
  if (!row) return '未確認';
  if (row.status === 'withdrawn') return labelOf('availabilityStatus', 'withdrawn');
  if (row.status !== 'confirmed') return labelOf('availabilityStatus', 'draft');
  if (!row.release_on || !row.sales_end_on) return '条件確認済み・期間未確認';
  if (asOf && asOf < row.release_on) return '条件確認済み・解禁前';
  if (asOf && asOf > row.sales_end_on) return '条件確認済み・期間終了';
  return '条件確認済み・期間内';
}

// URL の文字列から年・月を読む。範囲外や数字でないときは既定値。
export function parseYear(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1900 && n <= 9999 ? n : fallback;
}

export function parseMonthNumber(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : fallback;
}

// 月の初日と末日（YYYY-MM-DD）
export function monthBounds(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}`};
}

const INACTIVE_SLOT = new Set(['rejected', 'cancelled']);

// 作品と期間に重なる放送枠の局。slots = /api/broadcast の slots（最新版）。
// from/to のどちらかが無いときは month（{from,to}）で代える。戻り値: [{name, statuses:[日本語], count}]（局名の順）
export function stationsFor(slots, {workId, from, to, month} = {}) {
  const start = from || month?.from || null;
  const end = to || month?.to || null;
  const byName = new Map();
  for (const slot of slots || []) {
    if (slot.work_id !== workId || INACTIVE_SLOT.has(slot.status)) continue;
    const name = String(slot.station_name || '').trim();
    if (!name) continue;
    if (start && slot.period_to && slot.period_to < start) continue;
    if (end && slot.period_from && slot.period_from > end) continue;
    const entry = byName.get(name) || {name, statuses: [], count: 0};
    entry.count += 1;
    const status = labelOf('broadcastStatus', slot.status);
    if (!entry.statuses.includes(status)) entry.statuses.push(status);
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

// 局の表示文。slots が未取得（null）なら「読み込み中」、取得失敗は呼び出し側で表示する。
export function stationText(stations, {loaded = true} = {}) {
  if (!loaded) return '放送枠を読み込み中…';
  if (!stations || !stations.length) return '放送枠は未登録（番販・放送で登録すると局名が出ます）';
  return stations.map((station) => `${station.name}（${station.statuses.join('・')}${station.count > 1 ? `・${station.count}枠` : ''}）`).join('、');
}

// 流通の表示名。distribution_master の1行から「劇場・RS」のように作る（流通名は見出し側に出す）。
function detailLabel(type) {
  const nameParts = new Set(String(type.distribution_name || '').split('_').filter(Boolean));
  const parts = [];
  for (const part of [...String(type.sales_type || '').split('_'), type.transaction_method]) {
    const text = String(part || '').trim();
    if (!text || nameParts.has(text) || text === type.distribution_name || parts.includes(text)) continue;
    parts.push(text);
  }
  return parts.join('・') || type.transaction_method || type.code;
}

const groupName = (type) => String(type.distribution_name || 'その他').replaceAll('_', '・');

// 流通の選択肢を流通名ごとの見出しに分ける。同じ見出しの中で表示が重なるときだけコードを添える。
export function distributionGroups(types) {
  const groups = [];
  const byName = new Map();
  for (const type of types || []) {
    const label = groupName(type);
    if (!byName.has(label)) { const group = {label, options: []}; byName.set(label, group); groups.push(group); }
    byName.get(label).options.push({value: type.code, label: detailLabel(type)});
  }
  for (const group of groups) {
    const counts = new Map();
    for (const option of group.options) counts.set(option.label, (counts.get(option.label) || 0) + 1);
    for (const option of group.options) if (counts.get(option.label) > 1) option.label = `${option.label}（${option.value}）`;
  }
  return groups;
}

// 流通コードの表示名（一覧のセル用）。未登録のコードは推測で訳さない。
export function distributionLabel(types, code) {
  if (code === null || code === undefined || code === '') return '未確認';
  const type = (types || []).find((item) => item.code === code);
  if (!type) return `未登録の流通（${code}）`;
  return `${groupName(type)}・${detailLabel(type)}`;
}

// 作品マスタの下書きが保存済みの版から変わっているか（未保存の保護に使う）
const comparable = (value) => JSON.stringify(value ?? null, (key, item) => (key === 'baseRevision' ? undefined : item === '' ? null : item));
export function profileChanged(saved, draft) {
  return comparable(saved) !== comparable(draft);
}
