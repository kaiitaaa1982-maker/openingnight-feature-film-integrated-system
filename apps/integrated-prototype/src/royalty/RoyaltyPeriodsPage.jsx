// ロイヤリティ報告書の作成。契約のサイクルから期間（権利者×締め月）を並べ、状態（受付中・作成待ち・期限超過・作成済・報告済・支払済）と
// 下書きの額を出す。作成待ち・期限超過は、確認のうえ一括で確定版にする（古い順・1件ずつ）。確定版の一覧と取消もここから。
// 定期実行は使わない（規則を登録すれば、基準日の時点で一覧に出る）。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Notice} from '../ui/Notice.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, int, dateJst, dateTimeJst, month as monthText} from '../ui/format.mjs';
import {labelOf} from '../ui/labels.mjs';
import {StatusBadge, ErrorNotice, ReasonAction} from './RoyaltyParts.jsx';
import {todayJst, statusTone, isCreatablePeriod, HOLD_COUNT_COLUMN} from './royalty-ui.mjs';
import '../reports/reports.css';
import './royalty.css';

const CARDS = ['overdue', 'pending', 'open', 'created', 'reported', 'paid', 'merged'];
const PERIOD_COLUMNS = [
  {key: 'status', label: '状態', type: 'text', sticky: true, value: (r) => r.statusLabel, render: (r) => <StatusBadge status={r.status} label={r.statusLabel} />},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'closeMonth', label: '締め月', type: 'month'},
  {key: 'reportDueOn', label: '報告期限', type: 'date', value: (r) => r.reportDueOn || null},
  {key: 'paymentDueOn', label: '支払期限', type: 'date', value: (r) => r.paymentDueOn || null},
  {key: 'kind', label: '内容', type: 'text', value: (r) => (r.statementId ? `確定版 第${r.versionNo}版` : r.blockedReason ? '下書き（確定できません）' : r.draft ? '下書き' : r.restricted ? '権限外の作品を含む' : '—')},
  {key: 'royaltyYen', label: '当期', type: 'yen', total: 'sum'},
  {key: 'adjustmentYen', label: '調整', type: 'yen', total: 'sum'},
  {key: 'payableYen', label: '支払予定額', type: 'yen', total: 'sum'},
  {key: 'carriedOutYen', label: '翌期繰越', type: 'yen', total: 'none'},
  HOLD_COUNT_COLUMN,
  {key: 'blockedReason', label: '確定できない理由', type: 'text', wrap: true, hidden: true, value: (r) => r.blockedReason || ''},
  {key: 'reportedOn', label: '報告日', type: 'text', value: (r) => (r.reportedOn ? dateJst(r.reportedOn) : r.statementId ? '報告の記録なし' : '—')},
  {key: 'paidYen', label: '支払済', type: 'yen', total: 'sum'},
];
const STATEMENT_COLUMNS = [
  {key: 'status', label: '状態', type: 'text', sticky: true, value: (r) => r.statusLabel, render: (r) => <StatusBadge status={r.status} label={r.statusLabel} />},
  {key: 'closeMonth', label: '締め月', type: 'month'},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'versionNo', label: '版', type: 'int', total: 'none'},
  {key: 'payableYen', label: '支払予定額', type: 'yen'},
  {key: 'paidYen', label: '支払済', type: 'yen'},
  {key: 'createdAt', label: '作成日時', type: 'datetime'},
  {key: 'createdByName', label: '作成した人', type: 'text', value: (r) => r.createdByName || ''},
  {key: 'voidReason', label: '取消の理由', type: 'text', wrap: true, value: (r) => r.voided?.reason || ''},
];

