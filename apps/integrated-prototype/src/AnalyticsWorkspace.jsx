// 分析（帳票と分析の照合）。業務で確定した売上・契約を分析版として固定し、帳票の数字と照合してから分析に使う。
// 分析の更新・処理環境の再起動は管理者だけ。未接続のときは、理由と代わりに見る帳票・接続の手順をその場に出す。
// 英語の技術表示（分析版の番号・エラーの原文など）は「技術情報」の折りたたみへ。
import React, {useEffect, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {Notice} from './ui/Notice.jsx';
import {FormField} from './ui/FormField.jsx';
import {DataGrid} from './ui/DataGrid.jsx';
import {dateJst, dateTimeJst} from './ui/format.mjs';
import {analyticsView, lightdashView, historyRows, jstToday} from './admin/admin-model.mjs';
import './admin/admin.css';

const reportHref = (runId, route = 'report') => `/api/workbench/analytics/${route}?runId=${encodeURIComponent(runId)}`;

function SetupSteps() {
  return (
    <details className="adm-tech-inline">
      <summary>接続の手順（管理者向け・技術情報）</summary>
      <ol className="adm-steps">
        <li>分析用の架空DBを <code>apps/integrated-prototype/scripts/init-workbench-demo.mjs</code> で新しく作ります。既存のDBを後から分析の対象にすることはできません。</li>
        <li>分析用の Python（<code>analytics-poc/.runtime/venv</code>）を用意します。</li>
        <li><code>apps/integrated-prototype/start-workbench.ps1</code> で分析用の架空環境を起動し、その画面で「最新データで分析を更新」を押します。</li>
        <li>クラウドでは、管理者が分析の処理環境と保存先を設定したときだけ使えます。</li>
      </ol>
      <p className="adm-muted">詳しい手順: <code>docs/platform/team-development/workbench-recovery.md</code></p>
    </details>
  );
}

export default function AnalyticsWorkspace({request: requestProp, data, currentUser}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const knownRole = data?.currentUser?.role ?? currentUser?.role ?? null;
  const [sessionRole, setSessionRole] = useState(null);
  const role = knownRole ?? sessionRole;
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [history, setHistory] = useState([]);
  const [asOf, setAsOf] = useState(() => jstToday());
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState('');
  const [result, setResult] = useState(null);

  // 役割が渡されていないときは、ログイン中の利用者から確かめる（再起動・更新の表示に使う。権限はサーバーでも確かめる）
  useEffect(() => {
    if (knownRole) return undefined;
    let live = true;
    request('/session').then((body) => { if (live) setSessionRole(body?.user?.role ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [knownRole, request]);

  useEffect(() => {
    let active = true;
    let timer;
    const load = async () => {
      try {
        const next = await request('/workbench/analytics/status');
        if (!active) return;
        setStatus(next);
        setStatusError(null);
        if (next?.enabled) {
          const body = await request('/workbench/analytics/history');
          if (active) setHistory(Array.isArray(body?.runs) ? body.runs : []);
        }
        if (next?.busy) timer = setTimeout(load, 1500);
      } catch (error) {
        if (active) setStatusError(error);
      }
    };
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [request, refresh]);

  const view = analyticsView({status, error: statusError, role, pending: pending === 'sync'});
  const lightdash = lightdashView(status?.lightdash);
  const current = status?.active || null;
  const rows = historyRows(history, current?.runId);
  const openReports = () => shell.navigate('帳票センター');
  const reportLinks = view.links.length > 0 && (
    <>{view.links.map((link) => <button key={link.page} type="button" className="secondary" onClick={() => shell.navigate(link.page)}>{link.label}</button>)}</>
  );

  async function sync() {
    if (pending || !view.canSync) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      setResult({tone: 'error', message: '残高の基準日を選んでください'});
      return;
    }
    setPending('sync');
    setResult(null);
    try {
      await request('/workbench/analytics/sync', {method: 'POST', body: JSON.stringify({asOf})});
      setResult({tone: 'ok', message: `基準日 ${dateJst(asOf)} で分析の更新を始めました。帳票との照合が終わると新しい分析版に切り替わります。`});
      setRefresh((value) => value + 1);
    } catch (error) {
      setResult({tone: 'error', error});
    } finally {
      setPending('');
    }
  }

  async function restart() {
    if (pending || !view.canRestart) return;
    setPending('restart');
    setResult(null);
    try {
      await request('/workbench/runtime/restart', {method: 'POST', body: JSON.stringify({})});
      setResult({tone: 'ok', message: '処理環境を再起動しました。保存済みの分析版はそのまま残っています。分析を更新できます。'});
      setRefresh((value) => value + 1);
    } catch (error) {
      setResult({tone: 'error', error});
    } finally {
      setPending('');
    }
  }

  const historyColumns = [
    {key: 'verified', label: '照合した日時', type: 'text', sticky: true},
    {key: 'asOf', label: '残高の基準日', type: 'text'},
    {key: 'current', label: '表示中', type: 'text', value: (row) => (row.current ? '表示中の版' : '—')},
    {key: 'open', label: '帳票', type: 'text', searchable: false, sortable: false, value: () => '', render: (row) => (
      <a href={reportHref(row.runId)} target="_blank" rel="noreferrer">この版の照合帳票を開く</a>
    )},
  ];

  return (
    <div className="stack adm-page">
      <section className="card">
        <header className="adm-section-head">
          <div>
            <h2>帳票と分析の照合</h2>
            <p className="adm-muted">業務で確定した売上・契約を分析版として固定し、同じ期間・作品の帳票の数字と照合してから分析に使います。分析版を作っても業務のデータは変わりません。</p>
          </div>
          <button type="button" className="text" onClick={() => setRefresh((value) => value + 1)} disabled={view.state === 'loading'}>状態を読み直す</button>
        </header>
        {readOnly && <Notice tone="info" message="設計キャンバスのプレビューです。分析の更新と再起動はできません（表示だけ）。" compact />}

        {view.state === 'loading' && <p className="adm-muted" aria-busy="true">{view.message}</p>}
        {view.state === 'error' && <Notice error={view.error} onRetry={() => setRefresh((value) => value + 1)} retryLabel="読み直す" />}
        {view.state === 'forbidden' && <Notice tone={view.tone} title={view.title} message={view.message} actions={reportLinks} />}
        {view.state === 'unconfigured' && (
          <Notice tone={view.tone} title={view.title} message={view.message} actions={reportLinks}>
            {view.admin && <SetupSteps />}
          </Notice>
        )}
        {['busy', 'initial', 'stale', 'verified'].includes(view.state) && <Notice tone={view.tone} message={view.message} />}
        {view.lastError && (
          <Notice tone="warn" message={view.lastError.message} technical={view.lastError.technical} />
        )}

        {status?.enabled && view.admin && (
          <div className="adm-asof">
            <FormField type="date" label="残高の基準日" name="asOf" value={asOf} onChange={(value) => setAsOf(value)} required
              hint="請求残高・MG残高をこの日で見ます。売上の計上月とは別です。" disabled={readOnly || !view.canSync} />
            <div className="on-form-actions">
              <button type="button" onClick={sync} disabled={readOnly || !view.canSync || Boolean(pending)}>{view.state === 'busy' ? '更新中…' : '最新データで分析を更新'}</button>
            </div>
          </div>
        )}

        {current && (
          <div className="adm-current">
            <p className="adm-meta">
              <span>表示中の分析版: 照合 {dateTimeJst(current.verifiedAt)}</span>
              <span>残高の基準日 {current.asOf ? dateJst(current.asOf) : '未確認'}</span>
            </p>
            <div className="adm-links">
              <a href={reportHref(current.runId)} target="_blank" rel="noreferrer">照合帳票を開く</a>
              <a href={reportHref(current.runId, 'export')}>売上CSVを保存</a>
            </div>
            <details className="adm-tech-inline">
              <summary>技術情報</summary>
              <dl className="adm-dl adm-dl-tech">
                <div><dt>分析版の番号</dt><dd><code>{current.runId}</code></dd></div>
                {current.snapshotId && <div><dt>読取記録の番号</dt><dd><code>{current.snapshotId}</code></dd></div>}
                {current.auditThrough !== undefined && <div><dt>反映した操作記録</dt><dd>{String(current.auditThrough)}件目まで</dd></div>}
                {current.passedTests !== undefined && <div><dt>通過した照合</dt><dd>{String(current.passedTests)}件</dd></div>}
                {current.definitionStale && <div><dt>集計の定義</dt><dd>分析版を作った後に変わっています</dd></div>}
              </dl>
            </details>
          </div>
        )}

        {view.showRestart && (
          <details className="adm-tech-inline">
            <summary>処理環境（管理者）</summary>
            <p className="adm-muted">分析の処理環境が応答しないときだけ再起動します。保存済みの分析版は消えません。分析の更新中は再起動できません。</p>
            <div className="on-form-actions">
              <button type="button" className="secondary" onClick={restart} disabled={readOnly || !view.canRestart || Boolean(pending)}>{pending === 'restart' ? '再起動中…' : '処理環境を再起動'}</button>
            </div>
          </details>
        )}

        {result && <Notice tone={result.tone} message={result.message} error={result.error} onDismiss={() => setResult(null)} />}
      </section>

      {status?.enabled && (
        <section className="card">
          <h2>分析の画面（Lightdash）</h2>
          {!lightdash.connected && (
            <Notice tone="info" message={lightdash.message} actions={<button type="button" className="secondary" onClick={openReports}>帳票センターを開く</button>} />
          )}
          {lightdash.connected && (
            <>
              <p className="adm-meta">
                <span className={`adm-status adm-tone-${lightdash.tone}`}>{lightdash.label}</span>
                {lightdash.verifiedAt && <span>確認 {lightdash.verifiedAt}</span>}
              </p>
              {lightdash.charts.length > 0
                ? <div className="adm-links">{lightdash.charts.map((chart) => <a key={chart.key} href={chart.url} target="_blank" rel="noreferrer">{chart.name}を開く</a>)}</div>
                : <p className="adm-muted">開けるグラフはまだ登録されていません。</p>}
            </>
          )}
        </section>
      )}

      {status?.enabled && (
        <section className="card">
          <h2>分析の保存履歴</h2>
          <p className="adm-muted">照合を終えた分析版は、作った時点の入力と定義のまま残ります。</p>
          <DataGrid columns={historyColumns} rows={rows} rowKey="key" persistKey="analytics-history" maxHeight="40vh" showTotals={false}
            emptyText="保存済みの分析版はまだありません" ariaLabel="分析の保存履歴" />
        </section>
      )}
    </div>
  );
}
