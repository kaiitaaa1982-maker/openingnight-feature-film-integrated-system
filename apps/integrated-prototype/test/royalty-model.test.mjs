import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeMonthFor, dueDate, phaseFor, termFor, cycleText, dueText, presetOfPhase, CYCLE_PRESETS, DUE_PRESETS, addMonths, monthsBetween, lastDayOf,
  percentToBps, bpsToPercent, signedRateAmount, normalizeTermInput, normalizeScheduleInput, parseCloseList,
  accrueAgreement, resolveItems, enumerateClosings, holderClosings, buildStatement, periodRows, simulateDrafts, statementStatus, eventState,
  buildLedger, effectiveEntries, holdStates, checksOk, isHeldItem,
} from '../src/royalty/royalty-model.mjs';

const phase = (cycleKind, extra = {}) => ({id: extra.id ?? 1, startsMonth: '2020-01', endsMonth: null, cycleKind, anchorMonth: null, customCloseMonths: null,
  firstCloseImmediate: false, reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', ...extra});
const term = (extra = {}) => ({id: 11, versionNo: 1, effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1000, windowFeeBps: null,
  fixedAmountYen: null, advanceYen: 0, minPaymentYen: null, channels: [], expenseCategories: [], ...extra});
const agreement = (extra = {}) => ({id: 1, code: 'AG-1', title: '架空の監督料', workId: 1, workTitle: '架空作品', holderId: 7, holderName: '架空監督', category: 'director',
  terms: [term()], schedule: {id: 1, versionNo: 1, statementsFrom: null, phases: [phase('monthly')]}, ...extra});
const sale = (accountingMonth, amount, channelGroup = 'digital') => ({accountingMonth, amount, channelGroup});

test('月の計算: 年をまたぐ加算・範囲・月末', () => {
  assert.equal(addMonths('2025-12', 1), '2026-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2025-11', 14), '2027-01');
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(lastDayOf('2024-02'), 29);
  assert.equal(lastDayOf('2025-02'), 28);
  assert.equal(lastDayOf('2025-12'), 31);
});

test('FR-SETL-STMT-003 締め月: 毎月・四半期（3月基準）・年をまたぐ12月→1月', () => {
  const monthly = phase('monthly');
  assert.equal(closeMonthFor('2025-12', monthly), '2025-12');
  const q = phase('quarterly', {anchorMonth: 3});
  assert.equal(closeMonthFor('2025-01', q), '2025-03');
  assert.equal(closeMonthFor('2025-03', q), '2025-03');
  assert.equal(closeMonthFor('2025-11', q), '2025-12');
  assert.equal(closeMonthFor('2025-12', q), '2025-12', '12月の計上は12月締め');
  assert.equal(closeMonthFor('2026-01', q), '2026-03', '1月の計上は翌年3月締め（年をまたぐ）');
  const q1 = phase('quarterly', {anchorMonth: 1});
  assert.deepEqual(['2025-11', '2025-12', '2026-01', '2026-02'].map((m) => closeMonthFor(m, q1)), ['2026-01', '2026-01', '2026-01', '2026-04']);
});

test('FR-SETL-STMT-003 締め月: 半年（6・12月）と1年（12月・6月末・3月末）', () => {
  const half = phase('semiannual', {anchorMonth: 6});
  assert.deepEqual(['2025-01', '2025-06', '2025-07', '2025-12', '2026-01'].map((m) => closeMonthFor(m, half)), ['2025-06', '2025-06', '2025-12', '2025-12', '2026-06']);
  const y12 = phase('annual', {anchorMonth: 12});
  assert.deepEqual(['2025-01', '2025-12', '2026-01'].map((m) => closeMonthFor(m, y12)), ['2025-12', '2025-12', '2026-12']);
  const y6 = phase('annual', {anchorMonth: 6});
  assert.deepEqual(['2025-06', '2025-07', '2025-12', '2026-01', '2026-06'].map((m) => closeMonthFor(m, y6)), ['2025-06', '2026-06', '2026-06', '2026-06', '2026-06']);
  const y3 = phase('annual', {anchorMonth: 3});
  assert.deepEqual(['2025-03', '2025-04', '2025-12', '2026-01', '2026-03'].map((m) => closeMonthFor(m, y3)), ['2025-03', '2026-03', '2026-03', '2026-03', '2026-03']);
});

test('FR-SETL-STMT-003 FR-SETL-STMT-006 締め月: 特殊（列挙）・初月即締・別途協議・計上無し', () => {
  const custom = phase('custom', {customCloseMonths: '2025-12, 2025-06,2026-09'});
  assert.deepEqual(['2025-01', '2025-06', '2025-07', '2026-02', '2026-10'].map((m) => closeMonthFor(m, custom)), ['2025-06', '2025-06', '2025-12', '2026-09', null]);
  const first = phase('quarterly', {anchorMonth: 3, startsMonth: '2025-02', firstCloseImmediate: true});
  assert.deepEqual(['2025-02', '2025-03', '2025-04'].map((m) => closeMonthFor(m, first)), ['2025-02', '2025-03', '2025-06'], '開始月だけ開始月で締め、その後は四半期');
  const firstCustom = phase('custom', {startsMonth: '2025-02', customCloseMonths: '2025-12', firstCloseImmediate: true});
  assert.equal(closeMonthFor('2025-02', firstCustom), '2025-02');
  assert.equal(closeMonthFor('2025-03', firstCustom), '2025-12');
  assert.equal(closeMonthFor('2025-05', phase('manual')), null);
  assert.equal(closeMonthFor('2025-05', phase('none')), null);
  assert.equal(closeMonthFor('2025-05', null), null);
  assert.deepEqual(parseCloseList('2025-06、2025-06 2025-13').invalid, ['2025-13']);
});

test('FR-SETL-STMT-005 報告期限・支払期限: 月末・日付指定（月末を超える日は月末）・年をまたぐ', () => {
  assert.equal(dueDate('2025-12', 1, 'eom'), '2026-01-31');
  assert.equal(dueDate('2025-12', 2, 'eom'), '2026-02-28');
  assert.equal(dueDate('2023-12', 2, 'eom'), '2024-02-29', 'うるう年');
  assert.equal(dueDate('2025-01', 1, '31'), '2025-02-28', '31日指定は月末に丸める');
  assert.equal(dueDate('2025-06', 3, '15'), '2025-09-15');
  assert.equal(dueDate('2025-06', 0, 'eom'), '2025-06-30');
  assert.equal(dueText(1, 'eom'), '翌月末');
  assert.equal(dueText(3, 'eom'), '翌々々月末');
  assert.equal(dueText(2, '20'), '締め月の2か月後の20日');
  assert.deepEqual(DUE_PRESETS.map((p) => p.label), ['翌月末', '翌々月末', '翌々々月末', '日付指定']);
});

test('FR-SETL-STMT-007 サイクルのプリセットと表示', () => {
  assert.equal(CYCLE_PRESETS.length, 9);
  assert.equal(presetOfPhase(phase('annual', {anchorMonth: 6})), 'annual-6');
  assert.equal(cycleText(phase('annual', {anchorMonth: 6})), '1年（6月末締め）');
  assert.equal(cycleText(phase('quarterly', {anchorMonth: 1})), '四半期（1・4・7・10月締め）');
  assert.equal(cycleText(phase('semiannual', {anchorMonth: 6, firstCloseImmediate: true})), '半年（6・12月締め）・初月即締');
  assert.match(cycleText(phase('custom', {customCloseMonths: '2025-06,2025-12'})), /特殊.*2025年6月、2025年12月/);
  assert.equal(cycleText(null), 'サイクル未登録');
});

test('FR-SETL-ACCR-008 FR-SETL-STMT-004 FR-SETL-STMT-006 フェーズと条件版の選び方', () => {
  const schedule = {phases: [phase('semiannual', {id: 1, anchorMonth: 6, startsMonth: '2024-07', endsMonth: '2025-03'}), phase('quarterly', {id: 2, anchorMonth: 3, startsMonth: '2025-04'})]};
  assert.equal(phaseFor(schedule, '2024-06'), null);
  assert.equal(phaseFor(schedule, '2025-03').id, 1);
  assert.equal(phaseFor(schedule, '2030-01').id, 2);
  const versions = [term({id: 1, effectiveFrom: '2025-01'}), term({id: 2, effectiveFrom: '2025-07'})];
  assert.equal(termFor(versions, '2024-12'), null);
  assert.equal(termFor(versions, '2025-06').id, 1);
  assert.equal(termFor(versions, '2025-07').id, 2);
});

test('FR-SETL-ACCR-009 率と金額: %⇔bp、料率の額は0に向かって切り捨て（負の月も）', () => {
  assert.equal(percentToBps('10'), 1000);
  assert.equal(percentToBps('２.５％'), 250);
  assert.equal(percentToBps('12.34'), 1234);
  assert.equal(percentToBps('1.234'), null);
  assert.equal(percentToBps('abc'), null);
  assert.equal(bpsToPercent(1050), '10.5');
  assert.equal(bpsToPercent(1234), '12.34');
  assert.equal(bpsToPercent(300), '3');
  assert.equal(signedRateAmount(12345, 1000), 1234);
  assert.equal(signedRateAmount(-12345, 1000), -1234);
});

test('条件版の入力の検査', () => {
  assert.equal(normalizeTermInput({effectiveFrom: '2025-04', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 500, clauseReference: '第5条'}).ok, true);
  const noWindow = normalizeTermInput({effectiveFrom: '2025-04', calcMethod: 'rate', baseKind: 'after_window_fee', rateBps: 500, clauseReference: '第5条'});
  assert.equal(noWindow.ok, false);
  assert.ok(noWindow.errors.some((e) => e.field === 'windowFeeBps'));
  const categoriesOnGross = normalizeTermInput({effectiveFrom: '2025-04', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 500, clauseReference: 'x', expenseCategories: ['宣伝費']});
  assert.ok(categoriesOnGross.errors.some((e) => e.field === 'expenseCategories'));
  const packageTarget = normalizeTermInput({effectiveFrom: '2025-04', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 500, clauseReference: 'x', channels: ['package']});
  assert.ok(packageTarget.errors.some((e) => e.field === 'channels'), '区分未確認は対象に選べない');
  const fixed = normalizeTermInput({effectiveFrom: '2025-04', calcMethod: 'fixed_monthly', fixedAmountYen: 30000, clauseReference: '第3条', advanceYen: ''});
  assert.equal(fixed.ok, true);
  assert.equal(fixed.value.advanceYen, 0);
  assert.equal(fixed.value.rateBps, null);
  const missing = normalizeTermInput({calcMethod: 'manual'});
  assert.deepEqual(missing.errors.map((e) => e.field).sort(), ['clauseReference', 'effectiveFrom']);
});

test('FR-SETL-STMT-049 サイクルの入力の検査: 重なり・基準月・列挙・初月即締', () => {
  const good = normalizeScheduleInput({phases: [{startsMonth: '2025-04', cycleKind: 'quarterly', anchorMonth: 3}, {startsMonth: '2024-07', endsMonth: '2025-03', cycleKind: 'semiannual', anchorMonth: 6}]});
  assert.equal(good.ok, true);
  assert.deepEqual(good.value.phases.map((p) => p.startsMonth), ['2024-07', '2025-04'], '開始月の順に並べ直す');
  assert.equal(good.value.phases[0].reportDay, 'eom');
  const overlap = normalizeScheduleInput({phases: [{startsMonth: '2024-07', cycleKind: 'monthly'}, {startsMonth: '2025-04', cycleKind: 'monthly'}]});
  assert.ok(overlap.errors.some((e) => /重なって/.test(e.message)), '終了月の無いフェーズの後に別のフェーズは置けない');
  const noAnchor = normalizeScheduleInput({phases: [{startsMonth: '2024-07', cycleKind: 'annual'}]});
  assert.ok(noAnchor.errors.some((e) => e.field === 'phases.0.anchorMonth'));
  const badCustom = normalizeScheduleInput({phases: [{startsMonth: '2024-07', cycleKind: 'custom', customCloseMonths: '2024-13'}]});
  assert.ok(badCustom.errors.some((e) => e.field === 'phases.0.customCloseMonths'));
  const badFirst = normalizeScheduleInput({phases: [{startsMonth: '2024-07', cycleKind: 'monthly', firstCloseImmediate: true}]});
  assert.ok(badFirst.errors.some((e) => e.field === 'phases.0.firstCloseImmediate'));
  assert.equal(normalizeScheduleInput({phases: []}).ok, false);
  const day = normalizeScheduleInput({phases: [{startsMonth: '2024-07', cycleKind: 'monthly', reportDay: '32'}]});
  assert.ok(day.errors.some((e) => e.field === 'phases.0.reportDay'));
});

test('FR-SETL-ACCR-008 FR-SETL-ACCR-009 FR-SETL-ACCR-011 FR-SETL-ACCR-014 発生額: 売上×料率、対象流通、区分未確認のビデオグラムは保留、負の月（返品）もそのまま', () => {
  const a = agreement({terms: [term({channels: ['digital', 'rental']})]});
  const items = accrueAgreement({agreement: a, toMonth: '2025-03', sales: [
    sale('2025-01', 100000, 'digital'), sale('2025-01', 50000, 'theatrical'), sale('2025-01', 30000, 'package'), sale('2025-01', 20000, 'rental'),
    sale('2025-02', -15000, 'digital'), sale('2024-12', 99999, 'digital'), sale('2025-04', 99999, 'digital'),
  ]});
  assert.deepEqual(items.map((i) => i.accrualMonth), ['2025-01', '2025-02'], '条件版の前と期間後の月は入れない');
  const jan = items[0];
  assert.equal(jan.salesYen, 120000);
  assert.equal(jan.excludedSalesYen, 50000);
  assert.equal(jan.holdSalesYen, 30000, 'レンタルだけが対象なので、区分未確認のビデオグラムは保留');
  assert.equal(jan.royaltyYen, 12000);
  assert.match(jan.holdReasons[0], /区分未確認/);
  assert.equal(items[1].royaltyYen, -1500, '返品の月はマイナスのまま');
  const both = accrueAgreement({agreement: agreement({terms: [term({channels: ['rental', 'sell']})]}), toMonth: '2025-01', sales: [sale('2025-01', 30000, 'package')]});
  assert.equal(both[0].royaltyYen, 3000, 'レンタルとセルの両方が対象なら区分未確認も入る');
  assert.equal(both[0].holdSalesYen, 0);
});

test('FR-SETL-ACCR-009 FR-SETL-ACCR-010 発生額: 窓口手数料・経費（費目の指定）を引いた基礎、切り捨て', () => {
  const fee = accrueAgreement({agreement: agreement({terms: [term({baseKind: 'after_window_fee', windowFeeBps: 2500, rateBps: 333})]}), toMonth: '2025-01', sales: [sale('2025-01', 100001)]});
  assert.equal(fee[0].windowFeeYen, 25000);
  assert.equal(fee[0].baseYen, 75001);
  assert.equal(fee[0].royaltyYen, 2497, '75001×3.33%=2497.53 → 切り捨て');
  const expenses = [{id: 1, month: '2025-01', category: '宣伝費', description: '架空の広告', amount: 20000}, {id: 2, month: '2025-01', category: '事務費', description: '架空', amount: 5000},
    {id: 3, month: '2025-02', category: '宣伝費', description: '架空の広告', amount: 40000}];
  const withExp = accrueAgreement({agreement: agreement({terms: [term({baseKind: 'after_window_fee_and_expenses', windowFeeBps: 1000, rateBps: 1000, expenseCategories: ['宣伝費']})]}),
    toMonth: '2025-02', sales: [sale('2025-01', 100000)], expenses});
  assert.equal(withExp.length, 2, '経費だけの月も基礎を持つ');
  assert.equal(withExp[0].expenseYen, 20000, '指定した費目だけ');
  assert.equal(withExp[0].baseYen, 100000 - 10000 - 20000);
  assert.equal(withExp[0].royaltyYen, 7000);
  assert.equal(withExp[1].baseYen, -40000);
  assert.equal(withExp[1].royaltyYen, -4000, '売上の無い月の経費はマイナスの発生');
  assert.equal(withExp[0].expenseLines.length, 1);
  const allCats = accrueAgreement({agreement: agreement({terms: [term({baseKind: 'after_window_fee_and_expenses', windowFeeBps: 0, rateBps: 1000})]}), toMonth: '2025-01', sales: [sale('2025-01', 100000)], expenses});
  assert.equal(allCats[0].expenseYen, 25000, '費目の指定が無ければその月の経費すべて');
});

test('FR-SETL-ACCR-008 FR-SETL-ACCR-012 FR-SETL-ACCR-013 発生額: 条件版の切替（料率の変更・定額・実額）', () => {
  const a = agreement({terms: [
    term({id: 1, versionNo: 1, effectiveFrom: '2025-01', rateBps: 1000}),
    term({id: 2, versionNo: 2, effectiveFrom: '2025-03', calcMethod: 'fixed_monthly', baseKind: null, rateBps: null, fixedAmountYen: 30000}),
    term({id: 3, versionNo: 3, effectiveFrom: '2025-06', calcMethod: 'manual', baseKind: null, rateBps: null}),
  ]});
  const items = accrueAgreement({agreement: a, toMonth: '2025-07', sales: [sale('2025-01', 100000), sale('2025-02', 200000), sale('2025-04', 999999), sale('2025-06', 999999)],
    manual: [{id: 1, accrualMonth: '2025-06', amountYen: 12345}, {id: 2, accrualMonth: '2025-06', amountYen: 555}, {id: 3, accrualMonth: '2025-06', amountYen: -555, reversesEntryId: 2}, {id: 4, accrualMonth: '2025-02', amountYen: 777}]});
  assert.deepEqual(items.map((i) => [i.accrualMonth, i.calcMethod, i.royaltyYen]), [
    ['2025-01', 'rate', 10000], ['2025-02', 'rate', 20000], ['2025-03', 'fixed_monthly', 30000], ['2025-04', 'fixed_monthly', 30000], ['2025-05', 'fixed_monthly', 30000], ['2025-06', 'manual', 12345],
  ], '定額は次の版の前月まで毎月、実額は計上した月だけ（取消を差し引く）。料率の月の実額の行は使わない');
});

test('FR-SETL-ACCR-010 FR-SETL-ACCR-014 発生額: 本委員会収入の基礎（収入は入力として渡す）と、委員会の条件が無いときの保留', () => {
  const a = agreement({terms: [term({baseKind: 'committee_income_after_expenses', rateBps: 500, channels: ['theatrical', 'digital']})]});
  const committee = {available: true, rows: [
    {month: '2025-01', channelGroup: 'theatrical', sales: 1000000, income: 600000}, {month: '2025-01', channelGroup: 'digital', sales: 200000, income: 140000},
    {month: '2025-01', channelGroup: 'broadcast', sales: 50000, income: 40000},
  ], expenses: [{month: '2025-01', category: '宣伝費', amount: 100000}, {month: '2025-02', category: '宣伝費', amount: 30000}]};
  const items = accrueAgreement({agreement: a, toMonth: '2025-02', committee});
  assert.equal(items[0].committeeIncomeYen, 740000);
  assert.equal(items[0].salesYen, 1200000);
  assert.equal(items[0].expenseYen, 100000);
  assert.equal(items[0].baseYen, 640000);
  assert.equal(items[0].royaltyYen, 32000);
  assert.equal(items[1].royaltyYen, -1500, '委員会の経費だけの月');
  const plain = accrueAgreement({agreement: agreement({terms: [term({baseKind: 'committee_income', rateBps: 500})]}), toMonth: '2025-01', committee});
  assert.equal(plain[0].baseYen, 780000);
  const missing = accrueAgreement({agreement: agreement({terms: [term({baseKind: 'committee_income', rateBps: 500})]}), toMonth: '2025-01', committee: {available: false, rows: [], expenses: []}, sales: [sale('2025-01', 50000)]});
  assert.equal(missing[0].royaltyYen, null, '0円にしない');
  assert.equal(missing[0].holdSalesYen, 50000);
  assert.match(missing[0].holdReasons[0], /製作委員会/);
});

test('FR-SETL-STMT-006 FR-SETL-STMT-029 イレギュラー: 保留・解除（記録順、取消は効かない）と締め月の変更、計上無し・別途協議', () => {
  const entries = [
    {id: 1, kind: 'hold', agreementId: 1, accrualMonth: '2025-01', reason: '明細の確認中'},
    {id: 2, kind: 'release', agreementId: 1, accrualMonth: '2025-01', reason: '確認済み'},
    {id: 3, kind: 'hold', agreementId: 1, accrualMonth: '2025-02', reason: '誤り'},
    {id: 4, kind: 'hold', agreementId: 1, accrualMonth: '2025-02', reason: '誤り', reversesEntryId: 3},
    {id: 5, kind: 'hold', agreementId: 1, accrualMonth: '2025-03', reason: '係争中'},
  ];
  assert.deepEqual(effectiveEntries(entries).map((e) => e.id), [1, 2, 5]);
  const states = holdStates(entries);
  assert.equal(states.get('1:2025-01').held, false);
  assert.equal(states.has('1:2025-02'), false);
  assert.equal(states.get('1:2025-03').held, true);
  const a = agreement({schedule: {phases: [phase('monthly', {startsMonth: '2025-01', endsMonth: '2025-03'}), phase('none', {id: 2, startsMonth: '2025-04', endsMonth: '2025-04'}),
    phase('manual', {id: 3, startsMonth: '2025-05'})]}});
  const accruals = accrueAgreement({agreement: a, toMonth: '2025-06', sales: ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'].map((m) => sale(m, 10000))});
  const moves = [...entries, {id: 6, kind: 'move_period', agreementId: 1, accrualMonth: '2025-05', closeMonth: '2025-09', reason: '協議で9月締め'}];
  const items = resolveItems({agreement: a, accruals, entries: moves});
  assert.deepEqual(items.map((i) => i.accrualMonth), ['2025-01', '2025-02', '2025-03', '2025-05', '2025-06'], '計上無しのフェーズの月は発生させない');
  const by = Object.fromEntries(items.map((i) => [i.accrualMonth, i]));
  assert.equal(by['2025-03'].held, true);
  assert.ok(isHeldItem(by['2025-03']));
  assert.equal(by['2025-05'].closeMonth, '2025-09', '別途協議はイレギュラーで締め月を指定したものだけ締める');
  assert.equal(by['2025-05'].unscheduled, false);
  assert.equal(by['2025-06'].closeMonth, null);
  assert.equal(by['2025-06'].unscheduled, true);
  assert.match(by['2025-06'].holdReasons.join(), /別途協議/);
  assert.equal(by['2025-01'].reportDueOn, '2025-02-28');
});

test('FR-SETL-STMT-004 サイクルの途中変更（定型業務の型: 半年から四半期へ）と期間の列挙', () => {
  const a = agreement({terms: [term({effectiveFrom: '2024-07'})], schedule: {statementsFrom: null, phases: [
    phase('semiannual', {id: 1, anchorMonth: 6, startsMonth: '2024-07', endsMonth: '2025-03'}),
    phase('quarterly', {id: 2, anchorMonth: 3, startsMonth: '2025-04', reportOffsetMonths: 2}),
  ]}});
  const accruals = accrueAgreement({agreement: a, toMonth: '2025-08', sales: monthsBetween('2024-07', '2025-08').map((m) => sale(m, 10000))});
  const items = resolveItems({agreement: a, accruals, entries: []});
  const closeOf = Object.fromEntries(items.map((i) => [i.accrualMonth, i.closeMonth]));
  assert.equal(closeOf['2024-07'], '2024-12');
  assert.equal(closeOf['2024-12'], '2024-12');
  assert.equal(closeOf['2025-01'], '2025-06', '半年のフェーズの残りは次の6月締め');
  assert.equal(closeOf['2025-03'], '2025-06');
  assert.equal(closeOf['2025-04'], '2025-06', '四半期に変わった後の最初の締め');
  assert.equal(closeOf['2025-07'], '2025-09');
  const closings = enumerateClosings({agreement: a, asOfMonth: '2025-08'});
  assert.deepEqual([...closings.keys()], ['2024-12', '2025-06', '2025-09']);
  assert.deepEqual(closings.get('2025-06'), {reportDueOn: '2025-07-31', paymentDueOn: '2025-08-31'}, '同じ締め月を作るフェーズが複数なら早い期限');
  assert.equal(closings.get('2025-09').reportDueOn, '2025-11-30');
  const late = agreement({terms: [term({effectiveFrom: '2024-07'})], schedule: {statementsFrom: '2025-06', phases: a.schedule.phases}});
  assert.deepEqual([...enumerateClosings({agreement: late, asOfMonth: '2025-08'}).keys()], ['2025-06', '2025-09'], '報告書を作り始める締め月より前は並べない');
  const withAdjust = holderClosings({agreements: [a], entries: [{id: 9, kind: 'adjust_amount', holderId: 7, closeMonth: '2025-11', amountYen: 500, reason: '架空'}], asOfMonth: '2025-08'});
  assert.ok(withAdjust.has('2025-11'), '金額の調整の締め月も期間になる');
  assert.equal(withAdjust.get('2025-11').reportDueOn, '2026-01-31');
});

// 権利者1人・契約2つ（毎月締め）で報告書を順に作る
function chainFixture({advanceYen = 0, minPaymentYen = null, statementsFrom = null} = {}) {
  const a1 = agreement({id: 1, code: 'AG-DIR', terms: [term({id: 11, advanceYen, minPaymentYen})], schedule: {statementsFrom, phases: [phase('monthly', {startsMonth: '2025-01'})]}});
  const a2 = agreement({id: 2, code: 'AG-SCR', category: 'screenplay', workId: 2, workTitle: '架空作品2', terms: [term({id: 21, rateBps: 500, minPaymentYen: minPaymentYen === null ? null : minPaymentYen * 2})],
    schedule: {statementsFrom, phases: [phase('monthly', {startsMonth: '2025-01'})]}});
  return {a1, a2, holder: {id: 7, name: '架空監督', code: 'PT-7'}};
}
function itemsFor(agreements, salesByAgreement, entries = []) {
  return agreements.flatMap((a) => resolveItems({agreement: a, accruals: accrueAgreement({agreement: a, toMonth: '2025-12', sales: salesByAgreement[a.id] || []}), entries}));
}
const asPrior = (id, statement) => ({id, closeMonth: statement.closeMonth, carriedOutYen: statement.totals.carriedOutYen, lines: statement.lines});

test('FR-SETL-STMT-010 FR-SETL-STMT-016 報告書: 前回まで・当期・累計、報告後の売上の追加は差額として次の報告書へ', () => {
  const {a1, a2, holder} = chainFixture();
  const sales = {1: [sale('2025-01', 100000), sale('2025-02', 50000)], 2: [sale('2025-01', 40000)]};
  let items = itemsFor([a1, a2], sales);
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [a1, a2], items, due: {reportDueOn: '2025-02-28', paymentDueOn: '2025-03-31'}});
  assert.equal(jan.totals.royaltyYen, 10000 + 2000);
  assert.equal(jan.totals.payableYen, 12000);
  assert.equal(jan.reportDueOn, '2025-02-28');
  assert.ok(checksOk(jan.checks), JSON.stringify(jan.checks));
  // 1月の売上が報告後に届いた（遅れた報告）
  sales[1].push(sale('2025-01', 30000));
  items = itemsFor([a1, a2], sales);
  const feb = buildStatement({holder, closeMonth: '2025-02', agreements: [a1, a2], items, priorStatements: [asPrior(101, jan)]});
  const revision = feb.lines.find((line) => line.lineKind === 'revision');
  assert.equal(revision.accrualMonth, '2025-01');
  assert.equal(revision.amountYen, 3000);
  assert.equal(revision.salesYen, 30000);
  assert.match(revision.note, /報告後/);
  assert.equal(feb.totals.royaltyYen, 5000 + 3000);
  const row = feb.rows.find((r) => r.agreementId === 1);
  assert.equal(row.prior.amountYen, 10000);
  assert.equal(row.current.amountYen, 8000);
  assert.equal(row.cumulative.amountYen, 18000);
  assert.equal(feb.rows.find((r) => r.agreementId === 2).current.amountYen, 0, '当期の無い契約も前回まで・累計を出す');
  assert.equal(feb.previousStatementId, 101);
  assert.ok(checksOk(feb.checks), JSON.stringify(feb.checks));
  // 同じ内容で作り直しても差額は出ない（報告済みとの差だけを入れる）
  const again = buildStatement({holder, closeMonth: '2025-03', agreements: [a1, a2], items, priorStatements: [asPrior(101, jan), asPrior(102, feb)]});
  assert.equal(again.lines.length, 0);
  assert.equal(again.totals.payableYen, 0);
  assert.ok(checksOk(again.checks));
});

test('FR-SETL-STMT-013 FR-SETL-STMT-014 報告書: 支払の下限未満とマイナスは翌期へ繰り越し、前期繰越に引き継ぐ', () => {
  const {a1, a2, holder} = chainFixture({minPaymentYen: 10000});
  const sales = {1: [sale('2025-01', 50000), sale('2025-02', -80000), sale('2025-03', 200000)]};
  const items = itemsFor([a1, a2], sales);
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [a1, a2], items});
  assert.equal(jan.totals.minPaymentYen, 10000, '権利者の契約のうち小さい下限');
  assert.equal(jan.totals.payableYen, 0);
  assert.equal(jan.totals.carriedOutYen, 5000);
  assert.match(jan.totals.carryReason, /下限/);
  const feb = buildStatement({holder, closeMonth: '2025-02', agreements: [a1, a2], items, priorStatements: [asPrior(1, jan)]});
  assert.equal(feb.totals.carriedInYen, 5000);
  assert.equal(feb.totals.royaltyYen, -8000);
  assert.equal(feb.totals.payableYen, 0);
  assert.equal(feb.totals.carriedOutYen, -3000, 'マイナスも繰り越す');
  const mar = buildStatement({holder, closeMonth: '2025-03', agreements: [a1, a2], items, priorStatements: [asPrior(1, jan), asPrior(2, feb)]});
  assert.equal(mar.totals.payableYen, 20000 - 3000);
  assert.equal(mar.totals.carriedOutYen, 0);
  for (const s of [jan, feb, mar]) assert.ok(checksOk(s.checks), JSON.stringify(s.checks));
  const noMin = chainFixture({minPaymentYen: null});
  const small = buildStatement({holder: noMin.holder, closeMonth: '2025-01', agreements: [noMin.a1, noMin.a2], items: itemsFor([noMin.a1, noMin.a2], {1: [sale('2025-01', 100)]})});
  assert.equal(small.totals.payableYen, 10, '下限の無い契約があれば下限なし');
});

