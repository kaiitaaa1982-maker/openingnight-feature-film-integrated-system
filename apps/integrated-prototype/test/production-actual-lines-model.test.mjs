// 制作の実費の行の純関数（src/expenses/production-actual/actual-lines-model.mjs）を DB なしで確かめる。
// 期待値は要件 docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-009・015・033・043〜046 と brain の D-047 の3・7 から持ってくる。
// 合計の期待値は試験の中で手で足した数。架空の値だけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {actualLinesAccess, actualTotals, humanLineErrors, buildActualLinesView, currentActualLines, normalizeActualLineInput, normalizeActualLinesQuery,
  normalizeCheckInput, planActualLineChecks} from '../src/expenses/production-actual/actual-lines-model.mjs';
import {sumYen} from '../src/expenses/production-actual/money-actual.mjs';

// 表の行の形（production_actual_lines）
let nextId = 0;
const row = (v = {}) => ({id: v.id ?? ++nextId, entry_key: `fict-${nextId}`, spent_on: v.spentOn ?? '2026-01-10', category_code: v.category ?? 'D',
  payee_partner_id: v.partnerId ?? null, payee_name: v.payee ?? '架空店', description: null, inc_tax_yen: v.inc, ex_tax_yen: v.ex ?? null, tax_yen: v.tax ?? null,
  source_document_id: null, shooting_day_id: v.day ?? null, entry_method: 'human', ai_read_json: null, created_by: 1, created_at: '2026-01-10 00:00:00'});

test('FR-EXP-PCOST-043 FR-EXP-PCOST-010 いまの行は取消の無い行で、確認の行が無い行に未確認の印が付き、置き換えの行は元の行を指す', () => {
  const lines = [row({id: 1, inc: 1100, ex: 1000, tax: 100}), row({id: 2, inc: 2200, ex: 2000, tax: 200}), row({id: 3, inc: 3300, ex: 3000, tax: 300})];
  const current = currentActualLines({lines, voids: [{line_id: 2, replacement_line_id: 3}], checks: [{line_id: 1, checked_by: 1, checked_at: '2026-01-11 09:00:00'}]});
  assert.deepEqual(current.map((l) => [l.id, l.unconfirmed, l.check, l.replaces]),
    [[1, false, {checkedBy: 1, checkedAt: '2026-01-11 09:00:00'}, null], [3, true, null, 2]]);
});

test('FR-EXP-PCOST-046 FR-EXP-PCOST-015 FR-EXP-PCOST-043 合計は税込を全行で、税抜・税額を分かる行だけで足し、税抜が不明の行を件数と税込で分け、確認済み・未確認に分ける。日別・支払先別・費目別の和は全体と一致する', () => {
  const lines = currentActualLines({lines: [
    row({id: 11, spentOn: '2026-01-10', category: 'D', partnerId: 1, payee: '架空シネマ', inc: 11000, ex: 10000, tax: 1000}),
    row({id: 12, spentOn: '2026-01-10', category: 'H', payee: '架空弁当店', inc: 5400, ex: 5000, tax: 400}),
    row({id: 13, spentOn: '2026-01-11', category: 'H', payee: '架空弁当店', inc: 3240}),
    row({id: 14, spentOn: '2026-01-11', category: 'F', partnerId: 1, payee: '架空シネマ（別の書き方）', inc: 1, ex: 1, tax: 0}),
  ], voids: [], checks: [{line_id: 11, checked_by: 1, checked_at: 'x'}, {line_id: 13, checked_by: 1, checked_at: 'x'}]});
  const totals = actualTotals(lines);
  assert.deepEqual(totals.all, {count: 4, incTaxYen: 19641, exTaxYen: 15001, taxYen: 1400, exTaxUnknownCount: 1, exTaxUnknownIncTaxYen: 3240});
  assert.deepEqual(totals.confirmed, {count: 2, incTaxYen: 14240, exTaxYen: 10000, taxYen: 1000, exTaxUnknownCount: 1, exTaxUnknownIncTaxYen: 3240});
  assert.deepEqual(totals.unconfirmed, {count: 2, incTaxYen: 5401, exTaxYen: 5001, taxYen: 400, exTaxUnknownCount: 0, exTaxUnknownIncTaxYen: 0});
  // 税込＝（分かる行の税抜＋税額）＋不明の行の税込
  assert.equal(totals.all.incTaxYen, totals.all.exTaxYen + totals.all.taxYen + totals.all.exTaxUnknownIncTaxYen);
  // 支払先は取引先の ID で1組（領収書の名前が違っても）、ID が無ければ名前で1組
  assert.deepEqual(totals.byPayee.map((g) => [g.payeePartnerId, g.payeeName, g.payeeNames, g.all.incTaxYen]),
    [[1, null, ['架空シネマ', '架空シネマ（別の書き方）'], 11001], [null, '架空弁当店', ['架空弁当店'], 8640]]);
  assert.deepEqual(totals.byDay.map((g) => [g.spentOn, g.all.incTaxYen, g.confirmed.incTaxYen]), [['2026-01-10', 16400, 11000], ['2026-01-11', 3241, 3240]]);
  assert.deepEqual(totals.byCategory.map((g) => [g.categoryCode, g.all.incTaxYen, g.all.exTaxUnknownCount]), [['D', 11000, 0], ['F', 1, 0], ['H', 8640, 1]]);
  for (const key of ['byDay', 'byPayee', 'byCategory']) {
    for (const part of ['all', 'confirmed', 'unconfirmed']) {
      for (const field of Object.keys(totals.all)) {
        assert.equal(sumYen(totals[key].map((g) => g[part][field])), totals[part][field], `${key}.${part}.${field}`);
      }
    }
  }
  // 行が無ければ合計は0で、組は無い
  assert.deepEqual(actualTotals([]).all, {count: 0, incTaxYen: 0, exTaxYen: 0, taxYen: 0, exTaxUnknownCount: 0, exTaxUnknownIncTaxYen: 0});
});

