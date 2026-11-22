// 予算書の読み取りの定義（src/planning/budget/budget-read-model.mjs）の検査・語の当て方・使用中の版の選び方と、
// 定義がどう書かれていても読み取りが守る決まりを、DB を使わずに確かめる。
// 期待値は要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-036・037・041 と、架空の予算書（test/fixtures/folder-budget/）から手で書いた
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkBudgetReadDefinition, compileBudgetReadDefinition, firstTarget, inUseReadVersions} from '../src/planning/budget/budget-read-model.mjs';
import {BUDGET_READ_SEEDS} from '../src/planning/budget/budget-read-seeds.mjs';
import {readBudgetFile} from '../src/planning/budget/budget-xlsx.mjs';
import {budgetVerdict, checkParsedBudget} from '../src/planning/budget/budget-model.mjs';
import {buildBudgetXlsx, fictionalBudgetSheets} from './fixtures/folder-budget/build-budget-xlsx.mjs';

const BLOCKS = BUDGET_READ_SEEDS[0].definition;
const CODE_DETAIL = BUDGET_READ_SEEDS[1].definition;
const clone = (value) => JSON.parse(JSON.stringify(value));
const errorsOf = (definition) => {
  const checked = checkBudgetReadDefinition(definition);
  assert.equal(checked.ok, false, '断るはず');
  return checked.errors.join('\n');
};

test('FR-PLAN-BUDGET-036 初期値の2つの定義は検査を通り、知らない読み方・読み方に合わない小計の見つけ方・知らないキー・その読み方に無い見出しの役を断る', () => {
  for (const seed of BUDGET_READ_SEEDS) assert.equal(checkBudgetReadDefinition(seed.definition).ok, true, seed.name);
  assert.match(errorsOf({...clone(BLOCKS), read: {layout: 'any_grid', subtotal: 'marker_row', category: 'letter_prefix_then_order'}}), /read\.layout「any_grid」は決まった読み方/);
  assert.match(errorsOf({...clone(BLOCKS), read: {...BLOCKS.read, subtotal: 'sum_range_of_amount_column'}}), /read\.subtotal「sum_range_of_amount_column」は category_blocks の読み方/);
  assert.match(errorsOf({...clone(BLOCKS), script: 'return 1'}), /定義に知らないキー「script」/);
  assert.match(errorsOf({...clone(BLOCKS), categories: CODE_DETAIL.categories}), /定義に知らないキー「categories」/); // 区画の読み方は区分の語を持たない
  const header = clone(BLOCKS);
  header.header.roles.description = ['摘要'];
  assert.match(errorsOf(header), /header\.roles の役「description」は category_blocks の役/);
  const missing = clone(CODE_DETAIL);
  delete missing.categories;
  delete missing.header.roles.amount;
  const text = errorsOf(missing);
  assert.match(text, /categories がありません/);
  assert.match(text, /header\.roles に amount の語がありません/);
  assert.match(errorsOf({...clone(BLOCKS), kind: 'expense'}), /kind は "budget"/);
});

test('FR-PLAN-BUDGET-036 区分の行き先は A〜K と制作管理費・予備費だけで、空の語・当て方の2つ重なり・区分で使えない当て方・2つの役に重なる見出しの語を断る', () => {
  const outside = clone(CODE_DETAIL);
  outside.categories.push({to: 'L', words: ['雑費']}, {to: 'tax', words: ['消費税']});
  const text = errorsOf(outside);
  assert.match(text, /categories\[13\]\.to「L」は決まった行き先/);
  assert.match(text, /categories\[14\]\.to「tax」は決まった行き先/);
  const empty = clone(CODE_DETAIL);
  empty.categories[2].words = ['企画', '', '　'];
  const emptyText = errorsOf(empty);
  assert.match(emptyText, /categories\[2\]\.words\[1\] が空です/);
  assert.match(emptyText, /categories\[2\]\.words\[2\] が空です/);
  const noWords = clone(CODE_DETAIL);
  noWords.categories[0].words = [];
  assert.match(errorsOf(noWords), /categories\[0\]\.words は1つ以上の語の一覧/);
  const twoKinds = clone(BLOCKS);
  twoKinds.totals[0].contains = ['直接'];
  assert.match(errorsOf(twoKinds), /totals\[0\] は当て方を1つだけ/);
  const prefixCategory = clone(CODE_DETAIL);
  prefixCategory.categories[0] = {to: 'managementFee', prefix: ['制作管理']};
  assert.match(errorsOf(prefixCategory), /categories\[0\] の当て方「prefix」はここでは使えません（words）/);
  const overlap = clone(BLOCKS);
  overlap.header.roles.unitPrice = ['単価', '金額(税抜)'];
  assert.match(errorsOf(overlap), /見出しの語「金額税抜」が/);
  const parens = clone(BLOCKS);
  parens.header.roles.actual = ['（ ）'];
  assert.match(errorsOf(parens), /header\.roles\.actual\[0\] が空です/); // 見出しの語は括弧・空白を消して照らすので、括弧だけの語は空
  assert.match(errorsOf({...clone(BLOCKS), confirmedFills: ['yellow']}), /confirmedFills は16進6桁の色/);
});

