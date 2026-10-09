// ロイヤリティ報告書・支払。確定版の一覧（権利者・締め月・状態・支払予定額・支払済・未払）と、選んだ報告書の本体
// （表紙・作品×種別・経費の控除・前払金と繰越・調整・報告と支払の記録・照合・前提）。報告と支払はここで記録する。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Notice} from '../ui/Notice.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {month as monthText, dateJst} from '../ui/format.mjs';
import {StatusBadge, ErrorNotice} from './RoyaltyParts.jsx';
import {RoyaltyStatementView} from './RoyaltyCycleReport.jsx';
import {HOLD_COUNT_COLUMN} from './royalty-ui.mjs';
import '../reports/reports.css';
import './royalty.css';

const STATUS_FILTERS = [
  {value: '', label: 'すべて'}, {value: 'unreported', label: '報告の記録なし'}, {value: 'unpaid', label: '未払あり'}, {value: 'done', label: '支払済・完了'}, {value: 'voided', label: '取消済み'},
];
const COLUMNS = [
  {key: 'status', label: '状態', type: 'text', sticky: true, value: (r) => r.statusLabel, render: (r) => <StatusBadge status={r.status} label={r.statusLabel} />},
  {key: 'closeMonth', label: '締め月', type: 'month'},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'versionNo', label: '版', type: 'int', total: 'none'},
  {key: 'royaltyYen', label: '当期', type: 'yen'},
  {key: 'adjustmentYen', label: '調整', type: 'yen'},
  {key: 'advanceRecoupedYen', label: '前払金の充当', type: 'yen'},
  {key: 'payableYen', label: '支払予定額', type: 'yen'},
  {key: 'paidYen', label: '支払済', type: 'yen'},
  {key: 'unpaidYen', label: '未払', type: 'yen'},
  {key: 'carriedOutYen', label: '翌期繰越', type: 'yen'},
  {key: 'reportDueOn', label: '報告期限', type: 'date'},
  {key: 'reportedOn', label: '報告日', type: 'text', value: (r) => (r.reportedOn ? dateJst(r.reportedOn) : '報告の記録なし')},
  {key: 'paymentDueOn', label: '支払期限', type: 'date'},
  HOLD_COUNT_COLUMN,
];

function matches(row, filter) {
  if (filter === 'voided') return row.status === 'voided';
  if (row.status === 'voided') return false;
  if (filter === 'unreported') return !row.reportedOn;
  if (filter === 'unpaid') return row.unpaidYen > 0;
  if (filter === 'done') return row.status === 'paid' || (row.reportedOn && row.unpaidYen === 0);
  return true;
}

export function RoyaltyStatementsPage({onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const statementId = shell.getParam('statement', '');
  const holderId = shell.getParam('holder', '');
  const closeMonth = shell.getParam('close', '');
  const filter = shell.getParam('rstate', '');
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request('/royalty/statements?includeVoided=1').then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [request, revision]);
  const body = state.body;
  const rows = useMemo(() => (body?.statements || []).filter((row) => (!holderId || String(row.holderId) === String(holderId)) && matches(row, filter)), [body, holderId, filter]);
  const holderOptions = (body?.holders || []).filter((h) => !h.restricted).map((h) => ({value: String(h.id), label: h.name}));
  const restricted = (body?.holders || []).filter((h) => h.restricted);
  const open = (row) => {
    shell.setParam('close', null);
    shell.setParam('statement', String(row.id), {replace: false});
  };
  const title = 'ロイヤリティ報告書・支払';
  const sheets = () => [gridSheetSpec({columns: COLUMNS.map(({render, ...c}) => c), rows, exportSpec: {name: '報告書の一覧', title: `${title}（確定版の一覧）`,
    conditions: [['権利者', holderOptions.find((o) => o.value === String(holderId))?.label || 'すべて'], ['状態', STATUS_FILTERS.find((f) => f.value === filter)?.label || 'すべて']]}})];

  return (
    <div className="stack">
      <section className="card rp-report" aria-label={title}>
        <header className="rp-head">
          <div>
            <h2>{title}</h2>
            <p className="rp-muted">確定した報告書の一覧です。行を押すと報告書の本体を開き、報告した日と支払を記録できます。まだ作っていない期間は「報告書の作成」で作ります。</p>
          </div>
          {body && <ReportOutputBar sheets={sheets} name="ロイヤリティ報告書の一覧" title={title} formats={['xlsx', 'csv', 'print']} />}
        </header>
        <div className="on-conditions">
          <FormField type="select" label="権利者" value={holderId} blankLabel="すべての権利者" options={holderOptions} onChange={(value) => shell.setParam('holder', value || null)} />
          <FormField type="select" label="状態" value={filter} includeBlank={false} options={STATUS_FILTERS} onChange={(value) => shell.setParam('rstate', value || null)} />
          {onNavigate && <div className="on-form-actions"><button type="button" className="secondary" onClick={() => onNavigate('ロイヤリティ作成')}>報告書の作成へ</button></div>}
        </div>
        {state.error && <ErrorNotice error={state.error} />}
        {restricted.length > 0 && <Notice tone="info" compact message={`財務権限のない作品の契約を持つ権利者（${restricted.map((h) => h.name).join('、')}）の報告書は表示していません。`} />}
        {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
        {body && (
          <DataGrid columns={COLUMNS} rows={rows} rowKey="id" persistKey="royalty-statements" maxHeight="45vh" onRowClick={open}
            emptyText={body.statements.length ? '条件に合う報告書はありません' : 'まだ確定した報告書はありません。「報告書の作成」で作成待ちの期間を確定してください'} />
        )}
      </section>
      {(statementId || (holderId && closeMonth)) && (
        <RoyaltyStatementView key={statementId || `${holderId}:${closeMonth}`} statementId={statementId || null} holderId={holderId} closeMonth={closeMonth}
          onNavigate={onNavigate} onChanged={() => setRevision((n) => n + 1)} />
      )}
      {!statementId && !(holderId && closeMonth) && body?.statements?.length > 0 && <Notice tone="info" message={`一覧の行を押すと、報告書（${monthText(body.statements[0].closeMonth)}締めなど）を開きます。`} />}
    </div>
  );
}

export default RoyaltyStatementsPage;
