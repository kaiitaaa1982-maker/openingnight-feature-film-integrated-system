// 制作の実費の行（会社ルートの plans/2026-11-20-genba-inbox.md の手順8、移行 0068）を、DB の制約と受け口
// （src/expenses/production-actual/actual-lines-routes.mjs）で確かめる。期待値は要件 docs/requirements/expenses/production-cost.md の
// FR-EXP-PCOST-009・010・015・033・036・043〜046・要確認14 と brain の D-047 の3・7（未確認の印つきで入り合計に出る・まとめて確かめる・AI の読みの記録）から持ってくる。
// 合計の期待値は、送った行の額から試験の中で手で足した数（実装の関数を使わない）。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 架空のデータだけを使う（組織1・2と利用者・案件1・取引先1〜4は試作の行。作品・撮影日・原本は試験の中で足す。店名は架空）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {todayJst} from '../src/billing/receipt-model.mjs';

const ADMIN = 1;
const DEMO_PROJECT = 1;
const IMMUTABLE = /production actual record immutable/;
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});

async function addWork(db, code, {orgId = 1, projectId = DEMO_PROJECT} = {}) {
  return Number((await db.get('INSERT INTO works(org_id,project_id,code,title) VALUES(?,?,?,?) RETURNING id', [orgId, projectId, code, `${code}（架空）`])).id);
}
async function addDay(db, workId, date, {orgId = 1, projectId = DEMO_PROJECT, createdBy = ADMIN} = {}) {
  return Number((await db.get(`INSERT INTO shooting_days(org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(?,?,?,?,'本隊','架空の撮影日',?) RETURNING id`,
    [orgId, projectId, workId, date, createdBy])).id);
}
async function addDocument(db, sha, {orgId = 1, receivedBy = ADMIN} = {}) {
  return Number((await db.get(`INSERT INTO source_documents(org_id,kind,file_name,byte_length,sha256,storage,content_base64,received_on,received_by)
    VALUES(?,'receipt','架空の領収書.jpg',1,?,'inline','AA==','2026-01-10',?) RETURNING id`, [orgId, sha, receivedBy])).id);
}

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
  return {login, call};
}
const path = (workId, entry = '') => `/expenses/works/${workId}/actual-lines${entry ? `/${entry}` : ''}`;
const lineCount = async (db, workId) => Number((await db.get('SELECT COUNT(*) AS n FROM production_actual_lines WHERE work_id=?', [workId])).n);
const human = (overrides = {}) => ({spentOn: '2026-01-10', categoryCode: 'D', payeeName: '架空照明店', incTaxYen: 11000, exTaxYen: 10000, taxYen: 1000, entryMethod: 'human', ...overrides});
const READ_ALL = ['spentOn', 'categoryCode', 'payeeName', 'incTaxYen', 'exTaxYen', 'taxYen'];
const ai = (overrides = {}, aiRead = {}) => ({spentOn: '2026-01-10', categoryCode: 'H', payeeName: '架空弁当店', incTaxYen: 5400, exTaxYen: 5000, taxYen: 400,
  entryMethod: 'ai', aiRead: {model: 'fict-reader-1', readFields: READ_ALL, unreadFields: [], ...aiRead}, ...overrides});
const zero = {count: 0, incTaxYen: 0, exTaxYen: 0, taxYen: 0, exTaxUnknownCount: 0, exTaxUnknownIncTaxYen: 0};
// 合計を明細から手で足す（期待値を実装に頼らない）
const add = (rows) => rows.reduce((s, r) => ({count: s.count + 1, incTaxYen: s.incTaxYen + r.incTaxYen, exTaxYen: s.exTaxYen + (r.exTaxYen ?? 0), taxYen: s.taxYen + (r.taxYen ?? 0),
  exTaxUnknownCount: s.exTaxUnknownCount + (r.exTaxYen === null ? 1 : 0), exTaxUnknownIncTaxYen: s.exTaxUnknownIncTaxYen + (r.exTaxYen === null ? r.incTaxYen : 0)}), {...zero});
const plus = (a, b) => Object.fromEntries(Object.keys(zero).map((k) => [k, a[k] + b[k]]));