test('FR-PLAN-BUDGET-036 定義の語に正規表現の記号を書いても、ただの文字として当てる（「企.*」は「企画費」に当たらず「企.*費」には当たる）', () => {
  const definition = clone(CODE_DETAIL);
  definition.categories = [{to: 'A', words: ['企.*']}, {to: 'B', words: ['(a+)+$']}, {to: 'C', words: ['^producer|staff']}];
  const compiled = compileBudgetReadDefinition(definition);
  assert.equal(firstTarget(compiled.categories, '企画費'), null);
  assert.equal(firstTarget(compiled.categories, '企.*費'), 'A');
  // 入れ子の繰り返しの形も、ただの文字の照らしなので長い文字でもすぐ終わる（正規表現として実行しない）
  const started = process.hrtime.bigint();
  assert.equal(firstTarget(compiled.categories, `${'a'.repeat(50000)}!`), null);
  assert.ok(process.hrtime.bigint() - started < 1000000000n, '1秒以内');
  assert.equal(firstTarget(compiled.categories, 'x (a+)+$ y'), 'B');
  assert.equal(firstTarget(compiled.categories, 'producer'), null);
  assert.equal(firstTarget(compiled.categories, 'staff'), null);
  assert.equal(firstTarget(compiled.categories, 'the ^producer|staff list'), 'C');
});

test('FR-PLAN-BUDGET-036 区分の語は日本語を部分一致、英字だけの語を語の境で当て、上から順に最初に当たった行き先を返す', () => {
  const compiled = compileBudgetReadDefinition(CODE_DETAIL);
  const category = (label) => firstTarget(compiled.categories, label);
  assert.equal(category('Additional'), null); // additional の中の dit・add は語の境でない
  assert.equal(category('DIT費'), 'J'); // 英字の語のすぐ後ろが漢字なら語の境
  assert.equal(category('ＤＩＴ'), 'J'); // 全角は NFKC で半角にして当てる
  assert.equal(category('Talents'), null); // talent の後ろに s が続く形は語の境でない（語を並べて書く）
  assert.equal(category('Producers'), 'C');
  assert.equal(category('pre-production'), 'E');
  assert.equal(category('制作管理費（キャスト分）'), 'managementFee'); // 上の行が先に当たる
  assert.equal(category('ロケ弁'), 'H');
});

test('FR-PLAN-BUDGET-037 使用中の版は、最後の判定が承認の版のうち番号の最も大きいもので、判定の無い版・差し戻した版は使わず、定義の作られた順に並べる', () => {
  const row = (profileId, versionNo, latestAction) => ({profileId, profileName: `定義${profileId}`, versionId: profileId * 100 + versionNo, versionNo,
    definitionJson: JSON.stringify({kind: 'budget', name: `定義${profileId}`, v: versionNo}), definitionHash: 'f'.repeat(64), latestAction});
  const chosen = inUseReadVersions([row(7, 1, 'approve'), row(7, 2, 'approve'), row(7, 3, null), row(3, 1, 'approve'), row(3, 2, 'reject'), row(9, 1, 'reject')]);
  assert.deepEqual(chosen.map((c) => [c.profileId, c.versionNo, c.readVersionId, c.definition.v]), [[3, 1, 301, 1], [7, 2, 702, 2]]);
  assert.deepEqual(inUseReadVersions([row(1, 1, null), row(2, 1, 'reject')]), []);
  // 使用中の版が無ければ読まない（受け口は 422 にする）。定義が検査を通らなければ止める
  const bytes = buildBudgetXlsx(fictionalBudgetSheets());
  assert.throws(() => readBudgetFile(bytes, {definitions: []}), /使用中の読み取りの定義がありません/);
  assert.throws(() => readBudgetFile(bytes, {definitions: [{name: '壊れた定義', definition: {...clone(BLOCKS), read: {layout: 'any'}}}]}), /読み取りの定義が正しくありません/);
});

