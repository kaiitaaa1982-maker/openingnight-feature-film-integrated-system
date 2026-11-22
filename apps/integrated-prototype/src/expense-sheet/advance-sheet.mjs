// ORG 仮払精算明細書（IMPORT_FORMATS.fab_advance）を、経費の取込の25列（standard25）の行へ置き換える。AI は使わず、見出しの位置で読む。
// - 読むシート: 「仮払精算明細書(N行版)」。記載例のシートは読まない。明細のあるシートが2枚以上なら拒否する
// - 見出しの行: No.・領収書日付・項目・支払先・支払金額… の行。列は見出しの文字で位置を決める（版によって列がずれる）
// - 明細の行: 見出しの下から「総合計」の行まで。「例」の行・「合計」の行・No. のほかが空の行は読まない
// - 支払金額は税込。150行版は税率ごとの列（10%・8%・0%）と合計の列があり、合計を支払金額、税率ごとの額を rates に残す
// - 明細の支払金額の和が「総合計」の行（Excel が保存した計算結果）と一致しなければ拒否する
import {IMPORT_FORMATS,ADVANCE_HEADINGS,ADVANCE_FIELDS,EXPENSE_LAYOUTS,cellIndex} from './expense-columns.mjs';
import {fail} from './expense-model.mjs';
const FORMAT='fab_advance',spec=IMPORT_FORMATS[FORMAT];
const text=v=>v==null?'':String(v).replace(/\(プルダウンor手入力\)/g,'').replace(/[\s　]+/g,'');
const empty=v=>v==null||(typeof v==='string'&&!v.trim());
const yen=v=>{if(typeof v==='number')return v;const s=String(v??'').replace(/[¥￥,\s]/g,'');return s&&/^-?\d+(\.\d+)?$/.test(s)?Number(s):null;};
// 150行版の税率の見出し（Excel の数）→ bp。原本にある3つだけを受ける
const RATE_BPS=new Map([[0.1,1000],[0.08,800],[0,0]]);
export const isAdvanceBook=book=>book.some(s=>spec.sheet.test(s.name));
function headerRow(rows){for(let r=0;r<rows.length;r++){const row=rows[r]??[];const cols={};row.forEach((v,c)=>{const key=ADVANCE_HEADINGS[text(v)];if(key&&cols[key]==null)cols[key]=c;});if(cols.no!=null&&cols.date!=null&&cols.amount!=null)return {r,cols};}return null;}
function readSheet(sheet){
 const rows=sheet.rows,h=headerRow(rows);if(!h)fail(`${sheet.name}: 仮払精算明細書の見出しの行が見つかりません`);
 const cols={...h.cols};for(const key of ['category','payee','item','purpose','user','work','note','receipt_form'])if(cols[key]==null)fail(`${sheet.name}: 見出し「${Object.keys(ADVANCE_HEADINGS).find(k=>ADVANCE_HEADINGS[k]===key)}」が見つかりません`);
 // 150行版: 支払金額の下の行に税率（0.1・0.08・0）と「合計」。合計の列を支払金額にする
 let first=h.r+1,rateCols=null;const sub=rows[h.r+1]??[];const totalCol=sub.findIndex((v,c)=>c>=cols.amount&&c<cols.receipt_form&&text(v)==='合計');
 if(totalCol>=0){rateCols=[];for(let c=cols.amount;c<totalCol;c++){const bps=RATE_BPS.get(sub[c]);if(bps==null)fail(`${sheet.name}: 支払金額の税率の見出しを確認してください`);rateCols.push({c,bps});}cols.amount=totalCol;first=h.r+2;}
 if(cols.evidence==null&&cols.receipt_form-1>cols.amount)cols.evidence=cols.receipt_form-1;
 // 見出しの上の欄（作品名・仮払金額…）。ラベルの右で最初に値のあるセル
 const header={};for(let r=0;r<h.r;r++){const row=rows[r]??[];row.forEach((v,c)=>{const key=ADVANCE_FIELDS[text(v)];if(!key||key in header)return;for(let k=c+1;k<row.length&&!ADVANCE_FIELDS[text(row[k])];k++)if(!empty(row[k])){header[key]=row[k];return;}header[key]=null;});}
 const details=[];let grand=null;
 for(let r=first;r<rows.length;r++){const row=rows[r]??[],at=key=>cols[key]==null?null:row[cols[key]]??null,label=text(at('category'));
  if(label==='総合計'){grand={row_no:r+1,value:at('amount')};break;}
  if(label==='合計'||text(at('no'))==='例')continue;
  if(row.every((v,c)=>c===cols.no||empty(v)))continue;
  details.push({row_no:r+1,at,rates:rateCols?Object.fromEntries(rateCols.map(({c,bps})=>[bps,yen(row[c])])):null});
 }
 if(!grand)fail(`${sheet.name}: 「総合計」の行が見つかりません`);
 return {sheet:sheet.name,header,details,grand};
}
const memo=at=>[['No.','no'],['利用者','user'],['作品名','work'],['エビデンス','evidence'],['領収証形式','receipt_form'],['備考','note']].filter(([,k])=>!empty(at(k))).map(([l,k])=>`${l} ${String(at(k)).trim()}`).join('／')||null;
// 戻り値は decodeExpenseFile と同じ形 {layout,rows} に、原本の書式 source を足したもの
export function decodeAdvanceBook(book){
 const sheets=book.filter(s=>spec.sheet.test(s.name)).map(readSheet),filled=sheets.filter(s=>s.details.length);
 if(filled.length>1)fail(`明細が複数のシートにあります（${filled.map(s=>s.sheet).join('・')}）。1枚にまとめてください`);
 // 明細のあるシート。無ければ仮払金額の入ったシート、それも無ければ最初のシート
 const chosen=filled[0]??sheets.find(s=>yen(s.header.advance_yen))??sheets[0];if(!chosen)fail('仮払精算明細書のシートがありません');
 const width=EXPENSE_LAYOUTS[spec.layout],rows=chosen.details.map(({row_no,at})=>{const values=Array(width).fill(null),put=(key,v)=>{values[cellIndex(key)]=empty(v)?null:typeof v==='string'?v.trim():v;};
  put('recorded_on',at('date'));put('invoice_on',at('date'));put('client_name',at('payee'));put('description',at('item'));put('specification',at('purpose'));put('category_name',at('category'));put('payable_yen',at('amount'));put('withholding_yen',0);put('memo',memo(at));
  return {row_no,values};});
 const amounts=chosen.details.map(d=>yen(d.at('amount'))),detail=amounts.reduce((n,v)=>n+(v??0),0),grand=yen(chosen.grand.value);
 if(chosen.details.some((d,n)=>amounts[n]==null&&!empty(d.at('amount'))))fail(`${chosen.sheet}: 支払金額は数で記入してください`);
 if(grand==null&&!empty(chosen.grand.value))fail(`${chosen.sheet}: 総合計（${chosen.grand.row_no}行）が数ではありません`);
 if(detail!==(grand??0))fail(`${chosen.sheet}: 明細の支払金額の和（${detail}円）が総合計（${grand??0}円）と一致しません`);
 const rates=Object.fromEntries(chosen.details.filter(d=>d.rates).map(d=>[d.row_no,d.rates]));
 return {layout:spec.layout,rows,source:{format:FORMAT,label:spec.label,sheet:chosen.sheet,header:chosen.header,rows:rows.length,detail_yen:detail,grand_total_yen:grand??0,...(Object.keys(rates).length?{rates}:{})}};
}