test('FR-EXP-PCOST-010 実費の行・取消・確認の3表は追記だけで、アプリを通さない変更・削除も DB が断る', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-IMM');
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const added = await call(admin, path(work), {method: 'POST', payload: {lines: [human(), human({payeeName: '架空機材店'})]}});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const [first, second] = added.body.lineIds;
  assert.equal((await call(admin, path(work, `${first}/void`), {method: 'POST', payload: {reason: '架空の打ち間違い'}})).status, 201);
  assert.equal((await call(admin, path(work, 'checks'), {method: 'POST', payload: {lineIds: [second]}})).status, 200);
  await rejects(db.run('UPDATE production_actual_lines SET inc_tax_yen=1 WHERE id=?', [second]), 'raise', IMMUTABLE);
  await rejects(db.run('DELETE FROM production_actual_lines WHERE id=?', [second]), 'raise', IMMUTABLE);
  await rejects(db.run("UPDATE production_actual_line_voids SET reason='書き換え' WHERE line_id=?", [first]), 'raise', IMMUTABLE);
  await rejects(db.run('DELETE FROM production_actual_line_voids WHERE line_id=?', [first]), 'raise', IMMUTABLE);
  await rejects(db.run('UPDATE production_actual_line_checks SET checked_by=2 WHERE line_id=?', [second]), 'raise', IMMUTABLE);
  await rejects(db.run('DELETE FROM production_actual_line_checks WHERE line_id=?', [second]), 'raise', IMMUTABLE);
  assert.equal(await lineCount(db, work), 2);
  // 同じ行の2回目の取消・取消した行での置き換え・取消した行の確認も DB が断る
  await rejects(db.run("INSERT INTO production_actual_line_voids(org_id,work_id,line_id,reason,created_by) VALUES(1,?,?,'二重',1)", [work, first]), 'unique');
  await rejects(db.run("INSERT INTO production_actual_line_voids(org_id,work_id,line_id,reason,replacement_line_id,created_by) VALUES(1,?,?,'生き返らせる',?,1)", [work, second, first]),
    'raise', /voided production actual line cannot replace/);
  await rejects(db.run('INSERT INTO production_actual_line_checks(org_id,work_id,line_id,checked_by) VALUES(1,?,?,1)', [work, first]), 'raise', /voided production actual line cannot be checked/);
});

test('FR-EXP-PCOST-015 FR-EXP-PCOST-033 FR-EXP-PCOST-045 DB は費目 A〜K・税込＝税抜＋税額・税抜と税額のそろい・符号・AI の行だけの読みの記録・同じ作品の撮影日を、アプリを通さない書き込みでも守る', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-CHK');
  const other = await addWork(db, 'FICT-AL-OTH');
  const otherDay = await addDay(db, other, '2026-01-12');
  let n = 0;
  const insert = (v) => db.run(`INSERT INTO production_actual_lines(org_id,project_id,work_id,entry_key,spent_on,category_code,payee_name,inc_tax_yen,ex_tax_yen,tax_yen,shooting_day_id,
      entry_method,ai_read_json,created_by) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,1)`,
  [work, `fict-db-${++n}`, v.spentOn ?? '2026-01-10', v.categoryCode ?? 'A', v.payeeName ?? '架空店', v.incTaxYen ?? 1100, v.exTaxYen === undefined ? 1000 : v.exTaxYen,
    v.taxYen === undefined ? 100 : v.taxYen, v.shootingDayId ?? null, v.entryMethod ?? 'human', v.aiReadJson ?? null]);
  await insert({});
  await insert({exTaxYen: null, taxYen: null}); // 税抜・税額が不明の行は通る
  await insert({incTaxYen: -1100, exTaxYen: -1000, taxYen: -100}); // 符号のそろった負の額は DB が通す（受け口はいま正の額だけ）
  await insert({entryMethod: 'ai', aiReadJson: JSON.stringify({model: 'fict-reader-1', readFields: ['incTaxYen'], unreadFields: []})});
  await rejects(insert({categoryCode: 'L'}), 'check');
  await rejects(insert({categoryCode: 'a'}), 'check');
  await rejects(insert({incTaxYen: 1101}), 'check');
  await rejects(insert({taxYen: null}), 'check');
  await rejects(insert({exTaxYen: null}), 'check');
  await rejects(insert({incTaxYen: 0, exTaxYen: 0, taxYen: 0}), 'check');
  await rejects(insert({incTaxYen: 1100, exTaxYen: 1200, taxYen: -100}), 'check');
  await rejects(insert({spentOn: '2026-13-01'}), 'check');
  await rejects(insert({entryMethod: 'ai'}), 'check');
  await rejects(insert({entryMethod: 'human', aiReadJson: JSON.stringify({model: 'fict-reader-1'})}), 'check');
  await rejects(insert({entryMethod: 'ai', aiReadJson: JSON.stringify({readFields: []})}), 'check');
  await rejects(insert({shootingDayId: otherDay}), 'foreign_key');
  assert.equal(await lineCount(db, work), 4);
});

