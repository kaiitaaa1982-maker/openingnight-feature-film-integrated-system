// 取引先別の配信・販売リスト（営業基幹）の純関数。ブラウザ・Node・Worker で同じ結果を返す（node:* を使わない）。
// 設計: docs/platform/team-development/eigyo-sales-sheet-design.md §3。
// - 明細の状態（基準日から計算して保存しない）: 予定・取り下げ・開始前・期間中・終了間近・終了・自動更新・終了日未確認
// - 流通の照合: 流通ID（流通マスタ）と売上の流通分類（旧区分を含む）を「区分＋配信の種類」にそろえて比べる
// - 重なり（独占どうしは赤・ほかは注意。止めない）・再契約の空白・終了間近・契約中の取引先が無い流通・期間外の売上
// - 共通テンプレート（入力・記入例・記入ガイド・_meta）の列と、取込の計画（追加・修正・変更なし・取り下げ候補・エラー）
import {territoryKey} from './sales-catalog-model.mjs';
import {isOverseasTerritory} from '../sales/channel-group.mjs';
import {parseYen, parseInteger, parseDate, parseMonth} from '../ui/parse-input.mjs';

export const TEMPLATE_VERSION = 'partner-list-v1';
export const INPUT_SHEET = '入力';
export const REFERENCE_PREFIX = '参考_';
export const IMPORT_ROW_LIMIT = 2000;
export const PREVIEW_MINUTES = 30;
export const SOON_DAYS = Object.freeze([30, 60, 90]);

export const ENTRY_STATES = Object.freeze({
  upcoming: '開始前', active: '期間中', ending_soon: '終了間近', ended: '終了', auto_renew: '自動更新', end_unknown: '終了日未確認', planned: '予定', withdrawn: '取り下げ',
});
export const END_RULES = Object.freeze({date: '日付', auto_renew: '自動更新', perpetual: '期限なし', unknown: '未確認'});
export const EXCLUSIVITY = Object.freeze({exclusive: '独占', nonexclusive: '非独占', unknown: '未確認'});
export const ENTRY_STATUSES = Object.freeze({planned: '予定', contracted: '契約済', withdrawn: '取り下げ'});
export const SETTLEMENT_METHODS = Object.freeze({unverified: '未確認', FLAT: 'FLAT', MG: 'MG', RS: 'RS', other: 'その他'});
export const FIELD_VALUE_TYPES = Object.freeze({text: '文字', integer: '整数', yen: '金額（円）', date: '日付', month: '年月', choice: '選択肢'});
// 期間外の売上の照合の結果
export const SALE_MATCH = Object.freeze({
  in_period: '期間内', before_start: '契約開始前の売上', after_end: '契約終了後の売上', gap: '契約の空白期間の売上',
  no_contract: '契約済みの明細が無い（予定・取り下げだけ）', flow_mismatch: '流通が違う', not_listed: 'リストに作品が無い',
});
export const OUT_OF_PERIOD = Object.freeze(['before_start', 'after_end', 'gap', 'no_contract']);
// 期間の比べ方: 販売期間の月（既定・計上月と配信月がずれても月でそろえる）・販売期間の日・計上月
export const PERIOD_BASES = Object.freeze({month: '販売期間（月単位）', period: '販売期間（日単位）', accounting: '計上月'});

const DAY = 86400000;
const nfkc = (value) => (value === null || value === undefined ? '' : String(value).normalize('NFKC').trim());
const blank = (value) => value === null || value === undefined || String(value).trim() === '';
const OPEN_END = '9999-12-31';

export function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}
export function addMonthsYm(ym, n) {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
export const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// ---- 状態 ------------------------------------------------------------------------------------

// 期間の終わり（開いた終わりは null）。日付で終わる契約だけが終わりを持つ（自動更新・期限なし・未確認は開いた終わり）
export function effectiveEnd(version) {
  return version?.end_rule === 'date' ? version.contract_end || null : null;
}

// 基準日の状態。{key, daysLeft?, daysToStart?}
export function entryState(version, asOf, soonDays = 30) {
  if (!version) return null;
  if (version.status === 'withdrawn') return {key: 'withdrawn'};
  if (version.status === 'planned' || !version.contract_start) return {key: 'planned'};
  if (version.contract_start > asOf) return {key: 'upcoming', daysToStart: daysBetween(asOf, version.contract_start)};
  if (version.end_rule === 'date') {
    if (version.contract_end < asOf) return {key: 'ended'};
    const daysLeft = daysBetween(asOf, version.contract_end);
    return {key: daysLeft <= soonDays ? 'ending_soon' : 'active', daysLeft};
  }
  if (version.end_rule === 'auto_renew') return {key: 'auto_renew'};
  if (version.end_rule === 'perpetual') return {key: 'active', perpetual: true};
  return {key: 'end_unknown'};
}

export function stateText(state) {
  if (!state) return '';
  if (state.key === 'ending_soon') return `${ENTRY_STATES.ending_soon}（あと${state.daysLeft}日）`;
  if (state.key === 'active' && state.perpetual) return `${ENTRY_STATES.active}（期限なし）`;
  return ENTRY_STATES[state.key] || state.key;
}

// ---- 流通の照合 --------------------------------------------------------------------------------

const MASTER_GROUP = Object.freeze({'配給': 'theatrical', 'レンタル': 'rental', 'レンタル_RSS': 'rental', 'セル': 'sell', '配信': 'digital', '業務用VOD': 'digital', '放送': 'broadcast', '海外': 'overseas'});
const DIGITAL_SUBS = new Set(['EST', 'TVOD', 'SVOD', 'AVOD']);
export const FLOW_GROUP_LABELS = Object.freeze({theatrical: '劇場', rental: 'レンタル', sell: 'セル', package: 'ビデオグラム（区分未確認）', digital: '配信', broadcast: '放送', overseas: '海外', other: 'その他'});

// 流通（流通マスタの流通ID・旧区分）→ {group, sub}。地域が日本以外なら海外。
// info: {family, utilization, distribution_name, sales_type}（distribution_types と distribution_master の行）
export function flowOf(info = {}, territory = null) {
  if (!blank(territory) && isOverseasTerritory(territory)) return {group: 'overseas', sub: null};
  if (info?.distribution_name) {
    const group = MASTER_GROUP[info.distribution_name] || 'other';
    const sub = group !== 'digital' ? null : info.distribution_name === '業務用VOD' ? 'business' : DIGITAL_SUBS.has(info.sales_type) ? info.sales_type : null;
    return {group, sub};
  }
  const family = info?.family;
  if (family === 'theatrical') return {group: 'theatrical', sub: null};
  if (family === 'package') return {group: info.utilization === 'rental' ? 'rental' : info.utilization === 'sell' ? 'sell' : 'package', sub: null};
  if (family === 'digital') return {group: 'digital', sub: DIGITAL_SUBS.has(info.utilization) ? info.utilization : null};
  if (family === 'broadcast') return {group: 'broadcast', sub: null};
  return {group: 'other', sub: null};
}

const PACKAGE_GROUPS = new Set(['rental', 'sell', 'package']);
// 同じ流通として扱えるか。区分が同じで、配信の種類（EST・TVOD・SVOD・AVOD・業務用）が両方分かるときは同じもの。
// 区分未確認のビデオグラムはレンタル・セルの両方と照合する
export function flowsCompatible(a, b) {
  if (!a || !b) return false;
  if (a.group === 'package' || b.group === 'package') {
    if (!PACKAGE_GROUPS.has(a.group) || !PACKAGE_GROUPS.has(b.group)) return false;
  } else if (a.group !== b.group) return false;
  return !(a.sub && b.sub && a.sub !== b.sub);
}
export const flowText = (flow) => (flow ? `${FLOW_GROUP_LABELS[flow.group] || flow.group}${flow.sub ? `・${flow.sub === 'business' ? '業務用' : flow.sub}` : ''}` : '');

// 地域: 空欄は日本。全世界はすべて、全世界（日本を除く）は日本以外を含む
const tkey = (value) => territoryKey(blank(value) ? '日本' : value);
export function territoryCovers(outer, inner) {
  const o = tkey(outer), i = tkey(inner);
  if (o === i || o === 'WW') return true;
  if (o === 'WW_EX_JP') return i !== 'JP';
  return false;
}
export const territoriesIntersect = (a, b) => territoryCovers(a, b) || territoryCovers(b, a);

// ---- 重なり・空白・終了間近・契約中の取引先が無い流通 ---------------------------------------------

// entries: 最新の版 [{entry_id, list_id, partner_id, work_id, distribution_code, territory, contract_start, contract_end, end_rule, exclusivity, status, flow, renews_entry_id}]
const placed = (entry) => entry.status !== 'withdrawn' && Boolean(entry.contract_start);
const endOf = (entry) => effectiveEnd(entry) || OPEN_END;

// 同じ作品・同じ流通（照合できるもの）・重なる地域で、期間が重なる2つの明細。独占どうしは exclusive（赤）、ほかは caution（注意）
export function overlapPairs(entries) {
  const byWork = new Map();
  for (const entry of entries.filter(placed)) {
    if (!byWork.has(entry.work_id)) byWork.set(entry.work_id, []);
    byWork.get(entry.work_id).push(entry);
  }
  const pairs = [];
  for (const list of byWork.values()) {
    list.sort((x, y) => x.entry_id - y.entry_id);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i], b = list[j];
        if (!(a.distribution_code === b.distribution_code || flowsCompatible(a.flow, b.flow))) continue;
        if (!territoriesIntersect(a.territory, b.territory)) continue;
        if (!(a.contract_start <= endOf(b) && b.contract_start <= endOf(a))) continue;
        const to = [effectiveEnd(a), effectiveEnd(b)].filter(Boolean).sort()[0] || null;
        pairs.push({work_id: a.work_id, a: a.entry_id, b: b.entry_id, severity: a.exclusivity === 'exclusive' && b.exclusivity === 'exclusive' ? 'exclusive' : 'caution',
          from: a.contract_start > b.contract_start ? a.contract_start : b.contract_start, to});
      }
    }
  }
  return pairs;
}

