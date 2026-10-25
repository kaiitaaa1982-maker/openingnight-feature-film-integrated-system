// 予実管理のフォルダの受け口（会社ルートの plans/2026-10-22-folder-yojitsu.md の最初の一切れ。移行を足さず、いまの表だけで動く）。
//   GET  /api/revenue/yojitsu/folder?year=N            年度の12か月のマス（目・行・予・実の印と状態）、全体の4段、案件ごとの着地予測と実績
//   POST /api/revenue/yojitsu/folder/periods            年度（1〜5年目）を作る（まだ1つも無いときだけ）。{firstMonth: 'YYYY-MM'}
//   POST /api/revenue/yojitsu/folder/target             年度の目標（本人・全体・額）の版を足す。{year, amountYen, previousVersionNo, reason}
//   POST /api/revenue/yojitsu/folder/close              月を締める（締めた月の版を足す）。{month: 'YYYY-MM', previousVersionNo, reason}
//   POST /api/revenue/yojitsu/folder/reopen             いまの締めた月を1か月戻す。{previousVersionNo, reason}
//   GET  /api/revenue/yojitsu/folder/closes             締めの記録（締めた月の版の履歴）
// - 予実は入金に固定（D-039）。4段は GET /api/revenue/yojitsu と同じ buildYojitsuView で組む
// - 権限: 読むのは /api/revenue/yojitsu と同じ（制作担当は 403、財務の権限のある案件だけ）。書くのは管理者だけ
// - 足りないまま締めるときは理由が要る（問い6 A）。締め・戻しの理由は締めた月の版の根拠（basis）に残す
// - asOf（YYYY-MM-DD）を渡すと、その日を今日として月の状態を決める（試験と架空データの確かめ用。省けば日本時間の今日）
// Worker でも動くよう node:* を import しない
import {addChoiceVersion, addTargetVersion, definePeriods, listPeriods, readClosedMonthHistory, readEmptySalesResultsByMonth, readTargets, readYojitsuSources} from '../revenue-store.mjs';
import {revenueClassBases} from '../revenue-class/revenue-class-model.mjs';
import {countActivitySteps} from './activity-model.mjs';
import {linkReceiptsToProjects} from './receipt-inflow-model.mjs';
import {PERIOD_YEARS, addMonths, buildYojitsuView, normalizeChoiceInput, normalizeTargetInput, periodStarts} from './yojitsu-model.mjs';
import {buildFolderView, closeCheck, monthKey, projectFolderRow, reopenTarget} from './folder-model.mjs';

const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

function viewFrom(sources, targets, {projects = sources.projects, forecastSums = sources.forecastSums, receiptLines = sources.receiptLines, activityTallies = sources.activityTallies} = {}) {
  return buildYojitsuView({
    periods: sources.periods, targets, plans: sources.plans, settings: sources.settings, choices: sources.choices, earningTypes: sources.earningTypes,
    projects, bases: revenueClassBases(sources.revenueClassInputs), forecastSums,
    inflows: linkReceiptsToProjects(receiptLines, {projectIds: projects.map((p) => p.id)}),
    activity: countActivitySteps(activityTallies, {steps: sources.activitySteps, periods: sources.periods}),
  });
}