test('FR-EXP-PCOST-009 FR-EXP-PCOST-043 FR-EXP-PCOST-045 FR-EXP-PCOST-046 FR-EXP-PCOST-015 管理者が人と AI の行を足すと、未確認の印つきで合計に入り、日別・支払先別・費目別の合計が明細の和と一致し、税抜が不明の行は税込にだけ入る', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-SUM');
  const today = todayJst();
  const day = await addDay(db, work, today);
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const lines = [
    human({payeePartnerId: 1, payeeName: '架空シネマ', description: '架空の試写室'}),
    ai(),
    ai({spentOn: '2026-01-11', incTaxYen: 3240, exTaxYen: null, taxYen: null},
      {readFields: ['spentOn', 'categoryCode', 'payeeName', 'incTaxYen'], unreadFields: ['exTaxYen', 'taxYen']}),
    human({spentOn: today, categoryCode: 'F', payeePartnerId: 2, payeeName: '架空配信', incTaxYen: 22000, exTaxYen: 20000, taxYen: 2000, shootingDayId: day}),
  ];
  const added = await call(admin, path(work), {method: 'POST', payload: {lines}});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.lineIds.length, 4);
  const read = await call(admin, path(work));
  assert.equal(read.status, 200);
  const body = read.body;
  // 入れた行はどれも未確認の印つき（確認の行が無い）。印は列でなく確認の有無から導く
  assert.deepEqual(body.lines.map((l) => [l.payeeName, l.unconfirmed, l.check]), [
    ['架空シネマ', true, null], ['架空弁当店', true, null], ['架空弁当店', true, null], ['架空配信', true, null]]);
  assert.equal(body.unconfirmedCount, 4);
  assert.equal(body.canWrite, true);
  // AI の行は入れ方と読みの記録（読んだ欄・読めなかった欄・モデル名）を持ち、人の行は持たない
  assert.deepEqual(body.lines.map((l) => [l.entryMethod, l.aiRead]), [
    ['human', null],
    ['ai', {model: 'fict-reader-1', readFields: READ_ALL, unreadFields: []}],
    ['ai', {model: 'fict-reader-1', readFields: ['spentOn', 'categoryCode', 'payeeName', 'incTaxYen'], unreadFields: ['exTaxYen', 'taxYen']}],
    ['human', null]]);
  assert.deepEqual(body.lines.map((l) => [l.exTaxYen, l.taxYen, l.taxUnknown]), [[10000, 1000, false], [5000, 400, false], [null, null, true], [20000, 2000, false]]);
  const expected = add(lines.map((l) => ({incTaxYen: l.incTaxYen, exTaxYen: l.exTaxYen, taxYen: l.taxYen})));
  assert.deepEqual(expected, {count: 4, incTaxYen: 41640, exTaxYen: 35000, taxYen: 3400, exTaxUnknownCount: 1, exTaxUnknownIncTaxYen: 3240});
  // 未確認の行も合計に入り、合計は 確認済み・未確認 に分かれる（いまは全部が未確認）
  assert.deepEqual(body.totals.all, expected);
  assert.deepEqual(body.totals.unconfirmed, expected);
  assert.deepEqual(body.totals.confirmed, zero);
  assert.deepEqual(body.cumulative.all, expected);
  assert.deepEqual(body.todayTotal.all, {...zero, count: 1, incTaxYen: 22000, exTaxYen: 20000, taxYen: 2000});
  // 日別・支払先別・費目別
  assert.deepEqual(body.totals.byDay.map((g) => [g.spentOn, g.all.incTaxYen]), [['2026-01-10', 16400], ['2026-01-11', 3240], [today, 22000]]);
  assert.deepEqual(body.totals.byCategory.map((g) => [g.categoryCode, g.categoryName, g.all.incTaxYen, g.all.exTaxYen, g.all.exTaxUnknownCount]),
    [['D', 'スタッフ費', 11000, 10000, 0], ['F', '機材費', 22000, 20000, 0], ['H', 'ロケーション費', 8640, 5000, 1]]);
  assert.deepEqual(body.totals.byPayee.map((g) => [g.payeePartnerId, g.payeeName, g.all.count, g.all.incTaxYen]),
    [[2, null, 1, 22000], [1, null, 1, 11000], [null, '架空弁当店', 2, 8640]]);
  for (const groups of [body.totals.byDay, body.totals.byPayee, body.totals.byCategory]) {
    assert.deepEqual(groups.map((g) => g.all).reduce(plus, {...zero}), expected, '組ごとの合計の和＝明細の和');
  }
  // 変更の記録は件数だけで、金額・支払先を残さない
  const audit = await db.all("SELECT action,entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='production_actual_line'");
  assert.deepEqual(audit.map((r) => [r.action, r.entity_id, JSON.parse(r.detail_json)]), [['append', String(work), {workId: work, count: 4, ai: 2}]]);
  assert.equal(/41640|22000|架空/.test(audit[0].detail_json), false);
  // 絞り込み: 撮影日と日付。今日の合計と累計は絞り込みに依らない
  const byDay = await call(admin, `${path(work)}?shootingDayId=${day}`);
  assert.deepEqual([byDay.body.lines.length, byDay.body.totals.all.incTaxYen, byDay.body.cumulative.all.incTaxYen], [1, 22000, 41640]);
  const range = await call(admin, `${path(work)}?from=2026-01-11&to=2026-01-11`);
  assert.deepEqual([range.body.lines.map((l) => l.incTaxYen), range.body.todayTotal.all.incTaxYen], [[3240], 22000]);
  assert.equal((await call(admin, `${path(work)}?from=2026-01-12&to=2026-01-11`)).status, 400);
});

