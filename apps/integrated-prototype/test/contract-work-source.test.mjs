// 源泉1 制作受託の材料の読み取り（src/planning/planning-store.mjs の readContractWorkSourceRows）と導き方（src/accounting/profit/contract-work-source-model.mjs）を、
// 受託制作の契約の版（移行 0013。フェーズ1 #10b）の入った DB で確かめる（行動指標の計画 段B #3）。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-006（受託費×入金した節目の割合の純額。J-14 (a)。要確認12）と、
// project-cashflow-forecast-actual.md の FR-REV-YOJITSU-044・contract-work.md の FR-REV-CWORK-035（最新の版。節目ごとの受託費は最大剰余法で和が受託費）から、
// 架空の fixture（test/fixtures/yojitsu/revenue-classes.json の受託制作の案件）を読んで独立に計算する。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import {contractWorkSource} from '../src/accounting/profit/contract-work-source-model.mjs';
import {loadRevenueClassFixture, seedRevenueClassFixture} from './revenue-class-fixture.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const PERIOD = {from: '2026-04', to: '2027-03'};
const CLOSED = '2026-10';

// 受託費＝総製作費×受託費率の truncate（受託費率が空なら既定 1000。FR-REV-CWORK-035）と、最大剰余法（各行を truncate し、足りない1円ずつを
// 余りの大きい順・同じなら連番の小さい順に足す。docs/rules/money.md）
const feeOf = (budget, markup) => Number(BigInt(budget) * BigInt(markup ?? 1000) / 10000n);
function largestRemainder(total, shares) {
  const parts = shares.map((share, index) => ({index, floor: Number(BigInt(total) * BigInt(share) / 10000n), rest: BigInt(total) * BigInt(share) % 10000n}));
  let left = total - parts.reduce((n, p) => n + p.floor, 0);
  for (const p of [...parts].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1))) {
    if (left === 0) break;
    p.floor += 1;
    left -= 1;
  }
  return parts.map((p) => p.floor);
}

// fixture の受託制作の案件の最新の版から、源泉1の期待値を作る（入金した節目＝節目の月が締めた月まで。期間内＝期間の始まり〜締めた月）
function expectedRow(fixtureProject, projectId) {
  const latest = fixtureProject.contractVersions.at(-1);
  const fee = feeOf(latest.budgetYen, latest.markupBps);
  const shares = latest.milestones.map((m) => m.shareBps);
  const feeParts = largestRemainder(fee, shares);
  const budgetParts = largestRemainder(latest.budgetYen, shares);
  const milestones = latest.milestones.map((m, i) => ({seq: i + 1, month: m.dueOn.slice(0, 7), shareBps: m.shareBps,
    received: m.dueOn.slice(0, 7) <= CLOSED, budgetYen: budgetParts[i], feeYen: feeParts[i]}));
  const received = milestones.filter((m) => m.received);
  return {
    projectId, code: fixtureProject.code, title: fixtureProject.title, versionNo: fixtureProject.contractVersions.length,
    budgetYen: latest.budgetYen, markupBps: latest.markupBps ?? 1000, feeYen: fee, complete: true,
    receivedShareBps: received.reduce((n, m) => n + m.shareBps, 0),
    feeReceivedTotalYen: received.reduce((n, m) => n + m.feeYen, 0),
    feeReceivedPeriodYen: received.filter((m) => m.month >= PERIOD.from).reduce((n, m) => n + m.feeYen, 0),
    milestones,
  };
}

