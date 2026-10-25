// プロデュース管理の進行表の決まり（要件 docs/requirements/planning/produce-progress.md。移行 0047）。純関数だけを置く。
// 状態（完了・遅れ・進行中・予定）は列に持たず、予定の日と着手・完了の記録から導く（FR-PLAN-PRODUCE-004）。
// 標準の進行（代表の19項目に節目「初号」を足した20行）はここの定数に持ち、DB には利用者が残したテンプレートだけを入れる（FR-PLAN-PRODUCE-007）。

export const PHASES = Object.freeze([
  {code: 'script', label: '企画・脚本'}, {code: 'prep', label: '準備'}, {code: 'shoot', label: '撮影'},
  {code: 'post', label: 'ポスプロ'}, {code: 'delivery', label: '完成・納品'}, {code: 'finance', label: '資金・契約'},
]);
export const ROLES = Object.freeze([{code: 'producer', label: 'P'}, {code: 'line_producer', label: 'LP'}]);
export const KINDS = Object.freeze([{code: 'work', label: '作業'}, {code: 'check', label: 'チェック'}, {code: 'milestone', label: '節目'}]);
export const MILESTONES = Object.freeze([
  {code: 'kikaku_go', label: '企画決定'}, {code: 'crank_in', label: 'クランクイン'}, {code: 'crank_up', label: 'クランクアップ'},
  {code: 'edit_lock', label: '編集の確定'}, {code: 'sound_mix', label: '整音'}, {code: 'first_print', label: '初号'},
  {code: 'final_screening', label: '完成試写'}, {code: 'release', label: '公開'}, {code: 'delivery', label: '納品'},
]);
const codes = (list) => new Set(list.map((item) => item.code));
const PHASE_CODES = codes(PHASES);
const ROLE_CODES = codes(ROLES);
const KIND_CODES = codes(KINDS);
const MILESTONE_CODES = codes(MILESTONES);

// 関連する場所の既定（業務の画面へのリンク。写しは持たない。FR-PLAN-PRODUCE-009）
const L = {
  script: {label: '脚本・台本', target: '?p=script'}, kouban: {label: '香盤・日々スケ', target: '?p=production'},
  art: {label: '美術・衣装（香盤）', target: '?p=production'}, cast: {label: 'キャスト', target: '?p=production'},
  budget: {label: '予算書', target: '?p=budget'}, catalog: {label: '作品・商品マスタ', target: '?p=catalog'},
  final: {label: '完成台本', target: '?p=script'}, cut: {label: 'カット割り表（スクリプター記録。無ければ仮のコンテ）', target: '?p=script'},
};
// 標準の進行。起点はクランクイン（0日目）。[段, 名前, 役, 種類, 開始の日数, 終了の日数, 節目, チェックする人, 関連する場所]
const STANDARD_ROWS = [
  ['script', '脚本開発期間', 'producer', 'work', -180, -60, null, null, ['script']],
  ['prep', 'スタッフィング', 'line_producer', 'work', -75, -45, null, null, ['budget']],
  ['prep', 'キャスティング', 'producer', 'work', -70, -30, null, null, ['cast', 'script']],
  ['prep', 'ロケハン', 'line_producer', 'work', -40, -15, null, null, ['kouban']],
  ['prep', '美打ち', 'line_producer', 'work', -21, -21, null, null, ['art', 'script']],
  ['prep', 'オールスタッフミーティング', 'line_producer', 'work', -14, -14, null, null, ['kouban', 'script']],
  ['prep', '衣装合わせ', 'line_producer', 'work', -12, -10, null, null, ['art', 'cast']],
  ['prep', '読み合わせ', 'producer', 'work', -9, -9, null, null, ['script', 'cast']],
  ['prep', 'リハーサル', 'line_producer', 'work', -7, -3, null, null, ['script', 'kouban']],
  ['shoot', '撮影期間', 'line_producer', 'work', 0, 27, null, null, ['kouban']],
  ['post', 'ポストプロダクション期間', 'line_producer', 'work', 35, 130, null, null, ['final', 'cut']],
  ['post', '試写', 'producer', 'check', 70, 71, null, '監督・P', ['final', 'cut']],
  ['post', '画完パケ', 'line_producer', 'work', 85, 88, null, null, ['final']],
  ['post', '音楽当て込み', 'line_producer', 'work', 88, 95, null, null, ['final', 'cut']],
  ['post', 'カラコレ', 'line_producer', 'work', 86, 96, null, null, ['final', 'cut']],
  ['post', '整音期間', 'line_producer', 'work', 96, 104, null, null, ['final', 'cut']],
  ['post', 'MA', 'line_producer', 'work', 105, 110, null, null, ['final']],
  ['delivery', '初号', 'producer', 'milestone', 115, 115, 'first_print', null, ['final']],
  ['delivery', '完成試写', 'producer', 'milestone', 120, 120, 'final_screening', '監督・P', ['final']],
  ['delivery', '納品', 'line_producer', 'milestone', 150, 150, 'delivery', null, ['catalog']],
];
export const STANDARD_TEMPLATE = Object.freeze({id: 'standard', name: '標準の進行', anchorKind: 'crank_in', items: STANDARD_ROWS.map((r, i) => Object.freeze({
  sortNo: i + 1, phase: r[0], title: r[1], role: r[2], kind: r[3], startOffsetDays: r[4], endOffsetDays: r[5], milestoneCode: r[6], checkers: r[7],
  links: r[8].map((key) => ({...L[key], isFallback: key === 'cut'})),
}))});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(later, earlier) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400000);
}
const text = (value, max) => {
  const s = value == null ? '' : String(value).trim();
  return s ? s.slice(0, max + 1) : null;
};

