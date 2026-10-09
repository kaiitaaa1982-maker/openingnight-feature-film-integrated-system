#!/usr/bin/env node
// 架空データ（組織 DEMO-SALES）の seed を、決まった順にまとめて流す。流す順の正本はこのファイルの DEMO_SEED_STEPS。
//   1. 売上（計上・MG・ロイヤリティ・製作委員会）… scripts/seed-sales-demo.mjs
//   2. 売上の流通の分類（旧区分 → 流通マスタの流通ID）… scripts/seed-sales-distribution.mjs
//      （2026-09-25 に旧区分で入れた DB だけ新しい版を足して付け替える。1 が最初から流通マスタの ID で分類した DB では何もしない）
//   3. 制作（台本の取込・香盤・日々スケ）… scripts/seed-kouban-demo.mjs
//   4. 営業基幹（全作品のウィンドウ・取引先別リスト・売上集計シート・提案資料）… scripts/seed-eigyo-demo.mjs（連続ドラマのウィンドウは 3 の後だと入る）
//   5. 番販・放送（放送履歴表・アベイルズリスト・放送ウィンドウ提案と、提案から作った下書き）… scripts/seed-broadcast-demo.mjs（4 の後）
//   6. PL・BS（管理会計の試算）… scripts/seed-plbs-demo.mjs（公開月は 4 の劇場公開の窓から取る）
// 使い方: node scripts/seed-all-demo.mjs --db <SQLiteのパス> [--as-of 2026-09-25] [--twice] [--record <書き込みの記録.jsonl>] [--only <節,…>] [--check-api]
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番のD1・Cloudflare・設定・秘密値には触れない。
// ・どの seed も目印で「もうあるか」を確かめるので、何度流しても増えない。--twice は続けてもう1回流し、表ごとの行数が変わらず、
//   ログイン（sessions）のほかに何も書かないことを確かめる（変わったら終了コード1）。
// ・--record は、API が発行した書き込みを batch の区切りのまま JSON Lines に記録する（1行目は見出し、2行目から {step, statements}）。
//   ローカルのログイン（sessions）は記録しない。本番へ入れるときは、本番DBの写し（手元の SQLite）の上でこれを流して記録し、
//   D1 の上限（DDL なし・1文の値は100個まで・1回の batch は480文まで・1つの値は128KB未満）を満たすことをここで確かめてから、
//   記録を本番へ入れる。本番へは scripts/seed-record-to-sql.mjs で SQL ファイルにし、写しの複製で試してから代表が当てる
//   （このスクリプトは本番に当てない。本番の部品で包んだ D1 に batch で当てる関数 replaySeedRecord も下にある）。
//   --record のときは写しを「表の定義も試作用の行も流さずに」開く（写しに行を黙って足すと、記録の ID が本番とずれて再生が止まる）。
//   写しが最新の移行まで当たっていなければ止める。見出しには写しの指紋（表ごとの行数・rowid の別名のある表の最大の rowid・主な表の最大ID・
//   利用者と組織の一覧）を入れ、再生の前に本番の指紋と照らし合わせる（合わなければ1文も当てない。写しを取り直して記録し直す）。
//   見出しの after は流した後の写しの指紋。記録を SQL ファイルにする scripts/seed-record-to-sql.mjs が、ファイルの最後で
//   「記録どおりの件数・ID になったか」を確かめる文にする（本番へは wrangler d1 execute --remote --file で当てる。req4-integration.md §3）。
// ・--check-api は、流した後に架空の管理者で各画面の API（デモ資料の組織判定・提案資料・放送履歴表・アベイルズリスト・放送ウィンドウ提案・提案から作った下書き・PL・BS・
//   売上集計シート・売上集計シートの流通ID・香盤）を読み、数字が返ることを確かめる。読むだけで、ログインのほかは書かないことも確かめる。
//   流通IDは、seed が旧区分で入れた分類が残っていない（0行）ことを確かめる。利用者が画面で旧区分のまま分類し直した明細は付け替えない
//   （seed-sales-distribution.mjs）ので NG にせず、件数と売上IDを出す（直すなら帳票センターの流通の分類で流通マスタの ID を選び直す）。
//   --only で付け替えの節（distribution）を外したときは、seed が旧区分で入れた分類が残っていても NG にしない（件数を出す）。
//   付け替えは新しい Worker の配備の後に別の記録（--only distribution）で入れるため（req4-integration.md §3）。
// ・台本PDFの読み取り（3）にローカルの Python（ON_PYTHON、無ければ python / python3）を使う。
import {writeFileSync, readdirSync, readFileSync, existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {basename, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {PG_FINGERPRINT_TABLE} from '../src/data-platform/pg-fingerprint.mjs';
import {createApp} from '../src/app.mjs';
import {SALES_DEMO, seedSalesDemo, addMonths} from './seed-sales-demo.mjs';
import {reclassifyDemoSalesDistribution, reclassifyTargets} from './seed-sales-distribution.mjs';
import {seedKoubanDemo} from './seed-kouban-demo.mjs';
import {seedEigyoDemo} from './seed-eigyo-demo.mjs';
import {seedBroadcastDemo} from './seed-broadcast-demo.mjs';
import {seedPlbsDemo} from './seed-plbs-demo.mjs';
import {seedExpenseDemo, seedExpenseOriginalsDemo} from './seed-expense-demo.mjs';
import {seedMasterDemo} from './seed-master-demo.mjs';
import {draftCountsText} from '../src/broadcast/proposal-draft-model.mjs';

export const D1_LIMITS = Object.freeze({paramsPerStatement: 100, statementsPerBatch: 480, valueBytes: 128 * 1024});
export const SEED_RECORD_FORMAT = 'openingnight-seed-record';

// skipped(result) は「入れ済みで何もしなかった」か。seed ごとに返す形が違うので、ここでそろえる
export const DEMO_SEED_STEPS = Object.freeze([
  {key: 'sales', label: '売上（計上・MG・ロイヤリティ・製作委員会）', script: 'scripts/seed-sales-demo.mjs',
    run: (db, {asOf, log}) => seedSalesDemo(db, {asOf, log}), skipped: (result) => result?.skipped === true},
  {key: 'distribution', label: '売上の流通の分類（旧区分 → 流通マスタの流通ID）', script: 'scripts/seed-sales-distribution.mjs',
    run: (db, {log}) => reclassifyDemoSalesDistribution(db, {log}), skipped: (result) => result?.skipped === true},
  {key: 'kouban', label: '制作（台本の取込・香盤・日々スケ）', script: 'scripts/seed-kouban-demo.mjs',
    run: (db, {python, log}) => seedKoubanDemo(db, python ? {python, log} : {log}), skipped: (result) => result?.skipped === true},
  {key: 'eigyo', label: '営業基幹（ウィンドウ・取引先別リスト・売上集計シート・提案資料）', script: 'scripts/seed-eigyo-demo.mjs',
    run: (db, {log}) => seedEigyoDemo(db, {log}), skipped: (result) => ['windows', 'partnerLists', 'salesSheet', 'proposals'].every((key) => result?.[key]?.skipped === true)},
  {key: 'broadcast', label: '番販・放送（放送履歴表・アベイルズリスト・放送ウィンドウ提案）', script: 'scripts/seed-broadcast-demo.mjs',
    run: (db, {log}) => seedBroadcastDemo(db, {log}), skipped: (result) => result?.skipped === true},
  // PL・BS は入れた節だけを返す（入れ済みなら orgId と件数だけ）
  {key: 'plbs', label: 'PL・BS（管理会計の試算）', script: 'scripts/seed-plbs-demo.mjs',
    run: (db, {log}) => seedPlbsDemo(db, {log}), skipped: (result) => Boolean(result) && Object.keys(result).every((key) => key === 'orgId' || key === 'counts')},
  {key:'expenses',label:'経費・請求書・会計',script:'scripts/seed-expense-demo.mjs',run:(db,{log})=>seedExpenseDemo(db,{log}),skipped:result=>result?.skipped===true},
  {key: 'masters', label: '作品・商品マスタ（契約・費用・権利元・仕様）', script: 'scripts/seed-master-demo.mjs',
    run: (db, {log}) => seedMasterDemo(db, {log}), skipped: (result) => result?.skipped === true},
  // 原本（本番では R2 に置く列）を書く節。本番へ入れる架空データの SQL にできないので、本番の記録では --only から外す（runbook 07 の 3-7b）
  {key: 'expense-originals', label: '経費の原本の例（架空の領収書。本番は画面から入れる）', script: 'scripts/seed-expense-demo.mjs',
    run: (db, {log}) => seedExpenseOriginalsDemo(db, {log}), skipped: (result) => result?.skipped === true},
].map((step) => Object.freeze(step)));

// 文のコメント（-- から行末まで・/* … */）を1つの空白に置き換え、前後の空白を削る。文字（'…'）と名前（"…"・`…`・[…]）の中はそのまま。
// 閉じていない /* は SQLite と同じく文の終わりまでをコメントとみなす。文の種類（定義の文か・sessions への書き込みか）を、
// 先頭や途中のコメントに隠されずに見るために使う（seed-record-to-sql.mjs の bindValues もコメントを外した文を返す）
export function sqlWithoutComments(sql) {
  const text = String(sql);
  if (!text.includes('--') && !text.includes('/*')) return text.trim();
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === close) { if (close !== ']' && text[j + 1] === close) { j += 2; continue; } break; }
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; out += ' '; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; out += ' '; continue; }
    out += c;
    i += 1;
  }
  return out.trim();
}

