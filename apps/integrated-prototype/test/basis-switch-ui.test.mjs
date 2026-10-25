// 計上と入金の切り替え（フェーズ1の仕様書 #16）の画面の試験。全画面の見出しに基準を出すこと、既定は計上で会社の帳票は入金、
// 基準は URL（basis）に持つこと、会社PLの作品の行から作品別PL・作品別収支へ1クリックで同じ期間・同じ基準のまま開けることを確かめる。
// 期待値の出どころ: 計画の「計上と入金（全画面で同じ）」と香盤表 #16 の受け入れ基準。画面は esbuild で束ねて文字列に描く（作品別収支の文書の試験と同じ方法）
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readConditions, paramUpdates, conditionsToQuery, describeConditions, CONDITION_KEYS} from '../src/ui/condition-model.mjs';
import {parseLocation, buildSearch} from '../src/shell/url-state.mjs';
import {workPlColumns, WORK_PL_COLUMNS, currentBody, companyPlWorkRows, plBsSheets, basisHeading, BS_BASIS_HEADING, workOpeners, activeViewOf, headingBasisText, VIEWS}
  from '../src/pl-bs/pl-bs-view.mjs';
import {createLocalShell} from '../src/shell/context.mjs';
import {incomeLabels, unsettledSummary, incomeStatText, INCOME_CAUTION} from '../src/accounting/work-income/work-income-view-model.mjs';
import {buildPlBsForBasis} from '../src/reports/pl-bs-cash-model.mjs';
import {DEFAULT_ACCOUNTS} from '../src/reports/pl-bs-model.mjs';
import {buildWorkPnlDocument} from '../src/accounting/work-pnl/work-pnl-document.mjs';

const params = (object) => (key, fallback) => (Object.hasOwn(object, key) ? object[key] : fallback);
const CONDITIONS = ['fiscalYear', 'period', 'cashBasis', 'work'];

test('基準の条件: URL の basis に持ち、無ければ既定（計上。会社の帳票は入金）、読めない値は既定に戻し、API の問い合わせにそのまま渡す', () => {
  assert.equal(CONDITION_KEYS.cashBasis, 'basis');
  assert.equal(readConditions(params({}), CONDITIONS, {fiscalStartMonth: 5}).cashBasis, 'accrual');
  assert.equal(readConditions(params({}), CONDITIONS, {fiscalStartMonth: 5, defaults: {cashBasis: 'cash'}}).cashBasis, 'cash');
  assert.equal(readConditions(params({basis: 'cash'}), CONDITIONS, {fiscalStartMonth: 5}).cashBasis, 'cash');
  assert.equal(readConditions(params({basis: 'accrual'}), CONDITIONS, {fiscalStartMonth: 5, defaults: {cashBasis: 'cash'}}).cashBasis, 'accrual');
  assert.equal(readConditions(params({basis: 'sales'}), CONDITIONS, {fiscalStartMonth: 5, defaults: {cashBasis: 'cash'}}).cashBasis, 'cash', '年間売上の basis（販売月）は読まずに既定');
  assert.deepEqual(paramUpdates('cashBasis', 'cash'), [['basis', 'cash']]);
  const values = readConditions(params({basis: 'cash', period: 'custom', from: '2026-04', to: '2026-06', workId: '41'}), CONDITIONS, {fiscalStartMonth: 5});
  assert.equal(conditionsToQuery(values, CONDITIONS), 'from=2026-04&to=2026-06&basis=cash&workId=41');
  assert.deepEqual(describeConditions(values, ['cashBasis']), [['基準', '入金']]);
});