// チケットの入力を整える（新しいチケットにも、直した版にも使う）
export function normalizeTaskInput(input, {workIds = []} = {}) {
  const errors = [];
  const title = text(input.title, 120);
  if (!title) errors.push('名前を入れてください');
  else if (title.length > 120) errors.push('名前は120字までです');
  const kind = input.kind ?? 'work';
  if (!KIND_CODES.has(kind)) errors.push('種類を選んでください');
  const phase = input.phase;
  if (!PHASE_CODES.has(phase)) errors.push('段を選んでください');
  const role = input.role ?? 'producer';
  if (!ROLE_CODES.has(role)) errors.push('役を選んでください（P か LP）');
  const plannedStart = input.plannedStart;
  const plannedEnd = kind === 'milestone' ? plannedStart : (input.plannedEnd || plannedStart);
  if (!isDate(plannedStart)) errors.push('開始の日を入れてください');
  else if (!isDate(plannedEnd)) errors.push('終了の日を確かめてください');
  else if (plannedEnd < plannedStart) errors.push('終了は開始より後にしてください');
  const milestoneCode = input.milestoneCode || null;
  if (milestoneCode && !MILESTONE_CODES.has(milestoneCode)) errors.push('節目を確かめてください');
  const workId = input.workId == null || input.workId === '' ? null : Number(input.workId);
  if (workId != null && !workIds.includes(workId)) errors.push('作品を確かめてください');
  const assigneeLabel = text(input.assigneeLabel, 60);
  const checkers = text(input.checkers, 200);
  if (assigneeLabel && assigneeLabel.length > 60) errors.push('担当は60字までです');
  if (checkers && checkers.length > 200) errors.push('チェックする人は200字までです');
  if (errors.length) return {ok: false, errors};
  return {ok: true, value: {title, kind, phase, role, plannedStart, plannedEnd, milestoneCode, workId, assigneeLabel,
    checkers: kind === 'milestone' && !checkers ? null : checkers, templateLabel: text(input.templateLabel, 120)}};
}

// 最新の版だけを残す（やめたものは除く）
export function latestTasks(rows) {
  const byUid = new Map();
  for (const row of rows) {
    const current = byUid.get(row.taskUid);
    if (!current || row.versionNo > current.versionNo) byUid.set(row.taskUid, row);
  }
  return [...byUid.values()].filter((row) => !row.retired);
}

// 記録から導く: done（最後の done が最後の reopened より後）・started
export function eventState(events) {
  let done = null; let started = null; let reopened = null;
  for (const e of events) {
    if (e.kind === 'done') done = e;
    else if (e.kind === 'started') started = started ?? e;
    else if (e.kind === 'reopened') reopened = e;
  }
  const isDone = Boolean(done) && (!reopened || done.seq > reopened.seq);
  return {done: isDone, doneOn: isDone ? done.onDate : null, started: Boolean(started)};
}

