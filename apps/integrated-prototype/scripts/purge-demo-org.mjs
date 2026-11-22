#!/usr/bin/env node
// デモの組織（organizations.kind='demo'）を、SQLite のファイルから丸ごと消す道具（会社ルートの plans/2026-11-06-real-demo-split.md の手順2）。
// 使い方: node scripts/purge-demo-org.mjs --db <SQLiteのパス> <組織コード> [--dry-run | --apply]
// ・既定は予行（--dry-run）。DB を読み取り専用で開き、消す行の数を表ごとに出すだけで、何も書かない。--apply のときだけ消す。
// ・本番の組織（kind='real'）や印の列が無い DB（移行 0059 の前）を指したら、何も書かずに終了コード 2 で止まる。
//   消す直前にも同じトランザクションの中で印を読み直す（予行のあとに印を付け替えても消さない）。
// ・対象は org_id の列を持つ全部の表と、組織の行（organizations）そのもの。表の一覧と外部キーは DB（sqlite_master・PRAGMA）から引き、
//   手書きの一覧にしない。消す順は外部キーの向き（指す側を先）に従う。利用者（users）は組織をまたぐので消さない。
// ・ほかの組織の行がこの組織の行を指していたら（例: 組織の切替の記録 org_switch_events の from_org_id）、消さずに終了コード 1 で止まる
//   （ほかの組織の行は1行も変えない）。消したあとも、ほかの組織の行の数が表ごとに変わっていないことを確かめ、違えば全部を取り消す。
// ・消せない記録を守るトリガー（BEFORE DELETE で RAISE するもの）は、同じトランザクションの中だけ外して消し、元の定義で作り直す。
//   SQLite の定義の文はトランザクションに入るので、途中で落ちてもトリガーと行は元に戻る。
// ・data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番の D1・PostgreSQL・Cloudflare には触れない（SQLite のファイルだけ）。
// 終了コード: 0＝予行か消し終わり、1＝組織が無い・ほかの組織から指されている・失敗、2＝本番の組織・印の列が無い・引数の誤り。
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const PURGE_EXIT = Object.freeze({ok: 0, failed: 1, refused: 2});
const ORG_TABLE = 'organizations';

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const count = (raw, sql, params = []) => Number(raw.prepare(sql).get(...params).n);

function tableNames(raw) {
  return raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
}

function columnsOf(raw, table) {
  return raw.prepare(`PRAGMA table_info(${quote(table)})`).all();
}

// 外部キーを1つずつ（複合のキーは列の組で）。参照先の列が書かれていない外部キーは、参照先の主キーの列を使う
function foreignKeysOf(raw, table, pkOf) {
  const groups = new Map();
  for (const row of raw.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
    if (!groups.has(row.id)) groups.set(row.id, {parent: row.table, pairs: []});
    groups.get(row.id).pairs.push({seq: row.seq, from: row.from, to: row.to});
  }
  return [...groups.values()].map(({parent, pairs}) => {
    pairs.sort((a, b) => a.seq - b.seq);
    const pk = pkOf(parent);
    return {parent, pairs: pairs.map((pair, index) => ({from: pair.from, to: pair.to ?? pk[index]}))};
  });
}

// 消す順: 指す側（子）を先に。外部キーの輪が無ければ子から親への順になる。同じ段は名前の順（毎回同じ順にする）
export function deleteOrder(tables, edges) {
  const parents = new Map(tables.map((table) => [table, new Set()]));
  const children = new Map(tables.map((table) => [table, new Set()]));
  for (const {child, parent} of edges) {
    if (child === parent || !parents.has(child) || !parents.has(parent)) continue;
    parents.get(child).add(parent);
    children.get(parent).add(child);
  }
  const order = [];
  const done = new Set();
  // まだ消していない子が残っていない表から消す
  let ready = tables.filter((table) => children.get(table).size === 0).sort();
  const waiting = new Map(tables.map((table) => [table, children.get(table).size]));
  while (ready.length) {
    const table = ready.shift();
    order.push(table);
    done.add(table);
    const next = [];
    for (const parent of parents.get(table)) {
      waiting.set(parent, waiting.get(parent) - 1);
      if (waiting.get(parent) === 0) next.push(parent);
    }
    ready = [...ready, ...next].sort();
  }
  // 輪があれば残りを名前の順で後ろに足す（外部キーは消し終わりの COMMIT でまとめて確かめる）
  return [...order, ...tables.filter((table) => !done.has(table)).sort()];
}