// 契約の切れ目: 明細を開始日の順に並べ、それまでの明細をつないだ範囲の終わり（最も遅い終わり）の翌日より後に次が始まるところ。
// 長い契約の期間中に短い契約が並んでいても、長い契約が覆っていれば切れ目にしない。開いた終わりの明細の後に切れ目は無い。
// → [{prev: 範囲の終わりを持つ明細, next, from, to, days}]
function coverageHoles(list) {
  const sorted = [...list].sort((x, y) => (x.contract_start < y.contract_start ? -1 : x.contract_start > y.contract_start ? 1 : x.entry_id - y.entry_id));
  const holes = [];
  let cover = null; // {end: 最も遅い終わり（null は開いた終わり）, entry}
  for (const entry of sorted) {
    if (cover) {
      if (cover.end === null) break;
      if (entry.contract_start > addDays(cover.end, 1)) {
        holes.push({prev: cover.entry, next: entry, from: addDays(cover.end, 1), to: addDays(entry.contract_start, -1), days: daysBetween(cover.end, entry.contract_start) - 1});
      }
    }
    const end = effectiveEnd(entry);
    if (!cover || end === null || end > cover.end) cover = {end, entry};
  }
  return holes;
}

// 再契約の空白: 同じリスト・作品・流通ID・地域の明細をつないだ範囲の切れ目。
// renews_entry_id で指した再契約は（流通IDが違っても）両方の明細のまとまりをつないで、2つの間に切れ目があるときだけ出す
export function renewalGaps(entries) {
  const active = entries.filter(placed);
  const byId = new Map(active.map((entry) => [entry.entry_id, entry]));
  const pairs = new Map();
  const add = (prev, next, hole) => {
    const key = `${prev.entry_id}>${next.entry_id}`;
    if (!pairs.has(key)) pairs.set(key, {work_id: next.work_id, list_id: next.list_id, prev: prev.entry_id, next: next.entry_id, from: hole.from, to: hole.to, days: hole.days});
  };
  const groupKey = (entry) => `${entry.list_id}|${entry.work_id}|${entry.distribution_code}|${tkey(entry.territory)}`;
  const groups = new Map();
  for (const entry of active) {
    const key = groupKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const list of groups.values()) for (const hole of coverageHoles(list)) add(hole.prev, hole.next, hole);
  for (const entry of active) {
    const prev = entry.renews_entry_id ? byId.get(entry.renews_entry_id) : null;
    if (!prev || groupKey(prev) === groupKey(entry)) continue; // 同じまとまりは上で見た
    const end = effectiveEnd(prev);
    if (!end || entry.contract_start <= addDays(end, 1)) continue;
    const joined = [...groups.get(groupKey(prev)), ...groups.get(groupKey(entry))];
    for (const hole of coverageHoles(joined)) if (hole.from > end && hole.to < entry.contract_start) add(prev, entry, hole);
  }
  return [...pairs.values()].sort((x, y) => x.work_id - y.work_id || x.prev - y.prev || x.next - y.next);
}

// 基準日から maxDays 日以内に終わる契約（日付で終わる契約済みの明細）。区切りは 30・60・90 日
export function endingSoon(entries, asOf, maxDays = 90) {
  const limit = addDays(asOf, maxDays);
  const renewedIds = new Set(entries.filter((e) => e.status !== 'withdrawn' && e.renews_entry_id).map((e) => e.renews_entry_id));
  return entries
    .filter((e) => e.status === 'contracted' && e.end_rule === 'date' && e.contract_end >= asOf && e.contract_end <= limit)
    .map((e) => {
      const daysLeft = daysBetween(asOf, e.contract_end);
      const later = entries.some((x) => x.entry_id !== e.entry_id && x.status !== 'withdrawn' && x.list_id === e.list_id && x.work_id === e.work_id
        && x.distribution_code === e.distribution_code && tkey(x.territory) === tkey(e.territory) && x.contract_start && x.contract_start > e.contract_start);
      return {entry_id: e.entry_id, work_id: e.work_id, list_id: e.list_id, contract_end: e.contract_end, daysLeft, bucket: daysLeft <= 30 ? 30 : daysLeft <= 60 ? 60 : 90,
        renewed: renewedIds.has(e.entry_id) || later};
    })
    .sort((x, y) => x.daysLeft - y.daysLeft || x.entry_id - y.entry_id);
}

// 当社は売れる（条件確認済みの販売条件の期間中）のに、契約中（契約済みで基準日が期間内）の取引先が無い流通
// availabilities: [{work_id, distribution_code, territory, release_on, sales_end_on, status, flow}]
export function uncoveredFlows(availabilities, entries, asOf) {
  const out = [];
  for (const a of availabilities) {
    if (a.status !== 'confirmed' || !a.release_on || !a.sales_end_on || a.release_on > asOf || a.sales_end_on < asOf) continue;
    const related = entries.filter((e) => e.work_id === a.work_id && e.status !== 'withdrawn' && territoriesIntersect(e.territory, a.territory)
      && (e.distribution_code === a.distribution_code || flowsCompatible(e.flow, a.flow)));
    const covering = related.filter((e) => e.status === 'contracted' && e.contract_start <= asOf && asOf <= endOf(e));
    if (covering.length) continue;
    out.push({work_id: a.work_id, distribution_code: a.distribution_code, territory: a.territory, release_on: a.release_on, sales_end_on: a.sales_end_on,
      planned: related.filter((e) => e.status === 'planned').map((e) => e.entry_id), notCurrent: related.filter((e) => e.status === 'contracted').map((e) => e.entry_id)});
  }
  return out.sort((x, y) => x.work_id - y.work_id || (x.distribution_code < y.distribution_code ? -1 : 1));
}