// 入金ベースの会社PL・作品別PLの応答（PL の純関数から作る）。作品A（自社）と作品C（委員会）
const ACCOUNTS = DEFAULT_ACCOUNTS.map((row, index) => ({...row, id: index + 1}));
function plBody(basis) {
  const input = {
    from: '2026-01', to: '2026-03', asOf: '2026-03', fiscal: {fiscalStartMonth: 5, confirmed: true}, profile: {selfPartnerId: 9, openingMonth: '2025-12'}, accounts: ACCOUNTS,
    works: [{id: 1, code: 'A', title: '作品A（架空）', committee: false, releaseMonth: '2026-03', releaseSource: 'window'}, {id: 3, code: 'C', title: '作品C（委員会・架空）', committee: true}],
    saleLines: [{saleId: 1, workId: 1, month: '2026-02', amount: 1000, tax: 100, channelGroup: 'theatrical'}],
    expenses: [], expensePayments: [], royaltyAccruals: [], royaltyPayments: [],
    committee: [{workId: 3, contractId: 1, committedYen: 2000, selfShareBps: 5000, acquisitions: []}],
    investmentPayments: [], committeeReceipts: [{workId: 3, receivedOn: '2026-03-20', amount: 100}], receipts: [], manual: [], mg: [],
    cashSide: {receiptAllocations: [{receiptId: 1, invoiceId: 1, amount: 1000, invoiceIncTax: 1100, receivedOn: '2026-03-31', reversedOn: null}],
      invoiceLines: [{invoiceId: 1, saleId: 1, exTax: 1000, incTax: 1100, workId: 1, bps: 10000}], expensePayments: []},
  };
  const report = buildPlBsForBasis(input, basis);
  return {...report, ok: true, conditions: report.conditions, companyPl: report.companyPl};
}

test('作品別PLの列: 入金は科目を入金の言い方にし、未確定（税込・利益に入れない）の列を足す。計上は従来の列のまま', () => {
  assert.equal(workPlColumns('accrual'), WORK_PL_COLUMNS);
  const cash = workPlColumns('cash');
  const label = (key) => cash.find((column) => column.key === key)?.label;
  assert.equal(label('sales'), '売上（自社作品・入金）');
  assert.equal(label('production'), '制作費（払った月）');
  assert.equal(label('unsettledIn'), '未確定の入金（税込・利益に入れない）');
  assert.equal(cash.findIndex((column) => column.key === 'unsettledIn'), cash.findIndex((column) => column.key === 'profit') + 1);
  const body = plBody('cash');
  const a = body.workPl.find((row) => row.workId === 1);
  assert.equal(cash.find((column) => column.key === 'unsettledIn').value(a), 1000, '請求額（1,100）と違う入金 1,000 は未確定');
  assert.equal(basisHeading('cash'), '基準: 入金（売上は入金日・経費は出金日の月・税抜。税抜にできない入出金は未確定）');
  assert.equal(basisHeading('accrual'), '基準: 計上（売上・経費は計上月・税抜）');
});

test('基準を切り替えて読み込み中のあいだ、前の基準の数字を出さない。Excel の条件に PL の基準を書く', () => {
  const body = plBody('cash');
  assert.equal(currentBody({body}, {from: '2026-01', to: '2026-03', asOf: '2026-03', basis: 'cash'}), body);
  assert.equal(currentBody({body}, {from: '2026-01', to: '2026-03', asOf: '2026-03', basis: 'accrual'}), null);
  const sheets = plBsSheets(body, 'company-pl');
  assert.deepEqual(sheets[0].conditions?.find?.((row) => row[0] === 'PLの基準') ?? sheets[0].exportSpec?.conditions?.find((row) => row[0] === 'PLの基準'),
    ['PLの基準', '入金（売上は入金日・経費は出金日の月・税抜。税抜にできない入出金は未確定）']);
});

test('会社PLから作品へ1クリック: 作品ごとの内訳の行が、同じ期間・同じ基準の作品別PL（作品の月別を開いた状態）と作品別収支の URL を持ち、開いた先の条件がそれを読む', () => {
  const body = plBody('cash');
  const rows = companyPlWorkRows(body);
  assert.deepEqual(rows.map((row) => row.workId), [1, 3]);
  const a = rows[0];
  assert.deepEqual(a.links.workPl, {report: 'work-pl', period: 'custom', from: '2026-01', to: '2026-03', basis: 'cash', plbsWork: '1'});
  assert.deepEqual(a.links.workPnl, {report: 'work-pnl', workId: '1', period: 'custom', from: '2026-01', to: '2026-03', basis: 'cash'});
  // 帳票センターへ移った先の URL から、作品別収支（WorkPnlReport の条件）と作品別PL（PlBsReport の条件・plbsWork）が同じ値を読む
  const pnl = parseLocation(buildSearch({page: '帳票センター', params: a.links.workPnl}));
  assert.equal(pnl.params.report, 'work-pnl');
  const pnlValues = readConditions(params(pnl.params), CONDITIONS, {fiscalStartMonth: 5});
  assert.deepEqual([pnlValues.workId, pnlValues.from, pnlValues.to, pnlValues.cashBasis], ['1', '2026-01', '2026-03', 'cash']);
  const pl = parseLocation(buildSearch({page: '帳票センター', params: a.links.workPl}));
  assert.equal(pl.params.plbsWork, '1');
  const plValues = readConditions(params(pl.params), ['fiscalYear', 'period', 'cashBasis'], {fiscalStartMonth: 5, defaults: {cashBasis: 'accrual'}});
  assert.deepEqual([plValues.from, plValues.to, plValues.cashBasis], ['2026-01', '2026-03', 'cash'], '作品別PLの既定（計上）でなく、会社PLと同じ入金で開く');
  assert.deepEqual(companyPlWorkRows({...body, companyPl: null}), [], '会社PLを見られない人には内訳を出さない');
});

