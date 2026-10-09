// F8: /api/bootstrap と GET /api/:resource が見てよい案件のIDを IN (?,…) に全部並べていたため、
// D1（1つの問い合わせに値100個まで）では案件が100件近くある組織で読み込めず、組織の切替の直後も読み直せなかった。
// Worker と同じ条件で確かめるため、値の数を数えて100個を超えたら D1 と同じく失敗させる包みを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {identityForEmail, ORG_HEADER} from '../src/session-org.mjs';

const PROJECTS = 150;

function d1Limited(inner) {
  const seen = {maxParams: 0};
  const check = (params = []) => {
    seen.maxParams = Math.max(seen.maxParams, params.length);
    if (params.length > 100) throw new Error(`D1 の上限（100値）を超えました: ${params.length}`);
  };
  return Object.assign(Object.create(inner), {
    seen,
    all: (sql, params = []) => { check(params); return inner.all(sql, params); },
    get: (sql, params = []) => { check(params); return inner.get(sql, params); },
    run: (sql, params = []) => { check(params); return inner.run(sql, params); },
    batch: (statements) => { statements.forEach((statement) => check(statement.params)); return inner.batch(statements); },
  });
}

async function setup({t} = {}) {
  const raw = await openTestDb({t});
  // 組織1に案件・作品を150件足す（fixture の案件1・作品1と合わせて151件）。編集担当は全部の案件に編集権限を持つ
  const projects = Array.from({length: PROJECTS}, (_, index) => `(${1000 + index},1,'PRJ-BULK-${index}','架空の一括案件${index}','active',${index})`).join(',');
  const works = Array.from({length: PROJECTS}, (_, index) => `(${1000 + index},1,${1000 + index},'WRK-BULK-${index}','架空の一括作品${index}','film',${index})`).join(',');
  const memberships = Array.from({length: PROJECTS}, (_, index) => `(1,${1000 + index},2,'edit')`).join(',');
  await raw.batch([
    {sql: `INSERT INTO projects(id,org_id,code,title,status,budget_yen) VALUES ${projects}`},
    {sql: `INSERT INTO works(id,org_id,project_id,code,title,format,forecast_yen) VALUES ${works}`},
    {sql: `INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES ${memberships}`},
    {sql: "INSERT INTO scenes(org_id,project_id,work_id,scene_no,day_night,location,synopsis,status) VALUES (1,1149,1149,'1','D','架空ロケ地','架空の場面','draft')"},
  ]);
  const db = d1Limited(raw);
  let email = 'admin@openingnight.invalid';
  const app = createApp({db, mode: 'worker', authenticate: (request, database) => identityForEmail(database, email, request.headers.get('cookie'))});
  return {raw, db, app, as: (next) => { email = next; }};
}
const get = async (app, path) => {
  const response = await app.request(`/api${path}`, {headers: {[ORG_HEADER]: '1'}});
  return {status: response.status, body: await response.json()};
};

test('bootstrap and resource lists stay within the D1 bind limit for an admin with 151 projects', async (t) => {
  const f = await setup({t});
  const boot = await get(f.app, '/bootstrap');
  assert.equal(boot.status, 200, JSON.stringify(boot.body).slice(0, 200));
  assert.equal(boot.body.projects.length, PROJECTS + 1);
  assert.equal(boot.body.works.length, PROJECTS + 1);
  assert.deepEqual(boot.body.projects.slice(0, 2).map((row) => row.id), [1, 1000], '並びは案件ID順のまま');
  assert.ok(boot.body.projects.every((row) => 'budget_yen' in row), '管理者には金額を出す');
  for (const [path, expected] of [['/projects', PROJECTS + 1], ['/works', PROJECTS + 1], ['/scenes', 1], ['/expenses', 0], ['/opportunities', 0], ['/campaigns', 0], ['/exposures', 0], ['/observations', 0]]) {
    const listed = await get(f.app, path);
    assert.equal(listed.status, 200, `${path} ${JSON.stringify(listed.body).slice(0, 200)}`);
    assert.equal(listed.body.rows.length, expected, path);
  }
  assert.equal((await get(f.app, '/projects')).body.rows[0].id, 1149, '一覧は新しい順のまま');
  // 権利・分配の試算も、財務権限のある案件を同じ形（副問い合わせ）で絞る
  assert.equal((await get(f.app, '/settlement/preview?workId=1')).status, 200);
  assert.ok(f.db.seen.maxParams <= 100, `最大 ${f.db.seen.maxParams} 値`);
});

test('an editor with 150 project memberships also loads, and only sees the permitted projects', async (t) => {
  const f = await setup({t});
  f.as('editor@openingnight.invalid');
  // 編集担当は fixture の案件1（edit）と一括案件150件の権限を持つ。別組織の案件2は見えない
  const boot = await get(f.app, '/bootstrap');
  assert.equal(boot.status, 200, JSON.stringify(boot.body).slice(0, 200));
  assert.equal(boot.body.projects.length, PROJECTS + 1);
  assert.ok(!boot.body.projects.some((row) => row.id === 2));
  // 権限の期限が切れた案件は外れる
  await f.raw.run("UPDATE project_memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE project_id=1000 AND user_id=2");
  const after = await get(f.app, '/bootstrap');
  assert.equal(after.body.projects.length, PROJECTS);
  assert.ok(!after.body.projects.some((row) => row.id === 1000));
  assert.equal(after.body.works.length, PROJECTS);
  for (const path of ['/projects', '/works', '/expenses', '/scenes']) {
    const listed = await get(f.app, path);
    assert.equal(listed.status, 200, `${path} ${JSON.stringify(listed.body).slice(0, 200)}`);
  }
  assert.equal((await get(f.app, '/works')).body.rows.length, PROJECTS);
  assert.equal((await get(f.app, '/settlement/preview?workId=1001')).status, 200);
  assert.ok(f.db.seen.maxParams <= 100, `最大 ${f.db.seen.maxParams} 値`);
});
