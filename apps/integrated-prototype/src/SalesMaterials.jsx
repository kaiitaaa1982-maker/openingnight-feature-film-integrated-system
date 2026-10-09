// 営業資料。作品・営業案件・取引先から、版を固定した営業資料を作る。
// - 作品概要とタイトルは作品マスタ（キャッチ・あらすじ・クレジット・尺）から下書きし、自由に書き換えられる。
// - 作る前に「内容を確認」で仕上がりを見られる。保存済みの版は日本時間で表示し、版の識別情報（ハッシュ）は詳細の折りたたみへ。
// - 「この版から新しい版を作る」で保存済みの版の内容を入力欄へ戻し、直して次の版として保存する。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {FormField} from './ui/FormField.jsx';
import {Notice} from './ui/Notice.jsx';
import {VERBS} from './ui/labels.mjs';
import {dateTimeJst} from './ui/format.mjs';
import {materialDraft, materialFromVersion} from './sales-ops/sales-catalog-model.mjs';
import './reports/reports.css';
import './sales-ops/sales-ops.css';

const EMPTY = {opportunityId: '', productId: '', title: '', synopsis: '', pitch: '', terms: ''};

const MATERIAL_COLUMNS = [
  {key: 'title', label: '資料タイトル', type: 'text', sticky: true},
  {key: 'partner_name', label: '提案先', type: 'text'},
  {key: 'opportunity_name', label: '営業案件', type: 'text'},
  {key: 'product', label: '商品', type: 'text', value: (row) => row.product_name || '商品未指定'},
  {key: 'version', label: '版', type: 'text', value: (row) => `第${row.version_no}版`},
  {key: 'created_at', label: '作成日時', type: 'datetime'},
];

function Preview({values, partnerName, productName, workTitle, versionText, createdAt}) {
  return (
    <article className="so-preview" aria-label="営業資料の内容">
      <h3>{values.title || '（資料タイトル未入力）'}</h3>
      <dl>
        <div><dt>作品</dt><dd>{workTitle || '未確認'}</dd></div>
        <div><dt>提案先</dt><dd>{partnerName || '未選択'}</dd></div>
        <div><dt>商品</dt><dd>{productName || '作品提案・商品未指定'}</dd></div>
        <div><dt>版</dt><dd>{versionText}</dd></div>
        {createdAt && <div><dt>作成日時</dt><dd>{dateTimeJst(createdAt)}</dd></div>}
      </dl>
      <h4>作品概要</h4>
      <p>{values.synopsis || '（未入力）'}</p>
      <h4>提案内容</h4>
      <p>{values.pitch || '（未入力）'}</p>
      <h4>提示条件</h4>
      <p>{values.terms || '（未入力）'}</p>
      <p className="rp-muted">すべて架空の試作資料です。正式な契約・承認・外部への送信は行いません。</p>
    </article>
  );
}