test('FR-EXP-PCOST-046 合計が安全な整数を超えたら黙って丸めずに止める', () => {
  assert.throws(() => sumYen([Number.MAX_SAFE_INTEGER, 1]), /安全な整数を超えました/);
  assert.throws(() => sumYen([1.5]), /整数の円ではありません/);
});

test('FR-EXP-PCOST-046 今日の合計と作品の累計は絞り込みに依らず、絞り込みは日付の両端と撮影日を含む', () => {
  const lines = [row({id: 21, spentOn: '2026-01-10', inc: 100, ex: 100, tax: 0}), row({id: 22, spentOn: '2026-01-11', inc: 200, ex: 200, tax: 0, day: 5}),
    row({id: 23, spentOn: '2026-01-12', inc: 400})];
  const view = buildActualLinesView({lines, today: '2026-01-12', filter: {from: '2026-01-11', to: '2026-01-11', shootingDayId: null}});
  assert.deepEqual([view.lines.map((l) => l.id), view.totals.all.incTaxYen, view.todayTotal.all.incTaxYen, view.cumulative.all.incTaxYen, view.unconfirmedCount],
    [[22], 200, 400, 700, 1]);
  assert.deepEqual(buildActualLinesView({lines, today: '2026-01-12', filter: {shootingDayId: 5}}).lines.map((l) => l.id), [22]);
  assert.throws(() => buildActualLinesView({lines, today: null}), /今日の日付/);
  assert.deepEqual(normalizeActualLinesQuery({from: '2026-01-11', to: '2026-01-10'}).errors.map((e) => e.field), ['to']);
  assert.deepEqual(normalizeActualLinesQuery({shootingDayId: 'x'}).errors.map((e) => e.field), ['shootingDayId']);
});

test('FR-EXP-PCOST-033 FR-EXP-PCOST-015 行の入力は日付・費目 A〜K・領収書の名前・税込を必須にし、税抜と税額は2つそろえて税込と一致させるか、2つとも空（不明）にする', () => {
  const base = {spentOn: '2026-01-10', categoryCode: 'K', payeeName: '架空店', incTaxYen: 1100, entryMethod: 'human'};
  const ok = normalizeActualLineInput(base);
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.value.exTaxYen, ok.value.taxYen, ok.value.aiReadJson, ok.value.entryKey], [null, null, null, null]);
  assert.equal(normalizeActualLineInput({...base, exTaxYen: 1000, taxYen: 100}).ok, true);
  assert.equal(normalizeActualLineInput({...base, exTaxYen: 1100, taxYen: 0}).ok, true);
  const fields = (raw) => normalizeActualLineInput(raw).errors.map((e) => e.field);
  assert.deepEqual(fields({}), ['spentOn', 'categoryCode', 'payeeName', 'incTaxYen', 'entryMethod']);
  assert.deepEqual(fields([]), ['line', 'spentOn', 'categoryCode', 'payeeName', 'incTaxYen', 'entryMethod']);
  assert.deepEqual(fields({...base, categoryCode: 'L'}), ['categoryCode']);
  assert.deepEqual(fields({...base, spentOn: '2026-02-30'}), ['spentOn']);
  assert.deepEqual(fields({...base, exTaxYen: 1000}), ['taxYen']);
  assert.deepEqual(fields({...base, taxYen: 100}), ['exTaxYen']);
  assert.deepEqual(fields({...base, exTaxYen: 1000, taxYen: 99}), ['incTaxYen']);
  // いまは正の整数の円だけ（0円・負の額・小数は受けない）
  assert.deepEqual(fields({...base, incTaxYen: 0}), ['incTaxYen']);
  assert.deepEqual(fields({...base, incTaxYen: -1100}), ['incTaxYen']);
  assert.deepEqual(fields({...base, incTaxYen: 1100.5}), ['incTaxYen']);
  assert.deepEqual(fields({...base, incTaxYen: '1100'}), ['incTaxYen']);
  assert.deepEqual(fields({...base, payeeName: 'あ'.repeat(201)}), ['payeeName']);
  assert.deepEqual(fields({...base, entryKey: 'あ'}), ['entryKey']);
});

