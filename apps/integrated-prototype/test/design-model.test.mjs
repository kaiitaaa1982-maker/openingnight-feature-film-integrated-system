import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {objects,relations,screenSources,selectObject,selectTable,selectScreen,foreignKeys,validateModel} from '../src/design-model.mjs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
test('canvas correspondence exists in live schema and mounted screen registry; FK metadata follows schema changes',async(t)=>{
 const db=await openTestDb({t}),app=createApp({db});
 const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})}),cookie=login.headers.get('set-cookie').split(';')[0];
 const er=async()=>{const r=await app.request('/api/er',{headers:{cookie}});assert.equal(r.status,200);return (await r.json()).tables};
 const tables=await er(),main=readFileSync(new URL('../src/main.jsx',import.meta.url),'utf8'),registry=main.match(/const\s+screens\s*=\s*\{([\s\S]*?)\};/)[1];
 const screens=Object.keys(screenSources).filter(page=>registry.includes(`${page}:`)||registry.includes(`'${page}':`)||registry.includes(`"${page}":`));
 assert.deepEqual(validateModel(objects,tables,screens),[]);
 assert.ok(objects.find(o=>o.id==='report').tables.includes('report_source_controls'));
 assert.ok(objects.find(o=>o.id==='report').tables.includes('package_report_observations'));
 assert.ok(objects.find(o=>o.id==='sales').tables.includes('digital_sale_details'));
 for(const path of Object.values(screenSources))assert.ok(existsSync(new URL('../'+path,import.meta.url)),path);
 for(const edge of relations)assert.ok(objects.some(o=>o.id===edge.from)&&objects.some(o=>o.id===edge.to));
 const edges=foreignKeys(tables);assert.ok(edges.some(e=>e.columns.length>1));assert.equal(edges.reduce((n,e)=>n+e.columns.length,0),tables.reduce((n,t)=>n+t.foreignKeys.length,0));
 await db.run('ALTER TABLE works ADD COLUMN canvas_probe TEXT');
 const updated=await er();assert.ok(updated.find(t=>t.name==='works').columns.some(c=>c.name==='canvas_probe'));assert.ok(!tables.find(t=>t.name==='works').columns.some(c=>c.name==='canvas_probe'));
 assert.ok(validateModel([...objects,objects[0]],tables,screens).some(s=>s.includes('重複ID')));
 assert.ok(validateModel([{...objects[0],tables:['missing']}],tables,screens).some(s=>s.includes('表なし')));
});
test('selection follows object/table/screen and preserves compatible shared references',()=>{
 let state=selectObject({},'sales');state=selectTable(state,'report_imports');assert.equal(state.objectId,'sales');assert.equal(state.page,'帳票センター');
 state=selectScreen(state,'原本取り込み');assert.equal(state.objectId,'report');assert.equal(state.table,'report_imports');
 state=selectTable(state,'billing_receipts');assert.equal(state.objectId,'billing');assert.equal(state.page,'月別消込');
 state=selectScreen(state,'請求・入金');assert.equal(state.table,'billing_receipts');
 state=selectTable(state,'sessions');assert.equal(state.objectId,null);assert.equal(state.page,null);assert.match(state.notice,/未定義/);
 const production=objects.filter(o=>o.production);assert.equal(selectScreen(selectObject({},'work',production),'請求・入金',production).objectId,'work');
});
test('composite foreign keys group by declaration and sequence, not column name',()=>{
 const edges=foreignKeys([{name:'child',foreignKeys:[{id:2,seq:1,from:'org',to:'org',table:'parent'},{id:2,seq:0,from:'ref',to:'id',table:'parent'},{id:3,seq:0,from:'other',to:'id',table:'parent'}]}]);
 assert.equal(edges.length,2);assert.deepEqual(edges[0].columns.map(c=>c.from),['ref','org']);assert.notEqual(edges[0].key,edges[1].key);
});
