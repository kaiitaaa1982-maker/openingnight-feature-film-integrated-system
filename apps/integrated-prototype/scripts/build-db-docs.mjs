// 統合システムの DB の定義書（docs/database/）を、空の DB（テストと同じ LocalDatabase）と説明の辞書から作る。
// 型・NULL・既定値・制約・索引・トリガーは DB から読み、手で書かない。辞書（docs/database/dictionary.json）には
// 表の領域・論理名・説明と、列の説明だけを書く。md は生成物なので直さず、辞書か SQL を直してから作り直す。
//   node scripts/build-db-docs.mjs          md を作り直す
//   node scripts/build-db-docs.mjs --check  ずれと辞書の抜けを一覧にして、あれば終了コード1
//   node scripts/build-db-docs.mjs --xlsx   Excel 版を docs/database/_build/ に書き出す（git の対象外）
import {readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, realpathSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {encodeXlsx} from '../src/xlsx.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DOC_DIR = join(APP, 'docs', 'database');
export const DICTIONARY = join(DOC_DIR, 'dictionary.json');
export const XLSX_PATH = join(DOC_DIR, '_build', 'データベース定義書.xlsx');
// 業務の一周の順（docs/requirements/README.md の9領域）に、共通基盤と管理を足す
export const DOMAINS = {planning: '企画', production: '制作', sales: '営業', publicity: '宣伝', revenue: '売上', expenses: '経費',
  settlement: '精算', accounting: '会計', ledger: '台帳', core: '共通基盤', admin: '管理'};
export const GUESS = '（推測）';
// ほぼ全表が参照する表。ER 図に線を引くと図が読めなくなるので省き、図の下にその旨を書く
const OMIT_FROM_ER = new Set(['organizations', 'memberships']);
const GENERATED = '<!-- 生成物。直さない。正本は DB の定義（src/**/*.sql）と docs/database/dictionary.json。作り直しは node scripts/build-db-docs.mjs -->';

const quoteId = name => `"${String(name).replaceAll('"', '""')}"`;
const comma = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const cellText = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// SQL の文字列・引用符つきの名前・コメントを飛ばす。i は開きの位置、返すのは閉じの位置
function skip(sql, i) {
  const c = sql[i];
  if (c === "'" || c === '"' || c === '`') {
    for (let j = i + 1; j < sql.length; j++) {
      if (sql[j] !== c) continue;
      if (sql[j + 1] === c) { j++; continue; }
      return j;
    }
    return sql.length;
  }
  if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); return j < 0 ? sql.length : j; }
  if (c === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); return j < 0 ? sql.length : j + 1; }
  return i;
}

function matchClose(sql, open) {
  let depth = 0;
  for (let j = open; j < sql.length; j++) {
    const k = skip(sql, j);
    if (k !== j) { j = k; continue; }
    if (sql[j] === '(') depth++;
    else if (sql[j] === ')' && --depth === 0) return j;
  }
  throw Error('CHECK の括弧が閉じていない');
}

// CREATE TABLE の文から CHECK(...) の中身を順に取り出す（文字列・コメントの中の CHECK は数えない）
export function extractChecks(sql) {
  const out = [];
  for (let i = 0; i < sql.length; i++) {
    const k = skip(sql, i);
    if (k !== i) { i = k; continue; }
    if (!/[A-Za-z_]/.test(sql[i]) || /[A-Za-z0-9_]/.test(sql[i - 1] || '')) continue;
    const m = /^CHECK\s*\(/i.exec(sql.slice(i, i + 24));
    if (m) {
      const open = i + m[0].length - 1;
      const close = matchClose(sql, open);
      out.push(sql.slice(open + 1, close).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim());
      i = close;
      continue;
    }
    while (/[A-Za-z0-9_]/.test(sql[i + 1] || '')) i++;
  }
  return out;
}

// 式の中に出てくる列の名前（文字列の中は数えない）
export function columnsIn(expr, names) {
  const bare = expr.replace(/'(?:[^']|'')*'/g, "''");
  const found = new Set();
  for (const m of bare.matchAll(/"([^"]+)"|[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = m[1] ?? m[0];
    if (names.has(name)) found.add(name);
  }
  return [...found];
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function splitValues(inner) {
  const out = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "'") { const j = skip(inner, i); cur += inner.slice(i, j + 1); i = j; continue; }
    if (inner[i] === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += inner[i];
  }
  out.push(cur.trim());
  return out;
}
const unquote = v => v.replace(/^'(.*)'$/s, '$1').replaceAll("''", "'");

