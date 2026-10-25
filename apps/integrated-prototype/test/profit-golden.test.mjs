// 会社への利益額（K-16）の純関数（src/accounting/profit/profit-model.mjs の buildCompanyProfit）に、架空の種と入金の確認の請求から写した記録を渡し、
// golden（test/fixtures/yojitsu/expected.json の「利益額」。golden.py が種から独立に計算した値）と計上・入金の両方で不一致0であることを確かめる
// （フェーズ1の仕様書 #14b の受け入れ基準）。費目の状態（確定・未確定・除外）と向きも golden の費目の表と同じ（理由の文は種の言い回しを含むので比べない）。
// golden の「除外」のうち「出資の実績の行」は、種の実績の表が出資の記録の払込を二重に持つ行で、統合システムの記録には無い（払込の記録1つ）ので比べない
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCompanyProfit, PROFIT_ITEMS, STATUS_LABELS} from '../src/accounting/profit/profit-model.mjs';
import {yojitsuGolden, yojitsuSeed} from './yojitsu-view-fixture.mjs';
import {asGoldenBasis, goldenBasis, profitRecordsFromSeed, SEED_ONLY_EXCLUDED} from './profit-fixture.mjs';

const golden = yojitsuGolden().利益額;
const records = profitRecordsFromSeed(yojitsuSeed());

for (const basis of ['accrual', 'cash']) {
  test(`FR-ACCT-PROFIT-001 FR-ACCT-PROFIT-003 FR-ACCT-PROFIT-004 FR-ACCT-PROFIT-005 FR-ACCT-PROFIT-006 FR-ACCT-PROFIT-008 FR-ACCT-PROFIT-010 架空の種の利益額は ${basis === 'cash' ? '入金' : '計上'}の基準で golden と不一致0（確定・未確定・除外・案件不明・案件別）`, () => {
    const view = buildCompanyProfit(records, {basis});
    assert.equal(view.basis, basis);
    assert.equal(view.taxLabel, '税別');
    assert.deepEqual(asGoldenBasis(view), goldenBasis(golden, basis));
    // 確定の利益額＝売上−経費（月ごと・合計）
    assert.deepEqual(view.settled.profitYen, view.settled.salesYen.map((s, i) => s - view.settled.costYen[i]));
    // 記録を全部渡したので未接続の費目は無い
    assert.deepEqual(view.unconnected, []);
  });
}

test('FR-ACCT-PROFIT-005 利益額の費目の状態（確定・未確定・除外）と向き（売上・経費）は golden の費目の表と同じ', () => {
  const byLabel = new Map(PROFIT_ITEMS.map((item) => [item.label, item]));
  for (const g of golden.費目) {
    if (g.費目 === SEED_ONLY_EXCLUDED) continue;
    const item = byLabel.get(g.費目);
    assert.ok(item, `${g.費目} が利益額の費目に無い`);
    assert.equal(STATUS_LABELS[item.status], g.状態, g.費目);
    assert.equal(item.side === 'sales' ? '売上' : '経費', g.向き, g.費目);
  }
});

test('FR-ACCT-PROFIT-001 計上と入金の月の軸は同じ（基準を切り替えても列がずれない）', () => {
  assert.deepEqual(buildCompanyProfit(records, {basis: 'accrual'}).months, buildCompanyProfit(records, {basis: 'cash'}).months);
  assert.deepEqual(buildCompanyProfit(records, {basis: 'cash'}).months, golden.月);
});
