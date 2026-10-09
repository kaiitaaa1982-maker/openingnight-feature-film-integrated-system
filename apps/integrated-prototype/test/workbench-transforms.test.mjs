import test from 'node:test';
import assert from 'node:assert/strict';
import {executeTransform} from '../src/transforms/engine.mjs';
const s=(operation,parameters)=>({operation,parameters});
test('saved basic steps preserve codes and expose prefix results without mutating input',()=>{
 const input=[{code:'001',label:'映画:A',amount:'12',quantity:'2'},{code:'002',label:'映画:B',amount:'8',quantity:'3'}];
 const steps=[s('select',{columns:['code','label','amount','quantity']}),s('rename',{mapping:{amount:'unit'}}),s('type',{column:'unit',type:'integer'}),s('type',{column:'quantity',type:'integer'}),s('split',{column:'label',delimiter:':',into:['kind','name']}),s('replace',{column:'kind',from:'映画',to:'作品'}),s('concat',{columns:['kind','name'],separator:'・',into:'title'}),s('calculate',{columns:['unit','quantity'],operator:'multiply',into:'total'}),s('filter',{column:'unit',operator:'gte',value:10}),s('sort',{by:[{column:'total',direction:'desc'}]})];
 const out=executeTransform(input,steps);assert.equal(out.rows.length,1);assert.equal(out.rows[0].code,'001');assert.equal(out.rows[0].total,24);assert.equal(out.rows[0].title,'作品・A');assert.equal(input[0].amount,'12');assert.equal(executeTransform(input,steps.slice(0,3)).rows.length,2);
});
test('join, append and explicit dedupe have independent expected rows and lineage',()=>{
 const rows=[{id:1,value:10},{id:2,value:20}];const out=executeTransform(rows,[s('join',{lookup:'master',leftKey:'id',rightKey:'id',kind:'left',columns:['name']})],{lookups:{master:[{id:1,name:'A'}]}});
 assert.deepEqual(out.rows.map(r=>r.master_name),['A',null]);assert.equal(out.lineage[0].sources.length,2);
 assert.throws(()=>executeTransform(rows,[s('join',{lookup:'master',leftKey:'id',kind:'left'})],{lookups:{master:[{id:1},{id:1}]}}),/重複/);
 const appended=executeTransform(rows,[s('append',{dataset:'more'}),s('dedupe',{columns:['id'],keep:'first'})],{lookups:{more:[{id:2,value:20},{id:3,value:30}]}});assert.deepEqual(appended.rows.map(r=>r.value),[10,20,30]);assert.equal(appended.traces[1].beforeRows,4);assert.equal(appended.traces[1].afterRows,3);
});
test('group and pivot/unpivot conserve independently calculated totals',()=>{
 const rows=[{work:'A',month:'Jul',amount:10},{work:'A',month:'Jul',amount:5},{work:'A',month:'Aug',amount:20},{work:'B',month:'Jul',amount:7}];
 const grouped=executeTransform(rows,[s('group',{by:['work','month'],aggregates:[{column:'amount',operation:'sum',into:'amount'}]})]);assert.equal(grouped.rows.reduce((a,r)=>a+r.amount,0),42);assert.equal(grouped.rows[0].amount,15);
 const roundtrip=executeTransform(grouped.rows,[s('pivot',{by:['work'],keyColumn:'month',valueColumn:'amount'}),s('unpivot',{fixed:['work'],columns:['Jul','Aug'],keyInto:'month',valueInto:'amount'})]);assert.equal(roundtrip.rows.reduce((a,r)=>a+(r.amount||0),0),42);assert.ok(roundtrip.lineage.every(r=>r.sources.length));
});
