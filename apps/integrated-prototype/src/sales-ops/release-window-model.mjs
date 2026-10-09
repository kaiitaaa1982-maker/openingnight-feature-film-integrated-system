// 全作品のウィンドウ（営業基幹）の純関数。ブラウザ・Node・Worker で同じ結果を返す（node:* を使わない）。
// 設計: docs/platform/team-development/eigyo-sales-sheet-design.md §2。
// - 種別の初期テンプレート（組織が「採用」すると種別の版1になる）
// - 日付の読み取り（日・月・年・時期の原文・未定。仮の日付を作らない）と、日付の幅（その月の1日〜末日など）
// - 状態（未登録・予定・確定・取り下げ）と、その場で計算する警告（販売条件の期間外・権利期間外・放送枠の月が放送期間外）
// - 絞り込み（種別・状態・期間・語句・警告のあるものだけ）と、Excel の列（見出しは「<種別ラベル> <項目ラベル>」）と取込の差分
import {territoryKey} from './sales-catalog-model.mjs';

export const WINDOW_FAMILIES = Object.freeze({theatrical: '劇場', digital: '配信', package: 'パッケージ', broadcast: '放送', overseas: '海外', other: 'その他'});
export const WINDOW_STATES = Object.freeze({unregistered: '未登録', draft: '予定', confirmed: '確定', withdrawn: '取り下げ'});
export const DATE_PRECISIONS = Object.freeze({day: '日付', month: '月まで', year: '年まで', range: '時期（原文）', tbd: '未定'});
export const VALUE_TYPES = Object.freeze({date: '日付', integer: '整数', yen: '金額（円）', text: '文字', choice: '選択肢'});
// 選択肢の項目の許可リスト（choice_domain）。保存するのはコード、Excel と画面は日本語
export const CHOICE_DOMAINS = Object.freeze({
  exclusivity: Object.freeze({exclusive: '独占', nonexclusive: '非独占', unknown: '未確認'}),
});
// 期間の絞り込みの基準
export const DATE_FIELDS = Object.freeze({start: '開始（解禁・公開・発売）', end: '終了（期限）', announce: '告知解禁日', onsale: '販売中（期間が重なる）'});
export const PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
export const SHEET_NAME = 'ウィンドウ';
export const REFERENCE_PREFIX = '参考_';
export const WORK_CODE_HEADER = '作品コード';
export const IMPORT_ROW_LIMIT = 5000;

const nfkc = (value) => (value === null || value === undefined ? '' : String(value).normalize('NFKC').trim());
const pad = (n) => String(n).padStart(2, '0');
const blank = (value) => value === null || value === undefined || String(value).trim() === '';

// ---- 種別の初期テンプレート --------------------------------------------------------------------
// 配信の種別は 解禁日・配信期限・告知解禁日・販売予定価格（税抜）・視聴権利時間・独占種別 を持つ。
// distributions は流通ID（distribution_types.code）。売上・販売条件との突合（期間外の警告）に使う。空欄可
const DIGITAL_FIELDS = Object.freeze([
  Object.freeze({field_key: 'price_ex_tax', label: '販売予定価格（税抜）', value_type: 'yen', choice_domain: null, sort_order: 10}),
  Object.freeze({field_key: 'viewing_hours', label: '視聴権利時間', value_type: 'integer', choice_domain: null, sort_order: 20}),
  Object.freeze({field_key: 'exclusivity', label: '独占種別', value_type: 'choice', choice_domain: 'exclusivity', sort_order: 30}),
]);
const digital = (type_key, label, sort_order, distributions, group_label = '配信') => Object.freeze({
  type_key, label, group_label, family: 'digital', date_mode: 'period', start_label: '解禁日', end_label: '配信期限', has_announce: 1,
  default_territory: '日本', sort_order, fields: DIGITAL_FIELDS, distributions: Object.freeze(distributions),
});
const point = (type_key, label, group_label, family, start_label, sort_order, distributions) => Object.freeze({
  type_key, label, group_label, family, date_mode: 'point', start_label, end_label: null, has_announce: 0,
  default_territory: '日本', sort_order, fields: Object.freeze([]), distributions: Object.freeze(distributions),
});
export const INITIAL_WINDOW_TYPES = Object.freeze([
  // 「劇場配給」と「配給開始日」は同じもの。劇場のウィンドウ種別は1つ
  point('theatrical', '劇場公開・配給開始', '劇場', 'theatrical', '公開日', 10, ['H001', 'H002', 'theatrical']),
  point('package_sell', 'DVD・BD発売', 'パッケージ', 'package', '発売日', 20, ['S001', 'S003', 'S006', 'package_sell']),
  point('package_rental', 'レンタル開始', 'パッケージ', 'package', '開始日', 30, ['R001', 'R003', 'R004', 'package_rental']),
  // PVOD は独立した流通ID D007（2026-09-25 代表の判断。src/sales-ops/distribution-additions.sql）
  digital('pvod_early', 'PVOD先行', 40, ['D007']),
  digital('pvod_second', 'PVOD②', 50, ['D007']),
  digital('est_early', 'EST先行', 60, ['D003', 'est']),
  digital('est_regular', 'EST通常', 70, ['D003', 'est']),
  digital('tvod_early', 'TVOD先行', 80, ['D004', 'tvod']),
  digital('tvod_regular', 'TVOD通常', 90, ['D004', 'tvod']),
  digital('svod_early', 'SVOD先行', 100, ['D005', 'svod']),
  digital('svod_regular', 'SVOD通常', 110, ['D005', 'svod']),
  digital('avod', 'AVOD', 120, ['D006', 'avod']),
  digital('business_vod', '業務用VOD', 130, ['V001', 'V002'], '業務用'),
  Object.freeze({type_key: 'broadcast', label: '放送', group_label: '放送', family: 'broadcast', date_mode: 'period', start_label: '放送解禁日', end_label: '放送期限',
    has_announce: 1, default_territory: '日本', sort_order: 140, fields: Object.freeze([]),
    distributions: Object.freeze(['B001', 'B002', 'broadcast_free', 'broadcast_bs', 'broadcast_cs', 'broadcast_cable'])}),
  Object.freeze({type_key: 'overseas', label: '海外', group_label: '海外', family: 'overseas', date_mode: 'period', start_label: '開始日', end_label: '終了日',
    has_announce: 0, default_territory: '海外', sort_order: 150, fields: Object.freeze([]), distributions: Object.freeze(['A001', 'A002', 'A003'])}),
]);

