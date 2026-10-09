// 全集計の経費読取口。通常は取消済みを除外。帳簿は元行と取消日を読み、取消月に反対額を出す。
// asOf はISO日付のみ。組織の条件は呼出側のSQLでも必須。
export function expenseSource({history=false,asOf='9999-12-31'}={}) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf))throw Error('経費の基準日を確認してください');
 const voidOn=`(SELECT MIN(v.on_day) FROM (
 SELECT org_id,expense_id,voided_on on_day FROM expense_line_voids
 UNION ALL SELECT c.org_id,c.expense_id,ev.occurred_on FROM expense_import_row_commits c
 JOIN expense_import_rows r ON r.org_id=c.org_id AND r.id=c.row_id
 JOIN expense_import_events ev ON ev.org_id=r.org_id AND ev.batch_id=r.batch_id AND ev.kind='cancelled'
 ) v WHERE v.org_id=e.org_id AND v.expense_id=e.id)`;
 return `(SELECT e.*,${voidOn} AS expense_voided_on FROM expenses e
 ${history?'':`WHERE (${voidOn} IS NULL OR ${voidOn}>'${asOf}')`})`;
}

export const normalizedExpenseCategory=value=>String(value??'').normalize('NFKC').trim();
export async function resolveExpenseAccounts(db,orgId,rows){
 const [versions,aliases,categories]=await Promise.all([
  db.all('SELECT * FROM expense_accounting_versions WHERE org_id=? ORDER BY version_no',[orgId]),
  db.all('SELECT * FROM expense_category_alias_versions WHERE org_id=? ORDER BY version_no',[orgId]),
  db.all(`SELECT k.*,g.id account_id,g.name account_name,g.section,g.system_key FROM expense_category_versions k
   JOIN gl_account_class_versions cl ON cl.org_id=k.org_id AND cl.id=k.account_class_version_id
   JOIN gl_accounts g ON g.org_id=cl.org_id AND g.id=cl.account_id WHERE k.org_id=?`,[orgId])
 ]);
 const byExpense=new Map(versions.map(v=>[v.expense_id,v])),byAlias=new Map(aliases.map(v=>[v.alias_text,v])),byCategory=new Map(categories.map(v=>[v.id,v]));
 return rows.map(row=>{const a=byExpense.get(Math.abs(row.id)),alias=byAlias.get(normalizedExpenseCategory(row.category));
  const candidate=byCategory.get(a?(a.active?a.category_version_id:null):(alias?.active?alias.category_version_id:null));
  const k=candidate&&['cogs','sga','non_operating_expense','extraordinary_loss','income_tax'].includes(candidate.section)?candidate:null;
  return {...row,expense_account_id:k?.account_id??null,expense_account_name:k?.account_name??null,expense_section:k?.section??null,
   expense_system_key:k?.system_key??null,expense_recognition_timing:k?.recognition_timing??null,
   expense_category_version_id:k?.id??null,expense_classification_origin:k?(a?'明細の会計版':'採用済みの完全一致対応'):'費用区分未整備'};
 });
}