// DB の表と外部キーから、この組織の行を消す計画を作る（読むだけ）
export function purgePlan(raw, code) {
  const tables = tableNames(raw);
  if (!tables.includes(ORG_TABLE)) return {status: 'refused', reason: '組織の表（organizations）がありません'};
  const orgColumns = new Set(columnsOf(raw, ORG_TABLE).map((column) => column.name));
  if (!orgColumns.has('kind')) return {status: 'refused', reason: '組織に本番・デモの印（kind。移行 0059）がありません。本番かデモかを確かめられないので消しません'};
  const org = raw.prepare(`SELECT id,code,name,kind FROM ${ORG_TABLE} WHERE code=?`).get(code);
  if (!org) return {status: 'not-found', reason: `組織 ${code} がありません`};
  const target = {id: Number(org.id), code: org.code, name: org.name, kind: org.kind};
  if (target.kind !== 'demo') return {status: 'refused', org: target, reason: `組織 ${code} は本番（kind=${target.kind}）です。デモの組織だけを消します`};

  const columns = new Map(tables.map((table) => [table, columnsOf(raw, table)]));
  const pkCache = new Map();
  const pkOf = (table) => {
    if (!pkCache.has(table)) pkCache.set(table, (columns.get(table) ?? columnsOf(raw, table)).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name));
    return pkCache.get(table);
  };
  const hasOrg = (table) => columns.get(table).some((column) => column.name === 'org_id');
  const owned = tables.filter((table) => table === ORG_TABLE || hasOrg(table));
  const ownedSet = new Set(owned);
  // この組織の行か（組織の表は id、ほかは org_id）
  const belongs = (table, alias) => (table === ORG_TABLE ? `${alias}.id=?` : `${alias}.org_id=?`);
  // 消さずに残る行か
  const outside = (table, alias) => (table === ORG_TABLE ? `${alias}.id<>?` : hasOrg(table) ? `(${alias}.org_id IS NULL OR ${alias}.org_id<>?)` : null);

  const edges = [];
  const blockers = [];
  for (const table of tables) {
    for (const fk of foreignKeysOf(raw, table, pkOf)) {
      if (!ownedSet.has(fk.parent)) continue;
      if (ownedSet.has(table)) edges.push({child: table, parent: fk.parent});
      // 子の org_id が親の org_id（組織の表なら id）を指す外部キーは、ほかの組織の行から指せない
      const orgKey = fk.parent === ORG_TABLE ? 'id' : 'org_id';
      if (hasOrg(table) && fk.pairs.some((pair) => pair.from === 'org_id' && pair.to === orgKey)) continue;
      const keep = outside(table, 'c');
      const match = fk.pairs.map((pair) => `p.${quote(pair.to)}=c.${quote(pair.from)}`).join(' AND ');
      const params = keep ? [target.id, target.id] : [target.id];
      const n = count(raw, `SELECT COUNT(*) AS n FROM ${quote(table)} c WHERE ${keep ? `${keep} AND ` : ''}EXISTS (SELECT 1 FROM ${quote(fk.parent)} p WHERE ${belongs(fk.parent, 'p')} AND ${match})`, params);
      if (n > 0) blockers.push({table, columns: fk.pairs.map((pair) => pair.from), parent: fk.parent, rows: n});
    }
  }
  const order = deleteOrder(owned, edges);
  const rows = order.map((table) => ({table, rows: count(raw, `SELECT COUNT(*) AS n FROM ${quote(table)} t WHERE ${belongs(table, 't')}`, [target.id])}));
  // 消したあとに比べる、残る行の数（組織を持たない表は全部の行）
  const kept = () => new Map(tables.map((table) => {
    const keep = outside(table, 't');
    return [table, count(raw, `SELECT COUNT(*) AS n FROM ${quote(table)} t${keep ? ` WHERE ${keep}` : ''}`, keep ? [target.id] : [])];
  }));
  return {status: blockers.length ? 'blocked' : 'ready', org: target, order, rows, blockers, kept, belongs};
}

// 消す表の DELETE のトリガー（sqlite_master の定義の文のまま）
function deleteTriggers(raw, tables) {
  const set = new Set(tables);
  return raw.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").all()
    .filter((row) => set.has(row.tbl_name) && /\b(?:BEFORE|AFTER|INSTEAD\s+OF)\s+DELETE\s+ON\b/i.test(row.sql));
}

const summary = (plan) => ({
  status: plan.status, org: plan.org, reason: plan.reason,
  tables: plan.rows?.filter((row) => row.rows > 0) ?? [], total: plan.rows?.reduce((sum, row) => sum + row.rows, 0) ?? 0, blockers: plan.blockers ?? [],
});