test('FR-SETL-STMT-015 報告書: 前払金の充当（契約ごと・累計まで）と、返品で累計が減ったときの戻し', () => {
  const {a1, a2, holder} = chainFixture({advanceYen: 15000});
  const sales = {1: [sale('2025-01', 100000), sale('2025-02', 100000), sale('2025-03', -150000), sale('2025-04', 300000)], 2: [sale('2025-01', 100000)]};
  const items = itemsFor([a1, a2], sales);
  const chain = [];
  const results = [];
  for (const close of ['2025-01', '2025-02', '2025-03', '2025-04']) {
    const s = buildStatement({holder, closeMonth: close, agreements: [a1, a2], items, priorStatements: chain});
    results.push(s);
    chain.push(asPrior(chain.length + 1, s));
    assert.ok(checksOk(s.checks), `${close} ${JSON.stringify(s.checks)}`);
  }
  const [jan, feb, mar, apr] = results;
  assert.equal(jan.totals.advanceRecoupedYen, 10000, '1月: 発生10,000はすべて充当');
  assert.equal(jan.totals.payableYen, 5000, '脚本料は前払金なし');
  assert.equal(feb.totals.advanceRecoupedYen, 5000, '2月: 前払金の残り5,000');
  assert.equal(feb.totals.payableYen, 5000);
  assert.equal(mar.totals.royaltyYen, -15000);
  assert.equal(mar.totals.advanceRecoupedYen, -10000, '累計5,000に減ったので充当を10,000戻す');
  assert.equal(mar.totals.carriedOutYen, -5000);
  assert.equal(apr.totals.advanceRecoupedYen, 10000);
  assert.equal(apr.totals.payableYen, 30000 - 10000 - 5000);
  const adv = apr.advance.find((a) => a.agreementId === 1);
  assert.equal(adv.recoupedTotal, 15000);
  assert.equal(adv.remainingYen, 0);
});

