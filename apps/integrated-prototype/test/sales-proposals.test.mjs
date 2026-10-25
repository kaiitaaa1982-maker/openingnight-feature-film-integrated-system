// 営業管理の最初の切れ（移行 0049 の5表と src/sales-ops/proposals/）の試験。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は試験の中に手で書いた値で持ち、試験対象の関数で作らない。架空のデータだけを使う（組織1・2と利用者・試作の作品は試作の行）
// ・解禁月のページ: その月に始まる窓口を持つ作品だけ。流通のまとまり（配信・放送・業務用VOD…）ごとのマスに、提案先の数と状態
// ・1回の提案: 結んだウィンドウ・解禁までの日数・RS に金額を入れない・作品の違うウィンドウは 409
// ・結果と自己評価・効いた要因: 最新の評価が今の評価。件数5未満は率を出さない
// ・接点の言葉: 直前の相手の言葉が振り返りに並ぶ。記録は変更も削除もできない。制作担当は 403
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {normalizeProposalInput, normalizeReviewInput, tallyFactors, proposalCsv, launchGroupOf} from '../src/sales-ops/proposals/proposal-model.mjs';

async function setup({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const sessions = {};
  const as = async (role) => {
    if (!sessions[role]) {
      const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: `${role}@openingnight.invalid`})});
      assert.equal(login.status, 200, role);
      sessions[role] = login.headers.get('set-cookie').split(';')[0];
    }
    const cookie = sessions[role];
    const call = async (method, path, payload) => {
      const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
      const type = response.headers.get('content-type') || '';
      return {status: response.status, body: type.includes('json') ? await response.json() : await response.text()};
    };
    return {get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload)};
  };
  const admin = await as('admin');
  assert.equal((await admin.post('/release-window-types/adopt', {reason: '初期の種別を採用（試験）'})).status, 201);
  const types = new Map((await admin.get('/release-window-types')).body.types.map((type) => [type.type_key, type]));
  const window = async (typeKey, start, status = 'confirmed') => {
    const created = await admin.post('/release-windows', {workId: 1, typeId: types.get(typeKey).id, baseVersion: 0, start, status, reason: '試験'});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return Number((await db.get('SELECT w.id FROM work_release_windows w WHERE w.org_id=1 AND w.work_id=1 AND w.type_id=?', [types.get(typeKey).id])).id);
  };
  const opportunity = async (partnerId, name) => Number((await db.get("INSERT INTO sales_opportunities(org_id,project_id,work_id,partner_id,name,stage) VALUES(1,1,1,?,?,'proposal') RETURNING id", [partnerId, name])).id);
  return {db, app, as, admin, window, opportunity};
}

const rejects = (promise, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), 'raise', error.message);
  assert.match(error.message, message);
  return true;
});

test('入力の確かめ: RS に金額は入れない・料率は%で受けて bps・要因は2回書けない・契約は採用のときだけ', () => {
  assert.throws(() => normalizeProposalInput({opportunityId: 1, proposedOn: '2026-09-01', settlementMethod: 'RS', amountExTax: 1000}), /RS/);
  assert.equal(normalizeProposalInput({opportunityId: 1, proposedOn: '2026-09-01', settlementMethod: 'RS', ratePercent: '50'}).rateBps, 5000);
  assert.equal(normalizeProposalInput({opportunityId: 1, proposedOn: '2026-09-01', amountExTax: '800,000'}).amountExTax, 800000);
  assert.throws(() => normalizeProposalInput({opportunityId: 1, proposedOn: '2026-09-01', termStart: '2027-01-01', termEnd: '2026-12-31'}), /終了/);
  assert.throws(() => normalizeProposalInput({opportunityId: 1, proposedOn: '2026/09/01'}), /YYYY-MM-DD/);
  assert.throws(() => normalizeReviewInput({reviewedOn: '2026-09-10', outcome: 'adopted', score: 4, factors: [{factor: 'price', effect: 'plus'}, {factor: 'price', effect: 'minus'}]}), /2回/);
  assert.throws(() => normalizeReviewInput({reviewedOn: '2026-09-10', outcome: 'rejected', score: 2, agreementId: 3}), /採用/);
  assert.throws(() => normalizeReviewInput({reviewedOn: '2026-09-10', outcome: 'adopted', score: 6}), /1〜5/);
  assert.deepEqual(normalizeReviewInput({reviewedOn: '2026-09-10', outcome: 'adopted', score: 4, factors: {material: 'plus', price: '', timing: 'minus'}}).factors,
    [{factor: 'material', effect: 'plus'}, {factor: 'timing', effect: 'minus'}]);
  assert.deepEqual(['digital', 'broadcast', 'theatrical', 'overseas', 'package'].map((family) => launchGroupOf({family})), ['pf', 'tv', 'cn', 'os', 'pk']);
  assert.equal(launchGroupOf({family: 'digital', type_key: 'business_vod'}), 'hv', '業務用VOD は配信と別のまとまり');
});

