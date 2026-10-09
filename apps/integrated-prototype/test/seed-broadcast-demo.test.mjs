// 番販・放送の架空データ（scripts/seed-broadcast-demo.mjs）の試験。
// ・seed-sales-demo → seed-eigyo-demo の後に流し、1回だけ入ること（2回目は何も足さない）。組織1からは見えないこと。
// ・書き込みはすべて API を通り、本番へ記録して再生できる形（DDL を含まない・1つの値は128KB未満・1文の値は100個まで・1回の batch は480文まで）。
// ・赤・黄の例と放送枠の数は、計画（slotPlan）からこの試験の中で書き下した決まりで数え直して、API の結果と照合する。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {seedSalesDemo, SALES_DEMO} from '../scripts/seed-sales-demo.mjs';
import {seedEigyoDemo} from '../scripts/seed-eigyo-demo.mjs';
import {seedBroadcastDemo, slotPlan, entryPlan, termPlan, rightsPlan, proposalDraftPlan, BROADCAST_DEMO} from '../scripts/seed-broadcast-demo.mjs';

// 書き込みを記録する DB（読み込みはそのまま渡す）
function recording(db) {
  const writes = [];
  return {
    writes,
    all: (sql, params) => db.all(sql, params),
    get: (sql, params) => db.get(sql, params),
    run: (sql, params = []) => { writes.push({batch: 1, sql, params}); return db.run(sql, params); },
    batch: (statements) => { writes.push(...statements.map((s) => ({batch: statements.length, sql: s.sql, params: s.params || []}))); return db.batch(statements); },
    close: () => db.close(),
  };
}

let db, first, second, api, orgId, writes, secondWrites;
const tables = ['partners', 'partner_profile_versions', 'broadcast_station_type_versions', 'broadcast_slots', 'broadcast_slot_versions', 'broadcast_airings',
  'partner_lists', 'partner_list_entries', 'partner_list_entry_versions', 'broadcast_entry_term_versions', 'rights_intake_cases', 'rights_intake_scopes', 'audit_log',
  'broadcast_proposal_drafts', 'broadcast_proposal_draft_deletions'];
