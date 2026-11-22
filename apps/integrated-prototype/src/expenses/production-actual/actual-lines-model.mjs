// 制作の実費の行（会社ルートの plans/2026-11-20-genba-inbox.md の手順8。決まりは brain の D-047 の3・7）の入力の読み取り・いまの行・
// 未確認の印・合計・まとめて確認の振り分け・読める人と書ける人を決める純関数。表は移行 0068（production_actual_lines・_voids・_checks）。
// 要件は docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-009・010・015・021・033・036・043〜046。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。「今日」は引数で受け取る。金額は整数の円で、和は money-actual.mjs の sumYen だけで出す。
// 税抜・税額は分かるときだけ受け、分からない行は「不明」のまま持つ（税込から計算しない。端数・税率を推測しない）
import {BUDGET_CATEGORIES, CATEGORY_CODES} from '../../planning/budget/budget-model.mjs';
import {isCalendarDate} from '../production-cost/production-cost-model.mjs';
import {sumYen, taxSplitMatches} from './money-actual.mjs';

// 1回で足せる行の数と、1回で確かめられる行の数（D1 の1回の batch の文の数 500 に収まる大きさ）
export const MAX_LINES_PER_POST = 50;
export const MAX_CHECK_IDS = 200;
// 額の上限（1兆円。移行 0068 の CHECK と同じ）
export const MAX_ACTUAL_YEN = 1_000_000_000_000;
// 入れ方（人・AI。移行 0068 の entry_method）
export const ENTRY_METHODS = Object.freeze(['human', 'ai']);
// 行の欄（AI の読みの記録が「読んだ欄」「読めなかった欄」に書ける名前。並びはこの順にそろえて保存する）
export const LINE_FIELDS = Object.freeze(['spentOn', 'categoryCode', 'payeePartnerId', 'payeeName', 'description', 'incTaxYen', 'exTaxYen', 'taxYen',
  'sourceDocumentId', 'shootingDayId']);
// 読みの記録の大きさ（移行 0068 の CHECK は 2000 文字まで）
const AI_READ_MAX = 2000;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const ENTRY_KEY = /^[A-Za-z0-9._:-]{1,100}$/;
const CATEGORY_NAME = new Map(BUDGET_CATEGORIES.map((category) => [category.code, category.name]));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const blank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

function text(errors, field, value, {max, label, required = false}) {
  if (blank(value)) {
    if (required) errors.push({field, message: `${label}を入れてください`});
    return null;
  }
  if (typeof value !== 'string') { errors.push({field, message: `${label}は文字で入れてください`}); return null; }
  const trimmed = value.trim();
  if (trimmed.length > max) errors.push({field, message: `${label}は${max}文字までです`});
  return trimmed;
}

function optionalId(errors, field, value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) { errors.push({field, message: `${label}は番号で選んでください`}); return null; }
  return value;
}

// 円の額。いまは正の額だけを受ける（返金などの負の額を受けるかは代表の判断待ち。DB は符号のそろった負の額を通す）
function yen(errors, field, value, {label, required = false, min = 1}) {
  if (value === null || value === undefined) {
    if (required) errors.push({field, message: `${label}を入れてください`});
    return null;
  }
  if (!Number.isSafeInteger(value) || value < min || value > MAX_ACTUAL_YEN) {
    errors.push({field, message: `${label}は${min}円〜1兆円の整数の円で入れてください`});
    return null;
  }
  return value;
}

