// 作品と商品マスタの入力契約。金額・空欄・根拠を黙って補完しない。

export const WORK_FIELDS = {
  series:'シリーズ', label:'レーベル', production_category:'製作区分', registration_state:'登録状態', work_kind:'作品の種別', internal_notes:'社内メモ', other1:'その他1（意味未確認）', other2:'その他2（意味未確認）',
  lead_distribution_class:'主となる流通区分', cycle_boundary_date:'サイクル境界日（原文）', active_flag:'有効状態（原文）',
  overseas_sales_rights:'海外販売権（確認内容）', distribution_rights:'配給権（確認内容）', primary_use:'一次利用', secondary_use:'二次利用', copyright_royalty_notes:'著作権ロイヤリティ注記',
  director_copyright_royalty_status:'監督の権利処理状態', screenplay_copyright_royalty_status:'脚本の権利処理状態', original_work_copyright_royalty_status:'原作の権利処理状態', music_copyright_royalty_status:'音楽の権利処理状態', producer_royalty_status:'プロデューサーの権利処理状態',
  video_quality_subtitle_dubbing:'画質・字幕・吹替（作品共通）', dubbing_availability:'吹替の有無', music_copyright_society_registration:'音楽管理団体の登録（確認内容）',
};
export const MONEY_FIELDS = {production_cost:'総製作費（宣伝費を含まない）', promotion_budget:'宣伝費の予算', own_investment:'自社の出資額（税別）', sales_rights_purchase:'販売権の購入費'};
export const TAX_LABELS = {unknown:'税区分未確認', ex_tax:'税別', inc_tax:'税込'};
export const STATUS_LABELS = {unknown:'未確認', estimated:'見込み', confirmed:'確定'};
export const CONTRACT_TYPES = {acquisition:'権利の取得',investment:'出資',production:'製作委託',distribution:'配給委託',other:'その他'};
export function textValue(value, max=2000, required=false) {
  if (value != null && typeof value !== 'string') throw Error('文字列を入力してください');
  const text=(value ?? '').trim();
  if (text.length>max || (required && !text)) throw Error('必須項目・文字数を確認してください');
  return text || null;
}
export function numberValue(value, min=0, max=1_000_000_000_000) {
  if (value == null || value === '') return null;
  if (typeof value==='boolean' || !['string','number'].includes(typeof value) || (typeof value==='string' && !/^\d+$/.test(value))) throw Error('整数を入力してください');
  const n=Number(value);
  if (!Number.isSafeInteger(n) || n<min || n>max) throw Error('数値の範囲を確認してください');
  return n;
}
export function dateValue(value) {
  const s=textValue(value,10); if (s===null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10)!==s) throw Error('日付を確認してください');
  return s;
}
export function enumValue(value, labels, fallback) {
  const v=value ?? fallback;
  if (!Object.hasOwn(labels,v)) throw Error('区分を確認してください');
  return v;
}
export function baseInput(b) {
  const base=numberValue(b.baseRevision,0,1000000);
  if (base===null) throw Error('現在の版が必要です');
  return {base, revision:base+1, source_reference:textValue(b.source_reference,1000,true), reason:textValue(b.reason,1000,true)};
}
export function normalizeProfile(b) {
  const out=Object.fromEntries(Object.keys(WORK_FIELDS).map(k=>[k,textValue(b[k])]));
  out.registration_state=enumValue(b.registration_state,{unconfirmed:1,provisional:1,confirmed:1},'unconfirmed');
  out.work_kind=enumValue(b.work_kind,{work:1,aggregate:1,unresolved:1},'work');
  return out;
}
export function normalizeMoney(b, key) {
  const yen=numberValue(b[key+'_yen']);
  const tax=enumValue(b[key+'_tax_basis'],TAX_LABELS,key==='own_investment'?'ex_tax':'unknown');
  const status=enumValue(b[key+'_status'],STATUS_LABELS,'unknown');
  const asOf=dateValue(b[key+'_as_of']), evidence=textValue(b[key+'_evidence'],1000);
  if ((yen===null)!==(status==='unknown')) throw Error('未確認の金額は空欄、金額がある場合は見込みか確定を選んでください');
  if (yen!==null && (!asOf || !evidence)) throw Error('金額の評価日と根拠が必要です');
  if (key==='own_investment' && tax!=='ex_tax') throw Error('自社の出資額は税別です');
  return {[key+'_yen']:yen,[key+'_tax_basis']:tax,[key+'_status']:status,[key+'_as_of']:asOf,[key+'_evidence']:evidence};
}
export function normalizeFinance(b) {
  const out={committee_term_version_id:numberValue(b.committee_term_version_id,1)};
  for(const key of Object.keys(MONEY_FIELDS)) Object.assign(out,normalizeMoney(b,key));
  if(out.committee_term_version_id && (out.production_cost_yen!==null || out.own_investment_yen!==null)) throw Error('委員会の製作費・出資額は条件版を参照し、ここには複写しません');
  return out;
}
export function arrayValue(value,max=80) {if (!Array.isArray(value) || value.length>max) throw Error(`行数は${max}行以内です`);return value;}
export function normalizeRights(b) {
  return arrayValue(b.rows).map((r,position)=>{
    const partner_id=numberValue(r.partner_id,1), name=textValue(r.name,200);
    if (!partner_id && !name) throw Error('権利元の取引先か名前が必要です');
    return {position,partner_id,name,role:textValue(r.role,100,true),rights_scope:textValue(r.rights_scope,1000),notes:textValue(r.notes,2000),evidence:textValue(r.evidence,1000,true)};
  });
}
export function normalizeContracts(b) {
  const rows=arrayValue(b.rows).map((r,position)=>{
    const contract_key=textValue(r.contract_key,80,true);
    if (!/^[\w-]+$/.test(contract_key)) throw Error('契約キーの形式を確認してください');
    const out={contract_key,position,kind:enumValue(r.kind,CONTRACT_TYPES),signed_on:dateValue(r.signed_on),starts_on:dateValue(r.starts_on),ends_on:dateValue(r.ends_on),partner_id:numberValue(r.partner_id,1),document_reference:textValue(r.document_reference,1000,true),title:textValue(r.title,200,true)};
    if (out.starts_on && out.ends_on && out.starts_on>out.ends_on) throw Error('契約の期間を確認してください');
    if (!out.partner_id) throw Error('契約の相手を選んでください');
    return out;
  });
  if (new Set(rows.map(r=>r.contract_key)).size!==rows.length) throw Error('契約が重複しています');
  return rows;
}
export function financeTotals(finance, expenses=[], reference=null) {
  const promotion=expenses.filter(e=>e.expense_system_key==='promotion');
  const actual_ex_tax=promotion.reduce((n,e)=>n+e.actual_ex_tax,0), actual_inc_tax=promotion.reduce((n,e)=>n+e.actual_inc_tax,0);
  const production=reference?reference.production_cost_yen:finance?.production_cost_yen;
  const productionTax=reference?'unknown':finance?.production_cost_tax_basis;
  const budget=finance?.promotion_budget_yen, tax=finance?.promotion_budget_tax_basis;
  const actual=tax==='ex_tax'?actual_ex_tax:tax==='inc_tax'?actual_inc_tax:null;
  return {total_project_cost_yen:production!=null && budget!=null && productionTax===tax && tax!=='unknown'?production+budget:null,
    total_project_cost_tax_basis:productionTax===tax?tax:'unknown', promotion_actual_ex_tax:actual_ex_tax,promotion_actual_inc_tax:actual_inc_tax,promotion_expense_count:promotion.length,
    promotion_budget_remaining_yen:budget!=null && actual!==null?budget-actual:null};
}
