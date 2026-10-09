import test from 'node:test';
import assert from 'node:assert/strict';
import {objects,impactForObject,canvasTableScope,foreignKeys} from '../src/design-model.mjs';

test('the impact map comes from the selected concept and keeps every related screen',()=>{
 const sales=objects.find(object=>object.id==='sales');
 assert.deepEqual(impactForObject('sales'),{tables:sales.tables,screens:sales.screens});
 assert.deepEqual(impactForObject('unmapped'),{tables:[],screens:[]});
 const restricted=objects.filter(object=>object.production);
 assert.deepEqual(impactForObject('sales',restricted),{tables:[],screens:[]});
});

test('ER scope uses declared FK metadata and keeps the selected table',()=>{
 const tables=[
  {name:'work',foreignKeys:[]},
  {name:'sale',foreignKeys:[{id:0,seq:0,from:'work_id',to:'id',table:'work'}]},
  {name:'invoice',foreignKeys:[{id:0,seq:0,from:'sale_id',to:'id',table:'sale'}]},
  {name:'unrelated',foreignKeys:[]},
 ];
 const edges=foreignKeys(tables);
 assert.deepEqual(canvasTableScope(tables,edges,'sale',['sale','unrelated']).map(t=>t.name),['sale','unrelated']);
 assert.deepEqual(canvasTableScope(tables,edges,'sale',[],'related').map(t=>t.name),['work','sale','invoice']);
 assert.deepEqual(canvasTableScope(tables,edges,'sale',[],'all').map(t=>t.name),tables.map(t=>t.name));
});
