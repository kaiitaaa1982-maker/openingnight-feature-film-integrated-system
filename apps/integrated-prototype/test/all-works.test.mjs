// 全案件の受け口（GET /api/works/activity）と、その計算（src/ledger/all-works/all-works-model.mjs）。
// 約束: 作品を選ばずに、見てよい全作品の日々スケ・経費・台本の行を新しい日付から返す。作品・種類・日付で絞れる。
// 見てよくない作品の行は出さない（work_id に書いても出さない）。経費は財務の権限がある人だけ。件数の上限とページ送りが効く。
// データはすべて架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {parseActivityQuery, activityRows, pageActivity, ActivityQueryError, MAX_LIMIT} from '../src/ledger/all-works/all-works-model.mjs';

// 架空の作品を2つ（案件も別）。編集担当は案件 101 だけ（edit）、制作担当は案件 101 だけ（production）に所属する。
// 案件 102 には管理者しか入れない。
async function fixture(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  await db.run("INSERT INTO projects(id,org_id,code,title,status,budget_yen) VALUES(101,1,'PRJ-AW-A','架空案件A','active',1000000),(102,1,'PRJ-AW-B','架空案件B','active',1000000)");
  await db.run("INSERT INTO works(id,org_id,project_id,code,title,format,forecast_yen) VALUES(101,1,101,'WRK-AW-A','架空作品A','film',0),(102,1,102,'WRK-AW-B','架空作品B','film',0)");
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,101,2,'edit'),(1,101,3,'production')");
  // 撮影日（日々スケ）
  await db.run("INSERT INTO shooting_days(id,org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(9101,1,101,101,'2026-10-05','A班','架空の撮影2日目',1),(9102,1,102,102,'2026-10-03','B班','架空の撮影1日目',1)");
  await db.run("INSERT INTO production_characters(org_id,work_id,key,name) VALUES(1,101,'c1','架空の役1'),(1,101,'c2','架空の役2')");
  await db.run("INSERT INTO production_calls(org_id,work_id,day_id,character_key,call_time) VALUES(1,101,9101,'c1','08:30'),(1,101,9101,'c2','07:00')");
  // 経費
  await db.run(`INSERT INTO expenses(id,org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax)
    VALUES(9201,1,101,101,'2026-10-04','2026-10','宿泊費','架空の宿',10000,1000,11000),(9202,1,102,102,'2026-10-02','2026-10','交通費','架空の移動',5000,500,5500)`);
  // 台本の原本（9302 だけ香盤へ確定していない）
  const artifact = (id, project, work, sha, created) => db.run(`INSERT INTO workflow_raw_artifacts(id,org_id,project_id,work_id,kind,file_name,media_type,byte_length,raw_sha256,original_base64,extractor_name,extractor_version,extraction_json,extraction_status,created_by,created_at)
    VALUES(?,1,?,?,'script',?,'text/plain',4,?,'dGVzdA==','test','1','{}','extracted',1,?)`, [id, project, work, `架空の台本${id}.txt`, sha.repeat(64), created]);
  await artifact(9301, 101, 101, 'a', '2026-10-01 10:00:00');
  await artifact(9302, 102, 102, 'b', '2026-10-06 09:00:00');
  await db.run("INSERT INTO workflow_script_reviews(id,org_id,artifact_id,work_id,version_no,scenes_json,review_hash,reviewed_by) VALUES(9401,1,9301,101,1,'[]','h1',1)");
  await db.run("INSERT INTO workflow_script_commits(org_id,artifact_id,review_id,work_id,preview_token,proposal_hash,committed_by) VALUES(1,9301,9401,101,'tok-aw-1','p1',1)");
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const cookies = {admin: await login('admin@openingnight.invalid'), editor: await login('editor@openingnight.invalid'), production: await login('production@openingnight.invalid')};
  const get = async (who, search = '') => {
    const response = await app.request(`/api/works/activity${search}`, {headers: {cookie: cookies[who]}});
    return {status: response.status, body: await response.json()};
  };
  return {db, get};
}

const keys = (body) => body.rows.map((row) => row.key);
// 架空作品A・B の行だけ（ほかの作品の行が試作の DB にあっても比べない）
const AW = '?work_id=101,102';

test('全案件は2つの作品の日々スケ・経費・台本を混ぜて、新しい日付から返す', async (t) => {
  const {get} = await fixture(t);
  const {status, body} = await get('admin', AW);
  assert.equal(status, 200);
  assert.deepEqual(keys(body), ['script:9302', 'schedule:9101', 'expense:9201', 'schedule:9102', 'expense:9202', 'script:9301']);
  assert.deepEqual(body.rows.map((row) => [row.date, row.work.code, row.kindLabel]), [
    ['2026-10-06', 'WRK-AW-B', '台本'], ['2026-10-05', 'WRK-AW-A', '日々スケ'], ['2026-10-04', 'WRK-AW-A', '経費'],
    ['2026-10-03', 'WRK-AW-B', '日々スケ'], ['2026-10-02', 'WRK-AW-B', '経費'], ['2026-10-01', 'WRK-AW-A', '台本'],
  ]);
  const day = body.rows.find((row) => row.key === 'schedule:9101');
  assert.equal(day.summary, '架空の撮影2日目　A班　入り 07:00', '入りはその日の出演のうち最も早い時刻');
  assert.deepEqual(day.open, {page: '制作', params: {tab: 'day', day: '9101'}, workId: 101});
  assert.equal(day.amount, null);
  const expense = body.rows.find((row) => row.key === 'expense:9201');
  assert.deepEqual([expense.summary, expense.amount, expense.status, expense.open.page, expense.open.workId], ['宿泊費　架空の宿', 11000, '未整備', '経費', 101]);
  const unconfirmed = body.rows.find((row) => row.key === 'script:9302');
  assert.deepEqual([unconfirmed.status, unconfirmed.attention, unconfirmed.open.page, unconfirmed.open.workId], ['要確認', true, '台本・香盤', 102]);
  const confirmed = body.rows.find((row) => row.key === 'script:9301');
  assert.deepEqual([confirmed.status, confirmed.attention], ['確定', false]);
  assert.equal(body.attention, 1, '香盤へ確定していない台本の数');
  assert.equal(body.nextOffset, null);
  assert.ok(body.works.some((work) => work.id === 101) && body.works.some((work) => work.id === 102));
});

