// Rebuild only the CHECK constraint. IDs, rows, foreign keys and triggers survive.
export function migrateCommitteeChannels(raw, schema) {
 const old=raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='committee_term_windows'").get();
 if(!old||old.sql.includes("'broadcast'"))return false;
 const definition=schema.match(/CREATE TABLE IF NOT EXISTS committee_term_windows\s*\([\s\S]*?\);/);
 if(!definition?.[0].includes("'broadcast'"))throw Error('委員会販路の移行先定義がありません');
 const before=raw.prepare('SELECT * FROM committee_term_windows ORDER BY id').all();
 const objects=raw.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='committee_term_windows' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
 const columns=raw.prepare('PRAGMA table_info(committee_term_windows)').all().map(x=>`"${x.name.replaceAll('"','""')}"`).join(',');
 const foreignKeys=raw.prepare('PRAGMA foreign_keys').get().foreign_keys;
 const legacyAlter=raw.prepare('PRAGMA legacy_alter_table').get().legacy_alter_table;
 raw.exec('PRAGMA foreign_keys=OFF');
 if(raw.prepare('PRAGMA foreign_keys').get().foreign_keys)throw Error('委員会販路の移行はトランザクション外で開始してください');
 raw.exec('PRAGMA legacy_alter_table=ON');
 raw.exec('BEGIN IMMEDIATE');
 try {
  raw.exec(definition[0].replace('IF NOT EXISTS committee_term_windows','committee_term_windows_expanded'));
  raw.exec(`INSERT INTO committee_term_windows_expanded (${columns}) SELECT ${columns} FROM committee_term_windows`);
  raw.exec('DROP TABLE committee_term_windows');
  raw.exec('ALTER TABLE committee_term_windows_expanded RENAME TO committee_term_windows');
  for(const object of objects)raw.exec(object.sql);
  const after=raw.prepare('SELECT * FROM committee_term_windows ORDER BY id').all();
  if(JSON.stringify(before)!==JSON.stringify(after)||raw.prepare('PRAGMA foreign_key_check').all().length)throw Error('委員会販路の移行照合に失敗しました');
  raw.exec('COMMIT');
  return true;
 }catch(error){raw.exec('ROLLBACK');throw error}
 finally{raw.exec(`PRAGMA legacy_alter_table=${legacyAlter?'ON':'OFF'}; PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}`)}
}
