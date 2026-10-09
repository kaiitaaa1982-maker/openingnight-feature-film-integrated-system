// 営業パイプライン（全作品）。作品を切り替えずに、段階別の件数と見込額、次の行動の期限、納期超過・遅延提出を見る。
// 「商品・営業」の中で SalesViewSwitch が「選択中の作品」と「全作品のパイプライン」を切り替える（URL の view に残る）。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {FormField} from '../ui/FormField.jsx';
import {yen, int, dateJst} from '../ui/format.mjs';
import {labelOf} from '../ui/labels.mjs';
import {todayJst, STAGE_ORDER} from './pipeline-routes.mjs';
import '../reports/reports.css';
import './sales-ops.css';

// 状態の表示（色＋文字）。tone: ok | warn | bad | info
export function ToneLabel({tone = 'info', children}) {
  return <span className={`so-tone so-tone-${tone}`}>{children}</span>;
}

const STAGE_FILTERS = [{id: '', label: 'すべて'}, ...STAGE_ORDER.map((stage) => ({id: stage, label: labelOf('opportunityStage', stage)})), {id: 'overdue', label: '次の行動が期限切れ'}];

const OPPORTUNITY_COLUMNS = [
  {key: 'work_title', label: '作品', type: 'text', sticky: true},
  {key: 'name', label: '営業案件', type: 'text', sticky: true},
  {key: 'partner_name', label: '取引先', type: 'text'},
  {key: 'stage', label: '段階', type: 'status', domain: 'opportunityStage'},
  {key: 'expected_yen', label: '見込（円）', type: 'yen', total: 'sum'},
  {key: 'close_date', label: '予定日', type: 'date'},
  {key: 'next_action', label: '次の行動', type: 'text', wrap: true, value: (row) => row.next_action || '—'},
  {key: 'next_due_on', label: '次の期限', type: 'date'},
  {key: 'next_state', label: '期限の状況', type: 'text', value: (row) => row.next?.label, render: (row) => <ToneLabel tone={row.next?.tone}>{row.next?.label}</ToneLabel>},
  {key: 'last_activity_on', label: '最終の活動日', type: 'date'},
];

const DELIVERABLE_COLUMNS = [
  {key: 'work_title', label: '作品', type: 'text', sticky: true},
  {key: 'title', label: '納品物', type: 'text', sticky: true},
  {key: 'contract_code', label: '契約コード', type: 'code'},
  {key: 'partner_name', label: '取引先', type: 'text'},
  {key: 'term_label', label: '条件版', type: 'text'},
  {key: 'due_on', label: '期限', type: 'date'},
  {key: 'status', label: '状態', type: 'status', domain: 'deliverableStatus'},
  {key: 'submitted_on', label: '提出日', type: 'date'},
  {key: 'accepted_on', label: '受領日', type: 'date'},
  {key: 'timing', label: '判定', type: 'text', value: (row) => row.timing?.label, render: (row) => <ToneLabel tone={row.timing?.tone}>{row.timing?.label}</ToneLabel>},
  {key: 'note', label: 'メモ', type: 'text', wrap: true, hidden: true},
];

function tileClass(count, tone) {
  return count > 0 ? `is-${tone}` : undefined;
}

// 集計のタイル。children に足したいタイル（<div role="listitem">）を渡すと末尾に並べる。
export function PipelineTiles({summary, children}) {
  if (!summary) return null;
  return (
    <div className="rp-tiles so-tiles" role="list" aria-label="営業の集計">
      {summary.stages.map((stage) => (
        <div key={stage.stage} role="listitem">
          <span>{stage.label}</span>
          <strong>{int(stage.count)}件</strong>
          <small>見込額 {yen(stage.expectedYen)}{stage.unknownCount ? `（見込額が未入力 ${int(stage.unknownCount)}件）` : ''}</small>
        </div>
      ))}
      <div role="listitem">
        <span>進行中の見込（見込・提案・交渉）</span>
        <strong>{yen(summary.open.expectedYen)}</strong>
        <small>{int(summary.open.count)}件{summary.open.unknownCount ? `・見込未入力 ${int(summary.open.unknownCount)}件は含まない` : ''}</small>
      </div>
      <div role="listitem" className={tileClass(summary.nextActionOverdue, 'bad')}>
        <span>次の行動が期限切れ</span>
        <strong>{int(summary.nextActionOverdue)}件</strong>
        <small>{summary.nextActionOverdue ? '期限を過ぎています' : '期限切れはありません'}</small>
      </div>
      <div role="listitem" className={tileClass(summary.deliverableOverdue, 'bad')}>
        <span>納期超過（未提出）</span>
        <strong>{int(summary.deliverableOverdue)}件</strong>
        <small>納品 {int(summary.deliverableCount)}件のうち</small>
      </div>
      <div role="listitem" className={tileClass(summary.lateSubmitted, 'warn')}>
        <span>遅延提出（期限後に提出）</span>
        <strong>{int(summary.lateSubmitted)}件</strong>
        <small>{summary.lateSubmitted ? '提出済みでも期限後の提出として数えます' : '期限後の提出はありません'}</small>
      </div>
      {children}
    </div>
  );
}

