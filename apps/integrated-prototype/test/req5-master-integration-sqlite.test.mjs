// 要件5のマスタ拡張（migrations/0009_req5_master_extensions.sql）のうち、SQLite・D1 の移行そのものを確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// 移行の 0001〜0008 を当てた node:sqlite の DB に 0009 を足しても既存の行が変わらず、sqlite_master の表・トリガー・索引の数が migration-manifest.json と合い、
// PRAGMA foreign_key_check が空であることを確かめる（PostgreSQL の表は pg/schema.sql で、移行は当てない）。
// 元は req5-master-integration.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR7 で分けた。中身は変えていない）
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
test('0001から0009まで空DBへ適用でき、旧DBへの0009追加は既存行を変更しない',async()=>{
    const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(':memory:');
  try{
    const dir=new URL('../migrations/',import.meta.url),files=readdirSync(dir).filter(f=>/^\d{4}.*sql$/.test(f)).sort();
    for(const f of files.filter(f=>!f.startsWith('0009'))) db.exec(readFileSync(new URL(f,dir),'utf8'));
    const before=db.prepare('SELECT * FROM organizations').all();
    db.exec(readFileSync(new URL('0009_req5_master_extensions.sql',dir),'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM organizations').all(),before);
    const counts=Object.fromEntries(db.prepare("SELECT type,COUNT(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type").all().map(r=>[r.type,r.n]));
    const manifest=JSON.parse(readFileSync(new URL('../migration-manifest.json',import.meta.url),'utf8'));
    assert.equal(counts.table+1,manifest.tables);assert.equal(counts.trigger,manifest.triggers);assert.equal(counts.index,manifest.indexes);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});
