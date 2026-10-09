// 製作委員会の月次収支（作品別）。設計: docs/platform/team-development/royalty-committee-design.md §4
// 画面（委員会月次収支）と帳票センターの部品（CommitteeMonthlyReport）は同じ中身。条件（年度・期間・作品）は URL に残る。
// 画面では、条件版の窓口ごとに「窓口手数料の取り分」を1回だけ登録できる（変える時は新しい条件版）。
// 条件（作品・期間）を変えて読み込み中の間は、前の作品・期間の数字を出さない。読み込み中は出力と取り分の登録を止める。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {yen, int, dateTimeJst} from '../ui/format.mjs';
import {describeConditions} from '../ui/condition-model.mjs';
import {useFiscal} from '../reports/use-fiscal.mjs';
import {
  pivotColumns, INVESTOR_COLUMNS, CHANNEL_COLUMNS, ACCRUAL_COLUMNS, SOURCE_COLUMNS, CHECK_COLUMNS, WINDOW_COLUMNS,
  sourceRows, investorRows, committeeMonthlySheets, feeShareDraftState, feeShareText, versionText, currentReportBody, royaltyHoldText, feeSharesDroppedText,
} from './committee-monthly-view.mjs';
import {monthLabel} from './committee-monthly-model.mjs';
import '../reports/reports.css';

const CONDITIONS = ['fiscalYear', 'period', 'work'];
const TABS = [
  {id: 'pnl', label: '月次収支'}, {id: 'investors', label: '出資者別'}, {id: 'channels', label: '区分別売上'},
  {id: 'royalty', label: '権利処理費の内訳'}, {id: 'sources', label: '元明細'}, {id: 'checks', label: '照合'}, {id: 'terms', label: '契約の条件'},
];
const negative = (value) => (value < 0 ? {color: 'var(--bad)'} : undefined);

function HoldNotices({body, report}) {
  const holds = report.holds;
  const royaltyHold = royaltyHoldText(report);
  const dropped = feeSharesDroppedText(report);
  return (
    <>
      {body.royalty && !body.royalty.agreementCount && <Notice tone="warn" compact message={body.royalty.note} />}
      {holds.windowMissing.length > 0 && (
        <Notice tone="warn" compact message={`窓口の条件が無い区分の売上があります（${holds.windowMissing.map((row) => `${row.label} 期間${yen(row.periodSales)}`).join('、')}）。手数料と収入を算定できないため「保留の売上」の行に残し、分配原資に入れていません。製作委員会の画面で窓口を足した新しい条件版を作ると、その適用開始月から計算されます。`} />
      )}
      {royaltyHold && <Notice tone="warn" compact message={royaltyHold} />}
      {dropped && <Notice tone="warn" compact message={dropped} />}
      {holds.invalidFeeShares.length > 0 && (
        <Notice tone="error" compact message={`窓口手数料の取り分の合計が100%でない窓口があります（${holds.invalidFeeShares.map((row) => row.label).join('、')}）。取り分の決まらない窓口手数料${yen(holds.unassignedWindowFee)}は、どの出資者にも割り当てていません。`} />
      )}
      {holds.managerMissing && <Notice tone="error" compact message="幹事手数料がありますが、条件版に幹事が登録されていません。幹事手数料はどの出資者にも割り当てていません。" />}
      {holds.defaultBasisReports > 0 && (
        <Notice tone="info" compact message={`報告額の基準（控除前・控除後）が決まっていない売上報告が${int(holds.defaultBasisReports)}件あり、控除前として PF控除を計算しています。委員会の期間報告で基準を決めると、その基準で計算します（元明細の「報告額の基準」）。`} />
      )}
      {holds.netReported && <Notice tone="info" compact message="控除後で報告された売上があります。PF控除は報告元で差し引き済みのため、その分の PF控除の額は分かりません（「うち控除後で報告された売上」の行）。" />}
    </>
  );
}

