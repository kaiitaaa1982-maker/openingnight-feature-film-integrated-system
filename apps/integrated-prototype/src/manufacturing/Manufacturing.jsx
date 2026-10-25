// 製造の画面（会社ルートの plans/2026-10-24-folder-seizou.md。移行 0046）。
// 一覧: 数字だけ（今月・来月の発売・期限超・納品待ち・請求未着）と、発売月ごとの商品×工程のマス。
// 1商品: 逆算の日程（工程ごとに依頼・〆切・済。期限超だけ赤）と、発注書（依頼→見積→発注→納品→請求→支払）。値は受け口から読むだけ
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Notice} from '../ui/Notice.jsx';
import {priceToX100} from './mfg-model.mjs';
import './mfg.css';

const yen = (value) => (value == null ? '—' : `¥${Number(value).toLocaleString('ja-JP')}`);
const md = (date) => (date ? `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : '—');
const month = (date) => date.slice(0, 7);
const addMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const MARK = {done: '✓', late: '✕', requested: '…', open: ''};

function Mark({state, dueOn}) {
  if (state === 'done') return <span className="mf-tag">✓</span>;
  if (state === 'late') return <span className="mf-tag late">✕</span>;
  return <span className="mf-tag plan">{state === 'requested' ? '…' : md(dueOn)}</span>;
}

export default function Manufacturing({request}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [productId, setProductId] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await request('/mfg/products')); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { load(); }, [load]);
  if (productId != null) return <ProductPage request={request} productId={productId} onBack={() => { setProductId(null); load(); }} />;
  if (error) return <section className="mf"><Notice error={error} onRetry={load} retryLabel="読み直す" /></section>;
  if (!data) return <section className="mf"><p aria-busy="true">読込中…</p></section>;
  const thisMonth = month(data.today);
  const products = [...data.products].sort((a, b) => a.version.releaseOn.localeCompare(b.version.releaseOn) || a.id - b.id);
  const count = (fn) => products.filter(fn).length;
  const nums = [
    ['今月発売', count((p) => month(p.version.releaseOn) === thisMonth), false],
    ['来月発売', count((p) => month(p.version.releaseOn) === addMonth(thisMonth, 1)), false],
    ['期限超', products.reduce((n, p) => n + p.progress.late, 0), true],
    ['納品待ち', products.reduce((n, p) => n + p.orders.waiting, 0), false],
    ['請求未着', products.reduce((n, p) => n + p.orders.uninvoiced, 0), false],
  ];
  const months = [...new Set(products.map((p) => month(p.version.releaseOn)))];
  const stepKeys = ['material', 'text_spec', 'authoring_flow', 'menu_design', 'check_disc', 'sell_jacket', 'rental_front', 'promo_banner', 'announce', 'release'];
  const stepLabel = {material: '素材', text_spec: '文字', authoring_flow: 'ｵｰｻﾘ', menu_design: 'ﾒﾆｭｰ', check_disc: '検証', sell_jacket: 'ｼﾞｬｹ', rental_front: 'ﾚﾝﾀﾙ',
    promo_banner: '告知', announce: '解禁', release: '発売'};
  return (
    <section className="mf" data-page="mfg-list">
      <div className="mf-nums">
        {nums.map(([label, n, hot]) => <div key={label} className={hot && n > 0 ? 'hot' : ''}><b>{n}</b><span>{label}</span></div>)}
      </div>
      <div className="mf-actions"><button type="button" className="pri" onClick={() => setAdding(!adding)}>{adding ? '閉じる' : '商品を足す'}</button></div>
      {adding && <ProductForm data={data} request={request} onSaved={(id) => { setAdding(false); setProductId(id); }} />}
      {months.map((ym) => (
        <div key={ym}>
          <h2>{ym.replace('-', '年')}月発売</h2>
          <table className="mf-table">
            <thead><tr><th>商品</th><th>形</th><th>発売</th>{stepKeys.map((k) => <th key={k} className="c">{stepLabel[k]}</th>)}<th className="c">済</th><th className="c">発注</th></tr></thead>
            <tbody>
              {products.filter((p) => month(p.version.releaseOn) === ym).map((p) => (
                <tr key={p.id} className="mf-row" onClick={() => setProductId(p.id)} data-product={p.id}>
                  <td>{p.version.name}<span className="mf-sub">{p.workTitle}</span></td>
                  <td>{data.labels.channels[p.version.channel]}{data.labels.media[p.version.media] ? ` ${data.labels.media[p.version.media]}` : ''}</td>
                  <td>{md(p.version.releaseOn)}</td>
                  {stepKeys.map((k) => { const s = p.steps.find((x) => x.key === k); return <td key={k} className="c">{s ? <Mark state={s.state} dueOn={s.dueOn} /> : ''}</td>; })}
                  <td className="c">{p.progress.done}/{p.progress.total}</td>
                  <td className="c">{p.orders.count ? `${p.orders.count}${p.orders.waiting ? `（待${p.orders.waiting}）` : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function ProductForm({data, request, onSaved}) {
  const [form, setForm] = useState({workId: data.works[0]?.id ?? '', sourceKind: 'procure', name: '', channel: 'sell', media: 'dvd', editionLabel: '', releaseOn: '', plannedQty: '', episodeFrom: '', episodeTo: ''});
  const [error, setError] = useState(null);
  const set = (key) => (event) => setForm({...form, [key]: event.target.value});
  const save = async (event) => {
    event.preventDefault();
    setError(null);
    try { const result = await request('/mfg/products', {method: 'POST', body: {...form, workId: Number(form.workId)}}); onSaved(result.productId); } catch (failure) { setError(failure); }
  };
  return (
    <form className="mf-form" onSubmit={save}>
      {error && <Notice error={error} />}
      <label>作品<select value={form.workId} onChange={set('workId')}>{data.works.map((w) => <option key={w.id} value={w.id}>{w.title}（{w.code}）</option>)}</select></label>
      <label>出どころ<select value={form.sourceKind} onChange={set('sourceKind')}>{Object.entries(data.labels.sourceKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>商品名<input value={form.name} onChange={set('name')} required /></label>
      <label>形<select value={form.channel} onChange={set('channel')}>{Object.entries(data.labels.channels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>媒体<select value={form.media} onChange={set('media')}>{Object.entries(data.labels.media).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>版<input value={form.editionLabel} onChange={set('editionLabel')} /></label>
      <label>発売日<input type="date" value={form.releaseOn} onChange={set('releaseOn')} required /></label>
      <label>予定枚数<input className="n" value={form.plannedQty} onChange={set('plannedQty')} inputMode="numeric" /></label>
      <label>話<span className="mf-pair"><input className="n" value={form.episodeFrom} onChange={set('episodeFrom')} />〜<input className="n" value={form.episodeTo} onChange={set('episodeTo')} /></span></label>
      <button type="submit" className="pri">登録</button>
    </form>
  );
}

function ProductPage({request, productId, onBack}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const base = `/mfg/products/${productId}`;
  const load = useCallback(async () => {
    setError(null);
    try { setData(await request(base)); } catch (failure) { setError(failure); }
  }, [request, base]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, done) => {
    setError(null); setMessage(null);
    try { await fn(); setMessage(done ?? '✓'); await load(); } catch (failure) { setError(failure); }
  };
  if (!data) return <section className="mf">{error ? <Notice error={error} onRetry={load} retryLabel="読み直す" /> : <p aria-busy="true">読込中…</p>}</section>;
  const {version, steps, progress, orders, labels} = data;
  return (
    <section className="mf" data-page="mfg-product">
      <div className="mf-head no-print">
        <button type="button" onClick={onBack}>← 一覧</button>
        <button type="button" onClick={() => window.print()}>進行表を印刷</button>
      </div>
      {error && <Notice error={error} />}
      {message && <p className="mf-message" role="status">{message}</p>}
      <h2>{version.name}{version.editionLabel ? `（${version.editionLabel}）` : ''}<span className="mf-sub">{data.product.workTitle}・{labels.channels[version.channel]} {labels.media[version.media]}・{labels.sourceKinds[data.product.sourceKind]}</span></h2>
      <div className="mf-nums small">
        <div><b>{md(version.releaseOn)}</b><span>発売</span></div>
        <div><b>{progress.done}/{progress.total}</b><span>済</span></div>
        <div className={progress.late ? 'hot' : ''}><b>{progress.late}</b><span>期限超</span></div>
        <div><b>{version.plannedQty ?? '—'}</b><span>予定枚数</span></div>
      </div>
      <h3>日程</h3>
      <ScheduleTable steps={steps} events={data.events} today={data.today}
        onEvent={(body) => act(() => request(`${base}/steps`, {method: 'POST', body}))} />
      <div className="no-print">
        <VersionForm version={version} labels={labels} onSave={(body) => act(() => request(`${base}/versions`, {method: 'POST', body}), '版を足しました')} />
        <h3>発注書</h3>
        <Orders orders={orders} labels={labels} today={data.today} request={request} act={act} />
        <OrderForm partners={data.partners} labels={labels} onSave={(body) => act(() => request(`${base}/orders`, {method: 'POST', body}), '発注書を作りました')} />
      </div>
    </section>
  );
}

function ScheduleTable({steps, events, today, onEvent}) {
  const [date, setDate] = useState(today);
  const live = events.filter((e) => e.live && e.kind !== 'void');
  return (
    <>
      <p className="mf-inline no-print"><input type="date" aria-label="記録する日" value={date} onChange={(e) => setDate(e.target.value)} /></p>
      <table className="mf-table mf-schedule">
        <thead><tr><th>工程</th><th>依頼</th><th>〆切</th><th>記録</th><th className="c">状態</th><th className="no-print"></th></tr></thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.key} className={s.state === 'late' ? 'late' : s.state === 'done' ? 'mute' : ''}>
              <td>{s.label}</td>
              <td>{md(s.requestOn)}</td>
              <td>{md(s.dueOn)}{s.overridden && <span className="mf-sub">直</span>}</td>
              <td className="mf-events">{live.filter((e) => e.stepKey === s.key).map((e) => (
                <span key={e.id}>{({requested: '依頼', approved: '承認', done: '済', planned: '〆切'})[e.kind]} {md(e.onDate)}
                  <button type="button" className="link no-print" title="取消" onClick={() => { const note = window.prompt('取消の理由'); if (note) onEvent({stepKey: s.key, kind: 'void', voidsEventId: e.id, note}); }}>×</button></span>
              ))}</td>
              <td className="c"><Mark state={s.state} dueOn={s.dueOn} /></td>
              <td className="no-print mf-btns">
                {s.requestOn && <button type="button" onClick={() => onEvent({stepKey: s.key, kind: 'requested', onDate: date})}>依頼</button>}
                {s.requestOn && <button type="button" onClick={() => onEvent({stepKey: s.key, kind: 'approved', onDate: date})}>承認</button>}
                {!s.requestOn && <button type="button" onClick={() => onEvent({stepKey: s.key, kind: 'done', onDate: date})}>済</button>}
                <button type="button" onClick={() => onEvent({stepKey: s.key, kind: 'planned', onDate: date})}>〆切を直す</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function VersionForm({version, labels, onSave}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({name: version.name, channel: version.channel, media: version.media, editionLabel: version.editionLabel ?? '', releaseOn: version.releaseOn,
    plannedQty: version.plannedQty ?? '', episodeFrom: version.episodeFrom ?? '', episodeTo: version.episodeTo ?? '', reason: ''});
  const set = (key) => (event) => setForm({...form, [key]: event.target.value});
  if (!open) return <p><button type="button" onClick={() => setOpen(true)}>発売日・枚数を直す</button></p>;
  return (
    <form className="mf-form" onSubmit={(e) => { e.preventDefault(); onSave(form); setOpen(false); }}>
      <label>商品名<input value={form.name} onChange={set('name')} /></label>
      <label>形<select value={form.channel} onChange={set('channel')}>{Object.entries(labels.channels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>媒体<select value={form.media} onChange={set('media')}>{Object.entries(labels.media).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>版<input value={form.editionLabel} onChange={set('editionLabel')} /></label>
      <label>発売日<input type="date" value={form.releaseOn} onChange={set('releaseOn')} /></label>
      <label>予定枚数<input className="n" value={form.plannedQty} onChange={set('plannedQty')} /></label>
      <label>理由<input value={form.reason} onChange={set('reason')} required /></label>
      <button type="submit" className="pri">版を足す</button><button type="button" onClick={() => setOpen(false)}>やめる</button>
    </form>
  );
}

function Orders({orders, labels, today, request, act}) {
  if (!orders.length) return null;
  return orders.map((o) => <OrderCard key={o.id} order={o} labels={labels} today={today} request={request} act={act} />);
}

function OrderCard({order, labels, today, request, act}) {
  const [date, setDate] = useState(today);
  const voided = order.stage === 'void';
  const diff = order.invoicedExTax != null && order.invoicedExTax !== order.orderedExTax;
  const event = (kind, extra = {}) => act(() => request(`/mfg/orders/${order.id}/events`, {method: 'POST', body: {kind, onDate: date, ...extra}}));
  return (
    <div className={`mf-card ${voided ? 'mute' : ''}`} data-order={order.id}>
      <div className="mf-card-head">
        <b>{order.poNo}</b><span>{labels.poKinds[order.poKind]}</span><span>{order.partnerName}</span>
        {order.deliverTo && <span className="mf-sub">納品先 {order.deliverTo}</span>}{order.dueOn && <span className="mf-sub">納期 {md(order.dueOn)}</span>}
        {voided && <span className="mf-tag late">取消</span>}
      </div>
      <div className="mf-steps">
        {labels.poStages.map((stage) => <div key={stage} className={order.reached.includes(stage) ? 'on' : ''}>{labels.poStageLabels[stage]}</div>)}
      </div>
      <table className="mf-table">
        <thead><tr><th>品目</th><th>仕様</th><th className="n">数量</th><th className="n">単価</th><th className="n">税抜</th><th>納品</th><th>経費の行</th></tr></thead>
        <tbody>
          {order.lines.map((l) => <OrderLine key={l.id} line={l} today={today} disabled={voided} request={request} act={act} />)}
          <tr className="mf-total"><td colSpan={4}>発注額</td><td className="n">{yen(order.orderedExTax)}</td><td>請求額</td><td className={diff ? 'bad' : ''}>{yen(order.invoicedExTax)}</td></tr>
        </tbody>
      </table>
      {!voided && (
        <p className="mf-btns">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button type="button" onClick={() => event('quote_requested')}>見積を依頼</button>
          <button type="button" onClick={() => { const v = window.prompt('見積の額（税抜の円）'); if (v != null) event('quoted', {amountExTaxYen: v.replace(/,/g, '')}); }}>見積が来た</button>
          <button type="button" onClick={() => event('ordered')}>発注した</button>
          <button type="button" onClick={() => event('invoiced')}>請求が来た</button>
          <button type="button" onClick={() => event('paid')}>支払った</button>
          <button type="button" onClick={() => { const note = window.prompt('取消の理由'); if (note) event('void', {note}); }}>取消</button>
        </p>
      )}
    </div>
  );
}

function OrderLine({line, today, disabled, request, act}) {
  const received = line.receipts.filter((r) => r.result === 'pass').reduce((n, r) => n + r.qty - r.defectQty, 0);
  const receive = () => {
    const qty = window.prompt('納品の数量', String(line.qty - received));
    if (qty == null) return;
    act(() => request(`/mfg/order-lines/${line.id}/receipts`, {method: 'POST', body: {receivedOn: today, qty: Number(qty), result: 'pass'}}), '納品を記録しました');
  };
  const link = () => {
    const id = window.prompt('経費の明細の行の番号（経費の画面の ID）');
    if (!id) return;
    act(() => request(`/mfg/order-lines/${line.id}/expenses`, {method: 'POST', body: {expenseId: Number(id)}}), '経費の行と結びました');
  };
  return (
    <tr>
      <td>{line.item}</td><td>{line.spec ?? ''}</td><td className="n">{line.qty.toLocaleString('ja-JP')}</td>
      <td className="n">{(line.unitPriceX100 / 100).toLocaleString('ja-JP', {maximumFractionDigits: 2})}</td><td className="n">{yen(line.amountExTaxYen)}</td>
      <td>{received >= line.qty ? <span className="mf-tag">✓ {received}</span> : <>{received ? `${received}/${line.qty}` : '—'}{!disabled && <button type="button" className="link" onClick={receive}>納品</button>}</>}</td>
      <td>{line.expenses.map((x) => <span key={x.id} className="mf-sub">#{x.expenseId}</span>)}{!disabled && <button type="button" className="link" onClick={link}>結ぶ</button>}</td>
    </tr>
  );
}

function OrderForm({partners, labels, onSave}) {
  const blank = {item: '', spec: '', qty: '', unitPrice: ''};
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({poKind: 'manufacture', partnerId: '', partnerLabel: '', deliverTo: '', dueOn: '', note: ''});
  const [lines, setLines] = useState([blank]);
  const set = (key) => (event) => setForm({...form, [key]: event.target.value});
  const setLine = (i, key) => (event) => setLines(lines.map((l, j) => (j === i ? {...l, [key]: event.target.value} : l)));
  // 入れかけの行は合計に入れない（読めない額を0にしない）。銭の整数で足し、1円で割り切れないときは合計を出さない
  const total = useMemo(() => {
    let x100 = 0;
    for (const l of lines) {
      const qty = /^\d+$/.test(String(l.qty).trim()) ? Number(l.qty) : null;
      const price = priceToX100(l.unitPrice);
      if (qty == null || price == null) continue;
      x100 += qty * price;
    }
    return x100 % 100 === 0 ? x100 / 100 : null;
  }, [lines]);
  if (!open) return <p><button type="button" className="pri" onClick={() => setOpen(true)}>発注書を作る</button></p>;
  return (
    <form className="mf-form wide" onSubmit={(e) => { e.preventDefault(); onSave({...form, partnerId: form.partnerId ? Number(form.partnerId) : null, lines}); setOpen(false); setLines([blank]); }}>
      <label>種類<select value={form.poKind} onChange={set('poKind')}>{Object.entries(labels.poKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>取引先<select value={form.partnerId} onChange={set('partnerId')}><option value="">（登録していない）</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {!form.partnerId && <label>会社名<input value={form.partnerLabel} onChange={set('partnerLabel')} /></label>}
      <label>納品先<input value={form.deliverTo} onChange={set('deliverTo')} /></label>
      <label>納期<input type="date" value={form.dueOn} onChange={set('dueOn')} /></label>
      <table className="mf-table">
        <thead><tr><th>品目</th><th>仕様</th><th className="n">数量</th><th className="n">単価（円）</th><th></th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><input value={l.item} onChange={setLine(i, 'item')} aria-label="品目" /></td>
              <td><input value={l.spec} onChange={setLine(i, 'spec')} aria-label="仕様" /></td>
              <td><input className="n" value={l.qty} onChange={setLine(i, 'qty')} inputMode="numeric" /></td>
              <td><input className="n" value={l.unitPrice} onChange={setLine(i, 'unitPrice')} inputMode="decimal" /></td>
              <td>{lines.length > 1 && <button type="button" className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>}</td>
            </tr>
          ))}
          <tr><td colSpan={3}><button type="button" className="link" onClick={() => setLines([...lines, blank])}>＋ 行</button></td><td className="n">{yen(total)}</td><td></td></tr>
        </tbody>
      </table>
      <button type="submit" className="pri">発注書を作る</button><button type="button" onClick={() => setOpen(false)}>やめる</button>
    </form>
  );
}
