// 案件収支の予実（YOJITSU）の、活動記録の純関数（フェーズ1の仕様書 #13、移行 0015）: 活動記録と取消の入力の読み取り、本人に返す形、
// 行動の実績件数（稼ぎ方×ステップ×期間・ステップ×月）と携わった案件数の数え方。要件は docs/requirements/revenue/project-cashflow-forecast-actual.md の
// FR-REV-YOJITSU-015・017・029・035・037。数えるのは store の readActivityTallies の件数（行の中身を持たない）で、行の中身は本人にだけ返す。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）
import {isCalendarDate, rollUpStep} from '../../planning/project/project-model.mjs';
import {periodMonths} from './yojitsu-model.mjs';

// 結果（進んだ・保留・失注）。移行 0015 の活動記録の result の CHECK と同じ並び
export const ACTIVITY_RESULTS = Object.freeze(['advanced', 'on_hold', 'lost']);
export const ACTIVITY_RESULT_LABELS = Object.freeze({advanced: '進んだ', on_hold: '保留', lost: '失注'});

const MAX_ID = Number.MAX_SAFE_INTEGER;
const isId = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_ID;
const num = (value) => (value === null || value === undefined ? null : Number(value));

function readText(errors, field, value, {max, required, label}) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    if (required) errors.push({field, message: `${label}を入れてください`});
    return null;
  }
  if (typeof value !== 'string') { errors.push({field, message: `${label}は文字で入れてください`}); return null; }
  const out = value.trim();
  if (out.length > max) errors.push({field, message: `${label}は${max}文字までです`});
  return out;
}

// 活動記録の入力（施策の受け口・取り込み・種が渡す形）を、store に渡す値にそろえる。steps は行動のステップの参照表の行（code）、
// earningTypes は稼ぎ方の参照表の行（code）。案件は必須（FR-REV-YOJITSU-035）。稼ぎ方は空なら案件の稼ぎ方で数え、ステップは空なら数えない
// （Excel の「その他」）。作品は空でよい（作品の無い段）。期日は次の一手に付ける。記録した人は受け口が identity から渡す（入力に持たない）。
// 返り値: {ok, value, errors:[{field, message}]}
export function normalizeActivityInput(raw, {steps, earningTypes}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const err = (field, message) => errors.push({field, message});
  if (!isId(src.projectId)) err('projectId', '案件を選んでください（活動記録は案件に付けます）');
  if (!isCalendarDate(src.occurredOn)) err('occurredOn', '日付は YYYY-MM-DD の日付で入れてください');
  const earningType = src.earningType ?? null;
  if (earningType !== null && !earningTypes.some((e) => e.code === earningType)) err('earningType', '稼ぎ方は稼ぎ方の一覧から選ぶか、空にしてください（空なら案件の稼ぎ方で数えます）');
  const step = src.step ?? null;
  if (step !== null && !steps.some((s) => s.code === step)) err('step', 'ステップは行動のステップの一覧から選ぶか、空にしてください（空は数えません）');
  const summary = readText(errors, 'summary', src.summary, {max: 1000, required: true, label: 'したこと'});
  const counterparty = readText(errors, 'counterparty', src.counterparty, {max: 200, required: false, label: '相手'});
  const deliverable = readText(errors, 'deliverable', src.deliverable, {max: 1000, required: false, label: '成果物'});
  const nextAction = readText(errors, 'nextAction', src.nextAction, {max: 1000, required: false, label: '次の一手'});
  const nextDueOn = src.nextDueOn ?? null;
  if (nextDueOn !== null && !isCalendarDate(nextDueOn)) err('nextDueOn', '期日は YYYY-MM-DD の日付で入れてください');
  if (nextDueOn !== null && nextAction === null) err('nextDueOn', '期日は次の一手に付けます。次の一手を入れてください');
  if (!ACTIVITY_RESULTS.includes(src.result)) err('result', '結果は 進んだ・保留・失注 のどれかです');
  const workId = src.workId ?? null;
  if (workId !== null && !isId(workId)) err('workId', '作品を読めません');
  const sourceSalesActivityId = src.sourceSalesActivityId ?? null;
  if (sourceSalesActivityId !== null && !isId(sourceSalesActivityId)) err('sourceSalesActivityId', '取り込む営業の活動を読めません');
  return {ok: errors.length === 0, errors, value: {projectId: src.projectId, occurredOn: src.occurredOn, earningType, step, counterparty, summary, deliverable,
    nextAction, nextDueOn, result: src.result, workId, sourceSalesActivityId}};
}

