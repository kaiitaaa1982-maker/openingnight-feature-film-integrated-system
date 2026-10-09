import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildUxMigration, UX_MIGRATION_PATH, buildR3Migration, R3_MIGRATION_PATH, buildR4Migration, R4_MIGRATION_PATH, buildR5Migration, R5_MIGRATION_PATH, buildR6Migration, R6_MIGRATION_PATH } from '../scripts/build-ux-migration.mjs';
import { R4_SQL_FILES, R5_SQL_FILES, R6_SQL_FILES } from '../src/db.mjs';

test('D1 migration 0002 matches the UX tables loaded by LocalDatabase', () => {
  assert.equal(readFileSync(UX_MIGRATION_PATH, 'utf8'), buildUxMigration(), 'node scripts/build-ux-migration.mjs で作り直す');
});

test('the UX migration only adds objects (safe to roll the Worker back)', () => {
  const sql = buildUxMigration().replace(/--[^\n]*/g, '');
  const statements = sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) {
    if (/^(BEGIN|SELECT|END)\b/i.test(statement)) continue; // トリガー本体の断片
    assert.match(statement, /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS\b/i, statement.slice(0, 120));
  }
  assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+(TABLE|INDEX|TRIGGER)\b/i);
});

test('D1 migration 0003 matches the royalty/committee/source tables loaded by LocalDatabase and only adds objects', () => {
  assert.equal(readFileSync(R3_MIGRATION_PATH, 'utf8'), buildR3Migration(), 'node scripts/build-ux-migration.mjs で作り直す');
  const sql = buildR3Migration().replace(/--[^\n]*/g, '');
  const statements = sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  assert.ok(statements.length > 0);
  for (const statement of statements) {
    if (/^(BEGIN|SELECT|END|INSERT INTO transaction_guards)\b/i.test(statement)) continue; // トリガー本体の断片
    assert.match(statement, /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS\b/i, statement.slice(0, 120));
  }
  assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+(TABLE|INDEX|TRIGGER)\b/i);
});

test('D1 migration 0004 matches the eigyo tables loaded by LocalDatabase, only adds objects and runs after 0003', () => {
  assert.equal(readFileSync(R4_MIGRATION_PATH, 'utf8'), buildR4Migration(), 'node scripts/build-ux-migration.mjs で作り直す');
  assert.ok(R4_SQL_FILES.includes('sales-ops/release-windows.sql'));
  assert.ok(R4_SQL_FILES.includes('sales-ops/partner-lists.sql'));
  assert.ok(R4_SQL_FILES.indexOf('sales-ops/release-windows.sql') < R4_SQL_FILES.indexOf('sales-ops/partner-lists.sql'), '後から足した表は一覧の後ろ');
  assert.ok(R4_SQL_FILES.indexOf('sales-ops/partner-lists.sql') < R4_SQL_FILES.indexOf('sales-sheet/sales-sheet.sql'), '売上集計シートの表は取引先別リストの後ろ');
  const sql = buildR4Migration().replace(/--[^\n]*/g, '');
  const statements = sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  assert.ok(statements.length > 0);
  const seeds = [], additions = [];
  for (const statement of statements) {
    if (/^(BEGIN|SELECT|END|INSERT INTO transaction_guards)\b/i.test(statement)) continue; // トリガー本体の断片
    // 取引先別リストの種類（配信リスト・販売リスト）は参照表の初期行。何度当てても増えない INSERT OR IGNORE だけを許す
    if (/^INSERT OR IGNORE INTO partner_list_kinds\b/i.test(statement)) { seeds.push(statement); continue; }
    // 流通マスタに後から足した流通ID（PVOD の D007）。何度当てても増えない INSERT OR IGNORE だけを許す
    if (/^INSERT OR IGNORE INTO distribution_(types|master)\b/i.test(statement)) { additions.push(statement); continue; }
    assert.match(statement, /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS\b/i, statement.slice(0, 120));
  }
  assert.equal(seeds.length, 1);
  assert.equal(additions.length, 2);
  assert.match(additions.join(' '), /'D007','配信','RS','PVOD'/);
  assert.doesNotMatch(sql, /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sales_sheet_column_versions/i, '売上集計シートの83列は移行で入れない（管理者の採用で組織ごとに入る）');
  assert.match(seeds[0], /'distribution','配信リスト'/);
  assert.match(seeds[0], /'sales','販売リスト'/);
  assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+(TABLE|INDEX|TRIGGER)\b/i);
  assert.match(R4_MIGRATION_PATH.replaceAll('\\', '/'), /migrations\/0004_eigyo_sales_sheet\.sql$/);
  for (const table of ['release_window_types', 'release_window_type_versions', 'release_window_type_fields', 'release_window_type_distributions',
    'work_release_windows', 'work_release_window_versions', 'work_release_window_field_values', 'release_window_import_previews',
    'partner_list_kinds', 'partner_lists', 'partner_list_import_batches', 'partner_list_entries', 'partner_list_entry_versions',
    'partner_list_field_definitions', 'partner_list_field_states', 'partner_list_field_values', 'partner_list_import_previews',
    'sales_sheet_column_versions', 'sale_attribute_values', 'sale_currency_versions', 'sale_royalty_basis_versions', 'sales_sheet_views', 'sales_sheet_view_versions']) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), table);
  }
});

