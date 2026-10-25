// 経費の読み取り（DB の役）。経費集計シートの検査に使う件数の読み取りを置く。
import {expenseSource} from './expense-read.mjs';
import {countCategoryMismatch} from './expense-model.mjs';

// 費目の自由文（expenses.category）と、明細の最新の会計の版が指す費用区分の版の名前の食い違いの件数（計画の裁定4 (a)・E-6）。
// 組織の取消していない全明細を数える（権限の絞り込みはしない。呼ぶ側が管理者に限る）。自由文は変えない（ロイヤリティの控除が完全一致で読む）
export async function expenseCategoryMismatch(db, orgId) {
  const [expenses, accounting, categories, aliases] = await Promise.all([
    db.all(`SELECT e.id,e.category FROM ${expenseSource()} e WHERE e.org_id=?`, [orgId]),
    db.all('SELECT expense_id,version_no,active,category_version_id FROM expense_accounting_versions WHERE org_id=? ORDER BY version_no', [orgId]),
    db.all('SELECT id,category_id,name FROM expense_category_versions WHERE org_id=?', [orgId]),
    db.all('SELECT alias_text,version_no,active,category_version_id FROM expense_category_alias_versions WHERE org_id=? ORDER BY version_no', [orgId]),
  ]);
  return countCategoryMismatch({expenses, accounting, categories, aliases});
}
