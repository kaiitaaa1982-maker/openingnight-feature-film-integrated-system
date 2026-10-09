// 経費の予算対比（純関数）。金額は税抜の実績と予算。予算が無い費目は推測で埋めず「予算なし」とする。
// PL・BS での扱い（費用区分と勘定科目の対応による公開月に一括、ほかは計上月の費用）も費目ごとに並べる。
import {EXPENSE_CLASS_LABELS} from '../reports/pl-bs-model.mjs';

// 自社作品の制作費として公開月に一括で費用にする費目の名前（候補にいつも出す）
export const PRODUCTION_CATEGORY = '制作費';
export const EXPENSE_CATEGORY_HINT = 'PL・BSの科目と費用にする時期は、会計の設定の費用区分で決まります。費目の文字からは推測しません';

// 選んだ作品の経費と、同じ案件で作品を決めていない経費
export function expensesInScope(rows = [], work) {
  if (!work) return [];
  return rows.filter((row) => row.work_id === work.id || (row.work_id == null && row.project_id === work.project_id));
}

export function expenseBudgetRows(rows = []) {
  const byCategory = new Map();
  for (const row of rows) {
    const category = String(row.category || '').trim() || '（費目なし）';
    const entry = byCategory.get(category) || {category, budget: 0, hasBudget: false, actual: 0, count: 0};
    if (row.budget_yen != null && row.budget_yen !== '') { entry.budget += Number(row.budget_yen); entry.hasBudget = true; }
    entry.actual += Number(row.actual_ex_tax || 0);
    entry.count += 1;
    entry.classes??=new Set();entry.classes.add(row.expense_account_name??'費用区分未整備');
    byCategory.set(category, entry);
  }
  return [...byCategory.values()].map((entry) => {
    const remaining = entry.hasBudget ? entry.budget - entry.actual : null;
    const rate = entry.hasBudget && entry.budget > 0 ? entry.actual / entry.budget : null;
    let state;
    if (!entry.hasBudget) state = '予算なし';
    else if (remaining < 0) state = `予算超過（${(-remaining).toLocaleString('ja-JP')}円）`;
    else if (rate !== null && rate >= 0.9) state = '残りわずか';
    else state = '予算内';
    return {category: entry.category, budget: entry.hasBudget ? entry.budget : null, actual: entry.actual, remaining, rate, state, count: entry.count,
      plClass: [...entry.classes].join('／')};
  }).sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity) || a.category.localeCompare(b.category, 'ja'));
}

// 登録済みの費目（多い順）。入力の候補に使う。「制作費」は経費が無い組織でもいつも候補の先頭に出す
export function expenseCategories(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    const category = String(row.category || '').trim();
    if (category) counts.set(category, (counts.get(category) || 0) + 1);
  }
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).map(([category]) => category);
  return [...new Set([PRODUCTION_CATEGORY, ...used])];
}
