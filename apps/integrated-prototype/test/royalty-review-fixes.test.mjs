// ロイヤリティのレビュー指摘（2026-09-25）の再発防止。架空のデータだけを使う。
// F1 移行の締め月の後ろ倒し／F2 照合の合わない下書きの確定／F3 権限外の作品を含む権利者の金額／F4 保留の解除の取消／
// F5 報告済みの月を計上無しにするサイクル／F6 移行前の前払金と未払残／F7 絞り込んだ集計シートの支払／F8 明細の多い報告書（クラウド）／
// F9 一括作成の問い合わせ数／F10 INSERT OR REPLACE／F11 保留の件数の合計
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createApp} from '../src/app.mjs';
import {identityForEmail} from '../src/session-org.mjs';
import {R2LargeValueDatabase} from '../src/cloud-r2-db.mjs';
import {fixture} from './royalty-review-fixture.mjs';
import {financeWorkIds} from '../src/royalty/royalty-data.mjs';
import {GENERATE_LIMIT, splitUtf8, chunkRows, utf8Bytes} from '../src/royalty/royalty-routes.mjs';
import {HOLD_COUNT_COLUMN, ledgerHolderTail, isCreatablePeriod} from '../src/royalty/royalty-ui.mjs';
import {
  accrueAgreement, resolveItems, buildStatement, buildLedger, checksOk, scheduleConflicts, irregularReversalConflict, reportedMonths,
  statementBlockReason, markBlockedPeriods,
} from '../src/royalty/royalty-model.mjs';

// 権利者1人・契約1つ（毎月締め）の純関数の準備
const P = (cycleKind, extra = {}) => ({id: 1, startsMonth: '2025-01', endsMonth: null, cycleKind, anchorMonth: null, customCloseMonths: null, firstCloseImmediate: false,
  reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', ...extra});
const T = (extra = {}) => ({id: 11, versionNo: 1, effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1000, windowFeeBps: null,
  fixedAmountYen: null, advanceYen: 0, minPaymentYen: null, channels: [], expenseCategories: [], ...extra});
const A = (extra = {}) => ({id: 1, code: 'AG-1', title: '架空の監督料', workId: 1, workTitle: '架空作品', holderId: 7, holderName: '架空監督', category: 'director',
  terms: [T()], schedule: {statementsFrom: null, phases: [P('monthly')]}, ...extra});
const holder = {id: 7, name: '架空監督', code: 'PT-7'};
const itemsOf = (agreement, sales, entries = []) => resolveItems({agreement, accruals: accrueAgreement({agreement, toMonth: '2025-12', sales: sales.map(([m, amount]) => ({accountingMonth: m, amount, channelGroup: 'digital'}))}), entries});
const asPrior = (id, statement) => ({id, closeMonth: statement.closeMonth, carriedOutYen: statement.totals.carriedOutYen, lines: statement.lines});

test('FR-SETL-STMT-017 F1: 確定版のある契約に、報告書を作り始める締め月を後ろへずらしたサイクルの版は足せない（API・表のトリガー）', async (t) => {
  const f = await fixture({t});
  const {agreementId} = await f.create({term: f.term({advanceYen: 15000})});
  await f.sale('2025-01', 100000);
  f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true}));
  const moved = await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: '移行の締め月を入れ直す（架空）', statementsFrom: '2025-06', phases: [f.phase()]});
  assert.equal(moved.status, 409);
  assert.match(moved.data.error, /確定版がある期間は移行前にできません/);
  assert.ok(moved.data.details.errors.some((e) => e.field === 'statementsFrom'));
  // 報告書を作り始める締め月が確定版の締め月以前なら足せる
  f.ok(await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: '移行の締め月を明記（架空）', statementsFrom: '2025-03', phases: [f.phase()]}));
  // アプリを通らない書き込みも表のトリガーで止める
  await assert.rejects(f.db.run("INSERT INTO royalty_schedule_versions(org_id,agreement_id,version_no,statements_from,reason,created_by) VALUES(1,?,3,'2025-06','x',1)", [agreementId]), (e) => e.dbError?.kind === 'raise' && /移行前/.test(e.message));
  // 4月の売上を入れた6月締め: 前払金15,000のうち1月分10,000は充当済み。残り5,000を充当し、支払は5,000（二重に数えない）
  await f.sale('2025-04', 100000);
  const preview = f.ok(await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-06&asOf=2025-08-01'));
  assert.equal(preview.statement.totals.advanceRecoupedYen, 5000);
  assert.equal(preview.statement.totals.payableYen, 5000);
  assert.ok(checksOk(preview.statement.checks), JSON.stringify(preview.statement.checks));
});

