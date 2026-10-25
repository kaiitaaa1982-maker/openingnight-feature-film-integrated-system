// 月次の報告（春川の単位）の純関数の試験。架空の会社PL・会社BS の応答を手で作り、期待する値は手で計算した。
import test from 'node:test';
import assert from 'node:assert/strict';
import {shiftMonth, monthlyQueries, rateBps, bpsLabel, exceedsThreshold, buildMonthlyReport, monthlySheets} from '../src/pl-bs/monthly-report-model.mjs';

const plOf = (byKey) => ({columns: [], rows: Object.entries(byKey).map(([key, values]) => ({key, values: Object.fromEntries(Object.entries(values).map(([m, v]) => [`m:${m}`, v]))}))});
// 2026-04 と、先月 2026-03・前年同月 2025-04（架空）
const PL = plOf({
  'total:sales': {'2026-04': 18240000, '2026-03': 16900000, '2025-04': 20000000},
  'total:cogs': {'2026-04': 11960000, '2026-03': 11150000, '2025-04': 11960000},
  grossProfit: {'2026-04': 6280000, '2026-03': 5750000, '2025-04': 8040000},
  'total:sga': {'2026-04': 1830000, '2026-03': 1660000, '2025-04': 1800000},
  operatingProfit: {'2026-04': 4450000, '2026-03': 4090000, '2025-04': 6240000},
  ordinaryProfit: {'2026-04': 4300000, '2026-03': 3950000, '2025-04': 6100000},
  netIncome: {'2026-04': 4300000, '2026-03': 3950000, '2025-04': 6100000},
});
const bsOf = (rows) => ({asOf: '', rows, difference: 0, unavailable: false});
const CURRENT_BS = bsOf([
  {key: 'cash', section: 'asset', label: '現預金', value: 8640000},
  {key: 'receivable', section: 'asset', label: '売掛金', value: 7260000},
  {key: 'total:asset', section: 'asset', label: '資産の部（計）', value: 15900000, emphasis: true},
  {key: 'difference', section: 'difference', label: '説明のつかない差額', value: 0},
]);
const PREV_BS = bsOf([
  {key: 'cash', section: 'asset', label: '現預金', value: 9000000},
  {key: 'receivable', section: 'asset', label: '売掛金', value: 6200000},
  {key: 'total:asset', section: 'asset', label: '資産の部（計）', value: 15200000},
]);
const body = (extra = {}) => ({companyPl: PL, companyBs: CURRENT_BS, profile: {legalName: '架空データ映像株式会社（架空）'}, conditions: {fiscalConfirmed: true}, ...extra});

test('FR-ACCT-MONTHLY-001 月をずらす・読む条件（PL は前年同月から当月、BS は当月末と前の月末、どちらも計上）', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-04', -12), '2025-04');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.throws(() => shiftMonth('2026-4', 1));
  assert.deepEqual(monthlyQueries('2026-04'), {
    current: {from: '2025-04', to: '2026-04', asOf: '2026-04', basis: 'accrual'},
    previous: {from: '2026-03', to: '2026-03', asOf: '2026-03', basis: 'accrual'},
  });
});

test('FR-ACCT-MONTHLY-002 率は bp の整数で 0 の向きへ切り捨て、表示は小数1桁', () => {
  assert.equal(rateBps(6280000, 18240000), 3442); // 34.429…%
  assert.equal(rateBps(-1760000, 20000000), -880);
  assert.equal(rateBps(1, 3), 3333);
  assert.equal(rateBps(-1, 3), -3333);
  assert.equal(rateBps(5, 0), null);
  assert.equal(rateBps(null, 5), null);
  assert.equal(bpsLabel(3442), '34.4%');
  assert.equal(bpsLabel(-880), '−8.8%');
  assert.equal(bpsLabel(5), '0.0%');
  assert.equal(bpsLabel(null), '—');
});

test('FR-ACCT-MONTHLY-003 課題の基準: |差| ≥ 50万円 か |差| ≥ |比べる値|×5%（境目の両側）', () => {
  assert.equal(exceedsThreshold(500000, 100000000), true, '50万円ちょうどは超えた扱い');
  assert.equal(exceedsThreshold(499999, 100000000), false, '50万円未満で 5% 未満');
  assert.equal(exceedsThreshold(50000, 1000000), true, '5% ちょうど');
  assert.equal(exceedsThreshold(49999, 1000000), false, '5% 未満');
  assert.equal(exceedsThreshold(-60000, 1000000), true, '減る向きも同じ');
  assert.equal(exceedsThreshold(100, 0), false, '比べる値が 0 で 50万円未満は候補にしない');
  assert.equal(exceedsThreshold(0, 1000), false);
  assert.equal(exceedsThreshold(null, 1000), false);
});

test('FR-ACCT-MONTHLY-001 PL の行・粗利率・先月と前年同月との差（手で計算した値）', () => {
  const r = buildMonthlyReport({month: '2026-04', currentBody: body(), previousBody: {companyBs: PREV_BS}});
  const sales = r.plRows.find((row) => row.key === 'total:sales');
  assert.deepEqual([sales.actual, sales.prev, sales.lastYear, sales.diffPrev, sales.diffLastYear], [18240000, 16900000, 20000000, 1340000, -1760000]);
  assert.equal(sales.ratePrevBps, 792);   // 1,340,000 ÷ 16,900,000 = 7.928…%
  assert.equal(sales.rateLastYearBps, -880);
  assert.deepEqual(r.grossRate, {actual: 3442, prev: 3402, lastYear: 4020});
  assert.deepEqual(r.kpis.map((k) => [k.key, k.value, k.diffPrev]), [['sales', 18240000, 1340000], ['gross', 6280000, 530000], ['grossRate', 3442, 40], ['operating', 4450000, 360000]]);
});