// ローカルのログインが書く行。本番の認証（Cloudflare Access）とは別なので、記録にも「2回目は書かない」の判定にも入れない。
// コメントを外してから見る（先頭や途中のコメントで見逃さない）。表の名前は引用符つき・main. つきも同じに扱う
const SESSION_WRITE = /^(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(\s+OR\s+\w+)?)\s+(main\s*\.\s*)?("sessions"|`sessions`|\[sessions\]|sessions)(?![\w$])/i;
export const isSessionWrite = (sql) => SESSION_WRITE.test(sqlWithoutComments(sql));
// 定義・設定の文（D1 の記録に入れない）。これもコメントを外してから見る
const DEFINITION_STATEMENT = /^(CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM)\b/i;

// 行を返す書き込みの文（INSERT … RETURNING id を get で受け取る形。docs/rules/dialect.md）。コメントを外してから見る
const WRITE_STATEMENT = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i;
export const isWriteStatement = (sql) => WRITE_STATEMENT.test(sqlWithoutComments(sql));

// 書き込みを記録する DB。読み込みはそのまま渡し、run と batch と、get・all で流した書き込みの文を「どの seed の、どの batch か」ごとに残す
export function recordingDatabase(db) {
  const single = (sql, params) => recorder.batches.push({step: recorder.step, statements: [{sql, params: [...params]}]});
  const recorder = {
    step: null,
    batches: [],
    // DB の種類の印（PostgreSQL の入口の dialect）をそのまま見せる（tableCounts・ER 図の表の定義が読み方を分ける）
    get dialect() { return db.dialect; },
    all: (sql, params = []) => { if (isWriteStatement(sql)) single(sql, params); return db.all(sql, params); },
    get: (sql, params = []) => { if (isWriteStatement(sql)) single(sql, params); return db.get(sql, params); },
    readBatch: (statements) => db.readBatch(statements),
    run: (sql, params = []) => {
      single(sql, params);
      return db.run(sql, params);
    },
    batch: (statements) => {
      recorder.batches.push({step: recorder.step, statements: statements.map((s) => ({sql: s.sql, params: [...(s.params || [])]}))});
      return db.batch(statements);
    },
    close: () => db.close(),
  };
  return recorder;
}