// ---- 期間外の売上 --------------------------------------------------------------------------------

const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);
function saleSpan(sale, basis) {
  if (basis === 'accounting') return {from: sale.accounting_month, to: sale.accounting_month};
  if (basis === 'period') return {from: sale.sales_period_from, to: sale.sales_period_to};
  return {from: monthOf(sale.sales_period_from), to: monthOf(sale.sales_period_to)};
}
function entrySpan(entry, basis) {
  const end = effectiveEnd(entry);
  if (basis === 'period') return {from: entry.contract_start, to: end || OPEN_END};
  return {from: monthOf(entry.contract_start), to: end ? monthOf(end) : '9999-12'};
}

// 期間をつないだ範囲。次の期間が「前の範囲の終わりの翌日（月単位は翌月）」までに始まれば1つの範囲にする
function joinedRanges(spans, basis) {
  const next = (to) => (to.startsWith('9999') ? to : basis === 'period' ? addDays(to, 1) : addMonthsYm(to, 1));
  const ranges = [];
  for (const s of [...spans].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0))) {
    const last = ranges.at(-1);
    if (last && s.from <= next(last.to)) { if (s.to > last.to) last.to = s.to; } else ranges.push({from: s.from, to: s.to});
  }
  return ranges;
}

// 売上1件（作品に配賦した後の1件）と、その取引先（またはリストの請求先）の同じ作品の明細（最新の版）を照合する。
// sale: {sales_period_from, sales_period_to, accounting_month, territory, flow}
export function classifySale(sale, candidates, basis = 'month') {
  if (!candidates.length) return {status: 'not_listed', entryIds: []};
  const compatible = candidates.filter((e) => e.status !== 'withdrawn' && territoryCovers(e.territory, sale.territory)
    && ((sale.code && e.distribution_code === sale.code) || flowsCompatible(e.flow, sale.flow)));
  if (!compatible.length) return {status: 'flow_mismatch', entryIds: []};
  const contracted = compatible.filter((e) => e.status === 'contracted' && e.contract_start);
  if (!contracted.length) return {status: 'no_contract', entryIds: compatible.map((e) => e.entry_id)};
  const span = saleSpan(sale, basis);
  const spans = contracted.map((e) => ({entry: e, ...entrySpan(e, basis)}));
  // 契約をつないだ範囲（切れ目なく続く契約は1つの範囲）に売上の期間が収まれば期間内。入る明細は売上の期間と重なる明細
  const range = joinedRanges(spans, basis).find((r) => r.from <= span.from && span.to <= r.to);
  if (range) return {status: 'in_period', entryIds: spans.filter((s) => s.from <= span.to && span.from <= s.to).map((s) => s.entry.entry_id)};
  const ids = contracted.map((e) => e.entry_id);
  const earliest = spans.map((s) => s.from).sort()[0];
  if (span.from < earliest) return {status: 'before_start', entryIds: ids};
  const latest = spans.map((s) => s.to).sort().at(-1);
  if (span.to > latest) return {status: 'after_end', entryIds: ids};
  return {status: 'gap', entryIds: ids};
}

// ---- テンプレートの列 -----------------------------------------------------------------------------

// 固定の列（全取引先で同じ）。type: int|code|text|date|select|yen|percent
export const FIXED_COLUMNS = Object.freeze([
  {key: 'entry_id', header: '明細ID', type: 'int', hint: '空欄は新しい明細。出力したファイルの明細IDを残した行は、その明細の修正（次の版）', example: ''},
  {key: 'version', header: '版', type: 'int', hint: '出力したときの版。いまの版と違う行は取り込みません（出力の後に別の人が直したため）。空欄は照合しない', example: ''},
  {key: 'work_code', header: '作品コード', type: 'code', required: true, hint: '作品・商品マスタの作品コード', example: 'DEMO-W01'},
  {key: 'product_sku', header: '商品SKU', type: 'code', hint: '任意。作品に配賦した商品だけ', example: ''},
  {key: 'distribution_code', header: '流通ID', type: 'code', required: true, hint: '流通マスタの流通ID（販売種別・取引方法は流通マスタから引きます）', example: 'D005'},
  {key: 'territory', header: '地域', type: 'text', max: 100, hint: '空欄は日本', example: '日本'},
  {key: 'contract_start', header: '契約開始日', type: 'date', hint: '状態が「契約済」なら必須', example: '2026-04-01'},
  {key: 'contract_end', header: '契約終了日', type: 'date', hint: '終了の扱いが「日付」なら必須。自動更新は今の期間の終わりを入れてもよい', example: '2027-03-31'},
  {key: 'end_rule', header: '終了の扱い', type: 'select', options: END_RULES, hint: '空欄は、契約終了日があれば「日付」、無ければ「未確認」', example: '日付'},
  {key: 'announce_on', header: '告知解禁日', type: 'date', hint: '任意', example: ''},
  {key: 'exclusivity', header: '独占', type: 'select', options: EXCLUSIVITY, hint: '空欄は未確認', example: '非独占'},
  {key: 'status', header: '状態', type: 'select', options: ENTRY_STATUSES, hint: '空欄は、新しい明細なら予定、修正なら今の状態のまま', example: '契約済'},
  {key: 'settlement_method', header: '取引方法', type: 'select', options: SETTLEMENT_METHODS, hint: '空欄は未確認', example: 'RS'},
  {key: 'amount_ex_tax', header: '契約金額（税抜）', type: 'yen', hint: 'FLAT・MG の金額（円・整数）', example: ''},
  {key: 'rate_percent', header: '料率（%）', type: 'percent', hint: 'RS の料率（0〜100、小数は2桁まで）', example: '50'},
  {key: 'partner_work_code', header: '取引先側の作品コード', type: 'text', max: 200, hint: '取引先の管理コード', example: 'PF-000123（架空）'},
  {key: 'partner_category', header: '取引先側の区分', type: 'text', max: 200, hint: '取引先の書類の区分の原文（見放題・レンタルなど）', example: '見放題'},
  {key: 'billing_partner_code', header: '請求先の取引先コード', type: 'code', hint: '売上の相手（代理店など）がリストの取引先と違うとき', example: ''},
  {key: 'agreement_code', header: '販売契約コード', type: 'code', hint: '作品1本の販売契約があるときだけ', example: ''},
  {key: 'source_reference', header: '根拠', type: 'text', max: 1000, hint: '契約書・許諾通知書などの参照', example: '許諾通知書 2026-03（架空）'},
  {key: 'note', header: '備考', type: 'text', max: 1000, hint: '', example: ''},
  {key: 'renews_entry_id', header: '再契約元の明細ID', type: 'int', hint: '新しい明細が前の明細の再契約のとき。空欄なら同じ作品・流通ID・地域で先に終わった明細を探して結びます', example: ''},
]);
const FIXED_BY_KEY = new Map(FIXED_COLUMNS.map((column) => [column.key, column]));
export const headerKey = (value) => nfkc(value).replace(/[\s_　]+/g, '').toLowerCase();