test('FR-SETL-STMT-017 F1: 移行前（statementsFrom より前）でも、この仕組みの確定版に載った計上月は「以前の仕組みで報告済み」と二重に数えない（モデル）', () => {
  const plain = A({terms: [T({advanceYen: 15000})]});
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [plain], items: itemsOf(plain, [['2025-01', 100000]])});
  assert.equal(jan.totals.advanceRecoupedYen, 10000);
  // 後から statementsFrom=2025-06 の版が効いた（表を直接書き換えた場合など）
  const moved = {...plain, schedule: {statementsFrom: '2025-06', phases: [P('monthly')]}};
  const items = itemsOf(moved, [['2025-01', 100000], ['2025-06', 100000]]);
  assert.equal(items.find((i) => i.accrualMonth === '2025-01').external, true);
  const june = buildStatement({holder, closeMonth: '2025-06', agreements: [moved], items, priorStatements: [asPrior(1, jan)]});
  const advance = june.advance[0];
  assert.equal(advance.cumulativeBefore, 10000, '報告済みの1月は内の分として1回だけ');
  assert.equal(advance.recoupedBefore, 10000);
  assert.equal(june.totals.advanceRecoupedYen, 5000);
  assert.equal(june.totals.payableYen, 5000, '支払予定額は15,000ではなく5,000');
  assert.ok(checksOk(june.checks), JSON.stringify(june.checks));
  const ledger = buildLedger({agreements: [moved], items, statements: [{id: 1, holderId: 7, closeMonth: '2025-01', lines: jan.lines, events: []}], from: '2025-01', to: '2025-06'});
  assert.match(ledger.detail.find((d) => d.accrualMonth === '2025-01').status, /^報告済み/);
  assert.equal(ledger.byHolder[0].externalYen, 0);
});

test('FR-SETL-STMT-020 F2: 照合の合わない下書きは一括作成でも1件の確定でも確定版にせず、一覧で理由を出す（同じ権利者の後の期間も止める）', async (t) => {
  const f = await fixture({t});
  await f.create();
  // 元のデータの食い違い（アプリを通らない書き込み）: 「記録だけ」のイレギュラーを調整として報告した確定版
  const note = f.ok(await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'note', reason: '架空の記録'}));
  await f.db.run(`INSERT INTO royalty_statements(id,org_id,holder_partner_id,close_month,version_no,previous_statement_id,calculation_version,as_of,input_hash,calculation_json,
    royalty_yen,adjustment_yen,advance_recouped_yen,carried_in_yen,payable_yen,carried_out_yen,hold_count,line_count,created_by) VALUES(900,1,10,'2025-03',1,NULL,'royalty-cycle-v1','2025-05-01',?,'{}',0,777,0,0,777,0,0,1,1)`, ['h'.repeat(64)]);
  await f.db.run("INSERT INTO royalty_statement_lines(org_id,statement_id,line_no,line_kind,irregular_entry_id,amount_yen,created_by) VALUES(1,900,1,'adjustment',?,777,1)", [note.id]);
  const list = f.ok(await f.req('/royalty/periods?asOf=2025-10-15'));
  const june = list.periods.find((p) => p.closeMonth === '2025-06');
  const september = list.periods.find((p) => p.closeMonth === '2025-09');
  assert.equal(june.draft.checksOk, false);
  assert.match(june.blockedReason, /照合が合いません.*報告済みの調整の累計−台帳の調整の差額 777円/);
  assert.match(september.blockedReason, /前の期間（2025年6月締め）の照合が合わない/);
  assert.equal(list.creatable.count, 0, '照合の合わない期間は一括確定の対象にしない');
  assert.equal(list.blocked.count, 2);
  assert.ok(!list.periods.some(isCreatablePeriod));
  const generated = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-10-15', confirmed: true}));
  assert.equal(generated.created.length, 0);
  assert.match(generated.skipped.find((s) => s.key === '10:2025-06').reason, /照合が合いません/);
  assert.equal(generated.skipped.find((s) => s.key === '10:2025-06').checks[0].value, 777);
  assert.match(generated.skipped.find((s) => s.key === '10:2025-09').reason, /前の期間を作れなかった/);
  const preview = f.ok(await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-06&asOf=2025-10-15'));
  assert.equal(preview.canCreate, false, '報告書の画面の「確定する」も出さない');
  assert.match(preview.blockedReason, /照合が合いません/);
  const single = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-10-15', confirmed: true, keys: ['10:2025-06'], expectedHashes: {'10:2025-06': preview.inputHash}}));
  assert.equal(single.created.length, 0);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM royalty_statements')).n), 1);
});

