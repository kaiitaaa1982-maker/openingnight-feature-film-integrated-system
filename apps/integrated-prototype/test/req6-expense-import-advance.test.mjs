// ORG 仮払精算明細書（IMPORT_FORMATS.fab_advance）の取込。原本と同じ形の架空のブックを試験の中で組み立てる（値はすべて架空）
import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {setupExpense} from './req6-expense-fixture.mjs';
import {encodeXlsx} from '../src/xlsx.mjs';
import {decodeExpenseFile} from '../src/expense-sheet/expense-workbook.mjs';
import {cellIndex} from '../src/expense-sheet/expense-columns.mjs';

const NOTICE=['※注意事項'],HEAD=['No.','領収書日付','項目\n(プルダウンor手入力)','支払先','支払金額','エビデンス\n有無','領収証\n形式','利用者氏名','作品名','購入品内容','使用用途','チェック時備考'];
const EXAMPLE=['例','2026/04/01','事務費','架空の店（例）',320,'あり','データ','架空の利用者（例）','架空作品（例）','例の品','例の用途','例の備考'];
const top=advance=>[['ORG仮払精算明細書(立替一般経費精算フォーマット)'],[],['作品名',null,'架空作品A',null,'仮払金額',advance,null,null,null,'フォーマット作成日'],['仮払申請時の件名',null,'架空の件名',null,'実費',null,null,null,null,'仮払精算者','架空の精算者'],['使用目的',null,'架空の目的',null,'残金'],[],NOTICE];
// 25行版: 見出し16行・例17行・明細18〜42行・合計43行・総合計44行（原本と同じ位置）
function sheet25(details,{advance=50000,grand}={}){const rows=top(advance);while(rows.length<15)rows.push([]);rows.push(HEAD,EXAMPLE);
 for(let n=1;n<=25;n++)rows.push(details[n-1]?[n,...details[n-1]]:[n]);const sum=details.reduce((s,d)=>s+(typeof d[3]==='number'?d[3]:0),0);
 rows.push([null,'No.1～25','合計',null,sum],[null,'No.1～25','総合計',null,grand??sum]);return rows;}
// 150行版: 支払金額が E:H（10%・8%・0%・合計）、エビデンス有無の見出しは空、見出しの下に税率の行
function sheet150(details){const rows=top(null);while(rows.length<15)rows.push([]);
 rows.push(['No.','領収書日付','項目','支払先','支払金額',null,null,null,null,'領収証\n形式','利用者氏名','作品名','購入品内容','使用用途','チェック時備考'],[null,null,'(プルダウンor手入力)',null,0.1,0.08,0,'合計'],['例','2026/04/01','事務費','架空の店（例）',320,null,null,320,'あり','データ']);
 for(let n=1;n<=25;n++)rows.push(details[n-1]?[n,...details[n-1]]:[n]);const sum=details.reduce((s,d)=>s+d[6],0);rows.push([null,'No.1～25','合計',null,null,null,null,sum],[null,'No.1～25','総合計',null,null,null,null,sum]);return rows;}
const exampleSheet=()=>[[null,'★記載例'],[],[null,null,'ORG仮払精算明細書'],...Array(14).fill([]),[null,null,...HEAD],[null,null,...EXAMPLE],[null,null,1,'2026/04/02','事務費','架空の店（記載例）',1300,'あり','紙','架空','架空','架空','架空']];
// 原本と同じく、合計・総合計・実費・残金のセルを数式（Excel が保存した計算結果つき）にする
function withFormulas(bytes,formulas){const files=unzipSync(bytes);for(const [sheetNo,cells] of Object.entries(formulas)){const path=`xl/worksheets/sheet${sheetNo}.xml`;let xml=strFromU8(files[path]);for(const [ref,f] of Object.entries(cells)){const re=new RegExp(`<c r="${ref}"([^>]*)><v>([^<]*)</v></c>`);assert.match(xml,re,ref);xml=xml.replace(re,`<c r="${ref}"$1><f>${f}</f><v>$2</v></c>`);}files[path]=strToU8(xml);}return zipSync(files);}
function book({details=[],grand,s150=[],second=[]}={}){const bytes=encodeXlsx([{name:'仮払精算の注意事項',rows:[['仮払精算時の提出書類についての注意事項（架空）']]},{name:'仮払精算明細書(記載例)',rows:exampleSheet()},{name:'仮払精算明細書(25行版)',rows:sheet25(details,{grand})},{name:'仮払精算明細書(50行版)',rows:sheet25(second,{advance:0})},{name:'仮払精算明細書(150行版)',rows:sheet150(s150)},{name:'プルダウン用',rows:[[null,'プルダウン項目'],[null,'事務費']]}]);
 return withFormulas(bytes,{3:{E43:'SUM(E18:E42)',E44:'SUM(E43)'}});}