// 種別の定義（画面・API から受け取った値）を確かめて正規化する。{value} か {error}
export function normalizeTypeDefinition(input, {existingKeys = [], existingLabels = [], requireKey = true} = {}) {
  const fail = (error) => ({error});
  const type_key = nfkc(input?.type_key ?? input?.typeKey).toLowerCase();
  if (requireKey) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(type_key)) return fail('種別キーは英小文字で始まる英小文字・数字・_（40文字まで）です');
    if (existingKeys.includes(type_key)) return fail(`種別キー ${type_key} は登録済みです`);
  }
  const label = nfkc(input?.label);
  if (!label || label.length > 40) return fail('種別の表示名（40文字まで）を入れてください');
  if (existingLabels.includes(label)) return fail(`表示名「${label}」は別の種別で使っています（Excel の見出しが重なるため）`);
  const group_label = nfkc(input?.group_label ?? input?.groupLabel) || WINDOW_FAMILIES[input?.family] || '';
  const family = String(input?.family ?? '');
  if (!Object.hasOwn(WINDOW_FAMILIES, family)) return fail('分類（劇場・配信・パッケージ・放送・海外・その他）を選んでください');
  if (!group_label || group_label.length > 40) return fail('まとまりの名前（40文字まで）を入れてください');
  const date_mode = String(input?.date_mode ?? input?.dateMode ?? '');
  if (!['point', 'period'].includes(date_mode)) return fail('日付の形（1日／期間）を選んでください');
  const start_label = nfkc(input?.start_label ?? input?.startLabel) || (date_mode === 'point' ? '開始日' : '解禁日');
  const end_label = date_mode === 'period' ? (nfkc(input?.end_label ?? input?.endLabel) || '終了日') : null;
  if (start_label.length > 30 || (end_label && end_label.length > 30)) return fail('日付の見出しは30文字までです');
  const has_announce = input?.has_announce === true || input?.has_announce === 1 || input?.hasAnnounce === true || input?.hasAnnounce === 1 ? 1 : 0;
  const default_territory = nfkc(input?.default_territory ?? input?.defaultTerritory) || '日本';
  if (default_territory.length > 100) return fail('既定の地域は100文字までです');
  const sort_order = Number(input?.sort_order ?? input?.sortOrder ?? 1000);
  if (!Number.isInteger(sort_order) || sort_order < 0 || sort_order > 100000) return fail('並び順は0〜100000の整数です');
  const active = input?.active === false || input?.active === 0 ? 0 : 1;
  const fields = [];
  for (const [index, raw] of (Array.isArray(input?.fields) ? input.fields : []).entries()) {
    const field_key = nfkc(raw?.field_key ?? raw?.fieldKey).toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(field_key)) return fail(`追加項目${index + 1}のキーは英小文字で始まる英小文字・数字・_です`);
    if (fields.some((field) => field.field_key === field_key)) return fail(`追加項目のキー ${field_key} が重なっています`);
    const fieldLabel = nfkc(raw?.label);
    if (!fieldLabel || fieldLabel.length > 30) return fail(`追加項目${index + 1}の表示名（30文字まで）を入れてください`);
    const value_type = String(raw?.value_type ?? raw?.valueType ?? '');
    if (!Object.hasOwn(VALUE_TYPES, value_type)) return fail(`追加項目「${fieldLabel}」の型を選んでください`);
    const choice_domain = value_type === 'choice' ? String(raw?.choice_domain ?? raw?.choiceDomain ?? '') : null;
    if (value_type === 'choice' && !Object.hasOwn(CHOICE_DOMAINS, choice_domain)) return fail(`追加項目「${fieldLabel}」の選択肢の辞書を選んでください`);
    fields.push({field_key, label: fieldLabel, value_type, choice_domain, sort_order: Number.isInteger(raw?.sort_order) ? raw.sort_order : (index + 1) * 10});
  }
  if (fields.length > 20) return fail('追加項目は20個までです');
  const partLabels = [start_label, end_label, has_announce ? '告知解禁日' : null, ...fields.map((field) => field.label), '状態', '版'].filter(Boolean);
  if (new Set(partLabels).size !== partLabels.length) return fail('日付・追加項目・状態・版の見出しが重なっています');
  const distributions = [...new Set((Array.isArray(input?.distributions) ? input.distributions : []).map((code) => String(code).trim()).filter(Boolean))];
  if (distributions.length > 30) return fail('対応する流通IDは30個までです');
  return {value: {type_key, label, group_label, family, date_mode, start_label, end_label, has_announce, default_territory, sort_order, active, fields, distributions}};
}

// ---- 日付 --------------------------------------------------------------------------------
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const TBD_WORDS = new Set(['未定', '調整中', '未確定', 'tbd', 'tba', '―', '-', '—']);
const SEASON_MONTH = {春: 3, 夏: 6, 秋: 9, 冬: 12, 上期: 1, 上半期: 1, 下期: 7, 下半期: 7, 年初: 1, 年末: 12};

// 入力の文字（Excel のセル・画面の入力）から日付を読む。
// → {ok:true, precision: day|month|year|range|tbd|null, value: 'YYYY-MM-DD'|'YYYY-MM'|'YYYY'|null, raw} ／ {ok:false, error}
// 空欄は precision:null。範囲（時期の原文）は value に最も早い月（読めたときだけ）を入れる
export function parseWindowDate(input) {
  if (blank(input)) return {ok: true, precision: null, value: null, raw: null};
  const text = nfkc(input);
  if (text.length > 200) return {ok: false, error: '日付の文字が長すぎます（200文字まで）'};
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > lastDayOf(y, mo)) return {ok: false, error: `存在しない日付です: ${text}`};
    return {ok: true, precision: 'day', value: `${m[1]}-${pad(mo)}-${pad(d)}`, raw: text};
  }
  m = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(text);
  if (m) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return {ok: false, error: `存在しない月です: ${text}`};
    return {ok: true, precision: 'month', value: `${m[1]}-${pad(mo)}`, raw: text};
  }
  m = /^(\d{4})年?$/.exec(text);
  if (m) return {ok: true, precision: 'year', value: m[1], raw: text};
  if (TBD_WORDS.has(text.toLowerCase())) return {ok: true, precision: 'tbd', value: null, raw: text};
  return {ok: true, precision: 'range', value: earliestMonth(text), raw: text};
}

