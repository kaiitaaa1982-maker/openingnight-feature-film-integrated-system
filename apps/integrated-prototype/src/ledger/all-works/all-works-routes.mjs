// 全案件の受け口。作品を選ばずに、見てよい全作品の行（日々スケ・経費・台本）を1つの表の形で返す。
// - GET /api/works/activity?work_id=&kind=&from=&to=&limit=&offset=
//   work_id・kind は重ねても、カンマで区切ってもよい。新しい日付が上。limit は既定100・上限200、続きは nextOffset で読む
// - 権限: 作品の案件に所属する人（管理者は組織の全案件）。経費は財務の権限がある案件だけ（制作担当には出さない）。
//   見てよくない作品を work_id に書いても、行を出さず、有無も見せない。組織は identity の org_id だけ
import {readVisibleWorks, readScheduleRows, readExpenseRows, readScriptRows, countUnconfirmedScripts} from './all-works-store.mjs';
import {parseActivityQuery, activityRows, pageActivity, ActivityQueryError, ACTIVITY_KINDS, ACTIVITY_KIND_LABELS} from './all-works-model.mjs';

// 日本時間の今日（撮影日の状態に使う）
const todayInJapan = (now) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function registerAllWorksRoutes(app, {db, bad, permittedProjectScope, now = () => new Date()}) {
  app.get('/api/works/activity', async (c) => {
    const identity = c.get('identity');
    let query;
    try {
      query = parseActivityQuery({work_id: c.req.queries('work_id'), kind: c.req.queries('kind'), from: c.req.query('from'), to: c.req.query('to'),
        limit: c.req.query('limit'), offset: c.req.query('offset')});
    } catch (error) {
      if (error instanceof ActivityQueryError) return bad(c, error.message, 400);
      throw error;
    }
    const orgId = identity.org_id;
    const scope = permittedProjectScope(identity);
    const finance = identity.role === 'production' ? null : permittedProjectScope(identity, true);
    const filter = {workIds: query.workIds, from: query.from, to: query.to};
    const take = query.offset + query.limit + 1;
    const wants = (kind) => query.kinds.includes(kind);
    const [works, schedule, expenses, scripts, attention] = await Promise.all([
      readVisibleWorks(db, orgId, scope),
      wants('schedule') ? readScheduleRows(db, orgId, scope, filter, take) : [],
      wants('expense') && finance ? readExpenseRows(db, orgId, scope, finance, filter, take) : [],
      wants('script') ? readScriptRows(db, orgId, scope, filter, take) : [],
      wants('script') ? countUnconfirmedScripts(db, orgId, scope, filter) : 0,
    ]);
    const today = todayInJapan(now());
    const visible = works.map((work) => ({id: Number(work.id), code: work.code, title: work.title}));
    const page = pageActivity(activityRows({schedule, expenses, scripts, works: visible, today}), query);
    const kinds = ACTIVITY_KINDS.filter((kind) => kind !== 'expense' || finance).map((id) => ({id, label: ACTIVITY_KIND_LABELS[id]}));
    return c.json({ok: true, today, works: visible, kinds, attention, limit: query.limit, offset: query.offset, ...page});
  });
}
