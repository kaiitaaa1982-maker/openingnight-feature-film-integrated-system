import test from 'node:test';
import assert from 'node:assert/strict';
import {allIn, IN_CHUNK} from '../src/sql-in.mjs';

test('allIn splits long IN lists so that no query binds more than 100 values (D1 limit)', async () => {
  const calls = [];
  const db = {all: async (sql, params) => { calls.push({sql, params}); return params.slice(1).map((id) => ({id})); }};
  const ids = Array.from({length: 250}, (_, n) => 250 - n);
  const rows = await allIn(db, 'SELECT id FROM t WHERE org_id=? AND id IN (:in)', {before: [1], ids, sortBy: (a, b) => a.id - b.id});
  assert.equal(calls.length, Math.ceil(250 / IN_CHUNK));
  assert.ok(calls.every((call) => call.params.length <= 100), 'every query binds at most 100 values');
  assert.ok(calls.every((call) => (call.sql.match(/\?/g) || []).length === call.params.length));
  assert.equal(rows.length, 250);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.id), [1, 2, 3], 'sorted after joining the chunks');
  assert.deepEqual(await allIn(db, 'SELECT 1 WHERE x IN (:in)', {ids: []}), []);
  await assert.rejects(() => allIn(db, 'SELECT 1', {ids: [1]}), /\(:in\)/);
});
