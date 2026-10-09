// Preserve the first local MG prototype's rows while expanding close-day support.
export function migrateMgCloseDays(raw, schema) {
 const old=raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mg_version_phases'").get();
 if(!old?.sql.includes("close_day IN ('28','29','30','31','eom')"))return false;
 const definition=schema.match(/CREATE TABLE IF NOT EXISTS mg_version_phases\s*\([\s\S]*?\);/);
 if(!definition)throw Error('MG日程の移行先定義がありません');
 const before=raw.prepare('SELECT * FROM mg_version_phases ORDER BY id').all();
 const columns=raw.prepare('PRAGMA table_info(mg_version_phases)').all().map(x=>`"${x.name.replaceAll('"','""')}"`).join(',');
 raw.exec('BEGIN IMMEDIATE');
 try{
  raw.exec(definition[0].replace('IF NOT EXISTS mg_version_phases','mg_version_phases_expanded'));
  raw.exec(`INSERT INTO mg_version_phases_expanded (${columns}) SELECT ${columns} FROM mg_version_phases`);
  raw.exec('DROP TABLE mg_version_phases; ALTER TABLE mg_version_phases_expanded RENAME TO mg_version_phases;');
  raw.exec(schema);
  const after=raw.prepare('SELECT * FROM mg_version_phases ORDER BY id').all();
  if(JSON.stringify(before)!==JSON.stringify(after)||raw.prepare('PRAGMA foreign_key_check').all().length)throw Error('MG日程の移行照合に失敗しました');
  raw.exec('COMMIT');
  return true;
 }catch(error){raw.exec('ROLLBACK');throw error}
}