export function taskState(task, events, today) {
  const ev = eventState(events);
  if (ev.done) return 'done';
  if (task.plannedEnd < today) return 'late';
  if (ev.started || task.plannedStart <= today) return 'now';
  return 'plan';
}

// 上の箱（FR-PLAN-PRODUCE-005）: 初号・納品までの日数、初号までのチェックの回数（済・残り）、次のチェック、遅れの数
export function boardSummary(tasks, states, today) {
  const by = (code) => tasks.find((t) => t.milestoneCode === code) ?? null;
  const firstPrint = by('first_print');
  const delivery = by('delivery');
  const checks = tasks.filter((t) => t.kind === 'check').sort((a, b) => a.plannedStart.localeCompare(b.plannedStart));
  const limit = firstPrint?.plannedStart ?? null;
  const before = limit ? checks.filter((t) => t.plannedStart <= limit) : checks;
  const doneBefore = before.filter((t) => states[t.taskUid] === 'done').length;
  const next = checks.find((t) => states[t.taskUid] !== 'done') ?? null;
  return {
    firstPrint: firstPrint ? {date: firstPrint.plannedStart, days: daysBetween(firstPrint.plannedStart, today)} : null,
    delivery: delivery ? {date: delivery.plannedStart, days: daysBetween(delivery.plannedStart, today)} : null,
    checks: {total: before.length, done: doneBefore, until: limit},
    nextCheck: next ? {taskUid: next.taskUid, title: next.title, start: next.plannedStart, end: next.plannedEnd, checkers: next.checkers} : null,
    late: tasks.filter((t) => states[t.taskUid] === 'late').length,
  };
}

// テンプレートを当てる（起点の日から日数をずらしてチケットにする。FR-PLAN-PRODUCE-007）
export function tasksFromTemplate(template, anchorDate) {
  if (!isDate(anchorDate)) return {ok: false, errors: ['起点（クランクイン）の日を入れてください']};
  return {ok: true, tasks: template.items.map((item) => ({
    title: item.title, kind: item.kind, phase: item.phase, role: item.role, checkers: item.checkers ?? null, milestoneCode: item.milestoneCode ?? null,
    plannedStart: addDays(anchorDate, item.startOffsetDays), plannedEnd: addDays(anchorDate, item.endOffsetDays),
    templateLabel: template.name, links: item.links ?? [],
  }))};
}

// 作品の進行をテンプレートとして残す（起点からの日数に直す）。起点はクランクインの節目かその名前のチケット、無ければ最初の開始日
export function templateFromTasks(tasks, linksByTask = {}) {
  const sorted = [...tasks].sort((a, b) => a.plannedStart.localeCompare(b.plannedStart) || a.taskUid - b.taskUid);
  const anchorTask = sorted.find((t) => t.milestoneCode === 'crank_in') ?? sorted.find((t) => t.title === '撮影期間');
  const anchor = anchorTask?.plannedStart ?? sorted[0]?.plannedStart;
  const anchorKind = anchorTask ? 'crank_in' : 'project_start';
  return {anchorKind, anchor, items: sorted.map((t, i) => ({sortNo: i + 1, kind: t.kind, phase: t.phase, title: t.title, role: t.role, checkers: t.checkers ?? null,
    milestoneCode: t.milestoneCode ?? null, startOffsetDays: daysBetween(t.plannedStart, anchor), endOffsetDays: daysBetween(t.plannedEnd, anchor),
    links: (linksByTask[t.taskUid] ?? []).map((l) => ({label: l.label, target: l.target, isFallback: Boolean(l.isFallback)}))}))};
}

export function normalizeLink(input) {
  const label = text(input.label, 120);
  const target = text(input.target, 500);
  const errors = [];
  if (!label || label.length > 120) errors.push('リンクの名前を入れてください（120字まで）');
  if (!target || target.length > 500) errors.push('リンク先を入れてください（500字まで）');
  else if (!/^(\?p=|https:\/\/)/.test(target)) errors.push('リンク先は ?p= で始まる画面か https:// で始まる場所にしてください');
  return errors.length ? {ok: false, errors} : {ok: true, value: {label, target, isFallback: Boolean(input.isFallback)}};
}
