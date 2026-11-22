// 制作の実費の画面（ページ ID `実費`。会社ルートの plans/2026-11-20-genba-inbox.md の手順 14b。要件 FR-EXP-PCOST-048〜052）の論理。
// DB と画面を読まない純関数: 受け口 GET /api/expenses/works/:workId/actual-lines の行と合計 → 表（EditSheet）の行と列、
// 変えたセル → 送る本文（足す・取消と置き換え）、下書きの行の判定、確認と取消の対象の選び方。
// 記録は追記だけ: 保存した行を直すと取消と置き換えの行（置き換えは未確認に戻る）、消すと取消。戻すでは送らない。
// 金額は整数の円で、和は money-actual.mjs の sumYen だけで出す。税抜は分からなければ「不明」のまま（税込から計算しない）
import {BUDGET_CATEGORIES} from '../../planning/budget/budget-model.mjs';
import {int as formatInt} from '../../ui/format.mjs';
import {MAX_CHECK_IDS, MAX_LINES_PER_POST} from './actual-lines-model.mjs';
import {sumYen} from './money-actual.mjs';

// 費目の候補（A〜K。表示は名前、打つのは名前でも記号でもよい）
export const CATEGORY_OPTIONS = Object.freeze(BUDGET_CATEGORIES.map((category) => Object.freeze({value: category.code, label: category.name, code: category.code})));
// 札（1〜4字）。未保存は、日付・支払先・費目・金額のそろわない下書きの行（ページを離れると消える）
export const MARKS = Object.freeze({unconfirmed: '未確認', confirmed: '確認済', draft: '未保存'});
export const METHOD_LABELS = Object.freeze({human: '人', ai: 'AI'});
// 表で直せる欄と、その列名（取消の理由に「表で直した: 金額」と書く）
export const EDIT_FIELDS = Object.freeze(['d', 'payee', 'category', 'memo', 'amount']);
export const FIELD_LABELS = Object.freeze({d: '日付', payee: '支払先', category: '費目', memo: '内容', amount: '金額'});
// そろったら送る欄（受け口の必須の欄: 日付・支払先の名前・費目・税込）
export const REQUIRED_FIELDS = Object.freeze(['d', 'payee', 'category', 'amount']);
export const LINE_KEY_PREFIX = 'line:';
const DRAFT_KEY_PREFIX = 'new:';

const blank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const text = (value) => (blank(value) ? '' : String(value).trim());

// 保存した行（受け口の lines の1行）→ 表の行
export function detailRow(line) {
  return {
    id: `${LINE_KEY_PREFIX}${line.id}`, lineId: line.id, d: line.spentOn, payee: line.payeeName, category: line.categoryCode, memo: line.description ?? '',
    amount: line.incTaxYen, exTax: line.exTaxYen ?? null, receipt: line.sourceDocumentId ? '有' : '', method: METHOD_LABELS[line.entryMethod] ?? '',
    mark: line.unconfirmed ? MARKS.unconfirmed : MARKS.confirmed,
  };
}

export const detailRows = (lines = []) => lines.map(detailRow);

// 下書きの行（いちばん下の空の行に打つと足される。key は呼ぶ側が一意に振る番号）
export function draftRow(n) {
  return {id: `${DRAFT_KEY_PREFIX}${n}`, draft: true, d: '', payee: '', category: '', memo: '', amount: null, exTax: null, receipt: '', method: '', mark: MARKS.draft};
}

export const isDraft = (row) => row?.draft === true;
const isBlankDraft = (row) => EDIT_FIELDS.every((field) => blank(row[field]));
// 日付・支払先・費目・金額がそろったか（値の正しさは受け口が確かめ、断られたら理由を出す）
export const draftReady = (row) => REQUIRED_FIELDS.every((field) => !blank(row[field]));

// 下書きの行 → 足す行の本文（人が入れた行）
export function lineFromDraft(row) {
  return {spentOn: row.d, payeeName: text(row.payee), categoryCode: row.category, description: text(row.memo) || null, incTaxYen: row.amount, entryMethod: 'human'};
}

// 保存した行を表で直したときの置き換えの行。直した欄だけを表の値にし、ほかは元の行のまま。
// 金額を直したら、元の税抜・税額は合わなくなるので持たない（不明に戻す）。支払先を直したら、取引先の結び付きは外す（別の相手かもしれない）。
// 人が表で直した行なので入れ方は人（AI の読みの記録は持たない）
export function replacementFor(line, row, fields = []) {
  const changed = new Set(fields);
  return {
    spentOn: row.d, payeeName: text(row.payee), categoryCode: row.category, description: text(row.memo) || null, incTaxYen: row.amount,
    payeePartnerId: changed.has('payee') ? null : line.payeePartnerId ?? null,
    exTaxYen: changed.has('amount') ? null : line.exTaxYen ?? null,
    taxYen: changed.has('amount') ? null : line.taxYen ?? null,
    sourceDocumentId: line.sourceDocumentId ?? null, shootingDayId: line.shootingDayId ?? null, entryMethod: 'human',
  };
}

