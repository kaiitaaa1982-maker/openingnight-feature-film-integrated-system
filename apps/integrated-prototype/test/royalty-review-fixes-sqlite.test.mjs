// ロイヤリティのレビュー指摘（2026-09-25）の再発防止のうち、SQLite そのものを確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// F10: SQLite の INSERT OR REPLACE（衝突した行を消して入れ直す）を表のトリガーが止めることを確かめる（PostgreSQL に INSERT OR REPLACE は無い）。
// 元は royalty-review-fixes.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR6 で分けた。中身は変えていない）。組み立ては royalty-review-fixture.mjs。
// F8（明細480行のクラウドの確定）は、2026-10-04 に R2 の層を試験の DB の入口にかぶせて royalty-review-fixes.test.mjs へ戻した
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './royalty-review-fixture.mjs';

test('FR-SETL-STMT-023 F10: INSERT OR REPLACE で、取り消した確定版の復活・実額や支払の書き換え・行の置き換えはできない', async (t) => {
  const f = await fixture({t, kind: 'sqlite'});
  const {agreementId} = await f.create();
  await f.create({holderPartnerId: 11, category: 'music', agreementCode: 'RF-MUS-1', title: '架空の音楽', term: f.term({calcMethod: 'manual', baseKind: undefined, rateBps: undefined})});
  await f.sale('2025-01', 100000);
  const v1 = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true, keys: ['10:2025-03']})).created[0].statementId;
  const voided = f.ok(await f.req(`/royalty/statements/${v1}/void`, {reason: '作り直す（架空）'}));
  const v2 = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true, keys: ['10:2025-03']})).created[0].statementId;
  const raw = (sql, ...params) => () => f.db.raw.prepare(sql).run(...params);
  assert.throws(raw("INSERT OR REPLACE INTO royalty_statement_voids(id,org_id,statement_id,reason,created_by) VALUES(?,1,?,'差し替え',1)", voided.id, v2), /置き換えられません/);
  assert.throws(raw("INSERT OR REPLACE INTO royalty_statement_voids(org_id,statement_id,reason,created_by) VALUES(1,?,'差し替え',1)", v1), /置き換えられません/);
  const active = f.ok(await f.req('/royalty/statements?asOf=2025-05-01')).statements.map((s) => s.id);
  assert.deepEqual(active, [v2], '第2版が有効なまま');
  const musicId = f.db.raw.prepare("SELECT id FROM royalty_agreements WHERE agreement_code='RF-MUS-1'").get().id;
  const m = f.ok(await f.req('/royalty/manual-accruals', {agreementId: musicId, accrualMonth: '2025-01', amountYen: 50000, sourceReference: 'RF-SRC-1', reason: '分配明細（架空）'}));
  assert.throws(raw("INSERT OR REPLACE INTO royalty_manual_accruals(id,org_id,agreement_id,accrual_month,amount_yen,source_reference,reason,created_by) VALUES(?,1,?,'2025-01',1,'RF-SRC-1','書き換え',1)", m.id, musicId), /置き換えられません/);
  assert.throws(raw("INSERT OR REPLACE INTO royalty_manual_accruals(org_id,agreement_id,accrual_month,amount_yen,source_reference,reason,created_by) VALUES(1,?,'2025-01',1,'RF-SRC-1','書き換え',1)", musicId), /置き換えられません/);
  assert.equal(f.db.raw.prepare('SELECT amount_yen FROM royalty_manual_accruals WHERE id=?').get(m.id).amount_yen, 50000);
  const paid = f.ok(await f.req(`/royalty/statements/${v2}/events`, {kind: 'reported', occurredOn: '2025-04-20'}));
  assert.throws(raw("INSERT OR REPLACE INTO royalty_statement_events(id,org_id,statement_id,event_kind,occurred_on,created_by) VALUES(?,1,?,'reported','2025-04-30',1)", paid.id, v2), /置き換えられません/);
  assert.throws(raw("INSERT OR REPLACE INTO royalty_statements(id,org_id,holder_partner_id,close_month,version_no,calculation_version,as_of,input_hash,calculation_json,royalty_yen,adjustment_yen,advance_recouped_yen,carried_in_yen,payable_yen,carried_out_yen,hold_count,line_count,created_by) VALUES(?,1,10,'2025-03',9,'royalty-cycle-v1','2025-05-01',?,'{}',0,0,0,0,0,0,0,0,1)", v2, 'h'.repeat(64)), /置き換えられません|作成済み/);
  assert.throws(raw("INSERT OR REPLACE INTO royalty_statement_lines(org_id,statement_id,line_no,line_kind,agreement_id,accrual_month,amount_yen,created_by) VALUES(1,?,1,'accrual',?,'2025-01',1,1)", v2, agreementId), /置き換えられません|行数/);
  assert.throws(raw("INSERT OR REPLACE INTO royalty_agreements(id,org_id,project_id,work_id,holder_partner_id,category,agreement_code,title,created_by) VALUES(?,1,1,1,10,'director','RF-X','書き換え',1)", agreementId), /置き換えられません/);
  const musicTerm = f.db.raw.prepare('SELECT id FROM royalty_term_versions WHERE agreement_id=?').get(musicId).id;
  f.db.raw.prepare("INSERT INTO royalty_term_channels(org_id,term_version_id,channel_group,created_by) VALUES(1,?,'digital',1)").run(musicTerm);
  assert.throws(raw("INSERT OR REPLACE INTO royalty_term_channels(org_id,term_version_id,channel_group,created_by) VALUES(1,?,'digital',1)", musicTerm), /置き換えられません/);
  const entry = f.ok(await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'note', reason: '架空の記録'}));
  assert.throws(raw("INSERT OR REPLACE INTO royalty_irregular_entries(id,org_id,holder_partner_id,kind,reason,created_by) VALUES(?,1,10,'note','書き換え',1)", entry.id), /置き換えられません/);
  assert.equal(f.db.raw.prepare('SELECT reason FROM royalty_irregular_entries WHERE id=?').get(entry.id).reason, '架空の記録');
});