// 時期の原文の範囲の区切りの文字（NFKC の後。「～」は「~」、「－」は「-」になる）。正規表現の文字クラスの中身。
// 提案資料の月の幅の読み取り（release-proposal-model.mjs の timingMonthSpans）と同じ区切りを使う
export const RANGE_DASHES = '〜~\\-－–—―ー‐−';
// 「2027年春」「2027年4月以降」「2027年下期」から最も早い月（YYYY-MM）。読めなければ null
// 年度（4月始まり）の上期・下期の最初の月
const FISCAL_HALF_MONTH = {上期: 4, 上半期: 4, 下期: 10, 下半期: 10};
const FIRST_OF_MONTH_RANGE = new RegExp(`(\\d{1,2})\\s*(?:(?:[${RANGE_DASHES}]|から)\\s*\\d{1,2}\\s*)?月`);
export function earliestMonth(text) {
  const t = nfkc(text);
  const year = /^(\d{4})\s*年?/.exec(t);
  if (!year) return null;
  const rest = t.slice(year[0].length);
  // 「1〜3月」「1—3月」「1から3月」は範囲の最初の月（1月）
  const month = FIRST_OF_MONTH_RANGE.exec(rest);
  if (month && Number(month[1]) >= 1 && Number(month[1]) <= 12) return `${year[1]}-${pad(Number(month[1]))}`;
  // 「2026年度下期」は年度（4月始まり）の下期＝10月
  if (rest.startsWith('度')) {
    const half = Object.entries(FISCAL_HALF_MONTH).map(([word, mo]) => [rest.indexOf(word), mo]).filter(([at]) => at >= 0).sort((a, b) => a[0] - b[0])[0];
    if (half) return `${year[1]}-${pad(half[1])}`;
  }
  // 季節の語は原文に出てくる位置の早い順（「2026年末〜2027年初」は年末）
  const afterYear = t.slice(year[1].length); // 「年末」「年初」の「年」を含めて探す
  const season = Object.entries(SEASON_MONTH).map(([word, mo]) => [afterYear.indexOf(word), mo]).filter(([at]) => at >= 0).sort((a, b) => a[0] - b[0])[0];
  return season ? `${year[1]}-${pad(season[1])}` : null;
}

// 日付・月・年の文字 → その幅 [最初の日, 最後の日]（ISO）。読めなければ null
export function dateBounds(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return [text, text];
  if (/^\d{4}-\d{2}$/.test(text)) return [`${text}-01`, `${text}-${pad(lastDayOf(Number(text.slice(0, 4)), Number(text.slice(5, 7))))}`];
  if (/^\d{4}$/.test(text)) return [`${text}-01-01`, `${text}-12-31`];
  return null;
}

// 画面・Excel の表示（2026/11/05・2026年11月・2026年・原文・未定）
export function dateText(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replaceAll('-', '/');
  if (/^\d{4}-\d{2}$/.test(text)) return `${text.slice(0, 4)}年${Number(text.slice(5, 7))}月`;
  if (/^\d{4}$/.test(text)) return `${text}年`;
  return text;
}

// 版の開始の表示（範囲・未定は原文）
export function startText(version) {
  if (!version) return '';
  if (version.date_precision === 'range') return version.timing_raw || '時期未定';
  if (version.date_precision === 'tbd') return version.timing_raw || '未定';
  return dateText(version.start_on);
}

// ウィンドウの期間の幅。開始が日・月・年のときだけ判定に使う。
// → {startLow, startHigh, endHigh} （endHigh: 期間の種別で終了が読めないときは null＝終わりが決まっていない。1日の種別は startHigh）／ null
export function windowSpan(version, typeVersion) {
  if (!version || !['day', 'month', 'year'].includes(version.date_precision)) return null;
  const start = dateBounds(version.start_on);
  if (!start) return null;
  if (typeVersion?.date_mode === 'point') return {startLow: start[0], startHigh: start[1], endHigh: start[1]};
  const end = dateBounds(version.end_on);
  return {startLow: start[0], startHigh: start[1], endHigh: end ? end[1] : null};
}

export function windowState(version) {
  return version ? version.status : 'unregistered';
}

// ---- 警告（その場で計算・止めない）--------------------------------------------------------------

// 同じ地域か（販売条件は名寄せのキーが同じもの）
export const sameTerritory = (a, b) => territoryKey(a) === territoryKey(b);
// 権利の地域がウィンドウの地域を含むか。空欄・全世界は全部、全世界（日本を除く）は日本以外
export function rightsTerritoryCovers(scopeTerritory, windowTerritory) {
  const scope = territoryKey(scopeTerritory);
  if (!scope || scope === 'WW') return true;
  const target = territoryKey(windowTerritory);
  if (scope === target) return true;
  return scope === 'WW_EX_JP' && target !== 'JP' && target !== '';
}
const FAMILY_MEDIA = {theatrical: ['劇場', '配給'], digital: ['配信'], package: ['ビデオグラム'], broadcast: ['放送'], overseas: ['海外'], other: []};
const mediaName = (value) => nfkc(value).replace(/_/g, '・');