function useUnsaved(dirty, label) {
  const shell = useShell();
  const id = `sm${useId().replace(/:/g, '')}`;
  const register = shell.registerUnsaved;
  useEffect(() => { register?.(id, dirty ? 1 : 0, label); }, [dirty, id, label, register]);
  useEffect(() => () => register?.(id, 0, label), [id, register]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function SalesMaterials({data, request: requestProp}) {
  const shell = useShell();
  const requestRef = useRef(null);
  requestRef.current = requestProp || shell.request;
  const request = useCallback((path, options) => requestRef.current(path, options), []);
  const readOnly = Boolean(shell.readOnly);
  const workId = data.selectedWorkId;
  const work = data.selectedWork || data.works?.find((item) => item.id === workId);
  const [state, setState] = useState({loading: true, workId});
  const [revision, setRevision] = useState(0);
  const [loadNonce, setLoadNonce] = useState(0);
  const [values, setValues] = useState(EMPTY);
  const [auto, setAuto] = useState({title: '', synopsis: ''});
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [replaceAsk, setReplaceAsk] = useState(false);
  const [printHtml, setPrintHtml] = useState('');
  const formRef = useRef(null);
  const frameRef = useRef(null);
  const printPending = useRef(false);

  useEffect(() => {
    let live = true;
    setState({loading: true, workId});
    setValues(EMPTY);
    setAuto({title: '', synopsis: ''});
    setErrors({});
    setShowPreview(false);
    if (!workId) { setState({loading: false, workId}); return undefined; }
    Promise.all([
      request(`/sales-materials?workId=${workId}`),
      request('/opportunities'),
      request('/work-catalog').catch(() => null),
    ]).then(([materials, opportunities, catalog]) => {
      if (!live) return;
      const own = (opportunities.rows || []).filter((row) => row.work_id === workId);
      const catalogWork = (catalog?.works || []).find((item) => item.id === workId) || null;
      setState({workId, rows: materials.rows || [], opportunities: own, profile: catalogWork?.profile || null});
    }).catch((error) => { if (live) setState({workId, error}); });
    return () => { live = false; };
  }, [workId, request, loadNonce]);

  useEffect(() => {
    if (!revision || !workId) return undefined;
    let live = true;
    request(`/sales-materials?workId=${workId}`).then((materials) => {
      if (live) setState((previous) => (previous.workId === workId ? {...previous, rows: materials.rows || []} : previous));
    }).catch((error) => { if (live) setNotice({error}); });
    return () => { live = false; };
  }, [revision, workId, request]);

  const loaded = state.workId === workId && !state.loading && !state.error;
  const opportunities = loaded ? state.opportunities : [];
  const partnerOf = useCallback((opportunity) => (data.partners || []).find((partner) => partner.id === opportunity?.partner_id)?.name || '', [data.partners]);
  const productIds = new Set((data.productAllocations || []).filter((row) => row.work_id === workId).map((row) => row.product_id));
  const products = (data.products || []).filter((row) => productIds.has(row.id));
  const opportunity = opportunities.find((row) => String(row.id) === values.opportunityId);
  const draft = useMemo(() => (loaded ? materialDraft({work, profile: state.profile, partnerName: partnerOf(opportunity)}) : null),
    [loaded, work, state.profile, partnerOf, opportunity]);

  // 読み込んだら最初の営業案件を選び、作品マスタから下書きを入れる
  useEffect(() => {
    if (!loaded) return;
    const first = state.opportunities[0];
    const initial = materialDraft({work, profile: state.profile, partnerName: partnerOf(first)});
    setValues({...EMPTY, opportunityId: first ? String(first.id) : '', title: initial.title, synopsis: initial.synopsis});
    setAuto({title: initial.title, synopsis: initial.synopsis});
  }, [loaded, state.opportunities]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = Boolean(values.pitch || values.terms || (values.title && values.title !== auto.title) || (values.synopsis && values.synopsis !== auto.synopsis));
  useUnsaved(dirty, '営業資料の入力');

  function set(key) {
    return (value) => {
      // 営業案件を変えたら、書き換えていないタイトルだけ提案先に合わせて作り直す
      if (key === 'opportunityId' && values.title === auto.title) {
        const chosen = opportunities.find((row) => String(row.id) === value);
        const title = materialDraft({work, profile: state.profile, partnerName: partnerOf(chosen)}).title;
        setValues((previous) => ({...previous, opportunityId: value, title}));
        setAuto((current) => ({...current, title}));
      } else {
        setValues((previous) => ({...previous, [key]: value}));
      }
      setErrors((previous) => ({...previous, [key]: undefined}));
    };
  }

  function applyDraft(force = false) {
    if (!draft) return;
    if (!force && values.synopsis && values.synopsis !== auto.synopsis) { setReplaceAsk(true); return; }
    setValues((previous) => ({...previous, synopsis: draft.synopsis}));
    setAuto((current) => ({...current, synopsis: draft.synopsis}));
    setReplaceAsk(false);
  }

  function fromVersion(row) {
    const next = materialFromVersion(row);
    setValues(next);
    setAuto({title: '', synopsis: ''});
    setErrors({});
    setShowPreview(false);
    setNotice({tone: 'info', message: `「${row.title}」第${row.version_no}版の内容を入力欄に入れました。直して「営業資料を作成」を押すと、同じ営業案件の次の版として保存します。`});
    formRef.current?.scrollIntoView?.({behavior: 'smooth', block: 'start'});
  }

  async function save(event) {
    event.preventDefault();
    if (saving || readOnly) return;
    const found = {};
    if (!values.opportunityId) found.opportunityId = '営業案件を選んでください';
    for (const [key, label] of [['title', '資料タイトル'], ['synopsis', '作品概要'], ['pitch', '提案内容'], ['terms', '提示条件']]) if (!values[key].trim()) found[key] = `${label}を入力してください`;
    setErrors(found);
    if (Object.keys(found).length) { setNotice({tone: 'error', message: `${Object.keys(found).length}項目を確認してください`}); return; }
    setSaving(true);
    setNotice(null);
    try {
      const result = await request('/sales-materials', {method: 'POST', body: JSON.stringify({workId, opportunityId: Number(values.opportunityId), productId: values.productId ? Number(values.productId) : null,
        title: values.title, synopsis: values.synopsis, pitch: values.pitch, terms: values.terms})});
      setNotice({tone: 'ok', message: `営業資料「${values.title.trim()}」を第${result.versionNo}版として保存しました。`});
      setValues((previous) => ({...previous, pitch: '', terms: ''}));
      setAuto({title: values.title, synopsis: values.synopsis});
      setShowPreview(false);
      setRevision((n) => n + 1);
    } catch (error) {
      setNotice({error});
    } finally {
      setSaving(false);
    }
  }

  async function fetchHtml(row) {
    const response = await request(`/sales-materials/${row.id}/html`, {raw: true});
    return response.text();
  }

  async function printVersion(row) {
    try {
      const html = await fetchHtml(row);
      if (html === printHtml && frameRef.current) { frameRef.current.contentWindow?.print(); return; }
      printPending.current = true;
      setPrintHtml(html);
    } catch (error) {
      setNotice({error});
    }
  }

  async function downloadVersion(row) {
    try {
      const html = await fetchHtml(row);
      const url = URL.createObjectURL(new Blob([html], {type: 'text/html;charset=utf-8'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = `営業資料_${String(row.title).replace(/[\\/:*?"<>|]/g, '_')}_第${row.version_no}版.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setNotice({error});
    }
  }

  if (!workId) return <section className="card"><p className="rp-muted">作品を選ぶと、その作品の営業資料が表示されます。</p></section>;
  if (state.error) return <section className="card"><Notice error={state.error} onRetry={() => setLoadNonce((n) => n + 1)} /></section>;
  if (!loaded) return <section className="card"><p className="rp-muted" aria-busy="true">営業資料を読み込んでいます…</p></section>;

  const productName = products.find((row) => String(row.id) === values.productId)?.name;
  const nextVersion = state.rows.filter((row) => String(row.opportunity_id) === values.opportunityId).reduce((max, row) => Math.max(max, row.version_no), 0) + 1;

  return (
    <div className="so-page sales-materials">
      <section className="card so-section" ref={formRef} aria-label="新しい営業資料">
        <header className="so-head">
          <div>
            <h2>営業資料を作る（{work?.title || '選択中の作品'}）</h2>
            <p className="rp-muted">作品マスタの内容から作品概要を下書きします。自由に書き換えてから、版を固定して保存します。すべて架空の試作で、正式な契約・外部への送信は行いません。</p>
          </div>
          <button type="button" className="secondary" onClick={() => shell.navigate('営業作品一覧')}>流通別の販売条件を見る</button>
        </header>
        {!opportunities.length ? (
          <Notice tone="info" message="先にこの作品の営業案件を登録してください。営業資料は営業案件（提案先）ごとに版を重ねます。"
            actions={<button type="button" className="secondary" onClick={() => shell.navigate('商品・営業', {view: 'work'})}>商品・営業を開く</button>} />
        ) : (
          <form className="so-form" onSubmit={save} noValidate aria-label="営業資料の入力">
            {draft && !draft.hasProfile && (
              <Notice tone="info" compact message="作品マスタにキャッチコピー・あらすじが未登録のため、作品概要は空欄です。作品・商品マスタで登録すると、ここに下書きが入ります。"
                actions={<button type="button" className="secondary" onClick={() => shell.navigate('作品・商品マスタ')}>作品・商品マスタを開く</button>} />
            )}
            <fieldset className="on-form-grid" disabled={saving || readOnly}>
              <FormField type="select" label="営業案件（提案先）" required value={values.opportunityId} onChange={set('opportunityId')} error={errors.opportunityId}
                options={opportunities.map((row) => ({value: String(row.id), label: `${row.name}｜${partnerOf(row) || '取引先未確認'}`}))}
                hint={values.opportunityId ? `この営業案件の第${nextVersion}版として保存します` : undefined} />
              <FormField type="select" label="商品" value={values.productId} onChange={set('productId')} blankLabel="作品提案・商品未指定"
                options={products.map((row) => ({value: String(row.id), label: `${row.sku}｜${row.name}`}))} />
              <FormField label="資料タイトル" required wide value={values.title} onChange={set('title')} error={errors.title} placeholder="例: 架空配信向けご提案" />
              <FormField type="textarea" label="作品概要" required rows={7} value={values.synopsis} onChange={set('synopsis')} error={errors.synopsis}
                hint={draft?.filled.length ? `作品マスタの${draft.filled.join('・')}から下書きしました。自由に書き換えられます。` : '作品マスタに登録がない項目は空欄です。'} />
              <FormField type="textarea" label="提案内容" required rows={5} value={values.pitch} onChange={set('pitch')} error={errors.pitch} />
              <FormField type="textarea" label="提示条件" required rows={5} value={values.terms} onChange={set('terms')} error={errors.terms}
                placeholder="利用期間・地域・金額は架空の条件として明記" />
            </fieldset>
            {replaceAsk && (
              <div className="so-confirm" role="group" aria-label="作品概要の置き換え">
                <p>入力中の作品概要を、作品マスタの内容で置き換えます。</p>
                <div className="so-actions">
                  <button type="button" onClick={() => applyDraft(true)}>置き換える</button>
                  <button type="button" className="secondary" onClick={() => setReplaceAsk(false)}>いまの入力を残す</button>
                </div>
              </div>
            )}
            {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
            <div className="on-form-actions">
              <button type="submit" disabled={saving || readOnly}>{saving ? '保存中…' : '営業資料を作成（版を固定）'}</button>
              <button type="button" className="secondary" aria-pressed={showPreview} onClick={() => setShowPreview((value) => !value)}>{showPreview ? '確認の表示を閉じる' : VERBS.preview}</button>
              {draft?.hasProfile && <button type="button" className="secondary" disabled={saving || readOnly} onClick={() => applyDraft(false)}>作品マスタから作品概要を下書きし直す</button>}
              {dirty && <button type="button" className="text" disabled={saving} onClick={() => { setValues({...EMPTY, opportunityId: values.opportunityId, title: auto.title, synopsis: auto.synopsis}); setErrors({}); }}>入力を消す</button>}
            </div>
            {showPreview && (
              <Preview values={values} partnerName={partnerOf(opportunity)} productName={productName} workTitle={work?.title} versionText={`第${nextVersion}版（保存前の確認）`} />
            )}
          </form>
        )}
      </section>

      <section className="card so-section" aria-label="保存済みの営業資料">
        <header className="so-head">
          <div>
            <h2>保存済みの営業資料（{state.rows.length}版）</h2>
            <p className="rp-muted">行を押すと内容・印刷・ダウンロードと「この版から新しい版を作る」が開きます。保存した版は変わりません。</p>
          </div>
        </header>
        <DataGrid columns={MATERIAL_COLUMNS} rows={state.rows} rowKey="id" persistKey="sales-materials" showTotals={false} initialSort={{key: 'created_at', dir: 'desc'}}
          emptyText="営業資料はまだありません。"
          renderDetail={(row) => (
            <div className="so-detail">
              <Preview values={{title: row.title, synopsis: row.synopsis, pitch: row.pitch, terms: row.terms_text}} partnerName={row.partner_name} productName={row.product_name}
                workTitle={row.work_title} versionText={`第${row.version_no}版`} createdAt={row.created_at} />
              <div className="so-actions">
                <button type="button" className="secondary" onClick={() => printVersion(row)}>{VERBS.print}</button>
                <button type="button" className="secondary" onClick={() => downloadVersion(row)}>HTMLを{VERBS.download}</button>
                {!readOnly && <button type="button" onClick={() => fromVersion(row)}>この版から新しい版を作る</button>}
              </div>
              <details>
                <summary>版の識別情報</summary>
                <p className="rp-muted">内容のハッシュ（改ざんの確認用）: <code>{row.snapshot_hash}</code></p>
              </details>
            </div>
          )} />
      </section>
      {printHtml && (
        <iframe ref={frameRef} className="so-print-frame" title="印刷用の営業資料" srcDoc={printHtml} aria-hidden="true" tabIndex={-1}
          onLoad={() => { if (printPending.current) { printPending.current = false; frameRef.current?.contentWindow?.print(); } }} />
      )}
    </div>
  );
}