// PlBsReport が会社PLの内訳のボタンに渡す手続き（workOpeners）。外枠の setParam・navigate を差し替えて、渡る値を見る。
// 壊れたら: plbsTab を取り違える・作品の ID を渡さない・帳票センターで作品別PLでなく PL・BS のタブを切り替える・期間や基準を表示中の応答から取らない、のどれでも落ちる
test('会社PLの作品の行の手続き: PL・BS の画面では作品別PLのタブに切り替えてその作品の月別を開き、帳票センターでは同じ期間・同じ基準の作品別PL・作品別収支を開く', () => {
  const body = plBody('cash');
  const row = companyPlWorkRows(body)[0];
  const recorder = () => {
    const calls = {setParam: [], navigate: []};
    const shell = createLocalShell({readOnly: false});
    const setParam = shell.setParam;
    shell.setParam = (...args) => { calls.setParam.push(args); setParam(...args); };
    return {shell, calls, navigate: (...args) => calls.navigate.push(args)};
  };
  const page = recorder();
  const onPage = workOpeners({shell: page.shell, navigate: page.navigate, fixedView: null, body});
  onPage.openWorkPl(row);
  assert.deepEqual(page.calls.setParam, [['plbsWork', '1', {replace: true}], ['plbsTab', 'work-pl', {replace: true}]]);
  assert.deepEqual(page.calls.navigate, [], 'PL・BS の画面の作品別PLは画面を移らない');
  assert.equal(activeViewOf(null, page.shell.getParam('plbsTab')), 'work-pl', '開いた先のタブは作品別PL');
  onPage.openWorkPnl(row);
  assert.deepEqual(page.calls.navigate, [['帳票センター', {report: 'work-pnl', workId: '1', period: 'custom', from: '2026-01', to: '2026-03', basis: 'cash'}]]);

  const center = recorder();
  const inCenter = workOpeners({shell: center.shell, navigate: center.navigate, fixedView: 'company-pl', body});
  inCenter.openWorkPl(row);
  inCenter.openWorkPnl(row);
  assert.deepEqual(center.calls.navigate, [
    ['帳票センター', {report: 'work-pl', period: 'custom', from: '2026-01', to: '2026-03', basis: 'cash', plbsWork: '1'}],
    ['帳票センター', {report: 'work-pnl', workId: '1', period: 'custom', from: '2026-01', to: '2026-03', basis: 'cash'}],
  ]);
  assert.deepEqual(center.calls.setParam, [], '帳票センターでは開いている帳票の条件を書き換えない');
  const accrual = recorder();
  workOpeners({shell: accrual.shell, navigate: accrual.navigate, fixedView: 'company-pl', body: plBody('accrual')}).openWorkPnl(row);
  assert.equal(accrual.calls.navigate[0][1].basis, 'accrual', '基準は表示中の応答のもの');
});

test('共通の見出しの基準の帯は PL 系のタブ（作品別PL・会社PL）だけ。開いているタブは帳票センターの1枚か URL の plbsTab（読めない値は最初のタブ）', () => {
  assert.equal(headingBasisText('company-pl', 'cash'), basisHeading('cash'));
  assert.equal(headingBasisText('work-pl', 'accrual'), basisHeading('accrual'));
  for (const view of ['work-balances', 'company-bs', 'manual', 'settings']) assert.equal(headingBasisText(view, 'cash'), null, view);
  assert.equal(activeViewOf('company-bs', 'work-pl'), 'company-bs');
  assert.equal(activeViewOf(null, 'company-bs'), 'company-bs');
  assert.equal(activeViewOf(null, 'unknown'), VIEWS[0].id);
  assert.equal(activeViewOf(null, null), VIEWS[0].id);
});