test('FR-SETL-STMT-020 F2: 確定を止める理由の組み立て（照合の差額・後の期間）', () => {
  assert.equal(statementBlockReason({checks: [{item: 'a（差0）', value: 0}]}), null);
  assert.match(statementBlockReason({checks: [{item: '明細の和−当期の一覧（差0）', value: -1200}]}), /明細の和−当期の一覧の差額 -1,200円/);
  const bad = {checks: [{item: 'x', value: 5}]};
  const good = {checks: [{item: 'x', value: 0}]};
  const rows = [
    {holderId: 1, closeMonth: '2025-06', status: 'pending', draft: good}, {holderId: 1, closeMonth: '2025-03', status: 'overdue', draft: bad},
    {holderId: 2, closeMonth: '2025-03', status: 'overdue', draft: good}, {holderId: 1, closeMonth: '2025-09', status: 'open', draft: good},
  ];
  markBlockedPeriods(rows);
  assert.match(rows[1].blockedReason, /照合が合いません/);
  assert.match(rows[0].blockedReason, /前の期間（2025年3月締め）/);
  assert.equal(rows[2].blockedReason, undefined, '別の権利者は止めない');
  assert.equal(rows[3].blockedReason, undefined, '受付中の期間には付けない');
  assert.deepEqual(rows.filter(isCreatablePeriod).map((r) => r.holderId), [2]);
});

test('FR-SETL-STMT-033 FR-SETL-STMT-034 F3: 財務権限のない作品を含む権利者は、期間の一覧でも確定版の金額・版・支払を出さず、権利者全体の調整も出さない', async (t) => {
  const f = await fixture({t});
  await f.db.run("INSERT INTO projects(id,org_id,code,title,status) VALUES(3,1,'PRJ-RF-SECRET','架空の別案件','active')");
  await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,3,'WRK-RF-SECRET','架空の別作品')");
  await f.db.run("INSERT INTO products(id,org_id,sku,name,channel) VALUES(99,1,'SKU-RF-SECRET','架空の別作品の配信','digital')");
  await f.db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,99,3,10000)');
  const {agreementId} = await f.create();
  await f.create({workId: 3, agreementCode: 'RF-DIR-SECRET', title: '架空の別作品の監督料'});
  await f.sale('2025-01', 100000);
  await f.sale('2025-02', 5000000, {workId: 3, product: 99});
  f.ok(await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'adjust_amount', closeMonth: '2025-03', amountYen: 12345, reason: '権利者全体の精算（架空）'}));
  const made = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true}));
  assert.equal(made.created[0].payableYen, 510000 + 12345);
  f.ok(await f.req(`/royalty/statements/${made.created[0].statementId}/events`, {kind: 'paid', occurredOn: '2025-05-01', amountYen: 1000, reference: 'RF-PAY-1'}));
  const editor = await f.login('editor@openingnight.invalid');
  const periods = f.ok(await f.req('/royalty/periods?asOf=2025-05-01', null, editor));
  const march = periods.periods.find((p) => p.closeMonth === '2025-03');
  assert.equal(march.restricted, true);
  for (const field of ['royaltyYen', 'payableYen', 'adjustmentYen', 'carriedOutYen', 'holdCount', 'statementId', 'versionNo', 'reportedOn', 'paidYen', 'draft']) {
    assert.equal(march[field], null, `${field} を出さない`);
  }
  assert.equal(march.status, 'overdue', '状態と締め月は出す');
  const detail = f.ok(await f.req(`/royalty/agreements/${agreementId}`, null, editor));
  assert.ok(!detail.irregularEntries.some((row) => row.kind === 'adjust_amount'), '権利者全体の調整（金額・理由）を出さない');
  assert.equal(detail.ledgerTotals.paidYen, null);
  const ledger = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-06', null, editor));
  assert.equal(ledger.byHolder[0].adjustmentYen, 0);
  assert.ok(!ledger.irregular.some((row) => row.kind === 'adjust_amount'));
  assert.equal(ledger.byHolder[0].paidYen, null);
  assert.equal(ledger.byHolder[0].unpaidYen, null, '支払を読まないのに未払残を出さない');
  assert.equal(ledger.paymentScope, 'partial');
  // 全作品の権限がある人には今までどおり出す
  const adminPeriods = f.ok(await f.req('/royalty/periods?asOf=2025-05-01'));
  assert.equal(adminPeriods.periods.find((p) => p.closeMonth === '2025-03').payableYen, 510000 + 12345);
});