// 記録から sessions の書き込みを除いた batch（空になった batch も除く）
export function businessBatches(batches) {
  return batches.map((batch) => ({...batch, statements: batch.statements.filter((s) => !isSessionWrite(s.sql))})).filter((batch) => batch.statements.length > 0);
}

const valueBytes = (value) => {
  if (typeof value === 'string') return new TextEncoder().encode(value).length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return 0;
};

// D1 の上限に触れる書き込み。どれも無ければ空の配列
export function d1LimitViolations(batches, limits = D1_LIMITS) {
  const out = [];
  for (const batch of batches) {
    if (batch.statements.length > limits.statementsPerBatch) out.push(`${batch.step}: 1回の batch が ${batch.statements.length}文（上限 ${limits.statementsPerBatch}文）`);
    for (const {sql, params} of batch.statements) {
      const bare = sqlWithoutComments(sql);
      const head = bare.replace(/\s+/g, ' ').slice(0, 80);
      if (DEFINITION_STATEMENT.test(bare)) out.push(`${batch.step}: DDL・設定の文 ${head}`);
      if (params.length > limits.paramsPerStatement) out.push(`${batch.step}: 値が ${params.length}個の文（上限 ${limits.paramsPerStatement}個） ${head}`);
      for (const value of params) if (valueBytes(value) >= limits.valueBytes) out.push(`${batch.step}: 128KB以上の値（${valueBytes(value)}バイト） ${head}`);
    }
  }
  return out;
}

// JSON にできない値（バイナリ・bigint）を印つきで残す
const encodeValue = (value) => {
  if (value instanceof Uint8Array) return {$base64: Buffer.from(value).toString('base64')};
  if (typeof value === 'bigint') return {$bigint: value.toString()};
  return value;
};

export function recordLines(batches, meta) {
  const head = JSON.stringify({format: SEED_RECORD_FORMAT, version: 1, ...meta});
  return [head, ...batches.map((batch) => JSON.stringify({step: batch.step, statements: batch.statements.map((s) => ({sql: s.sql, params: s.params.map(encodeValue)}))}))].join('\n') + '\n';
}

// 表ごとの行数（sessions は数えない）。PostgreSQL の入口（dialect が 'postgres'）は、いまの schema の表を pg_catalog から読む
// （PostgreSQL だけにある版の印の表 PG_FINGERPRINT_TABLE は数えない。SQLite と同じ表の一覧にする）
const PG_TABLES = `SELECT c.relname AS name FROM pg_class c WHERE c.relkind IN ('r', 'p') AND c.relnamespace = current_schema()::regnamespace AND c.relname NOT LIKE 'sqlite_%' AND c.relname NOT LIKE '_cf_%' AND c.relname<>'sessions' AND c.relname<>'${PG_FINGERPRINT_TABLE}' ORDER BY c.relname COLLATE "C"`;
export async function tableCounts(db) {
  const tables = await db.all(db?.dialect === 'postgres' ? PG_TABLES : "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'sessions' ORDER BY name");
  const counts = {};
  for (const {name} of tables) counts[name] = Number((await db.get(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)).n);
  return counts;
}

