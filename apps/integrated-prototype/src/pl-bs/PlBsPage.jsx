// PL・BS（管理会計の試算）。売上基幹 › 計上 › 帳票・分析。タブは 作品別PL・作品別の残高・会社PL・会社BS・手入力・会社の設定。
// 数字はサーバーの /api/reports/pl-bs（純関数 buildPlBs）が毎回計算し、画面と Excel は同じ列定義（pl-bs-view.mjs）で出す。
// 帳票センターの「収支」の分類からは、作品別PL・会社PL・会社BS を1つずつ開ける（PlBsReport）。条件（年度・期間・BSの基準月・タブ）は URL に残る。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {yen, dateTimeJst} from '../ui/format.mjs';
import {useFiscal} from '../reports/use-fiscal.mjs';
import {isYm} from '../ui/condition-model.mjs';
import {monthLabel, PL_BS_HEADING} from '../reports/pl-bs-model.mjs';
import {
  VIEWS, WORK_PL_COLUMNS, WORK_BALANCE_COLUMNS, COMPANY_BS_COLUMNS, HINT_COLUMNS, REFERENCE_COLUMNS, CHECK_COLUMNS, EXPENSE_CLASS_COLUMNS,
  detailColumns, companyPlColumns, plBsSheets, currentBody,
} from './pl-bs-view.mjs';
import {ManualAmounts, CompanySettings} from './PlBsManual.jsx';
import {InvestmentPayments} from './ExpensePayments.jsx';
import '../reports/reports.css';
import './pl-bs.css';

const CONDITIONS = ['fiscalYear', 'period'];

