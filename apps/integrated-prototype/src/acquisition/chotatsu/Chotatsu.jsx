// 調達の画面（会社ルートの計画 plans/2026-10-24-folder-chotatsu.md。見本 _mocks の 2-folder-tree・3-case-view はどちらも A）。
// 左: 調達 › 発売予定年度 › 発売月 の木（案件から画面で組む。年度は4月〜翌3月）。右: 一覧（1案件1行・素材の期限の近い順）と1案件。
// 1案件: 判定 → 数字 → 例外 → 段 → 段ごとの記録と次の記録を足す小さな書式。値は受け口から読むだけで、段の状態・粗利は受け口が導いた値
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import {STAGES, STAGE_LABELS, MEDIA_FAMILIES, FORMATS, RELEASE_SLOTS, MATERIAL_KINDS, DOC_KINDS, RINGI_RESULTS} from './chotatsu-model.mjs';
import './chotatsu.css';

const yen = (value) => (value == null ? '—' : Number(value).toLocaleString('ja-JP'));
const SHORT = {wish: '希', estimate: '試', agreement: '合', ringi: '稟', contract: '契', materials: '素', handoff: '渡'};
const CHIP = {done: '済', now: '今', late: '遅', todo: '未', stop: '止', notice: '予'};
const CHECK_RESULTS = {pending: '未', ok: '済', ng: 'NG'};
const HANDOFF_STATES = {notice: '予告', received: '受領', void: '取消', none: '—'};
const EXCLUSIVITY = {exclusive: '独占', nonexclusive: '非独占', unknown: '不明'};
const ROYALTY_KINDS = {rate: '率', per_unit: '1枚', none: 'なし'};
const CLOSE_EVENTS = {dropped: '見送り', moved_to_mg: 'MGへ移した'};
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const blank = (v) => (v === '' || v == null ? undefined : v);
const toId = (v) => (v === '' || v == null ? undefined : /^\d+$/.test(String(v)) ? Number(v) : v);
const toNum = (v) => (v === '' || v == null ? undefined : Number(v));
const digits = (v) => String(v ?? '').replace(/[^\d]/g, '');
const fiscalYear = (month) => { const [y, m] = month.split('-').map(Number); return m >= 4 ? y : y - 1; };

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読めません'));
    reader.readAsDataURL(file);
  });
}

function Chip({state}) {
  return <span className={`ch-c ${state ?? 'todo'}`} data-state={state}>{CHIP[state] ?? '—'}</span>;
}

