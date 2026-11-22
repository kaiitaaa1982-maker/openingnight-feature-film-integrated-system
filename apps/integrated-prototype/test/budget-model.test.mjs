// 予算書の純関数と xlsx の読み取り（src/planning/budget/）を、DB を使わずに確かめる。
// 期待値は要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET と、架空の予算書（test/fixtures/folder-budget/build-budget-xlsx.mjs）の
// 値から手で書いた（実装の関数で期待値を作らない）
import test from 'node:test';
import assert from 'node:assert/strict';
import {BUDGET_CATEGORIES, budgetFolderState, budgetReadNotices, budgetTotals, budgetVerdict, categoryFromLabel, checkParsedBudget, compareBudgetVersions,
  currentFixedVersionNo, departmentTotals, noticesForLines, referenceDiffs} from '../src/planning/budget/budget-model.mjs';
import {readBudgetFile} from '../src/planning/budget/budget-xlsx.mjs';
import {compileBudgetReadDefinition, firstTarget} from '../src/planning/budget/budget-read-model.mjs';
import {BUDGET_READ_SEEDS} from '../src/planning/budget/budget-read-seeds.mjs';
import {buildBudgetXlsx, fictionalBudgetSheets, fictionalCodeDetailSheets, fictionalNamedBudgetSheets} from './fixtures/folder-budget/build-budget-xlsx.mjs';

const line = (categoryCode, amountExTaxYen, extra = {}) => ({categoryCode, amountExTaxYen, name: extra.name ?? `${categoryCode}-${amountExTaxYen}`, ...extra});