function usePlBs(values, bsMonth, reloadKey) {
  const shell = useShell();
  const [state, setState] = useState({});
  const query = useMemo(() => (values.valid && values.from && values.to && isYm(bsMonth)
    ? new URLSearchParams({from: values.from, to: values.to, asOf: bsMonth}).toString() : ''), [values.valid, values.from, values.to, bsMonth]);
  useEffect(() => {
    if (!query) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    shell.request(`/reports/pl-bs?${query}`)
      .then((body) => { if (live) setState({body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [query, shell, reloadKey]);
  return state;
}

function Heading({body}) {
  if (!body) return null;
  return (
    <div className="plbs-heading">
      <strong>{PL_BS_HEADING}</strong>
      <span>{body.profile?.legalName || '会社の設定が未登録'}・期間 {monthLabel(body.conditions.from)}〜{monthLabel(body.conditions.to)}・BSの基準月 {monthLabel(body.conditions.asOf)}末</span>
      {!body.conditions.fiscalConfirmed && <span className="rp-warn">年度（決算月）の解釈は未確定</span>}
      {body.dataAsOf?.latestImportAt && <span className="rp-muted">売上の最終取込 {dateTimeJst(body.dataAsOf.latestImportAt)}</span>}
    </div>
  );
}

function Notes({body}) {
  if (!body) return null;
  return (
    <>
      {(body.notes || []).map((note) => <Notice key={note} tone="warn" message={note} compact />)}
      <details className="plbs-rules">
        <summary>計算の決まり（{(body.headingNotes || []).length}項目）</summary>
        <ul>{(body.headingNotes || []).map((note) => <li key={note}>{note}</li>)}</ul>
      </details>
    </>
  );
}

function ChecksLine({checks = []}) {
  if (!checks.length) return null;
  const ok = checks.every((row) => row.value === 0);
  return <p className={`rp-check ${ok ? 'is-ok' : 'is-bad'}`}>{ok ? `照合OK（${checks.length}項目）` : `照合NG: ${checks.filter((row) => row.value !== 0).map((row) => row.item).join('、')}`}</p>;
}

export function WorkPlView({body}) {
  const [workId, setWorkId] = useState(null);
  const rows = body.workPl || [];
  const selected = rows.find((row) => row.workId === workId) || null;
  const detail = selected ? body.workDetail?.[selected.workId] : null;
  const totals = useMemo(() => ({profit: rows.reduce((n, row) => n + row.period.profit, 0), revenue: rows.reduce((n, row) => n + row.period.revenue, 0)}), [rows]);
  return (
    <section className="card rp-report" aria-label="作品別PL">
      <header className="rp-head">
        <div>
          <h2>作品別PL</h2>
          <p className="rp-muted">自社作品は売上−ロイヤリティ−作品の経費−制作費（公開月に一括）。委員会作品は委員会の月次収支の自社の取得額だけで、委員会の経費・権利処理費は引きません。行を押すと月別の内訳を下に出します。</p>
        </div>
        <ReportOutputBar sheets={() => plBsSheets(body, 'work-pl', {workId})} name="作品別PL" period={`${body.conditions.from}〜${body.conditions.to}`} title={`作品別PL（${PL_BS_HEADING}）`} formats={['xlsx', 'csv', 'print']} />
      </header>
      <div className="rp-tiles">
        <div><span>作品の売上高（期間）</span><strong>{yen(totals.revenue)}</strong><small>自社作品の売上＋委員会の自社の取得額</small></div>
        <div><span>作品の利益の和（期間）</span><strong>{yen(totals.profit)}</strong><small>{rows.length}作品</small></div>
        <div className={rows.some((row) => row.origin === 'unverified') ? 'is-warn' : ''}><span>未確定を含む作品</span><strong>{rows.filter((row) => row.origin === 'unverified').length}</strong><small>理由は表の右端</small></div>
      </div>
      <DataGrid columns={WORK_PL_COLUMNS} rows={rows} rowKey="workId" persistKey="plbs-work-pl" ariaLabel="作品別PL" onRowClick={(row) => setWorkId(row.workId === workId ? null : row.workId)}
        emptyText="財務の権限がある作品がありません" exportSpec={{name: '作品別PL'}} />
      {selected && detail && (
        <section className="plbs-detail" aria-label={`${selected.code}｜${selected.title}の月別`}>
          <h3>{selected.code}｜{selected.title}（{selected.kindLabel}）の月別</h3>
          {selected.reasons.length > 0 && <Notice tone="warn" message={selected.reasons.join('／')} compact />}
          <DataGrid columns={detailColumns(detail)} rows={detail.rows} rowKey="key" showTotals={false} persistKey="plbs-work-detail" ariaLabel={`${selected.code}の月別`} exportSpec={{name: `${selected.code}の月別`}} />
        </section>
      )}
      {(body.expenseClassification || []).length > 0 && (
        <details className="plbs-rules">
          <summary>経費の費目の扱い（会計対応と未整備。自社作品・会社共通・期間）</summary>
          <p className="rp-muted">科目と費用にする時期は、明細の会計版または採用済みの完全一致対応で決まります。対応がない経費は「費用区分未整備」として金額を残します。</p>
          <DataGrid columns={EXPENSE_CLASS_COLUMNS} rows={body.expenseClassification} rowKey={(row) => `${row.kind}|${row.category}`} showTotals={false} ariaLabel="経費の費目の扱い" exportSpec={{name: '経費の費目の扱い'}} />
        </details>
      )}
      <ChecksLine checks={body.checks} />
    </section>
  );
}

export function WorkBalancesView({body, onChanged}) {
  const [workId, setWorkId] = useState(null);
  if (body.bsUnavailable) return <Notice tone="warn" message={body.bsUnavailable} />;
  const rows = body.workBalances || [];
  const selected = rows.find((row) => row.workId === workId && row.kind === 'committee') || null;
  return (
    <section className="card rp-report" aria-label="作品別の残高">
      <header className="rp-head">
        <div>
          <h2>作品別の残高（{monthLabel(body.conditions.asOf)}末）</h2>
          <p className="rp-muted">作品に紐づく売掛金・未払の経費・未払ロイヤリティ・制作中の作品・委員会への出資金と回収。作品の純額は回収の見通しを見る管理の指標で、会社の純資産とは結び付けていません。委員会作品の行を押すと、出資の払込を記録できます。</p>
        </div>
        <ReportOutputBar sheets={() => plBsSheets(body, 'work-balances')} name="作品別の残高" period={body.conditions.asOf} title={`作品別の残高（${PL_BS_HEADING}）`} formats={['xlsx', 'csv', 'print']} />
      </header>
      <DataGrid columns={WORK_BALANCE_COLUMNS} rows={rows} rowKey="workId" persistKey="plbs-work-balances" ariaLabel="作品別の残高" onRowClick={(row) => setWorkId(row.workId === workId ? null : row.workId)}
        emptyText="財務の権限がある作品がありません" exportSpec={{name: '作品別の残高'}} />
      {selected && <InvestmentPayments workId={selected.workId} title={`${selected.code}｜${selected.title}`} onChanged={onChanged} />}
    </section>
  );
}

export function CompanyPlView({body}) {
  if (!body.companyPl) return <Notice tone="info" message={body.companyNote || '会社PLを見る権限がありません'} />;
  const net = body.companyPl.rows.find((row) => row.key === 'netIncome');
  const operating = body.companyPl.rows.find((row) => row.key === 'operatingProfit');
  return (
    <section className="card rp-report" aria-label="会社PL">
      <header className="rp-head">
        <div>
          <h2>会社PL（月次）</h2>
          <p className="rp-muted">作品別PLの合計に、作品の決まっていない案件の経費と手入力（全社費用・営業外・特別・法人税等）を足したものです。</p>
        </div>
        <ReportOutputBar sheets={() => plBsSheets(body, 'company-pl')} name="会社PL" period={`${body.conditions.from}〜${body.conditions.to}`} title={`会社PL（${PL_BS_HEADING}）`} formats={['xlsx', 'csv', 'print']} />
      </header>
      <div className="rp-tiles">
        <div><span>営業利益（期間）</span><strong>{yen(operating?.values.period)}</strong></div>
        <div><span>当期純利益（期間）</span><strong>{yen(net?.values.period)}</strong><small>{net?.originLabel}</small></div>
      </div>
      <DataGrid columns={companyPlColumns(body.companyPl)} rows={body.companyPl.rows} rowKey="key" showTotals={false} persistKey="plbs-company-pl" className="plbs-statement" ariaLabel="会社PL（月次）"
        exportSpec={{name: '会社PL'}} />
      <ChecksLine checks={body.checks} />
    </section>
  );
}

export function CompanyBsView({body}) {
  if (!body.companyBs) return <Notice tone="info" message={body.companyNote || '会社BSを見る権限がありません'} />;
  const bs = body.companyBs;
  if (bs.unavailable) return <Notice tone="warn" message={bs.reason} />;
  return (
    <section className="card rp-report" aria-label="会社BS">
      <header className="rp-head">
        <div>
          <h2>会社の簡易BS（{monthLabel(bs.asOf)}末）</h2>
          <p className="rp-muted">期首残高の基準月（{bs.openingMonth ? `${monthLabel(bs.openingMonth)}末` : '未設定'}）の手入力の残高に、その後の入出金・発生額を足しています。最後の行は必ず「説明のつかない差額」です。</p>
        </div>
        <ReportOutputBar sheets={() => plBsSheets(body, 'company-bs')} name="会社BS" period={bs.asOf} title={`会社BS（${PL_BS_HEADING}）`} formats={['xlsx', 'csv', 'print']} />
      </header>
      <div className="rp-tiles">
        <div><span>資産の部</span><strong>{yen(bs.totals.asset)}</strong></div>
        <div><span>負債の部</span><strong>{yen(bs.totals.liability)}</strong></div>
        <div><span>純資産の部</span><strong>{yen(bs.totals.equity)}</strong></div>
        <div className={bs.difference !== 0 ? 'is-warn' : ''}><span>説明のつかない差額</span><strong>{yen(bs.difference)}</strong><small>資産−負債−純資産</small></div>
      </div>
      <DataGrid columns={COMPANY_BS_COLUMNS} rows={bs.rows} rowKey="key" showTotals={false} persistKey="plbs-company-bs" className="plbs-statement" ariaLabel="会社の簡易BS" exportSpec={{name: '会社BS'}} />
      <h3>差額の手がかり</h3>
      <DataGrid columns={HINT_COLUMNS} rows={bs.hints} rowKey="key" showTotals={false} ariaLabel="差額の手がかり" exportSpec={{name: '差額の手がかり'}} />
      <h3>参考（BSの合計に入れない）</h3>
      <DataGrid columns={REFERENCE_COLUMNS} rows={bs.reference} rowKey="key" showTotals={false} ariaLabel="参考（BSの合計に入れない）" exportSpec={{name: '参考'}} />
      <details className="plbs-rules">
        <summary>現預金の内訳（期首の翌月から基準月まで）</summary>
        <ul>
          <li>請求の入金 {yen(bs.cashFlows.billingReceipts)}・委員会からの受取 {yen(bs.cashFlows.committeeReceipts)}</li>
          <li>経費の出金 {yen(bs.cashFlows.expensePayments)}・ロイヤリティの支払 {yen(bs.cashFlows.royaltyPayments)}・出資の払込 {yen(bs.cashFlows.investmentPayments)}</li>
          <li>手入力の収益（税込）{yen(bs.cashFlows.manualIncomeCash)}・手入力の費用（税込）{yen(bs.cashFlows.manualCostCash)}（うち消費税額 {yen(bs.cashFlows.manualCostTax)}）・手入力の残高の増減 {yen(bs.cashFlows.manualBalanceCash)}</li>
        </ul>
      </details>
    </section>
  );
}

// 帳票センター・PL・BS の画面で共通の条件と読み込み。view を渡すとそのタブだけ（帳票センター用）
export function PlBsReport({data, fiscal: fiscalProp, view: fixedView = null, onNavigate}) {
  const shell = useShell();
  const [fiscalState, setFiscal] = useFiscal(shell.request);
  const fiscal = fiscalProp || fiscalState;
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const bsParam = shell.getParam('bsMonth', '');
  const bsMonth = isYm(bsParam) ? bsParam : values.to;
  const [reloadKey, setReloadKey] = useState(0);
  const state = usePlBs(values, bsMonth, reloadKey);
  const body = currentBody(state, {from: values.from, to: values.to, asOf: bsMonth});
  const isAdmin = data?.currentUser?.role === 'admin';
  const reload = () => setReloadKey((n) => n + 1);
  const renderView = (id) => {
    if (id === 'manual') return <ManualAmounts from={values.from} to={values.to} works={data?.works || []} canEdit={isAdmin} onChanged={reload} />;
    if (id === 'settings') return <CompanySettings canEdit={isAdmin} onChanged={() => { reload(); setFiscal((f) => ({...f})); }} onNavigate={onNavigate} />;
    if (state.error) return <Notice error={state.error} onRetry={reload} />;
    if (!body) return <p className="rp-muted">{state.loading ? '集計しています…' : '期間を選ぶと集計します。'}</p>;
    if (id === 'work-pl') return <WorkPlView body={body} />;
    if (id === 'work-balances') return <WorkBalancesView body={body} onChanged={reload} />;
    if (id === 'company-pl') return <CompanyPlView body={body} />;
    if (id === 'company-bs') return <CompanyBsView body={body} />;
    return null;
  };
  return (
    <div className="stack plbs">
      <ConditionBar conditions={CONDITIONS} values={values} fiscalConfirmed={fiscal?.confirmed}
        summary="PLは計上月・税抜。BSは基準月の月末の残高です。">
        <FormField type="month" label="BSの基準月" value={bsMonth || ''} onChange={(value) => { if (!value || isYm(value)) shell.setParam('bsMonth', value || null, {replace: true}); }}
          hint={body?.profile?.openingMonth ? `空欄は期間の終わりの月。期首残高の基準月（${monthLabel(body.profile.openingMonth)}）以後にしてください` : '空欄は期間の終わりの月'} />
      </ConditionBar>
      <Heading body={body} />
      <Notes body={body} />
      {fixedView ? renderView(fixedView) : (
        <Tabs tabs={VIEWS.map((view) => ({id: view.id, label: view.label}))} urlKey="plbsTab" label="PL・BS の表">{(active) => renderView(active)}</Tabs>
      )}
    </div>
  );
}

// 帳票センターのカタログから開く部品（作品別PL・会社PL・会社BS）
export const WorkPlReport = (props) => <PlBsReport {...props} view="work-pl" />;
export const CompanyPlReport = (props) => <PlBsReport {...props} view="company-pl" />;
export const CompanyBsReport = (props) => <PlBsReport {...props} view="company-bs" />;

export function PlBsPage({data, onNavigate}) {
  return <PlBsReport data={data} onNavigate={onNavigate} />;
}

export default PlBsPage;
