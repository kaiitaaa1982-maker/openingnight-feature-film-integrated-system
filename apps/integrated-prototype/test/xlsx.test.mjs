import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8,unzipSync,strFromU8} from 'fflate';
import {encodeXlsx,decodeXlsx} from '../src/xlsx.mjs';
test('XLSX preserves Unicode, literal formulas, leading zeros, negative amounts and multiple sheets',()=>{
 const sheets=[{name:'番販作品',rows:[['作品コード','作品名','税抜'],['001','=SUM(A1) & <確認>',-1200],['002','風のあとさき',0]]},{name:'前回まで・当期・累計',rows:[['区分','額'],['累計',2400000]]}];
 const bytes=encodeXlsx(sheets);assert.deepEqual(decodeXlsx(bytes),sheets);assert.equal(bytes[0],0x50);assert.equal(bytes[1],0x4b);
 const files=unzipSync(bytes);assert.ok(strFromU8(files['xl/worksheets/sheet1.xml']).includes('t="inlineStr"'));assert.ok(!strFromU8(files['xl/worksheets/sheet1.xml']).includes('<f>'));
});
test('XLSX import refuses formulas rather than trusting stale cached results',()=>{
 const files=unzipSync(encodeXlsx([{name:'売上',rows:[['額'],[100]]}]));files['xl/worksheets/sheet1.xml']=strToU8(strFromU8(files['xl/worksheets/sheet1.xml']).replace('<v>100</v>','<f>1+1</f><v>100</v>'));
 assert.throws(()=>decodeXlsx(zipSync(files)),/数式を値/);
});

test('XLSX の数値文字参照（openpyxl などが書く &#20316; ・&#x54C1;）は文字に戻し、文字として書いた「&#…;」はそのまま読む', () => {
  const files = unzipSync(encodeXlsx([{name: 'Details', rows: [['見出し'], ['値']]}]));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  // 見出しを数値文字参照で書き、2行目は「&#20316;」という文字（&amp; で書く）にする
  files['xl/worksheets/sheet1.xml'] = strToU8(sheet.replace('見出し', '&#20316;&#x54C1;CD').replace('>値<', '>&amp;#20316;&lt;&gt;<'));
  const [book] = decodeXlsx(zipSync(files));
  assert.deepEqual(book.rows, [['作品CD'], ['&#20316;<>']]);
});