test('FR-PLAN-BUDGET-002 費目の大分類は A〜K の11区分で、区分の小計の行の名前からコードを導き、名前の食い違う区分と L 以降は当てない', () => {
  assert.deepEqual(BUDGET_CATEGORIES.map((c) => c.code), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  assert.equal(BUDGET_CATEGORIES[6].name, '美術・衣装費');
  assert.equal(categoryFromLabel('A 企画費　　　　'), 'A');
  assert.equal(categoryFromLabel('G 美術・衣装費'), 'G');
  assert.equal(categoryFromLabel('J 編集・MA費　　'), 'J');
  assert.equal(categoryFromLabel('Ｋ　プリント・制作諸費'), 'K');
  assert.equal(categoryFromLabel('B'), 'B');
  assert.equal(categoryFromLabel('B 機材費'), null);
  assert.equal(categoryFromLabel('L 雑費'), null);
  assert.equal(categoryFromLabel('雑費'), null);
});

test('FR-PLAN-BUDGET-004 FR-PLAN-BUDGET-005 合計は明細と制作管理費・予備費から導き、消費税は総合計に1回だけ掛けて円未満を切り捨てる', () => {
  const totals = budgetTotals({lines: [line('A', 1000001), line('A', 500000), line('K', 2159999)], managementFeeYen: 100000, contingencyYen: 6, taxRateBps: 1000});
  assert.equal(totals.byCategory.find((r) => r.code === 'A').subtotalYen, 1500001);
  assert.equal(totals.byCategory.find((r) => r.code === 'A').lineCount, 2);
  assert.equal(totals.byCategory.find((r) => r.code === 'B').subtotalYen, 0);
  assert.equal(totals.directYen, 3660000);
  assert.equal(totals.totalExTaxYen, 3760006);
  assert.equal(totals.taxYen, 376000); // 376000.6 を切り捨てる（四捨五入しない）。行ごとに 1.1 を掛けて足さない
  assert.equal(totals.totalIncTaxYen, 4136006);
  assert.throws(() => budgetTotals({lines: [line('L', 1)]}), /A〜K/);
  assert.throws(() => budgetTotals({lines: [line('A', 1.5)]}), /整数円/);
  assert.throws(() => budgetTotals({lines: [], managementFeeYen: -1}), /0以上/);
});

test('FR-PLAN-BUDGET-006 部署ごとの小計を出し、部署の無い行は「部署なし」にまとめて最後に並べる', () => {
  const rows = departmentTotals([line('D', 300000, {departmentId: 2}), line('B', 100000), line('D', 200000, {departmentId: 1}), line('F', 50000, {departmentId: 2})]);
  assert.deepEqual(rows, [{departmentId: 1, subtotalYen: 200000, lineCount: 1}, {departmentId: 2, subtotalYen: 350000, lineCount: 2}, {departmentId: null, subtotalYen: 100000, lineCount: 1}]);
});

test('FR-PLAN-BUDGET-008 FR-PLAN-BUDGET-009 FR-PLAN-BUDGET-012 FR-PLAN-BUDGET-040 左右2区画の予算書を（初期値の定義で）見出しの名前で読み、区分の小計の行で明細を区分に割り当て、セルの黄色を確定の印にし、キャストの別表と2枚目は読まない', () => {
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sheet, '予算');
  assert.deepEqual(parsed.otherSheets, ['領収書まとめ']);
  assert.equal(parsed.lines.length, 16);
  assert.deepEqual(Object.keys(parsed.categories).sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  const byName = new Map(parsed.lines.map((l) => [l.name, l]));
  assert.deepEqual(['企画開発費', '脚本料'].map((n) => byName.get(n).categoryCode), ['A', 'A']);
  assert.equal(byName.get('脚本料').lineNo, 2);
  assert.equal(byName.get('脚本料').cell, 'B12');
  assert.equal(byName.get('助監督').qtyMilli, 2500);
  assert.equal(byName.get('助監督').unit, '週');
  assert.equal(byName.get('食費').categoryCode, 'H');
  assert.equal(byName.get('試写会場代').categoryCode, 'K');
  // 確定の印はセルの黄色から起こし、補った印を付ける（人が確かめる）
  assert.equal(byName.get('主演').confirmed, true);
  assert.deepEqual(byName.get('主演').marks, ['confirmed_from_fill']);
  assert.equal(byName.get('助演').confirmed, false);
  // 額の無い行（注記・0円の行）は明細にしない
  assert.equal(parsed.emptyRows, 3);
  assert.equal(byName.has('録音'), false);
  // キャストの別表の見出し（役名・役者名・所属事務所）は取り込まない
  assert.deepEqual(parsed.ignored.map((i) => i.kind), ['cast_table', 'cast_table', 'cast_table']);
  // 見出しの項目
  assert.equal(parsed.header.createdOn, '2025-12-09');
  assert.equal(parsed.header.notes.length, 2);
  assert.equal(parsed.stated.managementFeeYen, 100000);
  assert.equal(parsed.stated.contingencyYen, 50000);
});

test('FR-PLAN-BUDGET-010 FR-PLAN-BUDGET-017 原本の総合計・見積り・消費税・税込が明細から導いた額と合わなければ例外にする（総合計の式が製作準備費・制作管理費・予備費を落とした予算書）', () => {
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()));
  const {checks, totals} = checkParsedBudget(parsed);
  assert.equal(totals.directYen, 3510000);
  assert.equal(totals.totalExTaxYen, 3660000);
  assert.equal(totals.taxYen, 366000);
  const get = (key) => checks.find((c) => c.key === key);
  for (const code of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) assert.equal(get(`subtotal:${code}`).ok, true, code);
  assert.equal(get('direct').ok, true);
  assert.equal(get('subtotal_with_fee').ok, true);
  assert.deepEqual([get('total').ok, get('total').statedYen, get('total').derivedYen, get('total').cell], [false, 3430000, 3660000, 'N30']);
  assert.deepEqual([get('estimate').ok, get('estimate').cell], [false, 'C6']);
  assert.deepEqual([get('tax').ok, get('tax').statedYen, get('tax').derivedYen], [false, 343000, 366000]);
  assert.deepEqual([get('total_inc_tax').ok, get('total_inc_tax').derivedYen], [false, 4026000]);
  const verdict = budgetVerdict(checks);
  assert.equal(verdict.kind, 'exceptions');
  assert.deepEqual(verdict.failedKeys, ['total', 'estimate', 'tax', 'total_inc_tax']);
});

test('FR-PLAN-BUDGET-010 区分の小計が明細の和と合わなければ、その区分を例外にする', () => {
  const {checks} = checkParsedBudget(readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets({badSubtotalB: true}))));
  const b = checks.find((c) => c.key === 'subtotal:B');
  assert.deepEqual([b.ok, b.statedYen, b.derivedYen, b.cell], [false, 400000, 450000, 'F17']);
  assert.ok(budgetVerdict(checks).failedKeys.includes('subtotal:B'));
});

