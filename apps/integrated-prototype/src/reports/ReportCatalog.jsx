// 帳票センター。カード型のカタログから帳票を選び、共通の条件で画面に表示し、同じ数字をExcelで出す。
// 選んだ帳票と条件は URL（report=…）に残るので、戻る・再読込・リンクの共有で同じ帳票が開く。
import React, {useEffect, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {REPORT_CATALOG, reportById, reportsByCategory, featuredReports, DEFAULT_REPORT} from './report-catalog.mjs';
import {REPORT_COMPONENTS} from './registry.jsx';
import {AnnualSalesReport} from './AnnualSalesReport.jsx';
import ReportSalesPanel from '../ReportSalesPanel.jsx';
import {Notice} from '../ui/Notice.jsx';
import {followElement} from './scroll-follow.mjs';
import {fiscalRuleText, fiscalSettingFrom} from '../ui/condition-model.mjs';
import './reports.css';

function FiscalSetting({fiscal, isAdmin, onSaved}) {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(String(fiscal.fiscalStartMonth));
  const [confirmed, setConfirmed] = useState(fiscal.confirmed);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setStart(String(fiscal.fiscalStartMonth)); setConfirmed(fiscal.confirmed); }, [fiscal.fiscalStartMonth, fiscal.confirmed]);
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = await shell.request('/settings/fiscal', {method: 'PUT', body: JSON.stringify({fiscalStartMonth: Number(start), confirmed})});
      onSaved(fiscalSettingFrom(body));
      setOpen(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="rp-fiscal">
      <span>{fiscalRuleText(fiscal.fiscalStartMonth, {confirmed: fiscal.confirmed})}・組織で共通</span>
      {isAdmin && !shell.readOnly && (open ? (
        <form onSubmit={save} className="rp-fiscal-form">
          <label>年度の開始月
            <select value={start} onChange={(event) => setStart(event.target.value)}>
              {Array.from({length: 12}, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}月</option>)}
            </select>
          </label>
          <label className="rp-inline"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 決算月の解釈を確認済み</label>
          <button type="submit" disabled={saving}>{saving ? '保存中…' : '年度の設定を保存'}</button>
          <button type="button" className="text" onClick={() => setOpen(false)}>閉じる</button>
          {error && <Notice error={error} compact />}
        </form>
      ) : <button type="button" className="text" onClick={() => setOpen(true)}>年度の設定を変更</button>)}
    </div>
  );
}

function ReportCard({entry, selected, onSelect}) {
  return (
    <li>
      <button type="button" className={`rp-card${selected ? ' is-selected' : ''}${entry.featured ? ' is-featured' : ''}`} aria-pressed={selected} onClick={() => onSelect(entry)}>
        <span className="rp-card-title">{entry.label}</span>
        <span className="rp-card-desc">{entry.description}</span>
        <span className="rp-card-formats">
          {entry.component === 'link' ? <span className="rp-badge">専用画面</span> : entry.formats.map((format) => <span key={format} className="rp-badge">{format}</span>)}
        </span>
      </button>
    </li>
  );
}

export function ReportCatalog({data, onNavigate, onSwitchOrg}) {
  const shell = useShell();
  const request = shell.request;
  const [fiscal, setFiscal] = useState({fiscalStartMonth: 5, confirmed: false});
  const [distributionTypes, setDistributionTypes] = useState([]);
  const [showAll, setShowAll] = useState(false);
  // カードを押したら、選んだ帳票の位置まで送る（読み込みでページが伸びるたびに送り直す。scroll-follow.mjs）
  const selectedRef = useRef(null);
  const [follow, setFollow] = useState(0);
  useEffect(() => (follow ? followElement(selectedRef.current) : undefined), [follow]);
  const reportId = shell.getParam('report', DEFAULT_REPORT);
  const entry = reportById(reportId);

  useEffect(() => {
    let live = true;
    request('/settings/fiscal').then((body) => live && setFiscal(fiscalSettingFrom(body))).catch(() => {});
    request('/distribution-types').then((body) => live && setDistributionTypes(body.rows || [])).catch(() => {});
    return () => { live = false; };
  }, [request]);

  function select(next) {
    if (next.component === 'link') {
      onNavigate?.(next.page);
      return;
    }
    shell.setParam('report', next.id, {replace: false});
    if (next.component === 'annual' && next.axis) shell.setParam('axis', next.axis === 'total' ? null : next.axis);
    setShowAll(false);
    setFollow((n) => n + 1);
  }

  const reportData = {...data, distributionTypes};
  const Custom = REPORT_COMPONENTS[entry.component];
  let body;
  if (entry.component === 'annual') {
    body = <AnnualSalesReport key={entry.id} data={reportData} fiscal={fiscal} defaultAxis={entry.axis || 'total'} title={entry.label} onNavigate={onNavigate} />;
  } else if (Custom) {
    body = <Custom key={entry.id} data={reportData} request={request} fiscal={fiscal} entry={entry} onNavigate={onNavigate} onSwitchOrg={onSwitchOrg} />;
  } else {
    body = <ReportSalesPanel key={entry.id} data={data} request={request} onNavigate={onNavigate} initialMode={entry.legacyMode} embedded />;
  }

  const groups = reportsByCategory(REPORT_CATALOG);
  return (
    <div className="stack rp-center">
      <section className="card rp-intro">
        <div className="rp-intro-head">
          <div>
            <h2>帳票を選ぶ</h2>
            <p className="rp-muted">カードを選ぶと、下に条件と画面プレビューが出ます。画面の数字とExcelの数字は同じ明細から作ります。</p>
          </div>
          <FiscalSetting fiscal={fiscal} isAdmin={data?.currentUser?.role === 'admin'} onSaved={setFiscal} />
        </div>
        <h3 className="rp-group-title">よく使う帳票</h3>
        <ul className="rp-cards rp-cards-featured">
          {featuredReports().map((item) => <ReportCard key={item.id} entry={item} selected={item.id === entry.id} onSelect={select} />)}
        </ul>
        <button type="button" className="secondary rp-toggle" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'すべての帳票を閉じる' : `すべての帳票（${REPORT_CATALOG.length}種類）を見る`}
        </button>
        {showAll && groups.map((group) => (
          <div key={group.id} className="rp-group">
            <h3 className="rp-group-title">{group.label}</h3>
            <ul className="rp-cards">
              {group.reports.map((item) => <ReportCard key={item.id} entry={item} selected={item.id === entry.id} onSelect={select} />)}
            </ul>
          </div>
        ))}
      </section>
      <div id="rp-selected" className="rp-selected" ref={selectedRef}>
        <p className="rp-crumb">表示中: <strong>{entry.label}</strong>{!entry.featured && !showAll && <button type="button" className="text" onClick={() => setShowAll(true)}>ほかの帳票を選ぶ</button>}</p>
        {body}
      </div>
    </div>
  );
}

export default ReportCatalog;
