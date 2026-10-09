// Local preparation and real D1 runtime verification. No remote calls.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {reportCompletionFixture} from '../test/report-completion-fixture.mjs';
const out=resolve('data/human-workflow-migration');mkdirSync(out,{recursive:true});
const fixture=await reportCompletionFixture({includeBroadcast:false}),raw=fixture.db.raw;
const schema=raw.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const signature=rows=>createHash('sha256').update(JSON.stringify(rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort())).digest('hex');
const table=schema.find(s=>s.name==='committee_term_windows'),columns=raw.prepare('PRAGMA table_info(committee_term_windows)').all().map(c=>quote(c.name)).join(',');
const triggers=schema.filter(s=>s.type==='trigger'&&s.sql.includes('committee_term_windows'));
const steps=['PRAGMA defer_foreign_keys=ON',...triggers.map(t=>'DROP TRIGGER '+quote(t.name)),table.sql.replace('committee_term_windows','committee_term_windows_expanded'),`INSERT INTO committee_term_windows_expanded(${columns}) SELECT ${columns} FROM committee_term_windows`,'DROP TABLE committee_term_windows','ALTER TABLE committee_term_windows_expanded RENAME TO committee_term_windows',...triggers.map(t=>t.sql),'PRAGMA defer_foreign_keys=OFF'];
const additive=['production.sql','broadcast.sql','report-dimensions.sql','rights-payments.sql','committee-finance.sql'];
const migration=steps.map(s=>s+';').join('\n')+'\n'+additive.map(name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8')).join('\n');
writeFileSync(resolve(out,'migration.sql'),migration);
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'migration',compatibilityDate:'2026-09-01',modules:true,script:'export default {fetch(){return new Response("local migration test")}}',d1Databases:{DB:'human-workflow-migration-test'}}]}));
try{
 const d1=await mf.getD1Database('DB');
 const definitions=schema.filter(s=>s.type==='table').map(t=>d1.prepare(t.name==='committee_term_windows'?t.sql.replace("'theatrical','digital','package','broadcast','other'","'theatrical','digital','package'"):t.sql));
 await d1.batch(definitions);
 await d1.batch(schema.filter(s=>s.type==='index').map(s=>d1.prepare(s.sql)));
 const insert=[d1.prepare('PRAGMA defer_foreign_keys=ON')],before={};
 for(const table of schema.filter(s=>s.type==='table')){
  const rows=raw.prepare(`SELECT * FROM ${quote(table.name)}`).all();before[table.name]={count:rows.length,sha256:signature(rows)};
  for(const row of rows){const names=Object.keys(row);insert.push(d1.prepare(`INSERT INTO ${quote(table.name)}(${names.map(quote).join(',')}) VALUES(${names.map(()=>'?').join(',')})`).bind(...Object.values(row)))}
 }
 insert.push(d1.prepare('PRAGMA defer_foreign_keys=OFF'));await d1.batch(insert);
 await d1.batch(schema.filter(s=>s.type==='trigger').map(s=>d1.prepare(s.sql)));
 await d1.batch(steps.map(sql=>d1.prepare(sql)));
 for(const table of schema.filter(s=>s.type==='table')){
  const rows=(await d1.prepare(`SELECT * FROM ${quote(table.name)}`).all()).results;
  if(rows.length!==before[table.name].count||signature(rows)!==before[table.name].sha256)throw Error('移行前後の行が一致しません: '+table.name);
 }
 if((await d1.prepare('PRAGMA foreign_key_check').all()).results.length)throw Error('移行後の外部キー検査失敗');
 const triggerNames=(await d1.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()).results.map(r=>r.name).sort();
 if(JSON.stringify(triggerNames)!==JSON.stringify(schema.filter(s=>s.type==='trigger').map(s=>s.name).sort()))throw Error('移行後のトリガーが一致しません');
 const migrated=(await d1.prepare("SELECT sql FROM sqlite_master WHERE name='committee_term_windows'").first()).sql;
 if(!migrated.includes("'broadcast'"))throw Error('放送の制約拡張が反映されません');
 const result={verified:true,runtime:'Miniflare D1',syntheticOnly:true,tables:Object.keys(before).length,snapshots:before.committee_report_snapshots.count,rowsPreserved:true,triggersPreserved:true,foreignKeyViolations:0,sqlSha256:createHash('sha256').update(migration).digest('hex'),remoteApplied:false};
 writeFileSync(resolve(out,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await mf.dispose();fixture.db.close()}