test('FR-PLAN-BUDGET-037 渡した定義だけで読む: 区画の定義だけなら Code・Detail・Description の書式は形違い、見出しの語を変えた定義なら変えた語の見出しで読み、読めた定義を結果に残す', () => {
  const bytes = buildBudgetXlsx(fictionalBudgetSheets());
  const seeded = readBudgetFile(bytes);
  assert.deepEqual(seeded.readDefinition, {readVersionId: null, name: '科目・金額(税抜)の区画', versionNo: 1});
  const onlyCodeDetail = readBudgetFile(bytes, {definitions: [{readVersionId: 12, name: 'Code・Detail・Description', versionNo: 1, definition: CODE_DETAIL}]});
  assert.deepEqual([onlyCodeDetail.ok, onlyCodeDetail.reason], [false, 'no_header']);
  assert.match(onlyCodeDetail.message, /読み取りの定義（Code・Detail・Description）/);
  const renamed = clone(BLOCKS);
  renamed.header.roles.name = ['費目名'];
  const notFound = readBudgetFile(bytes, {definitions: [{readVersionId: 21, name: '費目名の区画', versionNo: 2, definition: renamed}]});
  assert.equal(notFound.ok, false); // 架空の予算書の見出しは「科目」なので、「費目名」だけの定義では見出しが見つからない
  const noFill = clone(BLOCKS);
  noFill.confirmedFills = [];
  const plain = readBudgetFile(bytes, {definitions: [{readVersionId: 22, name: '色なし', versionNo: 3, definition: noFill}]});
  assert.deepEqual(plain.readDefinition, {readVersionId: 22, name: '色なし', versionNo: 3});
  assert.equal(seeded.lines.find((l) => l.name === '主演').confirmed, true);
  assert.equal(plain.lines.find((l) => l.name === '主演').confirmed, false); // 確定の印の色も定義から読む
});

test('FR-PLAN-BUDGET-041 定義をどう書いても、円未満の端数の額と値の無い数式は例外のまま、区分の小計と総合計は明細から照らして食い違いを例外にする', () => {
  // 語を足した定義・合計の行の語を外した定義・初期値の3つで、同じ原本を読む
  const loose = clone(BLOCKS);
  loose.header.roles.name.push('項目');
  loose.totals.push({to: 'total', contains: ['合計']});
  // 合計の行の語を、どの行にも当たらない語にした定義（行き先は持つので検査は通る）
  const noTotals = clone(BLOCKS);
  noTotals.totals = [{to: 'total', equals: ['架空のどこにも無い総合計']}, {to: 'managementFee', equals: ['架空のどこにも無い管理費']}];
  const cells = [
    {ref: 'D5', value: '科目'}, {ref: 'E5', value: '金額（税抜）'}, {ref: 'F5', value: '数量'}, {ref: 'G5', value: '単価'},
    {ref: 'D6', value: '脚本料'}, {ref: 'E6', value: 300000}, {ref: 'F6', value: 1}, {ref: 'G6', value: 300000},
    {ref: 'D7', value: '機材'}, {ref: 'E7', value: null, formula: 'G7*F7'},
    {ref: 'D8', value: '照明'}, {ref: 'E8', value: 100000.5, formula: 'G8*F8'},
    {ref: 'D9', value: 'A 企画費'}, {ref: 'F9', value: '小計'}, {ref: 'E9', value: 350000},
  ];
  for (const [name, definition] of [['初期値', BLOCKS], ['語を足した', loose], ['合計の語が当たらない', noTotals]]) {
    const parsed = readBudgetFile(buildBudgetXlsx([{name: 'Sheet1', cells}]), {definitions: [{name, definition}]});
    assert.equal(parsed.ok, true, name);
    assert.deepEqual(parsed.fractional, ['E8'], name); // 丸めて読まない
    assert.deepEqual(parsed.withoutValue, ['E7'], name);
    assert.deepEqual(parsed.lines.map((l) => [l.categoryCode, l.amountExTaxYen]), [['A', 300000]], name);
    const {checks} = checkParsedBudget(parsed);
    assert.deepEqual(checks.find((c) => c.key === 'subtotal:A'), {key: 'subtotal:A', ok: false, label: 'A 企画費の小計', statedYen: 350000, derivedYen: 300000, cell: 'E9'}, name);
    assert.deepEqual(budgetVerdict(checks).failedKeys, ['subtotal:A', 'without_value', 'fractional_yen'], name);
  }
  // 区画の読み方では、区分は行の名前の先頭の英字（A〜K）と小計の並びだけで決まり、定義に区分の行き先を書けない（L は区分違いの例外）
  const parsed = readBudgetFile(buildBudgetXlsx([{name: 'Sheet1', cells: [...cells.slice(0, 8), {ref: 'D9', value: 'L 雑費'}, {ref: 'F9', value: '小計'}, {ref: 'E9', value: 300000}]}]),
    {definitions: [{name: '語を足した', definition: loose}]});
  assert.deepEqual(parsed.unknownSubtotals.map((r) => r.cell), ['D9']);
  assert.equal(parsed.lines.length, 0);
});