// 1つのウィンドウの警告。context: {availabilities, scopes, slots, distributionNames: Map(code→流通名)}（どれもこの作品のもの）
// → [{kind, message}]。取り下げ・日付が読めない（時期の原文・未定）ウィンドウは判定しない
export function windowWarnings(version, typeVersion, windowTerritory, {availabilities = [], scopes = [], slots = [], distributionNames = new Map()} = {}) {
  if (!version || version.status === 'withdrawn') return [];
  const span = windowSpan(version, typeVersion);
  if (!span) return [];
  const out = [];
  const until = span.endHigh ?? span.startHigh;
  const codes = new Set(typeVersion?.distributions || []);
  // 1. 対応する流通IDの確定済み販売条件（各系列の最新版）の期間外
  const conditions = availabilities.filter((a) => codes.has(a.distribution_code) && a.status === 'confirmed' && a.release_on && a.sales_end_on && sameTerritory(a.territory, windowTerritory));
  if (conditions.length && !conditions.some((a) => a.release_on <= span.startLow && until <= a.sales_end_on)) {
    const list = conditions.slice(0, 2).map((a) => `${a.distribution_code} ${dateText(a.release_on)}〜${dateText(a.sales_end_on)}`).join('・');
    out.push({kind: 'availability', message: `販売条件の期間外（条件確認済み: ${list}${conditions.length > 2 ? ' ほか' : ''}）`});
  }
  // 2. 権利期間外（調達の権利範囲。媒体が合うか全媒体・未確認、地域を含むもの）
  const media = new Set([...[...codes].map((code) => distributionNames.get(code)).filter(Boolean).map(mediaName), ...(FAMILY_MEDIA[typeVersion?.family] || [])]);
  const rights = scopes.filter((s) => (s.rights_start || s.rights_end) && (blank(s.channel) || mediaName(s.channel) === '全媒体' || media.has(mediaName(s.channel)))
    && rightsTerritoryCovers(s.territory, windowTerritory));
  if (rights.length && !rights.some((s) => (!s.rights_start || s.rights_start <= span.startLow) && (!s.rights_end || (span.endHigh ?? span.startHigh) <= s.rights_end))) {
    const list = rights.slice(0, 2).map((s) => `${s.rights_start ? dateText(s.rights_start) : '開始未確認'}〜${s.rights_end ? dateText(s.rights_end) : '終了未確認'}`).join('・');
    out.push({kind: 'rights', message: `権利期間外（権利: ${list}${rights.length > 2 ? ' ほか' : ''}）`});
  }
  // 3. 放送枠の月が放送期間外（中止・差戻しの枠は除く）
  if (typeVersion?.family === 'broadcast') {
    for (const slot of slots) {
      if (['cancelled', 'rejected'].includes(slot.status)) continue;
      const month = dateBounds(slot.broadcast_month);
      if (!month) continue;
      if (month[1] < span.startLow || (span.endHigh && month[0] > span.endHigh)) {
        out.push({kind: 'broadcast_slot', message: `放送枠の月が放送期間外（${dateText(slot.broadcast_month)}・${slot.station_name}）`});
      }
    }
  }
  return out;
}

// ---- 絞り込み ------------------------------------------------------------------------------

// 期間の条件の文字（YYYY-MM か YYYY-MM-DD）→ 幅の端。読めなければ null
function edge(value, side) {
  const bounds = dateBounds(value);
  return bounds ? bounds[side === 'low' ? 0 : 1] : null;
}

// 条件の正規化（URL・API の値から）。types は有効な種別の一覧（{type_key, family}）
export function normalizeFilters(query = {}, types = []) {
  const list = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const families = list(query.families).filter((family) => Object.hasOwn(WINDOW_FAMILIES, family));
  const typeKeys = list(query.types).filter((key) => types.some((type) => type.type_key === key));
  const state = Object.hasOwn(WINDOW_STATES, query.state) ? query.state : '';
  const dateField = Object.hasOwn(DATE_FIELDS, query.dateField) ? query.dateField : '';
  const from = dateField && dateBounds(query.from) ? String(query.from) : '';
  const to = dateField && dateBounds(query.to) ? String(query.to) : '';
  const q = nfkc(query.q).slice(0, 100);
  const warnings = query.warnings === '1' || query.warnings === true || query.warnings === 'true';
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.pageSize) || PAGE_SIZE)));
  return {families, typeKeys, state, dateField, from, to, q, warnings, page, pageSize};
}

// 条件に合う種別（列に出す種別）
export function selectedTypes(types, filters) {
  return types.filter((type) => (!filters.families.length || filters.families.includes(type.family)) && (!filters.typeKeys.length || filters.typeKeys.includes(type.type_key)));
}

// 1つのウィンドウ（entry: {state, version, typeVersion}）が状態と期間の条件に合うか
export function entryMatches(entry, filters) {
  if (filters.state && entry.state !== filters.state) return false;
  if (!filters.dateField || (!filters.from && !filters.to)) return true;
  const low = filters.from ? edge(filters.from, 'low') : '0000-01-01';
  const high = filters.to ? edge(filters.to, 'high') : '9999-12-31';
  const version = entry.version;
  if (!version) return false;
  if (filters.dateField === 'onsale') {
    if (version.status === 'withdrawn') return false;
    const span = windowSpan(version, entry.typeVersion);
    if (!span) return false;
    return span.startLow <= high && (span.endHigh === null || span.endHigh >= low);
  }
  const value = {start: version.start_on, end: version.end_on, announce: version.announce_on}[filters.dateField];
  if (filters.dateField === 'start' && !['day', 'month', 'year'].includes(version.date_precision)) return false;
  const bounds = dateBounds(value);
  return Boolean(bounds) && bounds[1] >= low && bounds[0] <= high;
}

// 作品の行が条件に合うか。row: {work_code, work_title, project_title, entries: [{state, version, typeVersion, warnings}]}（selectedTypes の分）
export function rowMatches(row, filters) {
  if (filters.q) {
    const text = nfkc(`${row.work_code} ${row.work_title} ${row.project_title || ''} ${row.project_code || ''}`).toLowerCase();
    if (!text.includes(filters.q.toLowerCase())) return false;
  }
  if (filters.warnings && !row.entries.some((entry) => entry.warnings.length)) return false;
  const byDate = Boolean(filters.dateField && (filters.from || filters.to));
  if (!filters.state && !byDate) return true;
  return row.entries.some((entry) => entryMatches(entry, filters));
}

// ---- 値の正規化（画面の1件入力と Excel 取込で共通）-----------------------------------------------