// AI の読みの記録（FR-EXP-PCOST-045）。キーは model・readFields・unreadFields の3つだけ（原本の中身や本文を入れる場所を作らない）。
// 読んだ欄には値があり、読めなかった欄は空であること（読めなかった欄を推測で埋めていないこと）を、行の値と照らす
function aiReadOf(errors, raw, line) {
  if (!isObject(raw)) { errors.push({field: 'aiRead', message: 'AI が入れた行は、読みの記録（model・readFields・unreadFields）を付けてください'}); return null; }
  const extra = Object.keys(raw).filter((key) => !['model', 'readFields', 'unreadFields'].includes(key));
  if (extra.length) errors.push({field: 'aiRead', message: `読みの記録に持たない項目です: ${extra.join('・')}`});
  const model = typeof raw.model === 'string' && MODEL_NAME.test(raw.model) ? raw.model : null;
  if (!model) errors.push({field: 'aiRead.model', message: '読んだモデルの名前を、英数字と . _ : / - の100文字までで入れてください'});
  const fields = (key) => {
    const list = raw[key] ?? [];
    if (!Array.isArray(list) || list.some((name) => !LINE_FIELDS.includes(name)) || new Set(list).size !== list.length) {
      errors.push({field: `aiRead.${key}`, message: `欄の名前は ${LINE_FIELDS.join('・')} から重ならずに選んでください`});
      return [];
    }
    return LINE_FIELDS.filter((name) => list.includes(name));
  };
  const readFields = fields('readFields');
  const unreadFields = fields('unreadFields');
  const both = readFields.filter((name) => unreadFields.includes(name));
  if (both.length) errors.push({field: 'aiRead', message: `読んだ欄と読めなかった欄に同じ欄があります: ${both.join('・')}`});
  const filledButUnread = unreadFields.filter((name) => line[name] !== null);
  if (filledButUnread.length) errors.push({field: 'aiRead.unreadFields', message: `読めなかった欄に値があります（推測で埋めない）: ${filledButUnread.join('・')}`});
  const readButEmpty = readFields.filter((name) => line[name] === null);
  if (readButEmpty.length) errors.push({field: 'aiRead.readFields', message: `読んだ欄に値がありません: ${readButEmpty.join('・')}`});
  const value = {model, readFields, unreadFields};
  if (JSON.stringify(value).length > AI_READ_MAX) errors.push({field: 'aiRead', message: `読みの記録は${AI_READ_MAX}文字までです`});
  return value;
}

// 実費の行1つの入力（FR-EXP-PCOST-033・015・045。取り込みの鍵は要件の要確認14）。返り値の value は store が書く形（aiReadJson は保存する JSON の文字）
export function normalizeActualLineInput(raw) {
  const errors = [];
  const src = isObject(raw) ? raw : {};
  if (!isObject(raw)) errors.push({field: 'line', message: '行はオブジェクトで送ってください'});
  const spentOn = src.spentOn ?? null;
  if (!isCalendarDate(spentOn)) errors.push({field: 'spentOn', message: '日付を YYYY-MM-DD で入れてください'});
  const categoryCode = CATEGORY_CODES.includes(src.categoryCode) ? src.categoryCode : null;
  if (!categoryCode) errors.push({field: 'categoryCode', message: `費目を ${CATEGORY_CODES.join('・')} から選んでください`});
  const line = {
    spentOn: isCalendarDate(spentOn) ? spentOn : null,
    categoryCode,
    payeePartnerId: optionalId(errors, 'payeePartnerId', src.payeePartnerId, '支払先の取引先'),
    payeeName: text(errors, 'payeeName', src.payeeName, {max: 200, label: '支払先の名前（領収書に書いてある名前）', required: true}),
    description: text(errors, 'description', src.description, {max: 500, label: '内容'}),
    incTaxYen: yen(errors, 'incTaxYen', src.incTaxYen, {label: '税込', required: true}),
    exTaxYen: yen(errors, 'exTaxYen', src.exTaxYen, {label: '税抜'}),
    taxYen: yen(errors, 'taxYen', src.taxYen, {label: '税額', min: 0}),
    sourceDocumentId: optionalId(errors, 'sourceDocumentId', src.sourceDocumentId, '証憑の原本'),
    shootingDayId: optionalId(errors, 'shootingDayId', src.shootingDayId, '撮影日'),
  };
  // 税抜・税額は2つそろえて持つか、2つとも持たない（不明）。そろえたら税込＝税抜＋税額
  const exGiven = src.exTaxYen !== null && src.exTaxYen !== undefined;
  const taxGiven = src.taxYen !== null && src.taxYen !== undefined;
  if (exGiven !== taxGiven) errors.push({field: exGiven ? 'taxYen' : 'exTaxYen', message: '税抜と税額は2つそろえて入れてください（分からなければ2つとも空にします）'});
  else if (line.exTaxYen !== null && line.taxYen !== null && line.incTaxYen !== null && !taxSplitMatches(line.incTaxYen, line.exTaxYen, line.taxYen)) {
    errors.push({field: 'incTaxYen', message: `税込（${line.incTaxYen}円）を税抜と税額の和（${sumYen([line.exTaxYen, line.taxYen])}円）にそろえてください`});
  }
  const entryMethod = ENTRY_METHODS.includes(src.entryMethod) ? src.entryMethod : null;
  if (!entryMethod) errors.push({field: 'entryMethod', message: '入れ方を human（人）か ai（AI）で入れてください'});
  let aiRead = null;
  if (entryMethod === 'ai') aiRead = aiReadOf(errors, src.aiRead, line);
  if (entryMethod === 'human' && src.aiRead !== undefined && src.aiRead !== null) errors.push({field: 'aiRead', message: '人が入れた行に読みの記録は付けません'});
  let entryKey = null;
  if (src.entryKey !== undefined && src.entryKey !== null) {
    if (typeof src.entryKey === 'string' && ENTRY_KEY.test(src.entryKey)) entryKey = src.entryKey;
    else errors.push({field: 'entryKey', message: '取り込みの鍵は英数字と . _ : - の100文字までで入れてください'});
  }
  const value = {...line, entryMethod, aiRead, aiReadJson: aiRead ? JSON.stringify(aiRead) : null, entryKey};
  return {ok: errors.length === 0, value, errors};
}