test('D1 migration 0005 matches the proposal tables loaded by LocalDatabase, only adds objects, runs after 0004 and has no CASE in trigger bodies', () => {
  assert.equal(readFileSync(R5_MIGRATION_PATH, 'utf8'), buildR5Migration(), 'node scripts/build-ux-migration.mjs で作り直す');
  assert.match(R5_MIGRATION_PATH.replaceAll('\\', '/'), /migrations\/0005_sales_proposals\.sql$/);
  assert.deepEqual([...R5_SQL_FILES], ['sales-ops/proposal-profiles.sql']);
  const sql = buildR5Migration().replace(/--[^\n]*/g, '');
  const statements = sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  const created = {table: 0, trigger: 0, index: 0};
  for (const statement of statements) {
    if (/^(BEGIN|SELECT|END)\b/i.test(statement)) continue; // トリガー本体の断片
    const match = /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS\b/i.exec(statement);
    assert.ok(match, statement.slice(0, 120));
    created[match[1].toLowerCase().replace('unique ', '')] += 1;
  }
  assert.deepEqual(created, {table: 1, trigger: 3, index: 0});
  // 本番の wrangler d1 migrations apply はトリガー本体の CASE … END を文の終わりと読み違えて「incomplete input」で落ちる
  assert.doesNotMatch(sql, /\bCASE\b/i);
  assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+(TABLE|INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|INSERT)\b/im, '既存の行を書き換える文を入れない');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS work_proposal_profiles ('));
  assert.match(sql, /FOREIGN KEY\(org_id,work_id\) REFERENCES works\(org_id,id\)/, '組織の外の作品を指せない');
});

