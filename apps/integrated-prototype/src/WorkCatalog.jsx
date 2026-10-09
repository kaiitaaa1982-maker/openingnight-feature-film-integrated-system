// 作品・商品マスタ。上に「作品×商品」の一覧（検索語は URL に残す）、下に選んだ作品の詳細
// （作品情報・放送ウィンドウ・販売ウィンドウ・改訂履歴。選んだタブも URL に残し、作品を切り替えても消えない）。
// 新しい作品・商品はここから登録する（「＋新規作品」「＋新規商品」）。内部の番号は詳細の折りたたみにだけ出す。
// 放送局は番販・放送の放送枠から引く。日時は日本時間で表示する。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {broadcastEntries, broadcastStatus, monthCell, validDate} from './broadcast-window-model.mjs';
import './broadcast-window.css';
import './production-ui.css';
import {useShell} from './shell/context.mjs';
import {Tabs} from './ui/Tabs.jsx';
import {Notice} from './ui/Notice.jsx';
import {RecordForm} from './ui/RecordForm.jsx';
import {labelOf, optionsOf} from './ui/labels.mjs';
import {dateJst, dateTimeJst} from './ui/format.mjs';
import {ProposalProfileForm} from './work/ProposalProfileForm.jsx';
import {WorkMasterFields} from './master-extensions/WorkMasterFields.jsx';
import {ProductMasterFields} from './master-extensions/ProductMasterFields.jsx';
import {
  CATALOG_TABS, CATALOG_PARAMS, catalogTab, catalogRows, workCount, filterWorks, jstToday, windowState, parseYear, parseMonthNumber,
  monthBounds, stationsFor, stationText, distributionGroups, distributionLabel, profileChanged,
} from './work/catalog-model.mjs';

const ROLES = {director: '監督', writer: '脚本', cast: '出演者', staff: 'スタッフ'};
const blankProfile = () => ({baseRevision: 0, synopsis_long: '', synopsis_short: '', catch_long: '', catch_short: '', production_year: '', creation_year: '', source_reference: '', credits: [], editions: [], bindings: []});
const blankWindow = (workId) => ({work_id: workId, product_id: '', distribution_code: '', territory: '', window_key: '標準', baseRevision: 0, release_on: '', sales_end_on: '', terms_text: '', source_reference: '', status: 'draft'});
const show = (value) => (value == null || value === '' ? '未登録' : value);
const showDate = (value) => (value ? dateJst(value) : '未確認');

function Field({label, value, onChange, type = 'text', hint}) {
  return (
    <label>{label}
      {type === 'textarea' ? <textarea rows={3} value={value ?? ''} onChange={(event) => onChange(event.target.value)} /> : <input type={type} step={type === 'number' ? 'any' : undefined} value={value ?? ''} onChange={(event) => onChange(event.target.value)} />}
      {hint && <small className="on-field-hint">{hint}</small>}
    </label>
  );
}

// URL の条件（戻る・再読込・作品の切替で残す）。外枠が無いときは手元の状態で動く。
function useParamState(shell, key, fallback) {
  const [local, setLocal] = useState(fallback);
  const fromUrl = shell.getParam(key, null);
  const value = fromUrl ?? local;
  const set = (next) => {
    setLocal(next);
    shell.setParam(key, next === fallback || next === null || next === '' ? null : String(next), {replace: true});
  };
  return [value, set];
}