test('FR-PLAN-BUDGET-014 FR-PLAN-BUDGET-043 原本に合計の行が無い予算書は合計の検査を飛ばし（未判定）、明細から導いた額だけで下書きにでき（判定は例外なしのまま）、「総合計を読めなかった」の知らせを1件出す', () => {
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets({noTotals: true})));
  const {checks, totals} = checkParsedBudget(parsed);
  assert.equal(totals.totalExTaxYen, 3510000); // 制作管理費・予備費の行も無い
  for (const key of ['direct', 'total', 'estimate', 'tax', 'total_inc_tax']) assert.equal(checks.find((c) => c.key === key).ok, null, key);
  assert.equal(budgetVerdict(checks).kind, 'draft_ok');
  assert.deepEqual(budgetReadNotices({sourceKind: 'file', checks}), [{kind: 'total_unread', cell: null, label: '総合計を読めなかった'}]);
});

test('FR-PLAN-BUDGET-043 知らせは xlsx から読んで総合計の照合を飛ばした版だけに出し、総合計を読めた版・画面で作った版・見積りと消費税だけが無い版・総合計の照合を持たない過去の形の検査には出さない', () => {
  const read = (sheets) => checkParsedBudget(readBudgetFile(buildBudgetXlsx(sheets))).checks;
  assert.deepEqual(budgetReadNotices({sourceKind: 'file', checks: read(fictionalBudgetSheets())}), []); // 総合計の行がある（額は合わないが読めた）
  assert.deepEqual(budgetReadNotices({sourceKind: 'file', checks: read(fictionalCodeDetailSheets({noUnknown: true}))}), []); // GRAND TOTAL を読めた
  const noTotals = read(fictionalBudgetSheets({noTotals: true}));
  for (const sourceKind of ['screen', 'copy']) assert.deepEqual(budgetReadNotices({sourceKind, checks: noTotals}), [], sourceKind);
  // 総合計だけが読めて、見積り・消費税・税込・制作管理費が無い（照合は飛ばす）なら知らせない
  const totalOnly = noTotals.map((check) => (check.key === 'total' ? {...check, ok: true, statedYen: check.derivedYen, cell: 'N30'} : check));
  assert.deepEqual(budgetReadNotices({sourceKind: 'file', checks: totalOnly}), []);
  // 総合計の行はあるが値が読めない（数式だけで値の無いセル）も「読めなかった」
  assert.deepEqual(budgetReadNotices({sourceKind: 'file', checks: [{key: 'total', ok: null, statedYen: null, derivedYen: 1000, cell: 'N30'}]}),
    [{kind: 'total_unread', cell: 'N30', label: '総合計を読めなかった'}]);
  // 過去の形の検査の回（総合計の照合が無い・JSON が配列でない）でも落ちずに、知らせない
  for (const checks of [[], [{key: 'direct', ok: null}], null, undefined, {}]) assert.deepEqual(budgetReadNotices({sourceKind: 'file', checks}), [], JSON.stringify(checks));
  assert.deepEqual(budgetReadNotices(), []);
});

test('FR-PLAN-BUDGET-008 FR-PLAN-BUDGET-011 FR-PLAN-BUDGET-013 列の順と位置が違っても見出しの名前で読み、小計の行に閉じられない明細と A〜K に当たらない区分と値の無い数式と円未満の端数は例外、見出しの無いブックは形違い', () => {
  const cells = [
    {ref: 'D5', value: '科目'}, {ref: 'E5', value: '金額（税抜）'}, {ref: 'F5', value: '数量'}, {ref: 'G5', value: '単価'},
    {ref: 'D6', value: '脚本料'}, {ref: 'E6', value: 300000}, {ref: 'F6', value: 1}, {ref: 'G6', value: 300000},
    {ref: 'D7', value: 'A 企画費'}, {ref: 'F7', value: '小計'}, {ref: 'E7', value: 300000},
    {ref: 'D8', value: '雑費'}, {ref: 'E8', value: 20000},
    {ref: 'D9', value: 'L 雑費'}, {ref: 'F9', value: '小計'}, {ref: 'E9', value: 20000},
    {ref: 'D10', value: '交通費'}, {ref: 'E10', value: 5000},
    {ref: 'D11', value: '機材'}, {ref: 'E11', value: null, formula: 'G11*F11'},
    {ref: 'D12', value: '照明'}, {ref: 'E12', value: 100000.5, formula: 'G12*F12'},
  ];
  const parsed = readBudgetFile(buildBudgetXlsx([{name: 'Sheet1', cells}]));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.lines.length, 1);
  assert.deepEqual([parsed.lines[0].categoryCode, parsed.lines[0].amountExTaxYen, parsed.lines[0].unitPriceYen], ['A', 300000, 300000]);
  assert.deepEqual(parsed.unknownSubtotals.map((r) => r.cell), ['D9']);
  assert.deepEqual(parsed.uncategorized.map((l) => l.cell).sort(), ['D10', 'D8']);
  assert.deepEqual(parsed.withoutValue, ['E11']);
  assert.deepEqual(parsed.fractional, ['E12']); // 円未満の端数は丸めずに例外
  const {checks} = checkParsedBudget(parsed);
  assert.deepEqual(budgetVerdict(checks).failedKeys, ['uncategorized', 'unknown_category', 'without_value', 'fractional_yen']);
  const none = readBudgetFile(buildBudgetXlsx([{name: '一覧', cells: [{ref: 'A1', value: '作品'}, {ref: 'B1', value: '金額'}]}]));
  assert.deepEqual([none.ok, none.reason], [false, 'no_header']);
});