test('D1 migration 0006 matches the broadcast tables loaded by LocalDatabase, only adds objects and never uses CASE in a trigger body', () => {
  assert.equal(readFileSync(R6_MIGRATION_PATH, 'utf8'), buildR6Migration(), 'node scripts/build-ux-migration.mjs で作り直す');
  assert.deepEqual([...R6_SQL_FILES], ['broadcast/broadcast-windows.sql']);
  assert.match(R6_MIGRATION_PATH.replaceAll('\\', '/'), /migrations\/0006_broadcast_windows\.sql$/);
  const sql = buildR6Migration().replace(/--[^\n]*/g, '');
  const statements = sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  let triggers = 0;
  for (const statement of statements) {
    if (/^(BEGIN|SELECT|END)\b/i.test(statement)) continue; // トリガー本体の断片
    assert.match(statement, /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS\b/i, statement.slice(0, 120));
    if (/^CREATE TRIGGER/i.test(statement)) triggers += 1;
  }
  assert.equal(triggers, 7);
  // 本番の wrangler d1 migrations apply はトリガー本体の CASE … END を「incomplete input」で落とす。条件は WHEN 句に書く
  assert.doesNotMatch(sql, /\bCASE\b/i);
  assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+(TABLE|INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\s+(OR\s+\w+\s+)?(INTO\s+)?(partners|partner_list_entries|partner_list_entry_versions|broadcast_slot_versions)\b/i, '既存の表の行は書き換えない');
  for (const table of ['broadcast_station_type_versions', 'broadcast_entry_term_versions']) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), table);
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?org_id INTEGER NOT NULL`), `${table} は組織で区切る`);
  }
});

test('D1 migration 0007 matches the PL/BS tables loaded by LocalDatabase, only adds objects and has no CASE in trigger bodies', async () => {
  const {buildR7Migration, R7_MIGRATION_PATH} = await import('../scripts/build-ux-migration.mjs');
  const {R7_SQL_FILES} = await import('../src/db.mjs');
  assert.equal(readFileSync(R7_MIGRATION_PATH, 'utf8'), buildR7Migration(), 'node scripts/build-ux-migration.mjs で作り直す');
  assert.match(R7_MIGRATION_PATH.replaceAll('\\', '/'), /migrations\/0007_pl_bs\.sql$/);
  assert.deepEqual([...R7_SQL_FILES], ['pl-bs/pl-bs.sql']);
  const sql = buildR7Migration().replace(/--[^\n]*/g, '');
  const statements = sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  const created = {table: 0, trigger: 0, index: 0};
  for (const statement of statements) {
    if (/^(BEGIN|SELECT|END)\b/i.test(statement)) continue; // トリガー本体の断片
    const match = /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS\b/i.exec(statement);
    assert.ok(match, statement.slice(0, 120));
    created[match[1].toLowerCase().replace('unique ', '')] += 1;
  }
  // 法人情報の版・勘定科目・手入力の額・経費の出金・出資の払込の5表。manifest（0007 まで 211表・397トリガー・47索引）は 0005（1表・3トリガー）・0006（2表・7トリガー）とこの分を足した数
  // （手入力の額の消費税額 tax_yen と、現預金を動かさない科目に税額を入れないトリガーを含む）
  assert.deepEqual(created, {table: 5, trigger: 16, index: 7});
  assert.match(sql, /tax_yen INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /CHECK\(kind='flow' OR tax_yen=0\)/);
  assert.match(sql, /o\.tax_yen=-NEW\.tax_yen/, '取消の行は税額の符号も逆');
  assert.match(sql, /CREATE TRIGGER IF NOT EXISTS gl_manual_amounts_tax_cash BEFORE INSERT ON gl_manual_amounts/);
  assert.doesNotMatch(sql, /\bCASE\b/i, '本番の wrangler d1 migrations apply はトリガー本体の CASE … END で落ちる');
  assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+(TABLE|INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|INSERT)\b/im, '既存の行を書き換える文・初期行を入れない（勘定科目の初期値は管理者が組織に足す）');
  for (const table of ['org_profile_versions', 'gl_accounts', 'gl_manual_amounts', 'expense_payments', 'committee_investment_payments']) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), table);
    assert.ok(sql.includes(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}`), `${table} は変更できない`);
    assert.ok(sql.includes(`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}`), `${table} は削除できない`);
  }
  // 組織の外の行を指せない（org_id を含む複合キー）
  assert.match(sql, /FOREIGN KEY\(org_id,self_partner_id\) REFERENCES partners\(org_id,id\)/);
  assert.match(sql, /FOREIGN KEY\(org_id,expense_id\) REFERENCES expenses\(org_id,id\)/);
  assert.match(sql, /FOREIGN KEY\(org_id,term_version_id,partner_id\) REFERENCES committee_term_investments\(org_id,term_version_id,partner_id\)/);
  assert.match(sql, /FOREIGN KEY\(org_id,work_id\) REFERENCES works\(org_id,id\)/);
});