export function registerYojitsuFolderRoutes(app, {db, bad, permittedProjectScope}) {
  if (!app || !db || typeof bad !== 'function' || typeof permittedProjectScope !== 'function') {
    throw new Error('yojitsu folder routes require app, db, bad and permittedProjectScope');
  }
  const admin = (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role !== 'admin') return null;
    return identity;
  };

  app.get('/api/revenue/yojitsu/folder', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '予実は財務の画面です（制作担当は見られません）', 403);
    const asOf = c.req.query('asOf');
    if (asOf !== undefined && !isDate(asOf)) return bad(c, 'asOf は YYYY-MM-DD の日付です', 400, {field: 'asOf'});
    const today = asOf ?? todayJst();
    const scope = permittedProjectScope(identity, true);
    const sources = await readYojitsuSources(db, identity.org_id, {scope, viewerUserId: identity.user_id});
    if (identity.role !== 'admin' && !sources.projects.length) return bad(c, '財務の権限がある案件がありません', 403);
    if (!sources.periods.length) return c.json({ok: true, periods: [], folder: null, today, canWrite: identity.role === 'admin'});
    const yearParam = c.req.query('year');
    const thisMonth = `${today.slice(0, 7)}-01`;
    const defaultYear = sources.periods.findLast((p) => p.startsOn <= thisMonth)?.yearNo ?? sources.periods[0].yearNo;
    const yearNo = yearParam === undefined ? defaultYear : Number(yearParam);
    if (!sources.periods.some((p) => p.yearNo === yearNo)) return bad(c, '年度が見つかりません', 404, {field: 'year'});
    const targets = await readTargets(db, identity.org_id, {viewerUserId: identity.user_id});
    const view = viewFrom(sources, targets);
    const emptyResults = await readEmptySalesResultsByMonth(db, identity.org_id, {scope});
    const inflows = linkReceiptsToProjects(sources.receiptLines, {projectIds: sources.projects.map((p) => p.id)});
    const landingBps = view.conditions.find((x) => x.key === 'landingProbabilityBps')?.value ?? null;
    const projectViews = sources.projects.map((project) => projectFolderRow({project, yearNo, view: viewFrom(sources, [], {
      projects: [project],
      forecastSums: sources.forecastSums.filter((r) => Number(r.project_id) === project.id),
      activityTallies: [],
    })}));
    const history = await readTargets(db, identity.org_id, {viewerUserId: identity.user_id, history: true});
    const period = sources.periods.find((p) => p.yearNo === yearNo);
    const targetVersionNo = history.filter((t) => t.periodId === period.id && t.kind === 'self' && t.scope === 'all').reduce((m, t) => Math.max(m, t.versionNo), 0);
    const folder = buildFolderView({view, yearNo, today, closedMonth: sources.choices?.closedMonth?.value ?? null, closedVersionNo: sources.choices?.closedMonth?.versionNo ?? 0,
      emptyResults, projects: sources.projects, forecastProjectIds: [...new Set(sources.forecastSums.map((r) => Number(r.project_id)))],
      unsettled: inflows.unsettled, landingBps, projectViews});
    return c.json({ok: true, today, canWrite: identity.role === 'admin', basisLabel: view.basisLabel, taxLabel: view.taxLabel,
      periods: sources.periods.map((p) => ({yearNo: p.yearNo, startsOn: p.startsOn, label: `${p.startsOn.slice(0, 4)}年度`})),
      folder: {...folder, targetVersionNo}, notes: view.notes, conditions: view.conditions});
  });

  app.post('/api/revenue/yojitsu/folder/periods', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, '年度を作れるのは管理者だけです', 403);
    const body = await c.req.json().catch(() => ({}));
    if (!isMonth(body.firstMonth)) return bad(c, '始まりの月は YYYY-MM で入れてください', 400, {field: 'firstMonth'});
    if ((await listPeriods(db, identity.org_id)).length) return bad(c, '年度はもうあります', 409);
    const starts = periodStarts(`${body.firstMonth}-01`);
    await definePeriods(db, identity.org_id, starts.map((startsOn, i) => ({yearNo: i + 1, startsOn})), {createdBy: identity.user_id});
    return c.json({ok: true, years: PERIOD_YEARS}, 201);
  });

  app.post('/api/revenue/yojitsu/folder/target', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, '目標を入れられるのは管理者だけです', 403);
    const body = await c.req.json().catch(() => ({}));
    const period = (await listPeriods(db, identity.org_id)).find((p) => p.yearNo === Number(body.year));
    if (!period) return bad(c, '年度が見つかりません', 404, {field: 'year'});
    const checked = normalizeTargetInput({periodId: period.id, previousVersionNo: body.previousVersionNo ?? 0, kind: 'self', scope: 'all', unit: 'period_total',
      basisKind: 'amount', amountYen: body.amountYen, status: 'confirmed', decidedOn: todayJst(), basis: body.reason ?? null, ownerUserId: identity.user_id});
    if (!checked.ok) return bad(c, checked.errors.map((e) => e.message).join('。'), 400, {errors: checked.errors});
    try {
      await addTargetVersion(db, identity.org_id, checked.value, {createdBy: identity.user_id});
    } catch (error) {
      return bad(c, 'ほかの画面が先に目標を直しました。読み直してからもう一度入れてください', 409);
    }
    return c.json({ok: true, versionNo: checked.value.previousVersionNo + 1}, 201);
  });

  app.post('/api/revenue/yojitsu/folder/close', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, '月を締められるのは管理者だけです', 403);
    const body = await c.req.json().catch(() => ({}));
    if (!isMonth(body.month)) return bad(c, '締める月は YYYY-MM で入れてください', 400, {field: 'month'});
    const asOf = body.asOf ?? todayJst();
    if (!isDate(asOf)) return bad(c, 'asOf は YYYY-MM-DD の日付です', 400, {field: 'asOf'});
    const scope = permittedProjectScope(identity, true);
    const sources = await readYojitsuSources(db, identity.org_id, {scope, viewerUserId: identity.user_id});
    if (!sources.periods.length) return bad(c, '年度がありません', 409);
    const month = `${body.month}-01`;
    const closedMonth = sources.choices?.closedMonth?.value ?? null;
    const check = closeCheck({month, closedMonth, today: asOf, firstMonth: sources.periods[0].startsOn});
    if (!check.ok) return bad(c, check.message, 409);
    const period = sources.periods.find((p) => p.startsOn <= month && month <= addMonths(p.startsOn, 11));
    if (!period) return bad(c, '年度の外の月は締められません', 409);
    // 足りないものの件数（画面と同じ導き方）
    const targets = await readTargets(db, identity.org_id, {viewerUserId: identity.user_id});
    const view = viewFrom(sources, targets);
    const inflows = linkReceiptsToProjects(sources.receiptLines, {projectIds: sources.projects.map((p) => p.id)});
    const folder = buildFolderView({view, yearNo: period.yearNo, today: asOf, closedMonth, emptyResults: await readEmptySalesResultsByMonth(db, identity.org_id, {scope}),
      projects: sources.projects, forecastProjectIds: [...new Set(sources.forecastSums.map((r) => Number(r.project_id)))], unsettled: inflows.unsettled,
      landingBps: view.conditions.find((x) => x.key === 'landingProbabilityBps')?.value ?? null});
    const cell = folder.months.find((m) => m.month === month);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (cell && cell.missing > 0 && !reason) return bad(c, `足りないものが ${cell.missing} 件あります。足りないまま締めるときは理由を入れてください`, 400, {field: 'reason', missing: cell.marks});
    const marks = cell ? Object.entries(cell.marks).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(',') : '';
    const basis = [`締め ${monthKey(month)}`, marks ? `足りない ${marks}` : '揃', reason ? `理由: ${reason}` : null].filter(Boolean).join('。');
    const checked = normalizeChoiceInput({choiceKey: 'closed_month', previousVersionNo: body.previousVersionNo ?? 0, value: month, basis: basis.slice(0, 1000)});
    if (!checked.ok) return bad(c, checked.errors.map((e) => e.message).join('。'), 400, {errors: checked.errors});
    try {
      await addChoiceVersion(db, identity.org_id, checked.value, {createdBy: identity.user_id});
    } catch (error) {
      return bad(c, 'ほかの画面が先に締めを変えました。読み直してからもう一度押してください', 409);
    }
    return c.json({ok: true, closedMonth: month, versionNo: checked.value.previousVersionNo + 1}, 201);
  });

  app.post('/api/revenue/yojitsu/folder/reopen', async (c) => {
    const identity = admin(c);
    if (!identity) return bad(c, '締めを戻せるのは管理者だけです', 403);
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return bad(c, '締めを戻す理由を入れてください', 400, {field: 'reason'});
    const sources = await readYojitsuSources(db, identity.org_id, {scope: permittedProjectScope(identity, true), viewerUserId: identity.user_id});
    const target = reopenTarget({closedMonth: sources.choices?.closedMonth?.value ?? null});
    if (!target.ok) return bad(c, target.message, 409);
    const checked = normalizeChoiceInput({choiceKey: 'closed_month', previousVersionNo: body.previousVersionNo ?? 0, value: target.value,
      basis: `戻し ${monthKey(sources.choices.closedMonth.value)}。理由: ${reason}`.slice(0, 1000)});
    if (!checked.ok) return bad(c, checked.errors.map((e) => e.message).join('。'), 400, {errors: checked.errors});
    try {
      await addChoiceVersion(db, identity.org_id, checked.value, {createdBy: identity.user_id});
    } catch (error) {
      return bad(c, 'ほかの画面が先に締めを変えました。読み直してからもう一度押してください', 409);
    }
    return c.json({ok: true, closedMonth: target.value, versionNo: checked.value.previousVersionNo + 1}, 201);
  });

  // 締めの記録（締めた月の版の履歴。根拠に締め・戻しと理由が入っている）
  app.get('/api/revenue/yojitsu/folder/closes', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '予実は財務の画面です（制作担当は見られません）', 403);
    return c.json({ok: true, closes: await readClosedMonthHistory(db, identity.org_id)});
  });
}