test('作品の月別収支の言葉: 見出しに基準を出し、入金は入金・出金・入金日の月と未確定の注意に切り替える', () => {
  const accrual = incomeLabels('accrual');
  assert.equal(accrual.heading, '基準: 計上（売上・経費は計上月・税抜）');
  assert.equal(accrual.caution, INCOME_CAUTION);
  const cash = incomeLabels('cash');
  assert.deepEqual([cash.basis, cash.revenue, cash.cost, cash.month], ['cash', '入金（税抜）', '出金（税抜）', '入金日・出金日の月']);
  assert.match(cash.caution, /未確定/);
  assert.equal(incomeLabels('sales').basis, 'accrual', '知らない値は計上');
  assert.equal(unsettledSummary({rows: [{}, {}], inflowYen: 19958, outflowYen: 4000}), '税抜にできない入出金（未確定・税込）: 入金 19,958円・出金 4,000円（2件）。差引に入れていません。');
  assert.equal(unsettledSummary({rows: [], inflowYen: 0, outflowYen: 0}), '');
});

test('作品の月別収支の合計の欄: 入金ベースで月の行が無く未確定（作品を決められない入金を含む）だけなら「未確定のみ」、何も無ければ「未登録」と出し、未確定だけの作品を未登録に見せない', () => {
  const format = (value) => `${value}円`;
  const empty = {rows: [], inflowYen: 0, outflowYen: 0, unattachedReceiptCount: 0};
  assert.equal(incomeStatText({monthly: [{month: '2026-05', revenue: 10000, cost: 0, profit: 10000}], unsettled: empty}, 10000, format), '10000円');
  assert.equal(incomeStatText({monthly: [], unsettled: {...empty, rows: [{}], inflowYen: 19958}}, 0, format), '未確定のみ');
  assert.equal(incomeStatText({monthly: [], unsettled: {...empty, unattachedReceiptCount: 1}}, 0, format), '未確定のみ', '作品を決められない入金だけの作品');
  assert.equal(incomeStatText({monthly: [], unsettled: empty}, 0, format), '未登録');
  assert.equal(incomeStatText({monthly: []}, 0, format), '未登録', '計上は未確定を持たない');
  assert.equal(unsettledSummary({...empty, unattachedReceiptCount: 2}), '請求明細の作品の配賦がそろわない入金が2件あり、作品を決められないため、ここに入れていません（会社PLの「未確定」に出ます）。');
  assert.equal(unsettledSummary({rows: [{}], inflowYen: 19958, outflowYen: 0, unattachedReceiptCount: 1}),
    '税抜にできない入出金（未確定・税込）: 入金 19,958円・出金 0円（1件）。差引に入れていません。請求明細の作品の配賦がそろわない入金が1件あり、作品を決められないため、ここに入れていません（会社PLの「未確定」に出ます）。');
});

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let rendered = null;
async function renderer() {
  rendered ??= (async () => {
    const {build} = await import('esbuild');
    const result = await build({
      stdin: {
        contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {LocalShellProvider} from './src/shell/context.mjs';\n"
          + "import {CompanyPlView, CompanyBsView, WorkPlView, WorkBalancesView, Heading, CompanyPlReport, CompanyBsReport, WorkPlReport, PlBsPage, companyWorkColumns} from './src/pl-bs/PlBsPage.jsx';\n"
          + "import {WorkPnlReportScreen} from './src/reports/WorkPnlReport.jsx'; import IncomeDashboard from './src/IncomeDashboard.jsx';\n"
          + 'const inShell = (initialParams, element) => renderToStaticMarkup(React.createElement(LocalShellProvider, {initialParams}, element));\n'
          + 'export const companyPl = (props) => inShell({}, React.createElement(CompanyPlView, props));\n'
          + 'export const companyBs = (props) => inShell({}, React.createElement(CompanyBsView, props));\n'
          + 'export const workPl = (props, params) => inShell(params, React.createElement(WorkPlView, props));\n'
          + 'export const workPnl = (props) => inShell({}, React.createElement(WorkPnlReportScreen, props));\n'
          + 'export const income = (props) => inShell({}, React.createElement(IncomeDashboard, props));\n'
          + 'export const workBalances = (props) => inShell({}, React.createElement(WorkBalancesView, props));\n'
          + 'export const heading = (props) => inShell({}, React.createElement(Heading, props));\n'
          + 'const REPORTS = {CompanyPlReport, CompanyBsReport, WorkPlReport, PlBsPage};\n'
          + 'export const report = (name, params = {}) => inShell(params, React.createElement(REPORTS[name], {data: {}}));\n'
          + 'export {companyWorkColumns};',
        resolveDir: appDir, loader: 'jsx', sourcefile: 'basis-switch-entry.jsx',
      },
      bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
    });
    const dir = mkdtempSync(join(tmpdir(), 'on-basis-ui-'));
    const file = join(dir, 'basis-ui.cjs');
    writeFileSync(file, result.outputFiles[0].text);
    try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
  })();
  return rendered;
}
async function loadRenderer(t) {
  try { return await renderer(); } catch (error) {
    if (/EPERM|EACCES|spawn/.test(String(error))) { t.skip('サンドボックスでは esbuild の子プロセスを起動できない'); return null; }
    throw error;
  }
}
const textOf = (html) => html.replace(/<[^>]+>/g, '');