function Options({map, empty}) {
  return <>{empty !== undefined && <option value="">{empty}</option>}{Object.entries(map).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</>;
}

function Field({label, children}) {
  return <label className="ch-f"><span>{label}</span>{children}</label>;
}

// 書式の値をひとまとめに持つ。set('key') は input の onChange にそのまま渡せる
function useForm(initial) {
  const [values, setValues] = useState(initial);
  const set = (key, map = (x) => x) => (e) => { const v = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e; setValues((s) => ({...s, [key]: map(v)})); };
  return [values, set, setValues];
}

export default function Chotatsu({request}) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [node, setNode] = useState('all');
  const [creating, setCreating] = useState(false);
  const [caseId, setCaseId] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setList(await request('/chotatsu/cases')); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const cases = list?.cases ?? [];
  const tree = useMemo(() => {
    const years = new Map();
    let none = 0;
    for (const row of cases) {
      if (!row.releaseMonth) { none += 1; continue; }
      const fy = fiscalYear(row.releaseMonth);
      if (!years.has(fy)) years.set(fy, new Map());
      const months = years.get(fy);
      months.set(row.releaseMonth, (months.get(row.releaseMonth) ?? 0) + 1);
    }
    return {none, years: [...years.entries()].sort((a, b) => b[0] - a[0]).map(([fy, months]) => ({fy, months: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))}))};
  }, [cases]);
  const shown = useMemo(() => cases.filter((row) => {
    if (node === 'all') return true;
    if (node === 'none') return !row.releaseMonth;
    if (node.startsWith('fy:')) return row.releaseMonth && String(fiscalYear(row.releaseMonth)) === node.slice(3);
    return row.releaseMonth === node.slice(2);
  }).sort((a, b) => (a.materialsDue ?? '9999').localeCompare(b.materialsDue ?? '9999') || (a.releaseMonth ?? '9999').localeCompare(b.releaseMonth ?? '9999')), [cases, node]);

  const create = async (body) => {
    setBusy(true); setError(null);
    try {
      const result = await request('/chotatsu/cases', {method: 'POST', body});
      setCreating(false); await load(); setCaseId(result.caseId);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const treeNode = (id, className, label) => (
    <button key={id} type="button" className={`ch-node ${className}${node === id ? ' on' : ''}`} aria-pressed={node === id} onClick={() => setNode(id)}>{label}</button>
  );

  return (
    <section className="chotatsu" data-page="chotatsu" data-ready={list ? 'list' : 'loading'}>
      <nav className="ch-tree" aria-label="フォルダ">
        {treeNode('all', 'l1', `調達（${cases.length}）`)}
        {tree.none > 0 && treeNode('none', 'l2', `未定（${tree.none}）`)}
        {tree.years.map(({fy, months}) => (
          <React.Fragment key={fy}>
            {treeNode(`fy:${fy}`, 'l2', `${fy}年度`)}
            {months.map(([month, count]) => treeNode(`m:${month}`, 'l3', `${month}（${count}）`))}
          </React.Fragment>
        ))}
      </nav>
      <div className="ch-main">
        {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
        <div className="ch-bar">
          {list?.exceptionsCount > 0 && <span className="ch-alert" data-exceptions={list.exceptionsCount}>! 要確認 {list.exceptionsCount}</span>}
          <button type="button" className="ch-btn main" onClick={() => setCreating((v) => !v)}>新規</button>
        </div>
        {creating && list && (
          <div className="ch-box" data-form="create">
            <CaseFields partners={list.partners} works={list.works} busy={busy} submitLabel="置く" onCancel={() => setCreating(false)} onSubmit={create} />
          </div>
        )}
        {!list ? <p aria-busy="true">読込中…</p> : (
          <table className="ch-table" data-table="cases">
            <thead><tr><th>題</th><th>権利元</th><th>媒体</th><th>発売</th>{STAGES.map((s) => <th key={s} className="m">{SHORT[s]}</th>)}
              <th className="n">粗利見込</th><th>素材期限</th><th>判定</th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={14} className="ch-faint">なし</td></tr>}
              {shown.map((row) => (
                <tr key={row.id} className={`ch-row${row.id === caseId ? ' sel' : ''}${row.closed ? ' closed' : ''}`} data-case={row.caseCode} onClick={() => setCaseId(row.id)}>
                  <td>{row.title}<span className="ch-sub">{row.caseCode}</span></td>
                  <td>{row.holderName ?? '—'}</td>
                  <td>{MEDIA_FAMILIES[row.mediaFamily] ?? row.mediaFamily}</td>
                  <td>{row.releaseMonth ?? '未定'}</td>
                  {STAGES.map((s) => <td key={s} className="m"><Chip state={row.stages?.[s]} /></td>)}
                  <td className="n">{yen(row.grossYen)}</td>
                  <td>{row.materialsDue ?? '—'}</td>
                  <td className={row.folder?.reason === '遅' ? 'ch-red' : ''}>{row.folder?.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {caseId != null && list && (
          <CaseDetail key={`${caseId}`} request={request} id={caseId} partners={list.partners} works={list.works} onChanged={load} onClose={() => setCaseId(null)} />
        )}
      </div>
    </section>
  );
}

// 案件の欄（新規と版で共通）。withReason なら理由を必須にする
function CaseFields({initial = {}, partners, works, busy, submitLabel, withReason = false, onSubmit, onCancel}) {
  const [v, set] = useForm({title: '', holderPartnerId: '', distributorPartnerId: '', mediaFamily: 'videogram', workId: '', salesActivityId: '', theatricalReleaseOn: '',
    offerFrom: '', offerUntil: '', releaseMonth: '', releaseSlot: '', note: '', reason: '', ...Object.fromEntries(Object.entries(initial).map(([k, x]) => [k, x ?? '']))});
  const empty = withReason ? null : undefined;
  const pick = (x) => (x === '' ? empty : x);
  const body = () => {
    const out = {title: v.title.trim(), mediaFamily: v.mediaFamily, holderPartnerId: pick(toId(v.holderPartnerId) ?? ''), distributorPartnerId: pick(toId(v.distributorPartnerId) ?? ''),
      workId: pick(toId(v.workId) ?? ''), salesActivityId: pick(toId(v.salesActivityId) ?? ''), theatricalReleaseOn: pick(v.theatricalReleaseOn), offerFrom: pick(v.offerFrom),
      offerUntil: pick(v.offerUntil), releaseMonth: pick(v.releaseMonth), releaseSlot: pick(v.releaseSlot), note: pick(v.note)};
    if (withReason) out.reason = v.reason.trim();
    return out;
  };
  const ok = v.title.trim() && (!withReason || v.reason.trim());
  return (
    <div className="ch-form">
      <Field label="題"><input value={v.title} onChange={set('title')} /></Field>
      <Field label="権利元"><select value={v.holderPartnerId} onChange={set('holderPartnerId')}><option value="">—</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="発売元"><select value={v.distributorPartnerId} onChange={set('distributorPartnerId')}><option value="">—</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="媒体"><select value={v.mediaFamily} onChange={set('mediaFamily')}><Options map={MEDIA_FAMILIES} /></select></Field>
      <Field label="作品"><select value={v.workId} onChange={set('workId')}><option value="">—</option>{works.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></Field>
      {!withReason && <Field label="営業"><input inputMode="numeric" value={v.salesActivityId} onChange={set('salesActivityId', digits)} /></Field>}
      <Field label="公開日"><input type="date" value={v.theatricalReleaseOn} onChange={set('theatricalReleaseOn')} /></Field>
      <Field label="提示から"><input type="date" value={v.offerFrom} onChange={set('offerFrom')} /></Field>
      <Field label="提示まで"><input type="date" value={v.offerUntil} onChange={set('offerUntil')} /></Field>
      <Field label="発売月"><input type="month" value={v.releaseMonth} onChange={set('releaseMonth')} /></Field>
      <Field label="枠"><select value={v.releaseSlot} onChange={set('releaseSlot')}><Options map={RELEASE_SLOTS} empty="—" /></select></Field>
      <Field label="備考"><input value={v.note} onChange={set('note')} /></Field>
      {withReason && <Field label="理由"><input value={v.reason} onChange={set('reason')} /></Field>}
      <div className="ch-actions">
        <button type="button" className="ch-btn main" disabled={busy || !ok} onClick={() => onSubmit(body())}>{submitLabel}</button>
        {onCancel && <button type="button" className="ch-btn" onClick={onCancel}>やめる</button>}
      </div>
    </div>
  );
}

function CaseDetail({request, id, partners, works, onChanged, onClose}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const base = `/chotatsu/cases/${id}`;
  const load = useCallback(async () => {
    setError(null);
    try { setData(await request(base)); } catch (failure) { setError(failure); }
  }, [request, base]);
  useEffect(() => { load(); }, [load]);

  // 記録を足す。成功したら一覧と1案件を読み直す。失敗は受け口の文をそのまま出す。成否を返す
  const post = async (path, body) => {
    setBusy(true); setError(null);
    try { await request(`${base}${path}`, {method: 'POST', body}); await load(); await onChanged(); return true; } catch (failure) { setError(failure); return false; } finally { setBusy(false); }
  };
  const ask = (label) => { const reason = window.prompt(label); return reason && reason.trim() ? reason.trim() : null; };

  if (error && !data) return <div className="ch-detail"><Notice error={error} onRetry={load} retryLabel="読み直す" /></div>;
  if (!data) return <div className="ch-detail" aria-busy="true">読込中…</div>;
  const c = data.case;
  const latest = data.estimates.at(-1);
  const t = latest?.totals;
  const failed = data.checks.filter((check) => check.ok === false);
  const late = STAGES.filter((s) => data.stages[s] === 'late');
  const shared = {busy, post, data, ask};

  return (
    <div className="ch-detail" data-page="chotatsu-case" data-ready={`${c.id}:${c.versionNo}`}>
      <div className="ch-head">
        <span>{c.title} ／ {c.holderName ?? '—'} ／ {MEDIA_FAMILIES[c.mediaFamily] ?? c.mediaFamily} ／ {c.releaseMonth ?? '未定'} {RELEASE_SLOTS[c.releaseSlot] ?? ''}</span>
        <span className="ch-sub">{c.caseCode} 版{c.versionNo}</span>
        <button type="button" className="ch-btn ch-close" onClick={onClose} aria-label="閉じる">×</button>
      </div>
      {error && <Notice error={error} />}
      <div className="ch-verdict">判定: <span className={data.folder?.reason === '遅' ? 'ch-red' : ''}>{data.folder?.reason ?? '—'}</span>
        <span className="ch-sub">{data.folder?.done ?? 0}/{data.folder?.total ?? 3}</span>
        {data.closed && <span className="ch-chip">{CLOSE_EVENTS[data.closed.event] ?? data.closed.event}</span>}</div>
      <div className="ch-nums" data-gross={t?.grossYen ?? ''}>
        {[['予定価格', latest?.listPriceExTaxYen], ['数量', latest?.quantity], ['売上見込', t?.revenueYen], ['製造費', t?.costYen], ['権利料', t?.royaltyYen], ['粗利見込', t?.grossYen]].map(([label, value]) => (
          <div key={label}><div className="l">{label}</div><div className="v">{yen(value)}</div></div>
        ))}
      </div>
      {(failed.length > 0 || late.length > 0) && (
        <div className="ch-exc" data-exceptions={failed.length + late.length}>
          {late.map((s) => <p key={s}><b>遅</b> {STAGE_LABELS[s]}{s === 'materials' && data.materialsDue ? ` 期限 ${data.materialsDue}` : ''}</p>)}
          {failed.map((check) => <p key={check.key}><b>!</b> {check.message}</p>)}
        </div>
      )}
      <div className="ch-stages">{STAGES.map((s) => <div key={s} className={data.stages[s]} data-stage={s}>{STAGE_LABELS[s]}</div>)}</div>

      <Section title="版"><VersionForm key={`v${c.versionNo}`} c={c} partners={partners} works={works} {...shared} /></Section>
      <Section title="試算"><EstimateSection {...shared} /></Section>
      <Section title="合意"><AgreementSection {...shared} /></Section>
      <Section title="稟議"><RingiSection {...shared} /></Section>
      <Section title="契約"><ContractSection works={works} {...shared} /></Section>
      <Section title="素材"><MaterialsSection {...shared} /></Section>
      <Section title="渡す"><HandoffSection {...shared} /></Section>
      <Section title="原本"><DocumentsSection id={id} {...shared} /></Section>
      <Section title="閉じる"><CloseSection {...shared} /></Section>
    </div>
  );
}

function Section({title, children}) {
  return <section className="ch-sec" data-section={title}><h3>{title}</h3>{children}</section>;
}

function DocSelect({value, onChange, documents}) {
  return (
    <select value={value} onChange={onChange}><option value="">—</option>
      {documents.map((d) => <option key={d.sourceDocumentId} value={d.sourceDocumentId}>{DOC_KINDS[d.docKind] ?? d.docKind} {d.fileName}</option>)}
    </select>
  );
}

function EstimateSelect({value, onChange, estimates}) {
  return <select value={value} onChange={onChange}><option value="">—</option>{estimates.map((e) => <option key={e.versionNo} value={e.versionNo}>v{e.versionNo}</option>)}</select>;
}

function VersionForm({c, partners, works, busy, post}) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="ch-btn" onClick={() => setOpen(true)}>直す</button>;
  const initial = {title: c.title, holderPartnerId: c.holderPartnerId, distributorPartnerId: c.distributorPartnerId, mediaFamily: c.mediaFamily, workId: c.workId,
    theatricalReleaseOn: c.theatricalReleaseOn, offerFrom: c.offerFrom, offerUntil: c.offerUntil, releaseMonth: c.releaseMonth, releaseSlot: c.releaseSlot, note: c.note};
  return <CaseFields initial={initial} partners={partners} works={works} busy={busy} withReason submitLabel="版にする" onCancel={() => setOpen(false)}
    onSubmit={async (body) => { if (await post('/versions', {...body, baseVersionNo: c.versionNo})) setOpen(false); }} />;
}

const EMPTY_LINE = {expenseType: '', name: '', amountExTaxYen: ''};
function EstimateSection({data, busy, post}) {
  const last = data.estimates.at(-1);
  const initial = () => ({format: last?.format ?? 'sell_dvd', setCount: String(last?.setCount ?? 1), bonusNote: last?.bonusNote ?? '', listPriceExTaxYen: String(last?.listPriceExTaxYen ?? ''),
    unitRevenueExTaxYen: String(last?.unitRevenueExTaxYen ?? ''), quantity: String(last?.quantity ?? ''), royaltyKind: last?.royaltyKind ?? 'rate',
    royaltyRateBps: String(last?.royaltyRateBps ?? ''), royaltyPerUnitYen: String(last?.royaltyPerUnitYen ?? ''), promotionNote: last?.promotionNote ?? '', reason: '',
    lines: last?.lines?.length ? last.lines.map((l) => ({expenseType: l.expenseType ?? '', name: l.name ?? '', amountExTaxYen: String(l.amountExTaxYen ?? '')})) : [{...EMPTY_LINE}]});
  const [v, set, setV] = useForm(initial);
  const setLine = (i, key) => (e) => setV((s) => ({...s, lines: s.lines.map((l, j) => (j === i ? {...l, [key]: key === 'amountExTaxYen' ? digits(e.target.value) : e.target.value} : l))}));
  const submit = async () => {
    const ok = await post('/estimates', {format: v.format, setCount: toNum(v.setCount), bonusNote: blank(v.bonusNote), listPriceExTaxYen: toNum(v.listPriceExTaxYen),
      unitRevenueExTaxYen: toNum(v.unitRevenueExTaxYen), quantity: toNum(v.quantity), royaltyKind: v.royaltyKind,
      royaltyRateBps: v.royaltyKind === 'rate' ? toNum(v.royaltyRateBps) : undefined, royaltyPerUnitYen: v.royaltyKind === 'per_unit' ? toNum(v.royaltyPerUnitYen) : undefined,
      promotionNote: blank(v.promotionNote), reason: blank(v.reason),
      lines: v.lines.filter((l) => l.name.trim() || l.amountExTaxYen !== '').map((l) => ({expenseType: blank(l.expenseType.trim()), name: l.name.trim(), amountExTaxYen: toNum(l.amountExTaxYen)}))});
    if (ok) setV((s) => ({...s, reason: ''}));
  };
  return <>
    {data.estimates.length > 0 && (
      <table className="ch-table"><thead><tr><th>版</th><th>形態</th><th className="n">数量</th><th className="n">粗利</th><th>理由</th></tr></thead>
        <tbody>{data.estimates.map((e) => <tr key={e.versionNo}><td>v{e.versionNo}</td><td>{FORMATS[e.format] ?? e.format}</td><td className="n">{yen(e.quantity)}</td>
          <td className="n">{yen(e.totals?.grossYen)}</td><td>{e.reason ?? ''}</td></tr>)}</tbody></table>
    )}
    <div className="ch-form">
      <Field label="形態"><select value={v.format} onChange={set('format')}><Options map={FORMATS} /></select></Field>
      <Field label="枚組"><input className="n" inputMode="numeric" value={v.setCount} onChange={set('setCount', digits)} /></Field>
      <Field label="特典"><input value={v.bonusNote} onChange={set('bonusNote')} /></Field>
      <Field label="予定価格"><input className="n" inputMode="numeric" value={v.listPriceExTaxYen} onChange={set('listPriceExTaxYen', digits)} /></Field>
      <Field label="卸単価"><input className="n" inputMode="numeric" value={v.unitRevenueExTaxYen} onChange={set('unitRevenueExTaxYen', digits)} /></Field>
      <Field label="数量"><input className="n" inputMode="numeric" value={v.quantity} onChange={set('quantity', digits)} /></Field>
      <Field label="権利料"><select value={v.royaltyKind} onChange={set('royaltyKind')}><Options map={ROYALTY_KINDS} /></select></Field>
      {v.royaltyKind === 'rate' && <Field label="率 bp"><input className="n" inputMode="numeric" value={v.royaltyRateBps} onChange={set('royaltyRateBps', digits)} /></Field>}
      {v.royaltyKind === 'per_unit' && <Field label="1枚 円"><input className="n" inputMode="numeric" value={v.royaltyPerUnitYen} onChange={set('royaltyPerUnitYen', digits)} /></Field>}
      <Field label="宣伝"><input value={v.promotionNote} onChange={set('promotionNote')} /></Field>
      <Field label="理由"><input value={v.reason} onChange={set('reason')} /></Field>
    </div>
    <table className="ch-table ch-edit"><thead><tr><th>費目</th><th>名</th><th className="n">税抜</th><th /></tr></thead>
      <tbody>{v.lines.map((l, i) => (
        <tr key={i}><td><input value={l.expenseType} onChange={setLine(i, 'expenseType')} aria-label="費目" /></td><td><input value={l.name} onChange={setLine(i, 'name')} aria-label="名" /></td>
          <td><input className="n" inputMode="numeric" value={l.amountExTaxYen} onChange={setLine(i, 'amountExTaxYen')} aria-label="税抜" /></td>
          <td><button type="button" className="ch-btn" aria-label="行を消す" onClick={() => setV((s) => ({...s, lines: s.lines.filter((_, j) => j !== i)}))}>×</button></td></tr>
      ))}</tbody></table>
    <div className="ch-actions">
      <button type="button" className="ch-btn" onClick={() => setV((s) => ({...s, lines: [...s.lines, {...EMPTY_LINE}]}))}>＋ 行</button>
      <button type="button" className="ch-btn main" disabled={busy || !v.quantity || !v.unitRevenueExTaxYen} onClick={submit}>試算を足す</button>
    </div>
  </>;
}

function AgreementSection({data, busy, post}) {
  const [v, set, setV] = useForm({estimateVersionNo: String(data.estimates.at(-1)?.versionNo ?? ''), agreedOn: todayIso(), sourceDocumentId: ''});
  const submit = async () => {
    if (await post('/agreements', {estimateVersionNo: toNum(v.estimateVersionNo), agreedOn: v.agreedOn, sourceDocumentId: toId(v.sourceDocumentId)})) setV((s) => ({...s, sourceDocumentId: ''}));
  };
  return <>
    {data.agreements.length > 0 && (
      <table className="ch-table"><thead><tr><th>試算</th><th>合意日</th><th>原本</th></tr></thead>
        <tbody>{data.agreements.map((a) => <tr key={a.id}><td>v{a.estimateVersionNo}</td><td>{a.agreedOn}</td><td>{a.sourceDocumentId ? '有' : '—'}</td></tr>)}</tbody></table>
    )}
    <div className="ch-form">
      <Field label="試算"><EstimateSelect value={v.estimateVersionNo} onChange={set('estimateVersionNo')} estimates={data.estimates} /></Field>
      <Field label="合意日"><input type="date" value={v.agreedOn} onChange={set('agreedOn')} /></Field>
      <Field label="原本"><DocSelect value={v.sourceDocumentId} onChange={set('sourceDocumentId')} documents={data.documents} /></Field>
      <div className="ch-actions"><button type="button" className="ch-btn main" disabled={busy || !v.estimateVersionNo || !v.agreedOn} onClick={submit}>合意を足す</button></div>
    </div>
  </>;
}

function RingiSection({data, busy, post}) {
  const [v, set, setV] = useForm({estimateVersionNo: String(data.estimates.at(-1)?.versionNo ?? ''), result: 'approved', resultOn: todayIso(), sourceDocumentId: '', note: ''});
  const submit = async () => {
    const ok = await post('/ringi', {estimateVersionNo: toNum(v.estimateVersionNo), result: v.result, resultOn: v.resultOn, sourceDocumentId: toId(v.sourceDocumentId), note: blank(v.note)});
    if (ok) setV((s) => ({...s, note: '', sourceDocumentId: ''}));
  };
  return <>
    {data.ringi.length > 0 && (
      <table className="ch-table"><thead><tr><th>試算</th><th>結果</th><th>日</th><th>原本</th><th>備考</th></tr></thead>
        <tbody>{data.ringi.map((r) => <tr key={r.id}><td>v{r.estimateVersionNo}</td><td className={r.result === 'approved' ? '' : 'ch-red'}>{RINGI_RESULTS[r.result] ?? r.result}</td>
          <td>{r.resultOn}</td><td>{r.sourceDocumentId ? '有' : '—'}</td><td>{r.note ?? ''}</td></tr>)}</tbody></table>
    )}
    <div className="ch-form">
      <Field label="試算"><EstimateSelect value={v.estimateVersionNo} onChange={set('estimateVersionNo')} estimates={data.estimates} /></Field>
      <Field label="結果"><select value={v.result} onChange={set('result')}><Options map={RINGI_RESULTS} /></select></Field>
      <Field label="日"><input type="date" value={v.resultOn} onChange={set('resultOn')} /></Field>
      <Field label="原本"><DocSelect value={v.sourceDocumentId} onChange={set('sourceDocumentId')} documents={data.documents} /></Field>
      <Field label="備考"><input value={v.note} onChange={set('note')} /></Field>
      <div className="ch-actions"><button type="button" className="ch-btn main" disabled={busy || !v.estimateVersionNo || !v.resultOn} onClick={submit}>稟議を足す</button></div>
    </div>
  </>;
}

const EMPTY_SCOPE = {channel: '', territory: '日本', rightsStart: '', rightsEnd: '', exclusivity: 'exclusive'};
function ContractSection({data, works, busy, post}) {
  const contract = data.contract;
  const [v, set, setV] = useForm({workId: String(data.case.workId ?? ''), signedOn: todayIso(), signedDocumentId: '', agencyFeeBps: '', platformRateBps: '0', scopes: [{...EMPTY_SCOPE}]});
  if (contract) {
    return <>
      <p className="ch-kv"><span>作品</span>{contract.workTitle ?? '—'}<span>締結</span>{contract.signedOn ?? '—'}<span>受付</span>{contract.intakeCaseCode ?? '—'}
        <span>精算</span>{contract.settlementContractCode ?? '—'}<span>原本</span>{contract.signedDocumentId ? '有' : '—'}</p>
      <table className="ch-table"><thead><tr><th>媒体</th><th>地域</th><th>始</th><th>終</th><th>独占</th></tr></thead>
        <tbody>{contract.scopes.map((s, i) => <tr key={i}><td>{s.channel}</td><td>{s.territory}</td><td>{s.rightsStart ?? '—'}</td><td>{s.rightsEnd ?? '—'}</td>
          <td>{EXCLUSIVITY[s.exclusivity] ?? s.exclusivity}</td></tr>)}</tbody></table>
      {data.case.releaseMonth && <div className="ch-actions"><button type="button" className="ch-btn" disabled={busy} onClick={() => post('/release-window-draft', {})}>ウィンドウへ写す</button></div>}
    </>;
  }
  const setScope = (i, key) => (e) => setV((s) => ({...s, scopes: s.scopes.map((row, j) => (j === i ? {...row, [key]: e.target.value} : row))}));
  const submit = () => post('/contract', {workId: toId(v.workId), signedOn: v.signedOn, signedDocumentId: toId(v.signedDocumentId),
    scopes: v.scopes.filter((s) => s.channel.trim()).map((s) => ({channel: s.channel.trim(), territory: s.territory.trim(), rightsStart: blank(s.rightsStart), rightsEnd: blank(s.rightsEnd), exclusivity: s.exclusivity})),
    terms: {agencyFeeBps: toNum(v.agencyFeeBps), platformRateBps: toNum(v.platformRateBps) ?? 0}});
  return <>
    <div className="ch-form">
      <Field label="作品"><select value={v.workId} onChange={set('workId')}><option value="">—</option>{works.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></Field>
      <Field label="締結日"><input type="date" value={v.signedOn} onChange={set('signedOn')} /></Field>
      <Field label="原本"><DocSelect value={v.signedDocumentId} onChange={set('signedDocumentId')} documents={data.documents} /></Field>
      <Field label="手数料 bp"><input className="n" inputMode="numeric" value={v.agencyFeeBps} onChange={set('agencyFeeBps', digits)} /></Field>
      <Field label="PF率 bp"><input className="n" inputMode="numeric" value={v.platformRateBps} onChange={set('platformRateBps', digits)} /></Field>
    </div>
    <table className="ch-table ch-edit"><thead><tr><th>媒体</th><th>地域</th><th>始</th><th>終</th><th>独占</th><th /></tr></thead>
      <tbody>{v.scopes.map((s, i) => (
        <tr key={i}><td><input value={s.channel} onChange={setScope(i, 'channel')} aria-label="媒体" /></td><td><input value={s.territory} onChange={setScope(i, 'territory')} aria-label="地域" /></td>
          <td><input type="date" value={s.rightsStart} onChange={setScope(i, 'rightsStart')} aria-label="始" /></td><td><input type="date" value={s.rightsEnd} onChange={setScope(i, 'rightsEnd')} aria-label="終" /></td>
          <td><select value={s.exclusivity} onChange={setScope(i, 'exclusivity')}><Options map={EXCLUSIVITY} /></select></td>
          <td><button type="button" className="ch-btn" aria-label="行を消す" onClick={() => setV((x) => ({...x, scopes: x.scopes.filter((_, j) => j !== i)}))}>×</button></td></tr>
      ))}</tbody></table>
    <div className="ch-actions">
      <button type="button" className="ch-btn" onClick={() => setV((s) => ({...s, scopes: [...s.scopes, {...EMPTY_SCOPE}]}))}>＋ 行</button>
      <button type="button" className="ch-btn main" disabled={busy || !v.workId || !v.signedOn || !v.scopes.some((s) => s.channel.trim())} onClick={submit}>契約を置く</button>
    </div>
  </>;
}

function MaterialsSection({data, busy, post}) {
  const [v, set, setV] = useForm({materialKind: 'master', required: true, receivedOn: '', checkResult: 'pending', sourceDocumentId: '', note: ''});
  const submit = async () => {
    const ok = await post('/materials', {materialKind: v.materialKind, required: v.required, receivedOn: blank(v.receivedOn), checkResult: v.checkResult,
      sourceDocumentId: toId(v.sourceDocumentId), note: blank(v.note)});
    if (ok) setV((s) => ({...s, receivedOn: '', sourceDocumentId: '', note: ''}));
  };
  const lateDue = data.stages.materials === 'late';
  return <>
    <p className="ch-kv"><span>期限</span><b className={lateDue ? 'ch-red' : ''}>{data.materialsDue ?? '—'}</b></p>
    {data.materials.length > 0 && (
      <table className="ch-table"><thead><tr><th>種類</th><th className="m">要</th><th>受領</th><th>検品</th><th>備考</th></tr></thead>
        <tbody>{data.materials.map((m) => (
          <tr key={m.materialKind}><td>{MATERIAL_KINDS[m.materialKind] ?? m.materialKind}</td><td className="m">{m.required ? '要' : '—'}</td>
            <td className={!m.receivedOn && m.required && lateDue ? 'ch-red' : ''}>{m.receivedOn ?? '未'}</td>
            <td className={m.checkResult === 'ng' ? 'ch-red' : ''}>{CHECK_RESULTS[m.checkResult] ?? m.checkResult}</td><td>{m.note ?? ''}</td></tr>
        ))}</tbody></table>
    )}
    <div className="ch-form">
      <Field label="種類"><select value={v.materialKind} onChange={set('materialKind')}><Options map={MATERIAL_KINDS} /></select></Field>
      <Field label="要"><input type="checkbox" checked={v.required} onChange={set('required')} /></Field>
      <Field label="受領"><input type="date" value={v.receivedOn} onChange={set('receivedOn')} /></Field>
      <Field label="検品"><select value={v.checkResult} onChange={set('checkResult')}><Options map={CHECK_RESULTS} /></select></Field>
      <Field label="原本"><DocSelect value={v.sourceDocumentId} onChange={set('sourceDocumentId')} documents={data.documents} /></Field>
      <Field label="備考"><input value={v.note} onChange={set('note')} /></Field>
      <div className="ch-actions"><button type="button" className="ch-btn main" disabled={busy} onClick={submit}>素材を足す</button></div>
    </div>
  </>;
}

function HandoffSection({data, busy, post, ask}) {
  const live = data.handoffs.some((h) => h.state !== 'void');
  const voidIt = () => { const reason = ask('取消の理由'); if (reason) post('/handoffs', {action: 'void', reason}); };
  return <>
    {data.handoffs.length > 0 && (
      <table className="ch-table"><thead><tr><th>番号</th><th>状態</th><th>発売月</th><th>試算</th></tr></thead>
        <tbody>{data.handoffs.map((h) => <tr key={h.id} className={h.state === 'void' ? 'closed' : ''}><td>{h.handoffNo}</td><td>{HANDOFF_STATES[h.state] ?? h.state}</td>
          <td>{h.releaseMonth ?? '—'} {RELEASE_SLOTS[h.releaseSlot] ?? ''}</td><td>{h.estimateVersionNo ? `v${h.estimateVersionNo}` : '—'}</td></tr>)}</tbody></table>
    )}
    <div className="ch-actions">
      <button type="button" className="ch-btn" disabled={busy || !data.canNotice} onClick={() => post('/handoffs', {action: 'notice'})}>製造へ予告</button>
      <button type="button" className="ch-btn main" disabled={busy || !data.canReceive} onClick={() => post('/handoffs', {action: 'received'})}>製造へ渡す</button>
      {live && <button type="button" className="ch-btn" disabled={busy} onClick={voidIt}>取消</button>}
    </div>
  </>;
}

function DocumentsSection({id, data, busy, post}) {
  const [docKind, setDocKind] = useState('estimate');
  const [file, setFile] = useState(null);
  const [inputKey, setInputKey] = useState(0);
  const upload = async () => {
    if (!file) return;
    const base64 = await readFileBase64(file);
    const ok = await post('/documents', {docKind, fileName: file.name, mediaType: file.type || 'application/octet-stream', base64, receivedOn: todayIso()});
    if (ok) { setFile(null); setInputKey((n) => n + 1); }
  };
  return <>
    {data.documents.length > 0 && (
      <table className="ch-table"><thead><tr><th>種類</th><th>ファイル</th><th>受領</th><th className="n">大きさ</th></tr></thead>
        <tbody>{data.documents.map((d) => (
          <tr key={d.sourceDocumentId}><td>{DOC_KINDS[d.docKind] ?? d.docKind}</td>
            <td><a href={`/api/chotatsu/cases/${id}/documents/${d.sourceDocumentId}`} download={d.fileName}>{d.fileName}</a></td>
            <td>{d.receivedOn ?? '—'}</td><td className="n">{yen(d.byteLength)}</td></tr>
        ))}</tbody></table>
    )}
    <div className="ch-form">
      <Field label="種類"><select value={docKind} onChange={(e) => setDocKind(e.target.value)}><Options map={DOC_KINDS} /></select></Field>
      <Field label="ファイル"><input key={inputKey} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <div className="ch-actions"><button type="button" className="ch-btn main" disabled={busy || !file} onClick={upload}>置く</button></div>
    </div>
  </>;
}

function CloseSection({data, busy, post, ask}) {
  const close = (event, label) => { const reason = ask(`${label}の理由`); if (reason) post('/events', {event, reason}); };
  if (data.closed) {
    const undo = () => { const reason = ask('取消の理由'); if (reason) post('/events', {event: 'void', voidsSeq: data.closed.seq, reason}); };
    return <div className="ch-actions"><span className="ch-chip">{CLOSE_EVENTS[data.closed.event] ?? data.closed.event}</span>
      <span className="ch-sub">{data.closed.reason ?? ''}</span><button type="button" className="ch-btn" disabled={busy} onClick={undo}>取消</button></div>;
  }
  return (
    <div className="ch-actions">
      <button type="button" className="ch-btn" disabled={busy} onClick={() => close('dropped', '見送り')}>見送り</button>
      <button type="button" className="ch-btn" disabled={busy} onClick={() => close('moved_to_mg', 'MGへ移す')}>MGへ移す</button>
    </div>
  );
}