export function PipelineBoard({request: requestProp}) {
  const shell = useShell();
  const requestRef = useRef(null);
  requestRef.current = requestProp || shell.request;
  const today = todayJst();
  const asOf = shell.getParam('asOf', today) || today;
  const stageFilter = shell.getParam('stage', '') || '';
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    requestRef.current(`/sales-pipeline?asOf=${encodeURIComponent(asOf)}`)
      .then((body) => { if (live) setState({body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [asOf, revision]);
  const load = useCallback(() => setRevision((n) => n + 1), []);

  const body = state.body;
  const opportunities = useMemo(() => {
    const rows = body?.opportunities || [];
    if (!stageFilter) return rows;
    if (stageFilter === 'overdue') return rows.filter((row) => row.stage !== 'lost' && row.next?.overdue);
    return rows.filter((row) => row.stage === stageFilter);
  }, [body, stageFilter]);
  const deliverables = body?.deliverables || [];
  const deliverableAttention = deliverables.filter((row) => row.timing?.overdue || row.timing?.late).length;
  const exportConditions = [['判定日', dateJst(asOf)], ['対象', '営業（財務）の権限がある全作品']];

  const openWork = (row, params) => shell.navigate('商品・営業', {view: 'work', ...params}, {workId: row.work_id});

  return (
    <div className="so-page">
      <section className="card rp-report" aria-label="営業パイプライン">
        <header className="so-head">
          <div>
            <h2>営業パイプライン（全作品）</h2>
            <p className="rp-muted">{body?.scopeNote || '営業（財務）の権限がある作品だけを集計します。'}</p>
          </div>
          <FormField type="date" label="期限の判定日" value={asOf} hint="この日を基準に期限切れ・納期超過を数えます"
            onChange={(value) => shell.setParam('asOf', value && value !== today ? value : null, {replace: true})} />
        </header>
        {state.error && <Notice error={state.error} onRetry={load} />}
        {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
        {body && <PipelineTiles summary={body.summary} />}
      </section>

      {body && (
        <section className="card so-section">
          <Tabs urlKey="pipe" label="パイプラインの表示" tabs={[
            {id: 'opportunities', label: '営業案件', badge: body.opportunities.length},
            {id: 'deliverables', label: '納品', badge: deliverableAttention ? `注意 ${deliverableAttention}` : deliverables.length},
          ]}>
            {(active) => (active === 'deliverables'
              ? (
                <DataGrid columns={DELIVERABLE_COLUMNS} rows={deliverables} rowKey="id" persistKey="sales-pipeline-deliverables"
                  emptyText="納品項目はまだありません。作品の営業画面の「契約版ごとの納品」で登録します。" initialSort={{key: 'due_on', dir: 'asc'}}
                  exportSpec={{name: '営業パイプライン_納品', title: '営業パイプライン（納品）', conditions: exportConditions, dataAsOf: dateJst(today),
                    notes: ['判定: 提出日が期限より後の納品は「遅延提出（n日）」、未提出で期限を過ぎた納品は「納期超過（n日）」。']}}
                  renderDetail={(row) => (
                    <div className="so-detail">
                      <p className="rp-muted">{row.agreement_title || '契約名未確認'}・{row.term_label || '条件版未確認'}{row.note ? `・メモ: ${row.note}` : ''}</p>
                      {row.timing?.future && <Notice tone="warn" compact message="提出日が判定日より後の日付です。実績の日付を確認してください。" />}
                      <div className="so-actions">
                        <button type="button" className="secondary" onClick={() => openWork(row, {deliverable: String(row.id)})}>この作品の納品を開く</button>
                      </div>
                    </div>
                  )} />
              )
              : (
                <div className="so-section">
                  <div className="rp-filter" role="group" aria-label="段階で絞る">
                    {STAGE_FILTERS.map((filter) => (
                      <button key={filter.id || 'all'} type="button" className="secondary" aria-pressed={stageFilter === filter.id}
                        onClick={() => shell.setParam('stage', filter.id || null, {replace: true})}>{filter.label}</button>
                    ))}
                  </div>
                  <DataGrid columns={OPPORTUNITY_COLUMNS} rows={opportunities} rowKey="id" persistKey="sales-pipeline-opportunities"
                    emptyText={stageFilter ? 'この条件に合う営業案件はありません。' : '営業案件はまだありません。作品の営業画面で登録します。'}
                    initialSort={{key: 'next_due_on', dir: 'asc'}}
                    exportSpec={{name: '営業パイプライン_営業案件', title: '営業パイプライン（営業案件）', dataAsOf: dateJst(today),
                      conditions: [...exportConditions, ['段階', STAGE_FILTERS.find((filter) => filter.id === stageFilter)?.label || 'すべて']],
                      notes: ['見込が未入力の案件は金額の合計に含めていません。', '商談見込と契約条件の見込は別の数字です。']}}
                    renderDetail={(row) => (
                      <div className="so-detail">
                        <p className="rp-muted">
                          最新の活動: {row.last_activity_on ? `${dateJst(row.last_activity_on)}・${row.last_activity_summary || '要約なし'}` : 'まだありません'}
                        </p>
                        <div className="so-actions">
                          <button type="button" className="secondary" onClick={() => openWork(row, {opp: String(row.id)})}>この作品の営業を開く</button>
                        </div>
                      </div>
                    )} />
                </div>
              ))}
          </Tabs>
        </section>
      )}
    </div>
  );
}

// 「商品・営業」の切替。workView には選択中の作品の営業画面（商品・配賦・営業案件・契約・納品）を渡す。
export function SalesViewSwitch({workView, workTitle, request}) {
  return (
    <Tabs urlKey="view" label="営業の表示" className="so-view-switch" tabs={[
      {id: 'work', label: workTitle ? `選択中の作品（${workTitle}）` : '選択中の作品'},
      {id: 'pipeline', label: '全作品のパイプライン'},
    ]}>
      {(active) => (active === 'pipeline' ? <PipelineBoard request={request} /> : workView)}
    </Tabs>
  );
}

export default PipelineBoard;