test('FR-EXP-PCOST-010 FR-EXP-PCOST-044 FR-EXP-PCOST-043 取り消した行は合計から消えて置き換えの行が入り、まとめて確認は取消済み・確認済みを飛ばして数を返し、合計が確認済みへ移る', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-VOID');
  const other = await addWork(db, 'FICT-AL-VOID2');
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const added = await call(admin, path(work), {method: 'POST', payload: {lines: [
    human(), ai(), ai({spentOn: '2026-01-11', incTaxYen: 3240, exTaxYen: null, taxYen: null}, {readFields: ['spentOn', 'categoryCode', 'payeeName', 'incTaxYen'], unreadFields: ['exTaxYen', 'taxYen']}),
    human({categoryCode: 'F', incTaxYen: 22000, exTaxYen: 20000, taxYen: 2000}),
  ]}});
  const [l1, l2, l3, l4] = added.body.lineIds;
  const otherLine = (await call(admin, path(other), {method: 'POST', payload: {lines: [human()]}})).body.lineIds[0];
  // 2行を確かめる
  const first = await call(admin, path(work, 'checks'), {method: 'POST', payload: {lineIds: [l1, l2]}});
  assert.deepEqual(first.body, {ok: true, workId: work, checked: 2, skipped: {voided: 0, alreadyChecked: 0}});
  let view = (await call(admin, path(work))).body;
  assert.deepEqual([view.totals.confirmed.count, view.totals.confirmed.incTaxYen, view.totals.unconfirmed.count, view.totals.unconfirmed.incTaxYen], [2, 16400, 2, 25240]);
  assert.deepEqual(view.lines.filter((l) => !l.unconfirmed).map((l) => [l.id, l.check.checkedBy]), [[l1, ADMIN], [l2, ADMIN]]);
  // 取消の理由は必須。理由の無い取消は何も書かない
  const noReason = await call(admin, path(work, `${l3}/void`), {method: 'POST', payload: {}});
  assert.equal(noReason.status, 400);
  assert.deepEqual(noReason.body.details.map((e) => e.field), ['reason']);
  // 税抜の分かった額で置き換える（表の上で直す）。元の行は消えず、取消の行と置き換えの行が残る
  const fixed = await call(admin, path(work, `${l3}/void`), {method: 'POST', payload: {reason: '架空の領収書を読み直した',
    replacement: human({spentOn: '2026-01-11', categoryCode: 'H', payeeName: '架空弁当店', incTaxYen: 3300, exTaxYen: 3000, taxYen: 300})}});
  assert.equal(fixed.status, 201, JSON.stringify(fixed.body));
  const l5 = fixed.body.replacementLineId;
  assert.equal(typeof l5, 'number');
  assert.equal(await lineCount(db, work), 5);
  view = (await call(admin, path(work))).body;
  assert.deepEqual(view.lines.map((l) => l.id), [l1, l2, l4, l5]);
  assert.equal(view.lines.find((l) => l.id === l5).replaces, l3);
  assert.deepEqual(view.totals.all, {count: 4, incTaxYen: 11000 + 5400 + 3300 + 22000, exTaxYen: 10000 + 5000 + 3000 + 20000, taxYen: 1000 + 400 + 300 + 2000,
    exTaxUnknownCount: 0, exTaxUnknownIncTaxYen: 0});
  // 同じ行の2回目の取消と、別の作品の行の取消は断る（何も書かない）
  assert.equal((await call(admin, path(work, `${l3}/void`), {method: 'POST', payload: {reason: '二重'}})).status, 409);
  assert.equal((await call(admin, path(work, `${otherLine}/void`), {method: 'POST', payload: {reason: '別の作品'}})).status, 404);
  // まとめて確認: 確認済み1・取消済み1を飛ばし、残りの2行を確かめる
  const batch = await call(admin, path(work, 'checks'), {method: 'POST', payload: {lineIds: [l1, l3, l4, l5, l4]}});
  assert.deepEqual(batch.body, {ok: true, workId: work, checked: 2, skipped: {voided: 1, alreadyChecked: 1}});
  view = (await call(admin, path(work))).body;
  assert.deepEqual([view.unconfirmedCount, view.totals.unconfirmed, view.totals.confirmed.incTaxYen], [0, zero, 41700]);
  // 作品に無い番号（別の作品の行）を含む一覧は、どれも確かめずに断る
  const lastId = Math.max(l1, l2, l3, l4, l5, otherLine);
  const missing = await call(admin, path(work, 'checks'), {method: 'POST', payload: {lineIds: [otherLine, lastId + 1000]}});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.details, {lineIds: [otherLine, lastId + 1000]});
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM production_actual_line_checks WHERE work_id=?', [other])).n), 0);
});

