// 追加項目（宣伝の指標など）の提案と採否。記録したい内容を日本語で書くと、型・単位・集計方法の候補ができる。
// 管理者が採用すると、宣伝の入力・CSV取込・分析で使える項目になる。採用・不採用は元に戻せないので画面内で2段確認する。
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {
  proposalView, proposalCounts, filterProposals, decisionSummary, validateRequestText, parseProposalJson,
} from './admin-model.mjs';
import './admin.css';

const STATUS_TABS = [
  {id: 'pending', label: '確認待ち'},
  {id: 'adopted', label: '採用'},
  {id: 'rejected', label: '不採用'},
  {id: 'all', label: 'すべて'},
];

const JSON_EXAMPLE = '{"fieldKey":"trailer_completion","label":"予告編の完全視聴数","valueType":"integer","unit":"回","aggregation":"sum","meaningReason":"…","affectedApps":["publicity-form"]}';

function ProposalItem({row, isAdmin, readOnly, confirming, busy, onAsk, onCancel, onDecide}) {
  const view = proposalView(row);
  const asking = confirming?.id === row.id ? confirming.decision : null;
  return (
    <article className="adm-proposal" aria-label={view.label}>
      <header className="adm-proposal-head">
        <div>
          <h3>{view.label}</h3>
          <p className="adm-muted">{view.summary}</p>
        </div>
        <span className={`adm-status adm-tone-${view.tone}`}>{view.statusLabel}</span>
      </header>
      <dl className="adm-dl">
        <div><dt>依頼</dt><dd>{view.request || '記録なし'}</dd></div>
        <div><dt>意味・理由</dt><dd>{view.reason || '記録なし'}</dd></div>
        <div><dt>使える場所</dt><dd>{view.affected}</dd></div>
        <div><dt>候補の作り方</dt><dd>{view.source}</dd></div>
        <div><dt>提案日時</dt><dd>{view.created}</dd></div>
        {view.decided && <div><dt>判断日時</dt><dd>{view.decided}</dd></div>}
      </dl>
      <details className="adm-tech-inline">
        <summary>技術情報</summary>
        <dl className="adm-dl adm-dl-tech">
          {view.technical.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{String(value)}</code></dd></div>)}
        </dl>
      </details>
      {view.pending && isAdmin && !asking && (
        <div className="on-form-actions">
          <button type="button" onClick={() => onAsk(row.id, 'adopt')} disabled={readOnly || Boolean(busy)}>採用する</button>
          <button type="button" className="secondary" onClick={() => onAsk(row.id, 'reject')} disabled={readOnly || Boolean(busy)}>不採用にする</button>
        </div>
      )}
      {view.pending && isAdmin && asking && (
        <div className="adm-confirm" role="group" aria-label="確認">
          <p>{decisionSummary(row, asking)}</p>
          <div className="on-form-actions">
            <button type="button" onClick={() => onDecide(row, asking)} disabled={readOnly || busy === 'decide'}>
              {busy === 'decide' ? '処理中…' : asking === 'adopt' ? 'この内容で採用する' : 'この内容で不採用にする'}
            </button>
            <button type="button" className="secondary" onClick={onCancel} disabled={busy === 'decide'}>戻る</button>
          </div>
        </div>
      )}
      {view.pending && !isAdmin && <p className="adm-muted">採用・不採用は管理者が決めます。</p>}
    </article>
  );
}

