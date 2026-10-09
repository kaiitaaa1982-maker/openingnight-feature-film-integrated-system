import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jstInputToIso, isoToJstInput, jstToday, defaultExpiryInput, validateInvitation, invitationState, invitationRows, memberRows, revokeSummary,
  proposalView, proposalCounts, filterProposals, decisionSummary, validateRequestText, parseProposalJson, affectedApps,
  analyticsView, lightdashView, historyRows, INVITE_ROLE_OPTIONS,
} from '../src/admin/admin-model.mjs';

const projects = [{id: 1, code: 'PRJ-DEMO', title: '風のあとさき'}, {id: 2, code: 'PRJ-B', title: '架空の案件'}];
const NOW = new Date('2026-09-24T03:00:00Z'); // 日本時間 2026/09/24 12:00

test('期限は日本時間で入力し、UTC の ISO で送る（ブラウザの時差に左右されない）', () => {
  assert.equal(jstInputToIso('2026-10-01T18:00'), '2026-10-01T09:00:00.000Z');
  assert.equal(jstInputToIso('2026-10-01T00:30'), '2026-09-30T15:30:00.000Z');
  assert.equal(jstInputToIso('2026-02-30T10:00'), null, '存在しない日付は受け付けない');
  assert.equal(jstInputToIso('2026-10-01 18:00'), null);
  assert.equal(jstInputToIso(''), null);
  assert.equal(isoToJstInput('2026-10-01T09:00:00.000Z'), '2026-10-01T18:00');
  assert.equal(isoToJstInput('2026-09-30 15:30:00'), '2026-10-01T00:30', 'SQLite の時差なし日時は UTC とみなす');
  assert.equal(isoToJstInput('読めない'), '');
  assert.equal(defaultExpiryInput(NOW), '2026-10-01T23:59');
  assert.equal(defaultExpiryInput(new Date('2026-09-24T16:00:00Z')), '2026-10-02T23:59', 'UTC では前日でも日本時間の翌日から数える');
  assert.equal(jstToday(new Date('2026-09-24T16:00:00Z')), '2026-09-25');
  assert.equal(jstToday(NOW), '2026-09-24');
});

test('招待の入力は案件を一覧から選び、架空メール・役割・未来の期限だけを通す', () => {
  const ok = validateInvitation({email: ' Reviewer@Pilot.invalid ', projectId: '2', role: 'production', expiresAt: '2026-10-01T23:59'}, {now: NOW, projects});
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, {email: 'reviewer@pilot.invalid', projectId: 2, role: 'production', expiresAt: '2026-10-01T14:59:00.000Z'});

  const bad = validateInvitation({email: 'someone@example.com', projectId: null, role: 'admin', expiresAt: '2026-09-24T11:59'}, {now: NOW, projects});
  assert.equal(bad.ok, false);
  assert.equal(bad.payload, null);
  assert.match(bad.errors.email, /\.invalid/);
  assert.match(bad.errors.projectId, /一覧から選んで/);
  assert.match(bad.errors.role, /役割/);
  assert.match(bad.errors.expiresAt, /今より後/);

  const unknownProject = validateInvitation({email: 'a@b.invalid', projectId: 99, role: 'editor', expiresAt: '2026-10-01T23:59'}, {now: NOW, projects});
  assert.match(unknownProject.errors.projectId, /選べる案件/);
  const emptyExpiry = validateInvitation({email: 'a@b.invalid', projectId: 1, role: 'editor', expiresAt: ''}, {now: NOW, projects});
  assert.match(emptyExpiry.errors.expiresAt, /期限を入れて/);
  assert.deepEqual(INVITE_ROLE_OPTIONS.map((option) => option.value), ['editor', 'production'], '管理者は招待で作らない');
  for (const option of INVITE_ROLE_OPTIONS) assert.doesNotMatch(option.label, /[a-z]{3,}/, '役割は日本語で出す');
});

