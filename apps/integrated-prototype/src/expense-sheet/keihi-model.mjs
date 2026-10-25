// 経費管理のフォルダ（販売の経費）の純関数。会社ルート plans/2026-10-22-folder-keihi.md。
// 経費の種類の一覧（表D）は移行が入るまでこの固定の一覧で持ち、expenses.category に名前を入れる。単位は種類から決まる。
import {fail} from './expense-model.mjs';
import {divideHalfUp} from '../money-allocation.mjs';

export const SALES_ITEM_TYPES=Object.freeze([
 {code:'VID-PRESS',name:'ビデオ製造費（プレス）',family:'package',unit:'枚'},
 {code:'VID-PRINT',name:'ビデオ製造費（印刷）',family:'package',unit:'枚'},
 {code:'VID-PACK',name:'ビデオ製造費（パッケージ・梱包）',family:'package',unit:'個'},
 {code:'VOD-ENC',name:'エンコード費',family:'digital',unit:'分'},
 {code:'VOD-CLOUD',name:'クラウド保管費',family:'digital',unit:'GB'},
 {code:'TV-SUB',name:'字幕作成費',family:'broadcast',unit:'分'},
 {code:'TV-ENC',name:'放送用エンコード費',family:'broadcast',unit:'本'},
 {code:'SHIP',name:'納品の送料',family:null,unit:'式'},
 {code:'PR-POSTER',name:'ポスター外注',family:'theatrical',unit:'枚'},
 {code:'PR-FLYER',name:'チラシ',family:'theatrical',unit:'枚'},
 {code:'PR-GOODS',name:'グッズ製造費',family:'theatrical',unit:'個'},
 {code:'LABOR',name:'人件費（業務委託）',family:null,unit:'日',labor:true},
 {code:'OTHER',name:'その他の販売の経費',family:null,unit:'式'}
].map(Object.freeze));
export const itemType=nameOrCode=>SALES_ITEM_TYPES.find(t=>t.code===nameOrCode||t.name===nameOrCode)??null;
export const DIFF_REASONS=Object.freeze(['値引き','端数','一式']);
export const TAX_RATES=Object.freeze([{bps:1000,label:'10%'},{bps:800,label:'8%'},{bps:0,label:'0%（不課税・非課税）'}]);

// 数量・単価は小数を整数（×10000）で持つ（expense_details の列と同じ）。単価は小数第2位まで（要件定義）。
export function toX10000(value,{maxDecimals=4}={}){const s=String(value??'').trim().replaceAll(',','');if(!/^\d+(\.\d+)?$/.test(s))return null;const [int,dec='']=s.split('.');if(dec.length>maxDecimals)return null;return Number(int)*10000+Number((dec+'0000').slice(0,4));}
export const fromX10000=v=>v==null?null:v/10000;
// 税抜＝数量×単価（円に四捨五入）。整数どうしで掛けてから丸める。
// 端数は四捨五入（half_up。docs/rules/money.md）。
export function expectedExTax(qtyX,priceX){if(qtyX==null||priceX==null)return null;return divideHalfUp(BigInt(qtyX)*BigInt(priceX),100000000n);}
export const taxFor=(exTax,bps)=>divideHalfUp(BigInt(exTax)*BigInt(bps),10000n);
export const fiscalMonths=fy=>Array.from({length:12},(_,n)=>{const m=(4+n)%12+1,y=fy+(n>=8?1:0);return `${y}-${String(m).padStart(2,'0')}`;});