test('D1 migration 0008 matches the broadcast proposal draft tables loaded by LocalDatabase, only adds objects and has no CASE in trigger bodies', async () => {
  const {buildR8Migration, R8_MIGRATION_PATH} = await import('../scripts/build-ux-migration.mjs');
  const {R8_SQL_FILES} = await import('../src/db.mjs');
  assert.equal(readFileSync(R8_MIGRATION_PATH, 'utf8'), buildR8Migration(), 'node scripts/build-ux-migration.mjs で作り直す');
  assert.match(R8_MIGRATION_PATH.replaceAll('\\', '/'), /migrations\/0008_broadcast_proposal_drafts\.sql$/);
  assert.deepEqual([...R8_SQL_FILES], ['broadcast/proposal-drafts.sql']);
  const sql = buildR8Migration().replace(/--[^\n]*/g, '');
  const statements = sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  const created = {table: 0, trigger: 0, index: 0};
  for (const statement of statements) {
    if (/^(BEGIN|SELECT|END)\b/i.test(statement)) continue; // トリガー本体の断片
    const match = /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS\b/i.exec(statement);
    assert.ok(match, statement.slice(0, 120));
    created[match[1].toLowerCase().replace('unique ', '')] += 1;
  }
  // 提案の記録・削除の記録の2表。トリガーは変更・削除の禁止（各2）、提案は新しい下書きの枠にだけ、削除は下書きの次の中止の版だけ（売上を紐付けた枠は除く）、
  // 削除した枠に版を積まない、削除した枠に売上を紐付けない
  assert.deepEqual(created, {table: 2, trigger: 8, index: 0});
  assert.doesNotMatch(sql, /\bCASE\b/i, '本番の wrangler d1 migrations apply はトリガー本体の CASE … END で落ちる');
  assert.doesNotMatch(sql, /\b(DROP|ALTER)\s+(TABLE|INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|INSERT)\b/im, '既存の行を書き換える文・初期行を入れない');
  for (const table of ['broadcast_proposal_drafts', 'broadcast_proposal_draft_deletions']) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), table);
    assert.ok(sql.includes(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}`), `${table} は変更できない`);
    assert.ok(sql.includes(`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}`), `${table} は削除できない`);
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?org_id INTEGER NOT NULL`), `${table} は組織で区切る`);
  }
  // 組織の外の行を指せない（org_id を含む複合キー）
  assert.match(sql, /FOREIGN KEY\(org_id,work_id,slot_id\) REFERENCES broadcast_slots\(org_id,work_id,id\)/);
  assert.match(sql, /FOREIGN KEY\(org_id,station_partner_id\) REFERENCES partners\(org_id,id\)/);
  assert.match(sql, /FOREIGN KEY\(org_id,product_id\) REFERENCES products\(org_id,id\)/);
  assert.match(sql, /FOREIGN KEY\(org_id,slot_id,revision\) REFERENCES broadcast_slot_versions\(org_id,slot_id,revision\)/);
  // 既存の放送枠の版の表には、トリガーを足すだけ（行は書き換えない）
  assert.match(sql, /CREATE TRIGGER IF NOT EXISTS broadcast_slot_versions_not_deleted BEFORE INSERT ON broadcast_slot_versions/);
  assert.match(sql, /CREATE TRIGGER IF NOT EXISTS broadcast_sale_links_not_deleted_draft BEFORE INSERT ON broadcast_sale_links/);
  assert.match(sql, /broadcast_proposal_draft_deletions_draft_only[\s\S]*?OR EXISTS\(SELECT 1 FROM broadcast_sale_links l WHERE l\.org_id=NEW\.org_id AND l\.slot_id=NEW\.slot_id\) BEGIN/, '売上を紐付けた枠は削除の記録を付けられない');
  const manifest = JSON.parse(readFileSync(new URL('../migration-manifest.json', import.meta.url), 'utf8'));
  // 最新の移行までの合計。0009 まで（221表・427トリガー・47索引）に、0010（依頼6の経費と会計）の36表・113トリガー・77索引と、
  // 0011（分析の写しのジョブ。PG 計画 段2の準備 論点7）の2表・1索引を足した数
  assert.deepEqual(manifest, {tables: 259, triggers: 540, indexes: 125, views: 0});
});

test('D1 migration 0009 is additive, immutable, scoped and identical to local master SQL',async()=>{
  const {buildR9Migration,R9_MIGRATION_PATH}=await import('../scripts/build-ux-migration.mjs');
  const {LocalDatabase}=await import('../src/db.mjs');
  const sql=buildR9Migration();assert.equal(readFileSync(R9_MIGRATION_PATH,'utf8'),sql);
  const bare=sql.replace(/--[^\n]*/g,'');assert.doesNotMatch(bare,/\bCASE\b|\bALTER\b|\bDROP\b/i);
  assert.doesNotMatch(bare,/^\s*(UPDATE|DELETE|INSERT)\s/im);
  const tables=[...bare.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m=>m[1]);assert.equal(tables.length,8);
  assert.equal([...bare.matchAll(/CREATE TRIGGER IF NOT EXISTS/g)].length,22);
  const db=new LocalDatabase(':memory:');try{
    db.raw.exec(sql);db.raw.exec(sql);
    for(const table of tables){assert.ok((await db.all(`PRAGMA table_info(${table})`)).some(c=>c.name==='org_id'));assert.match(sql,new RegExp(`${table}_no_update`));assert.match(sql,new RegExp(`${table}_no_delete`));}
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
  }finally{db.close();}
});