test('FR-SETL-STMT-030 F4: 報告済みの計上月の「保留を解く」「締め月の変更」は取り消せない（取消で保留に戻る・締め月が変わるため）', async (t) => {
  const f = await fixture({t});
  const {agreementId} = await f.create();
  await f.sale('2025-01', 100000);
  await f.sale('2025-02', 50000);
  await f.sale('2025-04', 200000);
  f.ok(await f.req('/royalty/irregular-entries', {agreementId, kind: 'hold', accrualMonth: '2025-01', reason: '照会中（架空）'}));
  const release = f.ok(await f.req('/royalty/irregular-entries', {agreementId, kind: 'release', accrualMonth: '2025-01', reason: '確認できた（架空）'}));
  const move = f.ok(await f.req('/royalty/irregular-entries', {agreementId, kind: 'move_period', accrualMonth: '2025-02', closeMonth: '2025-06', reason: '次の四半期へ（架空）'}));
  const q1 = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true}));
  assert.deepEqual(q1.created.map((c) => [c.closeMonth, c.payableYen]), [['2025-03', 10000]]);
  const reverseRelease = await f.req(`/royalty/irregular-entries/${release.id}/reverse`, {reason: '解除を取り消す（架空）'});
  assert.equal(reverseRelease.status, 409);
  assert.match(reverseRelease.data.error, /報告済み.*保留に戻る.*金額の調整/);
  // 締め月を変えた2月は6月締めで報告されるまでは取り消せる。報告後は取り消せない
  f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-08-01', confirmed: true}));
  const reverseMove = await f.req(`/royalty/irregular-entries/${move.id}/reverse`, {reason: '締め月の変更を取り消す（架空）'});
  assert.equal(reverseMove.status, 409);
  assert.match(reverseMove.data.error, /締め月が変わる/);
  const ledger = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-06'));
  assert.match(ledger.detail.find((d) => d.accrualMonth === '2025-01').status, /^報告済み/);
  const next = f.ok(await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-09&asOf=2025-10-15'));
  assert.ok(checksOk(next.statement.checks), JSON.stringify(next.statement.checks));
});

test('FR-SETL-STMT-030 F4: 取消の検査（報告済みでない月・効いていない記録は取り消せる）と、報告済みの月が保留になっても額は戻さず照合は合う（モデル）', () => {
  const entries = [
    {id: 1, kind: 'hold', agreementId: 1, accrualMonth: '2025-01', reason: 'x'}, {id: 2, kind: 'release', agreementId: 1, accrualMonth: '2025-01', reason: 'x'},
    {id: 3, kind: 'move_period', agreementId: 1, accrualMonth: '2025-02', closeMonth: '2025-04', reason: 'x'},
    {id: 4, kind: 'move_period', agreementId: 1, accrualMonth: '2025-02', closeMonth: '2025-05', reason: 'x'},
  ];
  const reported = new Map([['1:2025-01', '2025-01'], ['1:2025-02', '2025-05']]);
  assert.match(irregularReversalConflict({entry: entries[1], entries, reported}), /保留に戻る/);
  assert.equal(irregularReversalConflict({entry: entries[0], entries, reported}), null, '解除済みの保留の取消は状態を変えない');
  assert.equal(irregularReversalConflict({entry: entries[2], entries, reported}), null, '後の記録で上書きされた締め月の変更は取り消せる');
  assert.match(irregularReversalConflict({entry: entries[3], entries, reported}), /締め月が変わる/);
  assert.equal(irregularReversalConflict({entry: entries[1], entries, reported: new Map()}), null, '報告前は取り消せる');
  // アプリを通らずに保留へ戻った報告済みの月
  const a = A();
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [a], items: itemsOf(a, [['2025-01', 100000]])});
  const heldAgain = itemsOf(a, [['2025-01', 100000], ['2025-02', 50000]], [{id: 9, kind: 'hold', agreementId: 1, accrualMonth: '2025-01', reason: '再照会'}]);
  const feb = buildStatement({holder, closeMonth: '2025-02', agreements: [a], items: heldAgain, priorStatements: [asPrior(1, jan)]});
  assert.equal(feb.totals.royaltyYen, 5000, '報告済みの1月の額は戻さない');
  const hold = feb.holds.find((h) => h.accrualMonth === '2025-01');
  assert.equal(hold.alreadyReported, true);
  assert.equal(hold.reportedYen, 10000);
  assert.ok(checksOk(feb.checks), JSON.stringify(feb.checks));
  const ledger = buildLedger({agreements: [a], items: heldAgain, statements: [{id: 1, holderId: 7, closeMonth: '2025-01', lines: jan.lines, events: []}], from: '2025-01', to: '2025-02'});
  assert.match(ledger.detail.find((d) => d.accrualMonth === '2025-01').status, /保留（2025年1月締めで報告済みの額は戻していません）/);
  assert.equal(ledger.holds.length, 1);
});

