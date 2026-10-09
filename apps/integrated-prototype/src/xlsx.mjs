import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';

const xml=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const declaration='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const list=value=>value==null?[]:Array.isArray(value)?value:[value];
const letters=index=>{let s='';for(let n=index+1;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s};
const cell=(value,r,c)=>{const ref=letters(c)+(r+1),style=r===0?' s="1"':typeof value==='number'?' s="2"':'';if(value==null)return `<c r="${ref}"/>`;if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Excelに無限値は出力できません');return `<c r="${ref}"${style}><v>${value}</v></c>`}return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(value)}</t></is></c>`};

// Strings are always inline strings, including =/+/-/@ prefixes. No executable formulas.
export function encodeXlsx(sheets){
 if(!Array.isArray(sheets)||!sheets.length||sheets.length>50)throw Error('帳票シートは1〜50枚です');
 const names=new Set(),files={},entries=[];
 for(let i=0;i<sheets.length;i++){
  const {rows}=sheets[i],name=String(sheets[i].name||`Sheet${i+1}`).replace(/[\\/?:*\[\]]/g,' ').slice(0,31);
  if(names.has(name.toLowerCase()))throw Error('Excelシート名が重複しています');names.add(name.toLowerCase());
  if(!Array.isArray(rows)||rows.length>100000||rows.some(r=>!Array.isArray(r)||r.length>256))throw Error('帳票の行数・列数を確認してください');
  const width=Math.max(1,...rows.map(r=>r.length));
  files[`xl/worksheets/sheet${i+1}.xml`]=strToU8(declaration+`<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${width}" width="20" customWidth="1"/></cols><sheetData>${rows.map((row,r)=>`<row r="${r+1}">${row.map((v,c)=>cell(v,r,c)).join('')}</row>`).join('')}</sheetData>${rows.length?`<autoFilter ref="A1:${letters(width-1)}${rows.length}"/>`:''}<printOptions horizontalCentered="1"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`);
  entries.push({name,id:i+1});
 }
 files['[Content_Types].xml']=strToU8(declaration+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${entries.map(e=>`<Override PartName="/xl/worksheets/sheet${e.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
 files['_rels/.rels']=strToU8(declaration+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
 files['xl/workbook.xml']=strToU8(declaration+`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${entries.map(e=>`<sheet name="${xml(e.name)}" sheetId="${e.id}" r:id="rId${e.id}"/>`).join('')}</sheets></workbook>`);
 files['xl/_rels/workbook.xml.rels']=strToU8(declaration+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(e=>`<Relationship Id="rId${e.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${e.id}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
 files['xl/styles.xml']=strToU8(declaration+`<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><name val="Yu Gothic"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
 return zipSync(files,{level:6});
}
export function downloadXlsx(filename,sheets){const bytes=encodeXlsx(sheets),url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const a=document.createElement('a');a.href=url;a.download=filename.endsWith('.xlsx')?filename:filename+'.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}

// options.formulas: 'reject'（既定。数式のセルがあればブック全体を拒否）| 'sheet'（数式のあるシートだけを {rows:[], error} にして他のシートは読む）
// options.percent: 'number'（既定。パーセント書式の数は保存された数のまま。50% は 0.5）| 'text'（「50%」の文字にする。料率の列を%の数で読む取込で使う）
export function decodeXlsx(input,options={}){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);if(bytes.length>20*1024*1024)throw Error('Excelは20MB以下にしてください');
 let size=0;const files=unzipSync(bytes,{filter:file=>{size+=file.originalSize;if(size>50*1024*1024||file.originalSize>20*1024*1024)throw Error('Excelの展開サイズが大きすぎます');return file.name.endsWith('.xml')||file.name.endsWith('.rels')}});
 // htmlEntities: 数値文字参照（&#20316; や &#x54C1;）も文字に戻す（openpyxl などが書くブック。既定では数値文字参照のまま残る）。&amp; は最後に戻すので、文字として書いた「&#20316;」はそのまま
 const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',parseTagValue:false,parseAttributeValue:false,trimValues:false,processEntities:true,htmlEntities:true,removeNSPrefix:true});
 const read=path=>{if(!files[path])return null;const text=strFromU8(files[path]);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('外部定義を含むExcelは読み込めません');return parser.parse(text)};
 const book=read('xl/workbook.xml')?.workbook;if(!book)throw Error('有効なXLSXブックではありません');
 if(book.workbookPr?.['@date1904']==='1'||book.workbookPr?.['@date1904']==='true')throw Error('1904日付形式は未対応です。日付を文字列にしてください');
 const rels=list(read('xl/_rels/workbook.xml.rels')?.Relationships?.Relationship);
 const textRun=value=>typeof value==='string'?value:value?.['#text']??'';
 const rich=si=>si?.t!=null?textRun(si.t):list(si?.r).map(r=>textRun(r.t)).join('');
 const shared=list(read('xl/sharedStrings.xml')?.sst?.si).map(rich),styles=read('xl/styles.xml')?.styleSheet||{};
 const custom=new Map(list(styles.numFmts?.numFmt).map(x=>[Number(x['@numFmtId']),x['@formatCode']]));
 const formats=list(styles.cellXfs?.xf).map(x=>{const id=Number(x['@numFmtId']);return (id>=14&&id<=22)||/y|d/i.test(String(custom.get(id)||'').replace(/"[^"]*"|\[[^\]]*\]/g,''))});
 const percents=list(styles.cellXfs?.xf).map(x=>{const id=Number(x['@numFmtId']);return id===9||id===10||/%/.test(String(custom.get(id)||'').replace(/"[^"]*"|\[[^\]]*\]|\\./g,''))});
 const percentText=value=>`${Number((value*100).toPrecision(12))}%`;
 return list(book.sheets?.sheet).map(sheet=>{
  const rel=rels.find(x=>x['@Id']===(sheet['@r:id']??sheet['@id']));if(!rel||rel['@TargetMode']==='External')throw Error('シートの参照が不正です');
  const path=String(rel['@Target']).startsWith('/')?String(rel['@Target']).slice(1):'xl/'+rel['@Target'];if(path.includes('..'))throw Error('シートのパスが不正です');
  const content=read(path)?.worksheet;if(!content)throw Error('シートを取得できません');const rows=[];
  try{
  for(const row of list(content.sheetData?.row)){
   const r=Number(row['@r'])-1;if(!Number.isInteger(r)||r<0||r>=10000)throw Error('取込は1シート10,000行までです');const values=[];
   for(const c of list(row.c)){
    if(c.f!=null)throw Error(`${sheet['@name']} ${c['@r']}: 数式を値にしてから取り込んでください`);
    const m=String(c['@r']).match(/^([A-Z]+)\d+$/);if(!m)throw Error('セル位置が不正です');let col=0;for(const x of m[1])col=col*26+x.charCodeAt(0)-64;if(col>256)throw Error('取込は256列までです');
    const t=c['@t'];let value=c.v??null;if(t==='inlineStr')value=rich(c.is);else if(t==='s'){value=shared[Number(c.v)];if(value===undefined)throw Error('文字列参照が不正です')}else if(t==='b')value=c.v==='1'?'true':'false';else if(t==='e')throw Error(`${c['@r']}: Excelエラーを修正してください`);else if(value!==null&&t!=='str'){value=Number(value);if(!Number.isFinite(value))throw Error('数値が不正です');if(formats[Number(c['@s']||0)]){if(value===60)throw Error('存在しないExcel日付です');value=new Date(Date.UTC(1899,11,30)+value*86400000).toISOString().slice(0,10)}else if(options.percent==='text'&&percents[Number(c['@s']||0)])value=percentText(value)}
    values[col-1]=value;
   }
   rows[r]=Array.from({length:values.length},(_,i)=>values[i]??null);
  }
  }catch(error){if(options.formulas==='sheet'&&/数式/.test(error.message))return {name:sheet['@name'],rows:[],error:error.message};throw error}
  return {name:sheet['@name'],rows:Array.from({length:rows.length},(_,i)=>rows[i]||[])};
 });
}
export const readXlsx=decodeXlsx;
