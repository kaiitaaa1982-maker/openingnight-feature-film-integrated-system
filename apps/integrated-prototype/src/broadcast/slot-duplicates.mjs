// 放送枠の二重登録の判定（純関数。ブラウザ・node・Worker 共通）。
// 同じ作品・同じ放送月に、同じ放送局の生きている枠は1つだけ。局名は NFKC にして空白を除き小文字にしたもの（matchKey）で比べるので、
// 「ＢＳ架空」と「BS架空」、前後や途中の空白の違いは同じ局として扱う。中止（cancelled）の枠は数えない（下書き・差戻しも生きている枠）。
import {matchKey} from './broadcast-sheet.mjs';

export const isLiveSlot = (slot) => Boolean(slot) && slot.status !== 'cancelled';
export const stationKey = (name) => matchKey(name);
export const slotKey = (workId, month, station) => `${Number(workId)}|${String(month || '')}|${stationKey(station)}`;

// 同じ作品・同じ月・同じ局の生きている枠（exceptSlotId は自分自身）。無ければ null
export function findDuplicateSlot(slots, {workId, month, station, exceptSlotId = null}) {
  const key = slotKey(workId, month, station);
  return (Array.isArray(slots) ? slots : []).find((slot) => isLiveSlot(slot) && slot.slot_id !== exceptSlotId
    && slotKey(slot.work_id, slot.broadcast_month, slot.station_name) === key) || null;
}

// 既に重なっている枠（修正前に入った二重登録）。slotId → 同じ作品・月・局の別の枠IDの一覧
export function duplicateSlotMap(slots) {
  const groups = new Map();
  for (const slot of (Array.isArray(slots) ? slots : []).filter(isLiveSlot)) {
    const key = slotKey(slot.work_id, slot.broadcast_month, slot.station_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot.slot_id);
  }
  const out = new Map();
  for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) out.set(id, ids.filter((other) => other !== id));
  return out;
}

export function duplicateMessage(existing, {stationName} = {}) {
  const status = {draft: '下書き', pending_first: '一次承認の申請中', tentative: '仮押さえ', pending_final: '最終承認の申請中', confirmed: '確定', rejected: '差戻し'}[existing?.status] || '登録済み';
  return `同じ作品・同じ放送月（${existing?.broadcast_month}）に、同じ放送局「${stationName || existing?.station_name}」の放送枠がすでにあります（放送枠ID ${existing?.slot_id}・${status}）。`
    + '同じ枠なら、その枠を直してください（全角・半角や空白の違いは同じ局として扱います）';
}

// Excel 取込の全行を当てたあとの状態で、同じ作品・月・局の生きている枠が2つ以上になる行を探す。
// current: この作品の今の枠（最新版）。rows: [{rowNo, action: append|revise|unchanged, slotId, value: {broadcast_month, station_name}}]
// → Map(rowNo → 理由)。ファイルに無い枠は今のまま、ファイルの行は取込後の値で数える
export function importDuplicateErrors(current, rows, workId) {
  const finalSlots = new Map();
  for (const slot of Array.isArray(current) ? current : []) finalSlots.set(`s:${slot.slot_id}`, {...slot, rowNo: null});
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.value?.broadcast_month || !row.value.station_name) continue;
    if (row.action === 'append') finalSlots.set(`r:${row.rowNo}`, {slot_id: null, work_id: workId, broadcast_month: row.value.broadcast_month, station_name: row.value.station_name, status: 'draft', rowNo: row.rowNo});
    else if (row.slotId && finalSlots.has(`s:${row.slotId}`)) {
      const before = finalSlots.get(`s:${row.slotId}`);
      finalSlots.set(`s:${row.slotId}`, {...before, broadcast_month: row.value.broadcast_month, station_name: row.value.station_name, status: row.action === 'revise' ? 'draft' : before.status, rowNo: row.rowNo});
    }
  }
  const groups = new Map();
  for (const slot of finalSlots.values()) {
    if (!isLiveSlot(slot)) continue;
    const key = slotKey(workId, slot.broadcast_month, slot.station_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }
  const errors = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const slot of list) {
      if (slot.rowNo === null) continue;
      const others = list.filter((other) => other !== slot);
      const where = others.map((other) => (other.rowNo !== null ? `${other.rowNo}行目` : `放送枠ID ${other.slot_id}`)).join('・');
      const hint = others.some((other) => other.rowNo === null) ? '。同じ枠なら、放送枠IDと版を入れてその枠を直してください' : '';
      errors.set(slot.rowNo, `同じ放送月（${slot.broadcast_month}）・同じ放送局「${slot.station_name}」の放送枠が${where}にもあります。1つの作品・月・局に放送枠は1つです（全角・半角や空白の違いは同じ局として扱います）${hint}`);
    }
  }
  return errors;
}

// ---- 競合（同じ作品・同じ月の別の局）--------------------------------------------------------------
// 申請中・仮押さえ・確定の枠どうし（下書き・差戻し・中止は数えない）。確定同士＝赤、それ以外＝黄。局名は stationKey で比べ、同じ局は競合ではない（二重登録）
// 申請中から確定までの放送枠（下書き・差し戻し・中止は数えない）。競合の判定と、提案の「同時期の他局」で同じ集合を使う
export const ACTIVE_SLOT_STATUSES = Object.freeze(new Set(['pending_first', 'tentative', 'pending_final', 'confirmed']));
export const isActiveSlot = (slot) => Boolean(slot) && ACTIVE_SLOT_STATUSES.has(slot.status);
const ACTIVE = ACTIVE_SLOT_STATUSES;
export function broadcastConflict(left, right) {
  if (left.slot_id === right.slot_id || left.work_id !== right.work_id || left.broadcast_month !== right.broadcast_month
    || stationKey(left.station_name) === stationKey(right.station_name) || !ACTIVE.has(left.status) || !ACTIVE.has(right.status)) return null;
  if (left.status === 'confirmed' && right.status === 'confirmed') return 'red';
  return 'yellow';
}
export function broadcastConflictMap(slots) {
  const out = new Map(slots.map((s) => [s.slot_id, null]));
  const groups = new Map();
  for (const s of slots) { const key = `${s.work_id}|${s.broadcast_month}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); }
  for (const list of groups.values()) {
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) {
      const color = broadcastConflict(list[a], list[b]);
      if (!color) continue;
      for (const s of [list[a], list[b]]) if (color === 'red' || out.get(s.slot_id) !== 'red') out.set(s.slot_id, color);
    }
  }
  return out;
}