test('FR-PLAN-BUDGET-015 単価×数量と金額の食い違いと、セルの色から起こした確定の印は知らせるだけにし、比べる相手との差は超えたものに印を付ける', () => {
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()));
  const notices = noticesForLines(parsed.lines);
  assert.deepEqual(notices.map((n) => [n.kind, n.name]), [['confirmed_from_fill', '主演'], ['unit_price_qty', '撮影']]);
  assert.equal(notices.find((n) => n.kind === 'unit_price_qty').productYen, 380000);
  const diffs = referenceDiffs(3660000, {estimate: 3500000, productionCost: 3660000, contractProduction: 4000000});
  assert.deepEqual(diffs.map((d) => [d.key, d.diffYen, d.over]), [['estimate', 160000, true], ['productionCost', 0, false], ['contractProduction', -340000, false]]);
  assert.equal(referenceDiffs(3660000, {productionCost: 3000000})[0].over, true); // 線と違えば知らせる（大小を問わない）
});

test('FR-PLAN-BUDGET-016 2つの版を区分ごとの差と、区分の中の行の足し・消し・変更で比べ、2割以上動いた区分に印を付ける', () => {
  const before = {lines: [line('B', 2000000, {name: '主演'}), line('B', 400000, {name: '助演'}), line('H', 900000, {name: 'ロケ地'})], managementFeeYen: 0, contingencyYen: 0};
  const after = {lines: [line('B', 2400000, {name: '主演'}), line('B', 300000, {name: '追加の助演'}), line('H', 800000, {name: 'ロケ地'})], managementFeeYen: 0, contingencyYen: 0};
  const result = compareBudgetVersions(before, after);
  const b = result.categories.find((c) => c.code === 'B');
  assert.deepEqual([b.beforeYen, b.afterYen, b.diffYen, b.large], [2400000, 2700000, 300000, false]);
  assert.deepEqual(b.lines.map((l) => [l.name, l.kind, l.diffYen]).sort(), [['主演', 'changed', 400000], ['助演', 'removed', -400000], ['追加の助演', 'added', 300000]]);
  const h = result.categories.find((c) => c.code === 'H');
  assert.deepEqual([h.diffYen, h.large], [-100000, false]);
  assert.equal(result.categories.find((c) => c.code === 'A').lines.length, 0);
  assert.equal(result.totalDiffYen, 200000);
  const jump = compareBudgetVersions({lines: [line('F', 100000)]}, {lines: [line('F', 120000)]});
  assert.equal(jump.categories.find((c) => c.code === 'F').large, true);
  assert.equal(compareBudgetVersions({lines: []}, {lines: [line('G', 1)]}).categories.find((c) => c.code === 'G').large, true);
});

test('FR-PLAN-BUDGET-019 確定の記録は追加だけで、取り消しの行のあとは確定版が無く、取り消されていない最新の確定がいまの確定版', () => {
  assert.equal(currentFixedVersionNo([]), null);
  assert.equal(currentFixedVersionNo([{seq: 1, action: 'fix', versionNo: 2}]), 2);
  assert.equal(currentFixedVersionNo([{seq: 2, action: 'void', versionNo: 2}, {seq: 1, action: 'fix', versionNo: 2}]), null);
  assert.equal(currentFixedVersionNo([{seq: 1, action: 'fix', versionNo: 2}, {seq: 2, action: 'void', versionNo: 2}, {seq: 3, action: 'fix', versionNo: 3}]), 3);
});

