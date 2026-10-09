// 取込履歴（管理者）。売上報告の取込（報告ごと）と、Excel一括登録の記録を新しい順に並べる。
import React, {useEffect, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import '../reports/reports.css';

const KIND = {theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', other: 'その他', publicity: '宣伝'};
const STATUS = {active: '有効', superseded: '訂正で置換済み', void: '取消'};
const ENTITY = {partners: '取引先', projects: '案件', works: '作品', products: '商品', expenses: '経費'};

const REPORT_COLUMNS = [
  {key: 'created_at', label: '取込日時', type: 'datetime', sticky: true},
  {key: 'report_key', label: '報告キー', type: 'code'},
  {key: 'partner_name', label: '取引先', type: 'text'},
  {key: 'work_title', label: '作品', type: 'text'},
  {key: 'kind', label: '種類', type: 'text', value: (r) => KIND[r.kind] || r.kind},
  {key: 'accounting_month', label: '計上月', type: 'month'},
  // 合計は有効な報告だけ（訂正で置き換えた旧報告・取消を足すと二重になる）
  {key: 'line_count', label: '明細数', type: 'int', total: 'sum', totalValue: (r) => (r.status === 'active' ? r.line_count : 0)},
  {key: 'amount_ex_tax', label: '税抜合計（合計行は有効な報告だけ）', type: 'yen', total: 'sum', totalValue: (r) => (r.status === 'active' ? r.amount_ex_tax : 0)},
  {key: 'status', label: '状態', type: 'text', value: (r) => `${STATUS[r.status] || r.status}${r.supersedes_id ? '（訂正版）' : ''}`},
  {key: 'created_by_name', label: '登録者', type: 'text'},
];
const BATCH_COLUMNS = [
  {key: 'created_at', label: '登録日時', type: 'datetime', sticky: true},
  {key: 'id', label: '記録', type: 'text', value: (r) => `#${r.id}`},
  {key: 'entity', label: '種類', type: 'text', value: (r) => ENTITY[r.entity] || r.entity},
  {key: 'file_name', label: 'ファイル', type: 'text'},
  {key: 'inserted_count', label: '追加', type: 'int', total: 'sum'},
  {key: 'updated_count', label: '修正', type: 'int', total: 'sum'},
  {key: 'approval_count', label: '承認待ち（未反映）', type: 'int', total: 'sum'},
  {key: 'created_by_name', label: '登録者', type: 'text'},
];

export function ImportHistory() {
  const shell = useShell();
  const [state, setState] = useState({loading: true});
  useEffect(() => { shell.request('/admin/import-history').then((body) => setState({body})).catch((error) => setState({error})); }, [shell]);
  return (
    <div className="stack">
      {state.error && <Notice error={state.error} />}
      {state.loading && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {state.body && (
        <>
          <section className="card rp-report">
            <h2>売上報告の取込</h2>
            <p className="rp-muted">報告ごとに、取込日時・明細数・税抜合計・状態（訂正で置き換えた旧報告も残ります）。</p>
            <DataGrid columns={REPORT_COLUMNS} rows={state.body.reports} rowKey="id" persistKey="import-history-reports" exportSpec={{name: '売上報告の取込履歴', title: '売上報告の取込履歴'}} />
          </section>
          <section className="card rp-report">
            <h2>Excel一括登録</h2>
            <DataGrid columns={BATCH_COLUMNS} rows={state.body.batches} rowKey="id" persistKey="import-history-batches" emptyText="一括登録の記録はまだありません" exportSpec={{name: '一括登録の履歴', title: 'Excel一括登録の履歴'}} />
          </section>
        </>
      )}
    </div>
  );
}

export default ImportHistory;