test('FR-SETL-STMT-031 F5: 報告済みの計上月を計上無し・フェーズの期間外・別途協議（締め月未定）にするサイクルの版は足せない', async (t) => {
  const f = await fixture({t});
  const {agreementId} = await f.create();
  await f.sale('2025-01', 100000);
  await f.sale('2025-04', 200000);
  f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true}));
  const none = await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: '1〜3月は計上無し（架空）', phases: [
    f.phase({endsMonth: '2025-03', cycleKind: 'none', anchorMonth: null}), f.phase({startsMonth: '2025-04'})]});
  assert.equal(none.status, 409);
  assert.match(none.data.error, /2025年1月（2025年3月締めで報告済み）が「計上無し」/);
  const manual = await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: '別途協議に（架空）', phases: [f.phase({cycleKind: 'manual', anchorMonth: null})]});
  assert.equal(manual.status, 409);
  assert.match(manual.data.error, /別途協議/);
  const gap = await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: 'フェーズの切れ目（架空）', phases: [
    f.phase({startsMonth: '2024-12', endsMonth: '2024-12', cycleKind: 'monthly', anchorMonth: null}), f.phase({startsMonth: '2025-02'})]});
  assert.equal(gap.status, 409);
  assert.match(gap.data.error, /フェーズの期間外/);
  // 報告済みの月の締め月が変わるだけの版（四半期→半年）は足せる。報告済みの額はそのまま
  f.ok(await f.req(`/royalty/agreements/${agreementId}/schedules`, {reason: '半年に変更（架空）', phases: [f.phase({cycleKind: 'semiannual', anchorMonth: 6})]}));
  const june = f.ok(await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-06&asOf=2025-08-01'));
  assert.equal(june.statement.totals.royaltyYen, 20000);
  assert.ok(checksOk(june.statement.checks), JSON.stringify(june.statement.checks));
});

test('FR-SETL-STMT-016 FR-SETL-STMT-031 F5: 報告済みなのに発生額の行が無くなった計上月は、報告済みの額を戻す行を出して照合を合わせる（モデル）', () => {
  const a = A();
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [a], items: itemsOf(a, [['2025-01', 100000]])});
  // 表を直接書き換えて1月を計上無しにした（または1月の売上報告を取り消した）
  const none = {...a, schedule: {statementsFrom: null, phases: [P('none', {endsMonth: '2025-01'}), P('monthly', {id: 2, startsMonth: '2025-02'})]}};
  const items = itemsOf(none, [['2025-01', 100000], ['2025-02', 30000]]);
  assert.ok(!items.some((i) => i.accrualMonth === '2025-01'));
  const feb = buildStatement({holder, closeMonth: '2025-02', agreements: [none], items, priorStatements: [asPrior(1, jan)]});
  const back = feb.lines.find((line) => line.accrualMonth === '2025-01');
  assert.equal(back.lineKind, 'revision');
  assert.equal(back.amountYen, -10000);
  assert.match(back.note, /発生額が無くなった/);
  assert.equal(feb.totals.royaltyYen, 3000 - 10000);
  assert.ok(checksOk(feb.checks), JSON.stringify(feb.checks));
  // サイクルの版を足す前の検査（API と同じ関数）
  const statements = [{id: 1, closeMonth: '2025-01', lines: jan.lines}];
  assert.deepEqual([...reportedMonths(statements)], [['1:2025-01', '2025-01']]);
  assert.equal(scheduleConflicts({agreement: a, schedule: {statementsFrom: null, phases: none.schedule.phases}, statements}).length, 1);
  assert.equal(scheduleConflicts({agreement: a, schedule: {statementsFrom: '2025-01', phases: [P('quarterly', {anchorMonth: 3})]}, statements}).length, 0);
});

