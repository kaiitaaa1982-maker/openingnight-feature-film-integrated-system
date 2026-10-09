// 手元の SQLite のファイルに書いた入力が、DB を開き直しても残ることを確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// SQLite のファイルを LocalDatabase で2回開く（PostgreSQL の試験の DB は試験ごとに作って消すので、開き直しは組めない）。
// 元は app.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR7 で分けた。中身は変えていない。login・req・read は app.test.mjs と同じ道具）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDatabase } from '../src/db.mjs';
import { createApp } from '../src/app.mjs';

async function login(app,email='admin@openingnight.invalid'){
  const response=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
  assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
}
const req=(app,path,cookie,options={})=>app.request(`/api${path}`,{...options,headers:{...(options.body?{'content-type':'application/json'}:{}),cookie,...(options.headers||{})}});
const read=async response=>({status:response.status,body:await response.json()});
test('SQLite persists user input across a database restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'on-integrated-')),file=join(dir,'db.sqlite');
  let db=new LocalDatabase(file),app=createApp({db,mode:'local'}),cookie=await login(app);
  const created=await read(await req(app,'/scenes',cookie,{method:'POST',body:JSON.stringify({project_id:1,work_id:1,scene_no:'T-101',day_night:'D',location:'架空港',synopsis:'再起動試験',status:'draft'})}));
  assert.equal(created.status,201);db.close();
  db=new LocalDatabase(file);assert.equal((await db.get("SELECT count(*) AS n FROM scenes WHERE scene_no='T-101'")).n,1);db.close();rmSync(dir,{recursive:true,force:true});
});