test('招待の状態は日本語で、期限を過ぎた確定待ちは「期限切れ」として確定させない', () => {
  const future = '2026-10-01T00:00:00.000Z';
  const past = '2026-09-01T00:00:00.000Z';
  const pending = invitationState({status: 'pending', expires_at: future}, NOW);
  assert.equal(pending.label, '参加の確定待ち');
  assert.equal(pending.canAccept, true);
  assert.equal(pending.canRevoke, true);
  const lapsed = invitationState({status: 'pending', expires_at: past}, NOW);
  assert.equal(lapsed.label, '期限切れ');
  assert.equal(lapsed.tone, 'warn');
  assert.equal(lapsed.canAccept, false);
  assert.equal(lapsed.canRevoke, true, '期限切れの招待も取り消して片付けられる');
  const accepted = invitationState({status: 'accepted', expires_at: future}, NOW);
  assert.equal(accepted.label, '参加済み');
  assert.equal(accepted.revokeLabel, 'この案件の権限を外す');
  assert.equal(invitationState({status: 'accepted', expires_at: past}, NOW).label, '参加済み（期限切れ）');
  const revoked = invitationState({status: 'revoked', expires_at: future}, NOW);
  assert.equal(revoked.label, '取消済み');
  assert.equal(revoked.canRevoke, false);
  assert.equal(invitationState({status: 'pending', expires_at: null}, NOW).canAccept, false, '期限が読めない招待は確定させない');

  const rows = invitationRows([{id: 3, email: 'x@y.invalid', project_id: 1, role: 'editor', status: 'pending', expires_at: future}, {id: 4, email: 'z@y.invalid', project_id: 7, role: 'editor', status: 'revoked', expires_at: future}], projects, NOW);
  assert.equal(rows[0].project_title, '風のあとさき', '案件は番号でなく名称で出す');
  assert.equal(rows[1].project_title, '案件（名称未確認）');
  assert.equal(rows[0].state_label, '参加の確定待ち');

  assert.match(revokeSummary({email: 'x@y.invalid', project_id: 1, status: 'pending'}, projects), /「風のあとさき」の招待を取り消します.*元に戻せません/);
  assert.match(revokeSummary({email: 'x@y.invalid', project_id: 1, status: 'accepted'}, projects), /権限を外します/);
});

test('メンバー一覧は案件名・有効/停止を日本語で出し、案件の権限が無い行も1行にする', () => {
  const rows = memberRows([
    {email: 'admin@openingnight.invalid', role: 'admin', active: 1, project_id: null},
    {email: 'editor@openingnight.invalid', role: 'editor', active: 0, project_id: 1, permission: 'edit'},
  ], projects);
  assert.equal(rows[0].project_title, '案件の権限なし');
  assert.equal(rows[0].active_label, '有効');
  assert.equal(rows[1].project_title, '風のあとさき');
  assert.equal(rows[1].active_label, '停止');
  assert.notEqual(rows[0].key, rows[1].key);
});

test('追加項目の提案は、主表示を業務の言葉にし、キー・照合値・版は技術情報へ回す', () => {
  const row = {
    id: 5, label: '予告編の完全視聴数', field_key: 'trailer_completion', value_type: 'integer', unit: '回', aggregation: 'sum',
    request_text: '予告編の完全視聴数を回数で記録したい', meaning_reason: '比較のため', affected_apps_json: '["publicity-form","analytics"]',
    base_schema_version: 3, proposal_hash: 'abc123', source: 'offline-rule', status: 'pending', created_at: '2026-09-24 00:18:32',
  };
  const view = proposalView(row);
  assert.equal(view.summary, '整数・回・合計');
  assert.equal(view.affected, '宣伝の入力、分析');
  assert.equal(view.source, '規則');
  assert.equal(view.statusLabel, '確認待ち');
  assert.equal(view.created, '2026/09/24 09:18', '日時は日本時間');
  assert.equal(view.pending, true);
  const main = [view.label, view.summary, view.affected, view.source, view.statusLabel, view.created].join(' ');
  assert.doesNotMatch(main, /trailer_completion|integer|offline-rule|abc123|pending/);
  const technical = Object.fromEntries(view.technical);
  assert.equal(technical['項目キー'], 'trailer_completion');
  assert.equal(technical['提案の照合値'], 'abc123');
  assert.equal(technical['元の項目定義の版'], 3);

  assert.equal(proposalView({...row, unit: null, aggregation: 'none', value_type: 'text'}).summary, '文字・単位なし・集計しない');
  assert.equal(affectedApps('壊れた').ok, false);
  assert.equal(proposalView({...row, affected_apps_json: '壊れた'}).affected, '未確認');
  assert.match(affectedApps('["unknown-app"]').labels[0], /未登録の影響先/);

  const rows = [{status: 'pending'}, {status: 'adopted'}, {status: 'pending'}, {status: 'rejected'}];
  assert.deepEqual(proposalCounts(rows), {all: 4, pending: 2, adopted: 1, rejected: 1});
  assert.equal(filterProposals(rows, 'pending').length, 2);
  assert.equal(filterProposals(rows, 'all').length, 4);
  assert.equal(filterProposals(null, 'pending').length, 0);

  assert.match(decisionSummary(row, 'adopt'), /「予告編の完全視聴数」（整数・回・合計）を項目として追加.*元に戻せません/);
  assert.match(decisionSummary(row, 'reject'), /不採用にします/);
});