test('要因の集計: 件数5未満は率を出さず、5件で率が出る（返事なしは不採用に数え、取り下げは数えない）', () => {
  const row = (id, outcome, effect) => ({id, review: {outcome, factors: [{factor: 'price', effect}]}});
  const four = tallyFactors([row(1, 'adopted', 'plus'), row(2, 'rejected', 'minus'), row(3, 'no_answer', 'minus'), row(4, 'withdrawn', 'minus'), row(5, 'adopted_changed', 'minus')]);
  assert.deepEqual(four.map((x) => [x.factor, x.adoptedPlus, x.adoptedMinus, x.rejectedMinus, x.count, x.adoptedRateBps]), [['price', 1, 1, 2, 4, null]]);
  const five = tallyFactors([row(1, 'adopted', 'plus'), row(2, 'rejected', 'minus'), row(3, 'no_answer', 'minus'), row(5, 'adopted_changed', 'minus'), row(6, 'adopted', 'plus')]);
  assert.equal(five[0].adoptedRateBps, 6000, '5件のうち採用3件＝60%');
});

test('解禁月のページと提案の振り返り: 9月に始まる窓口の作品が並び、提案・評価・言葉がつながる。CSV に同じ行が落ちる', async (t) => {
  const {db, as, admin, window, opportunity} = await setup({t});
  const svod = await window('svod_regular', '2026-09-15');
  const broadcast = await window('broadcast', '2026-09-05');
  await window('business_vod', '2026-09-20');
  await window('tvod_regular', '2026-10-01');
  const made = await admin.post('/sales-opportunities', {workId: 1, partnerId: 2, name: '架空の画面から作った営業案件', stage: 'lead', expectedYen: '1,200,000', closeDate: '2026-12-01'});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual({...await db.get('SELECT work_id,partner_id,stage,expected_yen,close_date FROM sales_opportunities WHERE org_id=1 AND id=?', [made.body.opportunityId])},
    {work_id: 1, partner_id: 2, stage: 'lead', expected_yen: 1200000, close_date: '2026-12-01'});
  assert.equal((await admin.post('/sales-opportunities', {workId: 1, partnerId: 2, name: ''})).status, 400, '名前は必須');
  const oppA = await opportunity(2, '架空の配信先への提案');
  const oppB = await opportunity(2, '架空の放送局への提案');

  const empty = await admin.get('/sales-launch-month?month=2026-09&asOf=2026-08-25');
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.rows.length, 1, '作品1だけ');
  assert.deepEqual(Object.keys(empty.body.rows[0].cells).sort(), ['hv', 'pf', 'tv'], 'TVOD通常は10月なので9月のページに出ない');
  assert.deepEqual([empty.body.rows[0].cells.pf.state, empty.body.rows[0].cells.tv.state, empty.body.rows[0].cells.hv.state], ['urgent', 'urgent', 'urgent'], '解禁まで30日以内で提案なし');
  assert.equal(empty.body.rows[0].cells.tv.earliestDay, 5);

  const created = await admin.post('/sales-proposals', {opportunityId: oppA, proposedOn: '2026-05-06', settlementMethod: 'FLAT', amountExTax: 800000, termStart: '2026-09-15', termEnd: '2028-09-14', exclusivity: 'nonexclusive', windowIds: [svod], pitchNote: '夏の特集に合わせた非独占の案（架空）'});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const second = await admin.post('/sales-proposals', {opportunityId: oppB, proposedOn: '2026-07-07', settlementMethod: 'unverified', windowIds: [broadcast]});
  assert.equal(second.status, 201);
  assert.equal((await admin.post('/sales-proposals', {opportunityId: oppA, proposedOn: '2026-05-06', windowIds: [999999]})).status, 409, '作品に無いウィンドウ');

  const review = await admin.post(`/sales-proposals/${created.body.proposalId}/reviews`, {reviewedOn: '2026-06-01', outcome: 'adopted', score: 4, factors: {material: 'plus', timing: 'plus', price: 'minus'}, worked: '特集の時期に合わせた'});
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.equal((await admin.post(`/sales-proposals/${created.body.proposalId}/reviews`, {reviewedOn: '2026-05-01', outcome: 'rejected', score: 2})).status, 400, '評価の日は提案日より後');

  const activity = Number((await db.get("INSERT INTO sales_activities(org_id,project_id,work_id,opportunity_id,partner_id,occurred_on,activity_type,summary,created_by) VALUES(1,1,1,?,2,'2026-05-20','contact','先方の編成担当と面談（架空）',1) RETURNING id", [oppA])).id);
  assert.equal((await admin.post('/sales-activity-notes', {activityId: activity, noteKind: 'their_words', body: '夏の特集の枠に合う（架空）', tone: 2})).status, 201);
  assert.equal((await admin.post('/sales-activity-notes', {activityId: activity, noteKind: 'my_read', body: '非独占なら通る', tone: 3})).status, 400, '温度は −2〜+2');

  const month = await admin.get('/sales-launch-month?month=2026-09&asOf=2026-08-25');
  const cells = month.body.rows[0].cells;
  assert.deepEqual([cells.pf.state, cells.pf.partnerCount, cells.pf.proposals], ['done', 1, 1], '採用あり');
  assert.deepEqual([cells.tv.state, cells.tv.proposals], ['proposed', 1], '提案あり・採用なし');
  assert.equal(cells.hv.state, 'urgent');
  assert.equal(month.body.summary.urgent, 1);

  const list = await admin.get('/sales-proposals');
  assert.equal(list.status, 200);
  const row = list.body.rows.find((item) => item.id === created.body.proposalId);
  assert.equal(row.leadDays, 132, '2026-05-06 から 2026-09-15 まで');
  assert.deepEqual([row.review.outcome, row.review.score, row.review.factors.length], ['adopted', 4, 3]);
  assert.deepEqual(row.lastWords, {body: '夏の特集の枠に合う（架空）', tone: 2, occurredOn: '2026-05-20'});
  assert.deepEqual(list.body.factorTally.map((x) => [x.factor, x.adoptedPlus, x.adoptedMinus, x.enough]), [['material', 1, 0, false], ['price', 0, 1, false], ['timing', 1, 0, false]]);

  const csv = await admin.get('/sales-proposals/export.csv');
  assert.equal(csv.status, 200);
  const lines = csv.body.replace(/^﻿/, '').trim().split(/\r\n/);
  assert.equal(lines.length, 3, '見出し＋提案2行');
  assert.match(lines.find((line) => line.startsWith(String(created.body.proposalId))), /夏の特集に合わせた非独占の案（架空）.*採用,4,資料・タイミング（解禁まで）,金額/);
  assert.equal(proposalCsv([]).replace(/^﻿/, '').trim().split(/\r\n/).length, 1);

  // 記録は変えられない（受け口を通さない書き込みも DB が断る）
  await rejects(db.run('UPDATE sales_proposals SET amount_ex_tax=1 WHERE org_id=1'), /immutable/);
  await rejects(db.run('DELETE FROM sales_proposal_reviews WHERE org_id=1'), /immutable/);
  await rejects(db.run('DELETE FROM sales_activity_notes WHERE org_id=1'), /immutable/);
  const audits = await db.all("SELECT entity_type FROM audit_log WHERE org_id=1 AND entity_type IN ('sales_proposal','sales_proposal_review','sales_activity_note') ORDER BY id");
  assert.deepEqual(audits.map((x) => x.entity_type), ['sales_proposal', 'sales_proposal', 'sales_proposal_review', 'sales_activity_note']);

  const production = await as('production');
  assert.equal((await production.get('/sales-launch-month?month=2026-09')).status, 403);
  assert.equal((await production.get('/sales-proposals')).status, 403);
  assert.equal((await production.post('/sales-proposals', {opportunityId: oppA, proposedOn: '2026-05-06'})).status, 403);
});
