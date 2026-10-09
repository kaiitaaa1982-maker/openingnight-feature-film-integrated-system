// 作品横断の営業パイプライン（GET /api/sales-pipeline）と、その判定の純関数。
// - 段階別の件数と見込額、次の行動の期限、納期超過、期限後に提出した納品（遅延提出（n日））を数える。
// - 対象は財務（営業）権限のある作品だけ。制作担当は 403。組織の外のデータは読まない。
// - 画面（SalesOperations・PipelineBoard）も同じ純関数で判定する。node:* を import しない（Worker でも動く）。
import {allIn} from '../sql-in.mjs';
import {integer, isoDate} from '../csv.mjs';
import {labelOf} from '../ui/labels.mjs';
import {dateJst} from '../ui/format.mjs';

export const STAGE_ORDER = Object.freeze(['lead', 'proposal', 'negotiation', 'won', 'lost']);
export const OPEN_STAGES = Object.freeze(['lead', 'proposal', 'negotiation']);
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// 日本時間の今日（YYYY-MM-DD）。
export function todayJst(now = Date.now()) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// to − from の日数（どちらも YYYY-MM-DD の暦日）。形式が違えば null。
export function daysBetween(from, to) {
  const a = DATE_RE.exec(String(from ?? ''));
  const b = DATE_RE.exec(String(to ?? ''));
  if (!a || !b) return null;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / DAY_MS);
}

// 納品項目の判定。提出日があれば提出日と期限で、無ければ判定日と期限で決める。
// 返り値: {code, label, tone: ok|warn|bad|info, days, overdue, late, future}
// 判定日より後の提出日は、その判定日の時点では未提出として判定する（future の印は残し、画面で日付の確認を促す）
export function deliverableTiming(row, asOf) {
  const futureSubmit = Boolean(row?.submitted_on && asOf && row.submitted_on > asOf);
  const result = timingAt(row, asOf);
  return futureSubmit ? {...result, future: true} : result;
}

function timingAt(row, asOf) {
  const due = row?.due_on || null;
  // 判定日より後の提出は、判定日の時点ではまだ提出されていない（過去の判定日で見たときに、後の事実を混ぜない）
  const submittedRaw = row?.submitted_on || null;
  const submitted = submittedRaw && !(asOf && submittedRaw > asOf) ? submittedRaw : null;
  const blocked = row?.status === 'blocked';
  if (submitted) {
    const future = false;
    if (due && submitted > due) {
      const days = daysBetween(due, submitted);
      return {code: 'late_submitted', label: `遅延提出（${days}日）`, tone: 'warn', days, overdue: false, late: true, future};
    }
    return {code: 'submitted', label: due ? '期限内に提出' : '提出済み（期限未設定）', tone: 'ok', days: 0, overdue: false, late: false, future};
  }
  if (!due) {
    return blocked
      ? {code: 'blocked', label: '保留中（期限未設定）', tone: 'warn', days: null, overdue: false, late: false, future: false}
      : {code: 'no_due', label: '期限未設定', tone: 'info', days: null, overdue: false, late: false, future: false};
  }
  const left = daysBetween(asOf, due);
  if (left === null) return {code: 'unknown', label: '判定できません（日付を確認）', tone: 'warn', days: null, overdue: false, late: false, future: false};
  if (left < 0) return {code: 'overdue', label: `納期超過（${-left}日）${blocked ? '・保留中' : ''}`, tone: 'bad', days: -left, overdue: true, late: false, future: false};
  if (left === 0) return {code: 'due_today', label: `本日が期限${blocked ? '・保留中' : ''}`, tone: 'warn', days: 0, overdue: false, late: false, future: false};
  if (blocked) return {code: 'blocked', label: `保留中（期限まで${left}日）`, tone: 'warn', days: left, overdue: false, late: false, future: false};
  return {code: left <= 7 ? 'due_soon' : 'upcoming', label: `期限まで${left}日`, tone: left <= 7 ? 'warn' : 'info', days: left, overdue: false, late: false, future: false};
}

// 実績日（提出日・受領日・活動日など）が今日より後なら警告を返す。保存は止めない（入力時に知らせるだけ）。
export function futureDateWarnings(values, today, fields = [['submittedOn', '提出日'], ['acceptedOn', '受領日']]) {
  return fields
    .filter(([key]) => DATE_RE.test(String(values?.[key] ?? '')) && values[key] > today)
    .map(([key, label]) => ({field: key, message: `${label}（${dateJst(values[key])}）が今日（${dateJst(today)}）より後の日付です。実績は起きた日を入れてください。予定の日は期限の欄に入れます。`}));
}