// 1つの列だけを見る CHECK から、型の中身（列挙・真偽・年月・日付・JSON）を読む。読めなければ null
export function semantic(expr, column) {
  const c = `"?${escapeRe(column)}"?`;
  const e = expr.replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1');
  const nullable = new RegExp(`^${c} IS NULL OR (.+)$`, 'i').exec(e);
  const body = (nullable ? nullable[1] : e).trim().replace(/^\((.*)\)$/, '$1');
  let m = new RegExp(`^${c} IN ?\\((.+)\\)$`, 'i').exec(body);
  if (m) {
    const values = splitValues(m[1]);
    if (values.length === 2 && values.includes('0') && values.includes('1')) return {kind: '真偽 0/1'};
    if (values.every(v => /^'.*'$/s.test(v) || /^-?\d+(\.\d+)?$/.test(v))) return {kind: '列挙', values: values.map(unquote)};
  }
  m = new RegExp(`^${c} GLOB '([^']*)'$`, 'i').exec(body);
  if (m && m[1] === '[0-9][0-9][0-9][0-9]-[0-9][0-9]') return {kind: '年月 YYYY-MM'};
  if (m && m[1] === '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]') return {kind: '日付 YYYY-MM-DD'};
  if (new RegExp(`^json_valid\\(${c}\\)$`, 'i').test(body)) return {kind: 'JSON'};
  return null;
}

function triggerEvent(sql) {
  const m = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+(BEFORE|AFTER|INSTEAD\s+OF)?\s*(INSERT|UPDATE(?:\s+OF\s+[^\n]+?)?|DELETE)\s+ON\s/i.exec(sql);
  if (!m) return '';
  const timing = {BEFORE: '前', AFTER: '後', 'INSTEAD OF': '代わり'}[String(m[1] || 'BEFORE').toUpperCase().replace(/\s+/g, ' ')];
  const what = m[2].replace(/\s+/g, ' ');
  const verb = /^INSERT/i.test(what) ? '追加' : /^DELETE/i.test(what) ? '削除' : `更新${/ OF /i.test(what) ? `（${what.replace(/^UPDATE OF /i, '')}）` : ''}`;
  return `${verb}の${timing}`;
}

