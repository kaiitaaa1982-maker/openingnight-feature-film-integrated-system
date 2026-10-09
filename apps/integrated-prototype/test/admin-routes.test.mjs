// 管理画面の論理（admin-model）が、いまのAPIとかみ合うかを確かめる。新しいAPIは足していない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {createApi} from '../src/ui/api-client.mjs';
import {
  validateInvitation, invitationRows, memberRows, proposalView, proposalCounts, analyticsView, defaultExpiryInput,
} from '../src/admin/admin-model.mjs';
import {definitionView, plainTerms, relationRows, sourceTables} from '../src/admin/definitions-model.mjs';
import {analysisDefinitions, semanticDocument} from '../src/semantic-definitions.mjs';
import {objects, relations} from '../src/design-model.mjs';

async function setup(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  async function as(email) {
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return createApi({base: '/api', fetchImpl: (url, init = {}) => app.request(url, {...init, headers: {...(init.headers || {}), cookie}})});
  }
  return {db, app, as};
}

test('チーム: 名称で選んだ案件・日本時間の期限で招待し、確定・取り消しの結果が日本語の状態で出る', async (t) => {
  const {db, as} = await setup(t);
  try {
    const admin = await as('admin@openingnight.invalid');
    const {projects} = await admin('/bootstrap');
    const project = projects[0];
    const checked = validateInvitation({email: 'reviewer@pilot.invalid', projectId: project.id, role: 'editor', expiresAt: defaultExpiryInput(new Date(), 7)}, {projects});
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    const created = await admin('/team/invitations', {method: 'POST', body: JSON.stringify(checked.payload)});
    assert.equal(created.externalSend, false);

    let team = await admin('/team');
    let rows = invitationRows(team.invitations, projects);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project_title, project.title);
    assert.equal(rows[0].state.label, '参加の確定待ち');
    assert.equal(rows[0].expires_at, checked.payload.expiresAt, '日本時間で入れた期限がそのまま保存される');

    await admin(`/team/invitations/${rows[0].id}/accept`, {method: 'POST', body: '{}'});
    team = await admin('/team');
    rows = invitationRows(team.invitations, projects);
    assert.equal(rows[0].state.label, '参加済み');
    const member = memberRows(team.members, projects).find((row) => row.email === 'reviewer@pilot.invalid');
    assert.equal(member.project_title, project.title);
    assert.equal(member.active_label, '有効');

    await admin(`/team/invitations/${rows[0].id}/revoke`, {method: 'POST', body: '{}'});
    team = await admin('/team');
    assert.equal(invitationRows(team.invitations, projects)[0].state.label, '取消済み');

    const editor = await as('editor@openingnight.invalid');
    await assert.rejects(() => editor('/team'), (error) => error.kind === 'forbidden', '編集担当はチームを扱えない（画面は理由を出す）');
  } finally {
    await db.close();
  }
});

test('追加項目: 規則で作った候補を業務の言葉で出し、採否は管理者だけ・確認した版でだけ通る', async (t) => {
  const {db, as} = await setup(t);
  try {
    const editor = await as('editor@openingnight.invalid');
    await editor('/proposals/suggest', {method: 'POST', body: JSON.stringify({request: '予告編の完全視聴数を回数で記録したい'})});
    const {rows} = await editor('/proposals');
    assert.equal(rows.length, 1);
    const view = proposalView(rows[0]);
    assert.equal(view.summary, '整数・回・合計');
    assert.equal(view.source, '規則');
    assert.equal(view.statusLabel, '確認待ち');
    assert.equal(view.affected, '宣伝の入力、CSV取込、分析');
    assert.deepEqual(proposalCounts(rows), {all: 1, pending: 1, adopted: 0, rejected: 0});
    await assert.rejects(() => editor(`/proposals/${rows[0].id}/adopt`, {method: 'POST', body: JSON.stringify({hash: rows[0].proposal_hash, baseSchemaVersion: rows[0].base_schema_version})}), (error) => error.kind === 'forbidden');

    const admin = await as('admin@openingnight.invalid');
    await assert.rejects(() => admin(`/proposals/${rows[0].id}/adopt`, {method: 'POST', body: JSON.stringify({hash: 'x', baseSchemaVersion: rows[0].base_schema_version})}), (error) => error.kind === 'conflict');
    await admin(`/proposals/${rows[0].id}/adopt`, {method: 'POST', body: JSON.stringify({hash: rows[0].proposal_hash, baseSchemaVersion: rows[0].base_schema_version})});
    const after = await admin('/proposals');
    assert.equal(proposalView(after.rows[0]).statusLabel, '採用');
    assert.equal(proposalView(after.rows[0]).pending, false);

    const imported = {fieldKey: 'poster_views', label: 'ポスター閲覧数', valueType: 'integer', unit: '回', aggregation: 'sum', meaningReason: '比較のため', affectedApps: ['publicity-form']};
    await admin('/proposals/import', {method: 'POST', body: JSON.stringify(imported)});
    const both = await admin('/proposals');
    assert.equal(proposalView(both.rows.find((row) => row.field_key === 'poster_views')).source, 'AI（JSON取込）');
  } finally {
    await db.close();
  }
});

test('分析: 分析の経路が無い環境では、管理者にも「未接続」と帳票センターへの導線を出す', async (t) => {
  const {db, as} = await setup(t);
  try {
    const admin = await as('admin@openingnight.invalid');
    let error = null;
    try { await admin('/workbench/analytics/status'); } catch (reason) { error = reason; }
    assert.ok(error, '経路が無いときはエラーになる');
    const view = analyticsView({error, role: 'admin'});
    assert.equal(view.state, 'unconfigured');
    assert.equal(view.canSync, false);
    assert.equal(view.showRestart, false);
    assert.equal(view.links[0].page, '帳票センター');
  } finally {
    await db.close();
  }
});

test('設計・定義: 数字の定義は業務の言葉で出し、表名・実装の状況・技術の言葉は技術情報へ', () => {
  const views = analysisDefinitions.map(definitionView);
  assert.equal(views.length, analysisDefinitions.length);
  for (const view of views) {
    assert.doesNotMatch([view.name, view.rule, view.sourceText].join(' '), /\b(dbt|DuckDB|sales_fact|sale_lines|product_works)\b/, view.id);
    assert.ok(view.technical.some(([label]) => label === '元の表（DB名）'), view.id);
  }
  const verified = views.find((view) => view.id === 'workbench_verified_sales');
  assert.match(verified.technical.find(([label]) => label === '元の定義文')[1], /dbt/);
  assert.equal(verified.sourceText, '売上明細、商品の作品配賦');
  assert.deepEqual(sourceTables(' sale_lines / product_works ').map((table) => table.name), ['sale_lines', 'product_works']);
  assert.equal(plainTerms('分析用MCP・外部利用者向け認証は未接続'), 'AI向けの分析の接続口（MCP）・外部利用者向け認証は未接続');
  assert.equal(plainTerms('DWHへの同期は未接続'), '分析用の保管庫への同期は未接続');
  for (const text of semanticDocument.limitations) assert.doesNotMatch(plainTerms(text), /(?<!（)MCP(?!）)/);
  const rows = relationRows(relations, objects);
  assert.equal(rows.length, relations.length);
  assert.ok(rows.every((row) => row.from && row.to && !/_/.test(row.from + row.to)), '関係は和名で出す');
  const production = objects.filter((object) => object.production);
  assert.ok(relationRows(relations, production).every((row) => production.some((object) => object.label === row.from) && production.some((object) => object.label === row.to)));
});
