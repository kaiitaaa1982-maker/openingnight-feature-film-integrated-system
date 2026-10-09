// 共通のエラーの種類（FR-CORE-DATA-015・016）。DB によらず、アプリが分岐に使う制約の違反の分類。
// SQLite（node:sqlite・D1）のエラーと PostgreSQL の SQLSTATE を同じ種類に変える。入口（src/db.mjs・src/d1-db.mjs・src/data-platform/pg-db.mjs）が
// 投げるエラーに dbError を付け、アプリは dbErrorOf・isDbConflict・isConstraintViolation などで見分ける（エラーの文で分岐しない。docs/rules/dialect.md）。
// エラーの文（message）は変えない（画面に出している文をそのまま残すため）。
// Worker でも動く（node:* を使わない）。

export const DB_ERROR_KINDS = Object.freeze({
  unique: '一意の違反',
  check: '値の範囲の違反',
  foreign_key: '参照先が無い',
  not_null: '必須の値が無い',
  raise: 'トリガーの拒否',
  out_of_range: '安全な整数の範囲を超えた値',
  read_only: '読み取りの一括の中の書き込み',
  unsupported_type: 'SQLite の入口に無い型（配列など）',
  invalid_input: '型に読めない値（読み取りの条件など）',
});

// 制約の違反（SQLite の「… constraint failed」にあたるもの）。トリガーの拒否（raise）は含めない
const CONSTRAINT_KINDS = new Set(['unique', 'check', 'foreign_key', 'not_null']);

// 入口が自分で止めたときのエラー（安全な整数を超えた値・整数の列への小数の定数など）
export class DbError extends Error {
  constructor(kind, message, {table = null, columns = [], constraint = null, code = null, cause} = {}) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'DbError';
    this.dbError = {kind, table, columns, constraint, code};
  }
}

// PostgreSQL の SQLSTATE → 種類。22P02（読めない値。WHERE id = 'abc' など）と 22003（範囲外）は invalid_input にする。
// 書き込みの文で起きたときだけ、SQLite で同じ値が整数の強制の CHECK（money.md の typeof）に止められるのに合わせて check にする
// （attachDbError の inWrite。PostgreSQL の入口が文を見て渡す）。読み取りの型の誤りを制約の違反（409）にしない
const PG_CODES = {
  '23505': 'unique', '23514': 'check', '23503': 'foreign_key', '23502': 'not_null', P0001: 'raise', '22P02': 'invalid_input', '22003': 'invalid_input',
  '25006': 'read_only',
};

// node:sqlite の拡張の結果コード → 種類（https://sqlite.org/rescode.html）
const SQLITE_CODES = {2067: 'unique', 1555: 'unique', 275: 'check', 3091: 'check', 787: 'foreign_key', 1299: 'not_null', 1811: 'raise', 8: 'read_only'};

// "t.a, t.b" → {table: 't', columns: ['a', 'b']}
function tableColumns(list) {
  const parts = String(list).split(',').map((part) => part.trim()).filter(Boolean);
  const table = parts[0]?.includes('.') ? parts[0].slice(0, parts[0].indexOf('.')) : null;
  return {table, columns: parts.map((part) => part.slice(part.indexOf('.') + 1))};
}

// SQLite の文（node:sqlite・D1）を読む。D1 は前後に "D1_ERROR: " と ": SQLITE_CONSTRAINT…" を付けることがある
// SQLite の文の読み方はこの2つだけ（docs/rules/dialect.md の「エラーの見分け方」。アプリは文で分岐しない）
const SQLITE_SUFFIX = /^(.*?)(?::\s*(SQLITE_[A-Z_]+)(?:\s*\(.*\))?)?\s*$/s;
const SQLITE_CONSTRAINT = /^(UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed(?::\s*(.*))?$/s;
const SQLITE_WORDS = {UNIQUE: 'unique', 'NOT NULL': 'not_null', CHECK: 'check', 'FOREIGN KEY': 'foreign_key'};

function fromSqliteMessage(raw, errcode) {
  const [, core = '', resultCode = ''] = SQLITE_SUFFIX.exec(String(raw || '').replace(/^(?:D1_ERROR|D1_EXEC_ERROR|Error):\s*/i, '')) || [];
  const text = core.trim();
  const failed = SQLITE_CONSTRAINT.exec(text);
  if (failed) {
    const kind = SQLITE_WORDS[failed[1]];
    const detail = (failed[2] ?? '').trim();
    if (kind === 'check') return {kind, table: null, columns: [], constraint: detail};
    if (kind === 'foreign_key') return {kind, table: null, columns: [], constraint: null};
    return {kind, ...tableColumns(detail), constraint: null};
  }
  const kind = SQLITE_CODES[errcode];
  // トリガーの RAISE(ABORT, '文') は、文だけが返る（node:sqlite は拡張コード 1811、D1 は末尾に結果コードの SQLITE_CONSTRAINT を付ける）
  if (kind === 'raise' || (!kind && resultCode.startsWith('SQLITE_CONSTRAINT'))) return {kind: 'raise', table: null, columns: [], constraint: null, message: text};
  return kind ? {kind, table: null, columns: [], constraint: null} : null;
}

// PostgreSQL のエラー（pg・PGlite の DatabaseError）。一意と外部キーの列は detail の "Key (a, b)=(…)" から読む
function fromPostgres(error) {
  const kind = PG_CODES[error.code];
  if (!kind) return null;
  const key = /^Key \(([^)]*)\)/.exec(String(error.detail || ''));
  const columns = key ? key[1].split(',').map((name) => name.trim().replace(/^"|"$/g, '')) : error.column ? [error.column] : [];
  return {kind, table: error.table || null, columns, constraint: error.constraint || null, code: error.code};
}

