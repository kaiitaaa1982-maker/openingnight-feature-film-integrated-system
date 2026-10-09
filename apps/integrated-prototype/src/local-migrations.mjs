// Rebuild only the four enum-constrained tables; retain every original column, row, index and trigger.
// This local migration is intentionally not imported by the Cloudflare Worker.
export function migrateReportFamilies(raw){
 if(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_report_selections'").get()&&!raw.prepare('PRAGMA table_info(workflow_report_selections)').all().some(c=>c.name==='source_rows_json'))raw.exec("ALTER TABLE workflow_report_selections ADD COLUMN source_rows_json TEXT NOT NULL DEFAULT '[]'");
 const changes=new Map([
  ['workflow_report_selections',[', UNIQUE(org_id,artifact_id,canonical_sha256)','']],
  ['products',["'theatrical','digital','package','license','other'","'theatrical','digital','package','broadcast','license','other'"]],
  ['report_imports',["'theatrical','digital','package','publicity'","'theatrical','digital','package','broadcast','other','publicity'"]],
  ['report_mapping_profiles',["'theatrical','digital','package'","'theatrical','digital','package','broadcast','other'"]],
  ['mapping_import_provenance',["'theatrical','digital','package'","'theatrical','digital','package','broadcast','other'"]]
 ]);
 const pending=[...changes].flatMap(([name,[oldValues,newValues]])=>{const row=raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);return row&&row.sql.includes(oldValues)?[{name,sql:row.sql.replace(oldValues,newValues)}]:[]});
 if(!pending.length)return;
 const triggers=raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all();
 raw.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
 try{
  for(const t of triggers)raw.exec(`DROP TRIGGER "${t.name.replaceAll('"','""')}"`);
  for(const t of pending){
   const indexes=raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(t.name);
   const temp=`migration_${t.name}`,create=t.sql.replace(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ["\x60]?${t.name}["\x60]?`,'i'),`CREATE TABLE ${temp}`);
   raw.exec(`${create}; INSERT INTO ${temp} SELECT * FROM ${t.name}; DROP TABLE ${t.name}; ALTER TABLE ${temp} RENAME TO ${t.name};`);
   for(const index of indexes)raw.exec(index.sql);
  }
  for(const t of triggers)raw.exec(t.sql);
  if(raw.prepare('PRAGMA foreign_key_check').all().length)throw Error('Report-family migration foreign keys failed');
  raw.exec('COMMIT');
 }catch(e){raw.exec('ROLLBACK');throw e}finally{raw.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON')}
}