// 予行（apply: false）は読むだけ。apply: true は1つのトランザクションで、印を読み直してから消す
export function purgeDemoOrg(raw, code, {apply = false} = {}) {
  if (!apply) {
    raw.exec('BEGIN');
    try {
      const plan = purgePlan(raw, code);
      return {...summary(plan), status: plan.status === 'ready' ? 'dry-run' : plan.status};
    } finally {
      raw.exec('ROLLBACK');
    }
  }
  raw.exec('PRAGMA foreign_keys=ON');
  raw.exec('BEGIN IMMEDIATE');
  try {
    const plan = purgePlan(raw, code);
    if (plan.status !== 'ready') {
      raw.exec('ROLLBACK');
      return summary(plan);
    }
    const before = plan.kept();
    raw.exec('PRAGMA defer_foreign_keys=ON');
    const triggers = deleteTriggers(raw, plan.order);
    for (const trigger of triggers) raw.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    for (const table of plan.order) raw.prepare(`DELETE FROM ${quote(table)} AS t WHERE ${plan.belongs(table, 't')}`).run(plan.org.id);
    for (const trigger of triggers) raw.exec(trigger.sql);
    const left = plan.order.filter((table) => count(raw, `SELECT COUNT(*) AS n FROM ${quote(table)} t WHERE ${plan.belongs(table, 't')}`, [plan.org.id]) > 0);
    if (left.length) throw new Error(`消し残りがあります: ${left.join('・')}`);
    const after = plan.kept();
    const changed = [...before].filter(([table, n]) => after.get(table) !== n).map(([table, n]) => `${table} ${n}→${after.get(table)}`);
    if (changed.length) throw new Error(`ほかの組織の行の数が変わりました（取り消しました）: ${changed.join('、')}`);
    raw.exec('COMMIT');
    return {...summary(plan), status: 'purged'};
  } catch (error) {
    if (raw.isTransaction) raw.exec('ROLLBACK');
    throw error;
  }
}

export function exitCodeOf(result) {
  if (result.status === 'dry-run' || result.status === 'purged') return PURGE_EXIT.ok;
  if (result.status === 'refused') return PURGE_EXIT.refused;
  return PURGE_EXIT.failed;
}

export function formatResult(result) {
  const lines = [];
  if (result.org) lines.push(`組織 ${result.org.code}（${result.org.name}・${result.org.kind}・id ${result.org.id}）`);
  if (result.reason) lines.push(result.reason);
  if (result.blockers.length) {
    lines.push('ほかの組織の行が、この組織の行を指しています（消しません）:');
    for (const b of result.blockers) lines.push(`  ${b.table}(${b.columns.join(',')}) → ${b.parent}\t${b.rows}行`);
  }
  if (result.status === 'dry-run' || result.status === 'purged' || result.status === 'blocked') {
    lines.push(result.status === 'purged' ? '消した行（表ごと）:' : '消す行（表ごと）:');
    for (const row of result.tables) lines.push(`  ${row.table}\t${row.rows}`);
    lines.push(`合計 ${result.total}行（${result.tables.length}表）`);
    if (result.status === 'dry-run') lines.push('予行です。何も消していません。消すときは --apply を付けます');
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {db: null, code: null, apply: false, allowMainDb: false};
  let mode = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--db の値を指定してください');
      options.db = next;
      i += 1;
    } else if (arg === '--apply' || arg === '--dry-run') {
      if (mode && mode !== arg) throw new Error('--dry-run と --apply は一緒に指定できません');
      mode = arg;
    } else if (arg === '--allow-main-db') options.allowMainDb = true;
    else if (arg.startsWith('--')) throw new Error(`知らない指定です: ${arg}`);
    else if (options.code !== null) throw new Error(`組織コードは1つだけ指定してください（${options.code}・${arg}）`);
    else options.code = arg;
  }
  if (!options.db) throw new Error('消す DB を --db で指定してください（SQLite のファイル）');
  if (!options.code) throw new Error('消す組織のコードを指定してください（例: DEMO-SALES）');
  options.apply = mode === '--apply';
  return options;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(PURGE_EXIT.refused);
  }
  const path = resolve(options.db);
  if (!existsSync(path)) {
    console.error(`DB のファイルがありません: ${path}`);
    process.exit(PURGE_EXIT.refused);
  }
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (options.apply && path.toLowerCase() === resolve(mainDb).toLowerCase() && !options.allowMainDb) {
    console.error('data/integrated.sqlite から消すのは --allow-main-db を付けたときだけです。');
    process.exit(PURGE_EXIT.refused);
  }
  const raw = new DatabaseSync(path, {readOnly: !options.apply});
  let code = PURGE_EXIT.failed;
  try {
    raw.exec('PRAGMA busy_timeout=5000');
    const result = purgeDemoOrg(raw, options.code, {apply: options.apply});
    console.log(formatResult(result));
    code = exitCodeOf(result);
  } catch (error) {
    console.error(`消せませんでした（何も変えていません）: ${error.message}`);
  } finally {
    raw.close();
  }
  process.exit(code);
}