export const voidReason = (fields = []) => `表で直した: ${EDIT_FIELDS.filter((field) => fields.includes(field)).map((field) => FIELD_LABELS[field]).join('・')}`;

export function chunks(list = [], size = MAX_LINES_PER_POST) {
  const out = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

// 部品が渡した変更（edits と、当てた後の表の行 rows）→ 送るもの。lines は受け口の保存した行。
// - 下書き: rows の下書きを全部持ち直し（空になった下書きは捨てる）。下書きを1つでもさわったら、欄のそろった下書きを全部足す（50行ずつ。
//   1回の POST は1行でも断られると何も書かないので、断られた下書きを直したときに、一緒に断られた下書きも送り直す）
// - 保存した行: 直した行ごとに取消と置き換えを1つ。必須の欄を空にした変更は送らず理由を返す（消すのは「行を消す」）
// - 戻す（action 'undo'）: 下書きだけに当てる。保存した行には何も送らない（記録は追記だけ）
export function planDetailChange({edits = [], action = 'edit', rows = [], lines = []} = {}) {
  const drafts = rows.filter(isDraft).filter((row) => !isBlankDraft(row));
  const draftKeys = new Set(rows.filter(isDraft).map((row) => row.id));
  const touchedDraft = edits.some((edit) => draftKeys.has(edit.key));
  const ready = touchedDraft ? drafts.filter(draftReady) : [];
  const posts = chunks(ready, MAX_LINES_PER_POST).map((group) => ({keys: group.map((row) => row.id), lines: group.map(lineFromDraft)}));
  const voids = [];
  const errors = [];
  if (action !== 'undo') {
    const fieldsByKey = new Map();
    for (const edit of edits) {
      if (edit.type !== 'cell' || !String(edit.key).startsWith(LINE_KEY_PREFIX) || !EDIT_FIELDS.includes(edit.field)) continue;
      if (!fieldsByKey.has(edit.key)) fieldsByKey.set(edit.key, new Set());
      fieldsByKey.get(edit.key).add(edit.field);
    }
    const lineById = new Map(lines.map((line) => [line.id, line]));
    const rowByKey = new Map(rows.map((row) => [row.id, row]));
    for (const [key, set] of fieldsByKey) {
      const row = rowByKey.get(key);
      const line = row ? lineById.get(row.lineId) : null;
      if (!row || !line) continue;
      const original = detailRow(line);
      const fields = [...set].filter((field) => text(original[field]) !== text(row[field]));
      if (!fields.length) continue;
      const empty = REQUIRED_FIELDS.filter((field) => blank(row[field]));
      if (empty.length) {
        errors.push({key, message: `${empty.map((field) => FIELD_LABELS[field]).join('・')}は空にできません（行ごと消すときは「行を消す」）`});
        continue;
      }
      voids.push({key, lineId: line.id, body: {reason: voidReason(fields), replacement: replacementFor(line, row, fields)}});
    }
  }
  return {drafts, posts, voids, errors};
}

// 表の行の鍵（line:番号）→ 保存した行の番号（下書き new:… は null）
export function lineIdOfKey(key) {
  const raw = String(key ?? '');
  if (!raw.startsWith(LINE_KEY_PREFIX)) return null;
  const id = raw.slice(LINE_KEY_PREFIX.length);
  return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
}

// 部品が渡す選択（onSelect の range・rowKeys・visibleKeys）→ 確認と取消の対象を選ぶための行の番号
export function selectionFromSheet({range = false, rowKeys = [], visibleKeys = []} = {}) {
  const ids = (keys) => keys.map(lineIdOfKey).filter((id) => id !== null);
  return {range: Boolean(range), selected: ids(rowKeys), visible: ids(visibleKeys)};
}

// 確認の対象: 範囲を選んでいれば選んだ行の未確認、選んでいなければ（セル1つ）見えている未確認の行すべて。件数と税込の合計を添える
// selection: {selected: [行の番号], visible: [行の番号], range: 2セル以上を選んでいるか}
export function checkTargets({lines = [], selection = {}} = {}) {
  const unconfirmed = new Map(lines.filter((line) => line.unconfirmed).map((line) => [line.id, line]));
  const source = selection.range ? selection.selected ?? [] : selection.visible ?? [];
  const lineIds = [...new Set(source)].filter((id) => unconfirmed.has(id));
  return {lineIds, count: lineIds.length, incTaxYen: sumYen(lineIds.map((id) => unconfirmed.get(id).incTaxYen)), batches: chunks(lineIds, MAX_CHECK_IDS)};
}

// 取消の対象: 選んだ行（セル1つならその行）のうち保存した行。件数と税込の合計を添える
export function voidTargets({lines = [], selection = {}} = {}) {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const lineIds = [...new Set(selection.selected ?? [])].filter((id) => byId.has(id));
  return {lineIds, count: lineIds.length, incTaxYen: sumYen(lineIds.map((id) => byId.get(id).incTaxYen))};
}

// 集計のシートの行（受け口の totals.byDay・byPayee・byCategory をそのまま使う。明細の和と一致することは受け口が保証する）。
// 構成比は税込の全体に対する割合（表示だけ。0〜1）
export function summaryRows(totals, kind) {
  const all = totals?.all?.incTaxYen ?? 0;
  const groups = totals?.[kind] ?? [];
  const label = {
    byDay: (group) => group.spentOn,
    byPayee: (group) => (group.payeePartnerId !== null && group.payeePartnerId !== undefined ? (group.payeeNames ?? []).join('・') : group.payeeName),
    byCategory: (group) => group.categoryName ?? group.categoryCode,
  }[kind];
  const keyOf = {
    byDay: (group) => group.spentOn,
    byPayee: (group) => (group.payeePartnerId !== null && group.payeePartnerId !== undefined ? `partner:${group.payeePartnerId}` : `name:${group.payeeName}`),
    byCategory: (group) => group.categoryCode,
  }[kind];
  if (!label) return [];
  return groups.map((group) => ({
    id: `${kind}:${keyOf(group)}`, key: label(group), count: group.all.count, amount: group.all.incTaxYen,
    share: all ? group.all.incTaxYen / all : 0, unconfirmed: group.unconfirmed.count,
  }));
}

// 上の1行: 未確認の数（赤の面）・累計（税込。確認済み・未確認の内訳）・今日の合計
export function headline(view) {
  return {
    unconfirmed: view?.unconfirmedCount ?? 0,
    cumulative: view?.cumulative?.all?.incTaxYen ?? 0,
    confirmed: view?.cumulative?.confirmed?.incTaxYen ?? 0,
    pending: view?.cumulative?.unconfirmed?.incTaxYen ?? 0,
    today: view?.todayTotal?.all?.incTaxYen ?? 0,
    count: view?.cumulative?.all?.count ?? 0,
  };
}

// 断られたときに表の上へ出す1行（受け口の理由と、行ごとの理由の最初の1つ）
export function failureText(error) {
  const message = String(error?.message || '保存できませんでした');
  const details = Array.isArray(error?.details) ? error.details : [];
  const first = details.find((item) => item && typeof item.message === 'string');
  return first && !message.includes(first.message) ? `${message}（${first.message}）` : message;
}

const markTone = (row) => (row.mark === MARKS.confirmed ? 'weak' : row.mark === MARKS.draft ? 'stop' : 'plain');

// 明細の列（EditSheet の列の形）。直せるのは日付・支払先・費目・内容・金額
export function detailColumns({year} = {}) {
  return [
    {key: 'd', label: '日付', type: 'date', year, width: 100},
    {key: 'payee', label: '支払先', width: 180},
    {key: 'category', label: '費目', type: 'choice', width: 150, options: CATEGORY_OPTIONS},
    {key: 'memo', label: '内容', width: 180},
    {key: 'amount', label: '金額', type: 'yen', width: 120},
    {key: 'exTax', label: '税抜', type: 'yen', width: 110, total: 'none', value: (row) => row.exTax,
      text: (row) => (row.draft ? '' : row.exTax === null || row.exTax === undefined ? '不明' : formatInt(row.exTax))},
    {key: 'receipt', label: '証憑', width: 96, readOnly: true},
    {key: 'method', label: '入れ方', width: 108, readOnly: true, badge: () => 'plain'},
    {key: 'mark', label: '札', width: 96, readOnly: true, badge: markTone},
  ];
}

// 集計の列（読むだけ）。first は日・支払先・費目の列
export function summaryColumns(kind, {year} = {}) {
  const first = kind === 'byDay' ? {key: 'key', label: '日', type: 'date', year, width: 120}
    : {key: 'key', label: kind === 'byPayee' ? '支払先' : '費目', width: 190};
  return [
    first,
    {key: 'count', label: '件数', type: 'int', width: 90, total: 'sum'},
    {key: 'amount', label: '金額', type: 'yen', width: 130},
    {key: 'share', label: '構成比', type: 'rate', width: 100},
    {key: 'unconfirmed', label: '未確認', type: 'int', width: 100, total: 'sum'},
  ];
}