test('提案の依頼文と貼り付けたJSONは、送る前に日本語の理由つきで確かめる', () => {
  assert.equal(validateRequestText('  視聴数を記録  '), '');
  assert.match(validateRequestText('   '), /入れてください/);
  assert.match(validateRequestText('あ'.repeat(2001)), /2,000文字以内.*2,001文字/);
  assert.deepEqual(parseProposalJson('{"label":"x"}'), {ok: true, value: {label: 'x'}});
  assert.match(parseProposalJson('').error, /貼り付けて/);
  assert.match(parseProposalJson('{label:').error, /JSONとして読めません/);
  assert.match(parseProposalJson('[1,2]').error, /1件ずつ/);
});

test('分析: 権限の無い役割・未接続・経路なしは理由と帳票センターへの導線を出し、再起動はクラウドの管理者だけ', () => {
  const forbidden = analyticsView({error: {kind: 'forbidden', status: 403}, role: 'editor'});
  assert.equal(forbidden.state, 'forbidden');
  assert.equal(forbidden.canSync, false);
  assert.equal(forbidden.showRestart, false);
  assert.deepEqual(forbidden.links.map((link) => link.page), ['帳票センター']);

  const missing = analyticsView({error: {kind: 'not_found', status: 404}, role: 'admin'});
  assert.equal(missing.state, 'unconfigured', '分析の経路が無い環境は「未接続」として案内する');
  assert.equal(missing.links[0].page, '帳票センター');
  assert.match(missing.message, /接続の手順/);

  const unconfigured = analyticsView({status: {enabled: false}, role: 'editor'});
  assert.equal(unconfigured.state, 'unconfigured');
  assert.match(unconfigured.message, /管理者が/);

  const failing = analyticsView({error: {kind: 'server', status: 500, message: 'x'}, role: 'admin'});
  assert.equal(failing.state, 'error');

  assert.equal(analyticsView({}).state, 'loading');

  const local = analyticsView({status: {enabled: true, busy: false, runtime: undefined, active: {stale: false}}, role: 'admin'});
  assert.equal(local.state, 'verified');
  assert.equal(local.canSync, true);
  assert.equal(local.showRestart, false, 'ローカルには処理環境の再起動が無い');

  const cloudAdmin = analyticsView({status: {enabled: true, busy: false, runtime: 'cloud', active: null}, role: 'admin'});
  assert.equal(cloudAdmin.state, 'initial');
  assert.equal(cloudAdmin.showRestart, true);
  assert.equal(cloudAdmin.canRestart, true);
  const cloudEditor = analyticsView({status: {enabled: true, busy: false, runtime: 'cloud', active: null}, role: 'editor'});
  assert.equal(cloudEditor.showRestart, false, '再起動は管理者だけ');
  assert.equal(cloudEditor.canSync, false);
  const busy = analyticsView({status: {enabled: true, busy: true, runtime: 'cloud'}, role: 'admin'});
  assert.equal(busy.state, 'busy');
  assert.equal(busy.canSync, false);
  assert.equal(busy.canRestart, false, '更新中は再起動しない');
  assert.equal(analyticsView({status: {enabled: true}, role: 'admin', pending: true}).state, 'busy');

  const stale = analyticsView({status: {enabled: true, active: {stale: true, definitionStale: true}, lastError: 'Traceback: boom'}, role: 'admin'});
  assert.equal(stale.state, 'stale');
  assert.match(stale.message, /集計の定義が変わりました/);
  assert.equal(stale.lastError.technical, 'Traceback: boom', '英語のエラー原文は技術情報へ');
  assert.doesNotMatch(stale.lastError.message, /Traceback/);
});

test('分析の画面（Lightdash）と保存履歴は日本時間で出し、分析版の番号は主表示にしない', () => {
  assert.equal(lightdashView(null).connected, false);
  const connected = lightdashView({url: 'https://lightdash.invalid', status: 'verified', verifiedAt: '2026-09-24T00:00:00Z', charts: {a: {name: '作品別売上', url: 'https://lightdash.invalid/a'}, b: {name: 'URLなし'}}});
  assert.equal(connected.label, '帳票との一致を確認済み');
  assert.equal(connected.verifiedAt, '2026/09/24 09:00');
  assert.deepEqual(connected.charts.map((chart) => chart.name), ['作品別売上']);
  assert.equal(lightdashView({url: 'x', status: 'stale'}).tone, 'warn');

  const rows = historyRows([{runId: 'a'.repeat(32), verifiedAt: '2026-09-24T00:00:00Z', asOf: '2026-09-23'}, {runId: 'b'.repeat(32), verifiedAt: '2026-09-20T00:00:00Z'}], 'a'.repeat(32));
  assert.equal(rows[0].verified, '2026/09/24 09:00');
  assert.equal(rows[0].asOf, '2026/09/23');
  assert.equal(rows[0].current, true);
  assert.equal(rows[1].asOf, '未確認');
  assert.equal(rows[1].current, false);
});
