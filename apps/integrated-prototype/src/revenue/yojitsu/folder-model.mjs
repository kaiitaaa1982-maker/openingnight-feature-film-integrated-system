// 予実管理のフォルダ（会社ルートの plans/2026-10-22-folder-yojitsu.md）。年度の12か月のマスの「揃い」と、全体・案件ごとの4段を、
// 予実の4段（buildYojitsuView）の結果と、営業の活動・予測・入金の件数から導く。表は読まない（純関数）。
// - 月の印は4つ: 目（その年度の目標〈本人〉と計画の版）・行（結果欄が空の営業の活動）・予（着地の案件なのに予測の版が無い）・実（請求額と違う入金〈未確定〉）
// - 月の状態は 締済（締めた月以前）・今月・未来・不足 n・締可 の5つ。状態の列は持たず、読むたびに導く
// - 年度の名前は始まりの年（2026-11 始まり → 2026年度）
// Worker でも動くよう node:* を import しない
import {MONTHS_PER_PERIOD, addMonths, periodMonths} from './yojitsu-model.mjs';

export const FOLDER_MARKS = Object.freeze(['target', 'action', 'forecast', 'actual']);
export const FOLDER_MARK_LABELS = Object.freeze({target: '目', action: '行', forecast: '予', actual: '実'});
export const FOLDER_STATES = Object.freeze(['closed', 'current', 'future', 'missing', 'closable']);
// 4段の表に出す行（buildYojitsuView の rows の key）。主要は黒、比は細字、補助は灰色
export const FOLDER_ROW_KEYS = Object.freeze(['target_self', 'plan', 'landing', 'actual', 'actual_rate', 'actual_progress', 'weighted']);

export const monthKey = (monthStart) => String(monthStart).slice(0, 7);
export const fiscalYearLabel = (startsOn) => `${String(startsOn).slice(0, 4)}年度`;

// 締めた月（YYYY-MM-01 か null）から、ある月の状態を導く。today は YYYY-MM-DD
export function monthState({month, closedMonth, today, missing}) {
  const thisMonth = `${String(today).slice(0, 7)}-01`;
  if (closedMonth && month <= closedMonth) return 'closed';
  if (month > thisMonth) return 'future';
  if (month === thisMonth) return 'current';
  return missing > 0 ? 'missing' : 'closable';
}

// 締められる月か（締めるのは今月より前の月だけ。締めた月より後で、間を飛ばさない）
export function closeCheck({month, closedMonth, today, firstMonth}) {
  const thisMonth = `${String(today).slice(0, 7)}-01`;
  if (month >= thisMonth) return {ok: false, message: '今月と未来の月は締められません（月が終わってから締めます）'};
  const next = closedMonth ? addMonths(closedMonth, 1) : firstMonth;
  if (month !== next) return {ok: false, message: `締めは月の順に1か月ずつです（次に締める月は ${monthKey(next)}）`};
  return {ok: true};
}

// 締めを戻す先（いまの締めた月の前の月。最初の月を戻すと締めが無い状態の印として期間の前の月）
export function reopenTarget({closedMonth}) {
  if (!closedMonth) return {ok: false, message: '締めた月がありません'};
  return {ok: true, value: addMonths(closedMonth, -1)};
}