test('FR-PLAN-BUDGET-036 読み方・行き先・役・当て方・キーに Object の継承の名前（constructor・toString・__proto__・hasOwnProperty）を書いても、例外で落ちずに定義の検査で断る', () => {
  const PROTO = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
  // JSON から読んだ定義と同じ形にする（__proto__ も自分のキーになる）
  const parsed = (text) => JSON.parse(text);
  const blocks = JSON.stringify(BLOCKS);
  const codeDetail = JSON.stringify(CODE_DETAIL);
  const cases = [];
  for (const name of PROTO) {
    const q = JSON.stringify(name);
    cases.push(
      [`read.layout=${name}`, parsed(blocks.replace('"layout":"category_blocks"', `"layout":${q}`))],
      [`read.subtotal=${name}`, parsed(blocks.replace('"subtotal":"marker_row"', `"subtotal":${q}`))],
      [`read.category=${name}`, parsed(codeDetail.replace('"category":"words_then_line_majority"', `"category":${q}`))],
      [`header.roles の役=${name}`, parsed(blocks.replace('"roles":{', `"roles":{${q}:["架空の見出し"],`))],
      [`totals の行き先=${name}`, parsed(blocks.replace('{"to":"direct"', `{"to":${q}`))],
      [`categories の行き先=${name}`, parsed(codeDetail.replace('{"to":"A"', `{"to":${q}`))],
      [`当て方の名前=${name}`, parsed(blocks.replace('"notes":{"contains"', `"notes":{${q}`))],
      [`breakdown のキー=${name}`, parsed(blocks.replace('"breakdown":{', `"breakdown":{${q}:{"contains":["架空"]},`))],
      [`定義のキー=${name}`, parsed(blocks.replace('{"kind"', `{${q}:1,"kind"`))],
    );
  }
  for (const [label, definition] of cases) {
    let checked;
    assert.doesNotThrow(() => { checked = checkBudgetReadDefinition(definition); }, label);
    assert.equal(checked.ok, false, label);
    assert.ok(checked.errors.length > 0, label);
  }
  for (const value of [null, [], 'budget', 1]) assert.deepEqual(checkBudgetReadDefinition(value), {ok: false, errors: ['定義は JSON のオブジェクトにしてください']});
});

test('FR-PLAN-BUDGET-041 合計の行き先を持たない定義を断る（区画の読み方は totals に総合計と制作管理費、Code・Detail・Description は grandTotal）', () => {
  const noTotals = clone(BLOCKS);
  delete noTotals.totals;
  assert.match(errorsOf(noTotals), /totals がありません/);
  const noSummaryNoTotals = clone(noTotals);
  delete noSummaryNoTotals.summary;
  assert.match(errorsOf(noSummaryNoTotals), /totals がありません/);
  const withoutTotal = clone(BLOCKS);
  withoutTotal.totals = withoutTotal.totals.filter((rule) => rule.to !== 'total');
  assert.match(errorsOf(withoutTotal), /totals に total の行き先がありません/);
  const withoutFee = clone(BLOCKS);
  withoutFee.totals = withoutFee.totals.filter((rule) => rule.to !== 'managementFee');
  assert.match(errorsOf(withoutFee), /totals に managementFee の行き先がありません/);
  const noGrandTotal = clone(CODE_DETAIL);
  delete noGrandTotal.grandTotal;
  assert.match(errorsOf(noGrandTotal), /grandTotal がありません/);
  // 直接制作費・予備費・小計の行き先は無くてもよい（原本に無い予算書がある）
  const minimal = clone(BLOCKS);
  minimal.totals = minimal.totals.filter((rule) => ['total', 'managementFee'].includes(rule.to));
  assert.equal(checkBudgetReadDefinition(minimal).ok, true);
});

