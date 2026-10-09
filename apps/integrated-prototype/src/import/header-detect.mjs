// 売上報告の見出し行の推定と、合計行の除外候補。純関数（ブラウザ・node・Worker で同じ結果）。
// 取引先の報告は、表題・注意書き・対象期間の行が見出しの上にあることが多い。
// 「文字だけの行が横に並び、次の行から数値の行が続く」行を見出しとみなし、根拠を日本語で返す。
import {normalizeHeader, knownHeaderTargets} from './column-synonyms.mjs';

export const PREVIEW_ROWS = 30;

const cellText = (value) => (value === null || value === undefined ? '' : String(value)).trim();
const isNumberText = (text) => /^[-−－]?[¥￥]?[0-9０-９,，]+(\.[0-9０-９]+)?%?$/.test(text);
const isDateText = (text) => /^\d{4}[-/.年]\d{1,2}([-/.月]\d{1,2}日?)?月?$/.test(text);
const TOTAL_PATTERN = /^(総?合計|小計|総計|計|合算|total|subtotal|grand\s*total|sum)$/i;
const TOTAL_CONTAINS = /(総合計|合計|小計|総計)/;

// 列番号（0始まり）→ Excel の列記号（A, B, …, Z, AA, …）
export function columnLetter(index) {
  let n = Number(index) + 1;
  if (!Number.isInteger(n) || n < 1) return '';
  let text = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    text = String.fromCharCode(65 + r) + text;
    n = Math.floor((n - 1) / 26);
  }
  return text;
}

function nonEmpty(row) {
  return (Array.isArray(row) ? row : []).map(cellText).filter((text) => text !== '');
}

function looksLikeDataRow(row, headerWidth) {
  const cells = nonEmpty(row);
  if (!cells.length) return false;
  const numeric = cells.filter((text) => isNumberText(text) || isDateText(text)).length;
  return numeric > 0 && cells.length >= Math.max(2, Math.ceil(headerWidth * 0.5));
}

// 1行を見出し候補として採点する。score が高いほど見出しらしい。
function scoreRow(rows, index, maxWidth) {
  const cells = nonEmpty(rows[index]);
  const reasons = [];
  if (cells.length < 2) return {score: 0, reasons: ['値のある列が1つ以下']};
  const textCells = cells.filter((text) => !isNumberText(text) && !isDateText(text));
  const textRatio = textCells.length / cells.length;
  if (textRatio < 0.5) return {score: 0, reasons: ['数値や日付が多い（明細の行らしい）']};
  const unique = new Set(cells.map(normalizeHeader)).size === cells.length;
  const widthRatio = maxWidth ? cells.length / maxWidth : 0;
  const known = cells.filter((text) => knownHeaderTargets(text).length > 0).length;
  const totalLike = cells.some((text) => TOTAL_PATTERN.test(text));
  let below = 0;
  let checked = 0;
  for (let next = index + 1; next < rows.length && checked < 5; next += 1) {
    if (!nonEmpty(rows[next]).length) continue;
    checked += 1;
    if (looksLikeDataRow(rows[next], cells.length)) below += 1;
  }
  const belowRatio = checked ? below / checked : 0;
  let score = 0;
  score += 3 * widthRatio;
  score += 3 * textRatio;
  score += unique ? 1 : -1;
  score += Math.min(known, 5) * 0.8;
  score += 3 * belowRatio;
  if (totalLike) score -= 2;
  if (textRatio < 1) score -= 2 * (1 - textRatio);
  if (widthRatio >= 0.8) reasons.push(`値のある列が${cells.length}列並んでいる`);
  if (textRatio === 1) reasons.push('すべて文字（数値や日付を含まない）');
  if (known) reasons.push(`よく使う見出しの語（数量・金額・税額など）が${known}列ある`);
  if (belowRatio >= 0.6) reasons.push('次の行から数値を含む明細が続く');
  if (!unique) reasons.push('同じ名前の列がある');
  if (totalLike) reasons.push('「合計」などの語を含む');
  return {score, reasons};
}