const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id=?`, [orgId])).n)])));
before(async (t) => {
  db = await openTestDb({t});
  await seedSalesDemo(db);
  await seedEigyoDemo(db);
  orgId = (await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode])).id;
  const rec = recording(db);
  first = await seedBroadcastDemo(rec);
  writes = rec.writes;
  const beforeSecond = await counts();
  const rec2 = recording(db);
  second = {result: await seedBroadcastDemo(rec2), before: beforeSecond, after: await counts()};
  secondWrites = rec2.writes;
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const cookies = {demo: await login(SALES_DEMO.adminEmail), fixture: await login('admin@openingnight.invalid')};
  api = async (path, as = 'demo') => (await app.request(`/api${path}`, {headers: {cookie: cookies[as]}})).json();
});
after(() => db?.close());

test('1回だけ入り、2回目は何も足さない（書き込みも無い）', () => {
  assert.equal(first.skipped, false);
  assert.deepEqual([first.partners, first.stationTypes, first.slots, first.entries, first.terms, first.rights], [2, 4, slotPlan().length, entryPlan().length, termPlan().length, 8]);
  // 提案から作った下書き3件（計画の月の数）のうち、削除の理由がある1件を削除した
  assert.deepEqual([first.proposalDrafts, first.proposalDeletions], [proposalDraftPlan().reduce((n, p) => n + p.months.length, 0), proposalDraftPlan().filter((p) => p.deleteReason).length]);
  assert.deepEqual([first.proposalDrafts, first.proposalDeletions], [3, 1]);
  assert.equal(second.result.skipped, true);
  assert.deepEqual(second.after, second.before);
  assert.deepEqual(secondWrites.filter((w) => !/^INSERT INTO sessions/.test(w.sql)), [], '2回目はログイン以外に書かない');
});

test('本番へ記録して再生できる: DDL を含まず、1つの値は128KB未満、1文の値は100個まで、1回の batch は480文まで', () => {
  assert.ok(writes.length > 100);
  for (const w of writes) {
    assert.doesNotMatch(w.sql, /^\s*(CREATE|ALTER|DROP|PRAGMA|ATTACH|VACUUM)\b/i, w.sql.slice(0, 80));
    assert.ok(w.params.length <= 100, `値が100個を超える文: ${w.sql.slice(0, 80)}`);
    assert.ok(w.batch <= 480, 'batch は480文まで');
    for (const value of w.params) if (typeof value === 'string') assert.ok(new TextEncoder().encode(value).length < 128 * 1024, `128KB以上の値: ${w.sql.slice(0, 80)}`);
  }
  const auditTransitions = writes.filter((w) => /^INSERT INTO audit_log/.test(w.sql) && w.params[2] === 'transition').length;
  assert.equal(auditTransitions, first.transitions, '承認の手順は1段ずつ API で進めて監査に残る');
});

test('放送局4局に区分「放送局」と局の種別（地上波・BS・CS・CATV）が付く', async () => {
  const body = await api('/broadcast/station-types');
  const byCode = new Map(body.stations.map((s) => [s.code, s]));
  for (const station of BROADCAST_DEMO.stations) {
    assert.equal(byCode.get(station.code)?.station_type, station.type, station.code);
    assert.ok(byCode.get(station.code).roles.includes('broadcaster'));
  }
});

test('放送履歴表: 枠の数・実放送の回数・同じ月の別局の赤と黄が計画どおり（計画から数え直して照合）', async () => {
  const plan = slotPlan();
  // 書き下した決まり: 同じ作品・同じ月の別の局で、どちらも申請中・仮押さえ・確定なら色。両方確定なら赤、そうでなければ黄
  const ACTIVE = new Set(['pending_first', 'tentative', 'pending_final', 'confirmed']);
  const expected = new Map();
  for (const a of plan) for (const b of plan) {
    if (a === b || a.work !== b.work || a.month !== b.month || a.station === b.station || !ACTIVE.has(a.status) || !ACTIVE.has(b.status)) continue;
    const color = a.status === 'confirmed' && b.status === 'confirmed' ? 'red' : 'yellow';
    const k = `${a.work}|${a.month}`;
    if (expected.get(k) !== 'red') expected.set(k, color);
  }
  assert.deepEqual([...expected.entries()].sort(), [['DEMO-W01|2026-08', 'red'], ['DEMO-W02|2026-11', 'yellow'], ['DEMO-W04|2026-10', 'yellow']]);
  const h = await api('/broadcast/history?from=2025-05&to=2027-04');
  const actual = new Map();
  for (const row of h.rows) for (const [ym, cell] of Object.entries(row.cells)) if (cell.color) actual.set(`${row.work_code}|${ym}`, cell.color);
  assert.deepEqual([...actual.entries()].sort(), [...expected.entries()].sort());
  for (let n = 1; n <= 6; n += 1) {
    const code = `DEMO-W0${n}`, row = h.rows.find((r) => r.work_code === code);
    const mine = plan.filter((s) => s.work === code);
    const existing = code === 'DEMO-W04' ? 1 : 0; // seed-eigyo-demo の W04 2025-06 の下書きの枠
    assert.equal(row.slot_count, mine.length + existing, code);
    assert.equal(row.aired_runs, mine.reduce((sum, s) => sum + s.airings.reduce((k, [, c]) => k + c, 0), 0), code);
  }
  assert.match(h.rows.find((r) => r.work_code === 'DEMO-W06').cells['2027-01']?.text || '', /（下書き）$/, '下書きの枠');
  const fixture = await api('/broadcast/history?from=2025-05&to=2027-04', 'fixture');
  assert.ok(fixture.rows.every((r) => !r.work_code.startsWith('DEMO-')), '組織1からは見えない');
});

test('放送ウィンドウ提案: W05 は CS の独占とホールドバックで空きなし、W07 は権利の終わりで短くなり、W06 には商品指定の予定の明細がある', async () => {
  const p = await api(`/broadcast/window-proposals?asOf=${BROADCAST_DEMO.asOf}`);
  const row = (code) => p.rows.find((r) => r.work_code === code);
  assert.equal(row('DEMO-W05').state, 'full');
  assert.deepEqual(row('DEMO-W05').result.blocked.map((b) => [b.kind, b.from, b.to]), [['exclusive', '2026-04-01', '2027-03-31'], ['holdback', '2027-04-01', '2027-09-30']]);
  // 局へ出す一文は、空きなしの理由（独占とホールドバック）を両方書く（独占の終わりの翌日から放送できると読ませない）
  assert.match(row('DEMO-W05').summary, /^空きなし（24か月以内）：独占契約中：〜2027年3月31日.*／ホールドバック：〜2027年9月30日/);
  // W06 の下書きの放送枠（架空CATV 2027-01）は同時期の他局に数えない
  assert.doesNotMatch(row('DEMO-W06').others_text, /放送枠 2027年1月/);
  assert.deepEqual(row('DEMO-W07').result.proposals.map((x) => [x.from, x.to]), [[BROADCAST_DEMO.asOf, rightsPlan().find((r) => r.workCode === 'DEMO-W07').rightsEnd]]);
  for (let n = 1; n <= 8; n += 1) assert.notEqual(row(`DEMO-W0${n}`).state, 'blocked', `W0${n} は権利と放送の解禁がそろう`);
  assert.ok(row('DEMO-W20').result.reasons.some((r) => r.startsWith('放送の解禁が未定')), 'W20 は放送の解禁が未定');
  assert.match(row('DEMO-W01').license_text, /架空BS放送（架空）: 3回中3回（残り0回）・ホールドバック6か月/);
  const productEntry = await db.get(`SELECT v.product_id,p.sku,v.status,v.exclusivity FROM partner_list_entry_versions v JOIN products p ON p.org_id=v.org_id AND p.id=v.product_id
    JOIN works w ON w.org_id=v.org_id AND w.id=v.work_id WHERE v.org_id=? AND w.code='DEMO-W06'`, [orgId]);
  assert.deepEqual({...productEntry, product_id: undefined}, {product_id: undefined, sku: 'DEMO-W06-TV', status: 'planned', exclusivity: 'nonexclusive'});
});

test('放送の権利範囲は W01〜W08 に入り、委員会の作品は委員会の調達ケースの改訂（出資者はそのまま）、ほかは単独保有', async () => {
  const rows = await db.all(`SELECT w.code,c.intake_type,c.source_case_id,s.rights_start,s.rights_end,
      (SELECT COUNT(*) FROM rights_intake_participants p WHERE p.org_id=c.org_id AND p.intake_case_id=c.id) AS participants
    FROM rights_intake_scopes s JOIN rights_intake_cases c ON c.org_id=s.org_id AND c.id=s.intake_case_id JOIN works w ON w.org_id=c.org_id AND w.id=c.work_id
    WHERE s.org_id=? AND s.channel='放送' AND NOT EXISTS(SELECT 1 FROM rights_intake_cases n WHERE n.org_id=c.org_id AND n.source_case_id=c.id) ORDER BY w.code`, [orgId]);
  assert.deepEqual(rows.map((r) => r.code), rightsPlan().map((r) => r.workCode));
  for (const r of rows) {
    const plan = rightsPlan().find((x) => x.workCode === r.code);
    assert.deepEqual([r.rights_start, r.rights_end], [plan.rightsStart, plan.rightsEnd], r.code);
    if (plan.committee) { assert.equal(r.intake_type, 'committee'); assert.ok(r.source_case_id); assert.ok(r.participants >= 3); } else assert.equal(r.intake_type, 'sole_owned');
  }
});

test('放送ウィンドウ提案から作った下書き2件（W07・W08）と、合意に至らず削除した1件（W03）が API を通って入り、削除したものは一覧・履歴表から外れる', async () => {
  const list = await api('/broadcast/window-proposals/drafts');
  const summary = (row) => [row.work_code, row.product_sku, row.station_name, row.broadcast_month, row.run_label, row.status, row.memo.split(' ').at(-1)];
  // 計画（proposalDraftPlan）から書き下した期待: W07 地上波 2026-11 初回、W08 CS 2027-01 初回（どちらも下書き）、W03 CATV 2027-03 再放送（削除）
  assert.deepEqual(list.rows.map(summary).sort(), [
    ['DEMO-W07', 'DEMO-W07-TV', '架空地上波テレビ（架空）', '2026-11', '初回', 'draft', 'DEMO-BPD-1'],
    ['DEMO-W08', 'DEMO-W08-TV', '架空CS放送（架空）', '2027-01', '初回', 'draft', 'DEMO-BPD-2'],
  ]);
  assert.deepEqual(list.deleted.map(summary), [['DEMO-W03', 'DEMO-W03-TV', '架空ケーブルテレビ（架空）', '2027-03', '再放送', 'cancelled', 'DEMO-BPD-3']]);
  assert.equal(list.deleted[0].deleted_reason, proposalDraftPlan().find((p) => p.deleteReason).deleteReason);
  assert.equal(list.deleted[0].deleted_by_name, SALES_DEMO.adminName);
  // 提案する期間の中の月で、放送枠の期間はその月まるごと（W07 は 2026-09-25〜2026-12-31、W08 は 〜2027-11-30、W03 は 〜2027-06-30）
  assert.deepEqual(list.rows.map((r) => [r.work_code, r.period_from, r.period_to, r.proposal_from, r.proposal_to]).sort(), [
    ['DEMO-W07', '2026-11-01', '2026-11-30', BROADCAST_DEMO.asOf, '2026-12-31'],
    ['DEMO-W08', '2027-01-01', '2027-01-31', BROADCAST_DEMO.asOf, '2027-11-30'],
  ]);
  const h = await api('/broadcast/history?from=2025-05&to=2027-04');
  const cell = (code, ym) => h.rows.find((r) => r.work_code === code)?.cells[ym]?.text || '';
  assert.equal(cell('DEMO-W07', '2026-11'), '架空地上波テレビ（架空）（下書き）');
  assert.equal(cell('DEMO-W08', '2027-01'), '架空CS放送（架空）（下書き）');
  assert.equal(cell('DEMO-W03', '2027-03'), '', '削除した下書きは履歴表に出ない');
  assert.deepEqual([h.counts.red, h.counts.yellow], [1, 2], '下書きは赤・黄に数えない');
  // 監査: 作成3件と削除1件が、架空の管理者の操作として残る
  const audits = await db.all("SELECT action,detail_json FROM audit_log WHERE org_id=? AND entity_type='broadcast_slot' AND detail_json LIKE '%window_proposal%'", [orgId]);
  assert.deepEqual(audits.map((a) => a.action).sort(), ['create', 'create', 'create', 'delete']);
  assert.deepEqual((await api('/broadcast/window-proposals/drafts', 'fixture')).rows, [], '組織1からは見えない');
});