// 納品項目の入力の確認（サーバーの検証と同じ規則を、保存前に項目の直下へ出すため）。{項目名: 理由}
export function deliverableFormErrors(values = {}) {
  const errors = {};
  if (!values.agreementId) errors.agreementId = '契約を選んでください';
  if (!values.termVersionId) errors.termVersionId = '条件版を選んでください';
  if (!String(values.title ?? '').trim()) errors.title = '納品物を入力してください';
  const status = values.status || 'pending';
  if (['submitted', 'accepted'].includes(status) && !values.submittedOn) errors.submittedOn = '提出済み・受領済みには提出日が必要です';
  if (status === 'accepted' && !values.acceptedOn) errors.acceptedOn = '受領済みには受領日が必要です';
  if (values.acceptedOn && !values.submittedOn && !errors.submittedOn) errors.submittedOn = '受領日を入れるときは提出日も入れてください';
  if (values.acceptedOn && values.submittedOn && values.acceptedOn < values.submittedOn) errors.acceptedOn = '受領日は提出日以後にしてください';
  return errors;
}

// 次の行動の期限の状況。
export function nextActionState(nextDueOn, nextAction, asOf) {
  if (!nextDueOn) {
    return nextAction
      ? {code: 'no_due', label: '期限未設定', tone: 'info', days: null, overdue: false}
      : {code: 'none', label: '次の行動なし', tone: 'info', days: null, overdue: false};
  }
  const left = daysBetween(asOf, nextDueOn);
  if (left === null) return {code: 'unknown', label: '判定できません', tone: 'warn', days: null, overdue: false};
  if (left < 0) return {code: 'overdue', label: `期限切れ（${-left}日）`, tone: 'bad', days: -left, overdue: true};
  if (left === 0) return {code: 'today', label: '本日が期限', tone: 'warn', days: 0, overdue: false};
  return {code: left <= 7 ? 'soon' : 'later', label: `あと${left}日`, tone: left <= 7 ? 'warn' : 'info', days: left, overdue: false};
}

// 営業案件ごとの最新の活動（実施日が新しい順、同じ日は後から登録した方）。
export function latestActivityByOpportunity(activities = []) {
  const out = new Map();
  const sorted = [...activities].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)) || Number(b.id) - Number(a.id));
  for (const row of sorted) if (!out.has(row.opportunity_id)) out.set(row.opportunity_id, row);
  return out;
}

const safeSum = (values) => values.reduce((total, value) => total + Number(value), 0);

// 段階別の件数と見込額。見込が未入力の案件は金額に含めず件数を別に数える。
export function pipelineStages(opportunities = []) {
  return STAGE_ORDER.map((stage) => {
    const rows = opportunities.filter((row) => row.stage === stage);
    const known = rows.filter((row) => row.expected_yen !== null && row.expected_yen !== undefined);
    return {stage, label: labelOf('opportunityStage', stage), count: rows.length, expectedYen: safeSum(known.map((row) => row.expected_yen)), unknownCount: rows.length - known.length};
  });
}

// 一覧の集計。opportunities は next（nextActionState）、deliverables は timing（deliverableTiming）を持つこと。
export function summarizePipeline({opportunities = [], deliverables = []} = {}) {
  const stages = pipelineStages(opportunities);
  const open = stages.filter((row) => OPEN_STAGES.includes(row.stage));
  const won = stages.find((row) => row.stage === 'won');
  return {
    stages,
    open: {count: safeSum(open.map((row) => row.count)), expectedYen: safeSum(open.map((row) => row.expectedYen)), unknownCount: safeSum(open.map((row) => row.unknownCount))},
    won: {count: won.count, expectedYen: won.expectedYen, unknownCount: won.unknownCount},
    nextActionOverdue: opportunities.filter((row) => row.stage !== 'lost' && row.next?.overdue).length,
    deliverableCount: deliverables.length,
    deliverableOverdue: deliverables.filter((row) => row.timing?.overdue).length,
    lateSubmitted: deliverables.filter((row) => row.timing?.late).length,
  };
}

// 条件版の表示名「第n版（版の名称）」。版の名称が「第n版」と同じなら重ねない。
export function termVersionLabel(term) {
  if (!term) return null;
  const base = `第${term.version_no}版`;
  const label = String(term.version_label || '').trim();
  return label && label !== base ? `${base}（${label}）` : base;
}