test('FR-REV-KPI-006 FR-REV-YOJITSU-044 源泉1は型「受託制作」の案件の最新の契約の版を読み、粗利は受託費×締めた月までの節目の割合（純額）で、版の無い受託は未登録に出す', async (t) => {
  const db = await openTestDb({t});
  const fixture = loadRevenueClassFixture();
  const {projectIds} = await seedRevenueClassFixture(db, {fixture});
  const ids = [...projectIds.values()];
  const rows = await planning.readContractWorkSourceRows(db, 1, ids);
  // 型「受託制作」の案件だけ（買付・販売委託・自社出資・製作委員会・受託開発の案件は読まない）。節目は最新の版（第2版）の行だけ
  const cw = projectIds.get('CW');
  const noVersion = projectIds.get('CW-NOVER');
  assert.deepEqual(rows.projects.map((p) => [Number(p.project_id), p.earning_type, Number(p.profit_source), p.version_no === null ? null : Number(p.version_no)]),
    [[cw, 'contract_work', 1, 2], [noVersion, 'contract_work', 1, null]].sort((a, b) => a[0] - b[0]));
  assert.deepEqual(rows.milestones.map((m) => [Number(m.project_id), Number(m.version_no), Number(m.seq), m.due_on, Number(m.share_bps)]),
    [[cw, 2, 1, '2026-05-01', 3333], [cw, 2, 2, '2026-09-01', 3334], [cw, 2, 3, '2027-01-01', 3333]]);

  const source = contractWorkSource(rows, {period: PERIOD, closedMonth: CLOSED});
  const fixtureCw = fixture.projects.find((p) => p.key === 'CW');
  assert.deepEqual(source.rows, [expectedRow(fixtureCw, cw)]);
  // 架空の値で: 受託費 6,545,514（52,364,117×12.5% の truncate）のうち、2026-05・2026-09 の節目（6667 bp）が入金した側
  assert.deepEqual([source.rows[0].feeYen, source.rows[0].receivedShareBps, source.rows[0].feeReceivedPeriodYen], [6545514, 6667, 4363894]);
  // 2027-01 の節目は入金の予定（契約済み）で、額は残りの受託費ちょうど
  assert.deepEqual(source.rows[0].milestones.filter((m) => !m.received).map((m) => [m.month, m.feeYen]), [['2027-01', 6545514 - 4363894]]);
  const fixtureNoVersion = fixture.projects.find((p) => p.key === 'CW-NOVER');
  assert.deepEqual(source.unregistered, [{projectId: noVersion, code: fixtureNoVersion.code, title: fixtureNoVersion.title}]);
  assert.deepEqual([source.excluded, source.unknownCount, source.receiptBasis], [[], 0, 'milestone_month']);
});

test('FR-REV-KPI-006 源泉1の材料は渡した案件と組織の分だけを読み、版のある受託が無ければ未接続（null）で0円で埋めない', async (t) => {
  const db = await openTestDb({t});
  const {projectIds} = await seedRevenueClassFixture(db);
  const cw = projectIds.get('CW');
  const noVersion = projectIds.get('CW-NOVER');
  // 財務の権限で絞った案件の ID に無い案件は読まない
  const onlyNoVersion = await planning.readContractWorkSourceRows(db, 1, [noVersion, projectIds.get('ACQ-MG')]);
  assert.deepEqual(onlyNoVersion.projects.map((p) => Number(p.project_id)), [noVersion]);
  assert.deepEqual(onlyNoVersion.milestones, []);
  const unconnected = contractWorkSource(onlyNoVersion, {period: PERIOD, closedMonth: CLOSED});
  assert.deepEqual([unconnected.rows, unconnected.unregistered.map((p) => p.projectId)], [null, [noVersion]]);
  // 別の組織からは、同じ案件の ID を渡しても読めない
  assert.deepEqual(await planning.readContractWorkSourceRows(db, 2, [cw, noVersion]), {projects: [], milestones: []});
  // 案件が無ければ問い合わせない
  assert.deepEqual(await planning.readContractWorkSourceRows(db, 1, []), {projects: [], milestones: []});
  // 案件の行と節目の行は読み取りの一括（db.readBatch）の1回で同じ時点から読む（80件まで。存在しない ID を混ぜても行は増えず、並びは案件・連番の順）。
  // 一括の外の読み取り（db.all）は使わない
  const batches = [];
  const counting = {
    all: () => { throw new Error('案件の行と節目の行を別々の時点に読んだ（db.all）'); },
    readBatch: (statements) => { batches.push(statements.length); return db.readBatch(statements); },
  };
  const many = [cw, noVersion, ...Array.from({length: 70}, (_, i) => 900000 + i)];
  const read = await planning.readContractWorkSourceRows(counting, 1, many.reverse());
  assert.deepEqual(batches, [2]);
  assert.deepEqual(read.projects.map((p) => Number(p.project_id)), [cw, noVersion].sort((a, b) => a - b));
  assert.deepEqual(read.milestones.map((m) => [Number(m.version_no), Number(m.seq)]), [[2, 1], [2, 2], [2, 3]]);
  // 81件からは80件ごとに一括を1回ずつ（案件の行とその節目の行は同じ一括に入る）。並びは分けても案件・連番の順
  batches.length = 0;
  const split = await planning.readContractWorkSourceRows(counting, 1, [...Array.from({length: 80}, (_, i) => 900000 + i), noVersion, cw]);
  assert.deepEqual(batches, [2, 2]);
  assert.deepEqual(split.projects.map((p) => Number(p.project_id)), [cw, noVersion].sort((a, b) => a - b));
  assert.deepEqual(split.milestones.map((m) => [Number(m.project_id), Number(m.seq)]), [[cw, 1], [cw, 2], [cw, 3]]);
});