const STATUS_BY_TEXT = new Map([
  ...Object.entries(WINDOW_STATES).filter(([code]) => code !== 'unregistered').flatMap(([code, label]) => [[label, code], [code, code]]),
  ['条件未確定', 'draft'], ['下書き', 'draft'], ['確認済み', 'confirmed'], ['条件確認済み', 'confirmed'],
]);
export function parseStatus(text) {
  const value = nfkc(text);
  if (!value) return {ok: true, value: null};
  const code = STATUS_BY_TEXT.get(value) || STATUS_BY_TEXT.get(value.toLowerCase());
  return code ? {ok: true, value: code} : {ok: false, error: `状態は ${['予定', '確定', '取り下げ'].join('・')} のどれかです（${value}）`};
}

// 追加項目の1つの値 → {ok, value: {t, n}|null}
export function parseFieldValue(field, input) {
  if (blank(input)) return {ok: true, value: null};
  const text = nfkc(input);
  if (field.value_type === 'yen' || field.value_type === 'integer') {
    const normalized = text.replace(/[￥¥,，\s円]/g, '').replace(/時間$/, '');
    if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(Number(normalized))) return {ok: false, error: `${field.label}は0以上の整数です（${text}）`};
    return {ok: true, value: {t: null, n: Number(normalized)}};
  }
  if (field.value_type === 'date') {
    const parsed = parseWindowDate(text);
    if (!parsed.ok || !['day', 'month', 'year'].includes(parsed.precision)) return {ok: false, error: `${field.label}は日付・月・年で入れてください（${text}）`};
    return {ok: true, value: {t: parsed.value, n: null}};
  }
  if (field.value_type === 'choice') {
    const domain = CHOICE_DOMAINS[field.choice_domain] || {};
    const code = Object.hasOwn(domain, text) ? text : Object.entries(domain).find(([, label]) => label === text)?.[0];
    if (!code) return {ok: false, error: `${field.label}は ${Object.values(domain).join('・')} のどれかです（${text}）`};
    return {ok: true, value: {t: code, n: null}};
  }
  if (text.length > 500) return {ok: false, error: `${field.label}は500文字までです`};
  return {ok: true, value: {t: text, n: null}};
}

// 追加項目の値の表示（金額は円・桁区切り、選択肢は日本語）
export function fieldText(field, value) {
  if (!value) return '';
  if (field.value_type === 'yen') return `${Number(value.n).toLocaleString('ja-JP')}円`;
  if (field.value_type === 'integer') return Number(value.n).toLocaleString('ja-JP');
  if (field.value_type === 'choice') return CHOICE_DOMAINS[field.choice_domain]?.[value.t] || value.t;
  if (field.value_type === 'date') return dateText(value.t);
  return value.t;
}
// Excel に出す値（金額・整数は数、ほかは文字）
export function fieldCell(field, value) {
  if (!value) return null;
  if (field.value_type === 'yen' || field.value_type === 'integer') return value.n;
  if (field.value_type === 'choice') return CHOICE_DOMAINS[field.choice_domain]?.[value.t] || value.t;
  return value.t;
}

// 入力（文字）→ 版の値。input: {start, end, announce, status, fields: {key: 文字}}。
// 返り値 {value: {start_on,end_on,announce_on,date_precision,timing_raw,status,fields:{key:{t,n}}}, errors: [文]}
export function normalizeWindowInput(input, typeVersion, {currentStatus = null} = {}) {
  const errors = [];
  const start = parseWindowDate(input.start);
  if (!start.ok) errors.push(`${typeVersion.start_label}: ${start.error}`);
  let end = {ok: true, precision: null, value: null};
  if (typeVersion.date_mode === 'period') {
    end = parseWindowDate(input.end);
    if (!end.ok) errors.push(`${typeVersion.end_label}: ${end.error}`);
    else if (end.precision && !['day', 'month', 'year'].includes(end.precision)) errors.push(`${typeVersion.end_label}は日付・月・年で入れてください（${end.raw}）`);
  } else if (!blank(input.end)) {
    errors.push(`${typeVersion.label}は1日の種別なので、終了は入れません`);
  }
  let announce = {ok: true, precision: null, value: null};
  if (typeVersion.has_announce) {
    announce = parseWindowDate(input.announce);
    if (!announce.ok) errors.push(`告知解禁日: ${announce.error}`);
    else if (announce.precision && !['day', 'month', 'year'].includes(announce.precision)) errors.push(`告知解禁日は日付・月・年で入れてください（${announce.raw}）`);
  } else if (!blank(input.announce)) {
    errors.push(`${typeVersion.label}には告知解禁日がありません`);
  }
  const status = parseStatus(input.status);
  if (!status.ok) errors.push(status.error);
  const fields = {};
  for (const field of typeVersion.fields || []) {
    const raw = input.fields ? input.fields[field.field_key] : undefined;
    const parsed = parseFieldValue(field, raw);
    if (!parsed.ok) errors.push(parsed.error);
    else if (parsed.value) fields[field.field_key] = parsed.value;
  }
  const known = new Set((typeVersion.fields || []).map((field) => field.field_key));
  for (const key of Object.keys(input.fields || {})) if (!known.has(key) && !blank(input.fields[key])) errors.push(`${typeVersion.label}に「${key}」の項目はありません`);
  if (errors.length) return {errors};
  const precision = start.precision || 'tbd';
  const value = {
    start_on: ['day', 'month', 'year'].includes(precision) ? start.value : precision === 'range' ? start.value : null,
    end_on: end.value || null,
    announce_on: announce.value || null,
    date_precision: precision,
    timing_raw: ['range', 'tbd'].includes(precision) ? (start.raw || null) : null,
    status: status.value || currentStatus || 'draft',
    fields,
  };
  if (value.status === 'confirmed' && !['day', 'month', 'year'].includes(precision)) errors.push('確定にするには開始の日付（日・月・年のどれか）が必要です');
  if (value.end_on && value.start_on && ['day', 'month', 'year'].includes(precision)) {
    const n = Math.min(value.end_on.length, value.start_on.length);
    if (value.end_on.slice(0, n) < value.start_on.slice(0, n)) errors.push(`${typeVersion.end_label}が${typeVersion.start_label}より前です`);
  }
  return errors.length ? {errors} : {value, errors: []};
}