const optionList = (options) => Object.values(options);
// 追加の列の見出しは表示名。固定の列と同じ見出しは使えない
export function reservedHeaders() {
  return new Set([...FIXED_COLUMNS.map((c) => headerKey(c.header))]);
}

// 入力シートの列（固定 → 追加の列 → 参考の列）
export function templateColumns(fields = [], {reference = false} = {}) {
  // 料率の列は空の行まで文字の書式にする（標準の書式のセルに Excel で「50%」と入れると 0.5 で保存され、0.5% と読めてしまうため）
  const columns = FIXED_COLUMNS.map((column) => ({key: column.key, label: column.header, type: column.type === 'select' || column.type === 'percent' ? 'text' : column.type === 'int' ? 'int' : column.type,
    width: column.type === 'text' ? 22 : undefined, ...(column.type === 'percent' ? {wholeColumnFormat: true} : {})}));
  for (const field of fields) columns.push({key: `f:${field.id}`, label: field.label, type: field.value_type === 'yen' ? 'yen' : field.value_type === 'integer' ? 'int' : field.value_type === 'date' ? 'date' : 'text'});
  if (reference) {
    columns.push({key: 'ref_work_title', label: `${REFERENCE_PREFIX}作品名`, type: 'text', width: 24});
    columns.push({key: 'ref_distribution', label: `${REFERENCE_PREFIX}流通名・販売種別`, type: 'text', width: 20});
    columns.push({key: 'ref_state', label: `${REFERENCE_PREFIX}状態（基準日）`, type: 'text', width: 16});
  }
  return columns;
}

const percentText = (bps) => (bps === null || bps === undefined ? null : String(Number((bps / 100).toFixed(2))));
const fieldCellValue = (field, value) => {
  if (!value) return null;
  if (field.value_type === 'yen' || field.value_type === 'integer') return value.n ?? null;
  return value.t ?? null;
};

// 明細（最新の版）→ 入力シートの1行
export function entrySheetRow(entry, fields = [], {asOf, soonDays} = {}) {
  const row = {
    entry_id: entry.entry_id, version: entry.version_no, work_code: entry.work_code, product_sku: entry.product_sku || null, distribution_code: entry.distribution_code,
    territory: entry.territory, contract_start: entry.contract_start, contract_end: entry.contract_end, end_rule: END_RULES[entry.end_rule], announce_on: entry.announce_on,
    exclusivity: EXCLUSIVITY[entry.exclusivity], status: ENTRY_STATUSES[entry.status], settlement_method: SETTLEMENT_METHODS[entry.settlement_method],
    amount_ex_tax: entry.amount_ex_tax, rate_percent: percentText(entry.rate_bps), partner_work_code: entry.partner_work_code, partner_category: entry.partner_category,
    billing_partner_code: entry.billing_partner_code || null, agreement_code: entry.agreement_code || null, source_reference: entry.source_reference, note: entry.note,
    renews_entry_id: entry.renews_entry_id || null,
    ref_work_title: entry.work_title, ref_distribution: [entry.distribution_name, entry.sales_type].filter(Boolean).join('・'),
    ref_state: asOf ? stateText(entryState(entry, asOf, soonDays)) : '',
  };
  for (const field of fields) row[`f:${field.id}`] = fieldCellValue(field, entry.fields?.[field.id]);
  return row;
}

// テンプレート（template）・現在の明細（current）の4シート。encodeReportXlsx にそのまま渡せる
export function partnerListSheets({list, fields = [], rows = [], kind = 'template', generatedAt = new Date().toISOString(), fieldSetHash = '', distributionCodes = [], asOf = null}) {
  const columns = templateColumns(fields, {reference: kind === 'current'});
  const headerKinds = Object.fromEntries(columns.map((column) => [column.key, column.key.startsWith('ref_') ? 'reference' : FIXED_BY_KEY.get(column.key)?.required ? 'required' : 'optional']));
  const validations = [
    ...FIXED_COLUMNS.filter((c) => c.type === 'select').map((c) => ({key: c.key, list: optionList(c.options)})),
    ...fields.filter((f) => f.value_type === 'choice' && f.options?.length).map((f) => ({key: `f:${f.id}`, list: f.options})),
  ];
  if (distributionCodes.length) validations.push({key: 'distribution_code', list: distributionCodes});
  const input = {name: INPUT_SHEET, titleBand: false, freezeCols: 3, columns, rows, headerKinds, validations};
  const example = Object.fromEntries(FIXED_COLUMNS.map((c) => [c.key, c.example ?? '']));
  for (const field of fields) example[`f:${field.id}`] = field.value_type === 'choice' ? field.options?.[0] || '' : '';
  const exampleSheet = {name: '記入例', title: `${list.partner_name} ${list.name}の記入例（このシートは登録されません）`, columns: templateColumns(fields), rows: [example], freezeCols: 1,
    notes: ['この例の値はすべて架空です。']};
  const typeText = {int: '整数', code: 'コード（文字）', text: '文字', date: '日付（2026-04-01）', select: '選択', yen: '金額（円・整数）', percent: '割合（%）'};
  const guide = {
    name: '記入ガイド', title: `${list.partner_name} ${list.name}（${list.kind_label}）の記入ガイド`,
    conditions: [['登録されるシート', `「${INPUT_SHEET}」だけ`], ['照合', '明細IDのある行はその明細の修正、空欄は新しい明細'], ['全件の取込', '「リスト全件」で読み込むと、ファイルに無い明細を取り下げの候補として示します']],
    columns: [{key: 'header', label: '列', type: 'text'}, {key: 'required', label: '必須', type: 'text'}, {key: 'type', label: '形式', type: 'text'},
      {key: 'hint', label: '説明', type: 'text', wrap: true, width: 60}, {key: 'options', label: '選択肢', type: 'text', wrap: true, width: 30}],
    rows: [
      ...FIXED_COLUMNS.map((c) => ({header: c.header, required: c.required ? '必須' : '任意', type: typeText[c.type] || '文字', hint: c.hint || '', options: c.type === 'select' ? optionList(c.options).join('・') : ''})),
      ...fields.map((f) => ({header: f.label, required: '任意', type: `追加の列（${FIELD_VALUE_TYPES[f.value_type]}）`, hint: f.scope_text || '', options: f.value_type === 'choice' ? (f.options || []).join('・') : ''})),
    ],
    notes: [
      '1行でもエラーがあれば、ファイル全体を登録しません。エラーの行は理由つきの Excel で受け取れます。',
      '「参考_」で始まる列と、知らない見出しの列は読みません。無い列は変更しません。ある列の空欄は空にします（状態の空欄は今の状態のまま）。',
      '再契約は新しい明細（明細IDは空欄）として入れます。前の明細は残り、再契約の間の空白は「確認」に出ます。',
      '保存値の全角・半角は変えません（コードの照合だけ全角半角をそろえます）。',
    ],
    freezeCols: 1,
  };
  const meta = {name: '_meta', hidden: true, titleBand: false, freezeCols: 0, columns: [{key: 'k', label: 'key', type: 'text'}, {key: 'v', label: 'value', type: 'text'}],
    rows: [{k: 'template', v: TEMPLATE_VERSION}, {k: 'kind', v: kind}, {k: 'list_id', v: String(list.id)}, {k: 'partner_code', v: list.partner_code}, {k: 'list_name', v: list.name},
      {k: 'field_set', v: fieldSetHash}, {k: 'as_of', v: asOf || ''}, {k: 'generated_at', v: generatedAt}]};
  return kind === 'current' ? [input, guide, meta] : [input, exampleSheet, guide, meta];
}

// 追加の列の組み合わせの印（テンプレートの _meta に入れ、取込で照合する）
export const fieldSetText = (fields) => fields.map((f) => `${f.field_key}:${f.value_type}`).join(',');

