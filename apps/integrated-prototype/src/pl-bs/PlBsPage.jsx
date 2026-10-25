// PL・BS（管理会計の試算）。売上基幹 › 計上 › 帳票・分析。タブは 月次の報告（春川の単位。MonthlyReport.jsx）・作品別PL・作品別の残高・会社PL・会社BS・手入力・会社の設定。
// 数字はサーバーの /api/reports/pl-bs（純関数 buildPlBs）が毎回計算し、画面と Excel は同じ列定義（pl-bs-view.mjs）で出す。
// 帳票センターの「収支」の分類からは、作品別PL・会社PL・会社BS を1つずつ開ける（PlBsReport）。条件（年度・期間・基準・BSの基準月・タブ・作品）は URL に残る。
// 基準（計上・入金。フェーズ1 #16）: PL・BS の画面と作品別PL は既定が計上、会社の帳票（会社PL・会社BS）は入金で開く。PL 系のタブは共通の見出しに基準を、
// BS 系のタブ（作品別の残高・会社BS）は表の見出しに「BS は基準によらない」を出す。
// 会社PLの「作品ごとの内訳」から、作品別PL と作品別収支を同じ期間・同じ基準で1クリックで開く
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
  VIEWS, WORK_BALANCE_COLUMNS, COMPANY_BS_COLUMNS, HINT_COLUMNS, REFERENCE_COLUMNS, CHECK_COLUMNS, EXPENSE_CLASS_COLUMNS, COMPANY_WORK_COLUMNS,
  detailColumns, companyPlColumns, plBsSheets, currentBody, workPlColumns, basisHeading, BS_BASIS_HEADING, companyPlWorkRows, headingBasisText, activeViewOf, workOpeners,
} from './pl-bs-view.mjs';
import {ManualAmounts, CompanySettings} from './PlBsManual.jsx';
import {InvestmentPayments} from './ExpensePayments.jsx';
import {MonthlyReport} from './MonthlyReport.jsx';
import '../reports/reports.css';
import './pl-bs.css';

const CONDITIONS = ['fiscalYear', 'period', 'cashBasis'];