// 空の DB から全表の定義を読む
export function readSchema(raw) {
  const master = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const indexSql = new Map(master.filter(m => m.type === 'index').map(m => [m.name, m.sql]));
  const tables = master.filter(m => m.type === 'table').map(t => {
    const columns = raw.prepare(`PRAGMA table_info(${quoteId(t.name)})`).all()
      .map(c => ({name: c.name, type: c.type, notnull: !!c.notnull, dflt: c.dflt_value, pk: c.pk}));
    const fkMap = new Map();
    for (const f of raw.prepare(`PRAGMA foreign_key_list(${quoteId(t.name)})`).all()) {
      if (!fkMap.has(f.id)) fkMap.set(f.id, {table: f.table, from: [], to: [], onDelete: f.on_delete});
      const fk = fkMap.get(f.id);
      fk.from.push(f.from);
      fk.to.push(f.to);
    }
    const indexes = raw.prepare(`PRAGMA index_list(${quoteId(t.name)})`).all().map(ix => ({
      name: ix.name, unique: !!ix.unique, origin: ix.origin, partial: !!ix.partial,
      columns: raw.prepare(`PRAGMA index_info(${quoteId(ix.name)})`).all().sort((a, b) => a.seqno - b.seqno).map(c => c.name ?? '（式）'),
      where: (/\bWHERE\b([\s\S]*)$/i.exec(indexSql.get(ix.name) || '')?.[1] || '').replace(/\s+/g, ' ').trim(),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const triggers = master.filter(m => m.type === 'trigger' && m.tbl_name === t.name).map(m => ({name: m.name, event: triggerEvent(m.sql)}));
    return {name: t.name, columns, fks: [...fkMap.values()], indexes, triggers, checks: extractChecks(t.sql)};
  });
  // 参照先の列を省いた FK（REFERENCES t）は、参照先の主キーを指す
  const pkOf = new Map(tables.map(t => [t.name, t.columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name)]));
  for (const t of tables) for (const fk of t.fks) fk.to = fk.to.map((c, i) => c ?? pkOf.get(fk.table)?.[i] ?? 'rowid');
  return tables;
}

export function loadDictionary(path = DICTIONARY) {
  if (!existsSync(path)) return {revisions: [], common: {}, tables: {}};
  const d = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  return {revisions: d.revisions || [], common: d.common || {}, tables: d.tables || {}};
}

const columnNote = (dict, table, column) => dict.tables[table]?.columns?.[column] ?? dict.common[column] ?? '';

// 辞書の抜けと、DB に無い説明の残り
export function dictionaryProblems(tables, dict) {
  const out = [];
  const names = new Set(tables.map(t => t.name));
  for (const t of tables) {
    const e = dict.tables[t.name];
    if (!e) { out.push(`${t.name}: 辞書に表が無い`); continue; }
    if (!DOMAINS[e.domain]) out.push(`${t.name}: 領域が ${Object.keys(DOMAINS).join('/')} のどれでもない（${e.domain ?? '無し'}）`);
    if (!e.name) out.push(`${t.name}: 論理名が無い`);
    if (!e.description) out.push(`${t.name}: 説明が無い`);
    const cols = new Set(t.columns.map(c => c.name));
    for (const c of t.columns) if (!columnNote(dict, t.name, c.name)) out.push(`${t.name}.${c.name}: 列の説明が無い`);
    for (const c of Object.keys(e.columns || {})) if (!cols.has(c)) out.push(`${t.name}.${c}: DB に無い列の説明が残っている`);
  }
  for (const n of Object.keys(dict.tables)) if (!names.has(n)) out.push(`${n}: DB に無い表の説明が残っている`);
  return out;
}

// 1つの表を、定義書の行と表の制約にする
export function describeTable(t, dict) {
  const names = new Set(t.columns.map(c => c.name));
  const perColumn = new Map(t.columns.map(c => [c.name, {checks: [], sem: null}]));
  const tableChecks = [];
  for (const expr of t.checks) {
    const cols = columnsIn(expr, names);
    if (cols.length !== 1) { tableChecks.push(expr); continue; }
    const slot = perColumn.get(cols[0]);
    const sem = semantic(expr, cols[0]);
    if (sem && !slot.sem) slot.sem = sem;
    else slot.checks.push(expr);
  }
  const pkCols = t.columns.filter(c => c.pk);
  const singleUnique = new Set(t.indexes.filter(ix => ix.unique && !ix.partial && ix.origin !== 'pk' && ix.columns.length === 1).map(ix => ix.columns[0]));
  const rows = t.columns.map((c, i) => {
    const {checks, sem} = perColumn.get(c.name);
    const rules = [];
    if (c.pk) rules.push(pkCols.length > 1 ? 'PK（複合）' : 'PK');
    if (singleUnique.has(c.name)) rules.push('Unique');
    // 複合の参照は、組織の列（org_id）を除いた列にだけ書く（org_id はほぼすべての複合の参照に入るので、書くと読めなくなる）
    for (const fk of t.fks.filter(f => f.from.includes(c.name) && !(f.from.length > 1 && c.name === 'org_id'))) {
      rules.push(fk.from.length > 1 ? `FK（複合）→ ${fk.table}` : `FK → ${fk.table}.${fk.to[0]}`);
    }
    if (sem?.kind === '列挙') rules.push(`値: ${sem.values.join(' / ')}`);
    for (const x of checks) rules.push(`CHECK: ${x}`);
    const type = (c.type || '型なし') + (sem ? `（${sem.kind === '列挙' ? '列挙' : sem.kind}）` : '');
    const rowidPk = c.pk && pkCols.length === 1 && /^INTEGER$/i.test(c.type);
    const dflt = c.dflt == null ? '-' : /^CURRENT_TIMESTAMP$/i.test(c.dflt) ? '現在時刻' : /^'.*'$/s.test(c.dflt) ? unquote(c.dflt) : c.dflt;
    return {no: i + 1, name: c.name, type, note: columnNote(dict, t.name, c.name), nullable: c.notnull || rowidPk ? '不可' : '可',
      dflt: dflt === '' ? '（空文字）' : dflt, rules: rules.join('、') || '-'};
  });
  const extras = [];
  if (pkCols.length > 1) extras.push(`複合の主キー: (${pkCols.sort((a, b) => a.pk - b.pk).map(c => c.name).join(', ')})`);
  for (const ix of t.indexes.filter(ix => ix.origin === 'u' && ix.columns.length > 1)) extras.push(`複合の一意: (${ix.columns.join(', ')})`);
  for (const fk of t.fks.filter(f => f.from.length > 1)) extras.push(`複合の参照: (${fk.from.join(', ')}) → ${fk.table}(${fk.to.join(', ')})`);
  for (const x of tableChecks) extras.push(`CHECK: ${x}`);
  for (const ix of t.indexes.filter(ix => ix.origin === 'c')) {
    extras.push(`索引 ${ix.name}: (${ix.columns.join(', ')})${ix.unique ? ' 一意' : ''}${ix.where ? ` WHERE ${ix.where}` : ''}`);
  }
  for (const tr of t.triggers) extras.push(`トリガー ${tr.name}${tr.event ? `: ${tr.event}` : ''}`);
  return {rows, extras};
}

function groupByDomain(tables, dict) {
  const groups = new Map([...Object.keys(DOMAINS), 'unassigned'].map(d => [d, []]));
  for (const t of tables) groups.get(DOMAINS[dict.tables[t.name]?.domain] ? dict.tables[t.name].domain : 'unassigned').push(t);
  return [...groups].filter(([, ts]) => ts.length);
}
const domainLabel = d => d === 'unassigned' ? '未分類' : DOMAINS[d];
const domainOf = (dict, name) => DOMAINS[dict.tables[name]?.domain] ? dict.tables[name].domain : 'unassigned';

const erAttr = s => String(s).replace(/"/g, '”').replace(/\r?\n/g, ' ');
function erDiagram(tables, dict) {
  const lines = ['```mermaid', 'erDiagram'];
  for (const t of tables) {
    const keyed = t.columns.filter(c => c.pk || t.fks.some(f => f.from.includes(c.name) && !OMIT_FROM_ER.has(f.table)));
    lines.push(`  ${t.name} {`);
    for (const c of keyed) {
      const keys = [c.pk && 'PK', t.fks.some(f => f.from.includes(c.name) && !OMIT_FROM_ER.has(f.table)) && 'FK'].filter(Boolean).join(', ');
      const note = columnNote(dict, t.name, c.name);
      lines.push(`    ${(c.type || 'ANY').replace(/[^A-Za-z0-9_]/g, '_')} ${c.name} ${keys}${note ? ` "${erAttr(note)}"` : ''}`);
    }
    lines.push('  }');
  }
  for (const t of tables) {
    for (const fk of t.fks) {
      if (OMIT_FROM_ER.has(fk.table)) continue;
      const cols = fk.from.filter(c => !['org_id'].includes(c) || fk.from.length === 1);
      const required = fk.from.every(c => t.columns.find(x => x.name === c)?.notnull);
      lines.push(`  ${t.name} }o--${required ? '||' : 'o|'} ${fk.table} : "${erAttr(cols.join(','))}"`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

function overview(groups, tables, dict) {
  const lines = ['```mermaid', 'flowchart LR'];
  for (const [d, ts] of groups) lines.push(`  ${d}["${domainLabel(d)}<br/>${ts.length} 表"]`);
  const edges = new Map();
  for (const t of tables) {
    const from = domainOf(dict, t.name);
    for (const fk of t.fks) {
      if (OMIT_FROM_ER.has(fk.table)) continue;
      const to = domainOf(dict, fk.table);
      if (to === from) continue;
      const key = `${from} ${to}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const [key, n] of [...edges].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [from, to] = key.split(' ');
    lines.push(`  ${from} -->|${n}| ${to}`);
  }
  lines.push('```');
  return lines.join('\n');
}

export function render(tables, dict) {
  const groups = groupByDomain(tables, dict);
  const files = new Map();
  const guesses = tables.reduce((n, t) => n + [dict.tables[t.name]?.description, ...t.columns.map(c => columnNote(dict, t.name, c.name))]
    .filter(s => String(s || '').endsWith(GUESS)).length, 0);
  const count = key => tables.reduce((n, t) => n + t[key].length, 0);
  const unsure = tables.filter(t => /^要確認/.test(dict.tables[t.name]?.domain_reason || ''));
  const readme = [
    GENERATED,
    '# データベース定義書（統合システム）',
    '',
    '統合システムの DB（本番は Cloudflare D1、手元とテストは SQLite）の全表を、領域ごとに説明する。型・NULL・既定値・制約・索引・トリガーは空の DB から読み、表の領域・論理名・説明は辞書（`dictionary.json`）に書く。説明の末尾が「（推測）」のものは、コードの使われ方から読み取った推測で、確かめを待っている。',
    '',
    `- 表 ${comma(tables.length)}・列 ${comma(count('columns'))}・参照 ${comma(count('fks'))}・索引 ${comma(tables.reduce((n, t) => n + t.indexes.filter(ix => ix.origin === 'c').length, 0))}・トリガー ${comma(count('triggers'))}`,
    `- 説明のうち推測: ${comma(guesses)} 件`,
    '- Excel 版は `node scripts/build-db-docs.mjs --xlsx` で `docs/database/_build/` に書き出す（git の対象外）',
    '',
    '## 改訂履歴',
    '',
    '| 版数 | 日付 | 改訂者 | 改訂内容 |',
    '|---|---|---|---|',
    ...dict.revisions.map(r => `| ${cellText(r.version)} | ${cellText(r.date)} | ${cellText(r.author)} | ${cellText(r.note)} |`),
    '',
    '## 目次',
    '',
    '| 領域 | ページ | 表の数 |',
    '|---|---|---|',
    ...groups.map(([d, ts]) => `| ${domainLabel(d)} | [${d}.md](${d}.md) | ${ts.length} |`),
    '',
    ...(unsure.length ? [
      '## 領域が要確認の表',
      '',
      'どの領域が受け持つかを決めきれなかった表。領域の境界（`docs/requirements/README.md` の要確認4）と合わせて決める。',
      '',
      '| 表 | 論理名 | いまの領域 | 迷った点 |',
      '|---|---|---|---|',
      ...unsure.map(t => `| [${t.name}](${domainOf(dict, t.name)}.md#${t.name}) | ${cellText(dict.tables[t.name].name)} | ${domainLabel(domainOf(dict, t.name))} | ${cellText(dict.tables[t.name].domain_reason.replace(/^要確認[:：]\s*/, ''))} |`),
      '',
    ] : []),
    '## 領域どうしのつながり',
    '',
    '矢印は参照する側から参照される側へ。数は参照（外部キー）の本数。',
    '',
    overview(groups, tables, dict),
    '',
    `組織（${[...OMIT_FROM_ER].join('・')}）への参照は、ほぼ全表にあるので図から省く。`,
    '',
    '## 読み方',
    '',
    '- **データ型**: SQLite の型。括弧の中は CHECK 制約から読み取った中身（年月 YYYY-MM・日付・真偽 0/1・列挙・JSON）',
    '- **NULL**: 不可＝必ず値が入る',
    '- **制約**: PK＝主キー、Unique＝一意、FK →＝参照先、値:＝入れられる値の一覧、CHECK:＝その他の条件',
    '- **表の制約**: 複数の列にまたがる一意・参照・CHECK と、索引・トリガー（書き換えや削除を止めるものを含む）',
    '',
  ].join('\n');
  files.set('README.md', readme);
  for (const [d, ts] of groups) {
    const body = [
      GENERATED,
      `# ${domainLabel(d)}（${d}）の表`,
      '',
      '[目次へ戻る](README.md)',
      '',
      '## ER 図',
      '',
      erDiagram(ts, dict),
      '',
      `主キーと参照の列だけを載せる。組織（${[...OMIT_FROM_ER].join('・')}）への参照は省く。`,
      '',
      '## 表の一覧',
      '',
      '| 表 | 論理名 | 説明 |',
      '|---|---|---|',
      ...ts.map(t => `| [${t.name}](#${t.name}) | ${cellText(dict.tables[t.name]?.name)} | ${cellText(dict.tables[t.name]?.description)} |`),
      '',
    ];
    for (const t of ts) {
      const {rows, extras} = describeTable(t, dict);
      body.push(
        `## ${t.name}`,
        '',
        `**${cellText(dict.tables[t.name]?.name || '（論理名なし）')}** — ${cellText(dict.tables[t.name]?.description || '（説明なし）')}`,
        '',
        '| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |',
        '|---|---|---|---|---|---|---|',
        ...rows.map(r => `| ${r.no} | ${r.name} | ${cellText(r.type)} | ${cellText(r.note)} | ${r.nullable} | ${cellText(r.dflt)} | ${cellText(r.rules)} |`),
        '',
      );
      if (extras.length) body.push('表の制約:', '', ...extras.map(x => `- ${cellText(x)}`), '');
    }
    files.set(`${d}.md`, body.join('\n'));
  }
  return files;
}

export function xlsxSheets(tables, dict) {
  const groups = groupByDomain(tables, dict);
  const sheetName = (i, d) => `§${String(i + 2).padStart(3, '0')} ${domainLabel(d)}`;
  const sheets = [
    {name: '§000 改訂履歴', rows: [['版数', '日付', '改訂者', '改訂内容'], ...dict.revisions.map(r => [r.version, r.date, r.author, r.note])]},
    {name: '§001 目次', rows: [['ページ名', '領域', '表', '論理名', '内容'],
      ...groups.flatMap(([d, ts], i) => ts.map(t => [sheetName(i, d), domainLabel(d), t.name, dict.tables[t.name]?.name || '', dict.tables[t.name]?.description || '']))]},
  ];
  groups.forEach(([d, ts], i) => sheets.push({name: sheetName(i, d), rows: [
    ['表', '論理名', 'No', 'カラム名', 'データ型', '説明', 'NULL', 'デフォルト値', '制約'],
    ...ts.flatMap(t => describeTable(t, dict).rows.map(r => [t.name, dict.tables[t.name]?.name || '', r.no, r.name, r.type, r.note, r.nullable, r.dflt, r.rules])),
  ]}));
  return sheets;
}

export function openSchema() {
  const db = new LocalDatabase(':memory:');
  try { return readSchema(db.raw); } finally { db.close(); }
}

export function plan({tables = openSchema(), dict = loadDictionary()} = {}) {
  const want = render(tables, dict);
  const have = existsSync(DOC_DIR) ? readdirSync(DOC_DIR).filter(n => n.endsWith('.md')) : [];
  const stale = have.filter(n => !want.has(n));
  const differ = [...want].filter(([n, text]) => !existsSync(join(DOC_DIR, n)) ||
    readFileSync(join(DOC_DIR, n), 'utf8').replace(/\r\n/g, '\n') !== text).map(([n]) => n);
  return {want, stale, differ, problems: dictionaryProblems(tables, dict), tables, dict};
}

const isMain = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (isMain()) {
  const {want, stale, differ, problems, tables, dict} = plan();
  if (process.argv.includes('--check')) {
    for (const n of differ) console.log(`ずれ: docs/database/${n}`);
    for (const n of stale) console.log(`生成されない md が残っている: docs/database/${n}`);
    for (const p of problems) console.log(`辞書: ${p}`);
    const bad = differ.length + stale.length + problems.length;
    if (!bad) console.log(`定義書 ${want.size} 本は DB と辞書にそろっている`);
    process.exit(bad ? 1 : 0);
  }
  mkdirSync(DOC_DIR, {recursive: true});
  for (const n of differ) writeFileSync(join(DOC_DIR, n), want.get(n), 'utf8');
  for (const n of stale) rmSync(join(DOC_DIR, n));
  console.log(`定義書 ${want.size} 本（書き直し ${differ.length}・消した md ${stale.length}）。辞書の抜け ${problems.length} 件`);
  if (process.argv.includes('--xlsx')) {
    mkdirSync(dirname(XLSX_PATH), {recursive: true});
    writeFileSync(XLSX_PATH, encodeXlsx(xlsxSheets(tables, dict)));
    console.log(`Excel 版: ${XLSX_PATH}`);
  }
}