// 活動記録の取消の入力（直しは取消の行を足して、正しい行を足し直す。FR-REV-YOJITSU-035）
export function normalizeActivityCancellation(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  if (!isId(src.activityId)) errors.push({field: 'activityId', message: '取り消す活動記録を選んでください'});
  if (!isCalendarDate(src.cancelledOn)) errors.push({field: 'cancelledOn', message: '取り消した日は YYYY-MM-DD の日付で入れてください'});
  const reason = readText(errors, 'reason', src.reason, {max: 1000, required: true, label: '取り消す理由'});
  return {ok: errors.length === 0, errors, value: {activityId: src.activityId, cancelledOn: src.cancelledOn, reason}};
}

// 活動記録の行を、記録した本人に返す形にする（store が本人の行だけを読む。FR-REV-YOJITSU-037）
export function activityRecordView(row) {
  return {id: Number(row.id), projectId: Number(row.project_id), occurredOn: row.occurred_on, earningType: row.earning_type ?? null, step: row.step ?? null,
    counterparty: row.counterparty ?? null, summary: row.summary, deliverable: row.deliverable ?? null, nextAction: row.next_action ?? null,
    nextDueOn: row.next_due_on ?? null, result: row.result, workId: num(row.work_id), sourceSalesActivityId: num(row.source_sales_activity_id),
    createdBy: Number(row.created_by), cancelledOn: row.cancelled_on ?? null, cancelReason: row.cancel_reason ?? null};
}

// 月（YYYY-MM）→ 年目。periods は [{yearNo, startsOn}]（月初の日）。期間の外の月は無い
function monthToYear(periods) {
  const out = new Map();
  for (const p of periods) for (const m of periodMonths(p.startsOn)) out.set(m.slice(0, 7), Number(p.yearNo));
  return out;
}

// 行動の実績件数（FR-REV-YOJITSU-017）。tallies は store の readActivityTallies の行（project_id・earning_type＝行の稼ぎ方か案件の稼ぎ方・step・
// month＝YYYY-MM・n・with_deliverable。取り消した行は入らない）、steps は行動のステップの参照表の行（code・parent_code）。
// 細目の段は親の step（面談・提案・契約）へ畳んで数え、ステップが空・参照表に無い行と稼ぎ方の決まらない行は数えない。
// 返り値: byPeriod（`稼ぎ方|ステップ|年目` → 件数。期間の外の月は入れない）、byMonth（`ステップ|YYYY-MM` → 件数。稼ぎ方の決まる行の全部）、
// skipped（数えなかった件数: ステップが空 noStep・稼ぎ方が決まらない noEarningType）
export function countActivitySteps(tallies, {steps, periods}) {
  const yearOf = monthToYear(periods);
  const byPeriod = new Map();
  const byMonth = new Map();
  const skipped = {noStep: 0, noEarningType: 0};
  const add = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n);
  for (const row of tallies) {
    const n = Number(row.n);
    const top = rollUpStep(steps, row.step ?? null);
    if (top === null) { skipped.noStep += n; continue; }
    if (row.earning_type === null || row.earning_type === undefined) { skipped.noEarningType += n; continue; }
    add(byMonth, `${top}|${row.month}`, n);
    const year = yearOf.get(row.month);
    if (year !== undefined) add(byPeriod, `${row.earning_type}|${top}|${year}`, n);
  }
  return {byPeriod, byMonth, skipped};
}

// 携わった案件数（FR-REV-YOJITSU-029）: 成果物のある活動記録の行を、月×案件で1回だけ数える。返り値: YYYY-MM → 案件の数
export function engagedProjectCounts(tallies) {
  const projects = new Map();
  for (const row of tallies) {
    if (Number(row.with_deliverable) <= 0) continue;
    if (!projects.has(row.month)) projects.set(row.month, new Set());
    projects.get(row.month).add(Number(row.project_id));
  }
  return new Map([...projects].map(([month, set]) => [month, set.size]));
}