test('work_id で1つの作品に絞ると、その作品の行だけが返る', async (t) => {
  const {get} = await fixture(t);
  const {body} = await get('admin', '?work_id=102');
  assert.deepEqual(keys(body), ['script:9302', 'schedule:9102', 'expense:9202']);
  const kinds = await get('admin', `${AW}&kind=schedule&kind=script`);
  assert.deepEqual(keys(kinds.body), ['script:9302', 'schedule:9101', 'schedule:9102', 'script:9301'], '種類も重ねて絞れる');
  const dates = await get('admin', `${AW}&from=2026-10-02&to=2026-10-04`);
  assert.deepEqual(keys(dates.body), ['expense:9201', 'schedule:9102', 'expense:9202'], '日付の両端を含む');
});

test('見る権限の無い作品の行は出ない（work_id に書いても出さない）', async (t) => {
  const {get} = await fixture(t);
  const editor = await get('editor', AW);
  assert.equal(editor.status, 200);
  assert.deepEqual(keys(editor.body), ['schedule:9101', 'expense:9201', 'script:9301']);
  assert.equal(editor.body.works.some((work) => work.id === 102), false, '作品の札にも出さない');
  assert.equal(editor.body.attention, 0, '見られない作品の台本は要確認に数えない');
  const named = await get('editor', '?work_id=102');
  assert.equal(named.status, 200);
  assert.deepEqual(named.body.rows, []);
  // 制作担当は案件に所属していても経費（財務）を見ない。種類の札にも経費を出さない
  const production = await get('production', AW);
  assert.deepEqual(keys(production.body), ['schedule:9101', 'script:9301']);
  assert.deepEqual(production.body.kinds.map((kind) => kind.id), ['schedule', 'script']);
});

test('件数の上限で切り、続きは nextOffset から同じ並びで読める', async (t) => {
  const {get} = await fixture(t);
  const first = await get('admin', `${AW}&limit=4`);
  assert.deepEqual(keys(first.body), ['script:9302', 'schedule:9101', 'expense:9201', 'schedule:9102']);
  assert.equal(first.body.nextOffset, 4);
  const second = await get('admin', `${AW}&limit=4&offset=4`);
  assert.deepEqual(keys(second.body), ['expense:9202', 'script:9301']);
  assert.equal(second.body.nextOffset, null);
  const exact = await get('admin', `${AW}&limit=6`);
  assert.equal(exact.body.rows.length, 6);
  assert.equal(exact.body.nextOffset, null, 'ちょうど6件で終わるときは続きが無い');
});

test('読めない引数は 400 で断る', async (t) => {
  const {get} = await fixture(t);
  for (const search of ['?kind=sales', '?work_id=abc', '?from=2026-13-01', `?limit=${MAX_LIMIT + 1}`, '?limit=0', '?from=2026-10-05&to=2026-10-01']) {
    const {status} = await get('admin', search);
    assert.equal(status, 400, search);
  }
});

test('引数の読み取り: 既定・重ねた値・上限ちょうど', () => {
  assert.deepEqual(parseActivityQuery({}), {workIds: [], kinds: ['schedule', 'expense', 'script'], from: null, to: null, limit: 100, offset: 0});
  assert.deepEqual(parseActivityQuery({work_id: ['3,1', '3'], kind: ['script', 'schedule']}).workIds, [3, 1]);
  assert.deepEqual(parseActivityQuery({kind: ['script', 'schedule']}).kinds, ['schedule', 'script']);
  assert.equal(parseActivityQuery({limit: String(MAX_LIMIT)}).limit, MAX_LIMIT);
  assert.throws(() => parseActivityQuery({work_id: Array.from({length: 51}, (_, i) => String(i + 1))}), ActivityQueryError);
  assert.equal(parseActivityQuery({work_id: Array.from({length: 50}, (_, i) => String(i + 1))}).workIds.length, 50);
  assert.throws(() => parseActivityQuery({from: '2026-02-30'}), ActivityQueryError);
});

test('撮影日の状態は今日より前が済み・今日がいま・後が予定。見てよくない作品の行は落とす', () => {
  const works = [{id: 1, code: 'W1', title: '架空1'}];
  const rows = activityRows({today: '2026-10-05', works, schedule: [
    {id: 1, work_id: 1, date: '2026-10-04', label: '架空', unit: 'A'},
    {id: 2, work_id: 1, date: '2026-10-05', label: '架空', unit: 'A'},
    {id: 3, work_id: 1, date: '2026-10-06', label: '架空', unit: 'A'},
    {id: 4, work_id: 2, date: '2026-10-06', label: '架空', unit: 'A'},
  ]});
  assert.deepEqual(rows.map((row) => [row.id, row.status]), [[1, '済み'], [2, 'いま'], [3, '予定']]);
  const paged = pageActivity(rows, {offset: 0, limit: 2});
  assert.deepEqual(paged.rows.map((row) => row.id), [3, 2]);
  assert.equal(paged.nextOffset, 2);
});