// 読み込んだ Excel（decodeXlsx の結果）→ {headers, rows: [{rowNo, cells}], meta}
export function tableFromPartnerListSheets(sheets) {
  const list = Array.isArray(sheets) ? sheets : [];
  const meta = list.find((sheet) => sheet.name === '_meta');
  const metaMap = meta ? Object.fromEntries((meta.rows || []).slice(1).map((row) => [String(row?.[0] ?? ''), String(row?.[1] ?? '')])) : null;
  const sheet = list.find((item) => item.name === INPUT_SHEET) || list.find((item) => !['記入例', '記入ガイド', '_meta', '失敗行'].includes(item.name) && !/^選択肢/.test(item.name) && !item.error);
  if (sheet?.error) throw new Error(`「${sheet.name}」シートに数式のセルがあります。Excelで数式を値に変換してから保存してください`);
  if (!sheet || !sheet.rows?.length) throw new Error(`「${INPUT_SHEET}」のシートが見つかりません。テンプレートか出力したExcelを使ってください`);
  const [headers = [], ...rows] = sheet.rows;
  return {headers: headers.map((value) => (value === null || value === undefined ? '' : String(value))), rows: rows.map((cells, index) => ({rowNo: index + 2, cells: cells || []})), meta: metaMap};
}

// ---- 取込の計画 ------------------------------------------------------------------------------------