// 今の版を、種別の最新の版にある部分だけの入力（文字・数）にする。画面の新しい版の下書きと、Excel 取込の「無い列は今の値」で共通。
// 種別を直した後に、今の版にだけ残っている値（1日の種別の終了・告知の無い種別の告知・外した追加項目）は持ち越さない
// （その値は画面にも Excel にも出ないため、利用者が空にできない）。前の版の値は履歴に残る
export function currentWindowInput(version, type) {
  if (!version) return {start: null, end: null, announce: null, status: null, fields: {}};
  const fields = {};
  for (const field of type?.fields || []) {
    const value = version.fields?.[field.field_key];
    if (!value || (value.t === null && value.n === null)) continue;
    fields[field.field_key] = field.value_type === 'choice' ? value.t : value.n ?? value.t;
  }
  return {
    start: ['range', 'tbd'].includes(version.date_precision) ? version.timing_raw || '' : version.start_on ?? null,
    end: type?.date_mode === 'period' ? version.end_on ?? null : null,
    announce: type?.has_announce ? version.announce_on ?? null : null,
    status: version.status ?? null,
    fields,
  };
}

// 今の版を、種別の最新の版にある部分だけに絞った版（取込の「変更なし」の判定と差分の表示に使う）
export function projectVersion(version, type) {
  if (!version) return null;
  const keys = new Set((type?.fields || []).map((field) => field.field_key));
  return {
    ...version,
    end_on: type?.date_mode === 'period' ? version.end_on ?? null : null,
    announce_on: type?.has_announce ? version.announce_on ?? null : null,
    fields: Object.fromEntries(Object.entries(version.fields || {}).filter(([key]) => keys.has(key))),
  };
}

// 版（DB の行＋項目の値）を比べられる形にする
export function comparable(version) {
  if (!version) return null;
  const fields = version.fields || {};
  return JSON.stringify({
    start_on: version.start_on ?? null, end_on: version.end_on ?? null, announce_on: version.announce_on ?? null,
    date_precision: version.date_precision, timing_raw: version.timing_raw ?? null, status: version.status,
    fields: Object.fromEntries(Object.keys(fields).sort().map((key) => [key, {t: fields[key]?.t ?? null, n: fields[key]?.n ?? null}])),
  });
}

// 変わった部分の見出し（差分の表示）
export function changedParts(before, after, typeVersion) {
  const parts = [];
  const b = before || {fields: {}};
  if ((b.start_on ?? null) !== after.start_on || (b.date_precision ?? null) !== after.date_precision || (b.timing_raw ?? null) !== after.timing_raw) parts.push(typeVersion.start_label);
  if ((b.end_on ?? null) !== after.end_on) parts.push(typeVersion.end_label || '終了');
  if ((b.announce_on ?? null) !== after.announce_on) parts.push('告知解禁日');
  for (const field of typeVersion.fields || []) {
    const x = b.fields?.[field.field_key], y = after.fields?.[field.field_key];
    if ((x?.t ?? null) !== (y?.t ?? null) || (x?.n ?? null) !== (y?.n ?? null)) parts.push(field.label);
  }
  if ((b.status ?? null) !== after.status) parts.push('状態');
  return parts;
}

// ---- Excel の列 --------------------------------------------------------------------------

// 種別ごとの列。part: start|end|announce|field|status|version。header: 「<種別ラベル> <項目ラベル>」
export function typeParts(type) {
  return [
    {part: 'start', label: type.start_label},
    ...(type.date_mode === 'period' ? [{part: 'end', label: type.end_label}] : []),
    ...(type.has_announce ? [{part: 'announce', label: '告知解禁日'}] : []),
    ...(type.fields || []).map((field) => ({part: 'field', field, label: field.label})),
    {part: 'status', label: '状態'},
    {part: 'version', label: '版'},
  ];
}
export const headerOf = (type, part) => `${type.label} ${part.label}`;
const headerKey = (value) => nfkc(value).replace(/[\s_　]+/g, '').toLowerCase();

// 出力の列の並び（画面と同じ: 固定列 → 種別の並び順 → 種別の中は 開始・終了・告知・追加項目・状態・版）
export function windowSheetColumns(types) {
  const columns = [
    {key: 'work_code', label: WORK_CODE_HEADER, type: 'code'},
    {key: 'work_title', label: `${REFERENCE_PREFIX}作品名`, type: 'text', reference: true},
    {key: 'project_title', label: `${REFERENCE_PREFIX}案件`, type: 'text', reference: true},
  ];
  for (const type of types) {
    for (const part of typeParts(type)) {
      const key = `${type.type_key}:${part.part === 'field' ? `field:${part.field.field_key}` : part.part}`;
      const cellType = part.part === 'version' ? 'int' : part.part === 'field' && part.field.value_type === 'yen' ? 'yen' : part.part === 'field' && part.field.value_type === 'integer' ? 'int' : 'text';
      columns.push({key, label: headerOf(type, part), type: cellType, typeKey: type.type_key, part: part.part, fieldKey: part.field?.field_key || null});
    }
  }
  columns.push({key: 'warnings', label: `${REFERENCE_PREFIX}警告`, type: 'text', wrap: true, reference: true});
  return columns;
}

// 行（API の行）→ Excel の1行（列の key → 値）
export function windowSheetRow(row, types) {
  const out = {work_code: row.work_code, work_title: row.work_title, project_title: row.project_title || ''};
  for (const type of types) {
    const entry = row.windows?.[type.type_key];
    const version = entry?.version;
    const prefix = `${type.type_key}:`;
    out[`${prefix}start`] = version ? (version.date_precision === 'range' || version.date_precision === 'tbd' ? version.timing_raw || '' : version.start_on) : null;
    out[`${prefix}end`] = version?.end_on || null;
    out[`${prefix}announce`] = version?.announce_on || null;
    for (const field of type.fields || []) out[`${prefix}field:${field.field_key}`] = fieldCell(field, version?.fields?.[field.field_key]);
    out[`${prefix}status`] = version ? WINDOW_STATES[version.status] : null;
    out[`${prefix}version`] = version ? version.version_no : null;
  }
  out.warnings = Object.values(row.windows || {}).flatMap((entry) => (entry.warnings || []).map((warning) => `${entry.typeLabel}: ${warning.message}`)).join(' ／ ');
  return out;
}

