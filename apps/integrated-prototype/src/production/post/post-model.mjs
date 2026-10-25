// ポストプロダクションの純関数（要件 docs/requirements/production/post-production.md。会社ルートの plans/2026-10-22-folder-postprod.md の第3版）。
// 状態の列は持たず、足した行から今を導く: 指摘は最後の対応、タスクは最後の済／戻し、納品物は最後の状態の記録。
// ホームは数字だけ（契約の納品物の「納品済み・確認中・未」と、期限を過ぎたタスク）。工程ごとに「済んだタスク／全部」。

export const PHASES = Object.freeze([
  {code: 'edit', label: '編集'}, {code: 'sound', label: '音'}, {code: 'color', label: 'カラコレ'}, {code: 'screening', label: '試写'},
  {code: 'final_screening', label: '完成試写'}, {code: 'delivery', label: '納品物'}, {code: 'other', label: 'その他'},
]);
const PHASE_CODES = new Set(PHASES.map((p) => p.code));
export const CUT_KINDS = Object.freeze({work: '途中', locked: '確定', final: '完成'});
export const NOTE_RESULTS = Object.freeze({fixed: '直した', skipped: '見送り', hold: '保留', reopen: '戻す'});
export const DELIVERABLE_STATUSES = Object.freeze({pending: '未', making: '制作中', in_review: '確認中', redo: '要再納品', delivered: '納品済み'});
export const VIEWPOINTS = Object.freeze(['つながり', '編集', '音', '色', 'テロップ', 'バレ', 'NG な表現', '専門の確認']);
export const FROM_ROLES = Object.freeze(['監督', 'プロデューサー', '局・取引先', '監修・専門家', 'ポスプロ担当']);
export const ASSIGNEES = Object.freeze(['編集', 'VFX・バレ消し', '整音', '音楽・効果音', 'カラコレ', 'テロップ', 'その他']);

// 共同製作契約の「納入」の条項によく並ぶ物件（型）。作品ごとに行として足し、要らない行は「未」のまま残すか足さない
export const CONTRACT_DELIVERABLE_TEMPLATE = Object.freeze([
  {section: '本編', name: '上映用 DCP', owner: 'ポスプロ'},
  {section: '本編', name: '本編マスターデータ（mov ProRes 422 HQ・ステレオ 2ch）', owner: 'ポスプロ'},
  {section: '本編', name: '文字の箇所の白素材', owner: 'ポスプロ'},
  {section: '本編', name: 'Final mix（2ch）', owner: 'ポスプロ'},
  {section: '本編', name: 'ME（2ch）', owner: 'ポスプロ'},
  {section: '本編', name: 'ステムのマスター素材（D・SE・M）', owner: 'ポスプロ'},
  {section: 'その他', name: '完成台本', owner: 'プロダクション'},
  {section: 'その他', name: 'キューシート', owner: 'プロダクション'},
  {section: 'その他', name: 'スチール', owner: 'ポスプロ'},
  {section: 'その他', name: '制作で結んだ契約書の写し（権利処理の書面を含む）', owner: '契約'},
  {section: 'その他', name: 'メイキングの映像素材一式', owner: 'ポスプロ'},
  {section: 'その他', name: '引渡し素材目録', owner: 'ポスプロ'},
]);

const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const text = (value, max) => {
  const v = value == null ? '' : String(value).trim();
  return v && v.length <= max ? v : null;
};
const optionalText = (value, max, errors, label) => {
  if (value == null || String(value).trim() === '') return null;
  const v = text(value, max);
  if (!v) errors.push(`${label}は${max}字まで`);
  return v;
};
const optionalInt = (value, min, max, errors, label) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) { errors.push(`${label}を確かめてください`); return null; }
  return n;
};
const optionalDate = (value, errors, label) => {
  if (value == null || value === '') return null;
  if (!isDate(value)) { errors.push(`${label}は YYYY-MM-DD で`); return null; }
  return value;
};

export function jstToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// TC: "01:02:03"・"1:02:03"・"02:03"・"123"（秒）を秒にする。読めなければ null
export function parseTc(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 86400 ? value : null;
  const v = String(value ?? '').trim();
  if (/^\d{1,5}$/.test(v)) return parseTc(Number(v));
  const m = v.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[:;.]\d{1,2})?$/);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (mi > 59 || s > 59) return null;
  return parseTc(h * 3600 + mi * 60 + s);
}
export function formatTc(seconds) {
  if (seconds == null) return '';
  const s = Math.max(0, Math.floor(Number(seconds)));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

// Vimeo の動画の番号と非公開の印（h=）を URL から取る。埋め込みの URL を作るのに使う。Vimeo でなければ null
export function vimeoEmbed(url) {
  if (typeof url !== 'string') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)vimeo\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const idAt = parts.findIndex((p) => /^\d{5,12}$/.test(p));
  if (idAt < 0) return null;
  const id = parts[idAt];
  const hash = u.searchParams.get('h') ?? (/^[0-9a-f]{6,20}$/.test(parts[idAt + 1] ?? '') ? parts[idAt + 1] : null);
  return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}&` : '?'}dnt=1`;
}