test('FR-SETL-STMT-029 報告書: 金額の調整（イレギュラー）と、報告済みの調整の取消は戻し行になる', () => {
  const {a1, a2, holder} = chainFixture();
  const items = itemsFor([a1, a2], {1: [sale('2025-01', 100000)]});
  const adjustments = [{id: 31, kind: 'adjust_amount', holderId: 7, agreementId: 1, accrualMonth: null, closeMonth: '2025-01', amountYen: -2500, reason: '計算誤りの訂正'},
    {id: 32, kind: 'adjust_amount', holderId: 7, agreementId: null, closeMonth: '2025-03', amountYen: 1000, reason: '振込手数料の負担'}];
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [a1, a2], items, adjustments});
  assert.equal(jan.totals.adjustmentYen, -2500);
  assert.equal(jan.totals.payableYen, 7500);
  assert.equal(jan.adjustments[0].reason, '計算誤りの訂正');
  const reversed = [...adjustments, {id: 33, kind: 'adjust_amount', holderId: 7, agreementId: 1, accrualMonth: null, closeMonth: '2025-01', amountYen: -2500, reason: '誤記録', reversesEntryId: 31}];
  const feb = buildStatement({holder, closeMonth: '2025-02', agreements: [a1, a2], items, adjustments: reversed, priorStatements: [asPrior(1, jan)]});
  assert.equal(feb.totals.adjustmentYen, 2500, '報告済みの調整を取り消したので戻す');
  assert.match(feb.adjustments[0].note, /取り消した/);
  const mar = buildStatement({holder, closeMonth: '2025-03', agreements: [a1, a2], items, adjustments: reversed, priorStatements: [asPrior(1, jan), asPrior(2, feb)]});
  assert.equal(mar.totals.adjustmentYen, 1000, '契約に付かない調整も締め月の報告書に入る');
  for (const s of [jan, feb, mar]) assert.ok(checksOk(s.checks), JSON.stringify(s.checks));
});

