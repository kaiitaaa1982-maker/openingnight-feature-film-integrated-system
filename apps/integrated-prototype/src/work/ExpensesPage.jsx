// 経費。選んだ作品（と、その案件の作品を決めていない経費）について、費目ごとの予算と実績（税抜）を並べ、
// 予算の消化と超過を確かめる。出金の記録（出金日・金額・方法）と未払は ExpensePaymentsPanel（PL・BS の未払金の元）。一覧と登録は既存の汎用一覧（renderList）で行い、費目は既存の費目を候補に出す。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {expenseBudgetRows, expenseCategories, expensesInScope} from './expenses-model.mjs';
import '../reports/reports.css';

const COLUMNS = [
  {key: 'category', label: '費目', type: 'text', sticky: true},
  {key: 'budget', label: '予算', type: 'yen', total: 'sum'},
  {key: 'actual', label: '実績（税抜）', type: 'yen', total: 'sum'},
  {key: 'remaining', label: '予算の残り（予算−実績）', type: 'yen', total: 'sum'},
  {key: 'rate', label: '消化率', type: 'rate', total: 'none'},
  {key: 'state', label: '状況', type: 'text'},
  {key: 'count', label: '件数', type: 'int', total: 'sum'},
  {key: 'plClass', label: 'PLでの扱い', type: 'text'},
];

export function ExpensesPage({data, bulkSlot, renderList}) {
  const shell = useShell();
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    shell.request('/expenses').then((body) => live && setState({rows: body.rows || []})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [shell, revision]);
  const work = data?.selectedWork;
  const scoped = useMemo(() => expensesInScope(state.rows || [], work), [state.rows, work]);
  const rows = useMemo(() => expenseBudgetRows(scoped), [scoped]);
  const suggestions = useMemo(() => expenseCategories(state.rows || []), [state.rows]);
  const over = rows.filter((row) => row.remaining < 0);
  return (
    <div className="stack">
      {bulkSlot}
      <section className="card rp-report" aria-label="費目別の予算対比">
        <header className="rp-head">
          <div>
            <h2>費目別の予算対比{work ? `（${work.title}）` : ''}</h2>
            <p className="rp-muted">選んだ作品の経費と、同じ案件で作品を決めていない経費を、費目ごとに予算と実績（税抜）で並べます。予算を入れていない費目は「予算なし」です。「PLでの扱い」は PL・BS での区分で、費用区分の会計対応で科目と費用にする時期を決めます。</p>
          </div>
        </header>
        {state.error && <Notice error={state.error} />}
        {over.length > 0 && <Notice tone="warn" message={`予算を超えている費目があります: ${over.map((row) => row.category).join('、')}`} />}
        {state.rows && <DataGrid columns={COLUMNS} rows={rows} rowKey="category" persistKey="expense-budget" showTotals totalLabel="合計"
          emptyText="この作品の経費はまだありません" exportSpec={{name: '経費の予算対比', title: `費目別の予算対比${work ? `（${work.title}）` : ''}`}} />}
      </section>
      <button type="button" aria-label="売上基幹の経費集計シートを開く" onClick={() => shell.navigate("経費集計シート")}>売上基幹の経費集計シートを開く</button>
      {renderList?.({suggestions, onChanged: () => setRevision((n) => n + 1), filter: (row) => expensesInScope([row], work).length > 0})}
    </div>
  );
}

export default ExpensesPage;