// 1行の検査。戻り値は {key,ok,label} の並び（画面にそのまま出す）。
export function lineChecks(line){const out=[];const t=itemType(line.item_type),q=toX10000(line.quantity),p=toX10000(line.unit_price,{maxDecimals:2}),ex=Number.isInteger(line.actual_ex_tax)?line.actual_ex_tax:null,tax=Number.isInteger(line.tax_amount)?line.tax_amount:null;
 out.push({key:'required',ok:!!(line.work_id&&line.distribution_type_code&&t&&String(line.description??'').trim()&&q!=null&&q>0&&p!=null&&ex!=null&&tax!=null),label:'必須の欄（作品・流通・経費の種類・内容・数量・単価・税抜・税額）'});
 const want=expectedExTax(q,p);out.push({key:'qty_price',ok:want!=null&&(want===ex||DIFF_REASONS.includes(line.diff_reason)),label:want==null||want===ex?'税抜＝数量×単価':`税抜が数量×単価（${want.toLocaleString('ja-JP')}）と違う${DIFF_REASONS.includes(line.diff_reason)?`（理由: ${line.diff_reason}）`:'。理由を選ぶ'}`});
 return out;}
// 請求書1通の検査。lines は lineChecks を通す前の入力。
export function invoiceChecks(draft,lines,{month}={}){const out=[];const sum=lines.reduce((a,l)=>({ex:a.ex+(l.actual_ex_tax??0),tax:a.tax+(l.tax_amount??0)}),{ex:0,tax:0});
 out.push({key:'header',ok:!!(draft.partner_id&&draft.invoice_on&&draft.project_id&&draft.category_version_id&&draft.tax_category_version_id&&draft.withholding_category_version_id),label:'必須の欄（仕入先・請求日・案件・費用区分・税区分・源泉区分）'});
 out.push({key:'lines',ok:lines.length>0&&lines.every(l=>lineChecks(l).every(c=>c.ok)),label:'明細の行の検査'});
 const total=draft.original_total_inc_tax;out.push({key:'total',ok:Number.isInteger(total)&&total===sum.ex+sum.tax,label:Number.isInteger(total)?(total===sum.ex+sum.tax?'原本の合計＝明細の和':`原本の合計と明細の和が違う（差 ${(total-sum.ex-sum.tax).toLocaleString('ja-JP')}）`):'原本の合計（税込）を入れる'});
 if(month)out.push({key:'month',ok:!draft.invoice_on||draft.invoice_on.slice(0,7)===month,label:draft.invoice_on&&draft.invoice_on.slice(0,7)!==month?`請求日が ${month} の外（${draft.invoice_on.slice(0,7)} の原本）`:'請求日がこの月の中'});
 const reg=String(draft.registration_number??'').trim();out.push({key:'registration',ok:!reg||/^T\d{13}$/.test(reg),label:reg&&!/^T\d{13}$/.test(reg)?'登録番号は T＋13桁':'登録番号の形'});
 return {checks:out,sum:{ex:sum.ex,tax:sum.tax,inc:sum.ex+sum.tax},ok:out.every(c=>c.ok)};}
export function assertRegistrable(draft,lines){const r=invoiceChecks(draft,lines);if(!r.ok)fail('検査が通っていません: '+r.checks.filter(c=>!c.ok).map(c=>c.label).join('／'));return r;}

// 経費リストの流通ごとの合計（税抜・件数）。人件費は別に数える（粗利から外して営業利益で引く）。
export function distributionTotals(rows){const map=new Map();for(const r of rows){const k=r.distribution_name??'（流通なし）',v=map.get(k)??{name:k,count:0,ex_tax:0,labor_ex_tax:0};v.count++;v.ex_tax+=r.actual_ex_tax??0;if(itemType(r.category)?.labor)v.labor_ex_tax+=r.actual_ex_tax??0;map.set(k,v);}return [...map.values()].sort((a,b)=>b.ex_tax-a.ex_tax);}
// 年度の12か月のマス。rows は経費集計シートの行、files は請求書に結んでいない原本。
export function yearCells(fy,rows,files){return fiscalMonths(fy).map(month=>{const r=rows.filter(x=>x.accounting_month===month),f=files.filter(x=>x.month===month);return {month,registered:r.length,ex_tax:r.reduce((a,x)=>a+(x.actual_ex_tax??0),0),pending:f.length,state:f.length?'pending':r.length?'registered':'empty'};});}