test('FR-SETL-STMT-016 FR-SETL-STMT-029 報告書: 保留は0円にせず別に示し、解除すると次の報告書に遅れて入る', () => {
  const {a1, a2, holder} = chainFixture();
  const a1Rental = {...a1, terms: [term({id: 11, channels: ['rental']})]};
  const sales = {1: [sale('2025-01', 100000, 'rental'), sale('2025-01', 40000, 'package'), sale('2025-02', 60000, 'rental')]};
  const hold = [{id: 41, kind: 'hold', holderId: 7, agreementId: 1, accrualMonth: '2025-02', reason: '明細の確認中'}];
  const items = itemsFor([a1Rental, a2], sales, hold);
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [a1Rental, a2], items});
  assert.equal(jan.totals.royaltyYen, 10000);
  assert.equal(jan.holds.length, 1);
  assert.equal(jan.holds[0].holdSalesYen, 40000);
  assert.equal(jan.holds[0].partial, true);
  const feb = buildStatement({holder, closeMonth: '2025-02', agreements: [a1Rental, a2], items, priorStatements: [asPrior(1, jan)]});
  assert.equal(feb.totals.royaltyYen, 0, '保留中の月は入れない');
  assert.equal(feb.totals.holdCount, 2);
  const heldRow = feb.holds.find((h) => h.accrualMonth === '2025-02');
  assert.equal(heldRow.royaltyYen, 6000);
  assert.equal(heldRow.holdSalesYen, 60000, '対象売上を残す');
  const released = itemsFor([a1Rental, a2], sales, [...hold, {id: 42, kind: 'release', holderId: 7, agreementId: 1, accrualMonth: '2025-02', reason: '確認済み'}]);
  const mar = buildStatement({holder, closeMonth: '2025-03', agreements: [a1Rental, a2], items: released, priorStatements: [asPrior(1, jan), asPrior(2, feb)]});
  const late = mar.lines.find((line) => line.accrualMonth === '2025-02');
  assert.equal(late.lineKind, 'revision');
  assert.equal(late.amountYen, 6000);
  assert.match(late.note, /締め月の後/);
  for (const s of [jan, feb, mar]) assert.ok(checksOk(s.checks), JSON.stringify(s.checks));
});