// 年度1つ分のフォルダの見え方。view は buildYojitsuView の結果（全体）
// - inputs.emptyResults: [{month: 'YYYY-MM', count}] 結果欄が空の営業の活動
// - inputs.projects: readYojitsuSources の projects（id・code・title・probability_bps）
// - inputs.forecastProjectIds: 予測の版がある案件の id
// - inputs.unsettled: linkReceiptsToProjects の unsettled（month は YYYY-MM-01）
export function buildFolderView({view, yearNo, closedMonth, closedVersionNo, today, emptyResults = [], projects = [], forecastProjectIds = [], unsettled = [],
  landingBps = null, projectViews = []}) {
  const period = view.periods.find((p) => p.yearNo === yearNo) ?? null;
  if (!period) return {period: null, months: [], rows: [], projects: []};
  const months = periodMonths(period.startsOn);
  const offset = view.months.indexOf(period.startsOn);
  const rowsByKey = new Map(view.rows.map((r) => [r.key, r]));
  const pick = (key) => {
    const row = rowsByKey.get(key);
    if (!row) return null;
    const values = offset < 0 ? Array(MONTHS_PER_PERIOD).fill(null) : row.months.slice(offset, offset + MONTHS_PER_PERIOD);
    const pi = view.periods.findIndex((p) => p.yearNo === yearNo);
    return {key, label: row.label, unit: row.unit, role: row.role, months: values, annual: row.periods[pi] ?? null, hidden: (row.hiddenYears ?? []).includes(yearNo)};
  };
  const rows = FOLDER_ROW_KEYS.map(pick).filter(Boolean);
  const target = rows.find((r) => r.key === 'target_self');
  const plan = rows.find((r) => r.key === 'plan');
  // 目の印: 年度の目標（本人）か計画の版が無ければ、その年度の月すべてに1件ずつ（見えないだけの owner_only は版があるので数えない）
  const pi = view.periods.findIndex((p) => p.yearNo === yearNo);
  const targetState = rowsByKey.get('target_self')?.states?.[pi] ?? 'unset';
  const planState = rowsByKey.get('plan')?.states?.[pi] ?? 'unset';
  const targetMissing = (targetState === 'unset' ? 1 : 0) + (planState === 'unset' ? 1 : 0);
  const emptyBy = new Map(emptyResults.map((r) => [String(r.month), Number(r.count)]));
  const withForecast = new Set(forecastProjectIds.map(Number));
  const landingWithoutForecast = landingBps === null ? [] : projects
    .filter((p) => p.probability_bps !== null && p.probability_bps !== undefined && Number(p.probability_bps) >= landingBps && !withForecast.has(Number(p.id)));
  const unsettledBy = new Map();
  for (const u of unsettled) unsettledBy.set(monthKey(u.month), (unsettledBy.get(monthKey(u.month)) ?? 0) + 1);
  const cells = months.map((month) => {
    const key = monthKey(month);
    const marks = {target: targetMissing, action: emptyBy.get(key) ?? 0, forecast: landingWithoutForecast.length, actual: unsettledBy.get(key) ?? 0};
    const missing = Object.values(marks).reduce((a, b) => a + b, 0);
    const state = monthState({month, closedMonth, today, missing});
    const shown = state === 'future' || state === 'current' ? {target: 0, action: 0, forecast: 0, actual: 0} : marks;
    return {month, key, state, marks: shown, missing: state === 'future' || state === 'current' ? 0 : missing};
  });
  const details = {
    target: targetMissing ? [targetState === 'unset' ? '年度の目標（本人）の版がありません' : null, planState === 'unset' ? '年度の計画の版がありません' : null].filter(Boolean) : [],
    forecast: landingWithoutForecast.map((p) => ({projectId: Number(p.id), code: p.code, title: p.title})),
  };
  return {
    period: {yearNo, startsOn: period.startsOn, lastMonth: period.lastMonth, label: fiscalYearLabel(period.startsOn)},
    closedMonth, closedVersionNo, today,
    months: cells, rows, details,
    targetAnnualYen: target?.annual ?? null, planAnnualYen: plan?.annual ?? null,
    projects: projectViews,
  };
}

// 案件ごとの4段（着地予測・実績）を、年度の12か月で切り出す。view は案件1件だけで組んだ buildYojitsuView の結果
export function projectFolderRow({project, view, yearNo}) {
  const pi = view.periods.findIndex((p) => p.yearNo === yearNo);
  const period = view.periods[pi];
  const offset = period ? view.months.indexOf(period.startsOn) : -1;
  const slice = (key) => {
    const row = view.rows.find((r) => r.key === key);
    if (!row || offset < 0) return {months: Array(MONTHS_PER_PERIOD).fill(null), annual: null};
    return {months: row.months.slice(offset, offset + MONTHS_PER_PERIOD), annual: row.periods[pi] ?? null};
  };
  return {projectId: Number(project.id), code: project.code, title: project.title, earningType: project.earning_type ?? null, stageCode: project.stage_code ?? null,
    probabilityBps: project.probability_bps ?? null, landing: slice('landing'), weighted: slice('weighted'), actual: slice('actual')};
}