test('FR-SETL-STMT-017 F6: 移行前に充当した前払金は、集計シートの未払残からも除く', async (t) => {
  const f = await fixture({t});
  await f.create({term: f.term({advanceYen: 10000}), schedule: {statementsFrom: '2025-06', phases: [f.phase()]}});
  await f.sale('2025-01', 150000); // 15,000（以前の仕組みで処理済み: 充当10,000・支払5,000）
  await f.sale('2025-04', 50000); // 5,000
  const made = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-08-01', confirmed: true}));
  assert.deepEqual(made.created.map((c) => [c.closeMonth, c.payableYen]), [['2025-06', 5000]]);
  f.ok(await f.req(`/royalty/statements/${made.created[0].statementId}/events`, {kind: 'paid', occurredOn: '2025-08-01', amountYen: 5000, reference: 'RF-PAY-6'}));
  const row = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-08')).byHolder[0];
  assert.equal(row.cumulativeYen, 20000);
  assert.equal(row.externalYen, 15000, '以前の仕組みの分は、外で充当した分も外で支払った分も除く');
  assert.equal(row.recoupYen, 0, 'この仕組みでは充当していない');
  assert.equal(row.unpaidYen, 0);
});

test('FR-SETL-STMT-034 F7: 作品・種別で絞った集計シートは、権利者全体の支払累計・未払残を出さず、権利者全体の調整も入れない', async (t) => {
  const f = await fixture({t});
  await f.addWork(4, '架空の作品B');
  await f.create();
  await f.create({workId: 4, agreementCode: 'RF-DIR-B', title: '架空の作品Bの監督料'});
  await f.sale('2025-01', 100000);
  await f.sale('2025-02', 1000000, {workId: 4, product: 4});
  f.ok(await f.req('/royalty/irregular-entries', {holderPartnerId: 10, kind: 'adjust_amount', closeMonth: '2025-03', amountYen: -500, reason: '振込手数料（架空）'}));
  const made = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-05-01', confirmed: true}));
  f.ok(await f.req(`/royalty/statements/${made.created[0].statementId}/events`, {kind: 'paid', occurredOn: '2025-05-01', amountYen: 109500, reference: 'RF-PAY-7'}));
  const all = f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-06'));
  assert.deepEqual([all.byHolder[0].cumulativeYen, all.byHolder[0].adjustmentYen, all.byHolder[0].paidYen, all.byHolder[0].unpaidYen], [110000, -500, 109500, 0]);
  assert.equal(all.paymentScope, 'all');
  for (const query of ['workId=1', 'workId=4', 'category=director']) {
    const narrowed = f.ok(await f.req(`/royalty/ledger?from=2025-01&to=2025-06&${query}`));
    const row = narrowed.byHolder[0];
    assert.equal(narrowed.paymentScope, 'none', query);
    assert.equal(row.paidYen, null, query);
    assert.equal(row.unpaidYen, null, `${query} 絞り込んだ累計から権利者全体の支払を引かない`);
    assert.equal(row.adjustmentYen, 0, `${query} 権利者全体の調整は絞込の契約に入れない`);
    assert.equal(narrowed.totals.unpaidYen, null);
    assert.ok(narrowed.notes.some((note) => /絞り込んだ表では、支払累計・報告済み・未払残を出していません/.test(note)));
    assert.ok(narrowed.checks.every((c) => c.value === 0));
  }
  assert.equal(f.ok(await f.req('/royalty/ledger?from=2025-01&to=2025-06&holderId=10')).byHolder[0].unpaidYen, 0, '権利者だけの絞込は権利者全体なので出す');
  assert.ok(!ledgerHolderTail('none').some((c) => ['paidYen', 'unpaidYen', 'reportedYen'].includes(c.key)), '画面でも列を出さない');
  assert.ok(ledgerHolderTail('all').some((c) => c.key === 'unpaidYen'));
});

