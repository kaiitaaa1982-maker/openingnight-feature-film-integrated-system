// 小道具の看板（画面「小道具」の3つ目の表示）の純関数。要件 docs/requirements/production/props-board.md。
// 行は GET /api/props の品目（props-model の propRow の形）。担当の名寄せ・担当ごとの件数・5状態の列・状態を変える版の本文を導く。
// 表は読まない。順位と％は出さない（件数だけ）。
import {PROP_STATES, PROP_DEPARTMENTS} from './props-model.mjs';

// ---- 担当の名寄せ（FR-PROD-BOARD-002） ----

export const NO_OWNER = '未定';
const OPEN = new Set(['（', '(']), CLOSE = new Set(['）', ')']);
const PERSON = /^[^\s・、,，（）()]+さん$/u;

// 括弧の外の「・」で分ける（括弧の中の「・」では分けない）
function splitTopLevel(text) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth = Math.max(0, depth - 1);
    if (ch === '・' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function ownerName(part) {
  const t = part.trim();
  if (!t) return null;
  const chars = [...t];
  const first = chars.findIndex((ch) => OPEN.has(ch));
  if (first < 0) return t;
  // 「演出部（鈴木さん）」: 括弧が1つだけで、中が人名「◯◯さん」だけなら、その人
  const one = /^([^（()）]*)[（(]([^（()）]*)[）)]$/u.exec(t);
  if (one && PERSON.test(one[2].trim())) return one[2].trim();
  // ほかの括弧は外して、括弧の前を担当にする
  return chars.slice(0, first).join('').trim() || null;
}

// 担当の文字から人（または部）の名前の並び。空は未定
export function ownersOf(label) {
  const names = [];
  for (const part of splitTopLevel(String(label ?? '').trim())) {
    const name = ownerName(part);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names : [NO_OWNER];
}

// 品目の担当。担当の文字（ownerLabel）があればそれを名寄せし、無ければ部署の名前（部署だけ決まった品目）、どちらも無ければ未定
export function rowOwners(row) {
  if (String(row.ownerLabel ?? '').trim()) return ownersOf(row.ownerLabel);
  if (row.department && Object.hasOwn(PROP_DEPARTMENTS, row.department)) return [PROP_DEPARTMENTS[row.department]];
  return [NO_OWNER];
}

// ---- 担当ごとの件数（FR-PROD-BOARD-003） ----

export const NO_DATE = 'none';
const byDate = (shootOn) => (row) => (!shootOn ? true : shootOn === NO_DATE ? !row.shootOn : row.shootOn === shootOn);
const compareOwner = (a, b) => (a === NO_OWNER) - (b === NO_OWNER) || a.localeCompare(b, 'ja');

export function ownerSummary(rows, {shootOn} = {}) {
  const map = new Map();
  for (const row of (rows || []).filter(byDate(shootOn))) {
    if (!Object.hasOwn(PROP_STATES, row.state)) continue;
    for (const owner of rowOwners(row)) {
      const n = map.get(owner) || {owner, total: 0, ready: 0, arranging: 0, adjust: 0, unassigned: 0, unneeded: 0};
      n.total += 1;
      n[row.state] += 1;
      map.set(owner, n);
    }
  }
  return [...map.values()].map((n) => ({...n, remaining: n.total - n.ready - n.unneeded})).sort((a, b) => compareOwner(a.owner, b.owner));
}

export function shootDates(rows) {
  const dates = [...new Set((rows || []).map((r) => r.shootOn).filter(Boolean))].sort();
  return {dates, hasNone: (rows || []).some((r) => !r.shootOn)};
}

export function ownerNames(rows) {
  return [...new Set((rows || []).flatMap(rowOwners))].sort(compareOwner);
}

// ---- 看板（FR-PROD-BOARD-004） ----

const sceneOrder = (label) => { const m = /(\d+)/.exec(label || ''); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };

// 5状態の列（並びは PROP_STATES の順）とカード。撮影日と担当で絞る
export function boardColumns(rows, {shootOn, owner} = {}) {
  const cards = (rows || []).filter(byDate(shootOn)).filter((r) => !owner || rowOwners(r).includes(owner))
    .sort((a, b) => (a.shootOn || '9999').localeCompare(b.shootOn || '9999') || sceneOrder(a.sceneLabel) - sceneOrder(b.sceneLabel) || a.id - b.id);
  return Object.entries(PROP_STATES).map(([id, label]) => ({id, label, cards: cards.filter((c) => c.state === id)}));
}

// 状態を変える版の本文（POST /api/props/items/:id/versions）。ほかの中身は読んだ版のまま写す
const BODY_FIELDS = ['sceneLabel', 'shootOn', 'place', 'name', 'quantity', 'kind', 'department', 'ownerLabel', 'nextAction', 'dueOn', 'source', 'scriptNote', 'memo'];
export function moveBody(row, state) {
  if (!Object.hasOwn(PROP_STATES, state)) throw Error('状態を確認してください');
  return {...Object.fromEntries(BODY_FIELDS.map((k) => [k, row[k] ?? null])), state, baseVersionNo: row.versionNo};
}

// 未割当へは、部署を持つ品目は動かせない（表の CHECK。部署を決めたら未割当にしない）
export const canMoveTo = (row, state) => !(state === 'unassigned' && row.department);