// ---------- 本番の写しの上で記録する ----------
const appDir = fileURLToPath(new URL('..', import.meta.url));
const migrationNames = () => readdirSync(resolve(appDir, 'migrations')).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
// 写しが最新の移行まで当たっているか。raw は node:sqlite の DatabaseSync。
// d1_migrations に migrations/ の全ファイル名がある（wrangler で当てた D1 の写し）か、表・トリガー・索引の数が migration-manifest.json と同じ
export function copyReadiness(raw) {
  const has = (name) => Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!has('organizations') || !has('users')) return {ok: false, reason: '表がありません（本番の写しではないか、移行を当てていません）'};
  if (has('d1_migrations')) {
    const applied = new Set(raw.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name));
    const missing = migrationNames().filter((name) => !applied.has(name));
    return missing.length ? {ok: false, reason: `当たっていない移行があります: ${missing.join('、')}`} : {ok: true, by: 'd1_migrations'};
  }
  const manifest = JSON.parse(readFileSync(resolve(appDir, 'migration-manifest.json'), 'utf8'));
  const count = (type) => Number(raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations'`).get(type).n);
  // manifest の表の数は D1 の d1_migrations を含む（ここでは d1_migrations の無い写しなので1つ足して比べる）
  const actual = {tables: count('table') + 1, triggers: count('trigger'), indexes: count('index')};
  const same = actual.tables === manifest.tables && actual.triggers === manifest.triggers && actual.indexes === manifest.indexes;
  return same ? {ok: true, by: 'manifest'} : {ok: false, reason: `表・トリガー・索引の数が移行と合いません（写し ${JSON.stringify(actual)}・移行 ${JSON.stringify({tables: manifest.tables, triggers: manifest.triggers, indexes: manifest.indexes})}）`};
}

// 写しを、表の定義も試作用の行も流さずに開く。開く前後で行数が変わったら止める（写しに行を黙って足さない）
export async function openRecordingCopy(path) {
  if (!existsSync(path)) throw new Error(`写しがありません: ${path}`);
  const probe = new DatabaseSync(path, {readOnly: true});
  let before;
  try {
    const ready = copyReadiness(probe);
    if (!ready.ok) throw new Error(`本番の写しとして使えません: ${ready.reason}`);
    before = await tableCounts({all: async (sql) => probe.prepare(sql).all(), get: async (sql) => probe.prepare(sql).get()});
  } finally { probe.close(); }
  const db = new LocalDatabase(path, {init: false});
  const after = await tableCounts(db);
  const changed = countDifferences(before, after);
  if (changed.length) { db.close(); throw new Error(`写しを開いたときに行が増えました: ${changed.map((row) => row.table).join('、')}`); }
  return db;
}