export function RoyaltyPeriodsPage({onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const navigate = onNavigate || shell.navigate;
  const today = todayJst();
  const asOf = shell.getParam('asOf', today);
  const holderId = shell.getParam('holder', '');
  const status = shell.getParam('pstatus', '');
  const [state, setState] = useState({loading: true});
  const [statements, setStatements] = useState(null);
  const [revision, setRevision] = useState(0);
  const [step, setStep] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const validAsOf = /^\d{4}-\d{2}-\d{2}$/.test(asOf) && asOf <= today;

  useEffect(() => {
    if (!validAsOf) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    const query = new URLSearchParams({asOf, ...(holderId ? {holderId} : {})});
    request(`/royalty/periods?${query}`).then((body) => live && setState({body})).catch((cause) => live && setState({error: cause}));
    request(`/royalty/statements?includeVoided=1&asOf=${asOf}`).then((body) => live && setStatements(body.statements)).catch(() => live && setStatements([]));
    return () => { live = false; };
  }, [asOf, holderId, validAsOf, request, revision]);

  const body = state.body;
  const rows = useMemo(() => (body?.periods || []).filter((p) => !status || p.status === status), [body, status]);
  const creatable = (body?.periods || []).filter(isCreatablePeriod);
  // 照合が合わない下書き（と、同じ権利者のそれより後の期間）は一括確定から外す。理由は一覧と確認に出す
  const blocked = (body?.periods || []).filter((p) => p.blockedReason);
  const limit = body?.generateLimit || creatable.length;
  const holderOptions = (body?.holders || []).map((h) => ({value: String(h.id), label: h.restricted ? `${h.name}（権限外の作品を含む）` : h.name}));
  const statementRows = (statements || []).filter((s) => !holderId || String(s.holderId) === String(holderId));
  const title = 'ロイヤリティ報告書の作成';

  async function generate() {
    setStep('saving');
    setError(null);
    try {
      const keys = creatable.map((p) => p.key);
      const expectedHashes = Object.fromEntries(creatable.filter((p) => p.draft?.inputHash).map((p) => [p.key, p.draft.inputHash]));
      // 1回に作れるのは上限（generateLimit）まで。残りは結果に出し、続けて作る
      const response = await request('/royalty/statements/generate', {method: 'POST', body: JSON.stringify({asOf, keys, expectedHashes, confirmed: true})});
      setResult(response);
      setStep('idle');
      setRevision((n) => n + 1);
    } catch (cause) {
      setError(cause);
      setStep('confirm');
    }
  }

  function openPeriod(row) {
    if (row.restricted) return;
    navigate('ロイヤリティ報告書', row.statementId ? {statement: String(row.statementId)} : {holder: String(row.holderId), close: row.closeMonth});
  }

  const sheets = () => [
    gridSheetSpec({columns: PERIOD_COLUMNS, rows, exportSpec: {name: '期間の一覧', title: `${title}（期間の一覧）`, conditions: [['基準日', dateJst(asOf)], ['権利者', holderOptions.find((o) => o.value === String(holderId))?.label || 'すべて'], ['状態', status ? labelOf('royaltyPeriodStatus', status) : 'すべて']],
      notes: ['下書きの額は基準日の時点の売上・経費・条件から計算しています。確定すると内容が固定されます。']}}),
    gridSheetSpec({columns: STATEMENT_COLUMNS, rows: statementRows, exportSpec: {name: '確定版', title: '確定版の一覧（取消を含む）'}}),
  ];

  return (
    <div className="stack">
      <section className="card rp-report" aria-label={title}>
        <header className="rp-head">
          <div>
            <h2>{title}</h2>
            <p className="rp-muted">契約のサイクルから、権利者×締め月の期間を並べます。締め月を過ぎて確定版の無い期間が「作成待ち」、報告期限を過ぎて報告の記録が無いものが「期限超過」です。行を押すと報告書（確定版か下書き）を開きます。</p>
          </div>
          {body && <ReportOutputBar sheets={sheets} name="ロイヤリティ報告書の作成" period={dateJst(asOf)} title={title} formats={['xlsx', 'csv', 'print']} />}
        </header>
        <div className="on-conditions">
          <FormField type="date" label="基準日" value={asOf} onChange={(value) => shell.setParam('asOf', value && value !== today ? value : null)}
            hint="この日の時点で締めを過ぎた期間を作成待ちにします（今日以前）" error={validAsOf ? null : '基準日は今日以前の日付にしてください'} />
          <FormField type="select" label="権利者" value={holderId} blankLabel="すべての権利者" options={holderOptions} onChange={(value) => shell.setParam('holder', value || null)} />
        </div>
        {state.error && <ErrorNotice error={state.error} />}
        {state.loading && !body && <p className="rp-muted" aria-busy="true">期間を並べています…</p>}
        {body && (
          <>
            <div className="rp-tiles pm-cards" role="group" aria-label="状態で絞り込む">
              {CARDS.map((code) => (
                <button key={code} type="button" className={`pm-card is-${statusTone(code)}`} aria-pressed={status === code}
                  onClick={() => shell.setParam('pstatus', status === code ? null : code)}>
                  <span>{labelOf('royaltyPeriodStatus', code)}</span><strong>{int(body.counts[code] || 0)}</strong>
                </button>
              ))}
            </div>
            {!body.periods.length && <Notice tone="info" message="ロイヤリティ契約とサイクルがまだありません。「ロイヤリティ契約」で登録すると、ここに期間が並びます。"
              actions={navigate ? <button type="button" className="secondary" onClick={() => navigate('ロイヤリティ契約')}>ロイヤリティ契約を開く</button> : null} />}
            <div className="rp-meta">
              <span>作成待ち・期限超過（未作成）: {int(creatable.length)}件・支払予定額の合計 {yen(creatable.reduce((n, p) => n + (p.payableYen ?? 0), 0))}{blocked.length ? `（照合が合わず確定できない${int(blocked.length)}件を除く）` : ''}</span>
              <span>データ時点: 最終取込 {body.latestImportAt ? dateTimeJst(body.latestImportAt) : 'なし'}（JST）</span>
              {!shell.readOnly && step === 'idle' && (
                <button type="button" disabled={!creatable.length} onClick={() => { setResult(null); setStep('confirm'); }}>作成待ちを一括で確定する（{int(creatable.length)}件）</button>
              )}
            </div>
            {blocked.length > 0 && (
              <Notice tone="warn" title={`照合が合わないため確定できない期間が${int(blocked.length)}件あります`}
                message="下書きの照合（明細の和・累計・集計シートとの一致など）に差額がある期間は、一括の確定から外しています。行を押して報告書の「照合」の表で差額の元を確かめ、元のデータ（イレギュラーの台帳・サイクル・条件）を直してください。"
                details={blocked.slice(0, 20).map((p) => `${p.holderName}・${monthText(p.closeMonth)}締め：${p.blockedReason}`)} />
            )}
            {step !== 'idle' && (
              <Notice tone="warn" title={`${int(Math.min(creatable.length, limit))}件の報告書を確定しますか`}
                message={`基準日 ${dateJst(asOf)}の時点の内容で、権利者ごとに古い締め月から確定版を作ります。確定した報告書は変更できません（直すときは取り消して作り直します）。${creatable.length > limit ? `1回に作れるのは${int(limit)}件までです。残りの${int(creatable.length - limit)}件は、確定の後にもう一度押して続けて作ってください。` : ''}${blocked.length ? `照合が合わない${int(blocked.length)}件は作りません。` : ''}`}
                details={creatable.slice(0, 50).map((p) => `${p.holderName}・${monthText(p.closeMonth)}締め：支払予定額 ${yen(p.payableYen ?? 0)}${p.holdCount ? `（保留${p.holdCount}件）` : ''}`)}
                actions={<>
                  <button type="button" disabled={step === 'saving'} onClick={generate}>{step === 'saving' ? '作成中…' : 'この内容で確定する'}</button>
                  <button type="button" className="secondary" disabled={step === 'saving'} onClick={() => setStep('idle')}>やめる</button>
                </>} />
            )}
            <ErrorNotice error={error} />
            {result && (
              <Notice tone={result.skipped.length || result.remaining?.count ? 'warn' : 'ok'} onDismiss={() => setResult(null)}
                message={`${result.created.length}件を確定しました。${result.skipped.length ? `${result.skipped.length}件は作れませんでした。` : ''}${result.remaining?.count ? `1回の上限（${int(result.limit)}件）に達したため、残りの${int(result.remaining.count)}件は「作成待ちを一括で確定する」をもう一度押して続けて作ってください。` : ''}`}
                details={result.skipped.length ? result.skipped.map((s) => {
                  const period = (body.periods || []).find((p) => p.key === s.key);
                  return `${period ? `${period.holderName}・${monthText(period.closeMonth)}締め` : '指定の期間'}：${s.reason}`;
                }) : undefined} />
            )}
            <DataGrid columns={PERIOD_COLUMNS} rows={rows} rowKey="key" persistKey="royalty-periods" maxHeight="55vh" onRowClick={openPeriod}
              emptyText={status ? 'この状態の期間はありません' : '期間はありません'} />
            <p className="rp-muted">「後の報告書に含める」は、その後の締め月の報告書が確定済みのため、この期間の分を次に作る報告書に含める期間です。</p>
          </>
        )}
      </section>

      <section className="card rp-report" aria-label="確定版の一覧">
        <header className="rp-head">
          <div>
            <h2>確定版の一覧</h2>
            <p className="rp-muted">取り消せるのは、権利者ごとの最新の確定版で、支払の記録が無いものだけです（取り消すと作成待ちに戻り、作り直せます）。行を開くと取り消せます。</p>
          </div>
        </header>
        {statements && (
          <DataGrid columns={STATEMENT_COLUMNS} rows={statementRows} rowKey="id" persistKey="royalty-period-statements" maxHeight="40vh" emptyText="まだ確定版はありません"
            renderDetail={(row) => (
              <div className="rp-drill">
                <div className="ry-actions">
                  <button type="button" className="secondary" onClick={() => navigate('ロイヤリティ報告書', {statement: String(row.id)})}>報告書を開く</button>
                  {row.canVoid && !shell.readOnly && (
                    <ReasonAction label="この確定版を取り消す" confirmTitle="確定版を取り消しますか"
                      confirmText={`${row.holderName}・${monthText(row.closeMonth)}締めの第${row.versionNo}版を取り消します`}
                      onConfirm={(reason) => request(`/royalty/statements/${row.id}/void`, {method: 'POST', body: JSON.stringify({reason})}).then(() => setRevision((n) => n + 1))} />
                  )}
                </div>
                {!row.canVoid && row.status !== 'voided' && <p className="rp-muted">後の締め月の確定版があるか、支払の記録があるため取り消せません。</p>}
              </div>
            )} />
        )}
      </section>
    </div>
  );
}

export default RoyaltyPeriodsPage;