test('FR-SETL-STMT-017 報告書: 移行前（報告書を作り始める締め月より前）の分は外で報告済みとして除き、前払金の充当も済んだとみなす', () => {
  const {a1, a2, holder} = chainFixture({advanceYen: 15000, statementsFrom: '2025-03'});
  const items = itemsFor([a1, a2], {1: [sale('2025-01', 100000), sale('2025-02', 100000), sale('2025-03', 100000)]});
  assert.deepEqual(items.filter((i) => i.external).map((i) => i.accrualMonth), ['2025-01', '2025-02']);
  const mar = buildStatement({holder, closeMonth: '2025-03', agreements: [a1, a2], items});
  assert.equal(mar.totals.royaltyYen, 10000);
  assert.equal(mar.totals.advanceRecoupedYen, 0, '前払金15,000は移行前の20,000で充当済み');
  assert.equal(mar.totals.payableYen, 10000);
});

test('FR-SETL-STMT-008 FR-SETL-STMT-025 FR-SETL-STMT-026 期間の状態: 受付中・作成待ち・期限超過・作成済・報告済・支払済・後の報告書に含める', () => {
  const holder = {id: 7, name: '架空監督', code: 'PT-7'};
  const closings = new Map([
    ['2025-01', {reportDueOn: '2025-02-28', paymentDueOn: '2025-03-31'}], ['2025-02', {reportDueOn: '2025-03-31', paymentDueOn: '2025-04-30'}],
    ['2025-03', {reportDueOn: '2025-04-30', paymentDueOn: '2025-05-31'}], ['2025-04', {reportDueOn: '2025-05-31', paymentDueOn: '2025-06-30'}],
    ['2025-05', {reportDueOn: '2025-06-30', paymentDueOn: '2025-07-31'}], ['2025-06', {reportDueOn: '2025-07-31', paymentDueOn: '2025-08-31'}],
  ]);
  const st = (id, closeMonth, payableYen, events = []) => ({id, closeMonth, versionNo: 1, payableYen, royaltyYen: payableYen, adjustmentYen: 0, carriedOutYen: 0, holdCount: 0,
    reportDueOn: closings.get(closeMonth).reportDueOn, paymentDueOn: closings.get(closeMonth).paymentDueOn, events});
  const statements = [
    st(1, '2025-01', 1000, [{id: 1, eventKind: 'reported', occurredOn: '2025-02-20'}, {id: 2, eventKind: 'paid', occurredOn: '2025-03-20', amountYen: 1000}]),
    st(3, '2025-03', 500, [{id: 3, eventKind: 'reported', occurredOn: '2025-04-10'}, {id: 4, eventKind: 'reported', occurredOn: '2025-04-10', reversesEventId: 3}]),
  ];
  const rows = periodRows({holder, closings, statements, asOf: '2025-06-10'});
  const status = Object.fromEntries(rows.map((r) => [r.closeMonth, r.status]));
  assert.deepEqual(status, {'2025-01': 'paid', '2025-02': 'merged', '2025-03': 'overdue', '2025-04': 'overdue', '2025-05': 'pending', '2025-06': 'open'});
  assert.equal(rows[0].statusLabel, '支払済');
  assert.equal(rows.find((r) => r.closeMonth === '2025-03').reportedOn, null, '取り消した報告は数えない');
  assert.equal(rows.find((r) => r.closeMonth === '2025-03').paymentOverdue, true);
  assert.equal(statementStatus({payableYen: 0, reportDueOn: '2025-09-30'}, [{id: 1, eventKind: 'reported', occurredOn: '2025-08-01'}], '2025-10-01'), 'reported', '支払予定0円は報告で完了');
  assert.equal(statementStatus({payableYen: 100, reportDueOn: '2025-09-30'}, [], '2025-09-30'), 'created', '期限日の当日はまだ超過ではない');
  const state = eventState([{id: 1, eventKind: 'paid', occurredOn: '2025-01-01', amountYen: 300}, {id: 2, eventKind: 'paid', occurredOn: '2025-01-05', amountYen: 200}, {id: 3, eventKind: 'paid', occurredOn: '2025-01-06', amountYen: 300, reversesEventId: 1}]);
  assert.equal(state.paidYen, 200);
});