test('FR-EXP-PCOST-045 AI の行は読みの記録が無い・読めなかった欄に値がある・本文の項目を持つと断り、どれか1行でも誤りがあれば1行も書かない。同じ取り込みの鍵（要確認14の仮置き）は2回入らない', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-AI');
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const post = (lines) => call(admin, path(work), {method: 'POST', payload: {lines}});
  const noRecord = await post([human(), {...ai(), aiRead: undefined}]);
  assert.equal(noRecord.status, 400);
  assert.deepEqual(noRecord.body.details.map((e) => [e.line, e.field]), [[1, 'aiRead']]);
  const guessed = await post([ai({}, {readFields: ['spentOn', 'categoryCode', 'payeeName', 'incTaxYen'], unreadFields: ['exTaxYen', 'taxYen']})]);
  assert.equal(guessed.status, 400);
  assert.deepEqual(guessed.body.details.map((e) => e.field), ['aiRead.unreadFields']);
  const withText = await post([ai({}, {text: '領収書の本文（架空）'})]);
  assert.equal(withText.status, 400);
  assert.match(withText.body.details[0].message, /持たない項目です: text/);
  const humanWithRecord = await post([{...human(), aiRead: {model: 'fict-reader-1', readFields: [], unreadFields: []}}]);
  assert.equal(humanWithRecord.status, 400);
  assert.equal(await lineCount(db, work), 0);
  // 取り込みの鍵: 同じ鍵の2回目は 409 で、行は増えない。1回の中で重なる鍵は 400
  const once = await post([ai({entryKey: 'fict-receipt-001:1'}), ai({entryKey: 'fict-receipt-001:2', incTaxYen: 1100, exTaxYen: 1000, taxYen: 100})]);
  assert.equal(once.status, 201);
  assert.deepEqual(once.body.entryKeys, ['fict-receipt-001:1', 'fict-receipt-001:2']);
  const twice = await post([ai({entryKey: 'fict-receipt-001:2', incTaxYen: 1100, exTaxYen: 1000, taxYen: 100})]);
  assert.equal(twice.status, 409);
  assert.deepEqual(twice.body.details, {entryKeys: ['fict-receipt-001:2']});
  const inside = await post([human({entryKey: 'fict-x'}), human({entryKey: 'fict-x'})]);
  assert.equal(inside.status, 400);
  assert.deepEqual(inside.body.details.map((e) => [e.line, e.field]), [[1, 'entryKey']]);
  assert.equal(await lineCount(db, work), 2);
  // 1回に送れる行は1〜50行
  assert.equal((await post([])).status, 400);
  assert.equal((await post(Array.from({length: 51}, () => human()))).status, 400);
  assert.equal(await lineCount(db, work), 2);
});

