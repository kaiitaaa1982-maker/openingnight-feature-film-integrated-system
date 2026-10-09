import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FileBlob,SpreadsheetFile,Workbook} from '@oai/artifact-tool';

const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.join(root,'output');
await fs.mkdir(out,{recursive:true});
const disclaimer='非公式・架空データ・実在企業発行書式ではありません。取込・加工テスト専用。';

const fixtures=[
 {slug:'streaming-platform',title:'配信プラットフォーム風 売上報告（架空）',period:'2026-08',headers:['作品CD','商品ｺｰﾄﾞ','配信区分','対象月','視聴/契約数','単価(税抜)','総額','PF手数料','正味売上','備考'],rows:[
  ['WRK-DEMO','SKU-DIGI','TVOD','2026/08',1250,420,525000,157500,367500,'正常'],
  ['WRK-DEMO','SKU-DIGI','SVOD','2026/08',1,480000,480000,0,480000,'月額固定・正常'],
  ['WRK-DEMO','SKU-DIGI','EST','2026/08',320,1200,384000,76800,307200,'正常'],
  ['WRK-DEMO','','TVOD','2026/08',45,500,22500,6750,16000,'要修正: 商品コード欠落・正味額不一致']
 ],validRows:3,expected:{gross:1389000,fee:234300,net:1154700},badRow:8},
 {slug:'videogram-rental',title:'ビデオグラム事業者風 出荷・返品報告（架空）',period:'2026-08',headers:['作品コード','品番','商材','集計年月','出荷数量','返品数','正味数量','精算単価','正味額','検証メモ'],rows:[
  ['WRK-DEMO','SKU-PACK','レンタルDVD','2026年8月',800,35,765,420,321300,'正常'],
  ['WRK-DEMO','SKU-PACK','レンタルBD','2026年8月',260,12,248,580,143840,'正常'],
  ['WRK-DEMO','SKU-PACK','セルDVD','2026年8月',150,5,145,1800,261000,'正常'],
  ['WRK-DEMO','SKU-PACK','レンタルDVD','2026年8月',90,120,-30,500,45000,'要修正: 返品超過・正味額不一致']
 ],validRows:3,expected:{netUnits:1158,net:726140},badRow:8}
];

const csvCell=v=>`"${String(v??'').replaceAll('"','""')}"`;
const csv=rows=>'\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
const manifests=[];
for(const f of fixtures){
 const wb=Workbook.create(),sheet=wb.worksheets.add('Details'),check=wb.worksheets.add('検証期待値');
 const width=f.headers.length,last=String.fromCharCode(64+width);
 sheet.getRange(`A1:${last}1`).merge();sheet.getRange('A1').values=[[f.title]];
 sheet.getRange(`A2:${last}2`).merge();sheet.getRange('A2').values=[[disclaimer]];
 sheet.getRange(`A3:${last}3`).merge();sheet.getRange('A3').values=[[`対象期間: ${f.period} / 作品: WRK-DEMO 風のあとさき`]];
 sheet.getRange(`A4:${last}4`).values=[f.headers];sheet.getRange(`A5:${last}${4+f.rows.length}`).values=f.rows;
 sheet.getRange(`A1:${last}${4+f.rows.length}`).format.font={name:'Arial',size:10};
 sheet.getRange(`A1:${last}1`).format={fill:'#172554',font:{name:'Arial',size:16,bold:true,color:'#FFFFFF'}};
 sheet.getRange(`A2:${last}2`).format={fill:'#FEF3C7',font:{name:'Arial',size:10,bold:true,color:'#92400E'}};
 sheet.getRange(`A4:${last}4`).format={fill:'#DBEAFE',font:{name:'Arial',bold:true,color:'#172554'}};
 sheet.getRange(`A${f.badRow}:${last}${f.badRow}`).format={fill:'#FEE2E2',font:{name:'Arial',color:'#991B1B'}};
 sheet.getRange(`A1:${last}${4+f.rows.length}`).format.wrapText=true;sheet.freezePanes.freezeRows(4);
 for(let c=0;c<width;c++)sheet.getRangeByIndexes(0,c,4+f.rows.length,1).format.columnWidth=c<4?16:14;
 if(f.slug==='streaming-platform'){
  sheet.getRange('G5:I8').format.numberFormat='#,##0';
  check.getRange('A1:B7').values=[['検証項目','期待値'],['注意',disclaimer],['正常行数',f.validRows],['総額合計',f.expected.gross],['手数料合計',f.expected.fee],['正味売上合計',f.expected.net],['要修正行','Details 8行目']];
  check.getRange('D1:F1').values=[['総額再計算','手数料再計算','正味再計算']];
  check.getRange('D2:D4').formulas=[['=Details!E5*Details!F5'],['=Details!E6*Details!F6'],['=Details!E7*Details!F7']];
  check.getRange('E2:E4').formulas=[['=Details!H5'],['=Details!H6'],['=Details!H7']];
  check.getRange('F2:F4').formulas=[['=D2-E2'],['=D3-E3'],['=D4-E4']];
 }else{
  sheet.getRange('E5:I8').format.numberFormat='#,##0';
  check.getRange('A1:B6').values=[['検証項目','期待値'],['注意',disclaimer],['正常行数',f.validRows],['正味数量合計',f.expected.netUnits],['正味額合計',f.expected.net],['要修正行','Details 8行目']];
  check.getRange('D1:E1').values=[['正味数量再計算','正味額再計算']];
  check.getRange('D2:D4').formulas=[['=Details!E5-Details!F5'],['=Details!E6-Details!F6'],['=Details!E7-Details!F7']];
  check.getRange('E2:E4').formulas=[['=D2*Details!H5'],['=D3*Details!H6'],['=D4*Details!H7']];
 }
 check.getRange('A1:F7').format.font={name:'Arial',size:10};check.getRange('A1:F1').format={fill:'#172554',font:{name:'Arial',bold:true,color:'#FFFFFF'}};
 check.getRange('A:A').format.columnWidth=20;check.getRange('B:B').format.columnWidth=58;check.getRange('D:F').format.columnWidth=18;
 wb.recalculate();
 const preview=await wb.render({sheetName:'Details',autoCrop:'all',scale:1,format:'png'});await fs.writeFile(path.join(out,`${f.slug}-preview.png`),new Uint8Array(await preview.arrayBuffer()));
 const xlsx=await SpreadsheetFile.exportXlsx(wb),xlsxPath=path.join(out,`${f.slug}-sample.xlsx`);await xlsx.save(xlsxPath);
 const csvRows=[[disclaimer],f.headers,...f.rows],csvPath=path.join(out,`${f.slug}-sample.csv`);await fs.writeFile(csvPath,csv(csvRows),'utf8');
 const imported=await SpreadsheetFile.importXlsx(await FileBlob.load(xlsxPath));imported.recalculate();
 const inspected=await imported.inspect({kind:'table',range:`検証期待値!A1:F7`,include:'values,formulas'});
 manifests.push({id:f.slug,files:{xlsx:path.basename(xlsxPath),csv:path.basename(csvPath)},work:{code:'WRK-DEMO',title:'風のあとさき'},period:f.period,disclaimer,validRows:f.validRows,badSourceRow:f.badRow,expected:f.expected,reloadInspection:{ok:!!inspected,artifactToolReloaded:true}});
}
await fs.writeFile(path.join(out,'fixture-manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),fixtures:manifests},null,2),'utf8');
console.log(JSON.stringify({ok:true,outputs:fixtures.flatMap(f=>[`${f.slug}-sample.xlsx`,`${f.slug}-sample.csv`]),manifest:'fixture-manifest.json'}));