export function normalizeCut(input) {
  const errors = [];
  const label = text(input.label, 40);
  if (!label) errors.push('版の名前（例 v3）を入れてください');
  const kind = Object.hasOwn(CUT_KINDS, input.kind) ? input.kind : (input.kind == null || input.kind === '' ? 'work' : null);
  if (!kind) errors.push('版の種類を確かめてください');
  let reviewUrl = null;
  if (input.reviewUrl != null && String(input.reviewUrl).trim() !== '') {
    reviewUrl = String(input.reviewUrl).trim();
    if (!/^https:\/\/\S+$/.test(reviewUrl) || reviewUrl.length > 500) { errors.push('視聴のリンクは https で始まる500字までの URL にしてください'); reviewUrl = null; }
  }
  const value = {episodeNo: optionalInt(input.episodeNo, 1, 999, errors, '話'), variant: optionalText(input.variant, 60, errors, '出し先の版'), label, kind,
    deliveredOn: optionalDate(input.deliveredOn, errors, '上がった日'), runtimeSeconds: null, reviewUrl};
  if (input.runtime != null && String(input.runtime).trim() !== '') {
    const seconds = parseTc(input.runtime);
    if (seconds == null || seconds < 1) errors.push('尺は 1:52:30 の形で');
    else value.runtimeSeconds = seconds;
  }
  return errors.length ? {ok: false, errors} : {ok: true, value};
}

export function normalizeNote(input) {
  const errors = [];
  const cutId = Number(input.cutId);
  if (!Number.isSafeInteger(cutId) || cutId <= 0) errors.push('どの版へのメモかを選んでください');
  const tcIn = parseTc(input.tcIn);
  if (tcIn == null) errors.push('TC（イン）を 00:12:40 の形で入れてください');
  let tcOut = null;
  if (input.tcOut != null && String(input.tcOut).trim() !== '') {
    tcOut = parseTc(input.tcOut);
    if (tcOut == null || (tcIn != null && tcOut < tcIn)) { errors.push('TC（アウト）はイン以降の時刻で'); tcOut = null; }
  }
  const viewpoint = text(input.viewpoint, 40) ?? (errors.push('観点を選んでください'), null);
  const fromRole = text(input.fromRole, 40) ?? (errors.push('誰からかを選んでください'), null);
  const assignee = text(input.assignee, 40) ?? (errors.push('担当を選んでください'), null);
  const body = text(input.body, 2000) ?? (errors.push('内容を入れてください（2000字まで）'), null);
  return errors.length ? {ok: false, errors} : {ok: true, value: {cutId, tcIn, tcOut, viewpoint, fromRole, assignee, body}};
}

export function normalizeNoteAction(input) {
  const errors = [];
  const result = Object.hasOwn(NOTE_RESULTS, input.result) ? input.result : null;
  if (!result) errors.push('対応を選んでください');
  const reason = optionalText(input.reason, 1000, errors, '理由');
  if (result === 'skipped' && !reason) errors.push('見送りは理由を入れてください');
  const fixedCutId = optionalInt(input.fixedCutId, 1, Number.MAX_SAFE_INTEGER, errors, '直した版');
  return errors.length ? {ok: false, errors} : {ok: true, value: {result, reason, fixedCutId}};
}

export function normalizeTask(input) {
  const errors = [];
  const phase = PHASE_CODES.has(input.phase) ? input.phase : null;
  if (!phase) errors.push('工程を選んでください');
  const name = text(input.name, 200) ?? (errors.push('タスクの名前を入れてください（200字まで）'), null);
  const value = {phase, name, episodeNo: optionalInt(input.episodeNo, 1, 999, errors, '話'), dueOn: optionalDate(input.dueOn, errors, '期日'),
    assignee: optionalText(input.assignee, 60, errors, '担当')};
  return errors.length ? {ok: false, errors} : {ok: true, value};
}

export function normalizeTaskEvent(input) {
  const errors = [];
  const kind = ['done', 'undone', 'due'].includes(input.kind) ? input.kind : null;
  if (!kind) errors.push('済み・戻す・期日の変更のどれかを選んでください');
  const dueOn = kind === 'due' ? optionalDate(input.dueOn, errors, '期日') : null;
  if (kind === 'due' && !dueOn) errors.push('新しい期日を入れてください');
  return errors.length ? {ok: false, errors} : {ok: true, value: {kind, dueOn}};
}