// エラー → {kind, table, columns, constraint, code}。DB の制約の違反でなければ null
export function classifyDbError(error) {
  if (!error || typeof error !== 'object') return null;
  if (error.dbError && typeof error.dbError.kind === 'string') return error.dbError;
  if (typeof error.code === 'string' && /^(?:[0-9A-Z]{5})$/.test(error.code) && (error.severity || PG_CODES[error.code])) return fromPostgres(error);
  const sqlite = fromSqliteMessage(error.message, error.errcode);
  return sqlite ? {code: error.errcode ?? null, ...sqlite} : null;
}

// 入口が投げる前に呼ぶ。エラーの文は変えずに dbError を付けて返す。
// inWrite: 書き込みの文（INSERT・UPDATE）のエラーなら true。読めない値（invalid_input）を、値の範囲の違反（check）として付ける
export function attachDbError(error, {inWrite = false} = {}) {
  if (error && typeof error === 'object' && !error.dbError) {
    let found = classifyDbError(error);
    if (found?.kind === 'invalid_input' && inWrite) found = {...found, kind: 'check'};
    if (found) {
      try { Object.defineProperty(error, 'dbError', {value: found, enumerable: false, configurable: true, writable: true}); } catch { /* 凍結されたエラーは付けずに投げる */ }
    }
  }
  return error;
}

export const dbErrorOf = (error) => classifyDbError(error);
export const dbErrorKind = (error) => classifyDbError(error)?.kind ?? null;

// 制約の違反（一意・CHECK・外部キー・NOT NULL）。トリガーの拒否は含めない
export const isConstraintViolation = (error) => CONSTRAINT_KINDS.has(dbErrorKind(error));

// 衝突として 409 を返す DB のエラー（制約の違反とトリガーの拒否）。受け口の状態の番号の判定はこれを使う。
// 置き換える前の照合（/constraint/i）は、D1 がトリガーの拒否の文の後ろに付ける「: SQLITE_CONSTRAINT」に当たり、本番（D1）では 409 を返していた。
// その番号を保つため raise を含める（手元の node:sqlite と PostgreSQL も 409 にそろう。記録 2026-10-03-pg-adapter.md の動きの違い3）
export const isDbConflict = (error) => {
  const kind = dbErrorKind(error);
  return CONSTRAINT_KINDS.has(kind) || kind === 'raise';
};

// 一意の違反。tables を渡すと、その表（文字列か配列）の違反だけ
export function isUniqueViolation(error, tables = null) {
  const found = classifyDbError(error);
  if (found?.kind !== 'unique') return false;
  if (tables === null) return true;
  return (Array.isArray(tables) ? tables : [tables]).includes(found.table);
}

// 同時更新の止め（transaction_guards の CHECK(value=1)。docs/rules/database.md）が失敗した
export function isGuardViolation(error) {
  const found = classifyDbError(error);
  if (found?.kind !== 'check') return false;
  return found.table === 'transaction_guards' || found.constraint?.replace(/\s+/g, '') === 'value=1';
}

// API の応答に載せる形（画面は ApiError の body.dbError で分岐する。FR-CORE-DATA-016）
export function dbErrorBody(error) {
  const found = classifyDbError(error);
  return found ? {kind: found.kind, table: found.table ?? null, columns: found.columns ?? []} : null;
}

// 画面の側: ApiError の本体から種類を読む（サーバーが dbErrorBody を載せたとき）
export const apiDbError = (error) => (error && typeof error === 'object' && error.body && typeof error.body === 'object' ? error.body.dbError ?? null : null);
export const isConstraintKind = (kind) => CONSTRAINT_KINDS.has(kind);
