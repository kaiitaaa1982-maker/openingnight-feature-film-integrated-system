import {downloadXlsx} from './xlsx.mjs';
import {downloadReportXlsx,specTable} from './xlsx-report.mjs';
import {dateTimeJst} from './ui/format.mjs';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// 数式の注入を防ぐ「'」は、数値（返品・取消の負の金額を含む）には付けない（付けると Excel で文字になり合計から外れる）
const plainNumber=value=>typeof value==='number'||/^-?\d+(\.\d+)?$/.test(String(value??'').trim());
export function csvDocument(rows){const cell=value=>{const s=String(value??'');return `"${(!plainNumber(value)&&/^[\s]*[=+@-]/.test(s)?"'":'')+s.replaceAll('"','""')}"`};return '﻿'+rows.map(row=>row.map(cell).join(',')).join('\r\n')}
export function downloadDocument(name,content,type='text/html;charset=utf-8'){
 const url=URL.createObjectURL(new Blob([content],{type})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
const conditionLine=sheet=>{const parts=(sheet.conditions||[]).map(c=>Array.isArray(c)?`${c[0]} ${c[1]??''}`.trim():String(c)).filter(Boolean);if(sheet.dataAsOf)parts.push(`データ時点 ${dateTimeJst(sheet.dataAsOf)}`);return parts.join(' ／ ')};
// sheets: [{name, rows:[[見出し], ...行]}]。任意で numeric（列ごとの右寄せ）、totalRows（末尾の合計行の数）、conditions・dataAsOf・notes。
export function printableReport({title,subtitle='',sheets,generatedAt=new Date().toISOString()}){
 const pages=[];
 for(const sheet of sheets){const [header=[],...rows]=sheet.rows,limit=header.length>12?18:25,totalFrom=rows.length-(sheet.totalRows||0),count=Math.ceil(Math.max(1,rows.length)/limit);for(let offset=0;offset<Math.max(1,rows.length);offset+=limit){const body=rows.slice(offset,offset+limit);pages.push({name:sheet.name,header,body,offset,totalFrom,numeric:sheet.numeric||[],meta:conditionLine(sheet),notes:offset/limit===count-1?sheet.notes||[]:[]})}}
 return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${escape(title)}</title><style>@page{size:A3 landscape;margin:12mm}*{box-sizing:border-box}body{font:12px "Yu Gothic","Noto Sans JP",sans-serif;color:#151515;background:white;margin:0}section{padding:12mm;break-after:page}section:last-child{break-after:auto}header{border-bottom:2px solid #222;margin-bottom:4mm}h1{font-size:22px;margin:0 0 2mm}h2{font-size:16px}p{margin:2mm 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #aaa;padding:2mm;overflow-wrap:anywhere;vertical-align:top}th{background:#edf0f2}td.number{text-align:right;font-variant-numeric:tabular-nums}tr.total td{font-weight:700;border-top:2px solid #222}p.meta,ul.notes{font-size:11px;color:#555}tr{break-inside:avoid}thead{display:table-header-group}footer{margin-top:4mm;font-size:10px;color:#555}button{margin:8px}@media print{button{display:none}section{padding:0}}</style><button onclick="window.print()">印刷・PDF保存</button>${pages.map((page,index)=>`<section><header><h1>${escape(title)}</h1><p>${escape(subtitle)}</p><p>生成日時 ${escape(dateTimeJst(generatedAt))} ／ ${index+1} / ${pages.length} ページ</p></header><h2>${escape(page.name)}</h2>${page.meta?`<p class="meta">${escape(page.meta)}</p>`:''}<table><thead><tr>${page.header.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${page.body.map((row,n)=>`<tr${page.offset+n>=page.totalFrom?' class="total"':''}>${page.header.map((_,i)=>`<td class="${typeof row[i]==='number'||page.numeric[i]?'number':''}">${escape(typeof row[i]==='number'?row[i].toLocaleString('ja-JP'):row[i])}</td>`).join('')}</tr>`).join('')}</tbody></table>${page.notes.length?`<ul class="notes">${page.notes.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>`:''}<footer>選択条件と登録済み情報による集計。未受領の報告は売上ゼロを意味しません。分配予定と支払実績を区別してください。</footer></section>`).join('')}</html>`;
}
// 列定義つきのシート（xlsx-report.mjs の形: columns＋行）と従来のシート（rows の1行目が見出し）を区別する。
// 全体の columns を渡すと、従来シートの見出し以外の行にその型（金額・率・日付など）を付ける。
export function normalizeReportSheets(sheets,columns){
 return (sheets||[]).map(sheet=>{
  if(Array.isArray(sheet?.columns))return {typed:true,spec:sheet};
  if(!Array.isArray(columns))return {typed:false,sheet};
  const [header=[],...rows]=sheet?.rows||[];
  return {typed:true,spec:{...sheet,columns:columns.map((column,i)=>({...column,key:column.key??String(i),label:column.label??header[i]})),rows}};
 });
}
const legacySpec=sheet=>{const [header=[],...rows]=sheet.rows||[];return {name:sheet.name,columns:header.map((label,i)=>({key:String(i),label})),rows}};
export function reportTables(sheets,{columns,mode='display'}={}){
 return normalizeReportSheets(sheets,columns).map(item=>{
  if(!item.typed)return item.sheet;
  const table=specTable(item.spec,{mode});
  return {name:table.name,rows:[table.header,...table.rows],numeric:table.numeric,totalRows:table.totalRows,conditions:item.spec.conditions,dataAsOf:item.spec.dataAsOf,notes:item.spec.notes};
 });
}
// 既存の引数はそのまま。columns（型）と sheetIndex（CSV・印刷の対象シート。省略時は CSV=先頭、印刷=全シート）を追加で受ける。
export function exportReport(format,{filename='report',title,subtitle,sheets,generatedAt,columns,sheetIndex}){
 if(sheetIndex!=null&&!sheets?.[sheetIndex])throw Error('出力するシートがありません');
 const normalized=normalizeReportSheets(sheets,columns),typed=normalized.some(item=>item.typed),first=normalized.find(item=>item.typed)?.spec;
 if(format==='xlsx'){
  if(!typed)return downloadXlsx(filename+'.xlsx',sheets);
  return downloadReportXlsx(filename+'.xlsx',{sheets:normalized.map(item=>item.typed?item.spec:legacySpec(item.sheet)),generatedAt:generatedAt?new Date(generatedAt):new Date()});
 }
 if(format==='csv'){const [table]=reportTables([sheets[sheetIndex??0]],{columns,mode:'raw'});return downloadDocument(filename+'.csv',csvDocument(table?.rows||[]),'text/csv;charset=utf-8')}
 const tables=reportTables(sheetIndex==null?sheets:[sheets[sheetIndex]],{columns,mode:'display'});
 const html=printableReport({title:title??first?.title??first?.name,subtitle,sheets:tables,generatedAt});
 if(format==='html')return downloadDocument(filename+'.html',html);
 const popup=window.open('','_blank');if(!popup)throw Error('印刷画面を開けません。印刷用HTMLを保存してください');popup.document.open();popup.document.write(html);popup.document.close();
}