// 見出し行の推定。返す row は1始まりの行番号（Excel の行番号と同じ）。見つからなければ null。
export function detectHeaderRow(rows, {maxScan = PREVIEW_ROWS} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Math.min(list.length, maxScan);
  const maxWidth = Math.max(0, ...list.slice(0, Math.min(list.length, maxScan + 10)).map((row) => nonEmpty(row).length));
  const candidates = [];
  for (let index = 0; index < limit; index += 1) {
    const {score, reasons} = scoreRow(list, index, maxWidth);
    if (score > 0) candidates.push({row: index + 1, score: Math.round(score * 100) / 100, reasons});
  }
  candidates.sort((a, b) => b.score - a.score || a.row - b.row);
  const best = candidates[0];
  if (!best || best.score < 4) return {row: null, confidence: 'none', reasons: ['見出しらしい行が見つかりません。見出しの行を押して選んでください'], candidates};
  const second = candidates[1];
  const margin = second ? best.score - second.score : best.score;
  const confidence = best.score >= 8 && margin >= 1.5 ? 'high' : best.score >= 6 ? 'medium' : 'low';
  return {row: best.row, confidence, reasons: best.reasons, candidates: candidates.slice(0, 5)};
}

export const CONFIDENCE_LABELS = Object.freeze({high: '確度 高', medium: '確度 中', low: '確度 低（確かめてください）', none: '推定できません'});

// 見出しの行が取込に使えるか（空欄・重複）。問題を [{column, message}] で返す。
export function headerProblems(row) {
  const cells = (Array.isArray(row) ? row : []).map(cellText);
  let last = cells.length - 1;
  while (last >= 0 && cells[last] === '') last -= 1;
  const problems = [];
  const seen = new Map();
  if (last < 0) return [{column: null, message: 'この行には見出しがありません'}];
  for (let index = 0; index <= last; index += 1) {
    const text = cells[index];
    if (!text) { problems.push({column: columnLetter(index), message: `${columnLetter(index)}列の見出しが空です`}); continue; }
    if (seen.has(text)) problems.push({column: columnLetter(index), message: `${columnLetter(seen.get(text))}列と${columnLetter(index)}列の見出しが同じ「${text}」です`});
    else seen.set(text, index);
  }
  return problems;
}

// 見出しより下で「合計」「小計」などを含む行（取り込まない行の候補）。row は1始まり。
export function detectTotalRows(rows, headerRow) {
  const list = Array.isArray(rows) ? rows : [];
  const start = Number(headerRow) || 0;
  const out = [];
  for (let index = start; index < list.length; index += 1) {
    const cells = nonEmpty(list[index]);
    if (!cells.length) continue;
    const label = cells.find((text) => TOTAL_PATTERN.test(text) || (TOTAL_CONTAINS.test(text) && text.length <= 12));
    if (label) out.push({row: index + 1, reason: `「${label}」を含む行（合計行の可能性）`});
  }
  return out;
}

// 画面の見出し確認用。先頭 count 行を行番号・列記号つきで返す（列幅は全行で最も広い行に合わせる）。
export function sheetPreview(rows, {count = PREVIEW_ROWS} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const shown = list.slice(0, count);
  const width = Math.max(0, ...shown.map((row) => (Array.isArray(row) ? row.length : 0)));
  let lastUsed = -1;
  for (const row of shown) (Array.isArray(row) ? row : []).forEach((value, index) => { if (cellText(value) !== '' && index > lastUsed) lastUsed = index; });
  const columns = Array.from({length: Math.min(width, lastUsed + 1)}, (_, index) => columnLetter(index));
  return {
    total: list.length,
    shown: shown.length,
    columns,
    rows: shown.map((row, index) => ({row: index + 1, cells: columns.map((_, col) => cellText(Array.isArray(row) ? row[col] : ''))})),
  };
}