// 見出し → 列の意味。{columns: [{index, typeKey, part, fieldKey}|null], workCodeIndex, unknown, references, duplicated, inactive}
export function mapWindowHeaders(headers, allTypes) {
  // 使っている種別を先に入れ、やめた種別は同じ見出しを上書きしない（やめた種別と同じ表示名の種別を作れるため）
  const lookup = new Map();
  const ordered = [...allTypes.filter((type) => type.active), ...allTypes.filter((type) => !type.active)];
  for (const type of ordered) {
    for (const part of typeParts(type)) {
      const key = headerKey(headerOf(type, part));
      if (!lookup.has(key)) lookup.set(key, {typeKey: type.type_key, part: part.part, fieldKey: part.field?.field_key || null, active: Boolean(type.active)});
    }
  }
  const columns = [];
  const unknown = [];
  const references = [];
  const duplicated = [];
  const inactive = [];
  const seen = new Set();
  let workCodeIndex = -1;
  headers.forEach((raw, index) => {
    const header = nfkc(raw);
    if (!header) { columns.push(null); return; }
    if (header.startsWith(REFERENCE_PREFIX)) { references.push(header); columns.push(null); return; }
    if (headerKey(header) === headerKey(WORK_CODE_HEADER)) {
      if (workCodeIndex >= 0) duplicated.push(header); else workCodeIndex = index;
      columns.push(null);
      return;
    }
    const hit = lookup.get(headerKey(header));
    if (!hit) { unknown.push(header); columns.push(null); return; }
    if (!hit.active) { inactive.push(header); columns.push(null); return; }
    const id = `${hit.typeKey}|${hit.part}|${hit.fieldKey || ''}`;
    if (seen.has(id)) { duplicated.push(header); columns.push(null); return; }
    seen.add(id);
    columns.push({index, ...hit});
  });
  return {columns, workCodeIndex, unknown, references, duplicated, inactive};
}

const cellString = (value) => (value === null || value === undefined ? '' : typeof value === 'number' ? String(value) : String(value));