export function ExtensionsPage({data, reload, request: requestProp}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const isAdmin = data?.currentUser?.role === 'admin';
  const aiEnabled = Boolean(data?.ai?.enabled);
  const [list, setList] = useState({loading: true, rows: []});
  const [text, setText] = useState('');
  const [textError, setTextError] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const registerUnsaved = shell.registerUnsaved;

  const load = useCallback(async () => {
    setList((previous) => ({...previous, loading: true, error: null}));
    try {
      const body = await request('/proposals');
      setList({loading: false, rows: Array.isArray(body?.rows) ? body.rows : []});
    } catch (error) {
      setList((previous) => ({...previous, loading: false, error}));
    }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const pendingInput = (text.trim() ? 1 : 0) + (jsonText.trim() ? 1 : 0);
  useEffect(() => {
    registerUnsaved?.('extensions-proposal', pendingInput, '追加項目の提案（入力中）');
    return () => registerUnsaved?.('extensions-proposal', 0);
  }, [registerUnsaved, pendingInput]);

  const counts = useMemo(() => proposalCounts(list.rows), [list.rows]);
  const tabs = STATUS_TABS.map((tab) => ({...tab, badge: counts[tab.id] || undefined}));

  function showPending() {
    shell.setParam('status', 'pending', {replace: true});
  }

  async function suggest(kind) {
    const problem = validateRequestText(text);
    setTextError(problem);
    if (problem) return;
    setBusy(kind);
    setResult(null);
    try {
      await request(kind === 'ai' ? '/proposals/ai' : '/proposals/suggest', {method: 'POST', body: JSON.stringify({request: text.trim()})});
      setResult({tone: 'ok', message: kind === 'ai'
        ? 'AIで候補を作りました。下の「確認待ち」で型・単位・集計方法を確かめてください。'
        : '規則で候補を作りました（AIは使っていません）。下の「確認待ち」で型・単位・集計方法を確かめてください。'});
      setText('');
      showPending();
      await load();
    } catch (error) {
      setResult({tone: 'error', error});
    } finally {
      setBusy('');
    }
  }

  async function importJson() {
    const parsed = parseProposalJson(jsonText);
    setJsonError(parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    setBusy('json');
    setResult(null);
    try {
      await request('/proposals/import', {method: 'POST', body: JSON.stringify(parsed.value)});
      setResult({tone: 'ok', message: '貼り付けた提案を確かめて保存しました（この画面からAIは呼び出していません）。下の「確認待ち」で内容を確かめてください。'});
      setJsonText('');
      showPending();
      await load();
    } catch (error) {
      setResult({tone: 'error', error});
    } finally {
      setBusy('');
    }
  }

  async function decide(row, decision) {
    setBusy('decide');
    setResult(null);
    try {
      await request(`/proposals/${encodeURIComponent(row.id)}/${decision}`, {method: 'POST', body: JSON.stringify({hash: row.proposal_hash, baseSchemaVersion: row.base_schema_version})});
      const label = row.label || '提案';
      setResult({tone: 'ok', message: decision === 'adopt'
        ? `「${label}」を項目として追加しました。宣伝の入力などで使えます。`
        : `「${label}」を不採用にしました。`});
      setConfirming(null);
      await load();
      reload?.();
    } catch (error) {
      setResult({tone: 'error', error});
      setConfirming(null);
      await load();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="stack adm-page">
      <section className="card">
        <h2>記録したい項目を提案する</h2>
        <p className="adm-muted">宣伝の指標など、いまの入力欄に無い項目を日本語で書くと、値の型・単位・集計方法の候補を作ります。候補は管理者が確かめてから採用します。</p>
        {readOnly && <Notice tone="info" message="設計キャンバスのプレビューです。提案の作成と採否はできません（表示だけ）。" compact />}
        <div className="on-form-grid adm-form-one">
          <FormField type="textarea" label="記録したい内容" name="request" value={text} onChange={(value) => { setText(value); if (textError) setTextError(''); }}
            placeholder="例: 予告編の完全視聴数を回数で記録したい" rows={3} maxLength={2000} error={textError} required
            hint="何を・どの単位で・何のために記録したいかを書きます（2,000文字まで）。" disabled={readOnly} />
        </div>
        <div className="on-form-actions">
          <button type="button" onClick={() => suggest('rule')} disabled={readOnly || Boolean(busy)}>{busy === 'rule' ? '作成中…' : '規則で候補を作る'}</button>
          <button type="button" className="secondary" onClick={() => suggest('ai')} disabled={readOnly || Boolean(busy) || !aiEnabled}>{busy === 'ai' ? '作成中…' : 'AIで候補を作る'}</button>
        </div>
        <p className="adm-muted">{aiEnabled
          ? 'AIの接続が有効です。管理者が決めたモデルと回数の上限の範囲で使います。'
          : '「AIで候補を作る」は、この環境でAIの接続が有効になっていないため使えません。管理者が接続と利用上限を設定すると使えます。「規則で候補を作る」はAIを使わずに作ります。'}</p>
        <details className="adm-tech-inline">
          <summary>外部のAIで作った提案を貼り付ける</summary>
          <p className="adm-muted">別のAIで作った提案（{'{'} から {'}'} までの1件）を貼り付けると、形と内容を確かめてから保存します。</p>
          <div className="on-form-grid adm-form-one">
            <FormField type="textarea" label="提案（JSON）" name="proposal-json" value={jsonText} onChange={(value) => { setJsonText(value); if (jsonError) setJsonError(''); }}
              rows={6} placeholder={JSON_EXAMPLE} error={jsonError} disabled={readOnly} />
          </div>
          <div className="on-form-actions">
            <button type="button" className="secondary" onClick={importJson} disabled={readOnly || Boolean(busy)}>{busy === 'json' ? '確認中…' : '内容を確かめて保存'}</button>
          </div>
        </details>
        {result && <Notice tone={result.tone} message={result.message} error={result.error} onDismiss={() => setResult(null)} />}
      </section>

      <section className="card">
        <header className="adm-section-head">
          <div>
            <h2>提案の一覧</h2>
            <p className="adm-muted">{isAdmin ? '確認待ちの提案を採用すると、その項目が使えるようになります。採用・不採用は元に戻せません。' : '採用・不採用は管理者が決めます。ここでは提案の内容と結果を確かめられます。'}</p>
          </div>
          <button type="button" className="text" onClick={load} disabled={list.loading}>{list.loading ? '読み込み中…' : '再読込'}</button>
        </header>
        {list.error && <Notice error={list.error} onRetry={load} />}
        <Tabs tabs={tabs} urlKey="status" defaultValue="pending" label="提案の状態">
          {(active) => {
            const rows = filterProposals(list.rows, active);
            if (list.loading && !list.rows.length) return <p className="adm-muted" aria-busy="true">読み込み中…</p>;
            if (!rows.length && active === 'pending' && list.rows.length) {
              return <p className="empty">確認待ちの提案はありません。<button type="button" className="text" onClick={() => shell.setParam('status', 'all', {replace: true})}>すべての提案を見る</button></p>;
            }
            if (!rows.length) return <p className="empty">{list.rows.length ? '該当する提案はありません。' : 'まだ提案はありません。上の欄に記録したい内容を書いて候補を作ります。'}</p>;
            return (
              <div className="adm-proposals">
                {rows.map((row) => (
                  <ProposalItem key={row.id} row={row} isAdmin={isAdmin} readOnly={readOnly} confirming={confirming} busy={busy}
                    onAsk={(id, decision) => setConfirming({id, decision})} onCancel={() => setConfirming(null)} onDecide={decide} />
                ))}
              </div>
            );
          }}
        </Tabs>
      </section>
    </div>
  );
}

export default ExtensionsPage;