// 1回の POST の行（1〜50行）。どれか1行でも誤りがあれば何も書かない。誤りには行の位置（0から）を付ける
export function normalizeActualLinesBatch(raw) {
  const list = isObject(raw) ? raw.lines : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_LINES_PER_POST) {
    return {ok: false, values: [], errors: [{line: null, field: 'lines', message: `行は1〜${MAX_LINES_PER_POST}行の配列で送ってください`}]};
  }
  const values = [];
  const errors = [];
  for (const [index, item] of list.entries()) {
    const n = normalizeActualLineInput(item);
    values.push(n.value);
    for (const error of n.errors) errors.push({line: index, ...error});
  }
  const seen = new Map();
  for (const [index, value] of values.entries()) {
    if (value.entryKey === null) continue;
    if (seen.has(value.entryKey)) errors.push({line: index, field: 'entryKey', message: `取り込みの鍵が ${seen.get(value.entryKey)} 行目と重なっています`});
    else seen.set(value.entryKey, index);
  }
  return {ok: errors.length === 0, values, errors};
}

// 取消の入力（FR-EXP-PCOST-010）。理由は必須。置き換えの行（replacement）を付けると、取消と同じ書き込みで足す（表の上で直す）
export function normalizeVoidInput(raw) {
  const errors = [];
  const src = isObject(raw) ? raw : {};
  const reason = text(errors, 'reason', src.reason, {max: 1000, label: '取消の理由', required: true});
  let replacement = null;
  if (src.replacement !== undefined && src.replacement !== null) {
    const n = normalizeActualLineInput(src.replacement);
    replacement = n.value;
    for (const error of n.errors) errors.push({...error, field: `replacement.${error.field}`});
  }
  return {ok: errors.length === 0, value: {reason, replacement}, errors};
}

// まとめて確認の入力（FR-EXP-PCOST-044）。行の ID の一覧（1〜200件。重なりは1つにする）
export function normalizeCheckInput(raw) {
  const list = isObject(raw) ? raw.lineIds : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CHECK_IDS || list.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return {ok: false, value: null, errors: [{field: 'lineIds', message: `確かめる行の番号を1〜${MAX_CHECK_IDS}件の配列で送ってください`}]};
  }
  return {ok: true, value: {lineIds: [...new Set(list)]}, errors: []};
}

const num = (value) => (value === null || value === undefined ? null : Number(value));

// 行（production_actual_lines の行）を受け口が返す形にする
export function actualLineView(row) {
  const exTaxYen = num(row.ex_tax_yen);
  return {
    id: Number(row.id), entryKey: row.entry_key, spentOn: row.spent_on, categoryCode: row.category_code, categoryName: CATEGORY_NAME.get(row.category_code) ?? null,
    payeePartnerId: num(row.payee_partner_id), payeeName: row.payee_name, description: row.description ?? null,
    incTaxYen: Number(row.inc_tax_yen), exTaxYen, taxYen: num(row.tax_yen), taxUnknown: exTaxYen === null,
    sourceDocumentId: num(row.source_document_id), shootingDayId: num(row.shooting_day_id),
    entryMethod: row.entry_method, aiRead: row.ai_read_json ? JSON.parse(row.ai_read_json) : null,
    createdBy: Number(row.created_by), createdAt: row.created_at,
  };
}

