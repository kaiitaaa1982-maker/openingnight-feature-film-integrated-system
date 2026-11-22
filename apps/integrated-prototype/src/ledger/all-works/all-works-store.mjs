// 全案件の画面の読み取り。見てよい案件（scope）の作品から、撮影日・経費・台本の行を作品を選ばずに読む。
// 撮影日（shooting_days・production_calls）・経費（expenses と請求書・会計の版）・台本の原本（workflow_raw_artifacts）は、
// まだ領域フォルダへ移していない古い形の表なので、ここから直接読む（docs/rules/architecture.md の「ほかの領域の表」）。
// scope・financeScope は受け口が渡す「見てよい案件の問い合わせ」（{sql, params}。案件 ID を値として並べない）。どの読み取りも組織で絞る。
import {expenseSource} from '../../expense-sheet/expense-read.mjs';

// 見てよい作品の問い合わせ（副問い合わせとして IN (...) に入れる）
const visibleWorks = (orgId, scope) => ({sql: `SELECT w.id FROM works w WHERE w.org_id=? AND w.project_id IN (${scope.sql})`, params: [orgId, ...scope.params]});

// 作品・日付の絞り込みの条件。column は作品の列、dateColumn は日付の式
function filters(orgId, scope, {workIds = [], from = null, to = null}, column, dateColumn) {
  const works = visibleWorks(orgId, scope);
  const where = [`${column} IN (${works.sql})`];
  const params = [...works.params];
  if (workIds.length) {
    where.push(`${column} IN (${workIds.map(() => '?').join(',')})`);
    params.push(...workIds);
  }
  if (from) { where.push(`${dateColumn}>=?`); params.push(from); }
  if (to) { where.push(`${dateColumn}<=?`); params.push(to); }
  return {where: where.join(' AND '), params};
}

// 見てよい作品の一覧（画面の作品の札）
export async function readVisibleWorks(db, orgId, scope) {
  return db.all(`SELECT w.id,w.code,w.title FROM works w WHERE w.org_id=? AND w.project_id IN (${scope.sql}) ORDER BY w.code,w.id`, [orgId, ...scope.params]);
}

// 撮影日（日々スケ）。入りの時刻は、その日の出演の入りのうち最も早いもの
export async function readScheduleRows(db, orgId, scope, filter, limit) {
  const f = filters(orgId, scope, filter, 'd.work_id', 'd.shoot_date');
  return db.all(`SELECT d.id,d.work_id,d.shoot_date AS date,d.label,d.unit,
      (SELECT MIN(p.call_time) FROM production_calls p WHERE p.org_id=d.org_id AND p.work_id=d.work_id AND p.day_id=d.id AND p.call_time IS NOT NULL AND p.call_time<>'') AS call_time
    FROM shooting_days d WHERE d.org_id=? AND ${f.where}
    ORDER BY d.shoot_date DESC,d.id DESC LIMIT ?`, [orgId, ...f.params, limit]);
}

// 経費（取消を除く。作品の付いた行だけ）。financeScope は財務の権限がある案件。
// ready は請求書の整備と、最新の会計の版が有効であること（経費集計シートの「未整備」と同じ条件）
export async function readExpenseRows(db, orgId, scope, financeScope, filter, limit) {
  const f = filters(orgId, scope, filter, 'e.work_id', 'e.incurred_on');
  return db.all(`SELECT e.id,e.work_id,e.incurred_on AS date,e.category,e.description,e.actual_inc_tax AS amount,
      CASE WHEN EXISTS (SELECT 1 FROM expense_details x WHERE x.org_id=e.org_id AND x.expense_id=e.id)
        AND EXISTS (SELECT 1 FROM expense_accounting_versions v WHERE v.org_id=e.org_id AND v.expense_id=e.id AND v.active=1
          AND v.version_no=(SELECT MAX(m.version_no) FROM expense_accounting_versions m WHERE m.org_id=v.org_id AND m.expense_id=v.expense_id))
      THEN 1 ELSE 0 END AS ready
    FROM ${expenseSource()} e WHERE e.org_id=? AND e.work_id IS NOT NULL AND e.project_id IN (${financeScope.sql}) AND ${f.where}
    ORDER BY e.incurred_on DESC,e.id DESC LIMIT ?`, [orgId, ...financeScope.params, ...f.params, limit]);
}

const SCRIPT_DATE = 'substr(a.created_at,1,10)';

// 台本の原本。登録した日を日付にし、香盤へ確定したかを返す
export async function readScriptRows(db, orgId, scope, filter, limit) {
  const f = filters(orgId, scope, filter, 'a.work_id', SCRIPT_DATE);
  return db.all(`SELECT a.id,a.work_id,${SCRIPT_DATE} AS date,a.file_name,
      CASE WHEN EXISTS (SELECT 1 FROM workflow_script_commits c WHERE c.org_id=a.org_id AND c.artifact_id=a.id) THEN 1 ELSE 0 END AS committed
    FROM workflow_raw_artifacts a WHERE a.org_id=? AND a.kind='script' AND ${f.where}
    ORDER BY ${SCRIPT_DATE} DESC,a.id DESC LIMIT ?`, [orgId, ...f.params, limit]);
}

// 香盤へ確定していない台本の数（画面の「要確認」の数。ページ送りに関係なく、絞り込みの全体で数える）
export async function countUnconfirmedScripts(db, orgId, scope, filter) {
  const f = filters(orgId, scope, filter, 'a.work_id', SCRIPT_DATE);
  const row = await db.get(`SELECT COUNT(*) AS n FROM workflow_raw_artifacts a WHERE a.org_id=? AND a.kind='script' AND ${f.where}
    AND NOT EXISTS (SELECT 1 FROM workflow_script_commits c WHERE c.org_id=a.org_id AND c.artifact_id=a.id)`, [orgId, ...f.params]);
  return Number(row?.n ?? 0);
}
