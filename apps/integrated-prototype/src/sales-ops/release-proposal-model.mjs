// 営業基幹「提案資料」の純関数（月別の5種と SVOD）。ブラウザ・Node・Worker で同じ結果を返す（node:* を使わない）。
// 設計: docs/platform/team-development/sales-proposals.md。
// - 月別: 基準のウィンドウ（PVOD基準は PVOD先行と PVOD②、ほかは1種別）の最新版で、解禁日が対象月にあるもの。取り下げは除き、
//   既定は予定＋確定（「確定だけ」も選べる）。状態の条件は同じ行のほかのウィンドウの列にも当てる（確定だけなら予定のウィンドウは空欄、
//   予定＋確定なら予定のウィンドウを備考に書く）。年まで・時期の原文のウィンドウは表に入れず「月が決まっていない候補」にする。
//   並びは 解禁日（日付 → 月まで）→ 作品コード → ウィンドウ（種別の並び順）。同じ作品のほかのウィンドウを横に並べる。
// - 列は中立の標準の形（取引先ごとの書式は作らない）。データの無い列は空欄で出し、空の列の数を _条件 に書く。
// - SVOD: 提案先（取引先）×提案期間（開始月〜終了月）。区分は 継続（提案先との SVOD 契約が期間内に終わり、その後に続く契約・再契約が無い）・
//   新規（SVOD のウィンドウが期間と重なり、提案先と期間に重なる契約が無い）・注意（他社の独占契約と提案の期間が重なる、または期間の前に権利が切れている）。
//   提案の期間は、提案期間・SVOD のウィンドウ（解禁日・配信期限）・配信の権利範囲（日本）で狭める。
//   提案金額 = 月額単価（SVOD のウィンドウの価格）× 月数（提案の開始月〜終了月。月の途中から始まる月も1か月と数える）。
import {dateBounds, dateText, startText, rightsTerritoryCovers, CHOICE_DOMAINS, WINDOW_STATES, RANGE_DASHES} from './release-window-model.mjs';
import {SETTLEMENT_METHODS} from './partner-list-model.mjs';

export const STATUS_MODES = Object.freeze({all: '予定＋確定', confirmed: '確定だけ'});
export const SHEET_NAME = '提案リスト';
export const CONDITION_SHEET = '_条件';
export const SVOD_SHEET = 'SVOD提案';

// ---- 月別の5種 -------------------------------------------------------------------------------
// groups: 横に並べるウィンドウのまとまり（この順）。基準の種別もまとまりに入れる（価格・視聴権利時間・独占種別を出すため）
const EARLY_GROUPS = Object.freeze(['pvod_second', 'est_early', 'est_regular', 'tvod_early', 'tvod_regular', 'svod_early', 'svod_regular']);
export const PROPOSAL_BASES = Object.freeze([
  Object.freeze({key: 'pvod', label: 'PVOD基準', typeKeys: Object.freeze(['pvod_early', 'pvod_second']),
    groups: Object.freeze(['pvod_early', 'pvod_second', 'est_early', 'est_regular', 'tvod_early', 'tvod_regular', 'svod_early', 'svod_regular'])}),
  Object.freeze({key: 'tvod', label: 'TVOD基準', typeKeys: Object.freeze(['tvod_regular']), groups: Object.freeze(['pvod_second', 'tvod_regular', 'svod_regular'])}),
  Object.freeze({key: 'tvod_early', label: 'TVOD先行基準', typeKeys: Object.freeze(['tvod_early']), groups: EARLY_GROUPS}),
  Object.freeze({key: 'est_early', label: 'EST先行基準', typeKeys: Object.freeze(['est_early']), groups: EARLY_GROUPS}),
  Object.freeze({key: 'est', label: 'EST基準', typeKeys: Object.freeze(['est_regular']), groups: Object.freeze(['pvod_second', 'est_regular', 'tvod_regular', 'svod_regular'])}),
]);
export const basisOf = (key) => PROPOSAL_BASES.find((basis) => basis.key === key) || null;