// 取得した行に判定を付けて、画面と出力で使う形にする（純関数）。
export function buildPipeline({works = [], opportunities = [], activities = [], agreements = [], terms = [], deliverables = [], asOf}) {
  const workTitle = new Map(works.map((work) => [work.id, work.title]));
  const latest = latestActivityByOpportunity(activities);
  const opportunityRows = opportunities.map((row) => {
    const last = latest.get(row.id);
    const next = nextActionState(last?.next_due_on || null, last?.next_action || null, asOf);
    return {
      ...row,
      work_title: workTitle.get(row.work_id) || '未確認',
      stage_label: labelOf('opportunityStage', row.stage),
      last_activity_on: last?.occurred_on || null,
      last_activity_summary: last?.summary || null,
      next_action: last?.next_action || null,
      next_due_on: last?.next_due_on || null,
      next,
    };
  });
  const agreementById = new Map(agreements.map((row) => [row.id, row]));
  const termById = new Map(terms.map((row) => [row.id, row]));
  const deliverableRows = deliverables.map((row) => {
    const agreement = agreementById.get(row.agreement_id);
    const term = termById.get(row.term_version_id);
    return {
      ...row,
      work_title: workTitle.get(row.work_id) || '未確認',
      contract_code: agreement?.contract_code || null,
      agreement_title: agreement?.title || null,
      partner_name: agreement?.partner_name || null,
      term_label: termVersionLabel(term),
      status_label: labelOf('deliverableStatus', row.status),
      timing: deliverableTiming(row, asOf),
    };
  });
  return {opportunities: opportunityRows, deliverables: deliverableRows, summary: summarizePipeline({opportunities: opportunityRows, deliverables: deliverableRows})};
}

export function registerSalesPipelineRoutes(app, {db, bad, permittedProjects}) {
  app.get('/api/sales-pipeline', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '制作担当は営業の一覧を参照できません', 403);
    let asOf;
    let workId = null;
    try {
      asOf = isoDate(String(c.req.query('asOf') || todayJst()));
      if (c.req.query('workId')) workId = integer(c.req.query('workId'));
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
    const projects = new Set((await permittedProjects(db, i, true)).map((project) => project.id));
    const works = (await db.all('SELECT id,project_id,code,title FROM works WHERE org_id=? ORDER BY id', [i.org_id])).filter((work) => projects.has(work.project_id));
    if (workId && !works.some((work) => work.id === workId)) return bad(c, 'この作品の営業情報を見る権限がありません', 403);
    const scoped = workId ? works.filter((work) => work.id === workId) : works;
    const scopeNote = '営業（財務）の権限がある作品だけを集計しています。商談見込と契約条件の見込は別の数字で、足していません。';
    if (!scoped.length) return c.json({ok: true, asOf, works: [], scopeNote, ...buildPipeline({asOf})});
    // D1 は1問い合わせの値が100個までなので、作品IDは allIn で分けて読む
    const scope = {before: [i.org_id], ids: scoped.map((work) => work.id)};
    const [opportunities, activities, agreements, terms, deliverables] = await Promise.all([
      allIn(db, `SELECT o.id,o.project_id,o.work_id,o.partner_id,o.name,o.stage,o.expected_yen,o.close_date,o.version,p.name AS partner_name
        FROM sales_opportunities o JOIN partners p ON p.org_id=o.org_id AND p.id=o.partner_id WHERE o.org_id=? AND o.work_id IN (:in) ORDER BY o.id`, {...scope, sortBy: (x, y) => x.id - y.id}),
      allIn(db, `SELECT id,opportunity_id,work_id,occurred_on,activity_type,summary,next_action,next_due_on FROM sales_activities WHERE org_id=? AND work_id IN (:in)`, scope),
      allIn(db, `SELECT a.id,a.work_id,a.contract_code,a.title,a.partner_id,p.name AS partner_name
        FROM sales_agreements a JOIN partners p ON p.org_id=a.org_id AND p.id=a.partner_id WHERE a.org_id=? AND a.work_id IN (:in)`, scope),
      allIn(db, `SELECT v.id,v.agreement_id,v.version_no,v.version_label,v.expected_amount_yen FROM sales_agreement_term_versions v
        JOIN sales_agreements a ON a.org_id=v.org_id AND a.id=v.agreement_id WHERE v.org_id=? AND a.work_id IN (:in)`, scope),
      allIn(db, `SELECT id,work_id,agreement_id,term_version_id,title,due_on,status,submitted_on,accepted_on,note,version
        FROM sales_deliverables WHERE org_id=? AND work_id IN (:in) ORDER BY due_on,id`, {...scope, sortBy: (x, y) => String(x.due_on ?? '').localeCompare(String(y.due_on ?? '')) || x.id - y.id}),
    ]);
    const built = buildPipeline({works: scoped, opportunities, activities, agreements, terms, deliverables, asOf});
    return c.json({ok: true, asOf, works: scoped.map(({id, code, title}) => ({id, code, title})), scopeNote, ...built});
  });
}