// 放送ウィンドウ（作品×月）。検索・流通・年・月は URL に残す。セルを押すと、その作品を選んで条件の詳細と放送局を出す。
function BroadcastMatrix({shell, catalog, selectedWorkId, onSelect, onEdit, onNew, slots, slotsError}) {
  const today = new Date();
  const [searchParam, setSearch] = useParamState(shell, CATALOG_PARAMS.matrixQuery, '');
  const [flow, setFlow] = useParamState(shell, CATALOG_PARAMS.flow, 'all');
  const [yearParam, setYear] = useParamState(shell, CATALOG_PARAMS.year, String(today.getFullYear()));
  const [monthParam, setMonth] = useParamState(shell, CATALOG_PARAMS.month, String(today.getMonth() + 1));
  const search = searchParam || '';
  const year = parseYear(yearParam, today.getFullYear());
  const month = parseMonthNumber(monthParam, today.getMonth() + 1);
  const [yearText, setYearText] = useState(String(year));
  useEffect(() => { setYearText(String(year)); }, [year]);
  const broadcastTypes = (catalog.types || []).filter((type) => type.distribution_name === '放送');
  const entries = broadcastEntries(catalog).filter((row) => flow === 'all' || row.distribution_code === flow);
  const productsById = new Map((catalog.products || []).map((product) => [product.id, product]));
  const filtered = filterWorks(catalog.works, search);
  const chosenWorkId = filtered.some((work) => work.id === selectedWorkId) ? selectedWorkId : filtered[0]?.id ?? null;
  const currentWork = (catalog.works || []).find((work) => work.id === chosenWorkId);
  const current = currentWork ? monthCell(entries, currentWork.id, year, month) : {entries: [], count: 0, sameMonthOverlap: false};
  const undated = entries.filter((row) => row.work_id === chosenWorkId && row.status !== 'withdrawn' && (!validDate(row.release_on) || !validDate(row.sales_end_on) || row.release_on > row.sales_end_on));
  const typeLabel = (code) => distributionLabel(catalog.types, code);
  const bounds = monthBounds(year, month);
  const stationLine = (row) => {
    if (slotsError) return '放送枠を読み込めませんでした';
    // 条件の期間と表示中の月が重なる範囲の放送枠（期間が未確認の条件は月だけで見る）
    const from = validDate(row.release_on) && row.release_on > bounds.from ? row.release_on : bounds.from;
    const to = validDate(row.sales_end_on) && row.sales_end_on < bounds.to ? row.sales_end_on : bounds.to;
    const stations = stationsFor(slots || [], {workId: row.work_id, from, to});
    return stationText(stations, {loaded: slots !== null});
  };
  const detail = (row) => (
    <article className="broadcast-detail" key={`${row.scope}:${row.id}`}>
      <h4>{row.scope === 'product' ? '商品別条件' : '作品共通条件'}・{typeLabel(row.distribution_code)}・{broadcastStatus(row)}</h4>
      <dl>
        <div><dt>対象商品</dt><dd>{row.scope === 'product' ? `${productsById.get(row.product_id)?.sku || '商品コード未確認'} ${productsById.get(row.product_id)?.name || ''}`.trim() : '作品全体（商品への適用は未確認）'}</dd></div>
        <div><dt>期間</dt><dd>{showDate(row.release_on)} 〜 {showDate(row.sales_end_on)}（両端を含む）</dd></div>
        <div><dt>放送局（放送枠）</dt><dd className="wc-station">{stationLine(row)}</dd></div>
        <div><dt>地域／枠</dt><dd>{show(row.territory)} / {show(row.window_key)}</dd></div>
        <div><dt>条件</dt><dd>{show(row.terms_text)}</dd></div>
        <div><dt>根拠</dt><dd>{show(row.source_reference)}</dd></div>
      </dl>
      {row.scope === 'product' && currentWork?.canEdit && currentWork.id === selectedWorkId && !shell.readOnly && <button type="button" className="secondary" onClick={() => onEdit(row)}>この条件の新しい版を作る</button>}
    </article>
  );
  function pick(workId, targetMonth) {
    setMonth(String(targetMonth));
    if (workId !== selectedWorkId) onSelect?.(workId);
  }
  return (
    <section className="broadcast-window" aria-label="放送ウィンドウ一覧">
      <div className="broadcast-head">
        <h3>放送ウィンドウ（作品×月）</h3>
        <span className="bc-action-buttons">
          <button type="button" className="secondary" onClick={() => shell.navigate('番販・放送', {tab: 'history'})}>全作品の放送履歴表を開く</button>
          <button type="button" className="secondary" onClick={() => shell.navigate('番販・放送', {tab: 'proposals'}, selectedWorkId ? {workId: selectedWorkId} : {})}>この作品の放送ウィンドウ提案を開く</button>
        </span>
      </div>
      <p className="wc-note">期間の両端を含めて表示します。同じ月に複数の条件があるときは確認が必要です。作品共通の条件を商品別の条件としては扱いません。</p>
      <div className="broadcast-controls">
        <label>作品を検索<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="作品名・作品コード（かな・全角半角を区別しません）" /></label>
        <label>放送の流通<select value={flow} onChange={(event) => setFlow(event.target.value)}><option value="all">すべて</option>{broadcastTypes.map((type) => <option key={type.code} value={type.code}>{typeLabel(type.code)}</option>)}</select></label>
        <label>表示年<input type="number" inputMode="numeric" min="1900" max="9999" value={yearText} onChange={(event) => { setYearText(event.target.value); const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1900 && value <= 9999) setYear(String(value)); }} /></label>
      </div>
      <p className="broadcast-legend">● {labelOf('availabilityStatus', 'confirmed')}　○ {labelOf('availabilityStatus', 'draft')}　! 同じ月に複数の条件　— 該当する条件なし</p>
      <div className="broadcast-scroll">
        <table className="broadcast-matrix">
          <caption>{year}年の放送条件。セルを押すと、その月の条件と放送局を下に表示します。</caption>
          <thead><tr><th scope="col">作品</th>{Array.from({length: 12}, (_, n) => <th scope="col" key={n}>{n + 1}月</th>)}</tr></thead>
          <tbody>
            {filtered.map((work) => (
              <tr key={work.id}>
                <th scope="row">{work.title}<small>{work.code}</small></th>
                {Array.from({length: 12}, (_, n) => {
                  const cellMonth = n + 1, cell = monthCell(entries, work.id, year, cellMonth), active = chosenWorkId === work.id && month === cellMonth;
                  const label = cell.status === 'overlap' ? `複数 ${cell.count}件` : cell.status === 'confirmed' ? labelOf('availabilityStatus', 'confirmed') : cell.status === 'draft' ? labelOf('availabilityStatus', 'draft') : '該当なし';
                  return (
                    <td key={cellMonth}>
                      <button type="button" className={`broadcast-cell broadcast-${cell.status}${active ? ' is-selected' : ''}`} aria-pressed={active} aria-label={`${work.title} ${year}年${cellMonth}月：${label}`} onClick={() => pick(work.id, cellMonth)}>
                        {cell.status === 'overlap' ? `! ${cell.count}` : cell.status === 'confirmed' ? '●' : cell.status === 'draft' ? '○' : '—'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={13}>該当する作品はありません。検索語を変えてください。</td></tr>}
          </tbody>
        </table>
      </div>
      {currentWork && (
        <section className="broadcast-selection" aria-live="polite">
          <h3>{currentWork.title}・{year}年{month}月</h3>
          {slotsError && <Notice error={slotsError} compact />}
          {currentWork.canEdit && !shell.readOnly && <button type="button" className="secondary" onClick={() => onNew(currentWork.id)}>商品別の放送条件を登録</button>}
          {current.sameMonthOverlap && <p className="broadcast-caution">同じ月に{current.count}件あります。契約上の競合かどうかは条件と根拠を確認してください。</p>}
          {current.entries.length ? current.entries.map(detail) : <p className="wc-note">この月に当たる、日付の確定した条件はありません。</p>}
          {undated.length > 0 && <><h4>期間が未確認の条件</h4>{undated.map(detail)}</>}
        </section>
      )}
    </section>
  );
}

function HistoryProfile({profile}) {
  return (
    <section className="card">
      <h3>第{profile.revision}版の作品情報</h3>
      <dl>
        {[['synopsis_long', 'あらすじ・ロング'], ['synopsis_short', 'あらすじ・ショート'], ['catch_long', 'キャッチコピー・ロング'], ['catch_short', 'キャッチコピー・ショート'], ['production_year', '製作年'], ['creation_year', '制作年'], ['source_reference', '出所・改訂理由']].map(([key, label]) => (
          <div key={key}><dt>{label}</dt><dd className="catalog-history">{show(profile[key])}</dd></div>
        ))}
      </dl>
      <h4>クレジット</h4>
      {profile.credits.length ? profile.credits.map((credit, n) => <p key={n}>{ROLES[credit.role] || '役割未確認'}：{credit.name} {credit.detail}</p>) : <p className="wc-note">クレジットは未登録です。</p>}
      <h4>映像版</h4>
      {profile.editions.length ? profile.editions.map((edition) => (
        <article key={edition.edition_key}>
          <strong>{edition.name}</strong>
          <p>{edition.runtime_seconds ? `${edition.runtime_seconds / 60}分` : '分数未確認'} / {show(edition.aspect_ratio)} / {show(edition.rating_authority)} {show(edition.rating_code)}</p>
          <p>制作国：{edition.country.join('、') || '未確認'} ／ 言語：{edition.language.join('、') || '未確認'} ／ 音楽著作権管理団体：{edition.music_society.join('、') || '未確認'}</p>
        </article>
      )) : <p className="wc-note">映像版は未登録です。</p>}
    </section>
  );
}

export default function WorkCatalog({request: requestProp, data, onSelect, reload}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const role = data.currentUser?.role;
  const selectedWorkId = data.selectedWorkId;
  const [result, setResult] = useState(null), [loadError, setLoadError] = useState(null), [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(blankProfile), [draftBase, setDraftBase] = useState(blankProfile);
  const [windowDraft, setWindowDraft] = useState(() => blankWindow(selectedWorkId)), [windowBase, setWindowBase] = useState(() => blankWindow(selectedWorkId));
  const [history, setHistory] = useState(null), [historyError, setHistoryError] = useState(null);
  const [asOf, setAsOf] = useState(jstToday());
  const [slots, setSlots] = useState(null), [slotsError, setSlotsError] = useState(null);
  const [queryParam, setQuery] = useParamState(shell, CATALOG_PARAMS.query, '');
  const [tabParam, setTab] = useParamState(shell, CATALOG_PARAMS.tab, 'details');
  const query = queryParam || '';
  const tab = catalogTab(tabParam);
  const loadNo = useRef(0);
  // 読み直しで作品情報の下書きを消さないための記録（どの作品の下書きか・未保存の修正があるか）
  const draftWorkRef = useRef(null);
  const draftDirtyRef = useRef(false);

  async function load({reset = false} = {}) {
    const n = ++loadNo.current;
    try {
      const body = await request('/work-catalog');
      if (n !== loadNo.current) return;
      setResult(body);
      setLoadError(null);
      const profile = body.works.find((work) => work.id === selectedWorkId)?.profile;
      const next = profile ? {...profile, baseRevision: profile.revision} : blankProfile();
      // 同じ作品の下書きに未保存の修正があれば残す（商品・作品の登録で読み直しても消えない）。保存の直後と作品の切替では入れ直す
      const keep = !reset && draftWorkRef.current === selectedWorkId && draftDirtyRef.current;
      if (!keep) {
        setDraft(next);
        setDraftBase(next);
      }
      draftWorkRef.current = selectedWorkId;
    } catch (error) {
      if (n === loadNo.current) setLoadError(error);
    }
  }
  // 作品の切替と、作品・商品の件数の変化（登録・一括登録）で読み直す。タブと検索語は URL にあるので消えない
  useEffect(() => {
    load();
  }, [selectedWorkId, data.works?.length, data.products?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // 販売条件の入力と改訂履歴は、作品を切り替えたときだけ空にする
  useEffect(() => {
    setWindowDraft(blankWindow(selectedWorkId));
    setWindowBase(blankWindow(selectedWorkId));
    setHistory(null);
  }, [selectedWorkId]);

  // 改訂履歴のタブを開いた（URL で開いた場合も）ら読み込む
  const currentWorkRef = useRef(selectedWorkId);
  currentWorkRef.current = selectedWorkId;
  useEffect(() => {
    if (tab !== 'history' || !selectedWorkId || history) return;
    const target = selectedWorkId;
    request(`/work-catalog/${target}/history`)
      .then((body) => { if (currentWorkRef.current === target) { setHistory(body); setHistoryError(null); } })
      .catch((error) => { if (currentWorkRef.current === target) setHistoryError(error); });
  }, [tab, selectedWorkId, history]); // eslint-disable-line react-hooks/exhaustive-deps

  // 放送ウィンドウを開いたら放送枠（局名）を読み込む。制作担当は放送枠を見られないため空で返る
  useEffect(() => {
    if (tab !== 'broadcast' || slots !== null) return;
    request('/broadcast').then((body) => { setSlots(body.slots || []); setSlotsError(null); }).catch((error) => { setSlots([]); setSlotsError(error); });
  }, [tab, slots]); // eslint-disable-line react-hooks/exhaustive-deps

  // 未保存の変更（作品情報の下書き・販売条件の入力）を外枠に登録する
  const draftDirty = profileChanged(draftBase, draft) ? 1 : 0;
  draftDirtyRef.current = draftDirty > 0;
  const windowDirty = JSON.stringify(windowDraft) !== JSON.stringify(windowBase) ? 1 : 0;
  const registerUnsaved = shell.registerUnsaved;
  useEffect(() => { registerUnsaved?.('work-catalog', draftDirty + windowDirty, '作品・商品マスタ'); }, [registerUnsaved, draftDirty, windowDirty]);
  useEffect(() => () => registerUnsaved?.('work-catalog', 0, '作品・商品マスタ'), [registerUnsaved]);

  const rows = useMemo(() => catalogRows(result, query), [result, query]);
  const groups = useMemo(() => distributionGroups(result?.types), [result]);

  if (!result) {
    return loadError
      ? <Notice error={loadError} title="作品マスタを読み込めませんでした" onRetry={load} />
      : <p className="empty">作品マスタを読み込んでいます。</p>;
  }

  const work = result.works.find((item) => item.id === selectedWorkId);
  const products = result.products.filter((product) => product.work_id === selectedWorkId);
  const windows = result.windows.filter((item) => item.work_id === selectedWorkId);
  const workWindows = result.workWindows.filter((item) => item.work_id === selectedWorkId);
  const set = (key, value) => setDraft((current) => ({...current, [key]: value}));
  const canCreate = role !== 'production' && !readOnly;
  const projects = data.projects || [];

  async function save(event) {
    event.preventDefault();
    setNotice(null);
    try {
      await request(`/work-catalog/${work.id}`, {method: 'POST', body: JSON.stringify(draft)});
      await load({reset: true});
      setHistory(null);
      setNotice({tone: 'ok', message: '作品情報を新しい版として保存しました（前の版は改訂履歴に残ります）'});
    } catch (error) {
      setNotice({tone: 'error', error});
    }
  }

  async function saveWindow(event) {
    event.preventDefault();
    setNotice(null);
    try {
      await request('/work-catalog/windows', {method: 'POST', body: JSON.stringify(windowDraft)});
      const revised = windowDraft.baseRevision > 0;
      await load();
      setWindowDraft(blankWindow(work.id));
      setWindowBase(blankWindow(work.id));
      setNotice({tone: 'ok', message: revised ? '商品別の販売条件の新しい版を保存しました' : '商品別の販売条件を登録しました'});
    } catch (error) {
      setNotice({tone: 'error', error});
    }
  }

  function editWindow(row) {
    const next = {...row, baseRevision: row.revision};
    setWindowDraft(next);
    setWindowBase(next);
    setTab('windows');
  }

  const workFields = [
    {name: 'project_id', label: '案件', type: 'select', required: true, options: projects.map((project) => ({value: String(project.id), label: `${project.code} ${project.title}`})), defaultValue: data.selectedWork?.project_id ? String(data.selectedWork.project_id) : ''},
    {name: 'code', label: '作品コード', type: 'text', required: true, placeholder: '例: WRK-2027-01', hint: '登録後のコード・名称の修正は「業務データ編集」で承認して反映します'},
    {name: 'title', label: '作品名', type: 'text', required: true},
    {name: 'format', label: '形式', type: 'select', required: true, options: optionsOf('workFormat'), defaultValue: 'film'},
  ];
  const productFields = [
    {name: 'sku', label: '商品コード', type: 'text', required: true, placeholder: '例: SKU-2027-PKG'},
    {name: 'name', label: '商品名', type: 'text', required: true},
    {name: 'channel', label: '流通の種類', type: 'select', required: true, options: optionsOf('productChannel')},
  ];

  async function createWork(values) {
    const body = await request('/works', {method: 'POST', body: JSON.stringify({...values, project_id: Number(values.project_id)})});
    return body;
  }
  async function afterWorkCreated(body) {
    if (reload) {
      await reload();
      onSelect?.(body.id);
    } else {
      await load();
    }
  }
  async function createProduct(values) {
    if (!work) throw Error('先に作品を選んでください');
    const created = await request('/products', {method: 'POST', body: JSON.stringify(values)});
    try {
      await request('/product-works', {method: 'POST', body: JSON.stringify({productId: created.id, allocations: [{workId: work.id, allocationBps: 10000}], baseAllocations: []})});
    } catch (error) {
      throw Error(`商品「${values.name}」は登録しましたが、作品への割り当てができませんでした（${error.message}）。「商品・営業」の配賦で作品を指定してください`);
    }
    return created;
  }

  const catalogTable = (
    <div className="table-wrap">
      <table className="wc-table">
        <thead><tr>{['作品コード', '作品名', '商品コード', '商品名', '映像版', '分数', '商品別の販売ウィンドウ', '作品情報の版'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {rows.map(({key, work: rowWork, product, edition, windows: rowWindows}) => (
            <tr key={key} className={selectedWorkId === rowWork.id ? 'catalog-selected' : ''} aria-current={selectedWorkId === rowWork.id ? 'true' : undefined}>
              <td>{rowWork.code}</td>
              <td><button type="button" className="text wc-work-name" onClick={() => onSelect?.(rowWork.id)}>{rowWork.title}</button></td>
              <td>{product ? product.sku : '商品未登録'}</td>
              <td>{product?.name || '—'}</td>
              <td>{edition?.name || (product ? '未対応' : '—')}</td>
              <td className="num">{edition?.runtime_seconds ? `${edition.runtime_seconds / 60}分` : product ? '未登録' : '—'}</td>
              <td>{product ? (rowWindows.length ? rowWindows.map((item) => (
                <div key={item.id} className="wc-window">{distributionLabel(result.types, item.distribution_code)}／{item.territory}<small>{showDate(item.release_on)} 〜 {showDate(item.sales_end_on)}・{windowState(item, asOf)}</small></div>
              )) : '未登録') : '—'}</td>
              <td className="num">{rowWork.profile?.revision ? `第${rowWork.profile.revision}版` : '未登録'}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={8} className="empty">{query ? `「${query}」に当たる作品・商品はありません。` : '作品がまだありません。「＋新規作品」から登録します。'}</td></tr>}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="stack work-catalog">
      <section className="card">
        <div className="wc-head">
          <div>
            <h2>作品と商品の一覧</h2>
            <p className="wc-lead">作品名を押すと、その作品の作品情報・放送ウィンドウ・販売ウィンドウを下に開きます。</p>
          </div>
        </div>
        {canCreate && (
          <div className="wc-create">
            <RecordForm mode="create" openLabel="＋新規作品" title="新しい作品を登録" fields={workFields} submitLabel="作品を登録" allowContinue={false}
              successMessage={(body, values) => `作品「${values.title}」を登録しました`} onSubmit={createWork} onSaved={afterWorkCreated} unsavedLabel="新規作品の入力" />
            <RecordForm mode="create" openLabel="＋新規商品" title={work ? `「${work.title}」の商品を登録` : '商品を登録'} fields={productFields} submitLabel="商品を登録" allowContinue
              disabled={!work} disabledReason="先に一覧から作品を選んでください" resetKey={selectedWorkId}
              successMessage={(body, values) => `商品「${values.name}」を登録し、「${work?.title}」に100%割り当てました（複数作品への配賦は「商品・営業」で変更します）`}
              onSubmit={createProduct} onSaved={() => (reload ? reload() : load())} unsavedLabel="新規商品の入力" />
          </div>
        )}
        <div className="wc-search">
          <label>作品・商品を検索<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="作品名・コード・商品名（かな・全角半角・大小を区別しません）" /></label>
          <span aria-live="polite">{workCount(rows)}作品・{rows.filter((row) => row.product).length}商品</span>
          {query && <button type="button" className="text" onClick={() => setQuery('')}>検索を解除</button>}
        </div>
        {catalogTable}
      </section>

      {!work && result.works.length > 0 && <Notice tone="info" message="選択中の作品を表示できません。一覧から作品を選んでください。" />}
      {work && (
        <section className="card">
          <header className="section-head"><h2>{work.title}</h2><span className="count">{work.code}・作品情報 {draft.baseRevision ? `第${draft.baseRevision}版` : '未登録'}</span></header>
          <details className="wc-ids">
            <summary>管理用の番号</summary>
            <p>作品の番号 {work.id}{products.length ? `／商品の番号 ${products.map((product) => `${product.sku}=${product.id}`).join('、')}` : ''}</p>
          </details>
          {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
          <Tabs label="作品マスタの表示" value={tab} onChange={setTab} tabs={CATALOG_TABS.map((item) => ({...item, badge: item.id === 'details' && draftDirty ? '未保存' : item.id === 'windows' && windowDirty ? '未保存' : undefined}))}>
            {(active) => (
              <>
                {active === 'broadcast' && (
                  <BroadcastMatrix shell={shell} catalog={result} selectedWorkId={selectedWorkId} onSelect={onSelect} slots={slots} slotsError={slotsError}
                    onEdit={editWindow} onNew={(workId) => { const next = blankWindow(workId); setWindowDraft(next); setWindowBase(next); setTab('windows'); if (workId !== selectedWorkId) onSelect?.(workId); }} />
                )}
                {active === 'details' && (
                  <form onSubmit={save}>
                    <fieldset disabled={!work.canEdit || readOnly} style={{border: 0, padding: 0, minWidth: 0}}>
                      <div className="grid-form">
                        {[['synopsis_long', 'あらすじ・ロング'], ['synopsis_short', 'あらすじ・ショート'], ['catch_long', 'キャッチコピー・ロング'], ['catch_short', 'キャッチコピー・ショート']].map(([key, label]) => <Field key={key} label={label} type="textarea" value={draft[key]} onChange={(value) => set(key, value)} />)}
                        <Field label="製作年" type="number" value={draft.production_year} onChange={(value) => set('production_year', value)} />
                        <Field label="制作年" type="number" value={draft.creation_year} onChange={(value) => set('creation_year', value)} />
                        <p className="wc-note wide">「製作年」と「制作年」の使い分けは確認中です。分かっている方だけ入れます。</p>
                      </div>
                      <h3>クレジット</h3>
                      <p className="wc-note">氏名は作品上の表記です。同姓同名を自動的に同一人物にまとめません。</p>
                      {draft.credits.map((credit, n) => (
                        <div className="catalog-row" key={n}>
                          <label>役割<select value={credit.role} onChange={(event) => set('credits', draft.credits.map((x, j) => (j === n ? {...x, role: event.target.value} : x)))}>{Object.entries(ROLES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                          <Field label="氏名・表記" value={credit.name} onChange={(value) => set('credits', draft.credits.map((x, j) => (j === n ? {...x, name: value} : x)))} />
                          <Field label="担当・役名" value={credit.detail} onChange={(value) => set('credits', draft.credits.map((x, j) => (j === n ? {...x, detail: value} : x)))} />
                          <button type="button" className="secondary" onClick={() => set('credits', draft.credits.filter((_, j) => j !== n))}>この行を外す</button>
                        </div>
                      ))}
                      <button type="button" className="secondary" onClick={() => set('credits', [...draft.credits, {role: 'staff', name: '', detail: ''}])}>クレジットを追加</button>
                      <h3>映像版・仕様</h3>
                      {draft.editions.map((edition, n) => {
                        const update = (key, value) => set('editions', draft.editions.map((x, j) => (j === n ? {...x, [key]: value} : x)));
                        return (
                          <section className="card" key={n}>
                            <div className="grid-form">
                              <Field label="映像版の識別名（英数字）" value={edition.edition_key} onChange={(value) => update('edition_key', value)} />
                              <Field label="映像版名" value={edition.name} onChange={(value) => update('name', value)} />
                              <Field label="分数（小数可）" type="number" value={edition.runtime_seconds == null ? '' : edition.runtime_seconds / 60} onChange={(value) => update('runtime_seconds', value === '' ? null : Math.round(Number(value) * 60))} />
                              <Field label="画角" value={edition.aspect_ratio} onChange={(value) => update('aspect_ratio', value)} />
                              <Field label="審査機関・地域" value={edition.rating_authority} onChange={(value) => update('rating_authority', value)} />
                              <Field label="審査区分" value={edition.rating_code} onChange={(value) => update('rating_code', value)} />
                              {[['country', '制作国'], ['language', '言語'], ['music_society', '音楽著作権管理団体']].map(([key, label]) => <Field key={key} label={label} hint="複数は読点（、）で区切ります" value={(edition[key] || []).join('、')} onChange={(value) => update(key, value.split(/[、,]/).map((x) => x.trim()))} />)}
                            </div>
                            <button type="button" className="secondary" onClick={() => { set('editions', draft.editions.filter((_, j) => j !== n)); set('bindings', draft.bindings.filter((binding) => binding.edition_key !== edition.edition_key)); }}>この映像版を外す</button>
                          </section>
                        );
                      })}
                      <button type="button" className="secondary" onClick={() => set('editions', [...draft.editions, {edition_key: `edition_${Date.now()}`, name: '', runtime_seconds: null, country: [], language: [], music_society: []}])}>映像版を追加</button>
                      <h3>商品と映像版の対応</h3>
                      {!products.length && <p className="wc-note">この作品の商品はまだありません。上の「＋新規商品」から登録します。</p>}
                      {products.map((product) => (
                        <label key={product.id}>{product.sku}　{product.name}
                          <select value={draft.bindings.find((binding) => binding.product_id === product.id)?.edition_key || ''} onChange={(event) => set('bindings', [...draft.bindings.filter((binding) => binding.product_id !== product.id), ...(event.target.value ? [{product_id: product.id, edition_key: event.target.value}] : [])])}>
                            <option value="">未対応</option>
                            {draft.editions.filter((edition) => edition.edition_key).map((edition, n) => <option key={n} value={edition.edition_key}>{edition.name || edition.edition_key}</option>)}
                          </select>
                        </label>
                      ))}
                      <Field label="作品情報の出所・改訂理由（必須）" value={draft.source_reference} onChange={(value) => set('source_reference', value)} />
                      <div className="on-form-actions">
                        <button>作品情報を新しい版として保存</button>
                        {draftDirty > 0 && <button type="button" className="text" onClick={() => setDraft(draftBase)}>修正をやめる</button>}
                      </div>
                    </fieldset>
                    {!work.canEdit && <p className="wc-note">この役割では作品情報を参照だけできます。</p>}
                  </form>
                )}
                {active === 'details' && <ProposalProfileForm key={work.id} request={request} workId={work.id} readOnly={readOnly} />}
                {active === 'details' && <WorkMasterFields key={`master-${work.id}`} request={request} workId={work.id} readOnly={readOnly} />}
                {active === 'details' && products.map(product => <ProductMasterFields key={`master-product-${product.id}`} request={request} product={product} readOnly={readOnly} />)}
                {active === 'windows' && (
                  <>
                    <Field label="販売期間の確認日" type="date" value={asOf} onChange={(value) => setAsOf(value || jstToday())} />
                    <p className="wc-note">期間内でも、最終の販売判断には契約・独占条件・素材の確認が必要です。作品共通の条件を商品別の確定条件として自動では写しません。</p>
                    <div className="table-wrap">
                      <table className="wc-table">
                        <thead><tr>{['商品コード', '商品名', '流通', '地域／枠', '解禁日', '終了日', '状態', '販売条件', '根拠', '操作'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
                        <tbody>
                          {windows.map((item) => {
                            const product = products.find((p) => p.id === item.product_id);
                            return (
                              <tr key={item.id}>
                                <td>{product?.sku || '未確認'}</td><td>{product?.name || '—'}</td><td>{distributionLabel(result.types, item.distribution_code)}</td><td>{item.territory} / {item.window_key}</td>
                                <td>{showDate(item.release_on)}</td><td>{showDate(item.sales_end_on)}</td><td>{windowState(item, asOf)}</td>
                                <td className="production-wrap">{item.terms_text || '—'}</td><td className="production-wrap">{item.source_reference || '—'}</td>
                                <td>{work.canEdit && !readOnly && <button type="button" className="secondary" onClick={() => editWindow(item)}>新しい版を作る</button>}</td>
                              </tr>
                            );
                          })}
                          {products.filter((product) => !windows.some((item) => item.product_id === product.id)).map((product) => <tr key={`missing:${product.id}`}><td>{product.sku}</td><td>{product.name}</td><td colSpan={8}>商品別の販売条件は未登録</td></tr>)}
                          {!products.length && <tr><td colSpan={10} className="empty">この作品の商品はまだありません。</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    <h3 className="wc-section">作品共通の販売条件</h3>
                    <p className="wc-note">作品共通の条件の登録・修正は「番販・放送」の販売条件で行います。ここでは参照だけです。{role !== 'production' && <button type="button" className="text" onClick={() => shell.navigate?.('番販・放送')}>番販・放送を開く</button>}</p>
                    <div className="table-wrap">
                      <table className="wc-table">
                        <thead><tr>{['流通', '地域', '解禁日', '終了日', '状態', '条件', '根拠'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
                        <tbody>
                          {workWindows.map((item) => <tr key={item.id}><td>{distributionLabel(result.types, item.distribution_code)}</td><td>{item.territory}</td><td>{showDate(item.release_on)}</td><td>{showDate(item.sales_end_on)}</td><td>{windowState(item, asOf)}</td><td className="production-wrap">{item.terms_text || '—'}</td><td className="production-wrap">{item.source_reference || '—'}</td></tr>)}
                          {!workWindows.length && <tr><td colSpan={7} className="empty">作品共通の販売条件はまだありません。</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    {work.canEdit && !readOnly && (
                      <form onSubmit={saveWindow}>
                        <h3 className="wc-section">{windowDraft.baseRevision ? `商品別の販売条件の新しい版（第${windowDraft.baseRevision + 1}版）` : '商品別の販売条件を登録'}</h3>
                        <div className="grid-form">
                          <label>商品<select disabled={windowDraft.baseRevision > 0} value={windowDraft.product_id} onChange={(event) => setWindowDraft({...windowDraft, product_id: event.target.value})}><option value="">選択してください</option>{products.map((product) => <option key={product.id} value={product.id}>{product.sku}　{product.name}</option>)}</select></label>
                          <label>流通<select disabled={windowDraft.baseRevision > 0} value={windowDraft.distribution_code} onChange={(event) => setWindowDraft({...windowDraft, distribution_code: event.target.value})}><option value="">選択してください</option>{groups.map((group) => <optgroup key={group.label} label={group.label}>{group.options.map((option) => <option key={option.value} value={option.value}>{`${group.label}・${option.label}`}</option>)}</optgroup>)}</select></label>
                          {[['territory', '地域', 'text'], ['window_key', '販売枠（再販売などを区別）', 'text'], ['release_on', '解禁日', 'date'], ['sales_end_on', '販売終了日', 'date'], ['terms_text', '販売条件', 'textarea'], ['source_reference', '契約根拠・参照先（必須）', 'text']].map(([key, label, type]) => <Field key={key} label={label} type={type} value={windowDraft[key]} onChange={(value) => setWindowDraft({...windowDraft, [key]: value})} />)}
                          <label>状態<select value={windowDraft.status} onChange={(event) => setWindowDraft({...windowDraft, status: event.target.value})}>{optionsOf('availabilityStatus').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                        </div>
                        <div className="on-form-actions">
                          <button>{windowDraft.baseRevision ? 'この内容で新しい版を保存' : '商品別の販売条件を登録'}</button>
                          {(windowDirty > 0 || windowDraft.baseRevision > 0) && <button type="button" className="text" onClick={() => { const next = blankWindow(work.id); setWindowDraft(next); setWindowBase(next); }}>{windowDraft.baseRevision ? '修正をやめる' : '入力を消す'}</button>}
                        </div>
                      </form>
                    )}
                  </>
                )}
                {active === 'history' && (
                  <>
                    <p className="wc-note">過去の版はそのまま残ります。版を押すと、その版の内容を表示します。</p>
                    {historyError && <Notice error={historyError} onRetry={() => { setHistoryError(null); setHistory(null); }} />}
                    {!history && !historyError && <p className="empty">改訂履歴を読み込んでいます。</p>}
                    {history && !history.versions.length && <p className="empty">作品情報はまだ保存されていません。</p>}
                    <div className="on-form-actions">
                      {history?.versions.map((version) => (
                        <button type="button" className={history.profile?.revision === version.revision ? '' : 'secondary'} key={version.revision}
                          onClick={async () => { try { setHistory(await request(`/work-catalog/${work.id}/history?revision=${version.revision}`)); } catch (error) { setHistoryError(error); } }}>
                          第{version.revision}版・{dateTimeJst(version.created_at)}・{version.source_reference || '理由未記入'}
                        </button>
                      ))}
                    </div>
                    {history?.profile && <HistoryProfile profile={history.profile} />}
                  </>
                )}
              </>
            )}
          </Tabs>
        </section>
      )}
    </div>
  );
}
