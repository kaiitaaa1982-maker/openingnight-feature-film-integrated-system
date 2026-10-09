// 帳票の発行記録（ロイヤリティ報告書・MG売上報告の下に置く）。
// 「この内容で発行を記録」は画面内の2段確認（要約→「この内容で発行を記録する／戻って直す」）。記録はサーバーが同じ条件で
// 帳票を作り直した内容を保存し、変更・削除できない。発行済みの版は後から Excel で出し直せる。元データが変わると差額を示す。
// 取消は理由必須（これも2段確認）。取消後は同じ条件で再発行できる。外部への送付はしない（人が行う）。
// 使い方: <IssuePanel kind="royalty" conditions={{from, to, holderId, workId}} recipientName="権利元の名前" />
//         <IssuePanel kind="mg-sales" conditions={{direction, month, partyId}} recipientName="取引先の名前" />
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {downloadReportXlsx, reportBaseName} from '../xlsx-report.mjs';
import {dateJst, dateTimeJst, yen} from '../ui/format.mjs';
import {
  ISSUANCE_KINDS, normalizeConditions, conditionsQuery, canIssue, changeMessage, changeDetails, issueSummaryRows,
  issuanceStatus, issuanceSheets, issuanceFileParts, voidReasonError,
} from '../report-issuance.mjs';
import './reports.css';

const HEADLINE_LABEL = {royalty: '当期の権利元額', 'mg-sales': '累計の実充当'};