// 取込の計画。table: {headers, rows: [{rowNo, cells}]}。
// context: {types: 有効な種別（最新の版・fields 付き）, allTypes, works: [{id, code, title}], editable: Set(作品ID),
//           current: Map(`${workId}|${typeId}` → 既定の地域のウィンドウの最新版 {window_id, version_no, ..., fields})}
// → {rows: [{rowNo, workCode, workTitle, action, changes: [{typeLabel, action, parts}], errors, warnings}], changes: [payload], counts, fileWarnings, mapping}
export function planWindowImport(table, context) {
  const headers = (table.headers || []).map((value) => cellString(value).trim());
  const mapping = mapWindowHeaders(headers, context.allTypes || context.types);
  if (mapping.workCodeIndex < 0) throw new Error(`見出しに「${WORK_CODE_HEADER}」がありません。出力したファイルの1行目（見出し）を消さずに使ってください`);
  const named = headers.filter(Boolean).map(headerKey);
  if (new Set(named).size !== named.length) throw new Error('見出しに同じ名前の列があります。1つにしてから読み込んでください');
  const rawRows = (table.rows || []).map((row, index) => (Array.isArray(row) ? {rowNo: index + 2, cells: row} : {rowNo: Number(row?.rowNo) || index + 2, cells: Array.isArray(row?.cells) ? row.cells : []}))
    .filter((row) => row.cells.some((cell) => !blank(cell)));
  if (!rawRows.length) throw new Error('見出しの下にデータの行がありません');
  if (rawRows.length > IMPORT_ROW_LIMIT) throw new Error(`一度に取り込めるのは${IMPORT_ROW_LIMIT}行までです（このファイルは${rawRows.length}行）。ファイルを分けてください`);
  const byType = new Map();
  for (const column of mapping.columns.filter(Boolean)) {
    if (!byType.has(column.typeKey)) byType.set(column.typeKey, []);
    byType.get(column.typeKey).push(column);
  }
  const typeByKey = new Map(context.types.map((type) => [type.type_key, type]));
  const workByCode = new Map(context.works.map((work) => [nfkc(work.code).toLowerCase(), work]));
  const fileWarnings = [];
  if (mapping.unknown.length) fileWarnings.push(`読み込まない列があります: ${mapping.unknown.join('、')}（見出しが種別と項目に合いません）`);
  if (mapping.inactive.length) fileWarnings.push(`使っていない種別の列は読みません: ${mapping.inactive.join('、')}`);
  if (mapping.duplicated.length) fileWarnings.push(`同じ意味の列が2つあるため後の列を読みません: ${mapping.duplicated.join('、')}`);
  const noVersion = [...byType.keys()].filter((key) => !byType.get(key).some((column) => column.part === 'version'));
  if (noVersion.length) fileWarnings.push(`版の列が無い種別（${noVersion.map((key) => typeByKey.get(key)?.label || key).join('、')}）は、出力後に別の人が直したかを照合していません`);
  const seenCodes = new Map();
  const results = [];
  const changes = [];
  for (const {rowNo, cells} of rawRows) {
    const code = nfkc(cells[mapping.workCodeIndex]);
    const result = {rowNo, workCode: code, workTitle: '', action: 'unchanged', changes: [], errors: [], warnings: [], cells: headers.map((_, index) => cells[index] ?? '')};
    results.push(result);
    if (!code) { result.errors.push(`${WORK_CODE_HEADER}が空欄です`); continue; }
    const work = workByCode.get(code.toLowerCase());
    if (!work) { result.errors.push(`${WORK_CODE_HEADER}「${code}」の作品がありません（閲覧できる作品のコードを入れてください）`); continue; }
    result.workTitle = work.title;
    if (seenCodes.has(work.id)) { result.errors.push(`同じ作品が${seenCodes.get(work.id)}行目にもあります`); continue; }
    seenCodes.set(work.id, rowNo);
    const rowChanges = [];
    for (const [typeKey, columns] of byType) {
      const type = typeByKey.get(typeKey);
      if (!type) continue;
      const current = context.current.get(`${work.id}|${type.id}`) || null;
      const cell = (part, fieldKey = null) => {
        const column = columns.find((item) => item.part === part && (item.fieldKey || null) === fieldKey);
        return column ? {present: true, value: cells[column.index]} : {present: false, value: undefined};
      };
      // 無い列は変更しない（今の版の値を使う）。ある列の空欄は「空にする」。今の版の値は、種別の最新の版にある部分だけを持ち越す
      const currentInput = currentWindowInput(current, type);
      const pick = (part, fallback) => { const c = cell(part); return c.present ? cellString(c.value) : fallback; };
      const input = {
        start: pick('start', currentInput.start),
        end: pick('end', currentInput.end),
        announce: pick('announce', currentInput.announce),
        status: pick('status', ''),
        fields: Object.fromEntries((type.fields || []).map((field) => {
          const c = cell('field', field.field_key);
          return [field.field_key, c.present ? cellString(c.value) : currentInput.fields[field.field_key]];
        })),
      };
      const versionCell = cell('version');
      const allBlank = blank(input.start) && blank(input.end) && blank(input.announce) && blank(input.status) && Object.values(input.fields).every(blank);
      if (!current && allBlank) continue;
      if (versionCell.present) {
        const text = cellString(versionCell.value).trim();
        const fileVersion = text === '' ? 0 : Number(text);
        if (!Number.isInteger(fileVersion) || fileVersion < 0) { result.errors.push(`${type.label} 版: 整数ではありません（${text}）`); continue; }
        const now = current?.version_no ?? 0;
        if (fileVersion !== now) { result.errors.push(`${type.label}: 出力した後に別の人が直しました（ファイルは第${fileVersion}版・いまは第${now}版）。出力し直してから直してください`); continue; }
      }
      const normalized = normalizeWindowInput(input, type, {currentStatus: current?.status || null});
      if (normalized.errors.length) { for (const error of normalized.errors) result.errors.push(`${type.label}: ${error}`); continue; }
      const value = normalized.value;
      const before = projectVersion(current, type);
      if (before && comparable(before) === comparable(value)) continue;
      const parts = changedParts(before, value, type);
      rowChanges.push({typeKey, typeLabel: type.label, action: current ? 'revise' : 'append', parts});
      changes.push({
        // 地域は今の系列の地域（名寄せで見つけた「国内」などの別表記もそのまま）。登録は地域の文字で系列を照合する
        workId: work.id, typeId: type.id, territory: current?.territory ?? type.default_territory, windowId: current?.window_id ?? null,
        baseVersion: current?.version_no ?? 0, typeVersionNo: type.version_no,
        start_on: value.start_on, end_on: value.end_on, announce_on: value.announce_on, date_precision: value.date_precision,
        timing_raw: value.timing_raw, status: value.status,
        fields: Object.entries(value.fields).map(([k, v]) => ({k, t: v.t ?? null, n: v.n ?? null})),
      });
    }
    if (result.errors.length) { result.action = 'error'; continue; }
    if (!context.editable.has(work.id) && rowChanges.length) { result.errors.push('この作品の編集権限がありません'); result.action = 'error'; continue; }
    result.changes = rowChanges;
    result.action = rowChanges.some((change) => change.action === 'append') ? 'append' : rowChanges.length ? 'revise' : 'unchanged';
  }
  for (const result of results) if (result.errors.length) { result.action = 'error'; result.changes = []; }
  // 権限のない作品の変更は計画に入れない（エラーの行として返す）
  const errorWorkIds = new Set(results.filter((row) => row.action === 'error').map((row) => workByCode.get(row.workCode.toLowerCase())?.id).filter(Boolean));
  const payload = changes.filter((change) => !errorWorkIds.has(change.workId));
  const counts = {
    rows: results.length,
    append: results.filter((row) => row.action === 'append').length,
    revise: results.filter((row) => row.action === 'revise').length,
    unchanged: results.filter((row) => row.action === 'unchanged').length,
    errors: results.filter((row) => row.action === 'error').length,
    windowsAppend: payload.filter((change) => change.baseVersion === 0).length,
    windowsRevise: payload.filter((change) => change.baseVersion > 0).length,
  };
  return {rows: results, changes: payload, counts, fileWarnings, mapping};
}

// 取込の失敗行を Excel で返す形（元の見出し＋理由）
export function failedWindowRows({headers = [], rows = []}) {
  const failed = rows.filter((row) => row.errors.length);
  return {
    columns: [
      {key: '__row', label: `${REFERENCE_PREFIX}元の行番号`, type: 'int'},
      ...headers.map((header, index) => ({key: `c${index}`, label: header || `列${index + 1}`, type: 'text'})),
      {key: '__error', label: `${REFERENCE_PREFIX}エラー理由`, type: 'text', wrap: true, width: 60},
    ],
    rows: failed.map((row) => ({__row: row.rowNo, __error: row.errors.join(' ／ '), ...Object.fromEntries(headers.map((_, index) => [`c${index}`, row.cells?.[index] ?? '']))})),
  };
}

// 読み込んだ Excel（decodeXlsx の結果）から「ウィンドウ」のシートを表にする
export function tableFromWindowSheets(sheets) {
  const list = Array.isArray(sheets) ? sheets : [];
  const sheet = list.find((item) => item.name === SHEET_NAME) || list.find((item) => !/^_/.test(item.name) && !/^選択肢/.test(item.name) && !item.error);
  if (sheet?.error) throw new Error(`「${sheet.name}」シートに数式のセルがあります。Excelで数式を値に変換してから保存してください`);
  if (!sheet || !sheet.rows?.length) throw new Error(`「${SHEET_NAME}」のシートが見つかりません。出力したExcelを使ってください`);
  const [headers = [], ...rows] = sheet.rows;
  return {headers: headers.map((value) => (value === null || value === undefined ? '' : String(value))), rows: rows.map((cells, index) => ({rowNo: index + 2, cells: cells || []}))};
}
