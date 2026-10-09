import {encodeReportXlsx as reportXlsx} from '../xlsx-report.mjs';
import {decodeXlsx} from '../xlsx.mjs';
import {parseCsv,toCsv as csv} from '../csv.mjs';
import {LEGACY_EXPENSE_COLUMNS,EXPENSE_COLUMN_VERSION} from './expense-columns.mjs';
import {SHEET_KEYS,sheetColumns} from './sheet-model.mjs';
import {fail} from './expense-model.mjs';
export const XLSX_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const encodeReportXlsx=sheets=>reportXlsx({sheets});
const toCsv=rows=>csv(rows[0],rows.slice(1));
function csvRows(text){const records=parseCsv(text),headers=Object.keys(records[0].values);return [headers,...records.map(r=>headers.map(h=>r.values[h]))];}
export function templateHeaders(layout){if(!['legacy22','standard25'].includes(layout))fail('22列または25列の形式を選んでください');return [...LEGACY_EXPENSE_COLUMNS,...(layout==='standard25'?['締め日','出金予定日','出金日']:[])];}
export function sampleRows(layout){return [
 [null,null,null,null,null,null,'2026-09-14','月末締めの支払先（架空）',null,'DEMO-INVOICE-UNPAID（架空）',1,12000,12000,1200,0,13200,null,'2026-09-14','架空の入力例','DEMO-PARTNER-EOM',null,'その他経費（架空）','2026-09-30','2026-10-31',null],
 [null,null,null,null,null,null,'2026-09-14','未登録の支払先（架空）',null,'支払先確認（架空）',1,12000,12000,1200,0,13200,null,'2026-09-14',null,'DEMO-MISSING',null,'その他経費（架空）','2026-09-30','2026-10-31',null],
 [null,null,null,null,null,null,'2026-09-14','月末締めの支払先（架空）',null,'金額未確認（架空）',null,null,null,null,null,null,null,'2026-09-14',null,'DEMO-PARTNER-EOM',null,'その他経費（架空）','2026-09-30','2026-10-31',null],
 ].map(r=>r.slice(0,layout==='legacy22'?22:25));}
export function expenseTemplate(layout,{samples=false}={}){const headers=templateHeaders(layout),columns=headers.map((label,n)=>({key:String(n),label,type:[12,13,14,15].includes(n)?'yen':[10,11].includes(n)?'number':[6,17,22,23,24].includes(n)?'date':'text',...([10,11].includes(n)?{width:14}:{})})),rows=sampleRows(layout).map(r=>Object.fromEntries(r.map((v,n)=>[String(n),v])));
 return encodeReportXlsx([{name:'経費入力',columns,rows:samples?rows:[],freezeCols:2},{name:'入力ガイド',columns:[{key:'item',label:'項目'},{key:'guide',label:'入力の説明'}],rows:[{item:'対象',guide:'架空の記入例です。業務データを含みません。案件・発生日・税区分・証憑のまとまりは下見画面で確認してください。'},{item:'金額',guide:'税抜・消費税額を明示。源泉の控除は負数、対象外は0、未確認は空欄。税込欄は税抜＋税−源泉控除。税は選択した税区分で再検算します。'},{item:'請求書',guide:'同じ請求書の行範囲を指定してください。番号のない領収書も登録できます。締め日と予定日が空なら支払条件から候補を出します。条件がなければ手入力。'},{item:'出金日',guide:'参照専用です。入力した行は保留とし、経費登録では支払を作りません。出金予定画面から別途記録してください。'},{item:'記入例',guide:'1行目は13,200円の未払、2行目は支払先未登録、3行目は金額未確認です。下見には案件・発生日2026-09-14・税10%・源泉対象外を指定してください。'}]},{name:'記入例',columns,rows},{name:'版情報',columns:[{key:'key',label:'項目'},{key:'value',label:'値'}],rows:[{key:'形式版',value:EXPENSE_COLUMN_VERSION},{key:'列形式',value:layout},{key:'データ',value:'DEMO-*／架空の入力例。既存の架空経費と同じ検証事実。実績の複製登録には使わない。'}]}]);}
export function decodeExpenseFile(bytes,name){const rows=/\.csv$/i.test(name)?csvRows(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):decodeXlsx(bytes).find(s=>s.name==='経費入力')?.rows;
 if(!rows?.length)fail('経費入力シートがありません');const headers=rows[0],layout=headers.length===22?'legacy22':headers.length===25?'standard25':null;
 if(!layout||headers.some((v,n)=>v!==templateHeaders(layout)[n]))fail('未対応の形式です。経費の22列または25列の雛形を使ってください');
 return {layout,rows:rows.slice(1).map((values,n)=>({row_no:n+2,values:Array.from({length:headers.length},(_,i)=>values[i]??null)})).filter(r=>r.values.some(v=>v!=null&&v!==''))};
}
export function exportExpense(rows,set,{asOf,filters,totals},format){const columns=sheetColumns(set),values=rows.map(row=>({...row,...(set==='legacy'?{withholding_yen:row.withholding_yen==null?null:-row.withholding_yen}:{})}));
 if(format==='csv')return '\uFEFF'+toCsv([columns.map(c=>c.label),...values.map(r=>columns.map(c=>{const v=r[c.key];return typeof v==='string'&&/^[\s\uFEFF]*[=+@-]/u.test(v)?"'"+v:v;}))]);
 return encodeReportXlsx([{name:'経費集計',columns,rows:values,freezeCols:2},{name:'出力条件',columns:[{key:'key',label:'項目'},{key:'value',label:'値'}],rows:[{key:'基準日',value:asOf},{key:'列・計算版',value:EXPENSE_COLUMN_VERSION},{key:'列セット',value:set},{key:'条件',value:JSON.stringify(filters)},...Object.entries(totals).map(([key,v])=>({key,value:`既知額 ${v.known}／未確認 ${v.unknown}件`}))]}]);}