function SummaryList({rows}) {
  return (
    <dl className="sl-detail">
      {rows.map(([label, value], index) => <div key={`${label}:${index}`}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

export function IssuePanel({kind, conditions, recipientName, request: requestProp}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const def = ISSUANCE_KINDS[kind];
  const conditionsKey = JSON.stringify(conditions || {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const normalized = useMemo(() => normalizeConditions(kind, conditions || {}), [kind, conditionsKey]);
  const query = normalized.ok ? conditionsQuery(kind, normalized.conditions) : '';
  const [state, setState] = useState({});
  const [reloadKey, setReloadKey] = useState(0);
  const [step, setStep] = useState('idle'); // idle | confirm | saving
  const [note, setNote] = useState('');
  const [voiding, setVoiding] = useState(null); // {issuance, step: 'reason'|'confirm'|'saving', reason, error}
  const [result, setResult] = useState(null); // {tone, message, error}
  const [exporting, setExporting] = useState(null);

  useEffect(() => {
    setStep('idle');
    setVoiding(null);
    setNote('');
    if (!query) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/reports/issuances?${query}`)
      .then((body) => { if (live) setState(body?.ok === false ? {error: new Error(body.error || '発行記録を読み込めませんでした')} : {body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [query, request, reloadKey]);

  // 入力途中の発行・取消は未保存として外枠に知らせる（画面移動の前に確かめられる）
  const dirty = step === 'confirm' || Boolean(voiding && (voiding.step === 'confirm' || voiding.reason?.trim()));
  useEffect(() => {
    shell.registerUnsaved?.(`issue-${kind}`, dirty ? 1 : 0, `${def?.label || '帳票'}の発行・取消の入力`);
    return () => shell.registerUnsaved?.(`issue-${kind}`, 0);
  }, [dirty, kind, def, shell]);

  const body = state.body;
  const active = body?.active || null;
  const permission = canIssue({readOnly: shell.readOnly, conditionsResult: normalized, active, blocked: body?.blocked, loading: state.loading || !body});
  const change = changeMessage(body?.comparison);
  const recipient = body?.current?.recipient?.name || recipientName || '';
  const headlineLabel = HEADLINE_LABEL[kind] || '見出しの金額';

  const reload = () => setReloadKey((n) => n + 1);

  async function issue() {
    setStep('saving');
    setResult(null);
    try {
      const response = await request('/reports/issuances', {method: 'POST', body: JSON.stringify({
        kind, conditions: normalized.conditions, expectedContentHash: body.current.contentHash, note: note.trim() || null,
      })});
      if (response?.ok === false) throw new Error(response.error || '発行を記録できませんでした');
      const issued = response.issuance;
      setResult({tone: 'ok', message: `第${issued.versionNo}版として発行を記録しました（発行日 ${dateJst(issued.issuedOn)}・${headlineLabel} ${yen(issued.headlineYen)}）。送付は人が行ってください。`});
      setStep('idle');
      setNote('');
      reload();
    } catch (error) {
      setResult({tone: 'error', error});
      setStep('confirm');
      if (error?.status === 409) reload();
    }
  }

  async function voidIssuance() {
    const target = voiding.issuance;
    setVoiding((previous) => ({...previous, step: 'saving'}));
    setResult(null);
    try {
      const response = await request(`/reports/issuances/${target.id}/void`, {method: 'POST', body: JSON.stringify({reason: voiding.reason.trim()})});
      if (response?.ok === false) throw new Error(response.error || '取り消せませんでした');
      setResult({tone: 'ok', message: `第${target.versionNo}版を取り消しました。取消は記録に残ります。同じ条件で再発行できます。`});
      setVoiding(null);
      reload();
    } catch (error) {
      setResult({tone: 'error', error});
      setVoiding((previous) => (previous ? {...previous, step: 'confirm'} : previous));
    }
  }

  async function exportVersion(item) {
    setExporting(item.id);
    setResult(null);
    try {
      const response = await request(`/reports/issuances/${item.id}`);
      if (response?.ok === false) throw new Error(response.error || '発行記録を読み込めませんでした');
      const issuance = response.issuance;
      const {name, period} = issuanceFileParts(issuance);
      downloadReportXlsx(reportBaseName(name, period), {sheets: issuanceSheets(issuance)});
      setResult({tone: 'ok', message: `第${issuance.versionNo}版を、発行した時の内容でExcelに出力しました。`});
    } catch (error) {
      setResult({tone: 'error', error});
    } finally {
      setExporting(null);
    }
  }

  const historyColumns = [
    {key: 'versionNo', label: '版', type: 'int', total: 'none', sticky: true, render: (row) => `第${row.versionNo}版`},
    {key: 'status', label: '状態', type: 'text', value: (row) => issuanceStatus(row).label,
      render: (row) => <span className={row.void ? 'rp-warn' : 'rp-check is-ok'}>{issuanceStatus(row).label}</span>},
    {key: 'issuedOn', label: '発行日', type: 'date'},
    {key: 'issuedByName', label: '記録した人', type: 'text'},
    {key: 'headlineYen', label: headlineLabel, type: 'yen', total: 'none'},
    {key: 'voidReason', label: '取消の理由', type: 'text', wrap: true, value: (row) => row.void?.reason || '—'},
    {key: 'voidedAt', label: '取消日時', type: 'text', value: (row) => (row.void ? dateTimeJst(row.void.voidedAt) : '—')},
    {key: 'note', label: 'メモ', type: 'text', wrap: true, hidden: true},
    {key: 'excel', label: '出力', type: 'text', sortable: false, export: false,
      render: (row) => (
        <button type="button" className="text" disabled={exporting === row.id} onClick={() => exportVersion(row)}>
          {exporting === row.id ? '出力中…' : 'Excelで出し直す'}
        </button>
      )},
  ];

  const summaryRows = body?.current ? issueSummaryRows(kind, {conditions: normalized.conditions, recipientName: recipient, figures: body.current.figures, note: note.trim()}) : [];

  return (
    <section className="card rp-report" aria-label="発行の記録">
      <header className="rp-head">
        <div>
          <h3>発行の記録</h3>
          <p className="rp-muted">{recipient ? `${recipient} 様へ送る版として` : '送付先へ送る版として'}、この内容を記録します。記録した内容は変更できず、後から同じ版をExcelで出し直せます。送付は人が行います。</p>
        </div>
      </header>
      {!normalized.ok && <Notice tone="info" compact message={normalized.error} />}
      {state.error && <Notice error={state.error} onRetry={reload} />}
      {result && <Notice tone={result.tone} message={result.message} error={result.error} onDismiss={() => setResult(null)} />}
      {state.loading && !body && normalized.ok && <p className="rp-muted" aria-busy="true">発行記録を読み込み中…</p>}

      {active && (
        <div className="stack">
          <div className="rp-meta">
            <span className="rp-check is-ok">発行済</span>
            <span>第{active.versionNo}版・発行日 {dateJst(active.issuedOn)}・記録した人 {active.issuedByName || '未確認'}</span>
            <span>{headlineLabel}（発行時） {yen(active.headlineYen)}</span>
            {body.comparison?.available && !body.comparison.changed && <span className="rp-check is-ok">いまの計算も発行時と同じです</span>}
          </div>
          {change && (
            <Notice tone="warn" message={change}>
              <ul>{changeDetails(body.comparison).map((line) => <li key={line}>{line}</li>)}</ul>
              <p>送った内容を改める場合は、この版を取り消してから再発行してください。</p>
            </Notice>
          )}
          {body.blocked && <Notice tone="warn" compact message={`いまの計算と比べられません: ${body.blocked}`} />}
          {active.note && <p className="rp-muted">メモ: {active.note}</p>}
          {!voiding && (
            <div className="on-form-actions">
              <button type="button" className="secondary" disabled={exporting === active.id} onClick={() => exportVersion(active)}>
                {exporting === active.id ? '出力中…' : 'この版をExcelで出し直す'}
              </button>
              {!shell.readOnly && <button type="button" className="text" onClick={() => setVoiding({issuance: active, step: 'reason', reason: ''})}>この発行を取り消す</button>}
            </div>
          )}
          {voiding && voiding.step === 'reason' && (
            <form className="stack" onSubmit={(event) => {
              event.preventDefault();
              const error = voidReasonError(voiding.reason);
              if (error) setVoiding((previous) => ({...previous, error}));
              else setVoiding((previous) => ({...previous, step: 'confirm', error: null}));
            }}>
              <FormField type="textarea" label="取消の理由" required rows={3} maxLength={1000} wide value={voiding.reason} error={voiding.error}
                hint="例: 追加の売上報告が届いたため、再計算して送り直す" onChange={(value) => setVoiding((previous) => ({...previous, reason: value, error: null}))} />
              <div className="on-form-actions">
                <button type="submit">取消の内容を確かめる</button>
                <button type="button" className="text" onClick={() => setVoiding(null)}>取り消さずに閉じる</button>
              </div>
            </form>
          )}
          {voiding && voiding.step !== 'reason' && (
            <div className="rp-drill" role="group" aria-label="取消の確認">
              <p className="rp-drill-head"><strong>この内容で取り消します。取消は記録に残り、元に戻せません。</strong></p>
              <SummaryList rows={[['取り消す版', `第${voiding.issuance.versionNo}版（発行日 ${dateJst(voiding.issuance.issuedOn)}）`], ['宛先', `${voiding.issuance.recipient?.name || ''} 様`], ['取消の理由', voiding.reason.trim()], ['取消の後', '同じ条件で再発行できます（第' + (voiding.issuance.versionNo + 1) + '版）']]} />
              <div className="on-form-actions">
                <button type="button" disabled={voiding.step === 'saving'} onClick={voidIssuance}>{voiding.step === 'saving' ? '取り消し中…' : 'この内容で取り消す'}</button>
                <button type="button" className="text" disabled={voiding.step === 'saving'} onClick={() => setVoiding((previous) => ({...previous, step: 'reason'}))}>戻って直す</button>
              </div>
            </div>
          )}
        </div>
      )}

      {normalized.ok && body && !active && (
        permission.allowed ? (
          step === 'idle' ? (
            <div className="on-form-actions">
              <button type="button" onClick={() => { setResult(null); setStep('confirm'); }}>この内容で発行を記録</button>
              <span className="rp-muted">{headlineLabel} {yen(body.current.headlineYen)}{body.issuances.length ? `・これまでに${body.issuances.length}版（取消済）` : ''}</span>
            </div>
          ) : (
            <div className="rp-drill" role="group" aria-label="発行の確認">
              <p className="rp-drill-head"><strong>この内容で発行を記録します。記録した内容は変更できません（取り消して再発行はできます）。</strong></p>
              <SummaryList rows={summaryRows} />
              <FormField type="textarea" label="メモ（任意）" rows={2} maxLength={1000} wide value={note} disabled={step === 'saving'}
                hint="送付の予定や宛先の担当など。帳票の数字は変わりません" onChange={(value) => setNote(value)} />
              <div className="on-form-actions">
                <button type="button" disabled={step === 'saving'} onClick={issue}>{step === 'saving' ? '記録中…' : 'この内容で発行を記録する'}</button>
                <button type="button" className="text" disabled={step === 'saving'} onClick={() => setStep('idle')}>戻って直す</button>
              </div>
            </div>
          )
        ) : (
          permission.reason && <Notice tone={body.blocked ? 'warn' : 'info'} compact message={permission.reason} />
        )
      )}

      {body?.issuances?.length > 0 && (
        <details className="rp-legacy" open={Boolean(active) || body.issuances.length > 1}>
          <summary>この条件の発行記録（{body.issuances.length}版）</summary>
          <DataGrid columns={historyColumns} rows={body.issuances} rowKey="id" persistKey={`issuance-history-${kind}`} maxHeight="40vh"
            showTotals={false} ariaLabel="発行記録の版" emptyText="発行記録はありません" />
          <details>
            <summary>記録の識別（技術情報）</summary>
            <ul className="rp-muted">
              {body.issuances.map((item) => <li key={item.id}>第{item.versionNo}版: {item.contentHash}（記録 {dateTimeJst(item.issuedAt)}）</li>)}
              {body.current && <li>いまの計算: {body.current.contentHash}</li>}
            </ul>
          </details>
        </details>
      )}
    </section>
  );
}

export default IssuePanel;