test('FR-REV-KPI-006 節目の欠けた最新の版（アプリを通さない書き込み）は前の版に戻らず額を未確定（null）にし、稼ぎ方の無い受託制作の案件は理由つきで源泉1から外す', async (t) => {
  const db = await openTestDb({t});
  const {projectIds} = await seedRevenueClassFixture(db);
  const cw = projectIds.get('CW');
  // 節目を3行と書いて1行しか入れていない第3版（アプリは版と節目を1回の batch で書くので作らない形）
  await db.run('INSERT INTO contract_production_versions(org_id,project_id,version_no,budget_yen,markup_bps,fee_yen,milestone_count,created_by) VALUES(1,?,3,1000000,1200,120000,3,1)', [cw]);
  await db.run("INSERT INTO contract_production_milestones(org_id,project_id,version_no,seq,due_on,share_bps) VALUES(1,?,3,1,'2026-06-01',5000)", [cw]);
  // 稼ぎ方を入れていない型「受託制作」の案件（契約の版はある）
  const bare = await planning.createProject(db, 1, {code: 'FICT-CW-BARE', title: '架空の制作受託（稼ぎ方なし）', projectType: 'contract_production', earningType: null,
    baseAmountYen: null, revenueRateBps: null, counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null}, {createdBy: ADMIN});
  await db.run('INSERT INTO contract_production_versions(org_id,project_id,version_no,budget_yen,markup_bps,fee_yen,milestone_count,created_by) VALUES(1,?,1,2000000,1000,200000,1,1)', [bare]);
  await db.run("INSERT INTO contract_production_milestones(org_id,project_id,version_no,seq,due_on,share_bps) VALUES(1,?,1,1,'2026-05-01',10000)", [bare]);

  const rows = await planning.readContractWorkSourceRows(db, 1, [cw, bare]);
  const source = contractWorkSource(rows, {period: PERIOD, closedMonth: CLOSED});
  assert.deepEqual(source.rows.map((r) => [r.projectId, r.versionNo, r.feeYen, r.complete, r.receivedShareBps, r.feeReceivedTotalYen, r.feeReceivedPeriodYen]),
    [[cw, 3, 120000, false, null, null, null]]);
  assert.deepEqual(source.rows[0].milestones, [{seq: 1, month: '2026-06', shareBps: 5000, received: true, budgetYen: null, feeYen: null}]);
  assert.equal(source.unknownCount, 1);
  assert.deepEqual(source.excluded, [{projectId: bare, code: 'FICT-CW-BARE', title: '架空の制作受託（稼ぎ方なし）', reason: 'no_earning_type'}]);
});
