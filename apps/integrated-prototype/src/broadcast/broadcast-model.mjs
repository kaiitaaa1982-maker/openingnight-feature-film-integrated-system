// 番販・放送の画面の論理（純関数。node で試験する）。
// 放送局の候補（取引先の「放送局」区分）、流通の選択肢（流通区分マスタだけを分類見出しつきで）、
// 放送枠の状態遷移の操作、承認待ちの一覧の集計。
import {labelOf} from '../ui/labels.mjs';
import {month as monthText} from '../ui/format.mjs';
import {distributionLabel, stationPartner, matchKey} from './broadcast-sheet.mjs';

export {stationPartner, distributionLabel};

export const PARTNER_ROLE_LABELS = Object.freeze({customer: '得意先', supplier: '仕入先', rights_holder: '権利元', broadcaster: '放送局', agency: '代理店'});
export const roleText = (roles = []) => (Array.isArray(roles) ? roles : []).map((role) => PARTNER_ROLE_LABELS[role] || role).join('・');

// 放送局として登録された取引先（区分に「放送局」がある）。
export function stationPartners(partners = []) {
  return (Array.isArray(partners) ? partners : []).filter((partner) => Array.isArray(partner.roles) && partner.roles.includes('broadcaster'));
}

// EntityPicker の候補。hint は「区分・コード」。
export function partnerItems(partners = [], {preferRole} = {}) {
  const list = Array.isArray(partners) ? [...partners] : [];
  if (preferRole) list.sort((a, b) => Number(!a.roles?.includes(preferRole)) - Number(!b.roles?.includes(preferRole)));
  return list.map((partner) => ({
    id: partner.id, code: partner.code || '', label: partner.name || partner.code || '',
    hint: [roleText(partner.roles) || '取引の区分は未設定', labelOf('partnerKind', partner.kind)].filter(Boolean).join('／'),
  }));
}

// 放送局の表示: 登録済みなら取引先名、そうでなければ「未登録の局」と明示する。
export function stationStatus(stationName, partners = []) {
  const name = String(stationName ?? '').trim();
  if (!name) return {registered: false, label: '未入力', partner: null};
  const partner = stationPartner(name, stationPartners(partners));
  return partner ? {registered: true, label: '登録済みの放送局', partner} : {registered: false, label: '未登録の局', partner: null};
}

// 流通の選択肢。流通区分マスタ（distribution_name がある流通）だけを、分類（配給・配信・放送…）の見出しでまとめる。
// 旧区分（legacy）は出さない。並びは渡された順（マスタの行順）。
export function distributionGroups(types = []) {
  const groups = new Map();
  for (const type of Array.isArray(types) ? types : []) {
    if (type.legacy || !type.distribution_name) continue;
    const group = type.distribution_name;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({value: type.code, label: `${distributionLabel(type)}（${type.code}）`, code: type.code});
  }
  return [...groups].map(([group, options]) => ({group, options}));
}

// 既存の行の流通の表示（旧区分は「旧区分」と明示する）。
export function distributionText(row, types = []) {
  const type = (Array.isArray(types) ? types : []).find((item) => item.code === row?.distribution_code);
  if (!type) return row?.distribution_code ? `未登録の流通（${row.distribution_code}）` : '未確認';
  if (type.legacy || !type.distribution_name) return `旧区分：${type.label || type.code}`;
  return `${type.distribution_name}・${distributionLabel(type)}`;
}

// ---- 放送枠の状態遷移 -------------------------------------------------------------------------
// to: 次の状態、kind: submit（申請）| approve（承認）| reject（差し戻し）| cancel（中止）
// needsReason: 理由が要る。irreversible: 元に戻せない（画面内で2段確認）。承認・差し戻しは管理者だけ。
const TRANSITIONS = Object.freeze({
  draft: [{to: 'pending_first', kind: 'submit', label: '一次承認を申請'}, {to: 'cancelled', kind: 'cancel', label: '中止'}],
  rejected: [{to: 'pending_first', kind: 'submit', label: '一次承認を申請し直す'}, {to: 'cancelled', kind: 'cancel', label: '中止'}],
  pending_first: [{to: 'tentative', kind: 'approve', label: '仮押さえを承認'}, {to: 'rejected', kind: 'reject', label: '差し戻す'}, {to: 'cancelled', kind: 'cancel', label: '中止'}],
  tentative: [{to: 'pending_final', kind: 'submit', label: '最終承認を申請'}, {to: 'cancelled', kind: 'cancel', label: '中止'}],
  pending_final: [{to: 'confirmed', kind: 'approve', label: '確定を承認'}, {to: 'rejected', kind: 'reject', label: '差し戻す'}, {to: 'cancelled', kind: 'cancel', label: '中止'}],
  confirmed: [{to: 'cancelled', kind: 'cancel', label: '中止'}],
  cancelled: [],
});

export function slotActions(row, {canEdit = false, isAdmin = false, include} = {}) {
  if (!canEdit) return [];
  return (TRANSITIONS[row?.status] || [])
    .filter((action) => (action.kind === 'approve' || action.kind === 'reject' ? isAdmin : true))
    .filter((action) => !include || include.includes(action.kind))
    .map((action) => ({...action, needsReason: action.kind === 'reject' || action.kind === 'cancel', irreversible: action.kind === 'cancel'}));
}

export const isPendingApproval = (status) => status === 'pending_first' || status === 'pending_final';

// 申請からの経過日数（JSTの暦日）。
export function waitingDays(requestedAt, now = new Date()) {
  if (!requestedAt) return null;
  const text = String(requestedAt);
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`; // SQLite の CURRENT_TIMESTAMP は UTC
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const day = (ms) => Math.floor((ms + 9 * 3600_000) / 86400_000);
  return Math.max(0, day(now.getTime()) - day(time));
}

export function conflictText(conflict) {
  if (conflict === 'red') return '競合：確定済みの別局と同じ月';
  if (conflict === 'yellow') return '注意：申請中・仮押さえの別局と同じ月';
  return '競合なし';
}

// 承認待ちの集計（タイルとタブの件数）。
export function approvalSummary(rows = [], now = new Date()) {
  const list = Array.isArray(rows) ? rows : [];
  const pending = list.filter((row) => isPendingApproval(row.status));
  const waits = pending.map((row) => waitingDays(row.requestedAt, now)).filter((n) => n !== null);
  return {
    first: list.filter((row) => row.status === 'pending_first').length,
    final: list.filter((row) => row.status === 'pending_final').length,
    pending: pending.length,
    conflicts: pending.filter((row) => row.conflict).length,
    oldestDays: waits.length ? Math.max(...waits) : null,
    works: new Set(pending.map((row) => row.workId)).size,
  };
}

// 承認・差し戻しの結果の文。
export function transitionMessage(row, to, revision) {
  const where = [row.workTitle, row.broadcastMonth ? monthText(row.broadcastMonth) : null, row.stationName].filter(Boolean).join('・');
  return `${where}を「${labelOf('broadcastStatus', to)}」にしました${revision ? `（第${revision}版）` : ''}`;
}

// 差し戻し・中止の理由の検査（画面内の入力）。
export function reasonError(reason, {kind} = {}) {
  const text = String(reason ?? '').trim();
  if (!text) return kind === 'cancel' ? '中止の理由を入れてください' : '差し戻す理由を入れてください（申請した人に表示されます）';
  if (text.length > 1000) return '理由は1000文字以内にしてください';
  return null;
}

export const sameName = (a, b) => matchKey(a) === matchKey(b);
