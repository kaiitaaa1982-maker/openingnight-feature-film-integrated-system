import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseBudgetRows, expenseCategories, expensesInScope} from '../src/work/expenses-model.mjs';

const rows = [
  {id: 1, project_id: 1, work_id: 1, category: '撮影費', budget_yen: 100000, actual_ex_tax: 120000},
  {id: 2, project_id: 1, work_id: 1, category: '撮影費', budget_yen: null, actual_ex_tax: 5000},
  {id: 3, project_id: 1, work_id: null, category: '宣伝費', budget_yen: 50000, actual_ex_tax: 46000},
  {id: 4, project_id: 1, work_id: 2, category: '美術費', budget_yen: 30000, actual_ex_tax: 1000},
  {id: 5, project_id: 2, work_id: null, category: '宣伝費', budget_yen: 999999, actual_ex_tax: 1},
  {id: 6, project_id: 1, work_id: 1, category: '', budget_yen: null, actual_ex_tax: 700},
];

test('expenses in scope: the selected work and unassigned expenses of the same project only', () => {
  assert.deepEqual(expensesInScope(rows, {id: 1, project_id: 1}).map((r) => r.id), [1, 2, 3, 6]);
  assert.deepEqual(expensesInScope(rows, null), []);
});

test('budget rows by category: over budget first, no budget is not guessed', () => {
  const result = expenseBudgetRows(expensesInScope(rows, {id: 1, project_id: 1}));
  assert.deepEqual(result.map((r) => r.category), ['撮影費', '宣伝費', '（費目なし）']);
  const shooting = result[0];
  assert.equal(shooting.budget, 100000);
  assert.equal(shooting.actual, 125000);
  assert.equal(shooting.remaining, -25000);
  assert.match(shooting.state, /予算超過（25,000円）/);
  assert.equal(result[1].state, '残りわずか');
  assert.equal(result[2].budget, null);
  assert.equal(result[2].state, '予算なし');
  assert.equal(result[2].remaining, null);
});

test('category suggestions are the registered categories, most used first (制作費 is always offered first)', () => {
  assert.deepEqual(expenseCategories([...rows, {category: '宣伝費'}]), ['制作費', '宣伝費', '撮影費', '美術費']);
  assert.deepEqual(expenseCategories([]), ['制作費'], '経費が0件でも「制作費」を候補に出す');
  assert.deepEqual(expenseCategories([{category: '制作費'}, {category: '宣伝費'}, {category: '宣伝費'}]), ['制作費', '宣伝費'], '重ねない');
  assert.ok(!expenseCategories(rows).includes(''), 'empty categories are not suggested');
});

test('費目の表記によらず採用済み科目を表示し、対応なしは未整備', () => {
  const result = expenseBudgetRows([{category: '制作費（撮影）', expense_account_name:'制作費（公開月に一括）', actual_ex_tax: 1}, {category: '製作費', expense_account_name:'直接費', actual_ex_tax: 1}, {category: '宣伝費', expense_account_name:'広告宣伝費', actual_ex_tax: 1}, {category: '事務費', actual_ex_tax: 1}]);
  const byCategory = Object.fromEntries(result.map((row) => [row.category, row.plClass]));
  assert.deepEqual(byCategory, {'制作費（撮影）': '制作費（公開月に一括）', 製作費: '直接費', 宣伝費: '広告宣伝費', 事務費: '費用区分未整備'});
});