test('FR-SETL-STMT-022 F8: UTF-8 での分割（文字の途中で切らない）と、明細のまとまりの大きさ', () => {
  const text = `${'あ'.repeat(50)}𠮷${'x'.repeat(20)}`;
  const parts = splitUtf8(text, 16);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => utf8Bytes(part) <= 16 && !part.includes('�')));
  const rows = Array.from({length: 300}, (_, index) => [index + 1, 'accrual', 1, '2025-01', 11, null, 1000, 0, 0, 0, 1000, 1000, 100, '締め月の変更（元は2025年3月締め）']);
  const chunks = chunkRows(rows, 4096);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => utf8Bytes(chunk) <= 4096));
  assert.deepEqual(chunks.flatMap((chunk) => JSON.parse(chunk)), rows);
});

// クラウドの試験。2026-10-03（香盤表 #11 の PR6）に D1 の binding を node:sqlite で模す形で royalty-review-fixes-sqlite.test.mjs へ分けたが、
// 2026-10-04 に R2 の層をどの入口にもかぶせられるようにしたので、試験の DB の入口にかぶせて両方の DB で流す形に戻した。R2 は Map
class MemoryBucket {
  constructor() { this.values = new Map(); }
  async head(key) { return this.values.has(key) ? {size: this.values.get(key).byteLength} : null; }
  async put(key, value) { this.values.set(key, new Uint8Array(value)); return {key}; }
  async get(key) { const value = this.values.get(key); return value ? {body: true, arrayBuffer: async () => value.buffer} : null; }
}