// いまの行（FR-EXP-PCOST-010・043）: 取消の無い行。確認の行があれば check（誰がいつ）、無ければ未確認（unconfirmed）。
// 取消の置き換えで足された行は replaces に元の行の番号を持つ。並びは日付・番号の順
export function currentActualLines({lines = [], voids = [], checks = []} = {}) {
  const voided = new Set(voids.map((v) => Number(v.line_id)));
  const replaces = new Map(voids.filter((v) => v.replacement_line_id !== null && v.replacement_line_id !== undefined)
    .map((v) => [Number(v.replacement_line_id), Number(v.line_id)]));
  const checkOf = new Map(checks.map((c) => [Number(c.line_id), {checkedBy: Number(c.checked_by), checkedAt: c.checked_at}]));
  return lines.filter((row) => !voided.has(Number(row.id))).map((row) => {
    const view = actualLineView(row);
    const check = checkOf.get(view.id) ?? null;
    return {...view, replaces: replaces.get(view.id) ?? null, check, unconfirmed: check === null};
  }).sort((a, b) => (a.spentOn < b.spentOn ? -1 : a.spentOn > b.spentOn ? 1 : a.id - b.id));
}

// 日付（from・to。両端を含む）と撮影日で絞る。値が無ければ絞らない
export function filterActualLines(lines, {from = null, to = null, shootingDayId = null} = {}) {
  return lines.filter((line) => (from === null || line.spentOn >= from) && (to === null || line.spentOn <= to)
    && (shootingDayId === null || line.shootingDayId === shootingDayId));
}

// 絞り込みの入力（クエリの文字）。誤りがあれば errors
export function normalizeActualLinesQuery({from, to, shootingDayId} = {}) {
  const errors = [];
  const date = (field, value) => {
    if (value === undefined || value === null || value === '') return null;
    if (!isCalendarDate(value)) { errors.push({field, message: '日付を YYYY-MM-DD で入れてください'}); return null; }
    return value;
  };
  const value = {from: date('from', from), to: date('to', to), shootingDayId: null};
  if (shootingDayId !== undefined && shootingDayId !== null && shootingDayId !== '') {
    const id = /^\d+$/.test(shootingDayId) ? Number(shootingDayId) : NaN;
    if (Number.isSafeInteger(id) && id > 0) value.shootingDayId = id;
    else errors.push({field: 'shootingDayId', message: '撮影日は番号で選んでください'});
  }
  if (value.from && value.to && value.from > value.to) errors.push({field: 'to', message: '終わりの日付を始まりの日付より後にしてください'});
  return {ok: errors.length === 0, value, errors};
}

// 行の集まりの合計（FR-EXP-PCOST-046）。税込はすべての行の和。税抜・税額は分かる行だけの和で、税抜が不明の行は件数と税込の和を分けて返す
function bucketOf(lines) {
  const known = lines.filter((line) => line.exTaxYen !== null);
  const unknown = lines.filter((line) => line.exTaxYen === null);
  return {
    count: lines.length, incTaxYen: sumYen(lines.map((line) => line.incTaxYen)),
    exTaxYen: sumYen(known.map((line) => line.exTaxYen)), taxYen: sumYen(known.map((line) => line.taxYen)),
    exTaxUnknownCount: unknown.length, exTaxUnknownIncTaxYen: sumYen(unknown.map((line) => line.incTaxYen)),
  };
}

// 合計を、すべて・確認済み・未確認に分ける（FR-EXP-PCOST-043。精算・会計へは確認済みだけを出せるように）
export function summarizeActualLines(lines) {
  return {all: bucketOf(lines), confirmed: bucketOf(lines.filter((line) => !line.unconfirmed)), unconfirmed: bucketOf(lines.filter((line) => line.unconfirmed))};
}

