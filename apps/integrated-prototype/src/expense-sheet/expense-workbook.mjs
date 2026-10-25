import {encodeReportXlsx as reportXlsx} from '../xlsx-report.mjs';
import {decodeXlsx} from '../xlsx.mjs';
import {parseCsv,toCsv as csv} from '../csv.mjs';
import {EXPENSE_COLUMN_VERSION,EXPENSE_LAYOUTS,IMPORT_LAYOUTS,EXPENSE_SHEET_NAME,EXPENSE_SHEET_ALIASES,expenseColumnsOfSet,expenseHeading,acceptsHeading,resolveExpenseSet} from './expense-columns.mjs';
import {sheetColumns,negativeWithholding} from './sheet-model.mjs';
import {fail} from './expense-model.mjs';
export const XLSX_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const encodeReportXlsx=sheets=>reportXlsx({sheets});
const toCsv=rows=>csv(rows[0],rows.slice(1));
function csvRows(text){const records=parseCsv(text),headers=Object.keys(records[0].values);return [headers,...records.map(r=>headers.map(h=>r.values[h]))];}
// 雛形を出す様式。33列（standard33）の雛形は取込の表を足す移行（香盤表 #4c）のあと
const templateLayout=layout=>{if(!IMPORT_LAYOUTS.includes(layout))fail('22列または25列の形式を選んでください');return layout;};
export function templateHeaders(layout){return expenseColumnsOfSet(templateLayout(layout)).map(c=>expenseHeading(c,layout));}
// 記入例（架空）。値は列のキーで書き、様式の位置へ並べる
const SAMPLES=[
 {recorded_on:'2026-09-14',client_name:'月末締めの支払先（架空）',description:'DEMO-INVOICE-UNPAID（架空）',quantity:1,unit_price:12000,actual_ex_tax:12000,tax_amount:1200,withholding_yen:0,payable_yen:13200,invoice_on:'2026-09-14',memo:'架空の入力例',partner_code:'DEMO-PARTNER-EOM',category_name:'その他経費（架空）',closing_on:'2026-09-30',due_on:'2026-10-31'},
 {recorded_on:'2026-09-14',client_name:'未登録の支払先（架空）',description:'支払先確認（架空）',quantity:1,unit_price:12000,actual_ex_tax:12000,tax_amount:1200,withholding_yen:0,payable_yen:13200,invoice_on:'2026-09-14',partner_code:'DEMO-MISSING',category_name:'その他経費（架空）',closing_on:'2026-09-30',due_on:'2026-10-31'},
 {recorded_on:'2026-09-14',client_name:'月末締めの支払先（架空）',description:'金額未確認（架空）',invoice_on:'2026-09-14',partner_code:'DEMO-PARTNER-EOM',category_name:'その他経費（架空）',closing_on:'2026-09-30',due_on:'2026-10-31'},
];
export function sampleRows(layout){const columns=expenseColumnsOfSet(templateLayout(layout));return SAMPLES.map(sample=>columns.map(c=>sample[c.key]??null));}
export function expenseTemplate(layout,{samples=false}={}){const headers=templateHeaders(layout),columns=expenseColumnsOfSet(layout).map((c,n)=>({key:String(n),label:headers[n],type:c.type,...(c.type==='number'?{width:14}:{})})),rows=sampleRows(layout).map(r=>Object.fromEntries(r.map((v,n)=>[String(n),v])));
 return encodeReportXlsx([{name:EXPENSE_SHEET_NAME,columns,rows:samples?rows:[],freezeCols:2},{name:'入力ガイド',columns:[{key:'item',label:'項目'},{key:'guide',label:'入力の説明'}],rows:[{item:'対象',guide:'架空の記入例です。業務データを含みません。案件・発生日・税区分・証憑のまとまりは下見画面で確認してください。'},{item:'金額',guide:'税抜・消費税額を明示。源泉の控除は負数、対象外は0、未確認は空欄。税込欄は税抜＋税−源泉控除。税は選択した税区分で再検算します。'},{item:'請求書',guide:'同じ請求書の行範囲を指定してください。番号のない領収書も登録できます。締め日と予定日が空なら支払条件から候補を出します。条件がなければ手入力。'},{item:'出金日',guide:'参照専用です。入力した行は保留とし、経費登録では支払を作りません。出金予定画面から別途記録してください。'},{item:'記入例',guide:'1行目は13,200円の未払、2行目は支払先未登録、3行目は金額未確認です。下見には案件・発生日2026-09-14・税10%・源泉対象外を指定してください。'}]},{name:'記入例',columns,rows},{name:'版情報',columns:[{key:'key',label:'項目'},{key:'value',label:'値'}],rows:[{key:'形式版',value:EXPENSE_COLUMN_VERSION},{key:'列形式',value:layout},{key:'データ',value:'DEMO-*／架空の入力例。既存の架空経費と同じ検証事実。実績の複製登録には使わない。'}]}]);}
// シートは「経費集計」を正とし、旧名「経費入力」も読む（両方あれば「経費集計」）。見出しは位置ごとに新しい見出しか旧22・25列の見出しに完全一致
export function decodeExpenseFile(bytes,name){let rows;if(/\.csv$/i.test(name))rows=csvRows(new TextDecoder('utf-8',{fatal:true}).decode(bytes));else{const book=decodeXlsx(bytes);rows=[EXPENSE_SHEET_NAME,...EXPENSE_SHEET_ALIASES].map(sheet=>book.find(s=>s.name===sheet)).find(Boolean)?.rows;}
 if(!rows?.length)fail('経費集計シートがありません');const headers=rows[0],layout=IMPORT_LAYOUTS.find(l=>EXPENSE_LAYOUTS[l]===headers.length)??null;
 if(!layout||headers.some((v,n)=>!acceptsHeading(n+1,v)))fail('未対応の形式です。経費の22列または25列の雛形を使ってください');
 return {layout,rows:rows.slice(1).map((values,n)=>({row_no:n+2,values:Array.from({length:headers.length},(_,i)=>values[i]??null)})).filter(r=>r.values.some(v=>v!=null&&v!==''))};
}
// 書き出し。源泉は DB では正の控除額、書き出しの3様式（legacy22・standard25・standard33）では負（取込の境界と同じ）
export function exportExpense(rows,set,{asOf,filters,totals},format){const columns=sheetColumns(set),negative=negativeWithholding(set),values=rows.map(row=>({...row,...(negative?{withholding_yen:row.withholding_yen==null?null:0-row.withholding_yen}:{})}));
 if(format==='csv')return '\uFEFF'+toCsv([columns.map(c=>c.label),...values.map(r=>columns.map(c=>{const v=r[c.key];return typeof v==='string'&&/^[\s\uFEFF]*[=+@-]/u.test(v)?"'"+v:v;}))]);
 return encodeReportXlsx([{name:EXPENSE_SHEET_NAME,columns,rows:values,freezeCols:2},{name:'出力条件',columns:[{key:'key',label:'項目'},{key:'value',label:'値'}],rows:[{key:'基準日',value:asOf},{key:'列・計算版',value:EXPENSE_COLUMN_VERSION},{key:'列セット',value:resolveExpenseSet(set)},{key:'条件',value:JSON.stringify(filters)},...Object.entries(totals).map(([key,v])=>({key,value:`既知額 ${v.known}／未確認 ${v.unknown}件`}))]}]);}