test('会社PL・作品別PL・会社BS の見出しに基準を出し、会社PLの作品の行に作品別PL・作品別収支のボタンがあり、押すとその行の作品で開く', async (t) => {
  const ui = await loadRenderer(t);
  if (!ui) return;
  const body = plBody('cash');
  const html = ui.companyPl({body});
  assert.match(textOf(html), /基準: 入金（売上は入金日・経費は出金日の月・税抜。税抜にできない入出金は未確定）/);
  assert.match(textOf(html), /未確定の入金（税込・利益に入れない）/);
  for (const code of ['A', 'C']) {
    assert.match(html, new RegExp(`aria-label="${code}の作品別PLを開く"`));
    assert.match(html, new RegExp(`aria-label="${code}の作品別収支を開く"`));
  }
  // ボタンの押下（列の描画の onClick）が、その行の作品で開く手続きを1回呼ぶ
  const opened = [];
  const columns = ui.companyWorkColumns({onOpenWorkPl: (row) => opened.push(['pl', row.workId]), onOpenWorkPnl: (row) => opened.push(['pnl', row.workId])});
  const cell = columns.at(-1).render(companyPlWorkRows(body)[0]);
  const buttons = [cell.props.children].flat().filter((child) => child?.type === 'button');
  assert.equal(buttons.length, 2);
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(opened, [['pl', 1], ['pnl', 1]]);
  // 開いた先の作品別PL（plbsWork=1）は、その作品の月別を開いた状態で、見出しに基準を出す
  const workHtml = ui.workPl({body}, {plbsWork: '1'});
  assert.match(textOf(workHtml), /A｜作品A（架空）（自社作品）の月別/);
  assert.match(textOf(workHtml), /基準: 入金/);
  assert.doesNotMatch(textOf(ui.workPl({body}, {})), /の月別/, '作品を指していなければ月別は開かない');
  assert.match(textOf(ui.workPl({body: plBody('accrual')}, {})), /基準: 計上（売上・経費は計上月・税抜）/);
  assert.match(textOf(ui.companyBs({body})), new RegExp(BS_BASIS_HEADING.replace(/[()（）]/g, '.')));
});

