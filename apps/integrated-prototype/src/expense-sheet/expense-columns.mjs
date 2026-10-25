// 経費集計シートの列の唯一の定義（会社ルートの plans/2026-10-09-sheet-columns-by-grain.md の経費の対応表。裁定5 (b)・モック案A）。
// 1列＝1要素 {key, label, position, aliases, type, source, group, sets}。
// - position は基本33列の位置（1〜33）。列セットに入るだけの列は null。様式は position の切り方だけで決まる
//   （legacy22＝1〜22、standard25＝1〜25、standard33＝1〜33）。#1〜25 は統合前の25列と同じ位置、#26〜33 は足した8列
// - aliases は旧22・25列の雛形の見出し。取込は位置ごとに label か aliases に完全一致する見出しを受け、旧22列の書き出し・雛形はこの見出しで出す
// - type は値の型（text・yen・number・date）。source は最新の唯一の情報（表.列か計算）
// - sets は位置で決まらない列セット（accounting・payout）での並び順
// sheetColumns（sheet-model.mjs）・雛形と書き出しと取込の対応づけ（expense-workbook.mjs・import-service.mjs）・訂正欄（ExpenseImports.jsx）・
// 出金予定の明細（ExpensePayout.jsx）はこの定義から作る。33列の様式（standard33）の取込と雛形は、取込の表を足す移行（香盤表 #4c）のあとで受ける
export const EXPENSE_COLUMN_VERSION='req6-v1';
const det='expense_details',acc='expense_accounting_versions（最新版）',inv='expense_invoice_versions（最新版）';
const col=(key,label,position,aliases,type,source,group,sets={})=>Object.freeze({key,label,position,aliases:Object.freeze(aliases),type,source,group,sets:Object.freeze(sets)});
export const EXPENSE_COLUMNS=Object.freeze([
 col('id','経費ID',1,['ID'],'text','expenses.id','standard25',{accounting:1}),
 col('distribution_name','流通区分',2,['流通名'],'text',`${det}.distribution_type_code→distribution_types.label`,'standard25'),
 col('work_code','作品コード',3,['統一作品ID'],'text','works.code','standard25'),
 col('product_code','商品コード',4,['商品ID'],'text',`products.sku←${det}.product_id`,'standard25'),
 col('product_number','品番（受領表記）',5,['品番'],'text',`${det}.source_product_number`,'standard25'),
 col('product_name','商品名（受領表記）',6,['商品名'],'text',`${det}.source_product_name`,'standard25'),
 col('recorded_on','計上日',7,['計上日（YYYY/MM/DD）'],'date',`${det}.recorded_on`,'standard25'),
 col('client_name','取引先名（受領表記）',8,['取引先名'],'text',`${det}.source_client_name`,'standard25'),
 col('specification','仕様',9,[],'text',`${det}.specification`,'standard25'),
 col('description','請求項目',10,[],'text','expenses.description','standard25'),
 col('quantity','数量',11,[],'number',`${det}.quantity_x10000÷10000`,'standard25'),
 col('unit_price','単価（税別）',12,['単価'],'number',`${det}.unit_price_x10000÷10000`,'standard25'),
 col('actual_ex_tax','金額（税別）',13,['金額(税別)'],'yen','expenses.actual_ex_tax','standard25'),
 col('tax_amount','消費税額',14,['消費税(自動)'],'yen','expenses.tax_amount','standard25'),
 col('withholding_yen','源泉徴収税額（控除）',15,['源泉徴収税額'],'yen',`${acc}.withholding_yen`,'standard25',{accounting:6}),
 col('payable_yen','差引支払額（税込）',16,['金額(税込)'],'yen','expenses.actual_inc_tax−源泉（源泉未確認なら空）','standard25'),
 col('supplier_text','発注先（受領表記）',17,['発注先'],'text',`${det}.supplier_text`,'standard25'),
 col('invoice_on','請求日',18,[],'date',`${inv}.invoice_on`,'standard25'),
 col('memo','メモ',19,[],'text',`${det}.memo`,'standard25'),
 col('partner_code','支払先コード',20,['仕入先ID'],'text','partners.code←expense_invoices.partner_id','standard25',{payout:1}),
 col('account_name','勘定科目',21,[],'text',`gl_accounts.name←gl_account_class_versions←expense_category_versions←${acc}`,'standard25',{accounting:3}),
 col('category_name','費用区分',22,[],'text',`expense_category_versions.name←${acc}`,'standard25',{accounting:2}),
 col('closing_on','締め日',23,[],'date',`${inv}.closing_on`,'standard25',{payout:3}),
 col('due_on','出金予定日',24,[],'date',`${inv}.due_on`,'standard25',{payout:4}),
 col('paid_on','出金日',25,[],'date','expense_payments（基準日現在の有効な出金の最後の日）','standard25',{payout:5}),
 col('amount_inc_tax','明細の税込額',26,[],'yen','expenses.actual_inc_tax（行の税込額。請求書の総額ではない）','added'),
 col('cash_paid_yen','出金済額',27,[],'yen','expense_payments.amount_yen の合計（基準日まで）','added'),
 col('incurred_on','発生日',28,[],'date','expenses.incurred_on','added'),
 col('project_code','案件コード',29,[],'text','projects.code←expenses.project_id','added'),
 col('tax_name','税区分',30,[],'text',`expense_tax_category_versions.name←${acc}`,'added',{accounting:4}),
 col('withholding_name','源泉区分',31,[],'text',`expense_withholding_category_versions.name←${acc}`,'added',{accounting:5}),
 col('invoice_number','請求書番号',32,[],'text',`${inv}.invoice_number`,'added'),
 col('document_kind','証憑種別',33,[],'text',`${inv}.document_kind（invoice・receipt・credit_note・other）`,'added'),
 col('status','状態',null,[],'text','会計の版・源泉の確認・出金から導く（EXPENSE_STATUS）','set_only',{accounting:7}),
 col('partner_name','支払先',null,[],'text','partners.name','set_only',{payout:2}),
 col('cash_due_yen','支払残額',null,[],'yen','明細の税込額−源泉−出金済額（源泉未確認なら空）','set_only',{payout:6}),
]);
export const EXPENSE_COLUMN_GROUPS=Object.freeze({standard25:'標準25列',added:'追加8列',set_only:'列セットだけの列'});
// 様式（位置の切り方）。取込は legacy22・standard25 を受ける。standard33 の取込・雛形は香盤表 #4c（新しい取込の表）で足す
export const EXPENSE_LAYOUTS=Object.freeze({legacy22:22,standard25:25,standard33:33});
export const IMPORT_LAYOUTS=Object.freeze(['legacy22','standard25']);
export const EXPENSE_SET_NAMES=Object.freeze([...Object.keys(EXPENSE_LAYOUTS),'accounting','payout']);
// URL・保存した画面の別名（basic＝standard33、legacy＝legacy22）
export const EXPENSE_SET_ALIASES=Object.freeze({basic:'standard33',legacy:'legacy22'});
// 書き出しで源泉を負（控除）で出す列セット。取込の境界も3様式とも負で受ける
export const NEGATIVE_WITHHOLDING_SETS=Object.freeze(Object.keys(EXPENSE_LAYOUTS));
export const EXPENSE_SHEET_NAME='経費集計';
export const EXPENSE_SHEET_ALIASES=Object.freeze(['経費入力']);
// 経費の状態（一覧・出金予定・絞り込みの語彙）
export const EXPENSE_STATUS=Object.freeze({unready:'未整備',unpaid:'未払い',partial:'一部払い',paid:'払い済み',withholding:'源泉未確認'});
export const EXPENSE_STATUSES=Object.freeze(Object.values(EXPENSE_STATUS));
export const DOCUMENT_KIND_LABELS=Object.freeze({invoice:'請求書',receipt:'領収書',credit_note:'減額証憑',other:'その他'});