// 写し（または本番）の指紋。記録の見出しに入れ、再生の前に本番の指紋と照らし合わせる（ID の前提が同じか）。
// rowids は rowid の別名（INTEGER PRIMARY KEY の列）を持つ表ごとの最大の rowid。id を書かずに足す行は「最大の rowid + 1」になるので、
// 行数が同じでも写しの後に消して足した行があれば ID がずれる。それを見分ける。
// 別名の無い表（主キーが複数の列・文字の列の表）の隠れ rowid は比べない。本番の書き出し（wrangler d1 export。列名つきの INSERT で
// rowid を書かない）から --prepare-copy で作った写しでは1から振り直されるので、本番に行の削除の穴が1つでもあると必ず食い違う。
// 隠れ rowid はどの文からも参照されない（src に rowid を読む文は無く、足した行の ID を使うのは id の列を持つ表だけ）ので、比べなくてよい。
// 別名のある表の rowid は、書き出しの INSERT に id の列として入るので写しでも同じ値になる（seed-record-to-sql.test.mjs で確かめている）
const FINGERPRINT_TABLES = Object.freeze(['organizations', 'users', 'works', 'partners', 'products']);
// 指紋の rowids がどの表の rowid か。これの無い指紋（2026-09-27 の直しより前）は、隠れ rowid の表も比べている
export const FINGERPRINT_ROWID_SCOPE = 'rowid-alias';
const quoteName = (name) => `"${String(name).replaceAll('"', '""')}"`;
// rowid の別名を持つ表（主キーが宣言の型がちょうど INTEGER の1列で、WITHOUT ROWID でない表）。
// 「INTEGER PRIMARY KEY DESC」の列は別名にならず主キーの索引が別にできるので、主キーの索引（origin='pk'）が無いことも見る
export async function rowidAliasTables(db, tables) {
  const withoutRowid = new Set((await db.all("SELECT name, sql FROM sqlite_master WHERE type='table'")).filter((row) => /\bWITHOUT\s+ROWID\b/i.test(String(row.sql || ''))).map((row) => row.name));
  const out = new Set();
  for (const table of tables) {
    if (withoutRowid.has(table)) continue;
    const pk = (await db.all(`PRAGMA table_info(${quoteName(table)})`)).filter((column) => Number(column.pk) > 0);
    if (pk.length !== 1 || String(pk[0].type).toUpperCase() !== 'INTEGER') continue;
    if ((await db.all(`PRAGMA index_list(${quoteName(table)})`)).some((index) => index.origin === 'pk')) continue;
    out.add(table);
  }
  return out;
}
export async function databaseFingerprint(db) {
  const counts = await tableCounts(db);
  delete counts.d1_migrations;
  const maxIds = {};
  for (const table of FINGERPRINT_TABLES) maxIds[table] = Number((await db.get(`SELECT COALESCE(MAX(id),0) AS n FROM ${table}`)).n);
  const users = (await db.all('SELECT id,email FROM users ORDER BY id')).map((row) => [row.id, row.email]);
  const orgs = (await db.all('SELECT id,code FROM organizations ORDER BY id')).map((row) => [row.id, row.code]);
  const rowids = {};
  for (const table of await rowidAliasTables(db, Object.keys(counts))) rowids[table] = Number((await db.get(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${quoteName(table)}`)).n);
  return {counts, maxIds, users, orgs, rowids, rowidScope: FINGERPRINT_ROWID_SCOPE};
}
// 指紋の rowids が古い形（隠れ rowid の表も入っている）か。古い形の記録は、本番の書き出しから作った写しでは当てる先と合わない
export const staleRowidFingerprint = (fingerprint) => Boolean(fingerprint?.rowids) && fingerprint.rowidScope !== FINGERPRINT_ROWID_SCOPE;
export const STALE_ROWID_MESSAGE = '記録の指紋が古い形です（2026-09-27 の直しより前の記録で、rowid の別名の無い表の隠れ rowid も比べている。本番の書き出しから作った写しでは1から振り直されるので合わない）。写しを取り直して記録し直してください';
// 指紋の食い違い（無ければ空）
export function fingerprintDifferences(recorded, current) {
  if (!recorded) return ['記録に写しの指紋がありません（古い記録です。写しを取り直して記録し直してください）'];
  const out = [];
  for (const [table, n] of Object.entries(recorded.counts || {})) if ((current.counts || {})[table] !== n) out.push(`${table} の行数: 写し ${n}・本番 ${(current.counts || {})[table] ?? '表なし'}`);
  for (const table of Object.keys(current.counts || {})) if (!Object.hasOwn(recorded.counts || {}, table)) out.push(`${table}: 写しに無い表`);
  for (const [table, n] of Object.entries(recorded.maxIds || {})) if ((current.maxIds || {})[table] !== n) out.push(`${table} の最大ID: 写し ${n}・本番 ${(current.maxIds || {})[table]}`);
  // 最大の rowid（rowid の別名のある表だけ。2026-09-27 より前の記録には無く、あれば照らす）
  if (staleRowidFingerprint(recorded)) out.push(STALE_ROWID_MESSAGE);
  else for (const [table, n] of Object.entries(recorded.rowids || {})) {
    if (Object.hasOwn(recorded.counts || {}, table) && (current.counts || {})[table] === undefined) continue; // 表が無いことは行数で出している
    if ((current.rowids || {})[table] !== n) out.push(`${table} の最大の rowid: 写し ${n}・本番 ${(current.rowids || {})[table] ?? '—'}`);
  }
  if (JSON.stringify(recorded.users) !== JSON.stringify(current.users)) out.push('利用者（id・メール）の一覧が違います');
  if (JSON.stringify(recorded.orgs) !== JSON.stringify(current.orgs)) out.push('組織（id・コード）の一覧が違います');
  return out;
}

// 記録（JSON Lines の文字）を db（本番の部品で包んだ D1 など）へ再生する。指紋が合わなければ1文も当てずに止める
const decodeValue = (value) => (value && typeof value === 'object' && '$base64' in value ? new Uint8Array(Buffer.from(value.$base64, 'base64'))
  : value && typeof value === 'object' && '$bigint' in value ? BigInt(value.$bigint) : value);
export async function replaySeedRecord(text, db, {fingerprintDb = db} = {}) {
  const [headLine, ...rest] = String(text).trimEnd().split('\n');
  const head = JSON.parse(headLine);
  if (head.format !== SEED_RECORD_FORMAT) throw new Error('架空データの記録ではありません');
  const differences = fingerprintDifferences(head.fingerprint, await databaseFingerprint(fingerprintDb));
  if (differences.length) return {ok: false, applied: 0, differences};
  let applied = 0;
  for (const line of rest) {
    const batch = JSON.parse(line);
    await db.batch(batch.statements.map((s) => ({sql: s.sql, params: s.params.map(decodeValue)})));
    applied += 1;
  }
  return {ok: true, applied, differences: []};
}

export function countDifferences(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter((name) => before[name] !== after[name]).map((name) => ({table: name, before: before[name] ?? 0, after: after[name] ?? 0}));
}

// ---------- 各画面の API が数字を返すか（読むだけ） ----------
const isXlsx = (bytes) => bytes instanceof Uint8Array && bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b;
const yen = (n) => `${Math.round(Number(n) || 0).toLocaleString('ja-JP')}円`;

// 架空の管理者で API を読み、画面ごとに {name, ok, detail} を返す。asOf は放送ウィンドウ提案・アベイルズの基準日
// only は流した節（seedAllDemo と同じ。null なら全部）。付け替えの節を流していないときは、流通IDの確認で seed の旧区分の残りを NG にしない
export async function checkDemoApis(db, {asOf = SALES_DEMO.asOf, plFrom = '2025-05', plTo = '2026-04', bsMonth = '2026-06', only = null} = {}) {
  const distributionDeferred = Array.isArray(only) && !only.includes('distribution');
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  if (login.status !== 200) throw new Error(`架空の管理者でログインできません（${login.status}）`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, init = {}) => {
    const response = await app.request(`/api${path}`, {...init, headers: {cookie, 'content-type': 'application/json', ...(init.headers || {})}});
    const type = response.headers.get('content-type') || '';
    const body = type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
    if (response.status !== 200 || body?.ok === false) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${body?.error || ''}`.trim());
    return {body, headers: response.headers};
  };
  const get = async (path) => (await call(path)).body;
  const out = [];
  const check = async (name, fn) => {
    try {
      const {ok, detail} = await fn();
      out.push({name, ok: Boolean(ok), detail});
    } catch (error) {
      out.push({name, ok: false, detail: error.message});
    }
  };
  const session = await get('/session');
  const orgId = session.user.orgId;
  const works = (await get('/bootstrap')).works || [];
  const workOf = (code) => works.find((work) => work.code === code);

  await check('デモ資料の組織判定（香盤のデモ・売上集計シート）', async () => {
    const body = await get('/session/org-features');
    const here = (list) => list.some((org) => org.id === orgId);
    return {ok: here(body.koubanDemo) && here(body.salesSheet), detail: `香盤のデモ ${body.koubanDemo.map((org) => org.name).join('・') || 'なし'}／売上集計シート ${body.salesSheet.map((org) => org.name).join('・') || 'なし'}`};
  });
  await check('提案資料（月別5種）', async () => {
    const summary = await get('/release-proposals?status=all');
    const month = summary.defaultMonth;
    const counts = summary.bases.map((basis) => [basis.label, basis.months.find((m) => m.month === month)?.count || 0]);
    const first = summary.bases[0];
    const detail = await get(`/release-proposals/${first.key}?month=${month}&status=all`);
    const xlsx = (await call(`/release-proposals/${first.key}/export.xlsx?month=${month}&status=all`)).body;
    return {ok: counts.every(([, n]) => n > 0) && detail.count > 0 && isXlsx(xlsx),
      detail: `${month}: ${counts.map(([label, n]) => `${label} ${n}件`).join('・')}。${first.label}の表 ${detail.count}行・${detail.columns.length}列、Excel ${xlsx.length}バイト`};
  });
  await check('提案資料（SVOD）', async () => {
    const body = await get('/svod-proposals?status=all');
    const sub = Object.entries(body.subtotals).map(([key, value]) => `${key} ${value.count}件`).join('・');
    return {ok: body.total.count > 0 && body.total.amount > 0, detail: `${body.partner?.name || '提案先なし'}・${body.from}〜${body.to}: ${body.total.count}件（${sub}）・提案金額 ${yen(body.total.amount)}`};
  });
  await check('放送履歴表', async () => {
    const body = await get('/broadcast/history?from=2025-05&to=2027-04');
    const xlsx = (await call('/broadcast/history/export.xlsx?from=2025-05&to=2027-04')).body;
    return {ok: body.rows.length > 0 && body.counts.red > 0 && body.counts.yellow > 0 && isXlsx(xlsx),
      detail: `2025-05〜2027-04: ${body.total}作品・赤 ${body.counts.red}・黄 ${body.counts.yellow}・局 ${body.stations.length}、Excel ${xlsx.length}バイト`};
  });
  await check('放送アベイルズリスト（照合と Excel）', async () => {
    const matched = (await call('/broadcast/availability-list/match', {method: 'POST', body: JSON.stringify({text: 'DEMO-W01\nDEMO-W02\n存在しない作品（架空）'})})).body;
    const ids = ['DEMO-W01', 'DEMO-W02'].map((code) => workOf(code)?.id).filter(Boolean);
    const {body: xlsx, headers} = await call(`/broadcast/availability-list/export.xlsx?${new URLSearchParams({asOf, workIds: ids.join(',')})}`);
    return {ok: matched.counts.matched === 2 && matched.counts.not_found === 1 && isXlsx(xlsx) && headers.get('x-work-count') === '2',
      detail: `照合: 一致 ${matched.counts.matched}・候補が複数 ${matched.counts.ambiguous}・見つからない ${matched.counts.not_found}。Excel ${headers.get('x-work-count')}作品・${xlsx.length}バイト`};
  });
  await check('放送ウィンドウ提案（全作品）', async () => {
    const body = await get(`/broadcast/window-proposals?asOf=${asOf}&scope=all`);
    return {ok: body.counts.rows > 0 && body.counts.ok > 0, detail: `基準日 ${body.asOf}: ${body.counts.rows}行（提案あり ${body.counts.ok}・空きなし ${body.counts.full}・出せない ${body.counts.blocked}）`};
  });
  await check('放送ウィンドウ提案から作った下書き', async () => {
    const body = await get('/broadcast/window-proposals/drafts');
    return {ok: body.counts.drafts > 0 && body.counts.deleted > 0,
      detail: draftCountsText(body.counts)};
  });
  await check('経費（請求書・未整備・出金予定）', async()=>{const invoices=await get('/expense-invoices'),sheet=await get('/expense-sheet');return {ok:invoices.rows.length>0 && sheet.unready===0 && sheet.scheduled>0,detail:`請求書 ${invoices.rows.length}件・未整備 ${sheet.unready}件・出金予定 ${sheet.scheduled}件`};});
  await check('PL・BS（作品別・会社）', async () => {
    const body = await get(`/reports/pl-bs?from=${plFrom}&to=${plTo}&asOf=${bsMonth}`);
    const cash = body.companyBs?.rows.find((row) => row.key === 'cash')?.value;
    return {ok: body.workPl?.length > 0 && Number.isFinite(body.companyPl?.netIncome?.period) && Number.isFinite(body.companyBs?.difference),
      detail: `${plFrom}〜${plTo}: 作品別PL ${body.workPl.length}作品・当期純利益 ${yen(body.companyPl.netIncome.period)}。${bsMonth}末の会社BS: 現預金 ${yen(cash)}・説明のつかない差額 ${yen(body.companyBs.difference)}`};
  });
  await check('売上集計シート（単独の画面）', async () => {
    const body = await get('/sales-sheet');
    const additional = await get('/sales-sheet?set=additional&hideEmpty=0');
    return {ok: body.adopted && body.total > 0 && additional.columns.length === 28 && additional.selected.length === 28,
      detail: `採用済み・${body.total}行（1ページ ${body.rows.length}行）・${body.columns.length}列・追加の列 ${additional.columns.length}列`};
  });
  // seed が旧区分で入れた分類は残っていない（付け替えの節が流れた）。利用者が旧区分のまま分類し直した明細は付け替えないので NG にせず件数を出す。
  // 分類の無い明細は報告の種類の既定の区分で集計し、売上集計シートでは「未分類」と出る
  await check('売上集計シートの流通ID（流通マスタの ID）', async () => {
    const legacy = new Set((await get('/distribution-types')).rows.filter((row) => Number(row.legacy) === 1).map((row) => row.code));
    const sheet = await get(`/sales-sheet?grain=aggregate&dims=distribution&columns=amount_ex_tax&from=${SALES_DEMO.salesFrom}&to=${SALES_DEMO.salesTo}&pageSize=500`);
    // 付け替えの対象と同じ条件（最新の分類が旧区分で、理由が seed の目印）の売上。読むだけ
    const {targets, unknown} = await reclassifyTargets(db, orgId);
    const seedLeft = new Set([...targets, ...unknown].map((row) => row.sale_id));
    const counts = {master: 0, legacySeed: 0, legacyUser: 0, unclassified: 0};
    const userSales = new Set();
    for (const start of [SALES_DEMO.salesFrom, addMonths(SALES_DEMO.salesFrom, 12)]) {
      for (const line of (await get(`/report-center?start=${start}`)).lines) {
        if (!line.distribution_version) counts.unclassified += 1;
        else if (!legacy.has(line.distribution_code)) counts.master += 1;
        else if (seedLeft.has(line.id)) counts.legacySeed += 1;
        else { counts.legacyUser += 1; userSales.add(line.id); }
      }
    }
    const codes = sheet.rows.map((row) => row.dimkey_distribution);
    const users = [...userSales].sort((a, b) => a - b);
    const deferredText = distributionDeferred ? '（--only に distribution が無いので、seed の旧区分の残りは NG にしない。配備の後に --only distribution で付け替える）' : '';
    return {ok: distributionDeferred ? counts.master + counts.legacySeed + counts.legacyUser > 0 : counts.master > 0 && counts.legacySeed === 0,
      detail: `${deferredText}流通マスタの ID ${counts.master}行・旧区分のまま seed の分 ${counts.legacySeed}行・利用者が残した分 ${counts.legacyUser}行${users.length ? `（売上 ${users.slice(0, 10).map((id) => `#${id}`).join('・')}${users.length > 10 ? ' ほか' : ''}）` : ''}・分類なし ${counts.unclassified}行（配賦後。売上集計シートでは未分類 ${sheet.unclassifiedCount ?? '—'}件）。シートの流通ID ${codes.join('・')}`};
  });
  if(!Array.isArray(only) || only.includes('masters')) await check('作品・商品マスタ（契約・費用・権利元・仕様）',async()=>{
    const catalog=await get('/work-catalog');let count=0,products=0,ok=true;
    for(const w of catalog.works.filter(w=>w.code.startsWith('DEMO-'))) {
      const body=await get(`/work-master/${w.id}`);count++;
      ok &&= Boolean(body.sections.profile && body.sections.finance && body.sections.contracts?.rows.length>=2 && body.sections.rights?.rows.length>=2);
      if(body.sections.finance?.committee_term_version_id) ok &&= Boolean(body.finance_reference && body.sections.finance.production_cost_yen===null && body.sections.finance.own_investment_yen===null);
    }
    for(const p of [...new Map(catalog.products.map(p=>[p.id,p])).values()].filter(p=>p.sku.startsWith('DEMO-'))) {
      const body=await get(`/product-master/${p.id}`);products++;ok &&= Boolean(body.profile?.jan_code?.startsWith('00'));
    }
    return {ok:ok&&count>=20&&products>0,detail:`${count}作品の契約・費用・複数権利元・仕様、${products}商品の仕様。委員会の額は参照のみ`};
  });
  await check('香盤（連続ドラマ DEMO-D78）', async () => {
    const work = workOf('DEMO-D78');
    if (!work) return {ok: false, detail: '作品 DEMO-D78 がありません'};
    const body = await get(`/production?workId=${work.id}`);
    return {ok: body.scenes.length > 0 && body.days.length > 0, detail: `シーン ${body.scenes.length}・撮影日 ${body.days.length}・役 ${body.characters.length}`};
  });
  return out;
}

// 6つの節を順に流す。only で一部だけ（キーの配列）
export async function seedAllDemo(db, {asOf = SALES_DEMO.asOf, python = process.env.ON_PYTHON || null, log = () => {}, only = null} = {}) {
  const results = [];
  for (const step of DEMO_SEED_STEPS) {
    if (only && !only.includes(step.key)) continue;
    if (typeof db.step !== 'undefined') db.step = step.key;
    const started = Date.now();
    log(`${step.label}（${step.script}）`);
    const result = await step.run(db, {asOf, python, log: (message) => log(`  ${message}`)});
    results.push({key: step.key, label: step.label, skipped: step.skipped(result), seconds: Math.round((Date.now() - started) / 100) / 10, result});
  }
  if (typeof db.step !== 'undefined') db.step = null;
  return results;
}

function parseArgs(argv) {
  const options = {twice: false, checkApi: false, allowMainDb: false, only: null};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} の値を指定してください`);
      i += 1;
      return next;
    };
    if (arg === '--db') options.db = value();
    else if (arg === '--as-of') options.asOf = value();
    else if (arg === '--record') options.record = value();
    else if (arg === '--only') options.only = value().split(',').map((key) => key.trim()).filter(Boolean);
    else if (arg === '--twice') options.twice = true;
    else if (arg === '--check-api') options.checkApi = true;
    else if (arg === '--allow-main-db') options.allowMainDb = true;
    else throw new Error(`知らない指定です: ${arg}`);
  }
  if (!options.db) throw new Error('投入先のDBを --db で指定してください（例: --db C:/temp/demo-all.sqlite）。既定のローカルDBへは書きません。');
  const unknown = (options.only || []).filter((key) => !DEMO_SEED_STEPS.some((step) => step.key === key));
  if (unknown.length) throw new Error(`--only に知らない seed があります: ${unknown.join('、')}（${DEMO_SEED_STEPS.map((step) => step.key).join('・')}）`);
  return options;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(options.db).toLowerCase() === resolve(mainDb).toLowerCase() && !options.allowMainDb) {
    console.error('data/integrated.sqlite への投入は --allow-main-db を付けたときだけ行います。');
    process.exit(2);
  }
  let base;
  try {
    // 記録するときは本番の写しを、表の定義も試作用の行も流さずに開く（最新の移行まで当たっていなければ止める）
    base = options.record ? await openRecordingCopy(resolve(options.db)) : new LocalDatabase(resolve(options.db));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const db = recordingDatabase(base);
  let failed = false;
  try {
    const log = (message) => console.log(message);
    const fingerprint = options.record ? await databaseFingerprint(base) : null;
    const first = await seedAllDemo(db, {asOf: options.asOf, only: options.only, log});
    // 流した後の写しの指紋（SQL ファイルの最後の確かめに使う）。2回目・API の確認より前に取る
    const afterFingerprint = options.record ? await databaseFingerprint(base) : null;
    const batches = businessBatches(db.batches);
    const statements = batches.reduce((sum, batch) => sum + batch.statements.length, 0);
    console.log('');
    for (const row of first) console.log(`${row.skipped ? '入れ済み' : '投入'}: ${row.label}（${row.seconds}秒）`);
    console.log(`書き込み: ${batches.length} batch・${statements}文（ログインを除く）`);
    const violations = d1LimitViolations(batches);
    if (violations.length) {
      failed = true;
      console.error(`D1 の上限に触れる書き込みが ${violations.length}件あります:\n  ${violations.slice(0, 20).join('\n  ')}`);
    } else console.log('D1 の上限: DDL なし・1文の値は100個まで・1回の batch は480文まで・1つの値は128KB未満（すべて満たす）');
    if (options.record) {
      writeFileSync(resolve(options.record), recordLines(batches, {createdAt: new Date().toISOString(), database: basename(resolve(options.db)), asOf: options.asOf || SALES_DEMO.asOf,
        steps: first.map((row) => ({key: row.key, skipped: row.skipped})), only: options.only, batches: batches.length, statements, fingerprint, after: afterFingerprint}));
      console.log(`記録しました: ${resolve(options.record)}`);
    }
    if (options.twice) {
      const before = await tableCounts(base);
      db.batches = [];
      const second = await seedAllDemo(db, {asOf: options.asOf, only: options.only});
      const after = await tableCounts(base);
      const changed = countDifferences(before, after);
      const writes = businessBatches(db.batches);
      const notSkipped = second.filter((row) => !row.skipped).map((row) => row.key);
      if (changed.length || writes.length || notSkipped.length) {
        failed = true;
        console.error(`2回目で増えました: ${changed.map((row) => `${row.table} ${row.before}→${row.after}`).join('、') || 'なし'}・書き込み ${writes.length} batch・入れ直した seed ${notSkipped.join('・') || 'なし'}`);
      } else console.log(`2回目: どの seed も入れ済み。表の行数は変わらず（${Object.keys(after).length}表）、ログインのほかは書いていません`);
    }
    if (options.checkApi) {
      db.batches = [];
      const checks = await checkDemoApis(db, {asOf: options.asOf || SALES_DEMO.asOf, only: options.only});
      for (const row of checks) console.log(`${row.ok ? '○' : '×'} ${row.name}: ${row.detail}`);
      const writes = businessBatches(db.batches);
      if (writes.length) console.error(`API の確認で書き込みがありました（${writes.length} batch）: ${writes[0].statements[0].sql.slice(0, 80)}`);
      if (writes.length || checks.some((row) => !row.ok)) failed = true;
      else console.log(`API の確認: ${checks.length}画面すべて数字が返りました（ログインのほかは書いていません）`);
    }
  } catch (error) {
    failed = true;
    console.error(`架空データを入れられませんでした: ${error.message}`);
  } finally {
    base.close();
  }
  process.exit(failed ? 1 : 0);
}