test('FR-PLAN-BUDGET-041 見出しの金額の役に税込の列の語を当てた定義で読んでも、原本の見積り・消費税・税込の照合で例外になる', () => {
  const taxIncluded = clone(BLOCKS);
  taxIncluded.header.roles.amount = ['金額(税込)'];
  delete taxIncluded.header.roles.amountIncTax;
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()), {definitions: [{name: '税込を金額にした', definition: taxIncluded}]});
  assert.equal(parsed.ok, true);
  const {checks} = checkParsedBudget(parsed);
  // 架空の予算書は税込の列に額が無いので明細は0行。総合計の行の額も読めず（照合は飛ばす）、見出しの上の見積り・消費税・税込が明細の額と合わない
  assert.equal(parsed.lines.length, 0);
  assert.equal(checks.find((c) => c.key === 'total').ok, null);
  assert.deepEqual(budgetVerdict(checks).failedKeys, ['estimate', 'tax', 'total_inc_tax']);
});

test('FR-PLAN-BUDGET-036 記号だけの語と英数字1字の語を断り、日本語は1字でも通す（見出しの「数」）', () => {
  const symbols = clone(CODE_DETAIL);
  symbols.categories[0].words = ['-', '・', '!?'];
  const text = errorsOf(symbols);
  assert.match(text, /categories\[0\]\.words\[0\]「-」は記号だけの語/);
  assert.match(text, /categories\[0\]\.words\[1\]「・」は記号だけの語/); // 区分の語は「・」を消さずに照らすので、空でなく記号だけ
  assert.match(text, /categories\[0\]\.words\[2\]「!\?」は記号だけの語/);
  const single = clone(CODE_DETAIL);
  single.categories[1].words = ['a', '7', 'ｂ'];
  const singleText = errorsOf(single);
  assert.match(singleText, /words\[0\]「a」は英数字1字の語/);
  assert.match(singleText, /words\[1\]「7」は英数字1字の語/);
  assert.match(singleText, /words\[2\]「ｂ」は英数字1字の語/); // 全角も NFKC で半角の1字
  const twoLetters = clone(CODE_DETAIL);
  twoLetters.categories[1].words = ['cg', '宣'];
  assert.equal(checkBudgetReadDefinition(twoLetters).ok, true);
  assert.equal(CODE_DETAIL.header.roles.qty.includes('数'), true);
  assert.equal(checkBudgetReadDefinition(CODE_DETAIL).ok, true);
});

test('FR-PLAN-BUDGET-042 検査を通らない定義は飛ばして残りの定義で読み、飛ばした定義の名前・版・誤りを返す。1つも通らなければ止める', () => {
  const broken = {readVersionId: 31, name: '壊れた区画', versionNo: 4, definition: {...clone(BLOCKS), read: {layout: 'any_grid'}}};
  const seeds = BUDGET_READ_SEEDS.map((seed, i) => ({readVersionId: 10 + i, name: seed.name, versionNo: 1, definition: seed.definition}));
  const parsed = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()), {definitions: [broken, ...seeds]});
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.readDefinition, {readVersionId: 10, name: '科目・金額(税抜)の区画', versionNo: 1});
  assert.deepEqual(parsed.skippedDefinitions.map(({readVersionId, name, versionNo}) => [readVersionId, name, versionNo]), [[31, '壊れた区画', 4]]);
  assert.match(parsed.skippedDefinitions[0].errors.join(), /read\.layout「any_grid」/);
  assert.deepEqual(readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets())).skippedDefinitions, []);
  // 読める定義で形違いのときも、飛ばした定義を返す
  const shape = readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()), {definitions: [broken, seeds[1]]});
  assert.deepEqual([shape.ok, shape.reason, shape.skippedDefinitions.map((s) => s.name)], [false, 'no_header', ['壊れた区画']]);
  assert.throws(() => readBudgetFile(buildBudgetXlsx(fictionalBudgetSheets()), {definitions: [broken]}), /読み取りの定義が正しくありません: 壊れた区画 版4（/);
});
