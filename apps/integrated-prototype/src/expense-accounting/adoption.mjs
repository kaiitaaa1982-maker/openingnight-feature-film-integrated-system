import {expenseSource,normalizedExpenseCategory} from '../expense-sheet/expense-read.mjs';
import {insert,newId,guard} from '../expense-sheet/expense-service.mjs';
import {fail,str} from '../expense-sheet/expense-model.mjs';

// 旧規則は下見専用。実際のPLの分類には使わない。
export function classifyExpense(category) {
 const text=normalizedExpenseCategory(category);
 if(text.startsWith('制作費'))return 'production_cost';
 if(/^P\s*&\s*A/i.test(text)||/宣伝|広告/.test(text))return 'promotion';
 if(/事務|手数料|管理/.test(text))return 'work_other_expense';
 return 'direct_cost';
}
const definitions={direct_cost:['5200','直接費','cogs','incurred_month'],production_cost:['5300','制作費','cogs','release_month_once'],promotion:['6100','広告宣伝費','sga','incurred_month'],work_other_expense:['6150','その他経費','sga','incurred_month']};
const stampTables=['expenses','expense_line_voids','expense_import_events','expense_category_alias_versions','expense_categories','expense_category_versions','gl_accounts','gl_account_class_versions'];
export async function adoptionPreview(db,org){
 const [source,accounts,classes,aliases,categories]=await Promise.all([
  db.all(`SELECT DISTINCT category FROM ${expenseSource()} WHERE org_id=? ORDER BY category`,[org]),
  db.all('SELECT * FROM gl_accounts WHERE org_id=? ORDER BY id',[org]),
  db.all('SELECT * FROM gl_account_class_versions WHERE org_id=? ORDER BY version_no',[org]),
  db.all('SELECT * FROM expense_category_alias_versions WHERE org_id=? ORDER BY version_no',[org]),
  db.all(`SELECT c.*,v.id category_version_id,v.account_class_version_id,v.recognition_timing,v.active FROM expense_categories c LEFT JOIN expense_category_versions v ON v.org_id=c.org_id AND v.category_id=c.id AND v.version_no=(SELECT MAX(x.version_no) FROM expense_category_versions x WHERE x.org_id=c.org_id AND x.category_id=c.id) WHERE c.org_id=? ORDER BY c.id`,[org])]);
 const latest=new Map(aliases.map(r=>[r.alias_text,r])),classMap=new Map(classes.map(r=>[r.account_id,r]));
 const rows=[...new Set(source.map(r=>normalizedExpenseCategory(r.category)))].sort().map(alias=>{
  const key=classifyExpense(alias),[code,name,section,timing]=definitions[key],found=accounts.filter(a=>a.code===code||a.system_key===key),account=found[0],cl=classMap.get(account?.id),old=latest.get(alias),initial=categories.find(c=>c.code==='R6-INITIAL-'+key);
  const conflict=old?null:!alias?'空の費目は手動で整備してください':found.length>1||account&&(account.system_key!==key||account.section!==section)?'既存の科目と衝突':cl&&(!cl.active||cl.normal_side!=='debit'||cl.balance_class!=='none'||cl.settlement_role)?'既存の科目分類と衝突':initial&&(!initial.active||initial.account_class_version_id!==cl?.id||initial.recognition_timing!==timing)?'同じ初期コードがあります。個別に対応を確認してください':null;
  return {alias,key,code,name,section,timing,accountId:account?.id??null,classId:cl?.id??null,initialCategoryVersionId:initial?.category_version_id??null,adopted:Boolean(old),categoryVersionId:old?.category_version_id??null,conflict};
 });
 const counts=[];for(const t of stampTables)counts.push((await db.get(`SELECT COUNT(*) n FROM ${t} WHERE org_id=?`,[org])).n);
 const raw=JSON.stringify({source,accounts,classes,aliases,categories,counts});
 const token=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
 return {rows,token,counts,conflicts:rows.filter(r=>r.conflict)};
}
export async function adoptExpenseCategories(s,i,b){
 str(b.reason,1000,true);const p=await adoptionPreview(s.db,i.org_id);
 if(b.token!==p.token)fail('下見の後に費目・会計設定が変わりました。もう一度下見してください',409);
 if(p.conflicts.length)fail('既存の科目との衝突を確認してください',409);
 const statements=[],versions=new Map();
 for(const r of p.rows.filter(r=>!r.adopted)){
  if(r.initialCategoryVersionId)versions.set(r.key,r.initialCategoryVersionId);
  if(!versions.has(r.key)){
   const accountId=r.accountId??newId(),classId=r.classId??newId(),categoryId=newId(),versionId=newId();
   if(!r.accountId)statements.push(insert('gl_accounts',{id:accountId,org_id:i.org_id,code:r.code,name:r.name,section:r.section,source:'system',system_key:r.key,cash_effect:0,sort_order:300,created_by:i.user_id}));
   if(!r.classId)statements.push(s.versionGuard(i,'gl_account_class_versions','account_id',accountId,0),insert('gl_account_class_versions',{id:classId,account_id:accountId,version_no:1,normal_side:'debit',balance_class:'none',settlement_role:null,active:1,...s.meta(i,b)}));
   statements.push(insert('expense_categories',{id:categoryId,code:'R6-INITIAL-'+r.key,...s.meta(i,b)}),insert('expense_category_versions',{id:versionId,category_id:categoryId,version_no:1,name:r.name,account_class_version_id:classId,recognition_timing:r.timing,active:1,...s.meta(i,b)}));versions.set(r.key,versionId);
  }
  statements.push(s.versionGuard(i,'expense_category_alias_versions','alias_text',r.alias,0),insert('expense_category_alias_versions',{id:newId(),alias_text:r.alias,version_no:1,category_version_id:versions.get(r.key),active:1,...s.meta(i,b)}),s.audit(i,'expense_category_adoption',r.alias,b));
 }
 if(statements.length){statements.unshift(guard(stampTables.map(t=>`(SELECT COUNT(*) FROM ${t} WHERE org_id=?)<>?`).join(' OR '),p.counts.flatMap(n=>[i.org_id,n])));await s.batch(statements);}
 return {adopted:p.rows.filter(r=>!r.adopted).length,conflicts:[]};
}
