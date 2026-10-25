// 予算書の画面（要件 docs/requirements/planning/budget-book.md。会社ルートの計画 plans/2026-10-22-folder-budget.md の問い3・4・10 はすべて A）。
// 一覧: 案件ごとに1行（確定・下書き・総合計・札）。1冊: 判定の1行・重要な数字（区分ごとの小計と前の版との差、区分／部署の切り替え）・例外だけ。
// 明細は区分を押すと開く。操作は「予算書を置く」「直して版にする」「確定する」「取り消す」。値は受け口から読むだけで、合計は受け口が明細から導いた値。
// 型（テンプレ）のタブ: 型の一覧・費目・版、Excel で落とす、案件の版や予算書 xlsx から型を作る。1冊から「型から作る」「型にも足す」「Excel で落とす」
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import './budget.css';

const yen = (value) => (value == null ? '—' : Number(value).toLocaleString('ja-JP'));
const signed = (value) => (value == null || value === 0 ? '' : `${value > 0 ? '+' : '−'}${Math.abs(value).toLocaleString('ja-JP')}`);
const STATE_TAG = {done: ['確定', 'ok'], in_progress: ['下書き', 'warn'], needs_review: ['例外', 'bad'], not_started: ['未着手', '']};
const CHECK_LABEL = {total: '総合計', estimate: '見積り', tax: '消費税', total_inc_tax: '税込', direct: '直接制作費', subtotal_with_fee: '直接＋管理費',
  uncategorized: '区分なし', unknown_category: '区分違い', without_value: '値なし', fractional_yen: '円未満の端数'};
const BREAKDOWN_REASON = {outside_range: 'SUMIF の範囲の外に内訳の行がある', mismatch: '行の額と内訳の和が違う', missing_sheet: '内訳のシートが無い', unsupported_formula: '読めない式'};

// xlsx を落とす（受け口が付けたファイル名で）
async function download(request, path, fallback) {
  const response = await request(path, {raw: true});
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? decodeURIComponent(match[1]) : fallback;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Tag({state}) {
  const [label, tone] = STATE_TAG[state] ?? ['—', ''];
  return <span className={`bd-tag ${tone}`}>{label}</span>;
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読めません'));
    reader.readAsDataURL(file);
  });
}

export default function Budget({request}) {
  const [tab, setTab] = useState('books');
  return (
    <>
      <div className="bd-tabs" role="tablist" aria-label="予算書">
        <button type="button" role="tab" aria-selected={tab === 'books'} onClick={() => setTab('books')}>予算書</button>
        <button type="button" role="tab" aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>型</button>
      </div>
      {tab === 'books' ? <BudgetBooks request={request} /> : <Templates request={request} />}
    </>
  );
}