test('FR-PLAN-BUDGET-021 作品画面の進み具合は、版なし→未着手・下書きだけ→作業中・最新の版に例外→要確認・確定版あり→完了（新しい下書きがあれば理由に出す）', () => {
  assert.deepEqual(budgetFolderState({}), {state: 'not_started', done: 0, total: 1, reason: '版なし'});
  assert.equal(budgetFolderState({versions: [{versionNo: 1}]}).state, 'in_progress');
  assert.deepEqual(budgetFolderState({versions: [{versionNo: 1}], latestVerdict: {kind: 'exceptions', failed: 2}}), {state: 'needs_review', done: 0, total: 1, reason: '例外 2'});
  assert.deepEqual(budgetFolderState({versions: [{versionNo: 1}, {versionNo: 2}], fixes: [{seq: 1, action: 'fix', versionNo: 1}]}),
    {state: 'done', done: 1, total: 1, reason: '確定 rev1・下書き rev2'});
  assert.equal(budgetFolderState({versions: [{versionNo: 1}], fixes: [{seq: 1, action: 'fix', versionNo: 1}, {seq: 2, action: 'void', versionNo: 1}]}).state, 'in_progress');
});

test('FR-PLAN-BUDGET-021 FR-PLAN-BUDGET-043 最新の版に知らせ（総合計を読めなかった）があれば進み具合は要確認で、例外のほうを先に出し、確定版があれば完了のまま', () => {
  const notices = [{kind: 'total_unread', cell: null, label: '総合計を読めなかった'}];
  assert.deepEqual(budgetFolderState({versions: [{versionNo: 1}], latestVerdict: {kind: 'draft_ok', failed: 0}, latestNotices: notices}),
    {state: 'needs_review', done: 0, total: 1, reason: '総合計を読めなかった', notice: true});
  assert.deepEqual(budgetFolderState({versions: [{versionNo: 1}], latestVerdict: {kind: 'exceptions', failed: 1}, latestNotices: notices}),
    {state: 'needs_review', done: 0, total: 1, reason: '例外 1'});
  assert.equal(budgetFolderState({versions: [{versionNo: 1}], fixes: [{seq: 1, action: 'fix', versionNo: 1}], latestNotices: notices}).state, 'done');
});

test('FR-PLAN-BUDGET-008 費目名に架空の人名・会社名を混ぜた正解表も同じ区分・額・セルで読み、キャストの別表の名前は取り込まない', () => {
  const plain = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()));
  const named = readBudgetFile(buildBudgetXlsx(fictionalNamedBudgetSheets()));
  assert.equal(named.ok, true);
  const shape = (parsed) => parsed.lines.map((l) => [l.cell, l.categoryCode, l.lineNo, l.amountExTaxYen, l.unitPriceYen, l.qtyMilli, l.unit, l.confirmed]);
  assert.deepEqual(shape(named), shape(plain));
  const byCell = new Map(named.lines.map((l) => [l.cell, l.name]));
  assert.equal(byCell.get('B20'), '監督料 架空太郎');
  assert.equal(byCell.get('J11'), '機材レンタル 架空機材株式会社');
  assert.equal(byCell.get('B11'), '企画開発費');
  assert.equal(JSON.stringify(named).includes('架空プロ'), false);
  assert.equal(JSON.stringify(named).includes('主人公'), false);
});

