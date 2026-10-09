// 放送枠・販売条件の Excel 往復（出力 → 直す → 読み込み → 全行の確認 → 登録）。
// 出力は日本語の見出しと「参考_」の確かめ用の列。取込は全行の理由を出し、エラーの行を Excel で返す。
// 使い方: <BroadcastExcelRoundTrip kind="slots" workId={1} canEdit /> ／ <BroadcastExcelRoundTrip kind="avails" canEdit />
// （request は props か外枠の文脈。販売条件は閲覧できる全作品が対象なので workId は不要）
import React, {useCallback, useEffect, useId, useMemo, useState} from 'react';
import {decodeXlsx} from '../xlsx.mjs';
import {downloadReportXlsx, reportBaseName} from '../xlsx-report.mjs';
import {decodeText} from '../import/text-decode.mjs';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {dateJst} from '../ui/format.mjs';
import {SLOT_SHEET, AVAIL_SHEET, SLOT_VALUE_LABELS, AVAIL_VALUE_LABELS, failedRowSheets, tableFromSheets} from './broadcast-sheet.mjs';
import '../reports/reports.css';
import '../broadcast-ui.css';

// ---- Excel の往復（放送枠・販売条件で共通） --------------------------------------------------------
const ROUND_TRIPS = {
  slots: {
    sheet: SLOT_SHEET, title: '放送枠', labels: SLOT_VALUE_LABELS, unsavedLabel: '放送枠の取込（確認中）',
    exportXlsx: (workId) => `/api/broadcast/export.xlsx?workId=${workId}`,
    exportCsv: (workId) => `/api/broadcast/export.csv?workId=${workId}&headers=ja`,
    previewPath: '/broadcast/import/preview', commitPath: '/broadcast/import/commit',
    intro: '出力した Excel の行を直して読み込むと、追加・改訂・変更なしを確かめてから下書きとして登録します。放送枠IDが空欄の行は新しい放送枠です。',
    columns: [
      {key: 'broadcast_month', label: '放送月', type: 'month'},
      {key: 'station_name', label: '放送局', type: 'text'},
      {key: 'period', label: '期間', type: 'text', value: (row) => `${dateJst(row.period_from)}〜${dateJst(row.period_to)}`},
      {key: 'planned_runs', label: '予定回数', type: 'int', total: 'none'},
    ],
  },
  avails: {
    // API の名前（/api/broadcast/avails）は互換のため残すが、中身は販売条件の一覧。放送アベイルズリストと取り違えないよう表示名を分ける
    sheet: AVAIL_SHEET, title: '販売条件の一覧', labels: AVAIL_VALUE_LABELS, unsavedLabel: '販売条件の一覧の取込（確認中）',
    exportXlsx: () => '/api/broadcast/avails/export.xlsx',
    exportCsv: () => '/api/broadcast/avails/export.csv?headers=ja',
    previewPath: '/broadcast/avails/preview', commitPath: '/broadcast/avails/commit',
    intro: '閲覧できる全作品の販売条件を出力します。直した行だけ新しい版になり、調達ケース・文書の紐付けは引き継ぎます。',
    columns: [
      {key: 'workTitle', label: '作品', type: 'text'},
      {key: 'distributionLabel', label: '流通', type: 'text', value: (row) => `${row.distributionName || ''}・${row.distributionLabel || row.distribution_code}`},
      {key: 'territory', label: '地域', type: 'text'},
      {key: 'status', label: '状態', type: 'status', domain: 'availabilityStatus'},
    ],
  },
};

async function readUpload(file, sheetName) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.xlsx$/i.test(file.name)) return {table: tableFromSheets(decodeXlsx(bytes, {formulas: 'sheet'}), sheetName).table};
  if (/\.(csv|txt)$/i.test(file.name)) return {csv: decodeText(bytes).text};
  throw new Error('Excel（.xlsx）か CSV（.csv）を選んでください。.xls（古い形式）は Excel で .xlsx に保存し直してください');
}