const blank = (value) => value === null || value === undefined || String(value).trim() === '';
const pad = (n) => String(n).padStart(2, '0');
export const isMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));
export function shiftMonth(month, n) {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${pad((index % 12) + 1)}`;
}
// 画面で選べる年（打ちかけの 0002 などは URL に書かない）
export const MIN_YEAR = 2000, MAX_YEAR = 2100;
export const SVOD_MAX_MONTHS = 60;
const inYearRange = (month) => isMonth(month) && Number(month.slice(0, 4)) >= MIN_YEAR && Number(month.slice(0, 4)) <= MAX_YEAR;
// SVOD の提案期間の入力を1つ変えたときの、URL に書く開始月・終了月（null は URL から消す＝サーバーの既定）。
// 開始月を終了月より後にしたら終了月を消す（既定の開始月＋11か月）。終了月が開始月より前・60か月を超えるときは開始月＋59か月に切り詰める。
// 年が 2000〜2100 の外（打ちかけ）の値は書かない（前の値のまま）
export function nextSvodPeriod({from = null, to = null} = {}, key, value) {
  const next = {from: from || null, to: to || null};
  const text = value ? String(value) : null;
  if (text && !inYearRange(text)) return next;
  next[key] = text;
  if (!next.from || !next.to) return next;
  if (key === 'from' && next.from > next.to) return {...next, to: null};
  const limit = shiftMonth(next.from, SVOD_MAX_MONTHS - 1);
  if (key === 'to' && (next.to < next.from || next.to > limit)) return {...next, to: next.to < next.from ? null : limit};
  if (next.to > limit) return {...next, to: limit};
  return next;
}
export const monthText = (month) => (isMonth(month) ? `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月` : String(month ?? ''));
// 開始月〜終了月の月数（両端を含む）
export const monthsBetween = (from, to) => (Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7))) - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7))) + 1;

// 状態の条件に合うか（取り下げはどちらでも除く）
export function statusAllowed(version, statusMode = 'all') {
  if (!version || version.status === 'withdrawn') return false;
  return statusMode === 'confirmed' ? version.status === 'confirmed' : version.status === 'draft' || version.status === 'confirmed';
}

// 解禁の月（日付・月までのウィンドウだけ）。年まで・時期の原文・未定は null
export function startMonthOf(version) {
  if (!version) return null;
  if (version.date_precision === 'day') return String(version.start_on).slice(0, 7);
  if (version.date_precision === 'month') return String(version.start_on);
  return null;
}

// 並べ替えのキー（日付 → 同じ月の「月まで」→ 作品コード → 種別の並び順）
const sortKey = (version) => (version.date_precision === 'day' ? version.start_on : `${version.start_on}-99`);

// 時期の原文のウィンドウが触れる年の幅（最も早い月の年と、原文に書かれた4桁の年の最小〜最大）。読めなければ null。
// 「2026年12月〜2027年3月」は 2026〜2027、「2027年内」は 2027。年を1つだけ書いた原文の翌年の月は timingMonthSpans で足す
export function rangeYearSpan(version) {
  const years = (String(version?.timing_raw || '').match(/(?<!\d)\d{4}(?!\d)/g) || []).map(Number);
  if (version?.start_on) years.push(Number(String(version.start_on).slice(0, 4)));
  return years.length ? [Math.min(...years), Math.max(...years)] : null;
}

// 時期の原文から読める月の幅の並び [[最初の月, 最後の月], …]（'YYYY-MM'）。頭に4桁の年がある次の書き方だけを読み、ほかは null（年の幅だけで見る）。
// 候補は人が見直す一覧なので、出し漏れより多めに出す（「下旬」「1日」などの日の細かさは月に丸め、季節はその3か月にする）。
// - 年度（4月始まり）: 「2026年度」4月〜翌3月、「2026年度上期」4〜9月、「2026年度下期」10月〜翌3月（上期と下期の両方は年度全体）、
//   「2026年度末」翌3月、四半期「2026年度第N四半期」「2026年度QN」（第1は4〜6月 … 第4は翌1〜3月）。
//   四半期の範囲「第N〜M四半期」「第N四半期〜第M四半期」「第N四半期から第M四半期」はその全部の月、
//   並び「第N四半期・第M四半期」「第N・M四半期」「第N四半期と第M四半期」はそれぞれの四半期の月（幅を2つ返す）
// - 月・季節の範囲: 「2026年12月〜3月」「2026年12〜3月」「2026/12〜3月」「2026年12月下旬〜3月」「2026年12月中旬〜2月上旬」「2026年12月1日〜3月31日」
//   「2026年12月〜翌3月」「2026年12月〜2027年3月」「2026年1〜3月」「2026年秋〜翌春」。区切りは 〜・～・-・—・―・ー・から など（RANGE_DASHES）。
//   終わりに年も「翌」も無く、終わりの月が始まりの月より前なら翌年の月。「翌」「翌年」は頭の年の翌年。
//   季節は 春=3〜5月・夏=6〜8月・秋=9〜11月・冬=12〜翌2月
// - 冬: 「2026年冬」12月〜翌2月（翌年の1〜2月かもしれない）。ほかの季節だけの原文（「2026年秋」）は年の中に収まるので読まない
const RANGE_SEP = `(?:[${RANGE_DASHES}]|から)`;
const LIST_SEP = '(?:[・、,/]|と|および|及び|または|又は)';
const SEASON_MONTHS = Object.freeze({春: [3, 5], 夏: [6, 8], 秋: [9, 11], 冬: [12, 14]}); // 冬の終わりの 14 は翌年の2月
const DAY_PART = '(?:\\d{1,2}日?|上旬|中旬|下旬|初旬|初め|初|頭|半ば|中|末|頃|ごろ)';
// 始まり: 月（「12月」「12月下旬」「12月1日」「12」「12/1」）か季節。区切り。終わり: （「翌」「翌年」か4桁の年）と、月か季節
const MONTH_OR_SEASON_RANGE = new RegExp(
  `^(?:(\\d{1,2})(?:月${DAY_PART}?|[/.\\-]\\d{1,2}日?)?|(春|夏|秋|冬))${RANGE_SEP}`
  + `(?:(翌年?の?)|(\\d{4})(?:年|[/.\\-]))?(?:(\\d{1,2})(?=月|[/.\\-]\\d|$)|(春|夏|秋|冬))`);
// 四半期のまとまり（「第3四半期〜第4四半期」「第2・4四半期」「Q3-Q4」）。数字の間の区切りで範囲か並びかを決める
const QUARTER_PHRASE = new RegExp(`(?:第|Q)[1-4](?!\\d)(?:四半期)?(?:(?:${RANGE_SEP}|${LIST_SEP})(?:第|Q)?[1-4](?!\\d)(?:四半期)?)*`, 'gi');
const RANGE_ONLY = new RegExp(`^${RANGE_SEP}$`);
// 年度の四半期の並び [[最初の四半期, 最後の四半期], …]。後ろの四半期が前より小さい範囲は読まない（null）
function fiscalQuarters(text) {
  for (const [phrase] of text.matchAll(QUARTER_PHRASE)) {
    if (!/四半期|q/i.test(phrase)) continue; // 「第3週」などの四半期でない「第N」
    const numbers = phrase.match(/[1-4]/g).map(Number);
    const gaps = phrase.split(/[1-4]/).slice(1, -1).map((gap) => gap.replace(/四半期|第|q/gi, ''));
    const spans = [[numbers[0], numbers[0]]];
    numbers.slice(1).forEach((n, i) => { if (RANGE_ONLY.test(gaps[i])) spans[spans.length - 1][1] = n; else spans.push([n, n]); });
    return spans.every(([first, last]) => first <= last) ? spans : null;
  }
  return null;
}
export function timingMonthSpans(text) {
  const t = String(text ?? '').normalize('NFKC').replace(/\s+/g, '');
  const head = /^(\d{4})(?:年|[/.\-])?/.exec(t);
  if (!head) return null;
  const year = Number(head[1]);
  const rest = t.slice(head[0].length);
  const ym = (y, m) => `${String(y).padStart(4, '0')}-${pad(m)}`;
  if (rest.startsWith('度')) {
    // 年度の4月から何か月目か（0 始まり）
    const fiscal = (from, to) => [shiftMonth(ym(year, 4), from), shiftMonth(ym(year, 4), to)];
    // 区切りの後ろに同じ年度をもう一度書いた原文（「2026年度Q3〜2026年度Q4」「2026年度第2四半期・2026年度第4四半期」）は、繰り返しの年度を外して読む
    const after = rest.slice(1).replace(new RegExp(`(${RANGE_SEP}|${LIST_SEP})${year}年?度`, 'g'), '$1');
    const quarters = fiscalQuarters(after);
    if (quarters) return quarters.map(([first, last]) => fiscal((first - 1) * 3, last * 3 - 1));
    const upper = /上半?期/.test(after), lower = /下半?期/.test(after);
    if (upper || lower) return [fiscal(upper ? 0 : 6, lower ? 11 : 5)];
    if (after.startsWith('末')) return [fiscal(11, 11)];
    return [fiscal(0, 11)];
  }
  const range = MONTH_OR_SEASON_RANGE.exec(rest);
  if (range) {
    const [, fromMonth, fromSeason, next, toYear, toMonth, toSeason] = range;
    const start = fromMonth ? Number(fromMonth) : SEASON_MONTHS[fromSeason][0];
    const [endFirst, endLast] = toMonth ? [Number(toMonth), Number(toMonth)] : SEASON_MONTHS[toSeason];
    if (start < 1 || start > 12 || endFirst < 1 || endFirst > 12) return null;
    const endYear = toYear ? Number(toYear) : next ? year + 1 : endFirst < start ? year + 1 : year;
    const span = [ym(year, start), shiftMonth(ym(endYear, endFirst), endLast - endFirst)];
    return span[0] <= span[1] ? [span] : null;
  }
  if (rest.includes('冬')) return [[ym(year, 12), ym(year + 1, 2)]];
  return null;
}

// 時期の原文のウィンドウを、その月（'YYYY-MM'）の「月が決まっていない候補」に出すか。
// 原文から読める月の幅（timingMonthSpans）の月と、年の幅（rangeYearSpan）の各月の両方に出す（候補は人が見直す一覧なので、出し漏れより多めに出す）
export function rangeCoversMonth(version, month) {
  const spans = timingMonthSpans(version?.timing_raw);
  if (spans && spans.some(([from, to]) => from <= month && month <= to)) return true;
  const years = rangeYearSpan(version);
  const year = Number(month.slice(0, 4));
  return Boolean(years && years[0] <= year && year <= years[1]);
}

// works: [{id, code, title, ...}]、windowsOf(workId) → Map(type_key → 版)（既定の地域・最新の版）、types: Map(type_key → 種別)
// → {rows: [{work, typeKey, version}], undated: [{work, typeKey, version}]}
export function selectProposalEntries(basis, {month, statusMode = 'all', works = [], windowsOf, types = new Map()}) {
  const rows = [], undated = [];
  const year = month.slice(0, 4);
  for (const work of works) {
    const windows = windowsOf(work.id) || new Map();
    for (const typeKey of basis.typeKeys) {
      const version = windows.get(typeKey);
      if (!statusAllowed(version, statusMode)) continue;
      const start = startMonthOf(version);
      if (start) {
        if (start === month) rows.push({work, typeKey, version});
        continue;
      }
      // 年まで（その年）・時期の原文（原文から読める月の幅の月と、最も早い月の年から原文に書かれた最も遅い年までの月）は
      // 「月が決まっていない候補」。未定は入れない
      if (version.date_precision === 'year' && version.start_on === year) undated.push({work, typeKey, version});
      else if (version.date_precision === 'range' && rangeCoversMonth(version, month)) undated.push({work, typeKey, version});
    }
  }
  const order = (typeKey) => types.get(typeKey)?.sort_order ?? 0;
  rows.sort((a, b) => (sortKey(a.version) < sortKey(b.version) ? -1 : sortKey(a.version) > sortKey(b.version) ? 1
    : a.work.code < b.work.code ? -1 : a.work.code > b.work.code ? 1 : order(a.typeKey) - order(b.typeKey)));
  undated.sort((a, b) => (a.work.code < b.work.code ? -1 : a.work.code > b.work.code ? 1 : order(a.typeKey) - order(b.typeKey)));
  return {rows, undated};
}

// 月ごとの件数（日付・月までのウィンドウだけ）。→ [{month, count}]（月の順）
export function proposalMonthCounts(basis, {statusMode = 'all', works = [], windowsOf}) {
  const counts = new Map();
  for (const work of works) {
    const windows = windowsOf(work.id) || new Map();
    for (const typeKey of basis.typeKeys) {
      const version = windows.get(typeKey);
      if (!statusAllowed(version, statusMode)) continue;
      const start = startMonthOf(version);
      if (start) counts.set(start, (counts.get(start) || 0) + 1);
    }
  }
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, count]) => ({month: m, count}));
}

// ---- 列 -------------------------------------------------------------------------------------
// ウィンドウのまとまりの項目。EST（買い切り）と SVOD（定額）は視聴権利時間を出さない。SVOD の価格は月額単価
const GROUP_FIELDS = Object.freeze(['price_ex_tax', 'viewing_hours', 'exclusivity']);
const withoutHours = (typeKey) => typeKey.startsWith('est_') || typeKey.startsWith('svod_');
export function groupParts(type) {
  const parts = [{part: 'start', label: type.start_label || '解禁日', cell: 'date'}];
  if (type.date_mode !== 'point') parts.push({part: 'end', label: type.end_label || '配信期限', cell: 'date'});
  for (const key of GROUP_FIELDS) {
    if (key === 'viewing_hours' && withoutHours(type.type_key)) continue;
    const field = (type.fields || []).find((item) => item.field_key === key);
    if (!field) continue;
    const label = key === 'price_ex_tax' && type.type_key.startsWith('svod_') ? '月額単価（税抜）' : field.label;
    parts.push({part: `field:${key}`, label, field, cell: field.value_type === 'yen' ? 'yen' : field.value_type === 'integer' ? 'int' : 'text'});
  }
  return parts;
}

const WORK_COLUMNS = Object.freeze([
  ['work_code', '作品コード', 'code'], ['work_title', '題名', 'text'], ['title_kana', 'フリガナ', 'text'], ['title_en', '英題', 'text'], ['genre', 'ジャンル', 'text'],
  ['production_year', '製作年', 'year'], ['runtime_minutes', '尺（分）', 'int'], ['rating', 'レーティング', 'text'], ['countries', '製作国', 'text'],
  ['languages', '言語', 'text'], ['copyright', 'コピーライト', 'text'],
]);
const DETAIL_COLUMNS = Object.freeze([
  ['catch', 'キャッチ', 'text', true], ['synopsis_short', 'あらすじ（短）', 'text', true], ['synopsis_long', 'あらすじ（長）', 'text', true],
  ['intro_short', 'イントロダクション（短）', 'text', true], ['intro_long', 'イントロダクション（長）', 'text', true], ['credits', 'クレジット', 'text', true],
  ['caution', '注意事項', 'text', true], ['info_url', '作品情報URL', 'text'], ['image_ref', '画像の参照', 'text'], ['image_file_name', '画像のファイル名', 'text'],
]);

// 基準の列の並び。types: Map(type_key → 種別の最新の版)。使っていない・無い種別のまとまりは出さない。
// 各列: {key, label（Excel の見出し）, group（画面の1段目）, part（画面の2段目）, type（Excel の書式）}
export function proposalColumns(basis, types) {
  const columns = [
    {key: 'basis_type', group: '基準のウィンドウ', part: '種別', label: '基準の種別', type: 'text'},
    {key: 'basis_start', group: '基準のウィンドウ', part: '解禁日', label: '基準の解禁日', type: 'date'},
    {key: 'basis_end', group: '基準のウィンドウ', part: '配信期限', label: '基準の配信期限', type: 'date'},
    {key: 'basis_status', group: '基準のウィンドウ', part: '状態', label: '基準の状態', type: 'text'},
    ...WORK_COLUMNS.map(([key, label, type]) => ({key, group: '作品', part: label, label, type})),
  ];
  for (const typeKey of basis.groups) {
    const type = types.get(typeKey);
    if (!type || type.active === false) continue;
    for (const part of groupParts(type)) {
      columns.push({key: `${typeKey}:${part.part}`, group: type.label, part: part.label, label: `${type.label} ${part.label}`, type: part.cell, typeKey, windowPart: part.part, field: part.field || null});
    }
  }
  columns.push({key: 'rights_end', group: '権利', part: '権利期限', label: '権利期限', type: 'date'});
  columns.push({key: 'rights_scope', group: '権利', part: '配信権', label: '配信権', type: 'text', wrap: true});
  for (const [key, label, type, wrap] of DETAIL_COLUMNS) columns.push({key, group: '作品詳細', part: label, label, type, ...(wrap ? {wrap: true} : {})});
  columns.push({key: 'note', group: '', part: '備考', label: '備考', type: 'text', wrap: true});
  return columns;
}

// 日付の出し方: 日付は ISO（Excel では日付）、月まで・年までは「2026年10月」「2027年」、時期の原文・未定はその文字
const dateCellOf = (value) => (blank(value) ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : dateText(value));
const startCellOf = (version) => (!version ? null : ['day', 'month', 'year'].includes(version.date_precision) ? dateCellOf(version.start_on) : startText(version) || null);

// 追加項目の値（金額・整数は数、選択肢は日本語）
function fieldValue(field, version) {
  const value = version?.fields?.[field.field_key];
  if (!value) return null;
  if (field.value_type === 'yen' || field.value_type === 'integer') return value.n ?? null;
  if (field.value_type === 'choice') return CHOICE_DOMAINS[field.choice_domain]?.[value.t] || value.t || null;
  return value.t ?? null;
}

const ROLE_LABELS = Object.freeze({director: '監督', writer: '脚本', cast: 'キャスト', staff: 'スタッフ'});
// クレジットの文字（監督: A／脚本: B／キャスト: C、D／スタッフ: 撮影 E、音楽 F）
export function creditsText(credits = []) {
  const parts = [];
  for (const role of ['director', 'writer', 'cast', 'staff']) {
    const names = credits.filter((credit) => credit.role === role).map((credit) => (role === 'staff' && credit.detail ? `${credit.detail} ${credit.name}` : credit.name));
    if (names.length) parts.push(`${ROLE_LABELS[role]}: ${names.join('、')}`);
  }
  return parts.join('／') || null;
}

// 本編の映像版（キーが main → 最初の映像版の順）
export function mainEdition(editions = []) {
  if (!editions.length) return null;
  return editions.find((edition) => edition.edition_key === 'main') || [...editions].sort((a, b) => (a.edition_key < b.edition_key ? -1 : 1))[0];
}

const EXCLUSIVITY = Object.freeze({exclusive: '独占', nonexclusive: '非独占', unknown: '独占未確認'});
const mediaText = (value) => String(value ?? '').normalize('NFKC').replace(/_/g, '・').trim();
// 配信の権利（媒体が配信・全媒体・空欄で、地域が日本を含むもの）
export function digitalRights(scopes = []) {
  return scopes.filter((scope) => {
    const media = mediaText(scope.channel);
    return (!media || media === '全媒体' || media === '配信') && rightsTerritoryCovers(scope.territory, '日本');
  });
}
// 権利期限（配信の権利の終了日の最も遅いもの。終了日の無い権利しか無ければ空欄）と配信権の文字
export function rightsCells(scopes = []) {
  const digital = digitalRights(scopes);
  const ends = digital.map((scope) => scope.rights_end).filter(Boolean).sort();
  const texts = [...new Set(digital.map((scope) => `${mediaText(scope.channel) || '全媒体'}・${scope.territory || '地域未確認'}・${EXCLUSIVITY[scope.exclusivity] || '独占未確認'}${scope.rights_start || scope.rights_end ? `（${dateText(scope.rights_start) || '開始未確認'}〜${dateText(scope.rights_end) || '終了未確認'}）` : ''}`))];
  return {rights_end: ends.at(-1) || null, rights_scope: texts.join('／') || null};
}

// 1行。entry: {work, typeKey, version}、context: {windows: Map(type_key → 版), types: Map, catalog: 作品カタログの最新版 {…, credits, editions}|null,
//   profile: 提案用の作品情報の最新版|null, scopes: 権利範囲の配列}、statusMode: 状態の条件（ほかのウィンドウの列にも当てる）
export function proposalRow(entry, columns, {windows = new Map(), types = new Map(), catalog = null, profile = null, scopes = []} = {}, statusMode = 'all') {
  const {work, typeKey, version} = entry;
  const edition = mainEdition(catalog?.editions || []);
  const rights = rightsCells(scopes);
  const rating = edition ? [edition.rating_code, edition.rating_authority ? `（${edition.rating_authority}）` : ''].filter(Boolean).join('') || null : null;
  const notes = [];
  if (version.date_precision === 'month') notes.push('解禁日は月まで（日は未定）');
  const values = {
    basis_type: types.get(typeKey)?.label || typeKey,
    basis_start: startCellOf(version),
    basis_end: dateCellOf(version.end_on),
    basis_status: WINDOW_STATES[version.status] || version.status,
    work_code: work.code, work_title: work.title,
    title_kana: profile?.title_kana ?? null, title_en: profile?.title_en ?? null, genre: profile?.genre ?? null,
    production_year: catalog?.production_year ?? null,
    runtime_minutes: edition?.runtime_seconds ? Math.round(edition.runtime_seconds / 60) : null,
    rating,
    countries: (edition?.country || []).join('・') || null,
    languages: (edition?.language || []).join('・') || null,
    copyright: profile?.copyright_notice ?? null,
    rights_end: rights.rights_end, rights_scope: rights.rights_scope,
    catch: catalog?.catch_short || catalog?.catch_long || null,
    synopsis_short: catalog?.synopsis_short ?? null, synopsis_long: catalog?.synopsis_long ?? null,
    intro_short: profile?.intro_short ?? null, intro_long: profile?.intro_long ?? null,
    credits: creditsText(catalog?.credits || []),
    caution: profile?.caution ?? null, info_url: profile?.info_url ?? null,
    image_ref: profile?.image_url || profile?.image_key || null, image_file_name: profile?.image_file_name ?? null,
    note: notes.join('／') || null,
  };
  for (const column of columns) {
    if (!column.typeKey) continue;
    const other = windows.get(column.typeKey);
    // 取り下げはどちらの条件でも除く。確定だけのときは予定のウィンドウも空欄にする
    const shown = statusAllowed(other, statusMode) ? other : null;
    if (column.windowPart === 'start') values[column.key] = startCellOf(shown);
    else if (column.windowPart === 'end') values[column.key] = shown ? dateCellOf(shown.end_on) : null;
    else values[column.key] = shown ? fieldValue(column.field, shown) : null;
  }
  // ほかのウィンドウの状態の印（状態の列は基準のウィンドウだけなので、予定のウィンドウを備考に書く）
  const others = [...new Set(columns.filter((column) => column.typeKey && column.typeKey !== typeKey).map((column) => column.typeKey))];
  const drafts = others.filter((key) => windows.get(key)?.status === 'draft').map((key) => types.get(key)?.label || key);
  if (drafts.length) notes.push(statusMode === 'confirmed' ? `予定のウィンドウは出していません（${drafts.join('・')}）` : `予定のウィンドウ: ${drafts.join('・')}`);
  values.note = notes.join('／') || null;
  return values;
}

// 全行が空の列
export function emptyColumns(columns, rows) {
  return columns.filter((column) => rows.every((row) => blank(row[column.key])));
}

// 月が決まっていない候補の1行（_条件と画面）
export const undatedText = ({work, typeKey, version}, types = new Map()) => `${work.code} ${work.title}・${types.get(typeKey)?.label || typeKey}・${startText(version)}（${WINDOW_STATES[version.status] || version.status}）`;

// ---- SVOD ------------------------------------------------------------------------------------
export const SVOD_TYPE_KEYS = Object.freeze(['svod_early', 'svod_regular']);
export const SVOD_CATEGORIES = Object.freeze({renewal: '継続', new: '新規', caution: '注意'});
const OPEN_END = '9999-12-31';
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const lastDayOf = (month) => `${month}-${pad(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate())}`;
const contractEnd = (contract) => (contract.end_rule === 'date' ? contract.contract_end || null : null);
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart <= (bEnd || OPEN_END) && bStart <= (aEnd || OPEN_END);

// SVOD のウィンドウの幅。日付・月・年は幅（年までは1月1日から）、時期の原文は最も早い月の1日から（終わりは配信期限か不明）。未定は null
export function svodSpan(version) {
  if (!version) return null;
  let start = null;
  if (['day', 'month', 'year'].includes(version.date_precision)) start = dateBounds(version.start_on)?.[0] || null;
  else if (version.date_precision === 'range' && isMonth(version.start_on)) start = `${version.start_on}-01`;
  if (!start) return null;
  const end = dateBounds(version.end_on)?.[1] || null;
  return {start, end};
}

// 提案のウィンドウ: 提案の期間（span）と重なる SVOD のウィンドウのうち、通常 → 先行 の順で1つ
function pickWindow(svodWindows, spanStart, spanEnd) {
  for (const typeKey of ['svod_regular', 'svod_early']) {
    const candidate = svodWindows.find((item) => item.typeKey === typeKey && item.span && overlaps(item.span.start, item.span.end, spanStart, spanEnd));
    if (candidate) return candidate;
  }
  return null;
}

// partnerId: 提案先（null は「取引先を選ばない」＝新規は SVOD のウィンドウだけで決める）。from・to: 'YYYY-MM'
// works: [{id, code, title}]、svodWindowsOf(workId) → [{typeKey, typeLabel, version}]（最新の版・既定の地域）
// contracts: 取引先別リストの明細の最新の版のうち SVOD のもの
//   [{entry_id, renews_entry_id, partner_id, partner_name, work_id, contract_start, contract_end, end_rule, exclusivity, status, settlement_method, amount_ex_tax}]
// → {rows: [...], subtotals: {renewal, new, caution: {count, months, amount, priced}}, total}
export function svodProposal({partnerId = null, from, to, statusMode = 'all', works = [], svodWindowsOf, contracts = [], rightsOf = () => []}) {
  const periodStart = `${from}-01`, periodEnd = lastDayOf(to);
  const live = contracts.filter((contract) => contract.status !== 'withdrawn' && contract.contract_start);
  // 再契約元として指されている明細（予定の再契約も含む。新規の判定が予定の明細も「既にある」とみなすのと揃える）
  const renewed = new Set(live.filter((contract) => contract.renews_entry_id).map((contract) => contract.renews_entry_id));
  const rows = [];
  for (const work of works) {
    const withSpan = (item) => ({...item, span: svodSpan(item.version)});
    const svodWindows = (svodWindowsOf(work.id) || []).filter((item) => statusAllowed(item.version, statusMode)).map(withSpan);
    // 状態で絞る前のウィンドウ（確定だけのとき、予定のウィンドウが重なるだけかを備考で分けるため）
    const anyWindows = (svodWindowsOf(work.id) || []).filter((item) => statusAllowed(item.version, 'all')).map(withSpan);
    const own = live.filter((contract) => contract.work_id === work.id && partnerId !== null && contract.partner_id === partnerId);
    const candidates = [];
    // 継続: 作品ごとに1回だけ判定する。提案先との明細のうち最も遅く終わるものが、契約済みで、日付で終わり、終了日が期間の中にあり、
    // 再契約元として指されていないとき。終わりの無い明細（end_rule が日付でない）があれば続いているので出さない
    if (own.length && own.every((contract) => contractEnd(contract))) {
      const latest = own.reduce((best, contract) => (!best || contractEnd(contract) > contractEnd(best) ? contract : best), null);
      const end = contractEnd(latest);
      if (latest.status === 'contracted' && !renewed.has(latest.entry_id) && end >= periodStart && end <= periodEnd) {
        const start = addDays(end, 1) > periodStart ? addDays(end, 1) : periodStart;
        if (start <= periodEnd) candidates.push({category: 'renewal', contract: latest, start});
      }
    }
    // 新規: SVOD のウィンドウが期間と重なり、提案先との明細（予定・契約済み）が期間と重ならないもの
    if (!candidates.length && svodWindows.some((item) => item.span && overlaps(item.span.start, item.span.end, periodStart, periodEnd))
      && !own.some((contract) => overlaps(contract.contract_start, contractEnd(contract), periodStart, periodEnd))) {
      candidates.push({category: 'new', contract: null, start: periodStart});
    }
    for (const candidate of candidates) {
      const window = pickWindow(svodWindows, candidate.start, periodEnd);
      let start = candidate.start, end = periodEnd;
      if (window) {
        if (window.span.start > start) start = window.span.start;
        if (window.span.end && window.span.end < end) end = window.span.end;
      }
      if (start > end) continue;
      const notes = [];
      // 配信・日本の権利範囲でも狭める（権利が登録されていなければ狭めない）。終わりはすべての範囲に終了日があるとき最も遅い終了日、
      // 始まりはすべてに開始日があるとき最も早い開始日
      const digital = digitalRights(rightsOf(work.id));
      let rightsExpired = null;
      if (digital.length && digital.every((scope) => scope.rights_end)) {
        const rightsEnd = digital.map((scope) => String(scope.rights_end)).sort().at(-1);
        if (rightsEnd < end) {
          end = rightsEnd;
          if (start > end) rightsExpired = rightsEnd;
          else notes.push(`権利期限 ${dateText(rightsEnd)} で終了日を狭めた`);
        }
      }
      if (!rightsExpired && digital.length && digital.every((scope) => scope.rights_start)) {
        const rightsStart = digital.map((scope) => String(scope.rights_start)).sort()[0];
        if (rightsStart > start) {
          start = rightsStart;
          if (start > end) continue;
          notes.push(`権利の開始 ${dateText(rightsStart)} から数えた`);
        }
      }
      const months = rightsExpired ? 0 : monthsBetween(start.slice(0, 7), end.slice(0, 7));
      const unitPrice = window?.version?.fields?.price_ex_tax?.n ?? null;
      const amount = rightsExpired || unitPrice === null ? null : unitPrice * months;
      // 注意: 他の取引先の独占の契約（予定・契約済み）が提案の期間と重なる
      const blocking = rightsExpired ? [] : live.filter((contract) => contract.work_id === work.id && contract.partner_id !== partnerId && contract.exclusivity === 'exclusive'
        && overlaps(contract.contract_start, contractEnd(contract), start, end));
      if (rightsExpired) notes.push(`権利期限 ${dateText(rightsExpired)} を過ぎている（提案期間に権利が無い）`);
      const precision = window?.version?.date_precision;
      if (precision === 'range') notes.push(`解禁は時期のみ（${window.version.timing_raw || '時期未定'}）`);
      if (precision === 'year') notes.push(`解禁は年まで（${window.version.start_on}年・月は未定。提案は1月1日から数えた）`);
      if (precision === 'month') notes.push('解禁日は月まで（日は未定）');
      if (window && /^\d{4}$/.test(String(window.version.end_on ?? ''))) notes.push('配信期限は年まで（年末まで数えた）');
      if (window && /^\d{4}-\d{2}$/.test(String(window.version.end_on ?? ''))) notes.push('配信期限は月まで（月末まで数えた）');
      if (window && window.version.status === 'draft') notes.push('SVOD のウィンドウは予定');
      if (unitPrice === null && !rightsExpired) {
        if (window) notes.push('SVOD のウィンドウに月額単価が無い');
        else if (statusMode === 'confirmed' && pickWindow(anyWindows, candidate.start, periodEnd)) notes.push('SVOD のウィンドウは予定のみ（確定だけの条件で除外）');
        else notes.push('期間に重なる SVOD のウィンドウが無い');
      }
      const rights = rightsCells(rightsOf(work.id));
      const category = rightsExpired || blocking.length ? 'caution' : candidate.category;
      rows.push({
        category,
        base_category: candidate.category,
        category_label: SVOD_CATEGORIES[category],
        work_id: work.id, work_code: work.code, work_title: work.title,
        window_type: window?.typeLabel || null, window_start: startCellOf(window?.version), window_end: window ? dateCellOf(window.version.end_on) : null,
        window_exclusivity: window ? fieldValue({field_key: 'exclusivity', value_type: 'choice', choice_domain: 'exclusivity'}, window.version) : null,
        window_status: window ? WINDOW_STATES[window.version.status] : null,
        contract_start: candidate.contract?.contract_start || null, contract_end: candidate.contract ? contractEnd(candidate.contract) : null,
        // 取引方法は取引先別リストと同じ表示名（未確認・その他など）
        contract_method: candidate.contract ? (SETTLEMENT_METHODS[candidate.contract.settlement_method] ?? candidate.contract.settlement_method ?? null) : null,
        contract_amount: candidate.contract?.amount_ex_tax ?? null,
        blocking: blocking.map((contract) => `${contract.partner_name} ${dateText(contract.contract_start)}〜${contractEnd(contract) ? dateText(contractEnd(contract)) : '終了なし'}（独占）`).join('／') || null,
        proposal_start: rightsExpired ? null : start, proposal_end: rightsExpired ? null : end, months, unit_price: unitPrice, amount,
        rights_end: rights.rights_end,
        note: notes.join('／') || null,
      });
    }
  }
  const categoryOrder = {renewal: 0, new: 1, caution: 2};
  rows.sort((a, b) => categoryOrder[a.category] - categoryOrder[b.category] || (a.work_code < b.work_code ? -1 : a.work_code > b.work_code ? 1 : 0));
  const tally = (list) => ({count: list.length, months: list.reduce((n, row) => n + row.months, 0), amount: list.reduce((n, row) => n + (row.amount ?? 0), 0), priced: list.filter((row) => row.amount !== null).length});
  const subtotals = Object.fromEntries(Object.keys(SVOD_CATEGORIES).map((key) => [key, tally(rows.filter((row) => row.category === key))]));
  return {rows, subtotals, total: tally(rows), period: {from, to, start: periodStart, end: periodEnd, months: monthsBetween(from, to)}};
}

export const SVOD_COLUMNS = Object.freeze([
  {key: 'category_label', label: '区分', type: 'text'},
  {key: 'work_code', label: '作品コード', type: 'code'},
  {key: 'work_title', label: '題名', type: 'text'},
  {key: 'window_type', label: '提案のウィンドウ', type: 'text'},
  {key: 'window_start', label: 'ウィンドウの解禁日', type: 'date'},
  {key: 'window_end', label: 'ウィンドウの配信期限', type: 'date'},
  {key: 'window_exclusivity', label: 'ウィンドウの独占種別', type: 'text'},
  {key: 'window_status', label: 'ウィンドウの状態', type: 'text'},
  {key: 'contract_start', label: '現契約の開始日', type: 'date'},
  {key: 'contract_end', label: '現契約の終了日', type: 'date'},
  {key: 'contract_method', label: '現契約の取引方法', type: 'text'},
  {key: 'contract_amount', label: '現契約の契約金額（税抜）', type: 'yen'},
  {key: 'blocking', label: '他社の独占', type: 'text', wrap: true},
  {key: 'proposal_start', label: '提案の配信開始日', type: 'date'},
  {key: 'proposal_end', label: '提案の配信終了日', type: 'date'},
  {key: 'months', label: '月数', type: 'int'},
  {key: 'unit_price', label: '月額単価（税抜）', type: 'yen'},
  {key: 'amount', label: '提案金額（税抜）', type: 'yen'},
  {key: 'rights_end', label: '権利期限', type: 'date'},
  {key: 'note', label: '備考', type: 'text', wrap: true},
]);

// Excel の行（区分ごとの小計の行を区分の後ろに入れる）
export function svodSheetRows(result) {
  const out = [];
  for (const key of Object.keys(SVOD_CATEGORIES)) {
    const members = result.rows.filter((row) => row.category === key);
    if (!members.length) continue;
    out.push(...members);
    const s = result.subtotals[key];
    out.push({__kind: 'subtotal', category_label: `${SVOD_CATEGORIES[key]} 小計（${s.count}件）`, months: s.months, amount: s.amount});
  }
  return out;
}