test('FR-SETL-STMT-009 下書き: 確定版の無い期間を古い順につなぎ、前期繰越を引き継ぐ', () => {
  const {a1, a2, holder} = chainFixture({minPaymentYen: 10000});
  const items = itemsFor([a1, a2], {1: [sale('2025-01', 50000), sale('2025-02', 80000)]});
  const closings = holderClosings({agreements: [a1, a2], asOfMonth: '2025-03'});
  const drafts = simulateDrafts({holder, agreements: [a1, a2], items, adjustments: [], statements: [], closings, asOf: '2025-04-01'});
  assert.deepEqual([...drafts.keys()], ['2025-01', '2025-02', '2025-03']);
  assert.equal(drafts.get('2025-01').totals.carriedOutYen, 5000);
  assert.equal(drafts.get('2025-02').totals.carriedInYen, 5000);
  assert.equal(drafts.get('2025-02').totals.payableYen, 13000);
  const later = simulateDrafts({holder, agreements: [a1, a2], items, adjustments: [], statements: [{id: 9, closeMonth: '2025-02', carriedOutYen: 0, lines: []}], closings, asOf: '2025-04-01'});
  assert.deepEqual([...later.keys()], ['2025-03'], '確定版より後の期間だけ');
});

test('FR-SETL-ACCR-023 FR-SETL-STMT-029 FR-SETL-STMT-037 集計シート: 権利者×月・種別・作品、累計・調整・前払金・支払・未払残、保留とイレギュラーの結果', () => {
  const {a1, a2, holder} = chainFixture({advanceYen: 5000});
  const entries = [
    {id: 1, kind: 'adjust_amount', holderId: 7, holderName: '架空監督', agreementId: 1, closeMonth: '2025-02', amountYen: 700, reason: '訂正'},
    {id: 2, kind: 'hold', holderId: 7, agreementId: 2, accrualMonth: '2025-02', reason: '確認中'},
    {id: 3, kind: 'move_period', holderId: 7, agreementId: 1, accrualMonth: '2025-02', closeMonth: '2025-04', reason: '合意'},
    {id: 4, kind: 'note', holderId: 7, reason: '電話で確認'},
    {id: 5, kind: 'adjust_amount', holderId: 7, agreementId: null, closeMonth: '2025-03', amountYen: 99, reason: '誤り'},
    {id: 6, kind: 'adjust_amount', holderId: 7, agreementId: null, closeMonth: '2025-03', amountYen: 99, reason: '誤り', reversesEntryId: 5},
  ];
  const items = itemsFor([a1, a2], {1: [sale('2024-12', 1), sale('2025-01', 100000), sale('2025-02', 50000)], 2: [sale('2025-01', 20000), sale('2025-02', 20000)]}, entries);
  const jan = buildStatement({holder, closeMonth: '2025-01', agreements: [a1, a2], items, adjustments: entries});
  const statements = [{id: 1, holderId: 7, closeMonth: '2025-01', lines: jan.lines, events: [{id: 1, eventKind: 'paid', occurredOn: '2025-03-15', amountYen: jan.totals.payableYen}]}];
  const ledger = buildLedger({agreements: [a1, a2], items, entries, statements, from: '2025-02', to: '2025-03'});
  assert.deepEqual(ledger.months, ['2025-02', '2025-03']);
  const row = ledger.byHolder[0];
  assert.equal(row.months['2025-02'], 5000 + 1000);
  assert.equal(row.periodYen, 6000);
  assert.equal(row.cumulativeYen, 10000 + 1000 + 6000, '契約開始からの累計（期間の前の月を含む）');
  assert.equal(row.adjustmentYen, 700, '取り消した調整は数えない');
  assert.equal(row.recoupYen, 5000);
  assert.equal(row.paidYen, jan.totals.payableYen);
  assert.equal(row.unpaidYen, 17000 + 700 - 5000 - jan.totals.payableYen);
  assert.equal(ledger.byHolderCategory.length, 2);
  assert.equal(ledger.byWorkCategory.length, 2);
  assert.ok(checksOk(ledger.checks), JSON.stringify(ledger.checks));
  assert.equal(ledger.holds.length, 1);
  assert.equal(ledger.holds[0].agreementCode, 'AG-SCR');
  assert.equal(ledger.holds[0].holdSalesYen, 20000, '発生額ごと保留の月は、その月の対象売上すべてを保留の対象売上にする');
  assert.equal(ledger.byHolder[0].holdSalesYen, 20000, '権利者の行も期間の中の保留だけ');
  const detailFeb = ledger.detail.find((d) => d.agreementId === 1 && d.accrualMonth === '2025-02');
  assert.equal(detailFeb.closeMonth, '2025-04', '締め月の変更が効いている');
  assert.equal(ledger.detail.find((d) => d.agreementId === 1 && d.accrualMonth === '2025-02').status, '未報告');
  const irregular = Object.fromEntries(ledger.irregular.map((r) => [r.id, r]));
  assert.match(irregular[1].effect, /2025年2月締めの報告書に \+700円/);
  assert.match(irregular[2].effect, /保留中/);
  assert.match(irregular[3].effect, /2025年4月締めへ（5,000円）/);
  assert.match(irregular[4].effect, /記録だけ/);
  assert.equal(irregular[5].reversed, true);
  assert.equal(irregular[6].isReversal, true);
  const janDetail = buildLedger({agreements: [a1, a2], items, entries, statements, from: '2025-01', to: '2025-01'}).detail.find((d) => d.agreementId === 1);
  assert.match(janDetail.status, /報告済み（2025年1月締め）/);
});