export function normalizeDeliverable(input) {
  const errors = [];
  const sourceKind = ['contract', 'guide', 'manual'].includes(input.sourceKind) ? input.sourceKind : (input.sourceKind == null ? 'manual' : null);
  if (!sourceKind) errors.push('出どころを確かめてください');
  const name = text(input.name, 200) ?? (errors.push('納品物の名前を入れてください（200字まで）'), null);
  const value = {sourceKind, name, section: optionalText(input.section, 40, errors, '区分'), episodeNo: optionalInt(input.episodeNo, 1, 999, errors, '話'),
    spec: optionalText(input.spec, 1000, errors, '仕様'), owner: optionalText(input.owner, 40, errors, '持ち主'),
    salesDeliverableId: optionalInt(input.salesDeliverableId, 1, Number.MAX_SAFE_INTEGER, errors, '取引先への納品')};
  return errors.length ? {ok: false, errors} : {ok: true, value};
}

export function normalizeDeliverableEvent(input, today) {
  const errors = [];
  const status = Object.hasOwn(DELIVERABLE_STATUSES, input.status) ? input.status : null;
  if (!status) errors.push('状態を選んでください');
  const onDate = input.onDate == null || input.onDate === '' ? today : optionalDate(input.onDate, errors, '日');
  const note = optionalText(input.note, 500, errors, 'メモ');
  return errors.length ? {ok: false, errors} : {ok: true, value: {status, onDate, note}};
}

// 指摘の今の状態: 最後の対応（戻すは未に戻る）。対応が無ければ未
export function noteState(actions) {
  const last = actions.at(-1);
  if (!last || last.result === 'reopen') return 'open';
  return last.result;
}
export const isOpenNote = (state) => state === 'open' || state === 'hold';

// タスクの今: 最後の済／戻すで済みかを、最後の期日の変更で期日を決める
export function taskState(task, events) {
  let done = false; let doneOn = null; let dueOn = task.dueOn ?? null;
  for (const e of events) {
    if (e.kind === 'done') { done = true; doneOn = e.onDate; }
    else if (e.kind === 'undone') { done = false; doneOn = null; }
    else if (e.kind === 'due') dueOn = e.dueOn;
  }
  return {done, doneOn, dueOn};
}
export const isLate = (task, today) => !task.done && task.dueOn != null && task.dueOn < today;

export function deliverableState(events) {
  const last = events.at(-1);
  return last ? {status: last.status, onDate: last.onDate} : {status: 'pending', onDate: null};
}

// 工程ごとの「済／全部・期限超・ゴール（最も遅い期日）」
export function phaseSummaries(tasks, deliverables, today) {
  return PHASES.filter((p) => p.code !== 'other' || tasks.some((t) => t.phase === 'other')).map((p) => {
    if (p.code === 'delivery') {
      const total = deliverables.length;
      return {phase: p.code, label: p.label, done: deliverables.filter((d) => d.status === 'delivered').length, total, late: 0, goal: null};
    }
    const own = tasks.filter((t) => t.phase === p.code);
    const dues = own.map((t) => t.dueOn).filter(Boolean).sort();
    return {phase: p.code, label: p.label, done: own.filter((t) => t.done).length, total: own.length, late: own.filter((t) => isLate(t, today)).length,
      goal: dues.at(-1) ?? null};
  });
}

// ホームの数字（契約の納品物の状態ごとの数と、期限を過ぎたタスク・片づいていない指摘）
export function homeNumbers(tasks, deliverables, notes, today) {
  const count = (status) => deliverables.filter((d) => d.status === status).length;
  return {delivered: count('delivered'), inReview: count('in_review') + count('making') + count('redo'), pending: count('pending'),
    total: deliverables.length, lateTasks: tasks.filter((t) => isLate(t, today)).length, openNotes: notes.filter((n) => isOpenNote(n.state)).length};
}

// フォルダの状態（約束 R-2。F05）: 何も無ければ未着手、期限超か片づいていない指摘があれば要確認、
// 完成試写の指摘が全部片づき納品物が全部納品済みなら済み（問い16 A）、ほかは進行中
export function postFolderStatus({tasks, deliverables, notes, finalScreeningNoteOpen, today}) {
  const total = PHASES.filter((p) => p.code !== 'other').length;
  const sums = phaseSummaries(tasks, deliverables, today).filter((s) => s.phase !== 'other');
  const done = sums.filter((s) => s.total > 0 && s.done === s.total).length;
  const empty = !tasks.length && !deliverables.length && !notes.length;
  const allDelivered = deliverables.length > 0 && deliverables.every((d) => d.status === 'delivered');
  if (empty) return {folderId: 'F05', state: 'not_started', done: 0, total, reason: null, doneOn: null};
  if (allDelivered && !finalScreeningNoteOpen) {
    const doneOn = deliverables.map((d) => d.onDate).filter(Boolean).sort().at(-1) ?? null;
    return {folderId: 'F05', state: 'done', done, total, reason: null, doneOn};
  }
  const late = tasks.filter((t) => isLate(t, today)).length;
  const open = notes.filter((n) => isOpenNote(n.state)).length;
  if (late || open) return {folderId: 'F05', state: 'needs_review', done, total, reason: [open ? `残 ${open}` : null, late ? '期限超' : null].filter(Boolean).join('・'), doneOn: null};
  return {folderId: 'F05', state: 'in_progress', done, total, reason: null, doneOn: null};
}