function groupBy(lines, keyOf) {
  const groups = new Map();
  for (const line of lines) {
    const key = keyOf(line);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  return groups;
}

// 日別・支払先別・費目別の合計（FR-EXP-PCOST-046）。どれも行を1回ずつ分けるので、各組の和は全体の合計と必ず一致する。
// 支払先は取引先の ID があればその ID で、無ければ領収書の名前で1組にする
export function actualTotals(lines) {
  const byDay = [...groupBy(lines, (line) => line.spentOn)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([spentOn, group]) => ({spentOn, ...summarizeActualLines(group)}));
  const byPayee = [...groupBy(lines, (line) => (line.payeePartnerId !== null ? `partner:${line.payeePartnerId}` : `name:${line.payeeName}`))]
    .map(([, group]) => ({
      payeePartnerId: group[0].payeePartnerId, payeeName: group[0].payeePartnerId !== null ? null : group[0].payeeName,
      payeeNames: [...new Set(group.map((line) => line.payeeName))].sort(), ...summarizeActualLines(group),
    }))
    .sort((a, b) => b.all.incTaxYen - a.all.incTaxYen || String(a.payeePartnerId ?? a.payeeName).localeCompare(String(b.payeePartnerId ?? b.payeeName)));
  const byCategory = CATEGORY_CODES.filter((code) => lines.some((line) => line.categoryCode === code))
    .map((code) => ({categoryCode: code, categoryName: CATEGORY_NAME.get(code), ...summarizeActualLines(lines.filter((line) => line.categoryCode === code))}));
  return {...summarizeActualLines(lines), byDay, byPayee, byCategory};
}

// 受け口が返す1枚（FR-EXP-PCOST-043・046）: 絞り込んだいまの行・未確認の数・その合計と組ごとの合計、今日の合計と作品の累計（絞り込みに依らない）
export function buildActualLinesView({lines = [], voids = [], checks = [], today, filter = {}} = {}) {
  if (!isCalendarDate(today)) throw new Error('今日の日付が要ります');
  const current = currentActualLines({lines, voids, checks});
  const shown = filterActualLines(current, filter);
  return {
    today, filter, lines: shown, unconfirmedCount: shown.filter((line) => line.unconfirmed).length, totals: actualTotals(shown),
    todayTotal: summarizeActualLines(current.filter((line) => line.spentOn === today)), cumulative: summarizeActualLines(current),
  };
}

// まとめて確認の振り分け（FR-EXP-PCOST-044）: 作品の行のうち、確かめる行・取消済みで飛ばす行・確認済みで飛ばす行と、作品に無い番号
export function planActualLineChecks({lineIds = [], lines = [], voids = [], checks = []} = {}) {
  const exists = new Set(lines.map((row) => Number(row.id)));
  const voided = new Set(voids.map((v) => Number(v.line_id)));
  const checked = new Set(checks.map((c) => Number(c.line_id)));
  const plan = {toCheck: [], voided: [], alreadyChecked: [], missing: []};
  for (const id of lineIds) {
    if (!exists.has(id)) plan.missing.push(id);
    else if (voided.has(id)) plan.voided.push(id);
    else if (checked.has(id)) plan.alreadyChecked.push(id);
    else plan.toCheck.push(id);
  }
  return plan;
}

// 読める人と書ける人（FR-EXP-PCOST-009・027）。読めるのは管理者と、作品の案件の編集の権限を持つ編集担当（作品の財務の権限）。
// 書けるのは、いまは管理者だけ（要件の「制作担当で、その作品に役目の行を持つ人」は、作品ごとの役目の表が入ってから広げる。狭い側に倒す）。
// 制作担当には読ませない（いまの経費と同じ）。
// via は呼び出しの経路の印（identity.via。FR-CORE-DATA-066）。サービストークン（AI）の呼び出しは、権限（読む・書く）はそのままに、
// 人の行（entryMethod が human）を足せず、確かめられない（FR-EXP-PCOST-047。D-047 の7 を本文の名乗りでなく経路で守る）
export const SERVICE_TOKEN_VIA = 'service_token';
export function actualLinesAccess({role, financeProject = false, via = null} = {}) {
  const person = via !== SERVICE_TOKEN_VIA;
  if (role === 'admin') return {read: true, write: true, humanLines: person, check: person};
  return {read: role === 'editor' && financeProject === true, write: false, humanLines: false, check: false};
}

// サービストークン（AI）の呼び出しで足せない行（入れ方が human の行）の誤り。at は誤りに付ける位置
export function humanLineErrors(lines, {humanLines}, at = (index) => ({line: index})) {
  if (humanLines) return [];
  return lines.flatMap((line, index) => (line.entryMethod === 'human'
    ? [{...at(index), field: 'entryMethod', message: 'AI の呼び出し（サービストークン）からは、入れ方が ai の行だけを足せます'}] : []));
}