test('royalty.sql の選択肢（CHECK の値）は、すべて画面の日本語の辞書にある', async () => {
  const {readFileSync} = await import('node:fs');
  const {labelOf, isKnownCode} = await import('../src/ui/labels.mjs');
  const sql = readFileSync(new URL('../src/royalty/royalty.sql', import.meta.url), 'utf8');
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)\s*\(/g)].map((m) => ({name: m[1], at: m.index}));
  const found = new Map();
  for (const m of sql.matchAll(/CHECK\s*\(\s*(?:[a-z_]+ IS NULL OR )?([a-z_]+)\s+IN\s*\(([^)]*)\)/g)) {
    const table = tables.filter((t) => t.at < m.index).at(-1)?.name;
    if (!m[2].includes("'")) continue;
    found.set(`${table}.${m[1]}`, m[2].split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
  }
  const coverage = {
    'royalty_agreements.category': 'royaltyCategory', 'royalty_term_versions.calc_method': 'royaltyCalcMethod', 'royalty_term_versions.base_kind': 'royaltyBaseKind',
    'royalty_term_channels.channel_group': 'royaltyChannel', 'royalty_schedule_phases.cycle_kind': 'royaltyCycleKind', 'royalty_irregular_entries.kind': 'royaltyIrregularKind',
    'royalty_statement_lines.line_kind': 'royaltyLineKind', 'royalty_statement_events.event_kind': 'royaltyEventKind',
  };
  for (const [column, domain] of Object.entries(coverage)) {
    assert.ok(found.has(column), `CHECK が見つかりません: ${column}`);
    for (const code of found.get(column)) {
      assert.ok(isKnownCode(domain, code), `${column} の ${code}`);
      assert.doesNotMatch(labelOf(domain, code), /未登録の値/);
    }
  }
  for (const status of ['open', 'pending', 'overdue', 'created', 'reported', 'paid', 'merged']) assert.ok(isKnownCode('royaltyPeriodStatus', status), status);
});
