// 受け口が読んだあとに、ほかの書き込みが割り込む DB（試験の道具）。受け口の DB（createApp の db）に proxy を渡し、state.race を置くと、
// sql が pattern に当たる文を含む batch の前に一度だけ race を流す（ほかの画面が先に書いた状況）。state.error も置くと、race のあと
// 本物の batch の代わりにそのエラーを投げる（PostgreSQL の同時の書き込みでだけ起きる負け方の再現。SQLite と PGlite は1本の接続で順に
// 処理するので本物では起きない。docs/rules/testing.md の「同時に書く試験」）。race と error は一度使うと消える
import {attachDbError} from '../src/data-platform/db-errors.mjs';

export function racingBatchDb(db, pattern) {
  const state = {race: null, error: null};
  const proxy = new Proxy(db, {get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    if (prop !== 'batch') return value.bind(target);
    return async (statements) => {
      if (state.race && statements.some((s) => pattern.test(s.sql))) {
        const {race, error} = state;
        state.race = null;
        state.error = null;
        await race();
        if (error) throw error;
      }
      return value.call(target, statements);
    };
  }});
  return {proxy, state};
}

// PostgreSQL で同じ親の版を同時に足したときの、後の側のエラー（pg の DatabaseError と同じ形。SQLSTATE 23505）。両方の版の番号のトリガーが
// 「最後の番号の次」の判定を通り、先の側が確定したあと、主キー・一意の制約で後の側が落ちる。入口（src/data-platform/pg-db.mjs）と同じく dbError を付ける
export function pgUniqueViolation({table, constraint, columns, values}) {
  const error = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  Object.assign(error, {name: 'DatabaseError', code: '23505', severity: 'ERROR', schema: 'public', table, constraint,
    detail: `Key (${columns.join(', ')})=(${values.join(', ')}) already exists.`});
  return attachDbError(error);
}
