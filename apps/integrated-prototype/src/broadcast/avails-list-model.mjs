// 放送アベイルズリスト（放送局へ出す作品の一覧。Excel）の純関数。ブラウザ・node・Worker 共通。
// 定型業務の「放送アベイルズリスト」と同じ17列の意味を、取引先固有の書式や社名の入らない中立の見出しで出す。
// - 作品名の貼り付け（1〜200行）→ 照合（一致・候補が複数・見つからない）→ 選択・並べ替え → Excel
// - 直近の放送局（3局まで）は確定の枠と実放送から自動で出し、連続する月は1つの期間にまとめて（予定）（一部予定）を付ける
// - 放送アベイルズ状況は、商品別の放送ウィンドウ提案（window-proposal-model.mjs）の結果の一文
// 名前の衝突に注意: 今ある /api/broadcast/avails は「販売条件の一覧」で、このリストとは別物（API の名前は互換のため残す）
import {dateBounds} from '../sales-ops/release-window-model.mjs';
import {ymText, dateSlash} from './intervals.mjs';

export const AVAILS_LINE_LIMIT = 200;
export const MATCH_STATES = Object.freeze({matched: '一致', ambiguous: '候補が複数', not_found: '見つからない'});
export const MATCH_LEVELS = Object.freeze({exact: '完全一致', prefix: '前方一致', partial: '部分一致'});
const key = (value) => String(value ?? '').normalize('NFKC').replace(/[\s　・･「」『』"'（）()【】\[\]]+/g, '').toLowerCase();

// 貼り付けた文字 → 行（空行は飛ばす）。{lines} か {error}
export function splitTitleLines(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return {error: '作品名を1行に1つ貼り付けてください'};
  if (lines.length > AVAILS_LINE_LIMIT) return {error: `一度に照合できるのは${AVAILS_LINE_LIMIT}行までです（${lines.length}行あります）`};
  if (lines.some((line) => line.length > 300)) return {error: '1行は300文字までです'};
  return {lines};
}

// 照合。作品名・作品コード・商品の品番と名前の、完全一致 → 前方一致 → 部分一致 の順で、最初に当たった段の候補で決める。
// works: [{id, code, title, production_year?}]、products: [{work_id, sku, name}]
export function matchTitles(lines, works, products = []) {
  const names = new Map(works.map((w) => [w.id, [w.title, w.code]]));
  for (const p of products) if (names.has(p.work_id)) names.get(p.work_id).push(p.sku, p.name);
  const keyed = works.map((w) => ({work: w, keys: [...new Set(names.get(w.id).map(key).filter(Boolean))]}));
  const order = (a, b) => (Number(a.production_year) || 0) - (Number(b.production_year) || 0) || String(a.title).localeCompare(String(b.title), 'ja') || a.id - b.id;
  return lines.map((input, index) => {
    const k = key(input);
    let hits = [];
    let level = null;
    for (const [name, test] of [['exact', (x) => x === k], ['prefix', (x) => x.startsWith(k)], ['partial', (x) => x.includes(k)]]) {
      hits = k ? keyed.filter((item) => item.keys.some(test)).map((item) => item.work) : [];
      if (hits.length) { level = name; break; }
    }
    hits.sort(order);
    const status = !hits.length ? 'not_found' : hits.length === 1 ? 'matched' : 'ambiguous';
    return {lineNo: index + 1, input, status, level, candidates: hits.slice(0, 20).map((w) => ({id: w.id, code: w.code, title: w.title, production_year: w.production_year ?? null})), more: Math.max(0, hits.length - 20)};
  });
}

// 照合の応答（API とプレビューで同じ）。source は照合の元（/api/broadcast/availability-list/candidates の works・products）。
// {error} か {rows, counts}
export function availsMatchResult(text, source = {}) {
  const split = splitTitleLines(text);
  if (split.error) return {error: split.error};
  const rows = matchTitles(split.lines, source.works || [], source.products || []);
  // prefix・partial は「一致」のうち前方一致・部分一致で1件に決まった行の数（自動では入れず、利用者が確かめて入れる）
  const counts = {matched: 0, ambiguous: 0, not_found: 0, prefix: 0, partial: 0};
  for (const row of rows) {
    counts[row.status] += 1;
    if (needsConfirm(row)) counts[row.level] += 1;
  }
  return {rows, counts};
}

// 前方一致・部分一致で1件に決まった行。1〜2文字の貼り付けや題名の一部が、たまたま1つの作品に当たっただけのことがあるので、
// 段を示して、作品名を確かめて「入れる」を押してもらう
export const needsConfirm = (row) => row?.status === 'matched' && row.level !== 'exact';

// 照合の後に自動でリストへ入れる作品。正規化（NFKC・空白と括弧の除去・小文字）した上で完全一致して1件に決まった行だけ
export function autoPickRows(rows = []) {
  return rows.filter((row) => row.status === 'matched' && row.level === 'exact').map((row) => row.candidates[0]);
}

// リストに入れる作品へ足す（同じ作品は1つだけ・AVAILS_LINE_LIMIT 件まで・今の順の後ろへ）。
// → {next, added, already, overLimit}（added は新しく入れた件数、already はもう入っていた件数、overLimit は上限で入れなかった件数）
export function addToSelection(current = [], works = [], limit = AVAILS_LINE_LIMIT) {
  const next = [...current];
  const counts = {added: 0, already: 0, overLimit: 0};
  const seen = new Set();
  for (const w of works) {
    if (!w || seen.has(w.id)) continue;
    seen.add(w.id);
    if (next.some((x) => x.id === w.id)) counts.already += 1;
    else if (next.length < limit) { next.push({id: w.id, code: w.code, title: w.title}); counts.added += 1; }
    else counts.overLimit += 1;
  }
  return {next, ...counts};
}

// 照合の結果の一文（画面の role="status"）。result は照合の応答 {rows, counts}、第2引数は完全一致の行を addToSelection で足した結果。
// 自動で入れた件数を出し、入れた作品が0件なら「入れました」と書かない
export function availsMatchText(result, {added = 0, already = 0, overLimit = 0} = {}) {
  const counts = result?.counts || {};
  const toConfirm = (result?.rows || []).filter(needsConfirm).length;
  return [
    `照合の結果: ${MATCH_STATES.matched} ${counts.matched ?? 0}件・${MATCH_STATES.ambiguous} ${counts.ambiguous ?? 0}件・${MATCH_STATES.not_found} ${counts.not_found ?? 0}件。`,
    added ? `完全一致の ${added}件をリストに入れました。` : '',
    already ? `完全一致の ${already}件はもうリストに入っています。` : '',
    overLimit ? `リストが${AVAILS_LINE_LIMIT}件に達したため、完全一致の ${overLimit}件は入れていません。` : '',
    toConfirm ? `前方一致・部分一致の ${toConfirm}件は作品名を確かめて「入れる」を押してください。` : '',
  ].join('');
}

// 作品の選んだ順（重複は最初だけ）。{workIds} か {error}
export function normalizeWorkIds(value) {
  const ids = String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!ids.length) return {error: '作品を1件以上選んでください'};
  if (ids.length > AVAILS_LINE_LIMIT) return {error: `作品は${AVAILS_LINE_LIMIT}件までです`};
  const out = [];
  for (const id of ids) {
    if (!/^\d+$/.test(id)) return {error: '作品の指定が正しくありません'};
    if (!out.includes(Number(id))) out.push(Number(id));
  }
  return {workIds: out};
}

const windowText = (w) => {
  if (!w || w.status === 'withdrawn' || !['day', 'month', 'year'].includes(w.date_precision)) return null;
  const v = String(w.start_on);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? dateSlash(v) : /^\d{4}-\d{2}$/.test(v) ? ymText(v) : `${v}年`;
};
const periodText = (w) => {
  const start = windowText(w);
  if (!start) return null;
  const end = w.end_on ? (/^\d{4}-\d{2}-\d{2}$/.test(w.end_on) ? dateSlash(w.end_on) : /^\d{4}-\d{2}$/.test(w.end_on) ? ymText(w.end_on) : `${w.end_on}年`) : '';
  return `${start}～${end}${w.status === 'draft' ? '（予定）' : ''}`;
};

// 1作品の行（17列）。ctx: {windows: [{type_key, family, ...版}], catalog: {production_year, synopsis_short, synopsis_long}, credits: [{role, name}],
//   runtimeSeconds, languages: [], sku, genre?, copyright?, recent: recentStations の結果, proposal: proposalSummary の文}
export function availsRow(work, ctx = {}) {
  const windows = ctx.windows || [];
  // 一次利用: 劇場公開・DVD発売・レンタル開始の最も早いもの
  const firstUse = windows.filter((w) => ['theatrical', 'package_sell', 'package_rental'].includes(w.type_key) && windowText(w))
    .map((w) => ({w, low: dateBounds(w.start_on)?.[0] || '9999'})).sort((a, b) => a.low.localeCompare(b.low))[0];
  const svod = windows.filter((w) => ['svod_early', 'svod_regular'].includes(w.type_key) && periodText(w))
    .sort((a, b) => String(a.start_on).localeCompare(String(b.start_on))).map((w) => `${w.type_key === 'svod_early' ? 'SVOD先行' : 'SVOD通常'}：${periodText(w)}`);
  const names = (role) => (ctx.credits || []).filter((c) => c.role === role).map((c) => c.name);
  const recent = ctx.recent || [];
  const minutes = ctx.runtimeSeconds ? `${Math.round(ctx.runtimeSeconds / 60)}分` : '';
  return {
    work_id: work.id,
    section: '',
    sku: ctx.sku || '',
    title: work.title,
    genre: ctx.genre || '',
    first_use: firstUse ? `${windowText(firstUse.w)} ${firstUse.w.type_label || ''}`.trim() + (firstUse.w.status === 'draft' ? '（予定）' : '') : '',
    production_year: ctx.catalog?.production_year ?? '',
    recent_stations: recent.length ? recent.map((r) => r.stationText).join('\n') : '放送実績なし',
    recent_history: recent.length ? recent.map((r) => r.historyText).join('\n') : '放送実績なし',
    availability: ctx.proposal || '要確認',
    svod: svod.join('\n') || '未登録',
    cast: names('cast').join('、'),
    director: names('director').join('、'),
    runtime: minutes,
    format: ctx.languages?.length ? `言語: ${ctx.languages.join('・')}（画質は要確認）` : '要確認',
    intro: ctx.catalog?.synopsis_short || '',
    story: ctx.catalog?.synopsis_long || '',
    copyright: ctx.copyright || '',
  };
}

// 17列（中立の見出し）。局に関わる4列（7〜10列）の見出しは橙黄で目立たせる
export const AVAILS_COLUMNS = Object.freeze([
  {key: 'section', label: '区分', type: 'text', width: 8},
  {key: 'sku', label: '品番', type: 'code', width: 14},
  {key: 'title', label: '作品名', type: 'text', width: 24},
  {key: 'genre', label: 'ジャンル', type: 'text', width: 12},
  {key: 'first_use', label: '一次利用（劇場公開・DVD発売）', type: 'text', width: 18},
  {key: 'production_year', label: '製作年', type: 'text', width: 8},
  {key: 'recent_stations', label: '直近の放送局（3局まで）', type: 'text', wrap: true, width: 22},
  {key: 'recent_history', label: '直近の放送履歴', type: 'text', wrap: true, width: 30},
  {key: 'availability', label: '放送アベイルズ状況', type: 'text', wrap: true, width: 34},
  {key: 'svod', label: 'メモ（SVOD の解禁状況）', type: 'text', wrap: true, width: 30},
  {key: 'cast', label: '出演', type: 'text', wrap: true, width: 20},
  {key: 'director', label: '監督', type: 'text', width: 14},
  {key: 'runtime', label: '時間', type: 'text', width: 8},
  {key: 'format', label: '画質・字幕・吹替', type: 'text', width: 16},
  {key: 'intro', label: 'イントロダクション', type: 'text', wrap: true, width: 34},
  {key: 'story', label: 'あらすじ', type: 'text', wrap: true, width: 40},
  {key: 'copyright', label: 'コピーライト', type: 'text', wrap: true, width: 18},
]);
export const AVAILS_ACCENT_KEYS = Object.freeze(['recent_stations', 'recent_history', 'availability', 'svod']);

export function availsSheet(rows, {asOf, dataAsOf}) {
  return {
    name: '放送アベイルズリスト', title: '放送アベイルズリスト', columns: AVAILS_COLUMNS, rows, dataAsOf, freezeCols: 3, paperSize: 'A3',
    conditions: [['基準日', asOf], ['作品', `${rows.length}件（選んだ順）`]],
    headerKinds: Object.fromEntries(AVAILS_ACCENT_KEYS.map((k) => [k, 'accent'])),
    notes: [
      `直近の放送局・放送履歴は、確定した放送枠と実放送の記録から（基準日 ${asOf} より後の月は（予定）、期間の一部が後なら（一部予定）。局名の（予定）はその局で過去に放送が無いとき）。仮押さえ・申請中の枠は数えない。`,
      '放送アベイルズ状況は、権利範囲・放送の解禁・販売条件と独占の契約・ホールドバックから計算した放送ウィンドウ提案の結果（24か月先まで）。局ごとの条件は個別に確かめる。',
      '区分・ジャンル・コピーライトは登録の置き場所が無いものは空欄。画質は登録が無いため要確認。',
    ],
  };
}

export function availsFileName(rows, today) {
  // 題名は文字（コードポイント）単位で40文字に切る（UTF-16 の単位で切るとサロゲートペアが割れ、ファイル名の符号化で失敗する）
  const first = Array.from(String(rows[0]?.title || '作品').toWellFormed().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')).slice(0, 40).join('');
  return `放送アベイルズリスト_${first}${rows.length > 1 ? `他${rows.length - 1}件` : ''}_${today.replaceAll('-', '')}.xlsx`;
}