test('FR-SETL-STMT-022 FR-SETL-STMT-023 FR-CORE-DATA-008 F8: 明細480行（1権利者80契約）の報告書も、クラウド（R2 の層をかぶせた入口。D1 と同じ batch 500文・1つの値128KB）で確定でき、計算の内容を読み戻せる', async (t) => {
  const f = await fixture({t});
  const N = 80;
  for (let k = 0; k < N; k += 1) await f.db.run('INSERT INTO works(id,org_id,project_id,code,title) VALUES(?,1,1,?,?)', [1000 + k, `WRK-RFM${k}`, `架空作品M${k}`]);
  await f.db.run("INSERT INTO products(id,org_id,sku,name,channel) VALUES(97,1,'SKU-RFM','架空の配信（80作品に配賦）','digital')");
  for (let k = 0; k < N; k += 1) await f.db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,97,?,125)', [1000 + k]);
  for (let k = 0; k < N; k += 1) {
    await f.create({workId: 1000 + k, holderPartnerId: 11, category: 'music', agreementCode: `RF-MUS-${k}`, title: `架空の音楽著作権料 ${k}`,
      schedule: {phases: [f.phase({cycleKind: 'semiannual', anchorMonth: 6})]}});
  }
  for (const month of ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']) await f.sale(month, 8000000, {workId: 1000, product: 97});
  // 試験の DB の入口（SQLite は LocalDatabase、PostgreSQL は PgDatabase）に R2 の層をかぶせ、本番の D1 と同じ上限（1回の batch 500文・1つの値128KB）で断る
  const cloud = new R2LargeValueDatabase(f.db, new MemoryBucket(), {maxBatchStatements: 500});
  const worker = createApp({db: cloud, mode: 'worker', authenticate: async () => identityForEmail(f.db, 'admin@openingnight.invalid', '')});
  const call = async (path, payload) => {
    const response = await worker.request(`/api${path}`, {method: payload ? 'POST' : 'GET', headers: {'content-type': 'application/json'}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const made = await call('/royalty/statements/generate', {asOf: '2025-08-01', confirmed: true, keys: ['11:2025-06']});
  assert.equal(made.status, 201, JSON.stringify(made.data.skipped));
  assert.deepEqual(made.data.skipped, []);
  const id = made.data.created[0].statementId;
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM royalty_statement_lines WHERE statement_id=?', [id])).n), 480);
  assert.ok(Number((await f.db.get('SELECT COUNT(*) AS n FROM royalty_statement_calculation_parts WHERE statement_id=?', [id])).n) >= 2, '計算の内容は128KBを超えるので分割して保存');
  const detail = await call(`/royalty/statements/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.calculation.lines.length, 480);
  assert.equal(detail.data.calculation.rows.length, 80);
  assert.equal(detail.data.calculation.statementId, id);
  assert.ok(checksOk(detail.data.calculation.checks));
  // 包みを通さない入口でも同じ形で保存・読み戻しできる
  const local = f.ok(await f.req(`/royalty/statements/${id}`));
  assert.equal(local.calculation.lines.length, 480);
  await assert.rejects(f.db.run("INSERT INTO royalty_statement_calculation_parts(org_id,statement_id,part_no,body,created_by) VALUES(1,?,1,'x',1)", [id]), /分割/);
});

test('F9: 一括作成の問い合わせ数は権利者・作品の数に比例して増えず、1回に作る通数に上限がある（残りは続けて作る）', async (t) => {
  const f = await fixture({t});
  for (let w = 0; w < 12; w += 1) await f.addWork(200 + w, `架空作品W${w}`);
  for (let h = 0; h < 12; h += 1) await f.db.run('INSERT INTO partners(id,org_id,code,name,kind) VALUES(?,1,?,?,?)', [300 + h, `PT-RF${h}`, `架空の権利者${h}`, 'other']);
  for (let h = 0; h < 12; h += 1) {
    for (let k = 0; k < 3; k += 1) {
      await f.create({workId: 200 + ((h + k) % 12), holderPartnerId: 300 + h, agreementCode: `RF-H${h}-${k}`, title: `架空の契約 ${h}-${k}`});
    }
  }
  for (let w = 0; w < 12; w += 1) await f.sale('2025-02', 100000 * (w + 1), {workId: 200 + w, product: 200 + w});
  const counts = {calls: 0, batchStatements: 0};
  for (const name of ['all', 'get', 'run', 'batch']) {
    const original = f.db[name].bind(f.db);
    f.db[name] = async (...args) => { counts.calls += 1; if (name === 'batch') counts.batchStatements += args[0].length; return original(...args); };
  }
  const made = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-08-15', confirmed: true}));
  assert.equal(made.created.length, 24, '12者×2期間（3月締め・6月締め）');
  const reads = counts.calls - made.created.length;
  assert.ok(reads <= 60, `読み込みの問い合わせ ${reads} 回（権利者ごとに読み直さない）`);
  assert.ok(counts.calls - made.created.length + counts.batchStatements < 1000, 'batch の文も数えて1,000回未満');
  // 同じ規則（作品の案件の財務権限）で、作品数によらない問い合わせで財務権限の作品を決める
  const ctx = f.app.ux;
  for (const email of ['admin@openingnight.invalid', 'editor@openingnight.invalid']) {
    const identity = await identityForEmail(f.db, email, '');
    assert.deepEqual([...await financeWorkIds(f.db, identity, ctx)].sort(), [...await financeWorkIds(f.db, identity, ctx.settlementWork)].sort(), email);
  }
});

test('FR-SETL-STMT-021 F9: 1回に作るのは上限まで。残りは remaining で返し、もう一度押すと続きから作る', async (t) => {
  const f = await fixture({t});
  await f.create({term: f.term({effectiveFrom: '2016-01'}), schedule: {phases: [f.phase({startsMonth: '2016-01', cycleKind: 'monthly', anchorMonth: null})]}});
  await f.sale('2016-03', 100000);
  const list = f.ok(await f.req('/royalty/periods?asOf=2025-06-15'));
  assert.equal(list.generateLimit, GENERATE_LIMIT);
  const total = list.creatable.count;
  assert.ok(total > GENERATE_LIMIT, `${total}`);
  const first = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-06-15', confirmed: true}));
  assert.equal(first.created.length, GENERATE_LIMIT);
  assert.equal(first.remaining.count, total - GENERATE_LIMIT);
  assert.deepEqual(first.skipped, []);
  const second = f.ok(await f.req('/royalty/statements/generate', {asOf: '2025-06-15', confirmed: true}));
  assert.equal(second.created.length, total - GENERATE_LIMIT);
  assert.equal(second.remaining.count, 0);
  assert.equal(f.ok(await f.req('/royalty/periods?asOf=2025-06-15')).creatable.count, 0);
});

test('F11: 一覧の「保留」は締め月時点の未解決の件数で、期間をまたいで合計しない', () => {
  assert.equal(HOLD_COUNT_COLUMN.key, 'holdCount');
  assert.equal(HOLD_COUNT_COLUMN.total, 'none');
  assert.match(HOLD_COUNT_COLUMN.label, /締め月時点/);
  for (const page of ['RoyaltyPeriodsPage.jsx', 'RoyaltyStatementsPage.jsx']) {
    const source = readFileSync(new URL(`../src/royalty/${page}`, import.meta.url), 'utf8');
    assert.ok(source.includes('HOLD_COUNT_COLUMN'), page);
    assert.doesNotMatch(source, /key: 'holdCount'[^}]*total: 'sum'/, `${page} で保留の件数を合計しない`);
  }
});