test('FR-EXP-PCOST-036 FR-EXP-PCOST-033 証憑は組織の原本を、撮影日は同じ作品の撮影日を、支払先は組織の取引先を指し、ほかを指す行は1行も書かない', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-REF');
  const other = await addWork(db, 'FICT-AL-REF2');
  const day = await addDay(db, work, '2026-01-12');
  const otherDay = await addDay(db, other, '2026-01-12');
  const doc = await addDocument(db, 'c'.repeat(64));
  const foreignDoc = await addDocument(db, 'd'.repeat(64), {orgId: 2, receivedBy: 4});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const post = (lines) => call(admin, path(work), {method: 'POST', payload: {lines}});
  const bad = await post([human({sourceDocumentId: foreignDoc}), human({shootingDayId: otherDay}), human({payeePartnerId: 4})]);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.details.map((e) => [e.line, e.field]), [[0, 'sourceDocumentId'], [1, 'shootingDayId'], [2, 'payeePartnerId']]);
  assert.equal(await lineCount(db, work), 0);
  // 外注先の制作会社の支出明細（架空）を証憑にした行
  const ok = await post([human({sourceDocumentId: doc, shootingDayId: day, payeePartnerId: 3, payeeName: '架空制作会社', description: '架空の支出明細の1行'})]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const line = (await call(admin, path(work))).body.lines[0];
  assert.deepEqual([line.sourceDocumentId, line.shootingDayId, line.payeePartnerId, line.payeeName, line.description],
    [doc, day, 3, '架空制作会社', '架空の支出明細の1行']);
});

test('FR-EXP-PCOST-009 書けるのはいまは管理者だけで、財務の権限のある編集担当は読めるが書けず、制作担当と別の組織は作品の有無も見えない', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-ROLE');
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const editor = await login('editor@openingnight.invalid');
  const production = await login('production@openingnight.invalid');
  const outsider = await login('outsider@other.invalid');
  const added = await call(admin, path(work), {method: 'POST', payload: {lines: [human()]}});
  const lineId = added.body.lineIds[0];
  // 編集担当（案件1に編集の権限）は読めるが、足す・取り消す・確かめるは 403
  const read = await call(editor, path(work));
  assert.deepEqual([read.status, read.body.lines.length, read.body.canWrite], [200, 1, false]);
  for (const [entry, payload] of [['', {lines: [human()]}], [`${lineId}/void`, {reason: '架空'}], ['checks', {lineIds: [lineId]}]]) {
    const refused = await call(editor, path(work, entry), {method: 'POST', payload});
    assert.equal(refused.status, 403, entry);
    assert.match(refused.body.error, /管理者だけ/);
  }
  // 制作担当には読ませず、書かせない（いまの経費と同じ）
  for (const [method, entry, payload] of [['GET', '', undefined], ['POST', '', {lines: [human()]}], ['POST', 'checks', {lineIds: [lineId]}]]) {
    const refused = await call(production, path(work, entry), {method, payload});
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'この作品の実費への権限がありません');
  }
  // 別の組織の管理者には、ある作品も無い作品も同じ 403（有無を見せない）。行も返さない
  const foreign = await call(outsider, path(work));
  const missing = await call(outsider, path(999999));
  assert.deepEqual([foreign.status, foreign.body.error, foreign.body.lines], [403, 'この作品の実費への権限がありません', undefined]);
  assert.deepEqual([missing.status, missing.body.error], [403, foreign.body.error]);
  assert.equal((await call(outsider, path(work), {method: 'POST', payload: {lines: [human()]}})).status, 403);
  assert.equal(await lineCount(db, work), 1);
  assert.equal((await call(admin, path(work, 'checks'), {method: 'POST', payload: {lineIds: [lineId]}})).body.checked, 1);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM production_actual_line_checks')).n), 1);
});