test('FR-PLAN-BUDGET-002 FR-PLAN-BUDGET-008 FR-PLAN-BUDGET-040 Code・Detail・Description の書式は（初期値の定義で）、小計の SUM の範囲で明細を区分に割り当て、小計の名前の規則で A〜K・制作管理費・予備費に当て、同じ区分の小計はまとめる', () => {
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalCodeDetailSheets()));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.form, 'code_detail');
  assert.deepEqual(Object.keys(parsed.categories).sort(), ['A', 'D', 'E', 'H', 'I']);
  const byCell = new Map(parsed.lines.map((l) => [l.cell, l]));
  assert.deepEqual(['B5', 'B6'].map((c) => byCell.get(c).categoryCode), ['A', 'A']);
  assert.equal(byCell.get('B5').name, '脚本料 架空太郎');
  // 監督費とスタッフ費は D に、ロケーション費(1)(2) は H にまとまる。小計の額は足し、セルは + でつなぐ
  assert.deepEqual(parsed.lines.filter((l) => l.categoryCode === 'D').map((l) => [l.cell, l.lineNo]), [['B8', 1], ['B15', 2]]);
  assert.deepEqual(parsed.categories.D.subtotal, {yen: 620000, cell: 'F9+F17', formula: null});
  assert.deepEqual(parsed.categories.H.subtotal, {yen: 100000, cell: 'F19+F21', formula: null});
  assert.equal(parsed.categories.A.subtotal.formula, 'SUM(F5:F6)');
  // Detail が空で Description だけの行は、直前の Detail を前に付ける。Detail の無い行は Description のセルを指す
  assert.equal(byCell.get('C13').name, 'ロケハン ガソリン代');
  assert.equal(byCell.get('C13').categoryCode, 'E');
  assert.equal(byCell.get('B15').qtyMilli, 3000);
  assert.equal(byCell.get('B15').unitPriceYen, 40000);
  // 額の無い行（撮影助手・謎の費目の枠）は明細にしない。額0で明細の無い区分の分からない小計は取り込まない部分
  assert.equal(parsed.lines.some((l) => l.name === '撮影助手'), false);
  assert.deepEqual(parsed.ignored, [{kind: 'empty_subtotal', cell: 'B23'}]);
  // 名前の無い小計は、範囲の明細の名前（劇伴）から I を補い、人が確かめる印を付ける。黄色は確定の印
  assert.deepEqual(parsed.inferredCategories, [{cell: 'B25', label: '', code: 'I'}]);
  assert.equal(byCell.get('B24').confirmed, true);
  // 区分の分からない小計に明細があれば、その明細は区分の無い行・小計は A〜K に当たらない区分
  assert.deepEqual(parsed.unknownSubtotals, [{cell: 'B27', label: '未分類の部 Unknown'}]);
  assert.deepEqual(parsed.uncategorized.map((l) => l.cell), ['B26']);
  // 制作管理費・予備費は小計の額で読み、明細にしない。節の合計は読まず、総合計（GRAND TOTAL）だけを原本の総合計にする
  assert.equal(parsed.stated.managementFeeYen, 100000);
  assert.equal(parsed.stated.contingencyYen, 50000);
  assert.deepEqual(parsed.stated.total, {yen: 1312000, cell: 'F34', formula: 'SUM(F10+F28+F33)'});
  assert.equal(parsed.lines.some((l) => /制作管理|予備/.test(l.name)), false);
  // 見出しの上の注記と、右の別表（見出しが無い）は読まない
  assert.deepEqual(parsed.header.notes, ['*撮影日数: 3日']);
  assert.equal(parsed.lines.some((l) => l.cell?.startsWith('J')), false);
  assert.equal(budgetVerdict(checkParsedBudget(parsed).checks).kind, 'exceptions');
});

test('FR-PLAN-BUDGET-002 FR-PLAN-BUDGET-010 Code・Detail・Description の書式で区分が全部決まれば、区分の小計と総合計を明細から照らして下書きにでき、区分の名前の規則は英字を語の境で当てる', () => {
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalCodeDetailSheets({noUnknown: true})));
  const {checks, totals} = checkParsedBudget(parsed);
  assert.equal(totals.totalExTaxYen, 1305000);
  assert.deepEqual(checks.filter((c) => c.key.startsWith('subtotal:')).map((c) => [c.key, c.ok]),
    [['subtotal:A', true], ['subtotal:D', true], ['subtotal:E', true], ['subtotal:H', true], ['subtotal:I', true]]);
  assert.equal(checks.find((c) => c.key === 'total').ok, true);
  assert.equal(budgetVerdict(checks).kind, 'draft_ok');
  // 規則（初期値の定義 Code・Detail・Description の categories）: 英字は語の境で当てる（additional の中の dit を拾わない）。制作管理費・予備費は区分でなく別の印
  const codeDetail = compileBudgetReadDefinition(BUDGET_READ_SEEDS.find((seed) => seed.name === 'Code・Detail・Description').definition);
  const codeDetailCategory = (label) => firstTarget(codeDetail.categories, label);
  assert.equal(codeDetailCategory('キャスト費 Additional Talent'), 'B');
  assert.equal(codeDetailCategory('Post Production Sound'), 'I');
  assert.equal(codeDetailCategory('Editing'), 'J');
  assert.equal(codeDetailCategory('制作管理/Production fee'), 'managementFee');
  assert.equal(codeDetailCategory('Contingency'), 'contingency');
  assert.equal(codeDetailCategory('Additional'), null);
  // 従来の書式（科目・金額(税抜)）は今までどおり読む
  assert.equal(readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets())).form, undefined);
});
