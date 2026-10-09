import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {extractDocument} from '../src/local-extractor.mjs';
import {proposeRuleBasedSchedule} from '../src/workflow.mjs';

const python=process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const fixture=name=>new URL(`../fixtures/${name === 'report.csv' ? name : 'workflow/' + name}`,import.meta.url);
const run=(args,input='')=>new Promise((resolve,reject)=>{const child=spawn(python,args,{shell:false,windowsHide:true});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code?reject(new Error(err)):resolve(out));child.stdin.end(input)});

test('Japanese script survives UTF-8 subprocess boundary and extracts location and cast',async()=>{
 const bytes=await readFile(fixture('script-ja.txt'));
 const result=await extractDocument({name:'日本語の台本.txt',base64:bytes.toString('base64'),pythonPath:python});
 assert.equal(result.name,'日本語の台本.txt');assert.equal(result.text,bytes.toString('utf8'));
 assert.equal(result.scenes[0].location,'港');assert.equal(result.scenes[1].location,'倉庫');
 assert.deepEqual(result.scenes[0].cast,['春川']);assert.ok(result.scenes[1].cast.includes('店主'));
 assert.equal(result.scenes[1].dayNight,'N');assert.equal(result.text.includes('\uFFFD'),false);
});

test('local extractor preserves hashes and extracts script TXT and sales CSV',async()=>{
  const script=await readFile(fixture('script.txt')),report=await readFile(fixture('report.csv'));
  const a=await extractDocument({name:'script.txt',base64:script.toString('base64'),pythonPath:python});
  assert.equal(a.status,'extracted');assert.equal(a.scenes.length,2);assert.equal(a.scenes[0].dayNight,'D');assert.equal(a.rawSha256.length,64);
  const b=await extractDocument({name:'report.csv',base64:report.toString('base64'),pythonPath:python});
  assert.deepEqual(b.sheets[0].rows[0].slice(0,3),['report id','start date','end date']);
});