function parsePercentToBps(raw) {
  const text = nfkc(raw).replace(/[%％\s,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return {error: '料率（%）は0〜100の数（小数は2桁まで）で入れてください'};
  const bps = Math.round(Number(text) * 100);
  if (bps < 0 || bps > 10000) return {error: '料率（%）は0〜100にしてください'};
  return {value: bps};
}
function parseSelect(column, raw) {
  const text = nfkc(raw);
  const hit = Object.entries(column.options).find(([code, label]) => code.toLowerCase() === text.toLowerCase() || nfkc(label) === text);
  return hit ? {value: hit[0]} : {error: `${column.header}は「${optionList(column.options).join('・')}」のどれかにしてください`};
}
const cellText = (value) => (value === null || value === undefined ? '' : String(value));

// 追加の列の値を読む → {t, n} | null | {error}
export function parseFieldInput(field, raw) {
  if (blank(raw)) return {value: null};
  if (field.value_type === 'yen' || field.value_type === 'integer') {
    const parsed = field.value_type === 'yen' ? parseYen(typeof raw === 'number' ? raw : String(raw), {allowNegative: false}) : parseInteger(typeof raw === 'number' ? raw : String(raw), {allowNegative: false});
    return parsed.ok ? {value: {t: null, n: parsed.value}} : {error: `${field.label}: ${parsed.error}`};
  }
  if (field.value_type === 'date') {
    const parsed = parseDate(String(raw));
    return parsed.ok ? {value: {t: parsed.value, n: null}} : {error: `${field.label}: ${parsed.error}`};
  }
  if (field.value_type === 'month') {
    const parsed = parseMonth(String(raw));
    return parsed.ok ? {value: {t: parsed.value, n: null}} : {error: `${field.label}: ${parsed.error}`};
  }
  const text = String(raw).trim();
  if (text.length > 500) return {error: `${field.label}は500文字以内にしてください`};
  if (field.value_type === 'choice') {
    const hit = (field.options || []).find((option) => nfkc(option) === nfkc(text));
    if (!hit) return {error: `${field.label}は「${(field.options || []).join('・')}」のどれかにしてください`};
    return {value: {t: hit, n: null}};
  }
  return {value: {t: text, n: null}};
}

// 見出し → 列。{columns: Map(index → {key}|{fieldId}), unknown, references, duplicated, missing}
export function mapPartnerListHeaders(headers, fields = [], allFields = fields) {
  const lookup = new Map();
  for (const column of FIXED_COLUMNS) { lookup.set(headerKey(column.header), {key: column.key}); lookup.set(headerKey(column.key), {key: column.key}); }
  const inactive = new Map();
  for (const field of allFields) if (!fields.some((f) => f.id === field.id)) { inactive.set(headerKey(field.label), field); inactive.set(headerKey(field.field_key), field); }
  for (const field of fields) { lookup.set(headerKey(field.label), {fieldId: field.id}); lookup.set(headerKey(field.field_key), {fieldId: field.id}); }
  const columns = new Map();
  const unknown = [], references = [], duplicated = [], notApplied = [];
  const seen = new Set();
  headers.forEach((header, index) => {
    const text = cellText(header).trim();
    if (!text) return;
    if (nfkc(text).startsWith(nfkc(REFERENCE_PREFIX))) { references.push(text); return; }
    const hit = lookup.get(headerKey(text));
    if (!hit) { if (inactive.has(headerKey(text))) notApplied.push(text); else unknown.push(text); return; }
    const id = hit.key || `f:${hit.fieldId}`;
    if (seen.has(id)) { duplicated.push(text); return; }
    seen.add(id);
    columns.set(index, hit);
  });
  const present = new Set([...columns.values()].map((hit) => hit.key).filter(Boolean));
  const missing = FIXED_COLUMNS.filter((c) => c.required && !present.has(c.key)).map((c) => c.header);
  return {columns, unknown, references, duplicated, notApplied, present};
}

// 明細の版の比べる値（取込の「変更なし」の判定と、修正の前後の表示）
export const VERSION_KEYS = Object.freeze(['distribution_code', 'territory', 'product_id', 'contract_start', 'contract_end', 'end_rule', 'announce_on', 'exclusivity', 'status',
  'settlement_method', 'amount_ex_tax', 'rate_bps', 'partner_work_code', 'partner_category', 'billing_partner_id', 'agreement_id', 'source_reference', 'note']);
const VALUE_LABELS = {distribution_code: '流通ID', territory: '地域', product_id: '商品SKU', contract_start: '契約開始日', contract_end: '契約終了日', end_rule: '終了の扱い',
  announce_on: '告知解禁日', exclusivity: '独占', status: '状態', settlement_method: '取引方法', amount_ex_tax: '契約金額（税抜）', rate_bps: '料率（%）',
  partner_work_code: '取引先側の作品コード', partner_category: '取引先側の区分', billing_partner_id: '請求先', agreement_id: '販売契約', source_reference: '根拠', note: '備考'};
const same = (a, b) => (a === null || a === undefined || a === '' ? null : String(a)) === (b === null || b === undefined || b === '' ? null : String(b));
const fieldSame = (a, b) => (a ? `${a.t ?? ''}|${a.n ?? ''}` : '') === (b ? `${b.t ?? ''}|${b.n ?? ''}` : '');

// 1つの明細の入力（画面・取込で共通）→ {value, errors}。current は今の版（新しい明細は null）。
// input のキー: FIXED_COLUMNS の key（生の文字）。present: 入力にある列（無い列は今の版の値を使う）
export function normalizeEntryInput(input, current, ctx) {
  const errors = [];
  const has = (key) => ctx.present ? ctx.present.has(key) : Object.hasOwn(input, key);
  const raw = (key) => input[key];
  const keep = (key) => (current ? current[key] ?? null : null);
  const value = {};
  // 流通ID（流通マスタ）
  if (has('distribution_code')) {
    const code = nfkc(raw('distribution_code')).toUpperCase();
    if (!code) errors.push('流通IDが空欄です');
    else if (!ctx.codes.has(code)) errors.push(`流通ID「${code}」は流通マスタにありません`);
    value.distribution_code = code || null;
  } else value.distribution_code = keep('distribution_code');
  if (!value.distribution_code && !errors.length) errors.push('流通IDが空欄です');
  // 地域
  if (has('territory')) {
    const text = String(raw('territory') ?? '').trim();
    if (text.length > 100) errors.push('地域は100文字以内にしてください');
    value.territory = text || '日本';
  } else value.territory = keep('territory') || '日本';
  // 商品
  if (has('product_sku')) {
    const sku = nfkc(raw('product_sku'));
    if (!sku) value.product_id = null;
    else {
      const product = ctx.products.get(sku.toLowerCase());
      if (!product) errors.push(`商品SKU「${sku}」は登録されていません`);
      else if (!product.works.has(ctx.workId)) errors.push(`商品SKU「${sku}」はこの作品に配賦されていません`);
      value.product_id = product?.id ?? null;
    }
  } else value.product_id = keep('product_id');
  // 日付
  for (const key of ['contract_start', 'contract_end', 'announce_on']) {
    if (!has(key)) { value[key] = keep(key); continue; }
    const parsed = parseDate(raw(key) === null || raw(key) === undefined ? '' : String(raw(key)));
    if (!parsed.ok) { errors.push(`${FIXED_BY_KEY.get(key).header}: ${parsed.error}`); value[key] = null; } else value[key] = parsed.value;
  }
  // 選択
  for (const key of ['exclusivity', 'settlement_method']) {
    if (!has(key)) { value[key] = keep(key) ?? (key === 'exclusivity' ? 'unknown' : 'unverified'); continue; }
    if (blank(raw(key))) { value[key] = key === 'exclusivity' ? 'unknown' : 'unverified'; continue; }
    const parsed = parseSelect(FIXED_BY_KEY.get(key), raw(key));
    if (parsed.error) errors.push(parsed.error); else value[key] = parsed.value;
  }
  if (has('status') && !blank(raw('status'))) {
    const parsed = parseSelect(FIXED_BY_KEY.get('status'), raw('status'));
    if (parsed.error) errors.push(parsed.error); else value.status = parsed.value;
  } else value.status = keep('status') || 'planned';
  if (has('end_rule') && !blank(raw('end_rule'))) {
    const parsed = parseSelect(FIXED_BY_KEY.get('end_rule'), raw('end_rule'));
    if (parsed.error) errors.push(parsed.error); else value.end_rule = parsed.value;
  } else if (has('end_rule') || !current) value.end_rule = value.contract_end ? 'date' : 'unknown';
  else value.end_rule = current.end_rule === 'date' && !value.contract_end ? 'unknown' : current.end_rule;
  // 金額・料率
  if (has('amount_ex_tax')) {
    const parsed = parseYen(typeof raw('amount_ex_tax') === 'number' ? raw('amount_ex_tax') : String(raw('amount_ex_tax') ?? ''), {allowNegative: false});
    if (!parsed.ok) errors.push(`契約金額（税抜）: ${parsed.error}`); else value.amount_ex_tax = parsed.value;
  } else value.amount_ex_tax = keep('amount_ex_tax');
  if (has('rate_percent')) {
    if (blank(raw('rate_percent'))) value.rate_bps = null;
    else { const parsed = parsePercentToBps(raw('rate_percent')); if (parsed.error) errors.push(parsed.error); else value.rate_bps = parsed.value; }
  } else value.rate_bps = keep('rate_bps');
  // 文字
  for (const key of ['partner_work_code', 'partner_category', 'source_reference', 'note']) {
    if (!has(key)) { value[key] = keep(key); continue; }
    const text = String(raw(key) ?? '').trim();
    const max = FIXED_BY_KEY.get(key).max;
    if (text.length > max) errors.push(`${FIXED_BY_KEY.get(key).header}は${max}文字以内にしてください`);
    value[key] = text || null;
  }
  // 請求先・販売契約
  if (has('billing_partner_code')) {
    const code = nfkc(raw('billing_partner_code'));
    if (!code) value.billing_partner_id = null;
    else {
      const id = ctx.partners.get(code.toLowerCase());
      if (!id) errors.push(`請求先の取引先コード「${code}」は登録されていません`);
      value.billing_partner_id = id ?? null;
    }
  } else value.billing_partner_id = keep('billing_partner_id');
  if (has('agreement_code')) {
    const code = nfkc(raw('agreement_code'));
    if (!code) value.agreement_id = null;
    else {
      const agreement = ctx.agreements.get(code.toLowerCase());
      if (!agreement) errors.push(`販売契約コード「${code}」は登録されていません`);
      else if (agreement.work_id !== ctx.workId) errors.push(`販売契約コード「${code}」は別の作品の契約です`);
      value.agreement_id = agreement?.work_id === ctx.workId ? agreement.id : null;
    }
  } else value.agreement_id = keep('agreement_id');
  // 期間の決まり（表の CHECK と同じ）
  if (value.contract_start && value.contract_end && value.contract_end < value.contract_start) errors.push('契約終了日は契約開始日以降にしてください');
  if (value.end_rule === 'date' && !value.contract_end) errors.push('終了の扱いが「日付」のときは契約終了日を入れてください');
  if (value.status === 'contracted' && !value.contract_start) errors.push('状態が「契約済」のときは契約開始日を入れてください');
  // 追加の列（無い列は今の版の値を写す）
  const fields = {};
  for (const field of ctx.fields || []) {
    const inputKey = `f:${field.id}`;
    if (!has(inputKey)) { if (current?.fields?.[field.id]) fields[field.id] = current.fields[field.id]; continue; }
    const parsed = parseFieldInput(field, raw(inputKey));
    if (parsed.error) errors.push(parsed.error); else if (parsed.value) fields[field.id] = parsed.value;
  }
  // 当てはまらなくなった列（やめた列）の値も写す（版の値は消さない）
  for (const [id, v] of Object.entries(current?.fields || {})) if (!(ctx.fields || []).some((f) => String(f.id) === String(id))) fields[id] = v;
  value.fields = fields;
  return {value, errors};
}

export function changedParts(current, value) {
  if (!current) return [];
  const parts = VERSION_KEYS.filter((key) => !same(current[key], value[key])).map((key) => VALUE_LABELS[key]);
  const ids = new Set([...Object.keys(current.fields || {}), ...Object.keys(value.fields || {})]);
  if ([...ids].some((id) => !fieldSame(current.fields?.[id], value.fields?.[id]))) parts.push('追加の列');
  return parts;
}

// 登録用の短い JSON（確認の表に入れ、json_each で1つの文で登録する）。null のキーは入れない
export function compactChange(op, {row = null, entryId = null, baseVersion = 0, workId, renewsEntryId = null, value}) {
  const out = {o: op, b: baseVersion, w: workId, d: value.distribution_code, t: value.territory, er: value.end_rule, x: value.exclusivity, st: value.status, m: value.settlement_method};
  const put = (key, v) => { if (v !== null && v !== undefined && v !== '') out[key] = v; };
  put('row', row); put('e', entryId); put('rn', renewsEntryId); put('p', value.product_id); put('pc', value.partner_category); put('pw', value.partner_work_code);
  put('s', value.contract_start); put('en', value.contract_end); put('an', value.announce_on); put('a', value.amount_ex_tax); put('rb', value.rate_bps);
  put('bp', value.billing_partner_id); put('ag', value.agreement_id); put('sr', value.source_reference); put('nt', value.note);
  const f = Object.entries(value.fields || {}).map(([d, v]) => {
    const item = {d: Number(d)};
    if (v.t !== null && v.t !== undefined) item.t = v.t;
    if (v.n !== null && v.n !== undefined) item.n = v.n;
    return item;
  });
  if (f.length) out.f = f;
  return out;
}

// 取込の計画。table: {headers, rows: [{rowNo, cells}]}。mode: partial（ファイルの行だけ）| full（リスト全件。ファイルに無い明細は取り下げ候補）
// ctx: {list, entries: Map(明細ID → 最新の版 {entry_id, work_id, version_no, …, fields}), works: Map(小文字の作品コード → {id, code, title}), editable: Set(作品ID),
//       products, partners, agreements, codes: Map(流通ID → 流通マスタの行), fields: 当てはまる有効な列, allFields, availabilities: Map(作品ID → [...]), flowOfCode(code, territory)}
export function planPartnerListImport(table, ctx, {mode = 'partial'} = {}) {
  const headers = (table.headers || []).map((value) => cellText(value).trim());
  const mapping = mapPartnerListHeaders(headers, ctx.fields || [], ctx.allFields || ctx.fields || []);
  const missing = FIXED_COLUMNS.filter((c) => c.required && !mapping.present.has(c.key)).map((c) => c.header);
  if (missing.length) throw new Error(`見出しに「${missing.join('」「')}」がありません。テンプレートの1行目（見出し）を消さずに使ってください`);
  const named = headers.filter(Boolean).map(headerKey);
  if (new Set(named).size !== named.length) throw new Error('見出しに同じ名前の列があります。1つにしてから読み込んでください');
  const rawRows = (table.rows || []).map((row, index) => (Array.isArray(row) ? {rowNo: index + 2, cells: row} : {rowNo: Number(row?.rowNo) || index + 2, cells: Array.isArray(row?.cells) ? row.cells : []}))
    .filter((row) => row.cells.some((cell) => !blank(cell)));
  if (!rawRows.length) throw new Error('見出しの下にデータの行がありません');
  if (rawRows.length > IMPORT_ROW_LIMIT) throw new Error(`一度に取り込めるのは${IMPORT_ROW_LIMIT.toLocaleString('ja-JP')}行までです（このファイルは${rawRows.length.toLocaleString('ja-JP')}行）。ファイルを分けてください`);
  const fileWarnings = [];
  if (mapping.unknown.length) fileWarnings.push(`読み込まない列があります: ${mapping.unknown.join('、')}（見出しが固定の列・追加の列に合いません）`);
  if (mapping.notApplied.length) fileWarnings.push(`このリストで使っていない追加の列は読みません: ${mapping.notApplied.join('、')}`);
  if (mapping.duplicated.length) fileWarnings.push(`同じ意味の列が2つあるため後の列を読みません: ${mapping.duplicated.join('、')}`);
  if (!mapping.present.has('version')) fileWarnings.push('「版」の列が無いため、出力の後に別の人が直したかを照合していません');
  const present = new Set([...mapping.columns.values()].map((hit) => hit.key || `f:${hit.fieldId}`));
  const seenIds = new Map(), seenNew = new Map();
  const rows = [], changes = [];
  const newRowsByKey = [];
  for (const {rowNo, cells} of rawRows) {
    const input = {};
    for (const [index, hit] of mapping.columns) input[hit.key || `f:${hit.fieldId}`] = cells[index] ?? null;
    const result = {rowNo, entryId: null, workCode: nfkc(input.work_code), workTitle: '', action: 'unchanged', parts: [], errors: [], warnings: [], cells: headers.map((_, i) => cells[i] ?? '')};
    rows.push(result);
    // 明細ID・版
    let current = null;
    if (present.has('entry_id') && !blank(input.entry_id)) {
      const id = Number(nfkc(input.entry_id));
      if (!Number.isSafeInteger(id) || id <= 0) { result.errors.push(`明細ID「${cellText(input.entry_id)}」は整数ではありません`); continue; }
      current = ctx.entries.get(id) || null;
      if (!current) { result.errors.push(`明細ID ${id} はこのリストにありません（別のリストのファイルか、IDを書き換えています）`); continue; }
      if (seenIds.has(id)) { result.errors.push(`明細ID ${id} が${seenIds.get(id)}行目にもあります`); continue; }
      seenIds.set(id, rowNo);
      result.entryId = id;
    }
    // 作品
    const code = nfkc(input.work_code);
    if (!code) { result.errors.push('作品コードが空欄です'); continue; }
    const work = ctx.works.get(code.toLowerCase());
    if (!work) { result.errors.push(`作品コード「${code}」の作品がありません（閲覧できる作品のコードを入れてください）`); continue; }
    result.workTitle = work.title;
    if (current && current.work_id !== work.id) { result.errors.push(`明細 ${current.entry_id} の作品は ${current.work_code} です（作品は変えられません。新しい明細として入れてください）`); continue; }
    if (current && present.has('version') && !blank(input.version)) {
      const fileVersion = Number(nfkc(input.version));
      if (!Number.isInteger(fileVersion) || fileVersion !== current.version_no) { result.errors.push(`出力した後に別の人が直しました（ファイルは第${nfkc(input.version)}版・いまは第${current.version_no}版）。出力し直してから直してください`); continue; }
    }
    const normalized = normalizeEntryInput(input, current, {...ctx, present, workId: work.id});
    for (const error of normalized.errors) result.errors.push(error);
    // 再契約元
    let renewsEntryId = null;
    if (present.has('renews_entry_id') && !blank(input.renews_entry_id)) {
      const id = Number(nfkc(input.renews_entry_id));
      const target = ctx.entries.get(id);
      if (current) { if (current.renews_entry_id !== id) result.errors.push(`再契約元の明細IDは変えられません（明細 ${current.entry_id} の再契約元は${current.renews_entry_id ? ` ${current.renews_entry_id}` : '無し'}）。新しい明細（明細IDが空欄の行）にだけ入れます`); }
      else if (!target)result.errors.push(`再契約元の明細ID ${nfkc(input.renews_entry_id)} はこのリストにありません`);
      else if (target.work_id !== work.id) result.errors.push(`再契約元の明細 ${id} は別の作品です`);
      else renewsEntryId = id;
    }
    if (result.errors.length) continue;
    const value = normalized.value;
    if (!current) {
      const key = `${work.id}|${value.distribution_code}|${territoryKey(value.territory)}|${value.contract_start || ''}`;
      if (seenNew.has(key)) { result.errors.push(`同じ作品・流通ID・地域・契約開始日の新しい明細が${seenNew.get(key)}行目にもあります`); continue; }
      seenNew.set(key, rowNo);
      if (!renewsEntryId && value.contract_start) {
        // 同じ作品・流通ID・地域で、この明細の開始より前に終わった明細（最も新しいもの）を再契約元にする
        const previous = [...ctx.entries.values()].filter((e) => e.work_id === work.id && e.status !== 'withdrawn' && e.distribution_code === value.distribution_code
          && territoryKey(e.territory) === territoryKey(value.territory) && effectiveEnd(e) && effectiveEnd(e) < value.contract_start)
          .sort((x, y) => (effectiveEnd(y) > effectiveEnd(x) ? 1 : -1))[0];
        if (previous) { renewsEntryId = previous.entry_id; result.warnings.push(`明細 ${previous.entry_id}（${previous.contract_start}〜${previous.contract_end}）の再契約として登録します`); }
      }
    }
    if (!ctx.editable.has(work.id)) { result.errors.push('この作品の編集権限がありません'); continue; }
    // 警告（止めない）: 同じリストの重なり・当社の販売条件の期間外
    const flow = ctx.flowOfCode(value.distribution_code, value.territory);
    if (value.status !== 'withdrawn' && value.contract_start) {
      const mine = {contract_start: value.contract_start, contract_end: value.contract_end, end_rule: value.end_rule};
      for (const other of ctx.entries.values()) {
        if (other.entry_id === current?.entry_id || other.work_id !== work.id || other.status === 'withdrawn' || !other.contract_start) continue;
        if (!(other.distribution_code === value.distribution_code || flowsCompatible(other.flow, flow)) || !territoriesIntersect(other.territory, value.territory)) continue;
        if (mine.contract_start <= endOf(other) && other.contract_start <= endOf(mine)) result.warnings.push(`同じリストの明細 ${other.entry_id}（${other.contract_start}〜${effectiveEnd(other) || ''}）と期間が重なります`);
      }
      const conditions = (ctx.availabilities.get(work.id) || []).filter((a) => a.status === 'confirmed' && a.release_on && a.sales_end_on && territoriesIntersect(a.territory, value.territory)
        && (a.distribution_code === value.distribution_code || flowsCompatible(a.flow, flow)));
      const end = effectiveEnd(mine) || value.contract_start;
      if (conditions.length && !conditions.some((a) => a.release_on <= value.contract_start && end <= a.sales_end_on)) {
        result.warnings.push(`当社の販売条件（${conditions.map((a) => `${a.distribution_code} ${a.release_on}〜${a.sales_end_on}`).join('、')}）の期間外です`);
      }
    }
    if (current) {
      const parts = changedParts(current, value);
      if (!parts.length) { result.action = 'unchanged'; continue; }
      result.action = 'revise';
      result.parts = parts;
      result.before = Object.fromEntries(VERSION_KEYS.filter((key) => !same(current[key], value[key])).map((key) => [VALUE_LABELS[key], current[key] ?? null]));
      result.after = Object.fromEntries(VERSION_KEYS.filter((key) => !same(current[key], value[key])).map((key) => [VALUE_LABELS[key], value[key] ?? null]));
      changes.push(compactChange('r', {row: rowNo, entryId: current.entry_id, baseVersion: current.version_no, workId: work.id, value}));
    } else {
      result.action = 'append';
      newRowsByKey.push(rowNo);
      changes.push(compactChange('a', {row: rowNo, baseVersion: 0, workId: work.id, renewsEntryId, value}));
    }
  }
  // 全件の取込: ファイルに無い明細（取り下げていないもの）は取り下げ候補
  const withdraw = [];
  if (mode === 'full') {
    for (const entry of ctx.entries.values()) {
      if (entry.status === 'withdrawn' || seenIds.has(entry.entry_id)) continue;
      const item = {entryId: entry.entry_id, workCode: entry.work_code, workTitle: entry.work_title, distributionCode: entry.distribution_code, contractStart: entry.contract_start, contractEnd: entry.contract_end, canEdit: ctx.editable.has(entry.work_id)};
      withdraw.push(item);
      if (item.canEdit) changes.push(compactChange('w', {entryId: entry.entry_id, baseVersion: entry.version_no, workId: entry.work_id, value: {...entry, status: 'withdrawn'}}));
    }
    if (withdraw.some((item) => !item.canEdit)) fileWarnings.push('編集権限の無い作品の明細は、ファイルに無くても取り下げません');
  }
  const hasErrors = rows.some((row) => row.errors.length);
  for (const row of rows) if (row.errors.length) { row.action = 'error'; row.parts = []; }
  const counts = {
    rows: rows.length, append: rows.filter((r) => r.action === 'append').length, revise: rows.filter((r) => r.action === 'revise').length,
    unchanged: rows.filter((r) => r.action === 'unchanged').length, errors: rows.filter((r) => r.action === 'error').length,
    withdraw: withdraw.filter((item) => item.canEdit).length,
  };
  return {rows, changes: hasErrors ? [] : changes, withdraw, counts, fileWarnings, mapping};
}

// 取込の失敗行を Excel で返す形（元の見出し＋理由）
export function failedPartnerListRows({headers = [], rows = []}) {
  const failed = rows.filter((row) => row.errors?.length);
  return {
    columns: [
      {key: '__row', label: `${REFERENCE_PREFIX}元の行番号`, type: 'int'},
      ...headers.map((header, index) => ({key: `c${index}`, label: header || `列${index + 1}`, type: 'text'})),
      {key: '__error', label: `${REFERENCE_PREFIX}エラー理由`, type: 'text', wrap: true, width: 60},
    ],
    rows: failed.map((row) => ({__row: row.rowNo, __error: row.errors.join(' ／ '), ...Object.fromEntries(headers.map((_, index) => [`c${index}`, row.cells?.[index] ?? '']))})),
  };
}

// ---- 全取引先をまとめた出力（Power Query で統合していた表の代わり）----------------------------------

export function combinedColumns(fields = []) {
  return [
    {key: 'partner_code', label: '取引先コード', type: 'code'}, {key: 'partner_name', label: '取引先名', type: 'text'},
    {key: 'kind_label', label: 'リストの種類', type: 'text'}, {key: 'list_name', label: 'リスト名', type: 'text'}, {key: 'service_name', label: 'サービス名', type: 'text'},
    {key: 'entry_id', label: '明細ID', type: 'int'}, {key: 'version_no', label: '版', type: 'int'},
    {key: 'work_code', label: '作品コード', type: 'code'}, {key: 'work_title', label: '作品名', type: 'text'}, {key: 'product_sku', label: '商品SKU', type: 'code'},
    {key: 'distribution_code', label: '流通ID', type: 'code'}, {key: 'distribution_name', label: '流通名', type: 'text'}, {key: 'master_method', label: '取引方法（流通マスタ）', type: 'text'},
    {key: 'sales_type', label: '販売種別', type: 'text'}, {key: 'territory', label: '地域', type: 'text'},
    {key: 'contract_start', label: '契約開始日', type: 'date'}, {key: 'contract_end', label: '契約終了日', type: 'date'}, {key: 'end_rule_label', label: '終了の扱い', type: 'text'},
    {key: 'status_label', label: '状態', type: 'text'}, {key: 'state_label', label: '状態（基準日）', type: 'text'}, {key: 'announce_on', label: '告知解禁日', type: 'date'},
    {key: 'exclusivity_label', label: '独占', type: 'text'}, {key: 'settlement_label', label: '取引方法', type: 'text'},
    {key: 'amount_ex_tax', label: '契約金額（税抜）', type: 'yen'}, {key: 'rate_percent', label: '料率（%）', type: 'text'},
    {key: 'partner_work_code', label: '取引先側の作品コード', type: 'text'}, {key: 'partner_category', label: '取引先側の区分', type: 'text'},
    {key: 'billing_partner_code', label: '請求先の取引先コード', type: 'code'}, {key: 'agreement_code', label: '販売契約コード', type: 'code'},
    {key: 'source_reference', label: '根拠', type: 'text'}, {key: 'note', label: '備考', type: 'text'}, {key: 'renews_entry_id', label: '再契約元の明細ID', type: 'int'},
    ...fields.map((field) => ({key: `f:${field.id}`, label: field.active ? field.label : `${field.label}（やめた列）`, type: field.value_type === 'yen' ? 'yen' : field.value_type === 'integer' ? 'int' : 'text'})),
  ];
}

export function combinedRow(entry, fields, {asOf, soonDays} = {}) {
  const row = {
    ...entry, end_rule_label: END_RULES[entry.end_rule], status_label: ENTRY_STATUSES[entry.status], state_label: stateText(entryState(entry, asOf, soonDays)),
    exclusivity_label: EXCLUSIVITY[entry.exclusivity], settlement_label: SETTLEMENT_METHODS[entry.settlement_method], rate_percent: percentText(entry.rate_bps),
  };
  for (const field of fields) row[`f:${field.id}`] = fieldCellValue(field, entry.fields?.[field.id]);
  return row;
}
