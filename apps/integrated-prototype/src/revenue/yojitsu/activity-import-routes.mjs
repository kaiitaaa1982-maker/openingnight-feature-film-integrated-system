// 既存の営業の活動（sales_activities。作品の商談ごとの営業の行動）を活動記録（フェーズ1 #13）へ取り込む受け口（行動指標の計画 段B #10。
// 要件 FR-REV-KPI-020・FR-REV-YOJITSU-035）。
//   POST /api/revenue/activity-imports/sales-activities   本文なし。組織の営業の活動のうち、まだ取り込んでいない行を足し、件数だけを返す
// - 権限: 組織の管理者だけ（取り込んだ行の記録した人は元の行を記録した人にするので、ほかの人の名前で行を足すことになる）。ほかの役割は 403
// - 何度流しても増えない（元の行の id で1回だけ。K2-15）。足す行が1つでもあれば 201、取り込み済みだけなら 200
// - 応答は件数と元の行の id だけで、行の中身（相手・したこと・次の一手）を返さない（行は記録した人の本人にだけ見せる。FR-REV-YOJITSU-037）
// - 種別とステップの対応は activity-import-model。結果は営業活動の明示欄を使い、未記録なら取り込まない。必要な細目の段が無ければ、何も足さずに 409
// - 同時に2つ流して後の側が一意の違反で落ちたら 409（もう一度流せば残りを足す）
import {listActionSteps} from '../../planning/planning-store.mjs';
import {importActivityRecords, readSalesActivityImportRows, readActivityOutcomeRows} from '../revenue-store.mjs';
import {planSalesActivityImport} from './activity-import-model.mjs';
import {dbErrorKind} from '../../data-platform/db-errors.mjs';
import {activityOutcomeSummary} from './activity-outcomes-model.mjs';
import {isCalendarDate} from '../../planning/project/project-model.mjs';

export function registerActivityImportRoutes(app, {db, bad, permittedProjectScope}) {
  if (!app || !db || typeof bad !== 'function' || typeof permittedProjectScope !== 'function') {
    throw new Error('activity import routes require app, db, bad and permittedProjectScope');
  }

  app.get('/api/revenue/activity-results', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '活動結果の集計は財務の画面です', 403);
    const from = c.req.query('from') || null;
    const to = c.req.query('to') || null;
    if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to)) || (from && to && from > to)) return bad(c, '期間は暦にある日付を開始日から終了日の順で指定してください', 400);
    const [rows, steps] = await Promise.all([
      readActivityOutcomeRows(db, identity.org_id, {scope: permittedProjectScope(identity, true)}), listActionSteps(db),
    ]);
    return c.json({ok: true, from, to, definition: '同じ案件・稼ぎ方・親の段の期間内の最新結果。進んだ÷（進んだ＋保留＋失注）。未記録は除外',
      ...activityOutcomeSummary(rows, {steps, from, to})});
  });

  app.post('/api/revenue/activity-imports/sales-activities', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role !== 'admin') return bad(c, '営業の活動の取り込みは組織の管理者だけが行えます（記録した人の名前で活動記録を足すため）', 403);
    const [rows, steps] = await Promise.all([
      readSalesActivityImportRows(db, identity.org_id, {scope: permittedProjectScope(identity, true)}),
      listActionSteps(db),
    ]);
    const plan = planSalesActivityImport(rows, {steps});
    if (plan.errors.length) return bad(c, '細目の段が参照表に無いので取り込めません（何も足していません）', 409, {errors: plan.errors, summary: plan.summary});
    try {
      await importActivityRecords(db, identity.org_id, plan.records, {importedBy: identity.user_id});
    } catch (error) {
      if (dbErrorKind(error) === 'unique') return bad(c, 'ほかの取り込みと重なりました。もう一度流すと残りの行を足します', 409, undefined, error);
      throw error;
    }
    return c.json({ok: true, ...plan.summary}, plan.records.length ? 201 : 200);
  });
}