const byKey=new Map(EXPENSE_COLUMNS.map(c=>[c.key,c])),byPosition=new Map(EXPENSE_COLUMNS.filter(c=>c.position).map(c=>[c.position,c]));
export const expenseColumn=key=>{const c=byKey.get(key);if(!c)throw Error('経費の列の定義にないキーです: '+key);return c;};
export const columnAt=position=>byPosition.get(position)??null;
// 原行・訂正値（位置の配列）の添字。key で読む
export const cellIndex=key=>{const c=expenseColumn(key);if(!c.position)throw Error('位置を持たない列です: '+key);return c.position-1;};
export const resolveExpenseSet=name=>Object.hasOwn(EXPENSE_SET_ALIASES,name)?EXPENSE_SET_ALIASES[name]:EXPENSE_SET_NAMES.includes(name)?name:null;
export function expenseColumnsOfSet(name){const set=resolveExpenseSet(name);if(!set)return null;
 if(Object.hasOwn(EXPENSE_LAYOUTS,set))return EXPENSE_COLUMNS.filter(c=>c.position&&c.position<=EXPENSE_LAYOUTS[set]).sort((a,b)=>a.position-b.position);
 return EXPENSE_COLUMNS.filter(c=>c.sets[set]).sort((a,b)=>a.sets[set]-b.sets[set]);}
// 見出し。旧22列（legacy22）は旧見出しで出す（旧22列の互換。取込は位置ごとに新しい見出しも別名も受ける）
export const expenseHeading=(c,set)=>resolveExpenseSet(set)==='legacy22'?(c.aliases[0]??c.label):c.label;
// 一覧・書き出しの列 {key,label,type}。日付は ISO の文字のまま出す（Excel の日付にしない。雛形だけ date で書く）
export const expenseGridColumn=(c,set='standard33')=>({key:c.key,label:expenseHeading(c,set),type:c.type==='date'?'text':c.type});
// 列セットに無い並び（出金予定の明細など）も、見出しと型は同じ定義から作る
export const expenseGridColumns=keys=>keys.map(key=>expenseGridColumn(expenseColumn(key)));
export const acceptsHeading=(position,heading)=>{const c=columnAt(position);return !!c&&(heading===c.label||c.aliases.includes(heading));};
export const EXPENSE_COLUMN_SETS=Object.freeze(Object.fromEntries([...EXPENSE_SET_NAMES,...Object.keys(EXPENSE_SET_ALIASES)].map(name=>[name,Object.freeze(expenseColumnsOfSet(name).map(c=>expenseHeading(c,name)))])));
