// 企画（移行 0025）を、受け口（src/planning/kikaku/kikaku-routes.mjs）と DB の制約で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は会社ルートの plans/2026-10-22-folder-kikaku.md と、売上試算の3段の型（架空のデータ。test/fixtures/kikaku/trial-3dan.json）から書いた
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

const golden = JSON.parse(readFileSync(new URL('./fixtures/kikaku/trial-3dan.json', import.meta.url), 'utf8'));

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
const trialBody = (expectedRevision) => ({costTotalYen: golden.costTotalYen, firstMonth: golden.firstMonth, reason: '架空の3段の型', expectedRevision,
  rates: golden.rates, investments: golden.investments, lines: golden.lines.map(({expected, ...l}) => l)});

test('FR-PLAN-KIKAKU-001 企画を作ると、案件・担当の最初の版・項目の最初の版が入り、一覧に残り4で出る', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const made = await call(admin, '/planning/kikaku/projects', {method: 'POST', payload: {code: 'KK-T1', title: '港町の配達人（仮）', earningType: 'own_investment', profile: {origin: 'concept'}}});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const list = await call(admin, '/planning/kikaku');
  const row = list.body.items.find((r) => r.id === made.body.id);
  assert.equal(row.readiness.verdict, '! 残り4: 企画書の提出版・試算・予算書・判断');
  assert.equal(row.owner.userId, list.body.me);
  assert.equal(row.stage.code, 'memo');
  const again = await call(admin, '/planning/kikaku/projects', {method: 'POST', payload: {code: 'KK-T1', title: 'x'}});
  assert.equal(again.status, 409);
});

test('FR-PLAN-KIKAKU-010 試算の版を足すと、受け口の計算が Excel で再計算した3段の型と一致し、版が増える。古い版の番号では 409', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const {body: {id}} = await call(admin, '/planning/kikaku/projects', {method: 'POST', payload: {code: 'KK-T2', title: '架空'}});
  const tpl = await call(admin, `/planning/kikaku/${id}/trials`, {method: 'POST', payload: {template: true, costTotalYen: 1000, firstMonth: '2027-01', expectedRevision: 0}});
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
  const added = await call(admin, `/planning/kikaku/${id}/trials`, {method: 'POST', payload: trialBody(1)});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const stale = await call(admin, `/planning/kikaku/${id}/trials`, {method: 'POST', payload: trialBody(1)});
  assert.equal(stale.status, 409);
  const detail = await call(admin, `/planning/kikaku/${id}`);
  assert.equal(detail.body.trial.revision, 2);
  for (const s of ['even', 'good', 'max']) {
    assert.equal(detail.body.trial.result.totals[s].income, golden.expected[s].income);
    assert.equal(detail.body.trial.result.totals[s].breakEvenMonth, golden.expected[s].breakEvenMonth);
  }
  assert.equal(detail.body.trialVersions.length, 2);
  assert.equal(detail.body.readiness.marks.find((m) => m.key === 'trial').done, true);
});

test('FR-PLAN-KIKAKU-040 企画書の原本を置くと共通の置き場に1回だけ入り、同じ原本を同じ役で置き直すと 409。提出版で企のマスが埋まる', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const {body: {id}} = await call(admin, '/planning/kikaku/projects', {method: 'POST', payload: {code: 'KK-T3', title: '架空'}});
  const base64 = Buffer.from('架空の企画書').toString('base64');
  const first = await call(admin, `/planning/kikaku/${id}/documents`, {method: 'POST', payload: {kind: 'deck', fileName: 'deck.pdf', mediaType: 'application/pdf', base64}});
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const dup = await call(admin, `/planning/kikaku/${id}/documents`, {method: 'POST', payload: {kind: 'deck', fileName: 'deck.pdf', base64}});
  assert.equal(dup.status, 409);
  const submitted = await call(admin, `/planning/kikaku/${id}/documents`, {method: 'POST', payload: {kind: 'deck', role: 'submitted', submittedOn: '2027-01-10', submittedTo: '架空社', fileName: 'deck.pdf', base64}});
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.reused, true);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM source_documents WHERE org_id=1 AND file_name='deck.pdf'")).n), 1);
  const detail = await call(admin, `/planning/kikaku/${id}`);
  assert.equal(detail.body.readiness.marks.find((m) => m.key === 'deck').done, true);
  const back = await call(admin, `/planning/kikaku/${id}/documents/${first.body.documentId}`);
  assert.equal(back.body.base64, base64);
});

test('FR-PLAN-KIKAKU-030 素材と事実: 下書きを確定すると確定の行が足され、準備ボードのページが確定になる。下書きの行は消えない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const {body: {id}} = await call(admin, '/planning/kikaku/projects', {method: 'POST', payload: {code: 'KK-T4', title: '架空'}});
  const mat = await call(admin, `/planning/kikaku/${id}/materials`, {method: 'POST', payload: {kind: 'similar', title: '類似作の調査（架空）', label: 'confirmed', source: '架空の出典'}});
  assert.equal(mat.status, 201, JSON.stringify(mat.body));
  const fact = await call(admin, `/planning/kikaku/${id}/facts`, {method: 'POST', payload: {body: '類似作3本が同時に上位に入った（架空）', label: 'confirmed', target: 'case', pages: [3, 12], materialId: mat.body.id}});
  assert.equal(fact.status, 201, JSON.stringify(fact.body));
  let detail = await call(admin, `/planning/kikaku/${id}`);
  assert.equal(detail.body.board.pages.find((p) => p.no === 3).state, 'draft');
  const ok = await call(admin, `/planning/kikaku/${id}/facts/${fact.body.id}/confirm`, {method: 'POST', payload: {}});
  assert.equal(ok.status, 201);
  const twice = await call(admin, `/planning/kikaku/${id}/facts/${fact.body.id}/confirm`, {method: 'POST', payload: {}});
  assert.equal(twice.status, 409);
  detail = await call(admin, `/planning/kikaku/${id}`);
  assert.equal(detail.body.board.pages.find((p) => p.no === 12).state, 'confirmed');
  assert.equal(detail.body.facts.length, 2);
  await assert.rejects(db.run('DELETE FROM planning_facts WHERE org_id=1 AND id=?', [fact.body.id]));
});

test('FR-PLAN-KIKAKU-050 制作担当は企画を見られず 403。担当を替えると版が増える', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const production = await login('production@openingnight.invalid');
  const {body: {id}} = await call(admin, '/planning/kikaku/projects', {method: 'POST', payload: {code: 'KK-T5', title: '架空'}});
  assert.equal((await call(production, '/planning/kikaku')).status, 403);
  assert.equal((await call(production, `/planning/kikaku/${id}`)).status, 403);
  const detail = await call(admin, `/planning/kikaku/${id}`);
  const other = detail.body.members.find((m) => m.userId !== detail.body.owner.userId);
  const changed = await call(admin, `/planning/kikaku/${id}/owner`, {method: 'POST', payload: {userId: other.userId, reason: '担当替え（架空）', expectedRevision: 1}});
  assert.equal(changed.status, 201, JSON.stringify(changed.body));
  assert.equal((await call(admin, `/planning/kikaku/${id}`)).body.owner.userId, other.userId);
});