test('local extractor handles DOCX, XLSX and text/scanned PDF without office applications',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'on-workflow-'));
  try{
    const code="import base64,io,json,openpyxl; from docx import Document; from reportlab.pdfgen.canvas import Canvas; from pypdf import PdfWriter; d=Document(); d.add_paragraph('S01 / NIGHT'); d.add_paragraph('Interior'); b=io.BytesIO(); d.save(b); w=openpyxl.Workbook(); w.active.append(['report id','gross sales']); w.active.append(['R1',1100]); x=io.BytesIO(); w.save(x); p=io.BytesIO(); c=Canvas(p); c.drawString(40,800,'report id, gross sales'); c.drawString(40,780,'R1, 1100'); c.save(); z=io.BytesIO(); q=PdfWriter(); q.add_blank_page(width=100,height=100); q.write(z); print(json.dumps({'docx':base64.b64encode(b.getvalue()).decode(),'xlsx':base64.b64encode(x.getvalue()).decode(),'pdf':base64.b64encode(p.getvalue()).decode(),'blank':base64.b64encode(z.getvalue()).decode()}))";
    const made=JSON.parse(await run(['-c',code]));
    const doc=await extractDocument({name:'a.docx',base64:made.docx,pythonPath:python});assert.equal(doc.scenes[0].dayNight,'N');
    const book=await extractDocument({name:'a.xlsx',base64:made.xlsx,pythonPath:python});assert.equal(book.sheets[0].rows[1][0],'R1');
    const pdf=await extractDocument({name:'a.pdf',base64:made.pdf,pythonPath:python});assert.equal(pdf.status,'extracted');assert.equal(pdf.sheets[0].name,'PDF text');
    const blank=await extractDocument({name:'blank.pdf',base64:made.blank,pythonPath:python});assert.equal(blank.status,'ocr_pending');assert.match(blank.unsupportedReason,/OCR/);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('FR-PROD-SCHED-005 FR-PROD-SCHED-022 rule-based schedule reports availability conflict and never invents a date',()=>{
  const scenes=[{sceneNo:'S1',cast:['A'],location:'港',estimatedMinutes:60},{sceneNo:'S2',cast:['B'],location:'港',estimatedMinutes:60}];
  const proposal=proposeRuleBasedSchedule(scenes,{dates:[{date:'2026-10-01',budgetMinutes:120}],availability:{cast:{A:['2026-10-01'],B:[]},locations:{港:['2026-10-01']}},unit:'A班'});
  assert.equal(proposal.commitAllowed,false);assert.deepEqual(proposal.days.map(x=>x.date),['2026-10-01']);assert.equal(proposal.conflicts[0].sceneNo,'S2');
});

test('縦書きの台本PDFを列ごとに組み直し、番号付き・○◯〇の見出し、話数付きのS#、頁（1/8）、文字化けの疑いを出す',async()=>{
  const script=async name=>extractDocument({name,base64:(await readFile(new URL(`../public/demo-fixtures/scripts/${name}`,import.meta.url))).toString('base64'),pythonPath:python,timeoutMs:60_000});
  const ep7=await script('fukurodo-ep07-kettei.pdf');
  assert.equal(ep7.scriptMeta.orientation,'vertical');assert.equal(ep7.scriptMeta.episode,'7');assert.deepEqual(ep7.scriptMeta.headingStyles,{number:30});
  assert.equal(ep7.scenes.length,30);assert.deepEqual(ep7.scenes.slice(0,3).map(x=>x.sceneNo),['7-1','7-2','7-3']);
  assert.equal(ep7.scenes[2].location,'ふくろう堂・店内');                 // 「同・店内」を直前の場所で読み替える
  assert.equal(ep7.scenes[6].location,'喫茶「灯台」');assert.equal(ep7.scenes[6].dayNight,'D');   // 括弧の閉じた店名は台詞の混入としない
  assert.deepEqual([...ep7.scenes[2].cast].sort(),['みさき','千尋','透'].sort());
  assert.ok(ep7.scenes.every(x=>x.pageEighths>=1));
  const pages=ep7.scriptMeta.pages-1,total=ep7.scenes.reduce((n,x)=>n+x.pageEighths,0);
  // 1シーンごとに1/8頁へ丸めるので、合計は本文の頁数×8から「最後の頁の余白＋シーン数の半分」までずれうる
  assert.ok(total<=pages*8+ep7.scenes.length/2&&total>=(pages-1)*8-ep7.scenes.length/2,`頁の合計 ${total}/8 と本文 ${pages}頁`);
  const draft=await script('fukurodo-ep08-junbi.pdf');
  assert.equal(draft.scriptMeta.episode,'8');assert.deepEqual(draft.scriptMeta.headingStyles,{glyph:27});assert.equal(draft.scriptMeta.suspectLines,3);
  assert.match(draft.scenes[1].reviewNotes.join(''),/撮影しない見出し/);
  assert.ok(draft.scriptMeta.warnings.some(x=>/文字化け/.test(x)));
});

test('台本の見出しの読み方: ○◯〇・時間帯・同・台詞の混入・助詞で終わる名前',async()=>{
  const text=['第12話 準備稿','','◯喫茶「灯台」（夜）','マスター「いらっしゃい」','〇同・厨房（翌朝）','看板に「準備中」と出ている。','○路地裏（回想・夕方）','千尋M『ここだ』','三 輪「来るか」'].join('\n');
  const result=await extractDocument({name:'variants.txt',base64:Buffer.from(text).toString('base64'),pythonPath:python});
  assert.deepEqual(result.scenes.map(x=>[x.sceneNo,x.location,x.dayNight]),[['12-1','喫茶「灯台」','N'],['12-2','喫茶「灯台」・厨房','D'],['12-3','路地裏（回想）','DN']]);
  assert.deepEqual(result.scenes[1].cast,[]);                               // 「看板に「…」」は台詞ではない
  assert.deepEqual(result.scenes[2].cast,['千尋','三輪']);                   // モノローグのM・名前の間の空白
  const mixed=await extractDocument({name:'mixed.txt',base64:Buffer.from('1\t古書店『灯』岸 本「遅いぞ」店主「\n本文').toString('base64'),pythonPath:python});
  assert.equal(mixed.scenes[0].location,'古書店『灯』岸 本');assert.match(mixed.scenes[0].reviewNotes.join(''),/台詞が混ざっている/);
});