function usePlBs(values, bsMonth, reloadKey) {
  const shell = useShell();
  const [state, setState] = useState({});
  const query = useMemo(() => (values.valid && values.from && values.to && isYm(bsMonth)
    ? new URLSearchParams({from: values.from, to: values.to, asOf: bsMonth, basis: values.cashBasis}).toString() : ''), [values.valid, values.from, values.to, bsMonth, values.cashBasis]);
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

// 共通の見出し。PL の基準の帯は PL 系のタブ（view）だけに出す（headingBasisText）
export function Heading({body, view}) {
  if (!body) return null;
  const basisText = headingBasisText(view, body.basis);
  return (
    <div className="plbs-heading">
      <strong>{PL_BS_HEADING}</strong>
      {basisText && <span className="plbs-basis" data-basis={body.basis}>{basisText}</span>}
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
  // 開いている作品は URL（plbsWork）に残す（会社PLの内訳から、作品を開いた状態で来られる）
  const shell = useShell();
  const workId = Number(shell.getParam('plbsWork', '')) || null;
  const setWorkId = (id) => shell.setParam('plbsWork', id ? String(id) : null, {replace: true});
  const rows = body.workPl || [];
  const columns = useMemo(() => workPlColumns(body.basis), [body.basis]);
  const selected = rows.find((row) => row.workId === workId) || null;
  const detail = selected ? body.workDetail?.[selected.workId] : null;
  const totals = useMemo(() => ({profit: rows.reduce((n, row) => n + row.period.profit, 0), revenue: rows.reduce((n, row) => n + row.period.revenue, 0)}), [rows]);
  return (
    <section className="card rp-report" aria-label="作品別PL">
      <header className="rp-head">
        <div>
          <h2>作品別PL</h2>
          <p className="rp-muted">{basisHeading(body.basis)}</p>
        </div>
        <ReportOutputBar sheets={() => plBsSheets(body, 'work-pl', {workId})} name="作品別PL" period={`${body.conditions.from}〜${body.conditions.to}`} title={`作品別PL（${PL_BS_HEADING}）`} formats={['xlsx', 'csv', 'print']} />
      </header>
      <div className="rp-tiles">
        <div><span>売上高</span><strong>{yen(totals.revenue)}</strong></div>
        <div><span>利益計</span><strong>{yen(totals.profit)}</strong><small>{rows.length}作品</small></div>
        <div className={rows.some((row) => row.origin === 'unverified') ? 'is-warn' : ''}><span>未確定</span><strong>{rows.filter((row) => row.origin === 'unverified').length}</strong></div>
      </div>
      <DataGrid columns={columns} rows={rows} rowKey="workId" persistKey={`plbs-work-pl-${body.basis || 'accrual'}`} ariaLabel="作品別PL" onRowClick={(row) => setWorkId(row.workId === workId ? null : row.workId)}
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
          <p className="rp-muted plbs-basis">{BS_BASIS_HEADING}</p>
        </div>
        <ReportOutputBar sheets={() => plBsSheets(body, 'work-balances')} name="作品別の残高" period={body.conditions.asOf} title={`作品別の残高（${PL_BS_HEADING}）`} formats={['xlsx', 'csv', 'print']} />
      </header>
      <DataGrid columns={WORK_BALANCE_COLUMNS} rows={rows} rowKey="workId" persistKey="plbs-work-balances" ariaLabel="作品別の残高" onRowClick={(row) => setWorkId(row.workId === workId ? null : row.workId)}
        emptyText="財務の権限がある作品がありません" exportSpec={{name: '作品別の残高'}} />
      {selected && <InvestmentPayments workId={selected.workId} title={`${selected.code}｜${selected.title}`} onChanged={onChanged} />}
    </section>
  );
}

// 会社PLの作品ごとの内訳の列。最後の列のボタンで、その行の作品の作品別PL・作品別収支を開く（1クリック）
export function companyWorkColumns({onOpenWorkPl, onOpenWorkPnl} = {}) {
  return [...COMPANY_WORK_COLUMNS, {key: 'open', label: '作品を開く', type: 'text', sortable: false, total: 'none', value: () => '',
    render: (row) => (
      <span className="plbs-open">
        <button type="button" className="secondary" onClick={() => onOpenWorkPl?.(row)} aria-label={`${row.code}の作品別PLを開く`}>作品別PL</button>
        {' '}
        <button type="button" className="secondary" onClick={() => onOpenWorkPnl?.(row)} aria-label={`${row.code}の作品別収支を開く`}>作品別収支</button>
      </span>
    )}];
}

// onOpenWorkPl・onOpenWorkPnl: 作品ごとの内訳の行から、作品別PL・作品別収支を開く（1クリック）
export function CompanyPlView({body, onOpenWorkPl, onOpenWorkPnl}) {
  if (!body.companyPl) return <Notice tone="info" message={body.companyNote || '会社PLを見る権限がありません'} />;
  const net = body.companyPl.rows.find((row) => row.key === 'netIncome');
  const operating = body.companyPl.rows.find((row) => row.key === 'operatingProfit');
  const unsettledIn = body.companyPl.rows.find((row) => row.key === 'unsettled:in');
  const unsettledOut = body.companyPl.rows.find((row) => row.key === 'unsettled:out');
  const workRows = companyPlWorkRows(body);
  const workColumns = companyWorkColumns({onOpenWorkPl, onOpenWorkPnl});
  return (
    <section className="card rp-report" aria-label="会社PL">
      <header className="rp-head">
        <div>
          <h2>会社PL（月次）</h2>
          <p className="rp-muted">{basisHeading(body.basis)}</p>
        </div>
        <ReportOutputBar sheets={() => plBsSheets(body, 'company-pl')} name="会社PL" period={`${body.conditions.from}〜${body.conditions.to}`} title={`会社PL（${PL_BS_HEADING}）`} formats={['xlsx', 'csv', 'print']} />
      </header>
      <div className="rp-tiles">
        <div><span>営業利益（期間）</span><strong>{yen(operating?.values.period)}</strong></div>
        <div><span>当期純利益（期間）</span><strong>{yen(net?.values.period)}</strong><small>{net?.originLabel}</small></div>
        {unsettledIn && (
          <div className="is-warn"><span>未確定の入金・出金（税込・期間）</span><strong>{yen(unsettledIn.values.period)}・{yen(unsettledOut?.values.period)}</strong><small>税抜未確定・利益の対象外</small></div>
        )}
      </div>
      <DataGrid columns={companyPlColumns(body.companyPl)} rows={body.companyPl.rows} rowKey="key" showTotals={false} persistKey="plbs-company-pl" className="plbs-statement" ariaLabel="会社PL（月次）"
        exportSpec={{name: '会社PL'}} />
      <section className="plbs-detail" aria-label="作品ごとの内訳">
        <h3>作品内訳</h3>
        <DataGrid columns={workColumns} rows={workRows} rowKey="workId" persistKey="plbs-company-works" ariaLabel="作品ごとの内訳" emptyText="作品がありません"
          exportSpec={{name: '作品ごとの内訳'}} />
      </section>
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
          <p className="rp-muted plbs-basis">{BS_BASIS_HEADING}</p>
          <p className="rp-muted">期首 {bs.openingMonth ? `${monthLabel(bs.openingMonth)}末` : '未設定'}</p>
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

// 帳票センター・PL・BS の画面で共通の条件と読み込み。view を渡すとそのタブだけ（帳票センター用）。
// defaultBasis: URL に基準が無いときの基準（PL・BS の画面と作品別PLは計上、会社の帳票は入金）
export function PlBsReport({data, fiscal: fiscalProp, view: fixedView = null, onNavigate, defaultBasis = 'accrual'}) {
  const shell = useShell();
  const navigate = onNavigate || shell.navigate;
  const [fiscalState, setFiscal] = useFiscal(shell.request);
  const fiscal = fiscalProp || fiscalState;
  const conditionDefaults = useMemo(() => ({cashBasis: defaultBasis}), [defaultBasis]);
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth, defaults: conditionDefaults});
  const bsParam = shell.getParam('bsMonth', '');
  const bsMonth = isYm(bsParam) ? bsParam : values.to;
  const [reloadKey, setReloadKey] = useState(0);
  const state = usePlBs(values, bsMonth, reloadKey);
  const body = currentBody(state, {from: values.from, to: values.to, asOf: bsMonth, basis: values.cashBasis});
  // 開いているタブ（共通の見出しの基準の帯を PL 系のタブだけに出す）。外枠の無いところでは Tabs の選択を手元に持つ
  const [localTab, setLocalTab] = useState(null);
  const view = activeViewOf(fixedView, shell.getParam('plbsTab', null) ?? localTab);
  // 会社PLの内訳から作品へ1クリック（workOpeners。PL・BS の画面ではタブを作品別PLへ切り替え、帳票センターでは作品別PLの帳票を開く）
  const {openWorkPl, openWorkPnl} = workOpeners({shell, navigate, fixedView, body});
  const isAdmin = data?.currentUser?.role === 'admin';
  const reload = () => setReloadKey((n) => n + 1);
  const renderView = (id) => {
    if (id === 'monthly') return <MonthlyReport defaultMonth={values.to} />;
    if (id === 'manual') return <ManualAmounts from={values.from} to={values.to} works={data?.works || []} canEdit={isAdmin} onChanged={reload} />;
    if (id === 'settings') return <CompanySettings canEdit={isAdmin} onChanged={() => { reload(); setFiscal((f) => ({...f})); }} onNavigate={onNavigate} />;
    if (state.error) return <Notice error={state.error} onRetry={reload} />;
    if (!body) return <p className="rp-muted">{state.loading ? '集計中…' : '期間未選択'}</p>;
    if (id === 'work-pl') return <WorkPlView body={body} />;
    if (id === 'work-balances') return <WorkBalancesView body={body} onChanged={reload} />;
    if (id === 'company-pl') return <CompanyPlView body={body} onOpenWorkPl={openWorkPl} onOpenWorkPnl={openWorkPnl} />;
    if (id === 'company-bs') return <CompanyBsView body={body} />;
    return null;
  };
  return (
    <div className="stack plbs">
      <ConditionBar conditions={CONDITIONS} values={values} fiscalConfirmed={fiscal?.confirmed}>
        <FormField type="month" label="BSの基準月" value={bsMonth || ''} onChange={(value) => { if (!value || isYm(value)) shell.setParam('bsMonth', value || null, {replace: true}); }}
          hint={body?.profile?.openingMonth ? `期首 ${monthLabel(body.profile.openingMonth)}` : undefined} />
      </ConditionBar>
      {view !== 'monthly' && <Heading body={body} view={view} />}
      {view !== 'monthly' && <Notes body={body} />}
      {fixedView ? renderView(fixedView) : (
        <Tabs tabs={VIEWS.map((item) => ({id: item.id, label: item.label}))} urlKey="plbsTab" value={view} onChange={setLocalTab} label="PL・BS の表">{(active) => renderView(active)}</Tabs>
      )}
    </div>
  );
}

// 帳票センターのカタログから開く部品（作品別PL・会社PL・会社BS）
export const WorkPlReport = (props) => <PlBsReport {...props} view="work-pl" />;
// 会社の帳票は入金で開く（計画 #16。URL に基準があればそれに従う）
export const CompanyPlReport = (props) => <PlBsReport {...props} view="company-pl" defaultBasis="cash" />;
export const CompanyBsReport = (props) => <PlBsReport {...props} view="company-bs" defaultBasis="cash" />;

export function PlBsPage({data, onNavigate}) {
  return <PlBsReport data={data} onNavigate={onNavigate} />;
}

export default PlBsPage;