function FeeSharePanel({body, request, readOnly, reloading = false, onSaved}) {
  const shell = useShell();
  const windows = useMemo(() => (body.versions?.length ? body.versions.flatMap((version) => version.windows || []) : body.term.windows || []), [body]);
  const open = useMemo(() => windows.filter((window) => !window.feeSharesRegistered), [windows]);
  const [windowId, setWindowId] = useState(open[0] ? String(open[0].id) : '');
  const [inputs, setInputs] = useState({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const candidates = body.term.members || [];
  const draft = feeShareDraftState(candidates, inputs, reason);
  const registerUnsaved = shell.registerUnsaved;
  useEffect(() => {
    registerUnsaved?.('committee-fee-shares', draft.dirty ? 1 : 0, '窓口手数料の取り分（入力中）');
    return () => registerUnsaved?.('committee-fee-shares', 0);
  }, [registerUnsaved, draft.dirty]);
  useEffect(() => {
    if (!open.some((window) => String(window.id) === windowId)) setWindowId(open[0] ? String(open[0].id) : '');
  }, [open, windowId]);

  async function submit(event) {
    event.preventDefault();
    if (!draft.ok || !windowId || reloading) return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await request(`/committee/windows/${windowId}/fee-shares`, {method: 'POST', body: JSON.stringify(draft.payload)});
      const label = windows.find((window) => String(window.id) === windowId)?.label || '';
      setInputs({});
      setReason('');
      setMessage(`「${label}」の窓口手数料の取り分を登録しました。月次収支に反映しています。`);
      onSaved?.();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rp-drill" aria-label="窓口手数料の取り分の登録">
      <p className="rp-drill-head"><strong>窓口手数料の取り分</strong>（条件版の窓口ごと。登録は1回だけで、変える時は変える月を適用開始月にした新しい条件版で登録します）</p>
      <ul className="rp-muted">
        {windows.map((window) => <li key={window.id}>{versionText(window)}｜{window.kindLabel}｜{window.label}: {feeShareText(window)}</li>)}
      </ul>
      {message && <Notice tone="ok" compact message={message} onDismiss={() => setMessage('')} />}
      {readOnly && <p className="rp-muted">閲覧専用のため登録できません。</p>}
      {!readOnly && !open.length && <p className="rp-muted">すべての窓口で取り分を登録済みです。変える場合は、製作委員会の画面で変える月を適用開始月にした新しい条件版を「取り分を引き継がない」で作り、その版の窓口に登録してください。</p>}
      {!readOnly && open.length > 0 && (
        <form onSubmit={submit} className="stack">
          <FormField type="select" label="窓口" required includeBlank={false} value={windowId} disabled={busy || reloading}
            options={open.map((window) => ({value: String(window.id), label: `${versionText(window)}｜${window.kindLabel}｜${window.label}（受取先: ${window.windowPartnerName}）`}))}
            onChange={(value) => setWindowId(value)} />
          <div className="two">
            {candidates.map((member) => (
              <FormField key={member.partnerId} type="text" label={`${member.name} の取り分（%）`} value={inputs[member.partnerId] ?? ''}
                placeholder="例: 50" hint="空欄は取り分なし" disabled={busy || reloading} onChange={(value) => setInputs((previous) => ({...previous, [member.partnerId]: value}))} />
            ))}
          </div>
          <FormField type="textarea" label="登録の理由（契約書の条項など）" required rows={2} maxLength={500} value={reason} disabled={busy || reloading}
            onChange={(value) => setReason(value)} />
          <p className={`rp-check ${draft.totalBps === 10000 ? 'is-ok' : draft.dirty ? 'is-bad' : ''}`}>
            合計 {(draft.totalBps / 100).toLocaleString('ja-JP', {maximumFractionDigits: 2})}%（100%にしてください）
          </p>
          {draft.dirty && !draft.ok && <ul className="on-field-error">{draft.errors.map((text) => <li key={text}>{text}</li>)}</ul>}
          {error && <Notice error={error} compact />}
          <div><button type="submit" disabled={busy || reloading || !draft.ok}>{busy ? '登録中…' : reloading ? '集計し直しています…' : '取り分を登録する'}</button></div>
        </form>
      )}
    </section>
  );
}

// 帳票で使った条件版（「条件版2」「条件版1・2」）
function usedVersionsText(body) {
  const used = (body.versions || []).filter((version) => version.monthCount > 0);
  if (!used.length) return `条件版${body.term.versionNo}`;
  return `条件版${used.map((version) => version.versionNo).join('・')}${(body.versions || []).length > used.length ? `／全${body.versions.length}版` : ''}`;
}

export function CommitteeMonthlyReport({data, request: requestProp, fiscal, onNavigate, withFeeShares = false}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const navigate = onNavigate || shell.navigate;
  const [works, setWorks] = useState(null);
  const [worksError, setWorksError] = useState(null);
  const [state, setState] = useState({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    request('/reports/committee-monthly/works')
      .then((body) => { if (live) { setWorks(Array.isArray(body?.works) ? body.works : []); setWorksError(null); } })
      .catch((error) => { if (live) { setWorks([]); setWorksError(error); } });
    return () => { live = false; };
  }, [request, reloadKey]);

  const defaultWork = useMemo(() => {
    if (!works?.length) return null;
    const current = works.find((work) => String(work.id) === String(shell.workId));
    return String((current || works[0]).id);
  }, [works, shell.workId]);
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth, defaults: defaultWork ? {work: defaultWork} : {}});
  const selected = works?.find((work) => String(work.id) === String(values.workId)) || null;
  const query = selected && values.from && values.to && values.valid
    ? new URLSearchParams({workId: String(selected.id), from: values.from, to: values.to}).toString() : '';

  useEffect(() => {
    if (!query) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null, failure: null}));
    request(`/reports/committee-monthly?${query}`)
      .then((body) => { if (live) setState(body?.ok === false ? {failure: body.error || '集計できませんでした'} : {body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [query, request, reloadKey]);

  // いま選んでいる作品・期間で集計した応答だけを使う（条件を変えて読み込み中の間は前の数字・出力を出さない）
  const body = currentReportBody(state, {workId: selected?.id, from: values.from, to: values.to});
  const report = body?.report;
  const workTitle = body?.work?.title || selected?.title || '';
  const title = workTitle ? `製作委員会の月次収支（${workTitle}）` : '製作委員会の月次収支';
  const names = useMemo(() => ({work: Object.fromEntries((works || []).map((work) => [String(work.id), work.title]))}), [works]);
  const pivot = useMemo(() => pivotColumns(report), [report]);
  const investors = useMemo(() => investorRows(report), [report]);
  const sources = useMemo(() => sourceRows(body), [body]);
  const accrualRows = useMemo(() => (body?.accruals || []).map((row, index) => ({...row, rowId: String(index)})), [body]);
  const s = report?.summary;

  function sheets() {
    const conditions = [...describeConditions(values, CONDITIONS, {names}),
      ['委員会契約', `${body.contract.code}｜${body.contract.title}（${usedVersionsText(body)}）`], ['集計の基準', '計上月・税抜']];
    return committeeMonthlySheets(body, {title, conditions, dataAsOf: body.dataAsOf?.latestImportAt});
  }

  const panels = {
    pnl: () => (
      <DataGrid columns={pivot} rows={report.rows} rowKey="key" showTotals={false} persistKey="committee-monthly-pnl" maxHeight="65vh"
        ariaLabel="月次収支（行＝項目、列＝月・年度計・期間計・累計）" emptyText="この期間の数字はありません" />
    ),
    investors: () => (
      <DataGrid columns={INVESTOR_COLUMNS} rows={investors} rowKey="partnerId" persistKey="committee-monthly-investors" totalLabel="合計" ariaLabel="出資者別の分配と取得額" />
    ),
    channels: () => (
      <DataGrid columns={CHANNEL_COLUMNS} rows={body.incomeRows} rowKey={(row) => `${row.month}:${row.channelGroup}`} persistKey="committee-monthly-channels"
        totalLabel="合計" ariaLabel="計上月×流通の区分の売上と手数料" emptyText="この期間の売上はありません" />
    ),
    royalty: () => (
      <>
        <p className="rp-muted">ロイヤリティの発生額（計上月）です。ロイヤリティ契約の登録がまだ無い作品では、ここは空になります。</p>
        <DataGrid columns={ACCRUAL_COLUMNS} rows={accrualRows} rowKey="rowId" persistKey="committee-monthly-royalty"
          totalLabel="合計" ariaLabel="権利処理費の内訳" emptyText="この期間の権利処理費はありません" />
        {navigate && <button type="button" className="secondary" onClick={() => navigate('ロイヤリティ集計', {workId: String(body.work.id)})}>ロイヤリティ集計を開く</button>}
      </>
    ),
    sources: () => (
      <DataGrid columns={SOURCE_COLUMNS} rows={sources} rowKey="id" persistKey="committee-monthly-sources" totalLabel="合計" maxHeight="55vh"
        ariaLabel="元明細（売上明細と経費）" emptyText="この期間の明細はありません" />
    ),
    checks: () => (
      <>
        <DataGrid columns={CHECK_COLUMNS} rows={report.checks} rowKey="item" showTotals={false} blankZero={false} persistKey="committee-monthly-checks" ariaLabel="照合" />
        <ul className="rp-muted">{(body.notes || []).map((note) => <li key={note}>{note}</li>)}</ul>
        <p className="rp-muted">{body.scope}</p>
      </>
    ),
    terms: () => (
      <>
        <p className="rp-muted">
          契約: {body.contract.code}｜{body.contract.title}（{usedVersionsText(body)}）
          {body.contract.documentTitle ? `・契約書: ${body.contract.documentTitle}` : ''}・幹事: {body.term.managerName || 'なし'}
          ・製作費: {body.term.funding ? yen(body.term.funding.productionCostYen) : '未確認'}
        </p>
        {body.contracts.length > 1 && <Notice tone="info" compact message={`この作品には委員会契約が${body.contracts.length}件あります。最後に登録した契約（${body.contract.code}）で集計しています。`} />}
        {(body.versions || []).length > 1 && <p className="rp-muted">条件版は計上月ごとに、適用開始月がその月以前の版のうち最新の版を使います。{body.versions.map((version) => `${versionText(version)}: ${version.monthCount ? `${monthLabel(version.firstMonth)}〜${monthLabel(version.lastMonth)}の${version.monthCount}か月` : 'この帳票の月では未使用'}`).join('／')}</p>}
        <DataGrid columns={WINDOW_COLUMNS} rows={(body.versions || []).length ? body.versions.flatMap((version) => version.windows || []) : body.term.windows} rowKey="id" showTotals={false} blankZero={false} persistKey="committee-monthly-windows" ariaLabel="窓口の条件" />
      </>
    ),
  };

  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">作品ごとの月次の売上（流通の区分別）・PF控除・窓口手数料・幹事手数料・本委員会収入・経費・権利処理費・分配原資と、出資者別の分配・取得額・回収率です。計上月・税抜。保存済みの委員会の期間報告は変えません。</p>
        </div>
        {body && !state.loading && <ReportOutputBar sheets={sheets} name={`委員会月次収支_${body.work.title}`} period={`${body.conditions.from}〜${body.conditions.to}`} title={title} subtitle={values.periodLabel} formats={['xlsx', 'print', 'html', 'csv']} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} works={works || []} fiscalConfirmed={fiscal?.confirmed} labels={{work: '作品（製作委員会のある作品）'}} />
      {worksError && <Notice error={worksError} onRetry={() => setReloadKey((n) => n + 1)} />}
      {works === null && <p className="rp-muted" aria-busy="true">作品を読み込んでいます…</p>}
      {works && !works.length && !worksError && <Notice tone="info" message="月次収支を出せる作品がありません。製作委員会の画面で委員会契約を登録した作品のうち、財務権限のある作品がここに出ます。" />}
      {works?.length > 0 && values.workId && !selected && <Notice tone="info" message="選んでいる作品には製作委員会の契約が無いか、財務権限がありません。委員会のある作品を選んでください。" />}
      {state.error && <Notice error={state.error} onRetry={() => setReloadKey((n) => n + 1)} />}
      {state.failure && <Notice tone="error" message={state.failure} />}
      {state.loading && <p className="rp-muted" aria-busy="true">{body ? '集計し直しています…' : '集計中…'}</p>}
      {body && report && (
        <>
          <div className="rp-tiles">
            <div><span>売上（期間）</span><strong>{yen(s.period.sales)}</strong>{s.period.holdSales ? <span>うち保留 {yen(s.period.holdSales)}</span> : null}</div>
            <div><span>本委員会収入（期間）</span><strong style={negative(s.period.income)}>{yen(s.period.income)}</strong></div>
            <div><span>分配原資（期間）</span><strong style={negative(s.period.pool)}>{yen(s.period.pool)}</strong></div>
            <div><span>分配額（期間）</span><strong style={negative(s.period.distribution)}>{yen(s.period.distribution)}</strong></div>
            <div><span>未分配（赤字の繰越・期末）</span><strong style={negative(s.cumulative.undistributed)}>{yen(s.cumulative.undistributed)}</strong><span>累計の分配原資 {yen(s.cumulative.cumPool)}</span></div>
          </div>
          <div className="rp-meta">
            <span className={`rp-check ${body.checksOk ? 'is-ok' : 'is-bad'}`}>{body.checksOk ? '照合OK: 売上＝控除・手数料・経費・権利処理費・分配原資の和、分配の和＝分配額' : '照合NG: 照合のタブを確かめてください'}</span>
            <span>データ時点: 最終取込 {body.dataAsOf.latestImportAt ? dateTimeJst(body.dataAsOf.latestImportAt) : 'なし'}（JST）</span>
            <span>売上明細 {int(body.lines.length)}行・経費 {int(body.expenseLines.length)}件・権利処理費 {int(body.accruals.length)}件</span>
            <span>契約 {body.contract.code}（{usedVersionsText(body)}）</span>
            {report.firstMonth < values.from && <span>累計は{monthLabel(report.firstMonth)}から</span>}
          </div>
          {s.deficitMonths.length > 0 && (
            <p className="rp-muted">分配原資の累計が負の月（{s.deficitMonths.length}か月）は分配していません。累計が正に戻った月に、戻った分だけ分配します。</p>
          )}
          <HoldNotices body={body} report={report} />
          <Tabs tabs={TABS} urlKey="cmv" label="月次収支の表">{(active) => (panels[active] || panels.pnl)()}</Tabs>
          {withFeeShares && <FeeSharePanel reloading={Boolean(state.loading)} key={`${body.work.id}:${body.versions?.map((version) => version.id).join(',') || body.term.versionId}`} body={body} request={request} readOnly={shell.readOnly} onSaved={() => setReloadKey((n) => n + 1)} />}
        </>
      )}
    </section>
  );
}

export function CommitteeMonthlyPage({data, onNavigate}) {
  const shell = useShell();
  const [fiscal] = useFiscal(shell.request);
  return <CommitteeMonthlyReport data={data} fiscal={fiscal} onNavigate={onNavigate} withFeeShares />;
}

export default CommitteeMonthlyPage;