test('作品別収支の画面と作品の月別収支の見出しに基準を出し、入金は未確定の表を出す', async (t) => {
  const ui = await loadRenderer(t);
  if (!ui) return;
  const work = {id: 41, code: 'W41', title: '架空の作品'};
  const base = {work, conditions: {workId: 41, from: '2026-05', to: '2026-06'}, dataAsOf: {latestImportAt: null}, lines: [], expenses: [], unallocatedExpenses: []};
  const accrualDoc = buildWorkPnlDocument(base, {sourceHash: 'a'.repeat(64)});
  assert.match(textOf(ui.workPnl({doc: accrualDoc, values: {workId: '41', from: '2026-05', to: '2026-06', cashBasis: 'accrual'}, works: [work]})), /基準: 計上（計上月・税抜）/);
  const cashDoc = buildWorkPnlDocument({...base, basis: 'cash', unsettled: [{kind: 'receipt', kindLabel: '入金', on: '2026-06-05', month: '2026-06', amount: 19958,
    reason: 'receipt_amount_differs', reasonLabel: '請求額と違う額の入金', ref: '入金 2・請求 2', category: null}]}, {sourceHash: 'b'.repeat(64)});
  const html = ui.workPnl({doc: cashDoc, values: {workId: '41', from: '2026-05', to: '2026-06', cashBasis: 'cash'}, works: [work]});
  assert.match(textOf(html), /基準: 入金（入金日・出金日の月・税抜）/);
  assert.match(html, /aria-label="未確定の入出金"/);
  assert.match(textOf(html), /請求額と違う額の入金/);
  assert.match(textOf(html), /未確定の入金・出金（税込）/);
  // 読み込み中に基準だけ先に変わっても、見出しは出している文書の基準
  assert.match(textOf(ui.workPnl({doc: cashDoc, values: {workId: '41', from: '2026-05', to: '2026-06', cashBasis: 'accrual'}, works: [work]})), /基準: 入金/);
  const monthly = [{month: '2026-05', revenue: 10000, cost: 5000, profit: 5000}];
  assert.match(textOf(ui.income({monthly, basis: 'cash'})), /基準: 入金（売上は入金日・経費は出金日の月・税抜。税抜にできない入出金は未確定）/);
  assert.match(textOf(ui.income({monthly, basis: 'cash'})), /入金日・出金日の月/);
  assert.match(textOf(ui.income({monthly})), /基準: 計上（売上・経費は計上月・税抜）/);
});

// 条件の「基準」の切り替えで押された（aria-pressed="true"）ボタンの文字
function pressedBasis(html) {
  const group = html.match(/role="group" aria-label="基準">(.*?)<\/div>/);
  assert.ok(group, '条件に「基準」の切り替えが無い');
  const pressed = [...group[1].matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.equal(pressed.length, 1, group[1]);
  return pressed[0];
}

// 受け入れ基準「会社の帳票は入金」を担う defaultBasis。帳票センターの部品を外枠の中で描き、条件の「基準」でどちらが押されているかを見る。
// 壊れたら: CompanyPlReport・CompanyBsReport の defaultBasis を計上に戻すと「入金」が押されずに落ちる
test('会社PL・会社BS の帳票は基準を入金で開き、作品別PLと PL・BS の画面は計上で開く。URL に基準があればそれに従う', async (t) => {
  const ui = await loadRenderer(t);
  if (!ui) return;
  assert.equal(pressedBasis(ui.report('CompanyPlReport')), '入金');
  assert.equal(pressedBasis(ui.report('CompanyBsReport')), '入金');
  assert.equal(pressedBasis(ui.report('WorkPlReport')), '計上');
  assert.equal(pressedBasis(ui.report('PlBsPage')), '計上');
  assert.equal(pressedBasis(ui.report('CompanyPlReport', {basis: 'accrual'})), '計上');
  assert.equal(pressedBasis(ui.report('WorkPlReport', {basis: 'cash'})), '入金', '会社PLから来た作品別PLは入金のまま');
});

test('PL・BS の共通の見出しは PL 系のタブだけに PL の基準を出し、作品別の残高・会社BS には BS の基準を出す（文言を重ねない）', async (t) => {
  const ui = await loadRenderer(t);
  if (!ui) return;
  const body = plBody('cash');
  const plText = basisHeading('cash');
  for (const view of ['company-pl', 'work-pl']) assert.ok(textOf(ui.heading({body, view})).includes(plText), view);
  for (const view of ['company-bs', 'work-balances', 'manual', 'settings']) {
    const text = textOf(ui.heading({body, view}));
    assert.ok(!text.includes('基準:'), `${view}: ${text}`);
    assert.match(text, /管理会計の試算/, '見出しの本体は出す');
  }
  assert.ok(textOf(ui.workBalances({body})).includes(BS_BASIS_HEADING), '作品別の残高に BS の基準');
  assert.ok(!textOf(ui.workBalances({body})).includes(plText));
  assert.ok(textOf(ui.companyBs({body})).includes(BS_BASIS_HEADING));
});