function BudgetBooks({request}) {
  const [list, setList] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setError(null);
    try { setList((await request('/planning/budgets')).budgets); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { load(); }, [load]);
  if (projectId != null) return <BudgetBook request={request} projectId={projectId} onBack={() => { setProjectId(null); load(); }} />;
  return (
    <section className="bd" data-page="budget-list">
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      {!list ? <p aria-busy="true">読込中…</p> : (
        <table className="bd-table">
          <thead><tr><th>案件</th><th>確定</th><th>下書き</th><th className="n">総合計（税抜）</th><th>状態</th></tr></thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.projectId} className="bd-row" onClick={() => setProjectId(row.projectId)} data-project={row.projectId}>
                <td>{row.title}<span className="bd-sub">{row.code}</span></td>
                <td>{row.fixedVersionNo ? `rev${row.fixedVersionNo}` : '—'}</td>
                <td>{row.latestVersionNo && row.latestVersionNo !== row.fixedVersionNo ? `rev${row.latestVersionNo}` : '—'}</td>
                <td className="n">{yen(row.fixedTotalExTaxYen)}</td>
                <td><Tag state={row.state.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function BudgetBook({request, projectId, onBack}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [versionNo, setVersionNo] = useState(null);
  const [axis, setAxis] = useState('category');
  const [open, setOpen] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [templateKey, setTemplateKey] = useState(0);
  const base = `/planning/projects/${projectId}/budget`;
  const load = useCallback(async (no = versionNo) => {
    setError(null);
    try { setData(await request(no ? `${base}?version=${no}` : base)); } catch (failure) { setError(failure); }
  }, [request, base, versionNo]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn) => {
    setBusy(true); setError(null); setMessage(null);
    try { await fn(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const importFile = (file) => act(async () => {
    const result = await request(`${base}/import`, {method: 'POST', body: {fileName: file.name, base64: await readFileBase64(file)}});
    setMessage(result.verdict === 'exceptions' ? `rev${result.versionNo} ! 例外 ${result.failed}` : `rev${result.versionNo} ✓`);
    setVersionNo(null); await load(null);
  });
  const fix = (action) => act(async () => {
    const reason = window.prompt(action === 'fix' ? '確定の理由' : '取り消しの理由');
    if (!reason) return;
    await request(`${base}/fixes`, {method: 'POST', body: {action, versionNo: data.version.versionNo, reason}});
    await load();
  });

  if (error && !data) return <section className="bd"><button type="button" onClick={onBack}>← 一覧</button><Notice error={error} onRetry={() => load()} retryLabel="読み直す" /></section>;
  if (!data) return <section className="bd" aria-busy="true">読込中…</section>;
  const v = data.version;
  const failed = v?.check?.checks?.filter((check) => check.ok === false) ?? [];
  const compare = new Map((v?.comparison?.categories ?? []).map((row) => [row.code, row]));
  const workName = new Map(data.works.map((w) => [w.id, w.title]));

  return (
    <section className="bd" data-page="budget-book" data-ready={v ? `${data.project.id}:${v.versionNo}` : `${data.project.id}:none`}>
      <button type="button" className="bd-back" onClick={onBack}>← 一覧</button>
      <h2>{data.project.title}<span className="bd-sub">{data.project.code}</span></h2>
      {error && <Notice error={error} />}
      {message && <p className="bd-message" role="status">{message}</p>}
      <DropZone onFile={importFile} busy={busy} />
      <TemplateStart key={templateKey} request={request} busy={busy} onStart={(template) => setEditing({rows: template.items.map((item) => ({categoryCode: item.categoryCode, name: item.name,
        unit: item.unit, unitPriceYen: item.unitPriceYen, qtyMilli: item.qtyMilli, amountExTaxYen: '', confirmedSource: 'none',
        ...(item.breakdownSheet ? {breakdown: {sheet: item.breakdownSheet, items: []}} : {})})), template: {templateId: template.template.id, name: template.template.name, versionNo: template.versionNo}, fromTemplate: true})} />
      {!v ? <p className="bd-empty">版なし</p> : <>
        <div className="bd-verdict" data-verdict={v.check?.verdict ?? 'none'}>
          <span>{v.fixed ? '✓ 確定' : '下書き'} rev{v.versionNo}</span>
          {v.template && <span className="bd-chip">型 {v.template.name} v{v.template.versionNo}</span>}
          {failed.length > 0 && <span className="bad">! 例外 {failed.length}</span>}
          {v.check && <span className="bd-chip">検査 {v.check.passed}/{v.check.passed + v.check.failed}</span>}
          <select aria-label="版" value={v.versionNo} onChange={(e) => { const no = Number(e.target.value); setVersionNo(no); load(no); }}>
            {data.versions.map((row) => <option key={row.versionNo} value={row.versionNo}>rev{row.versionNo}{row.fixed ? ' ✓' : ''}</option>)}
          </select>
        </div>
        <div className="bd-actions">
          <button type="button" disabled={busy} onClick={() => setEditing({rows: v.lines.map((line) => ({...line})), template: v.template})}>直して版にする</button>
          <button type="button" disabled={busy} onClick={() => act(() => download(request, `${base}/versions/${v.versionNo}/xlsx`, '予算書.xlsx'))}>⬇ Excel</button>
          <button type="button" disabled={busy} onClick={() => act(async () => {
            const name = window.prompt('型の名前（例「Vシネ 2〜3本撮り」）');
            if (!name) return;
            await request('/planning/budget-templates', {method: 'POST', body: {name, reason: `${data.project.title} rev${v.versionNo} から作った`, from: {projectId, versionNo: v.versionNo}}});
            setMessage(`型「${name}」を作った`);
            setTemplateKey((k) => k + 1);
          })}>型にする</button>
          {data.canFix && !v.fixed && <button type="button" disabled={busy || failed.length > 0} onClick={() => fix('fix')}>確定する</button>}
          {data.canFix && v.fixed && <button type="button" disabled={busy} onClick={() => fix('void')}>取り消す</button>}
        </div>

        {failed.length > 0 && (
          <div className="bd-exceptions" data-exceptions={failed.length}>
            {failed.map((check) => (
              <p key={check.key}><span className="bd-cell">{check.cell ?? (check.cells ?? []).join(' ')}</span>
                {CHECK_LABEL[check.key] ?? check.label}
                {check.statedYen != null && <> 原本 <b>{yen(check.statedYen)}</b> ／ 明細 <b className="bad">{yen(check.derivedYen)}</b></>}
                {check.count != null && <> {check.count}</>}
                {check.reason && BREAKDOWN_REASON[check.reason] && <span className="bd-sub">{BREAKDOWN_REASON[check.reason]}{check.cells?.length ? `（${check.cells.join(' ')}）` : ''}</span>}</p>
            ))}
          </div>
        )}

        <div className="bd-axis" role="group" aria-label="並べ方">
          <button type="button" aria-pressed={axis === 'category'} onClick={() => setAxis('category')}>区分</button>
          <button type="button" aria-pressed={axis === 'department'} onClick={() => setAxis('department')}>部署</button>
        </div>
        <table className="bd-table" data-table="totals">
          <thead><tr><th>{axis === 'category' ? '区分' : '部署'}</th><th className="n">小計</th>{axis === 'category' && <th className="n">前の版</th>}</tr></thead>
          <tbody>
            {axis === 'category' ? v.totals.byCategory.map((row) => {
              const diff = compare.get(row.code);
              const lines = v.lines.filter((line) => line.categoryCode === row.code);
              const isOpen = open.has(row.code);
              return (
                <React.Fragment key={row.code}>
                  <tr className={`bd-row${row.subtotalYen ? '' : ' mute'}${diff?.large ? ' large' : ''}`} onClick={() => setOpen((s) => { const next = new Set(s); next.has(row.code) ? next.delete(row.code) : next.add(row.code); return next; })}>
                    <td>{lines.length ? (isOpen ? '▾ ' : '▸ ') : '　'}{row.code} {row.name}</td>
                    <td className="n">{yen(row.subtotalYen)}</td>
                    <td className={`n ${diff?.diffYen > 0 ? 'bad' : ''}`}>{signed(diff?.diffYen)}</td>
                  </tr>
                  {isOpen && lines.flatMap((line) => [(
                    <tr key={`${row.code}-${line.lineNo}`} className="bd-line">
                      <td>{line.name}{line.confirmedSource !== 'none' && <span className="bd-chip">確定{line.confirmedSource === 'fill' ? '（色）' : ''}</span>}
                        {line.workId && <span className="bd-sub">{workName.get(line.workId)}</span>}</td>
                      <td className="n">{yen(line.amountExTaxYen)}</td>
                      <td className="n bd-sub">{line.breakdown ? `内訳 ${line.breakdown.items.length}` : line.unitPriceYen != null && line.qtyMilli != null ? `${yen(line.unitPriceYen)}×${line.qtyMilli / 1000}${line.unit ?? ''}` : ''}</td>
                    </tr>
                  ), ...(line.breakdown?.items ?? []).map((item) => (
                    <tr key={`${row.code}-${line.lineNo}-${item.itemNo}`} className="bd-item">
                      <td>{item.label}{item.castingRef && <span className="bd-chip">キャスト一覧</span>}</td>
                      <td className="n">{yen(item.amountExTaxYen)}</td>
                      <td className="n bd-sub">{item.unitPriceYen != null && item.qtyMilli != null ? `${yen(item.unitPriceYen)}×${item.qtyMilli / 1000}` : ''}</td>
                    </tr>
                  ))])}
                </React.Fragment>
              );
            }) : v.departments.map((row) => (
              <tr key={row.departmentId ?? 'none'}><td>{row.departmentId == null ? '部署なし' : `部署 ${row.departmentId}`}</td><td className="n">{yen(row.subtotalYen)}</td></tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>直接制作費</td><td className="n">{yen(v.totals.directYen)}</td>{axis === 'category' && <td />}</tr>
            <tr><td>制作管理費</td><td className="n">{yen(v.totals.managementFeeYen)}</td>{axis === 'category' && <td />}</tr>
            <tr><td>予備費（計画）</td><td className="n">{yen(v.totals.contingencyYen)}</td>{axis === 'category' && <td />}</tr>
            <tr className="bd-total"><td>総合計（税抜）</td><td className="n" data-total-ex-tax={v.totals.totalExTaxYen}>{yen(v.totals.totalExTaxYen)}</td>
              {axis === 'category' && <td className="n">{signed(v.comparison?.totalDiffYen)}</td>}</tr>
            <tr><td>消費税 {v.totals.taxRateBps / 100}%</td><td className="n">{yen(v.totals.taxYen)}</td>{axis === 'category' && <td />}</tr>
            <tr><td>税込</td><td className="n">{yen(v.totals.totalIncTaxYen)}</td>{axis === 'category' && <td />}</tr>
          </tfoot>
        </table>
        {v.notices.length > 0 && <p className="bd-notices">{v.notices.filter((n) => n.kind === 'unit_price_qty').map((n) => <span key={n.cell ?? n.name} className="bd-chip">単価×数量 {n.name}</span>)}</p>}
        {v.headerNotes && <p className="bd-sub">{v.headerNotes}</p>}
      </>}
      {editing && <VersionEditor lines={editing.rows} template={editing.template} categories={data.categories} works={data.works} busy={busy} copyOf={editing.fromTemplate ? undefined : v?.versionNo}
        fees={{managementFeeYen: v?.managementFeeYen ?? 0, contingencyYen: v?.contingencyYen ?? 0}}
        onCancel={() => setEditing(null)}
        onSave={(body, additions) => act(async () => {
          const result = await request(`${base}/versions`, {method: 'POST', body: {...body, ...(editing.template ? {templateId: editing.template.templateId, templateVersionNo: editing.template.versionNo} : {})}});
          let note = '';
          if (additions.length && editing.template) {
            const grown = await request(`/planning/budget-templates/${editing.template.templateId}/versions`, {method: 'POST', body: {reason: `${data.project.title} rev${result.versionNo} で足した`, additions}});
            note = `・型「${editing.template.name}」v${grown.versionNo}`;
          }
          setEditing(null); setMessage(`rev${result.versionNo} ✓${note}`); setVersionNo(null); await load(null);
        })} />}
    </section>
  );
}

function DropZone({onFile, busy, label = '予算書（xlsx）を置く'}) {
  const [over, setOver] = useState(false);
  return (
    <label className={`bd-drop${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const file = e.dataTransfer.files?.[0]; if (file && !busy) onFile(file); }}>
      {busy ? '読取中…' : label}
      <input type="file" accept=".xlsx" hidden disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onFile(file); }} />
    </label>
  );
}

function VersionEditor({lines, template, categories, works, busy, copyOf, fees, onCancel, onSave}) {
  const [rows, setRows] = useState(lines);
  const [reason, setReason] = useState('');
  const [managementFeeYen, setFee] = useState(fees.managementFeeYen);
  const [contingencyYen, setContingency] = useState(fees.contingencyYen);
  // 明細の和は、整数で入った行だけを足して見せる（空の行は保存のときに受け口が断る）
  const total = useMemo(() => rows.filter((row) => /^\d+$/.test(String(row.amountExTaxYen ?? ''))).reduce((sum, row) => sum + Number(row.amountExTaxYen), 0), [rows]);
  const set = (i, key, value) => setRows((all) => all.map((row, j) => (j === i ? {...row, [key]: value} : row)));
  // 内訳のある行は、金額を内訳の和にする（Excel の SUMIF と同じ）
  const setItem = (i, k, key, value) => setRows((all) => all.map((row, j) => {
    if (j !== i) return row;
    const items = row.breakdown.items.map((item, m) => (m === k ? {...item, [key]: value} : item));
    return {...row, breakdown: {...row.breakdown, items}, amountExTaxYen: String(items.reduce((sum, item) => sum + (/^\d+$/.test(String(item.amountExTaxYen ?? '')) ? Number(item.amountExTaxYen) : 0), 0))};
  }));
  return (
    <div className="bd-editor" data-editor="version">
      <table className="bd-table">
        <thead><tr><th>区分</th><th>費目</th><th className="n">税抜</th><th>作品</th><th>支払月</th><th>確定</th>{template && <th>型にも足す</th>}<th /></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <React.Fragment key={i}>
            <tr>
              <td><select value={row.categoryCode} onChange={(e) => set(i, 'categoryCode', e.target.value)}>{categories.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></td>
              <td><input value={row.name ?? ''} onChange={(e) => set(i, 'name', e.target.value)} aria-label="費目" /></td>
              <td><input className="n" inputMode="numeric" value={row.amountExTaxYen ?? ''} readOnly={Boolean(row.breakdown)} title={row.breakdown ? '内訳の和' : undefined}
                onChange={(e) => set(i, 'amountExTaxYen', e.target.value.replace(/[^\d]/g, ''))} aria-label="税抜" /></td>
              <td><select value={row.workId ?? ''} onChange={(e) => set(i, 'workId', e.target.value ? Number(e.target.value) : null)}><option value="">—</option>{works.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></td>
              <td><input type="month" value={row.paymentMonth ?? ''} onChange={(e) => set(i, 'paymentMonth', e.target.value || null)} aria-label="支払月" /></td>
              <td><input type="checkbox" checked={row.confirmedSource !== 'none' && row.confirmedSource != null} onChange={(e) => set(i, 'confirmedSource', e.target.checked ? 'manual' : 'none')} aria-label="確定" /></td>
              {template && <td>{row.added ? <input type="checkbox" checked={Boolean(row.toTemplate)} onChange={(e) => set(i, 'toTemplate', e.target.checked)} aria-label="型にも足す" /> : null}</td>}
              <td><button type="button" onClick={() => setRows((all) => all.filter((_, j) => j !== i))} aria-label="行を消す">×</button>
                {!row.breakdown && <button type="button" onClick={() => set(i, 'breakdown', {sheet: '内訳', items: [{label: '', amountExTaxYen: row.amountExTaxYen ?? ''}]})} aria-label="内訳を付ける">内訳</button>}</td>
            </tr>
            {row.breakdown && !row.breakdown.items.length && (
              <tr className="bd-item"><td /><td colSpan={template ? 7 : 6}><span className="bd-sub">内訳（{row.breakdown.sheet}）</span>
                <button type="button" onClick={() => set(i, 'breakdown', {...row.breakdown, items: [{label: '', amountExTaxYen: ''}]})}>＋ 内訳</button></td></tr>
            )}
            {row.breakdown && row.breakdown.items.map((item, k) => (
              <tr key={`${i}-${k}`} className="bd-item">
                <td />
                <td><input value={item.label ?? ''} onChange={(e) => setItem(i, k, 'label', e.target.value)} placeholder="役名・名目" aria-label="内訳の名目" /></td>
                <td><input className="n" inputMode="numeric" value={item.amountExTaxYen ?? ''} onChange={(e) => setItem(i, k, 'amountExTaxYen', e.target.value.replace(/[^\d]/g, ''))} aria-label="内訳の金額" /></td>
                <td colSpan={template ? 4 : 3}>{k === row.breakdown.items.length - 1 && <button type="button" onClick={() => set(i, 'breakdown', {...row.breakdown, items: [...row.breakdown.items, {label: '', amountExTaxYen: ''}]})}>＋ 内訳</button>}</td>
                <td><button type="button" onClick={() => setRows((all) => all.map((r, j) => (j === i ? {...r, breakdown: {...r.breakdown, items: r.breakdown.items.filter((_, m) => m !== k)}} : r)))} aria-label="内訳を消す">×</button></td>
              </tr>
            ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => setRows((all) => [...all, {categoryCode: 'A', name: '', amountExTaxYen: '', confirmedSource: 'none', added: true}])}>＋ 行</button>
      {template && <span className="bd-sub">型「{template.name}」v{template.versionNo}</span>}
      <p>明細 <b>{yen(total)}</b>　制作管理費 <input className="n" inputMode="numeric" value={managementFeeYen} onChange={(e) => setFee(e.target.value.replace(/[^\d]/g, ''))} aria-label="制作管理費" />
        　予備費（計画） <input className="n" inputMode="numeric" value={contingencyYen} onChange={(e) => setContingency(e.target.value.replace(/[^\d]/g, ''))} aria-label="予備費" /></p>
      <p><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由" aria-label="理由" /></p>
      <button type="button" disabled={busy || !reason.trim()} onClick={() => onSave({reason, copyOf, managementFeeYen: managementFeeYen === '' ? null : Number(managementFeeYen), contingencyYen: contingencyYen === '' ? null : Number(contingencyYen),
        lines: rows.map((row) => ({categoryCode: row.categoryCode, name: row.name, amountExTaxYen: row.amountExTaxYen === '' ? null : Number(row.amountExTaxYen),
          unitPriceYen: row.unitPriceYen, qtyMilli: row.qtyMilli, unit: row.unit, workId: row.workId, departmentId: row.departmentId, paymentMonth: row.paymentMonth,
          confirmed: row.confirmedSource === 'manual', confirmedSource: row.confirmedSource, sourceCell: row.sourceCell, note: row.note,
          ...(row.breakdown ? {breakdown: {sheet: row.breakdown.sheet, items: row.breakdown.items.map((item) => ({label: item.label, amountExTaxYen: item.amountExTaxYen === '' ? null : Number(item.amountExTaxYen),
            qtyMilli: item.qtyMilli, unitPriceYen: item.unitPriceYen, castingRef: item.castingRef, sourceCell: item.sourceCell}))}} : {})}))},
        rows.filter((row) => row.added && row.toTemplate && row.name).map((row) => ({categoryCode: row.categoryCode, name: row.name, unit: row.unit ?? null,
          ...(row.breakdown ? {breakdownSheet: row.breakdown.sheet} : {})})))}>版にする</button>
      <button type="button" onClick={onCancel}>やめる</button>
    </div>
  );
}

// 型から作る（1冊の上。型を選ぶと、型の費目が並んだ編集が開く）
function TemplateStart({request, busy, onStart}) {
  const [templates, setTemplates] = useState(null);
  const [chosen, setChosen] = useState('');
  useEffect(() => { request('/planning/budget-templates').then((r) => setTemplates(r.templates), () => setTemplates([])); }, [request]);
  if (!templates?.length) return null;
  return (
    <p className="bd-start">
      <select value={chosen} onChange={(e) => setChosen(e.target.value)} aria-label="型">
        <option value="">型を選ぶ</option>
        {templates.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.latestVersionNo}（{t.itemCount}）</option>)}
      </select>
      <button type="button" disabled={busy || !chosen} onClick={async () => onStart(await request(`/planning/budget-templates/${chosen}`))}>型から作る</button>
    </p>
  );
}

// 型（テンプレ）のタブ
function Templates({request}) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setList((await request('/planning/budget-templates')).templates); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn) => { setBusy(true); setError(null); setMessage(null); try { await fn(); } catch (failure) { setError(failure); } finally { setBusy(false); } };
  const fromFile = (file) => act(async () => {
    const name = window.prompt('型の名前', file.name.replace(/\.xlsx$/i, ''));
    if (!name) return;
    const result = await request('/planning/budget-templates', {method: 'POST', body: {name, reason: `${file.name} から作った`, fileName: file.name, base64: await readFileBase64(file)}});
    setMessage(`型「${name}」v1（費目 ${result.itemCount}）`);
    await load();
  });
  return (
    <section className="bd" data-page="budget-templates">
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      {message && <p className="bd-message" role="status">{message}</p>}
      <DropZone onFile={fromFile} busy={busy} label="予算書（xlsx）を置いて型にする" />
      {!list ? <p aria-busy="true">読込中…</p> : !list.length ? <p className="bd-empty">型なし</p> : (
        <table className="bd-table" data-table="templates">
          <thead><tr><th>型</th><th>版</th><th className="n">費目</th><th className="n">内訳</th><th>最後の版の理由</th><th /></tr></thead>
          <tbody>
            {list.map((t) => (
              <React.Fragment key={t.id}>
                <tr className="bd-row" onClick={async () => setOpen(open?.template.id === t.id ? null : await request(`/planning/budget-templates/${t.id}`))}>
                  <td>{open?.template.id === t.id ? '▾ ' : '▸ '}{t.name}</td><td>v{t.latestVersionNo}</td><td className="n">{t.itemCount}</td><td className="n">{t.breakdownCount}</td>
                  <td className="bd-sub">{t.reason}</td>
                  <td><button type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); act(() => download(request, `/planning/budget-templates/${t.id}/xlsx`, '予算書の型.xlsx')); }}>⬇ Excel</button></td>
                </tr>
                {open?.template.id === t.id && open.items.map((item) => (
                  <tr key={`${item.categoryCode}-${item.lineNo}`} className="bd-line">
                    <td>{item.categoryCode} {item.name}{item.breakdownSheet && <span className="bd-chip">内訳 {item.breakdownSheet}</span>}</td>
                    <td colSpan={5} className="bd-sub">{item.unitPriceYen != null ? `${yen(item.unitPriceYen)}` : ''}{item.qtyMilli != null ? ` × ${item.qtyMilli / 1000}${item.unit ?? ''}` : ''}</td>
                  </tr>
                ))}
                {open?.template.id === t.id && <tr className="bd-line"><td colSpan={6} className="bd-sub">版: {open.versions.map((v) => `v${v.versionNo} ${v.reason}`).join(' ／ ')}</td></tr>}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