// 呼び出しの経路の印（identity.via。FR-CORE-DATA-066）を付けた identity で受け口を呼ぶ。本番の Worker が付ける印を、
// 認証の差し替え（createApp の authenticate）で同じ形に作る。印の付け方そのものは test/cloud-db.test.mjs が Worker の JWT で確かめる
async function appAs(db, via) {
  const {identityForUser} = await import('../src/session-org.mjs');
  const identity = await identityForUser(db, {user_id: ADMIN, email: 'admin@openingnight.invalid', display_name: '管理者'}, null);
  const app = createApp({db, mode: 'production', authenticate: async () => (via === undefined ? identity : {...identity, via})});
  return async (p, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${p}`, {method, headers: payload ? {'content-type': 'application/json'} : {}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
}

test('FR-EXP-PCOST-047 FR-CORE-DATA-066 サービストークン（AI）の呼び出しは、入れ方が ai の行だけを足せて人の行は理由つきで断り、まとめて確認は 403、取消と置き換え（ai の行）は通る', async (t) => {
  const db = await openTestDb({t});
  const work = await addWork(db, 'FICT-AL-SVC');
  const call = await appAs(db, 'service_token');
  // 人の行が1つでもあれば、黙って書き換えずに 400（何も書かない）
  const human1 = await call(path(work), {method: 'POST', payload: {lines: [ai(), human()]}});
  assert.equal(human1.status, 400);
  assert.deepEqual(human1.body.details.map((e) => [e.line, e.field]), [[1, 'entryMethod']]);
  assert.match(human1.body.details[0].message, /ai の行だけ/);
  assert.equal(await lineCount(db, work), 0);
  const added = await call(path(work), {method: 'POST', payload: {lines: [ai(), ai({incTaxYen: 1100, exTaxYen: 1000, taxYen: 100})]}});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const [first, second] = added.body.lineIds;
  const read = await call(path(work));
  assert.deepEqual([read.status, read.body.canWrite, read.body.canCheck, read.body.lines.map((l) => l.entryMethod)], [200, true, false, ['ai', 'ai']]);
  // まとめて確認は人が画面から。確認の行は1つも書かない
  const checks = await call(path(work, 'checks'), {method: 'POST', payload: {lineIds: [first]}});
  assert.deepEqual([checks.status, checks.body.error], [403, '確認は、人が画面から行います']);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM production_actual_line_checks WHERE work_id=?', [work])).n), 0);
  // 取消は通る。置き換えの行も ai だけ
  const humanReplacement = await call(path(work, `${first}/void`), {method: 'POST', payload: {reason: '架空の読み直し', replacement: human()}});
  assert.equal(humanReplacement.status, 400);
  assert.deepEqual(humanReplacement.body.details.map((e) => e.field), ['replacement.entryMethod']);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM production_actual_line_voids WHERE work_id=?', [work])).n), 0);
  const aiReplacement = await call(path(work, `${first}/void`), {method: 'POST', payload: {reason: '架空の読み直し', replacement: ai({incTaxYen: 5500, exTaxYen: 5000, taxYen: 500})}});
  assert.equal(aiReplacement.status, 201, JSON.stringify(aiReplacement.body));
  assert.equal((await call(path(work, `${second}/void`), {method: 'POST', payload: {reason: '架空の二重'}})).status, 201);
  assert.deepEqual((await call(path(work))).body.lines.map((l) => [l.entryMethod, l.replaces]), [['ai', first]]);
});

test('FR-EXP-PCOST-047 FR-EXP-PCOST-044 印の無い呼び出しと人のログイン（access）は今までどおり、人の行も足せて確かめられる', async (t) => {
  const db = await openTestDb({t});
  for (const via of [undefined, 'access']) {
    const work = await addWork(db, `FICT-AL-ACC-${via ?? 'none'}`);
    const call = await appAs(db, via);
    const added = await call(path(work), {method: 'POST', payload: {lines: [human(), ai()]}});
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((await call(path(work))).body.canCheck, true);
    const checked = await call(path(work, 'checks'), {method: 'POST', payload: {lineIds: added.body.lineIds}});
    assert.deepEqual([checked.status, checked.body.checked], [200, 2]);
  }
});
