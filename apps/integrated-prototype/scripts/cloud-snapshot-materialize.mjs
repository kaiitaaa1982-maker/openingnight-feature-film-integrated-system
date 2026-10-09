import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotTables,sha256} from '../src/cloud-analytics.mjs';
import {exportSnapshot} from './export-workbench-snapshot.mjs';

// Materialize only the fixed allowlist, without application migrations or seed data.
export async function materializeSnapshot(frozen,out){
 const {frozenHash,...payload}=frozen;
 if(frozen.formatVersion!==1||frozen.source!=='registered-synthetic-workbench'||frozen.orgId!==1||await sha256(JSON.stringify(payload))!==frozenHash)throw Error('固定入力の形式またはハッシュが一致しません');
 if(!/^[a-f0-9]{32}$/.test(frozen.runId)||!Number.isSafeInteger(frozen.auditThrough)||frozen.auditThrough<0)throw Error('固定入力の境界が不正です');
 if(Object.keys(frozen.tables).sort().join()!==Object.keys(snapshotTables).sort().join())throw Error('分析表のallowlistが一致しません');
 out=resolve(out);mkdirSync(out,{recursive:true});const path=resolve(out,'source.sqlite'),db=new DatabaseSync(path);
 try{
  db.exec('BEGIN');
  for(const [table,columnText] of Object.entries(snapshotTables)){
   const columns=columnText.split(','),source=frozen.tables[table];
   if(JSON.stringify(source.columns)!==JSON.stringify(columns)||!Array.isArray(source.rows))throw Error('分析列が一致しません: '+table);
   db.exec(`CREATE TABLE "${table}" (${columns.map(x=>'"'+x+'"').join(',')})`);
   const insert=db.prepare(`INSERT INTO "${table}" VALUES(${columns.map(()=>'?').join(',')})`);
   for(const row of source.rows){
    if(Object.keys(row).sort().join()!==[...columns].sort().join())throw Error('行の列が一致しません');
    if(columns.includes('org_id')&&row.org_id!==frozen.orgId)throw Error('別組織の行を復元できません');
    const values=columns.map(k=>row[k]);if(values.some(v=>v!==null&&!['string','number'].includes(typeof v)||typeof v==='number'&&!Number.isSafeInteger(v)))throw Error('分析入力の値が不正です');
    insert.run(...values);
   }
  }
  db.exec('CREATE TABLE audit_log(id INTEGER,org_id INTEGER)');db.prepare('INSERT INTO audit_log VALUES(?,?)').run(frozen.auditThrough,frozen.orgId);
  db.exec('COMMIT');
 }finally{db.close()}
 writeFileSync(path+'.workbench-demo.json',JSON.stringify({kind:'workbench-synthetic-v1',database:path,id:frozen.registrationId}));
 const manifest=await exportSnapshot({source:path,out,asOf:frozen.asOf});
 if(manifest.auditThrough!==frozen.auditThrough)throw Error('抽出境界が一致しません');
 Object.assign(manifest,{id:frozen.runId,frozenHash,cloudDefinitionVersion:frozen.definitionVersion,exported_at:frozen.exportedAt});
 writeFileSync(resolve(out,'snapshot.json'),JSON.stringify(manifest,null,2));return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const manifest=await materializeSnapshot(JSON.parse(readFileSync(process.argv[2],'utf8')),process.argv[3]);console.log(JSON.stringify({ok:true,id:manifest.id}))}catch(e){console.error(e.message);process.exitCode=1}
}
