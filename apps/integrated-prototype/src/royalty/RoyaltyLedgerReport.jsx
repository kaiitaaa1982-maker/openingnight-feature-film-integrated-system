// ロイヤリティ集計シート（帳票センターと「ロイヤリティ集計」画面で同じ中身）。
// 行＝権利者（×種別×作品）、列＝各月の発生額・期間計・契約開始からの累計・調整・前払金の充当・支払累計・未払残。
// シート: 権利者×月／権利者×種別×月／作品×種別×月／明細／経費の控除／保留／イレギュラー／実額の計上。絞込: 権利者・種別・作品・期間。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {describeConditions} from '../ui/condition-model.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Notice} from '../ui/Notice.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, dateTimeJst, month as monthText} from '../ui/format.mjs';
import {rateText} from './royalty-model.mjs';
import {CATEGORY_OPTIONS, ledgerHolderTail} from './royalty-ui.mjs';
import {ErrorNotice} from './RoyaltyParts.jsx';
import '../reports/reports.css';
import './royalty.css';

const CONDITIONS = ['fiscalYear', 'period', 'work'];

function monthColumns(months) {
  return months.map((month) => ({key: `m:${month}`, label: monthText(month), type: 'yen', total: 'sum', value: (row) => row.months?.[month] ?? 0}));
}
const TAIL = [
  {key: 'periodYen', label: '期間計', type: 'yen', total: 'sum'},
  {key: 'cumulativeYen', label: '契約開始からの累計', type: 'yen', total: 'sum'},
];
const DETAIL_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'categoryLabel', label: '種別', type: 'text'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'agreementCode', label: '契約', type: 'code'},
  {key: 'closeMonth', label: '締め月', type: 'month', value: (r) => r.closeMonth || null},
  {key: 'calcMethodLabel', label: '計算方法', type: 'text', hidden: true},
  {key: 'baseKindLabel', label: '基礎', type: 'text', hidden: true},
  {key: 'salesYen', label: '対象の売上', type: 'yen'},
  {key: 'windowFeeYen', label: '窓口手数料', type: 'yen'},
  {key: 'expenseYen', label: '経費の控除', type: 'yen'},
  {key: 'committeeIncomeYen', label: '本委員会収入', type: 'yen', hidden: true},
  {key: 'baseYen', label: '基礎の額', type: 'yen'},
  {key: 'rate', label: '料率', type: 'text', value: (r) => (r.rateBps === null || r.rateBps === undefined ? '—' : rateText(r.rateBps))},
  {key: 'royaltyYen', label: '発生額', type: 'yen'},
  {key: 'holdSalesYen', label: '保留の対象売上', type: 'yen'},
  {key: 'excludedSalesYen', label: '対象外の流通の売上', type: 'yen', hidden: true},
  {key: 'status', label: '状態', type: 'text'},
  {key: 'holdReason', label: '保留の理由', type: 'text', wrap: true, hidden: true},
  {key: 'channelText', label: '流通の内訳', type: 'text', wrap: true, hidden: true},
];
const EXPENSE_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'categoryLabel', label: '種別', type: 'text'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'agreementCode', label: '契約', type: 'code'},
  {key: 'expenseCategory', label: '費目', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true, value: (r) => r.description || ''},
  {key: 'sourceLabel', label: '出どころ', type: 'text'},
  {key: 'amountYen', label: '控除した額', type: 'yen'},
];
const HOLD_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'agreementCode', label: '契約', type: 'code'},
  {key: 'holdKind', label: '保留の範囲', type: 'text'},
  {key: 'holdSalesYen', label: '保留の対象売上', type: 'yen'},
  {key: 'royaltyYen', label: '計算できた額', type: 'yen', total: 'none'},
  {key: 'holdReason', label: '理由', type: 'text', wrap: true},
];
const IRREGULAR_COLUMNS = [
  {key: 'id', label: '記録', type: 'int', total: 'none', sticky: true},
  {key: 'kindLabel', label: '種類', type: 'text'},
  {key: 'holderName', label: '権利者', type: 'text', value: (r) => r.holderName || ''},
  {key: 'agreementCode', label: '契約', type: 'code', value: (r) => r.agreementCode || '（権利者全体）'},
  {key: 'accrualMonth', label: '計上月', type: 'month', value: (r) => r.accrualMonth || null},
  {key: 'closeMonth', label: '締め月', type: 'month', value: (r) => r.closeMonth || null},
  {key: 'amountYen', label: '金額', type: 'yen', total: 'none'},
  {key: 'effect', label: 'その結果', type: 'text', wrap: true},
  {key: 'reason', label: '理由', type: 'text', wrap: true},
  {key: 'sourceReference', label: '根拠の資料', type: 'text', value: (r) => r.sourceReference || ''},
];
const MANUAL_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'agreementCode', label: '契約', type: 'code'},
  {key: 'amountYen', label: '金額', type: 'yen'},
  {key: 'sourceReference', label: '元資料', type: 'text'},
  {key: 'reason', label: '理由', type: 'text', wrap: true},
  {key: 'kind', label: '行', type: 'text', value: (r) => (r.isReversal ? '取消' : '計上')},
];
const CHECK_COLUMNS = [{key: 'item', label: '照合', type: 'text'}, {key: 'value', label: '差額', type: 'yen', total: 'none'}];