test('FR-EXP-PCOST-045 AI の読みの記録は model・readFields・unreadFields だけを持ち、欄の名前は行の欄から選び、読めなかった欄は空・読んだ欄は値があることを行と照らす', () => {
  const base = {spentOn: '2026-01-10', categoryCode: 'H', payeeName: '架空弁当店', incTaxYen: 3240, entryMethod: 'ai'};
  const read = ['spentOn', 'categoryCode', 'payeeName', 'incTaxYen'];
  const ok = normalizeActualLineInput({...base, aiRead: {model: 'fict-reader-1', readFields: [...read].reverse(), unreadFields: ['taxYen', 'exTaxYen']}});
  assert.equal(ok.ok, true);
  // 欄は行の欄の順にそろえて保存する
  assert.equal(ok.value.aiReadJson, JSON.stringify({model: 'fict-reader-1', readFields: read, unreadFields: ['exTaxYen', 'taxYen']}));
  const fields = (aiRead) => normalizeActualLineInput({...base, aiRead}).errors.map((e) => e.field);
  assert.deepEqual(fields(undefined), ['aiRead']);
  assert.deepEqual(fields({model: 'fict-reader-1', readFields: read, unreadFields: [], body: '本文'}), ['aiRead']);
  assert.deepEqual(fields({model: '読んだ人', readFields: read, unreadFields: []}), ['aiRead.model']);
  assert.deepEqual(fields({model: 'fict-reader-1', readFields: ['spentOn', 'total'], unreadFields: []}), ['aiRead.readFields']);
  assert.deepEqual(fields({model: 'fict-reader-1', readFields: ['spentOn', 'spentOn'], unreadFields: []}), ['aiRead.readFields']);
  assert.deepEqual(fields({model: 'fict-reader-1', readFields: read, unreadFields: ['incTaxYen']}), ['aiRead', 'aiRead.unreadFields']);
  assert.deepEqual(fields({model: 'fict-reader-1', readFields: [...read, 'exTaxYen'], unreadFields: []}), ['aiRead.readFields']);
  assert.deepEqual(normalizeActualLineInput({...base, entryMethod: 'human', aiRead: {model: 'x', readFields: [], unreadFields: []}}).errors.map((e) => e.field), ['aiRead']);
});

test('FR-EXP-PCOST-044 まとめて確認は、作品の行を 確かめる・取消済み・確認済み・作品に無い に分け、番号の重なりは1つにする', () => {
  const lines = [row({id: 31, inc: 1}), row({id: 32, inc: 1}), row({id: 33, inc: 1})];
  const input = normalizeCheckInput({lineIds: [31, 32, 33, 34, 31]});
  assert.deepEqual(input.value.lineIds, [31, 32, 33, 34]);
  assert.deepEqual(planActualLineChecks({lineIds: input.value.lineIds, lines, voids: [{line_id: 32}], checks: [{line_id: 33}]}),
    {toCheck: [31], voided: [32], alreadyChecked: [33], missing: [34]});
  assert.equal(normalizeCheckInput({lineIds: []}).ok, false);
  assert.equal(normalizeCheckInput({lineIds: Array.from({length: 201}, (_, i) => i + 1)}).ok, false);
  assert.equal(normalizeCheckInput({lineIds: ['31']}).ok, false);
});

test('FR-EXP-PCOST-009 読めるのは管理者と財務の権限のある編集担当で、書けるのはいまは管理者だけ。制作担当は読めない', () => {
  assert.deepEqual(actualLinesAccess({role: 'admin'}), {read: true, write: true, humanLines: true, check: true});
  assert.deepEqual(actualLinesAccess({role: 'admin', via: 'access'}), {read: true, write: true, humanLines: true, check: true});
  assert.deepEqual(actualLinesAccess({role: 'editor', financeProject: true}), {read: true, write: false, humanLines: false, check: false});
  assert.deepEqual(actualLinesAccess({role: 'editor', financeProject: false}), {read: false, write: false, humanLines: false, check: false});
  assert.deepEqual(actualLinesAccess({role: 'production', financeProject: true}), {read: false, write: false, humanLines: false, check: false});
});

test('FR-EXP-PCOST-047 サービストークン（AI）の呼び出しは、読む・書くはそのままに、人の行を足せず確かめられない。人の行には位置つきの理由を返す', () => {
  const access = actualLinesAccess({role: 'admin', via: 'service_token'});
  assert.deepEqual(access, {read: true, write: true, humanLines: false, check: false});
  const lines = [{entryMethod: 'ai'}, {entryMethod: 'human'}, {entryMethod: 'ai'}, {entryMethod: 'human'}];
  assert.deepEqual(humanLineErrors(lines, access).map((e) => [e.line, e.field]), [[1, 'entryMethod'], [3, 'entryMethod']]);
  assert.deepEqual(humanLineErrors(lines, actualLinesAccess({role: 'admin'})), []);
});