test('FR-ACCT-MONTHLY-003 課題の候補: 基準を超えた行だけ・悪い向きを先に・額の大きい順。売掛金の増えも候補', () => {
  const r = buildMonthlyReport({month: '2026-04', currentBody: body(), previousBody: {companyBs: PREV_BS}});
  const keys = r.issues.map((i) => i.key);
  // 悪い向き（額の大きい順）: 営業利益 前年同月 −1,790,000、売上・粗利 前年同月 −1,760,000、
  // 売掛金 先月 +1,060,000、売上原価 先月 +810,000（費用の増え）、販管費 先月 +170,000（10.2%）
  assert.deepEqual(keys.filter((k) => r.issues.find((i) => i.key === k).worse), [
    'operatingProfit:前年同月', 'total:sales:前年同月', 'grossProfit:前年同月', 'receivable:先月', 'total:cogs:先月', 'total:sga:先月']);
  assert.ok(!keys.some((k) => k.startsWith('ordinaryProfit') || k.startsWith('netIncome')), '経常利益・当期純利益は候補にしない（営業利益と重なる）');
  // 良い向き: 売上 先月 +1,340,000・売上原価 先月 +810,000（費用が増えたので悪い）・粗利 先月 +530,000 など
  assert.ok(keys.includes('total:cogs:先月'));
  assert.equal(r.issues.find((i) => i.key === 'total:cogs:先月').worse, true, '費用の行は増えると悪い');
  assert.equal(r.issues.find((i) => i.key === 'total:sales:先月').worse, false);
  // 販管費の先月との差 +170,000 は 50万円未満で、10.2% なので候補。前年同月との差 +30,000（1.6%）は候補にしない
  assert.ok(keys.includes('total:sga:先月'));
  assert.ok(!keys.includes('total:sga:前年同月'));
  assert.ok(!keys.includes('total:cogs:前年同月'), '差 0 は候補にしない');
  const worseFirst = r.issues.findIndex((i) => !i.worse);
  assert.ok(r.issues.slice(worseFirst).every((i) => !i.worse), '悪い向きが先にまとまる');
});

test('FR-ACCT-MONTHLY-004 BS: 月末と前の月末の増減。説明のつかない差額の行は出さない', () => {
  const r = buildMonthlyReport({month: '2026-04', currentBody: body(), previousBody: {companyBs: PREV_BS}});
  assert.deepEqual(r.bsRows.map((row) => [row.key, row.value, row.prev, row.diff]), [['cash', 8640000, 9000000, -360000], ['receivable', 7260000, 6200000, 1060000], ['total:asset', 15900000, 15200000, 700000]]);
});

test('FR-ACCT-MONTHLY-004 FR-ACCT-MONTHLY-006 出せないときは額を作らず理由を出す（権限なし・BS の基準月が期首より前・先月の BS が無い）', () => {
  const none = buildMonthlyReport({month: '2026-04', currentBody: {companyPl: null, companyBs: null, companyNote: '会社PL・会社BSは管理者だけ'}, previousBody: null});
  assert.ok(none.plRows.every((row) => row.actual === null));
  assert.deepEqual(none.issues, []);
  assert.ok(none.notes.includes('会社PL・会社BSは管理者だけ'));
  const early = buildMonthlyReport({month: '2026-04', currentBody: body({companyBs: {unavailable: true, reason: '期首残高の基準月より前'}}), previousBody: null});
  assert.deepEqual(early.bsRows, []);
  assert.ok(early.notes.includes('期首残高の基準月より前'));
  const noPrev = buildMonthlyReport({month: '2026-04', currentBody: body(), previousBody: {companyBs: {unavailable: true, reason: 'x'}}});
  assert.ok(noPrev.bsRows.every((row) => row.prev === null && row.diff === null), '前の月末が無ければ増減は空（0円にしない）');
  assert.ok(!noPrev.issues.some((i) => i.rowKey === 'receivable'));
});

test('FR-ACCT-MONTHLY-005 Excel・印刷のシートに画面と同じ値と、書いた原因・打ち手が載る', () => {
  const r = buildMonthlyReport({month: '2026-04', currentBody: body(), previousBody: {companyBs: PREV_BS}});
  const key = r.issues[0].key;
  const sheets = monthlySheets(r, {[key]: {cause: '新作の公開が5月へずれた（架空）', action: '5月に移す', due: '2026-05-31'}});
  assert.deepEqual(sheets.map((s) => s.sheetName ?? s.name), ['PL', 'BS', '課題']);
  const flat = JSON.stringify(sheets);
  assert.ok(flat.includes('新作の公開が5月へずれた（架空）'));
  assert.ok(flat.includes('18240000') || flat.includes('18,240,000'));
  const issueSheet = JSON.stringify(sheets[2]);
  assert.ok(!issueSheet.includes('売上高が先月より'), '良い向きで何も書いていない候補は報告に載せない');
  const withNote = monthlySheets(r, {'total:sales:先月': {cause: '新作が好調（架空）'}});
  assert.ok(JSON.stringify(withNote[2]).includes('新作が好調（架空）'), '良い向きでも書いたものは載る');
});