export function BroadcastExcelRoundTrip({kind, workId, canEdit, request: requestProp, onCommitted}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const spec = ROUND_TRIPS[kind];
  const inputId = useId();
  const [upload, setUpload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const unsavedId = `broadcast-import-${kind}`;

  useEffect(() => {
    shell.registerUnsaved(unsavedId, preview ? 1 : 0, spec.unsavedLabel);
    return () => shell.registerUnsaved(unsavedId, 0);
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setUpload(null); setPreview(null); setNotice(null); }, [workId]);

  const runPreview = useCallback(async (next) => {
    setBusy(true);
    setPreview(null);
    try {
      const body = kind === 'slots' ? {workId, ...next.input} : next.input;
      const result = await request(spec.previewPath, {method: 'POST', body: JSON.stringify(body)});
      setPreview(result);
      const warnings = [...(result.warnings || []), ...(result.counts?.warnings ? [`注意のある行が${result.counts.warnings}行あります（表の「注意」列）。登録はできます`] : [])];
      setNotice({tone: warnings.length ? 'warn' : 'info', title: `${next.fileName} の内容`, message: `追加 ${result.counts.append}行・改訂 ${result.counts.revise}行・変更なし ${result.counts.unchanged}行。表を確かめて「この内容で登録する」を押してください（まだ登録していません）`, details: warnings.map((text) => ({message: text}))});
    } catch (error) {
      const body = error?.body && typeof error.body === 'object' ? error.body : null;
      setNotice({error, failed: body?.failedRows?.length ? body : null, fileName: next.fileName});
    } finally {
      setBusy(false);
    }
  }, [kind, request, spec.previewPath, workId]);

  async function choose(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const input = await readUpload(file, spec.sheet.name);
      const next = {fileName: file.name, input};
      setUpload(next);
      await runPreview(next);
    } catch (error) {
      setUpload(null);
      setPreview(null);
      setNotice({error});
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const result = await request(spec.commitPath, {method: 'POST', body: JSON.stringify({token: preview.token, confirmed: true})});
      setPreview(null);
      setUpload(null);
      setInputKey((n) => n + 1);
      shell.registerUnsaved(unsavedId, 0);
      setNotice({tone: 'ok', message: `${spec.sheet.label}を登録しました（追加 ${result.append}行・改訂 ${result.revise}行・変更なし ${result.unchanged}行）`});
      onCommitted?.();
    } catch (error) {
      setNotice({error, expired: error?.status === 410});
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setPreview(null);
    setUpload(null);
    setInputKey((n) => n + 1);
    setNotice(null);
  }

  function downloadFailed() {
    const failed = notice?.failed;
    if (!failed) return;
    downloadReportXlsx(reportBaseName(`${spec.sheet.label}_登録できない行`), {sheets: failedRowSheets(spec.sheet, {fileName: notice.fileName, headers: failed.headers, failedRows: failed.failedRows})});
  }

  const previewColumns = useMemo(() => [
    {key: 'rowNo', label: '行', type: 'int', total: 'none', sticky: true},
    {key: 'action', label: '扱い', type: 'status', domain: 'importDiff'},
    ...spec.columns,
    {key: 'diff', label: '変わる項目', type: 'text', wrap: true, value: (row) => (row.diff || []).map((key) => spec.labels[key] || key).join('、') || '—'},
    {key: 'warnings', label: '注意', type: 'text', wrap: true, value: (row) => (row.warnings || []).join(' ／ ') || '—'},
  ], [spec]);

  return (
    <section className="bc-roundtrip" aria-label={`${spec.title}のExcel`}>
      <div className="bc-toolbar">
        <div>
          <h4>{spec.title}の Excel</h4>
          <p className="rp-muted">{spec.intro}「参考_」で始まる列は確かめ用で、読み込みません。</p>
        </div>
        <div className="bc-action-buttons">
          <a className="bc-link-button" href={spec.exportXlsx(workId)} download>Excelで出力</a>
          <a className="bc-link-button" href={spec.exportCsv(workId)} download>CSVで出力</a>
        </div>
      </div>
      {canEdit && !readOnly && (
        <div className="bc-upload">
          <label htmlFor={inputId}>直したファイルを読み込む（.xlsx・.csv、200行まで）</label>
          <input key={inputKey} id={inputId} type="file" disabled={busy} accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={choose} />
          {busy && <span className="rp-muted" role="status">確認しています…</span>}
        </div>
      )}
      {notice && (
        <Notice tone={notice.tone} title={notice.title} message={notice.message} details={notice.details} error={notice.error}
          onRetry={notice.expired && upload ? () => runPreview(upload) : undefined} retryLabel="もう一度確認する"
          actions={notice.failed ? <button type="button" className="secondary" onClick={downloadFailed}>エラーの行をExcelで受け取る</button> : undefined}
          onDismiss={() => setNotice(null)} />
      )}
      {preview && (
        <div className="bc-preview">
          <DataGrid columns={previewColumns} rows={preview.rows} rowKey="rowNo" ariaLabel="取込内容の確認" maxHeight="50vh" showTotals={false} />
          <div className="bc-action-buttons">
            <button type="button" disabled={busy} onClick={commit}>この内容で登録する</button>
            <button type="button" className="secondary" disabled={busy} onClick={cancel}>取り消す</button>
          </div>
        </div>
      )}
    </section>
  );
}

export default BroadcastExcelRoundTrip;