export function RoyaltyLedgerReport({data, fiscal, onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const navigate = onNavigate || shell.navigate;
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const holderId = shell.getParam('holder', '');
  const category = shell.getParam('category', '');
  const [state, setState] = useState({});
  const [reloadKey, setReloadKey] = useState(0);
  const [holders, setHolders] = useState([]);
  const works = data?.works || [];

  useEffect(() => {
    let live = true;
    request('/royalty/agreements').then((body) => live && setHolders(body.holders || [])).catch(() => {});
    return () => { live = false; };
  }, [request]);
  const query = useMemo(() => {
    if (!values.from || !values.to) return '';
    const params = new URLSearchParams({from: values.from, to: values.to});
    if (holderId) params.set('holderId', holderId);
    if (category) params.set('category', category);
    if (values.workId) params.set('workId', values.workId);
    return params.toString();
  }, [values.from, values.to, values.workId, holderId, category]);
  useEffect(() => {
    if (!query || !values.valid) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/royalty/ledger?${query}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [query, values.valid, request, reloadKey]);

  const body = state.body;
  const months = body?.months || [];
  // 作品・種別で絞った表では支払累計・未払残を出さない（支払は権利者の全契約で1つの値）
  const paymentScope = body?.paymentScope || 'all';
  const holderColumns = useMemo(() => [{key: 'holderName', label: '権利者', type: 'text', sticky: true}, ...monthColumns(months), ...ledgerHolderTail(paymentScope)], [months, paymentScope]);
  const holderCategoryColumns = useMemo(() => [{key: 'holderName', label: '権利者', type: 'text', sticky: true}, {key: 'categoryLabel', label: '種別', type: 'text', sticky: true},
    ...monthColumns(months), ...TAIL, {key: 'recoupYen', label: '前払金の充当', type: 'yen', total: 'sum'}], [months]);
  const workCategoryColumns = useMemo(() => [{key: 'workTitle', label: '作品', type: 'text', sticky: true}, {key: 'categoryLabel', label: '種別', type: 'text', sticky: true},
    ...monthColumns(months), ...TAIL], [months]);
  const names = useMemo(() => ({work: Object.fromEntries(works.map((w) => [String(w.id), w.title]))}), [works]);
  const holderName = holders.find((h) => String(h.id) === String(holderId))?.name;
  const title = holderName ? `ロイヤリティ集計シート（${holderName}）` : 'ロイヤリティ集計シート';
  const ok = body?.checks?.every((check) => check.value === 0);

  function sheets() {
    const conditions = [...describeConditions(values, CONDITIONS, {names}), ['権利者', holderName || 'すべて'], ['種別', CATEGORY_OPTIONS.find((o) => o.value === category)?.label || 'すべて'], ['集計の基準', '計上月・税抜']];
    const dataAsOf = body.dataAsOf?.latestImportAt;
    const spec = (name, sheetTitle, notes) => ({name, title: sheetTitle, conditions, dataAsOf, notes});
    const all = (columns) => columns.map((c) => ({...c, hidden: false}));
    return [
      gridSheetSpec({columns: all(holderColumns), rows: body.byHolder, exportSpec: spec('権利者×月', `${title} 権利者×月`, [body.basis,
        ...(paymentScope === 'none' ? [] : ['未払残＝契約開始からの累計＋調整−前払金の充当−支払累計（以前の仕組みで報告済みの分は、充当・支払とも除く）']), ...(body.notes || [])])}),
      gridSheetSpec({columns: all(holderCategoryColumns), rows: body.byHolderCategory, exportSpec: spec('権利者×種別×月', `${title} 権利者×種別×月`)}),
      gridSheetSpec({columns: all(workCategoryColumns), rows: body.byWorkCategory, exportSpec: spec('作品×種別×月', `${title} 作品×種別×月`)}),
      gridSheetSpec({columns: all(DETAIL_COLUMNS), rows: body.detail, exportSpec: spec('明細', `${title} 明細（契約×計上月）`)}),
      gridSheetSpec({columns: EXPENSE_COLUMNS, rows: body.expenses, exportSpec: spec('経費の控除', '経費の控除')}),
      gridSheetSpec({columns: HOLD_COLUMNS, rows: body.holds, exportSpec: spec('保留', '保留（0円にせず別に示す）')}),
      gridSheetSpec({columns: IRREGULAR_COLUMNS, rows: body.irregular, showTotals: false, exportSpec: spec('イレギュラー', 'イレギュラーの台帳と、その結果')}),
      gridSheetSpec({columns: MANUAL_COLUMNS, rows: body.manual, exportSpec: spec('実額の計上', '実額の計上')}),
      {name: '照合', title: '照合', conditions, dataAsOf, columns: CHECK_COLUMNS, rows: body.checks, freezeCols: 1},
    ];
  }

  const tabs = body ? [
    {id: 'holder', label: '権利者×月', badge: body.byHolder.length}, {id: 'holder-category', label: '権利者×種別×月'}, {id: 'work-category', label: '作品×種別×月'},
    {id: 'detail', label: '明細', badge: body.detail.length}, {id: 'expenses', label: '経費の控除', badge: body.expenses.length || undefined},
    {id: 'holds', label: '保留', badge: body.holds.length || undefined}, {id: 'irregular', label: 'イレギュラー', badge: body.irregular.length || undefined},
    {id: 'manual', label: '実額の計上', badge: body.manual.length || undefined},
  ] : [];

  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">監督料・脚本料・音楽著作権料・原作料などの発生額を、計上月ごとに権利者×種別×作品で集計します。累計は契約開始から、未払残は支払の記録を差し引いた額です。保留の分は0円にせず別に示します。</p>
        </div>
        {body && <ReportOutputBar sheets={sheets} name={holderName ? `ロイヤリティ集計_${holderName}` : 'ロイヤリティ集計'} period={`${values.from}〜${values.to}`} title={title} subtitle={values.periodLabel} formats={['xlsx', 'csv', 'print', 'html']} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} works={works} fiscalConfirmed={fiscal?.confirmed}>
        <FormField type="select" label="権利者" value={holderId} blankLabel="すべての権利者" options={holders.map((h) => ({value: String(h.id), label: h.name}))}
          onChange={(value) => shell.setParam('holder', value || null)} />
        <FormField type="select" label="種別" value={category} blankLabel="すべての種別" options={CATEGORY_OPTIONS} onChange={(value) => shell.setParam('category', value || null)} />
      </ConditionBar>
      {state.error && <><ErrorNotice error={state.error} /><button type="button" className="secondary" onClick={() => setReloadKey((n) => n + 1)}>再試行</button></>}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">集計中…</p>}
      {body && (
        <>
          <div className="rp-tiles">
            <div><span>期間の発生額</span><strong>{yen(body.totals.periodYen)}</strong></div>
            <div><span>契約開始からの累計</span><strong>{yen(body.totals.cumulativeYen)}</strong></div>
            <div><span>調整（イレギュラー）</span><strong>{yen(body.totals.adjustmentYen)}</strong></div>
            <div><span>前払金の充当</span><strong>{yen(body.totals.recoupYen)}</strong></div>
            {paymentScope !== 'none' && <>
              <div><span>支払累計</span><strong>{yen(body.totals.paidYen)}</strong>{body.totals.paymentHiddenCount > 0 && <small>権限外の作品を含む{body.totals.paymentHiddenCount}者を除く</small>}</div>
              <div><span>未払残</span><strong>{yen(body.totals.unpaidYen)}</strong>{body.totals.paymentHiddenCount > 0 && <small>権限外の作品を含む{body.totals.paymentHiddenCount}者を除く</small>}</div>
            </>}
            <div className={body.totals.holdCount ? 'is-warn' : ''}><span>保留</span><strong>{body.totals.holdCount}件</strong><small>対象売上 {yen(body.totals.holdSalesYen)}</small></div>
          </div>
          <div className="rp-meta">
            <span className={`rp-check ${ok ? 'is-ok' : 'is-bad'}`}>{ok ? '照合OK: 明細の和＝権利者×月＝種別・作品の集計' : '照合NG: 照合シートを確かめてください'}</span>
            <span>データ時点: 最終取込 {body.dataAsOf.latestImportAt ? dateTimeJst(body.dataAsOf.latestImportAt) : 'なし'}（JST）</span>
          </div>
          {(body.notes || []).map((note) => <Notice key={note} tone="info" compact message={note} />)}
          {!body.byHolder.length && <Notice tone="info" message="条件に合うロイヤリティ契約がありません。"
            actions={navigate ? <button type="button" className="secondary" onClick={() => navigate('ロイヤリティ契約')}>ロイヤリティ契約を開く</button> : null} />}
          <Tabs tabs={tabs} urlKey="sheet" label="集計シート">
            {(active) => {
              if (active === 'holder') return <DataGrid columns={holderColumns} rows={body.byHolder} rowKey="key" persistKey="royalty-ledger-holder" totalLabel="合計"
                onRowClick={(row) => shell.setParam('holder', String(row.holderId))} />;
              if (active === 'holder-category') return <DataGrid columns={holderCategoryColumns} rows={body.byHolderCategory} rowKey="key" persistKey="royalty-ledger-holder-category" totalLabel="合計" />;
              if (active === 'work-category') return <DataGrid columns={workCategoryColumns} rows={body.byWorkCategory} rowKey="key" persistKey="royalty-ledger-work-category" totalLabel="合計" />;
              if (active === 'detail') return <DataGrid columns={DETAIL_COLUMNS} rows={body.detail} rowKey="key" persistKey="royalty-ledger-detail" maxHeight="55vh" />;
              if (active === 'expenses') return <DataGrid columns={EXPENSE_COLUMNS} rows={body.expenses} rowKey="key" persistKey="royalty-ledger-expenses" emptyText="控除した経費はありません" />;
              if (active === 'holds') return <DataGrid columns={HOLD_COLUMNS} rows={body.holds} rowKey="key" persistKey="royalty-ledger-holds" emptyText="保留はありません" />;
              if (active === 'irregular') return <DataGrid columns={IRREGULAR_COLUMNS} rows={body.irregular} rowKey="key" persistKey="royalty-ledger-irregular" showTotals={false} emptyText="イレギュラーの記録はありません" />;
              return <DataGrid columns={MANUAL_COLUMNS} rows={body.manual} rowKey="key" persistKey="royalty-ledger-manual" emptyText="実額の計上はありません" />;
            }}
          </Tabs>
          <p className="rp-muted">{body.basis}</p>
        </>
      )}
    </section>
  );
}

export default RoyaltyLedgerReport;