// 明細: [日付, 項目, 支払先, 支払金額(税込), エビデンス, 形式, 利用者, 作品名, 購入品内容, 使用用途, 備考]
const D=(amount,extra={})=>['2026/10/0'+(extra.day??1),'事務費','架空の店',amount,'あり','紙','架空の利用者','架空作品A','架空の品','架空の用途',extra.note??null];

async function fixture({t}={}){const f=await setupExpense({t});return {...f,supplement:{project_id:1,partner_id:f.settings.payee,incurred_on:'2026-10-01',tax_category_version_id:f.settings.taxes['10'],withholding_category_version_id:f.settings.withholding.NONE,common_expense:true,each_row_invoice:true,closing_on:'2026-10-31',due_on:'2026-11-30'}};}
const body=(f,bytes,extra={})=>({file_name:'DEMO-仮払精算明細書.xlsx',original_base64:Buffer.from(bytes).toString('base64'),expectedVersion:0,reason:'下見（架空）',supplement:f.supplement,...extra});

test('仮払精算明細書: 25行版の明細だけを25列の位置へ置き換え、記載例・例の行・空の行・合計の行は読まない',()=>{
 const d=decodeExpenseFile(book({details:[D(1100),D(1300,{day:2,note:'架空の備考'})]}),'DEMO.xlsx');
 assert.equal(d.layout,'standard25');assert.equal(d.source.format,'fab_advance');assert.equal(d.source.sheet,'仮払精算明細書(25行版)');
 assert.deepEqual(d.rows.map(r=>r.row_no),[18,19]);assert.equal(d.rows[0].values.length,25);
 const v=d.rows[1].values;assert.deepEqual([v[cellIndex('recorded_on')],v[cellIndex('invoice_on')],v[cellIndex('category_name')],v[cellIndex('client_name')],v[cellIndex('payable_yen')],v[cellIndex('withholding_yen')],v[cellIndex('description')],v[cellIndex('specification')],v[cellIndex('actual_ex_tax')],v[cellIndex('tax_amount')]],['2026/10/02','2026/10/02','事務費','架空の店',1300,0,'架空の品','架空の用途',null,null]);
 assert.equal(v[cellIndex('memo')],'No. 2／利用者 架空の利用者／作品名 架空作品A／エビデンス あり／領収証形式 紙／備考 架空の備考');
 assert.deepEqual([d.source.rows,d.source.detail_yen,d.source.grand_total_yen,d.source.header.advance_yen,d.source.header.subject],[2,2400,2400,50000,'架空の件名']);
});
test('仮払精算明細書: 総合計と明細の和の不一致・明細が2枚のシート・金額が文字は拒否する',async(t)=>{
 assert.throws(()=>decodeExpenseFile(book({details:[D(1100)],grand:9999}),'DEMO.xlsx'),/明細の支払金額の和（1100円）が総合計（9999円）と一致しません/);
 assert.throws(()=>decodeExpenseFile(book({details:[D(1100)],second:[D(500)]}),'DEMO.xlsx'),/明細が複数のシートにあります/);
 assert.throws(()=>decodeExpenseFile(book({details:[D('千円')]}),'DEMO.xlsx'),/支払金額は数で記入してください/);
 // 仮払精算明細書でない xlsx の数式は従来どおり拒否する
 const plain=withFormulas(encodeXlsx([{name:'経費集計',rows:[['ID'],[1]]}]),{1:{A2:'1'}});assert.throws(()=>decodeExpenseFile(plain,'DEMO.xlsx'),/数式を値にしてから/);
});
test('仮払精算明細書: 下見で税込から税抜・税額を割り出して登録し、税込の和が総合計と一致する',async(t)=>{const f=await fixture({t});try{
 const bytes=book({details:[D(1100),D(1300,{day:2}),D(55,{day:3})]});assert.ok(bytes.length>0);
 const p=await f.post('/expense-imports/preview',body(f,bytes));
 assert.deepEqual([p.ready,p.held,p.unknown],[3,0,0],JSON.stringify(p.rows.map(r=>r.issues)));assert.equal(p.source.grand_total_yen,2455);assert.equal(p.source.rows,3);
 assert.deepEqual(p.rows.map(r=>[r.payload.actual_ex_tax,r.payload.tax_amount,r.payload.actual_inc_tax]),[[1000,100,1100],[1182,118,1300],[50,5,55]]);assert.equal(p.known_ex_tax,2232);
 assert.equal((await f.db.get('SELECT layout FROM expense_import_batches WHERE id=?',[p.id])).layout,'standard25');
 // 下見の保存には原本の書式が1回だけ残り、行ごとの補足には写さない
 const saved=JSON.parse((await f.db.get('SELECT payload_json FROM expense_import_versions WHERE batch_id=?',[p.id])).payload_json);assert.equal(saved.supplement.advance.format,'fab_advance');assert.ok(saved.rows.every(r=>!('advance' in r.supplement)));
 // 利用者の入力で原本の書式を消しても、再下見は保存した書式で読む
 const p2=await f.post(`/expense-imports/${p.id}/preview`,{expectedVersion:1,reason:'再下見（架空）',supplement:{...f.supplement,advance:null}});assert.equal(p2.ready,3);
 await f.post(`/expense-imports/${p.id}/commit`,{expectedVersion:2,hash:p2.hash,reason:'登録（架空）'});
 assert.equal((await f.db.get('SELECT SUM(actual_inc_tax) n FROM expenses')).n,2455);assert.equal((await f.db.get("SELECT COUNT(*) n FROM expense_invoice_versions WHERE document_kind='receipt'")).n,3);
}finally{f.db.close();}});
test('仮払精算明細書: 150行版の税率ごとの金額が取込の税区分と違う・複数の税率なら保留する',async(t)=>{const f=await fixture({t});try{
 // [日付, 項目, 支払先, 10%, 8%, 0%, 合計, エビデンス, 形式, 利用者, 作品名, 購入品内容, 使用用途, 備考]
 const r=(a10,a8,total)=>['2026/10/01','事務費','架空の店',a10,a8,null,total,'あり','紙','架空の利用者','架空作品A','架空の品','架空の用途',null];
 const bytes=book({s150:[r(1100,null,1100),r(null,1080,1080),r(1100,1080,2180)]});const d=decodeExpenseFile(bytes,'DEMO.xlsx');assert.equal(d.source.sheet,'仮払精算明細書(150行版)');assert.deepEqual(d.rows.map(x=>x.row_no),[19,20,21]);assert.deepEqual(d.source.rates[19],{0:null,1000:1100,800:null});
 const p=await f.post('/expense-imports/preview',body(f,bytes));assert.deepEqual(p.rows.map(x=>x.status),['登録可','保留','保留']);
 assert.match(p.rows[1].issues[0].reason,/領収書の税率（8%）と取込の税区分が違います/);assert.equal(p.rows[1].issues[0].column,'税区分');assert.match(p.rows[2].issues[0].reason,/税率の違う金額が1行にあります/);
 // 行の税区分を 8% に直すと登録できる
 const p2=await f.post(`/expense-imports/${p.id}/preview`,{expectedVersion:1,reason:'税区分（架空）',supplement:{...f.supplement,overrides:{20:{tax_category_version_id:f.settings.taxes['8']}}}});assert.deepEqual(p2.rows.map(x=>x.status),['登録可','登録可','保留']);assert.deepEqual([p2.rows[1].payload.actual_ex_tax,p2.rows[1].payload.tax_amount],[1000,80]);
}finally{f.db.close();}});
test('仮払精算明細書でない取込は、税抜・税額が空でも割り出さず保留する（利用者の supplement.advance は使わない）',async(t)=>{const f=await fixture({t});try{
 const {templateHeaders,sampleRows}=await import('../src/expense-sheet/expense-workbook.mjs');const row=sampleRows('standard25')[0];row[cellIndex('actual_ex_tax')]=null;row[cellIndex('tax_amount')]=null;
 const bytes=encodeXlsx([{name:'経費集計',rows:[templateHeaders('standard25'),row]}]);const p=await f.post('/expense-imports/preview',body(f,bytes,{supplement:{...f.supplement,advance:{format:'fab_advance'}}}));
 assert.equal(p.held,1);assert.match(p.rows[0].issues[0].reason,/金額が未確認/);assert.equal(p.source,undefined);
}finally{f.db.close();}});
