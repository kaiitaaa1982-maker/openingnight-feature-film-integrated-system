// 権利先・MG帳票。帳票センターの「製作委員会収支報告」「MG売上・回収現況」からも同じ部品を使う。
// - 選択肢が決まるものは自動で選んで表示する（最新の保存報告・契約が1件ならその契約・最新の条件版）。
// - 数値は右寄せ（.num）、文字の列は左寄せ。権利先別の分配に合計行。MGの作品・商品別は1商品1行の表（DataGrid）。
// - タブは共通の Tabs で、選んだタブを URL に残す。
import React, {useEffect, useMemo, useState} from 'react';
import './RightsReports.css';
import {useShell} from './shell/context.mjs';
import {Tabs} from './ui/Tabs.jsx';
import {DataGrid} from './ui/DataGrid.jsx';
import {Notice} from './ui/Notice.jsx';
import {int, dateJst, dateTimeJst, month as monthText} from './ui/format.mjs';
import {VERBS} from './ui/labels.mjs';
import {exportReport, csvDocument, downloadDocument} from './report-output.mjs';
import {committeeOutputSheets, mgReportSheets} from './rights-report-output.mjs';
import {ProblemNotice} from './CommitteeFinanceFields.jsx';
import {SCREEN_TEXT, periodDateBasisText, percentText, windowKindText, routeText, japaneseMessage} from './rights/rights-ui-model.mjs';
import {latestSnapshotId, mgSelectionDefaults, memberDistributionTable} from './rights/committee-ui-model.mjs';
export {default as RoyaltyReport} from './RoyaltyReport.jsx';

const yenCell = (n) => (n === null || n === undefined ? '未確認' : int(n));
const LABELS = {grossReported: '控除前の報告額', netReported: '控除後の報告額', platformFeeKnown: '把握済みのPF控除', platformNet: 'PF控除後の原資', windowFee: '窓口手数料', managerFee: '幹事手数料', expenseTotal: '経費', royaltyDeductions: '権利処理費の控除', productionRecoupDeductions: '製作費回収の控除', distributionPool: '分配原資', residual: '未配分の端数'};
const PERIODS = {previous: '前回まで', current: '当期', cumulative: '累計'};
const MG_MODES = {single: '単品', cross: 'クロスリクープ', special: '特殊条件・要確認'};
const OUTPUT_TITLES = {income: '製作委員会収支報告書', distribution: '出資者向け分配報告書', history: '損益収支経緯表', royalty: '権利処理費報告書'};
const directionLabel = (direction) => (direction === 'incoming' ? '受取MG（販売先）' : '支払MG（仕入先）');
const CHANNEL_KEYS = ['platformNet', 'windowFee', 'managerFee', 'expenseTotal', 'royaltyDeductions', 'productionRecoupDeductions', 'distributionPool'];

function DraftBanner() {
  return <div className="rr-warning"><strong>下書き・未確認</strong><span>登録済みの情報の集計です。分配額は支払の実績ではありません。</span></div>;
}

function Actions({csv, output}) {
  return (
    <div className="rr-actions">
      <button type="button" className="secondary" onClick={() => output('xlsx')}>{VERBS.excel}</button>
      <button type="button" className="secondary" onClick={csv}>{VERBS.csv}</button>
      <button type="button" className="secondary" onClick={() => output('print')}>{VERBS.print}</button>
      <button type="button" className="secondary" onClick={() => output('html')}>{VERBS.printHtml}</button>
    </div>
  );
}

const Warnings = ({report}) => (report.warnings || []).map((text) => <p className="rr-caution" key={text}>{japaneseMessage(text)}</p>);

export function CommitteeReport({data, request}) {
  const shell = useShell();
  const req = request || shell.request;
  const [outputKind, setOutputKind] = useState('income');
  const [workId, setWorkId] = useState(String(data.selectedWorkId || data.works[0]?.id || ''));
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotId, setSnapshotId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setReport(null); setSnapshots([]); setSnapshotId(''); setRecipient(''); setError(null);
    if (!workId) return undefined;
    setLoading(true);
    req(`/committee/snapshots?workId=${workId}`).then((body) => {
      if (!active) return;
      setSnapshots(body.rows);
      setSnapshotId(latestSnapshotId(body.rows));
    }).catch((cause) => { if (active) setError(cause); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workId, req]);
  // 保存報告と宛先が決まったら表示する（読み取りだけなので確認なしで実行する）
  useEffect(() => {
    let active = true;
    // 前の集計の応答は捨てるので、その「集計中」もここで消す（条件が欠けて集計しないときに残らないように）
    setReport(null); setBusy(false);
    if (!workId || !snapshotId) return undefined;
    setBusy(true);
    setError(null);
    req(`/rights-reports/committee?workId=${workId}&snapshotId=${snapshotId}${recipient ? `&recipientPartnerId=${recipient}` : ''}`)
      .then((body) => { if (active) setReport(body.report); })
      .catch((cause) => { if (active) setError(cause); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [workId, snapshotId, recipient, revision, req]);

  const selected = snapshots.find((row) => String(row.id) === snapshotId);
  const memberIds = [...new Set(snapshots.filter((row) => row.contract_id === selected?.contract_id && row.period_to <= selected.period_to)
    .flatMap((row) => row.calculation.windows.flatMap((window) => window.payouts.map((payout) => payout.partnerId))))];
  const partyName = (id) => data.partners.find((partner) => Number(partner.id) === Number(id))?.name || '名称未登録の権利先';
  const distribution = useMemo(() => (report ? memberDistributionTable(report, partyName) : null), [report]); // eslint-disable-line react-hooks/exhaustive-deps

  function csv() {
    const rows = [];
    const s = report.selected;
    const meta = [s.contractCode, report.work?.title, s.periodFrom, s.periodTo, periodDateBasisText(s.periodDateBasis), dateTimeJst(report.generatedAt), '下書き・未確認', report.recipientPartnerId ? partyName(report.recipientPartnerId) : '全員'];
    for (const [key, label] of Object.entries(LABELS)) rows.push([...meta, '収支', label, ...Object.keys(PERIODS).map((p) => report.totals[p][key])]);
    for (const row of distribution.rows) rows.push([...meta, '出資分配', row.name, row.previous, row.current, row.cumulative]);
    downloadDocument(`権利先収支報告_${s.periodFrom}_${s.periodTo}.csv`, csvDocument([['契約', '作品', '当期の開始', '当期の終了', '期間に含めた売上', '作成日時', '状態', '宛先', '区分', '項目', '前回まで（円）', '当期（円）', '累計（円）'], ...rows]), 'text/csv;charset=utf-8');
  }
  function output(format) {
    try {
      const sheets = committeeOutputSheets(report, outputKind, partyName);
      const filename = `${OUTPUT_TITLES[outputKind]}_${report.selected.periodFrom}_${report.selected.periodTo}`;
      if (format === 'csv' && outputKind === 'income') { csv(); return; }
      exportReport(format, {filename, title: OUTPUT_TITLES[outputKind], subtitle: `${report.work?.title || ''} ／ ${report.selected.periodFrom}〜${report.selected.periodTo} ／ 下書き・未確認`, generatedAt: report.generatedAt, sheets});
    } catch (cause) { setError(cause); }
  }

  return (
    <div className="stack rt-page">
      <section className="card">
        <p className="rt-muted">保存した分配の下書きから、権利先へ説明する収支の比較表を作ります。最新の保存報告を自動で選んで表示します。</p>
        <fieldset disabled={busy} className="rr-controls">
          <label>作品<select value={workId} onChange={(event) => setWorkId(event.target.value)}>{data.works.map((work) => <option key={work.id} value={work.id}>{work.code}｜{work.title}</option>)}</select></label>
          <label>当期の保存報告<select value={snapshotId} onChange={(event) => { setRecipient(''); setSnapshotId(event.target.value); }}>
            <option value="">{snapshots.length ? '選んでください' : '保存報告がありません'}</option>
            {snapshots.map((row) => <option key={row.id} value={row.id}>{dateJst(row.period_from)}〜{dateJst(row.period_to)}｜{row.calculation?.contract?.code || '契約'}（{dateTimeJst(row.created_at)} 保存）</option>)}
          </select></label>
          <label>権利先の表示<select value={recipient} onChange={(event) => setRecipient(event.target.value)}><option value="">出資者全員</option>{memberIds.map((id) => <option key={id} value={id}>{partyName(id)}</option>)}</select></label>
          <button type="button" className="secondary" disabled={!snapshotId || loading || busy} onClick={() => setRevision((value) => value + 1)}>{busy ? '集計中…' : '集計し直す'}</button>
        </fieldset>
        <ProblemNotice error={error} onDismiss={() => setError(null)} />
        {!loading && workId && !snapshots.length && !error && (
          <Notice tone="info" message="保存報告がありません。「製作委員会」で契約条件と期間報告を確認し、下書きとして保存してください。架空の帳票例は作品「架空映画・夜明けの航路」で確認できます。" />
        )}
      </section>
      {report && (
        <article className="card print-target rr-report">
          <header>
            <div>
              <p className="rt-eyebrow">権利先向けの収支報告書</p>
              <h2>{report.work?.title || report.selected.title}</h2>
              <p>{report.selected.contractCode}｜{report.selected.title}</p>
              <p>当期 {dateJst(report.selected.periodFrom)}〜{dateJst(report.selected.periodTo)}｜{report.selected.periodDateBasis === 'sales_period' ? '販売期間で集計' : '報告受領日で集計'}｜円・税抜</p>
              <p>宛先：{report.partialDisplay ? partyName(report.recipientPartnerId) : '出資者全員'}</p>
            </div>
            <div className="stack">
              <label>出力する帳票
                <select value={outputKind} onChange={(event) => setOutputKind(event.target.value)}>
                  <option value="income">製作委員会収支報告</option>
                  <option value="distribution">出資者向け分配報告</option>
                  <option value="history">損益収支経緯表</option>
                  <option value="royalty" disabled={!report.deductions.some((d) => d.category === 'royalty')}>権利処理費報告</option>
                </select>
              </label>
              <Actions csv={() => output('csv')} output={output} />
            </div>
          </header>
          <DraftBanner />
          <Warnings report={report} />
          {report.partialDisplay && <p className="rt-muted">収支は作品全体、分配の欄は選んだ権利先だけの部分表示です。</p>}
          <div className="rr-table">
            <table>
              <thead><tr><th>収支の項目（税抜・円）</th>{Object.values(PERIODS).map((p) => <th key={p} className="num">{p}</th>)}</tr></thead>
              <tbody>{Object.entries(LABELS).map(([key, label]) => (
                <tr key={key} className={key === 'distributionPool' ? 'rr-total' : ''}><th>{label}</th>{Object.keys(PERIODS).map((p) => <td key={p} className="num">{yenCell(report.totals[p][key])}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
          <h3>権利先別の出資分配（円）</h3>
          <p className="rt-muted">窓口手数料・幹事手数料の受取とは別の分配額です。</p>
          <div className="rr-table">
            <table>
              <thead><tr><th>権利先</th>{Object.values(PERIODS).map((p) => <th key={p} className="num">{p}</th>)}</tr></thead>
              <tbody>{distribution.rows.map((row) => <tr key={row.id}><th>{row.name}</th>{Object.keys(PERIODS).map((p) => <td key={p} className="num">{int(row[p])}</td>)}</tr>)}</tbody>
              {distribution.rows.length > 0 && <tfoot><tr><th>合計（{distribution.rows.length}者）</th>{Object.keys(PERIODS).map((p) => <td key={p} className="num">{int(distribution.total[p])}</td>)}</tr></tfoot>}
            </table>
          </div>
          <h3>販路別の前回まで・当期・累計（円）</h3>
          <div className="rr-table">
            <table>
              <thead><tr><th>販路</th><th>項目</th>{Object.values(PERIODS).map((p) => <th key={p} className="num">{p}</th>)}</tr></thead>
              <tbody>{(report.byChannel || []).flatMap((window) => CHANNEL_KEYS.map((key) => (
                <tr key={`${window.kind}-${key}`} className={key === 'distributionPool' ? 'rr-total' : ''}><th>{window.label || windowKindText(window.kind)}</th><th>{LABELS[key]}</th>{Object.keys(PERIODS).map((p) => <td key={p} className="num">{yenCell(window[p][key])}</td>)}</tr>
              )))}</tbody>
            </table>
          </div>
          <h3>当期の窓口別の内訳（円）</h3>
          <div className="rr-table">
            <table>
              <thead><tr><th>窓口</th>{CHANNEL_KEYS.map((key) => <th key={key} className="num">{LABELS[key]}</th>)}<th>分配の経路</th></tr></thead>
              <tbody>{report.details.map((window) => <tr key={window.kind}><th>{window.label || windowKindText(window.kind)}</th>{CHANNEL_KEYS.map((key) => <td key={key} className="num">{yenCell(window[key])}</td>)}<td>{routeText(window.route)}</td></tr>)}</tbody>
              {report.details.length > 1 && (
                <tfoot><tr><th>合計</th>{CHANNEL_KEYS.map((key) => <td key={key} className="num">{int(report.details.reduce((total, window) => total + (Number(window[key]) || 0), 0))}</td>)}<td /></tr></tfoot>
              )}
            </table>
          </div>
          <details>
            <summary>製作費・出資額・回収残高</summary>
            <p>製作費の総額：{yenCell(report.funding?.productionCostYen)}円／回収の累計：{yenCell(report.totals.cumulative.productionRecoupDeductions)}円／残高：{report.funding ? `${int(report.funding.productionCostYen - report.totals.cumulative.productionRecoupDeductions)}円` : '未確認'}</p>
            <div className="rr-table">
              <table>
                <thead><tr><th>出資者</th><th className="num">持分</th><th className="num">出資額（円）</th></tr></thead>
                <tbody>{report.members.map((member) => {
                  const id = member.partner_id ?? member.partnerId;
                  return <tr key={id}><th>{partyName(id)}</th><td className="num">{percentText(member.share_bps ?? member.shareBps)}</td><td className="num">{yenCell(report.funding?.investments.find((item) => item.partnerId === id)?.amountYen)}</td></tr>;
                })}</tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>月次の損益収支の経緯と元の売上</summary>
            <div className="rr-table">
              <table>
                <thead><tr><th>計上月</th><th>窓口</th><th className="num">報告額（円）</th><th className="num">分配原資（円）</th><th className="num">元の売上明細</th><th>明細化の基準</th></tr></thead>
                <tbody>{report.history.map((row) => (
                  <tr key={`${row.snapshotId}-${row.reportId}`}><td>{monthText(row.accountingMonth)}</td><td>{row.label || windowKindText(row.kind)}</td><td className="num">{yenCell(row.reportedAmount)}</td><td className="num">{yenCell(row.distributionPool)}</td><td className="num">{row.saleIds.length}行</td><td>{row.allocationBasis}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </details>
          {report.deductions.length > 0 && (
            <details>
              <summary>権利処理費・製作費回収の受取先</summary>
              <div className="rr-table">
                <table>
                  <thead><tr><th>区分</th><th>受取先</th><th className="num">控除額（円）</th><th>根拠</th></tr></thead>
                  <tbody>{report.deductions.map((row) => <tr key={`${row.snapshotId}-${row.sourceReference}`}><td>{row.category === 'royalty' ? '権利処理費' : '製作費の回収'}</td><td>{partyName(row.recipientPartnerId)}</td><td className="num">{int(row.amountYen)}</td><td>{row.sourceReference}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          )}
          <h3>集計に使った保存報告</h3>
          <div className="rr-table">
            <table>
              <thead><tr><th>対象期間</th><th>締め日</th><th>報告予定日</th><th>支払予定日</th></tr></thead>
              <tbody>{report.sourceSnapshots.map((row) => <tr key={row.snapshotId}><td>{dateJst(row.periodFrom)}〜{dateJst(row.periodTo)}</td><td>{dateJst(row.closeOn)}</td><td>{dateJst(row.reportOn)}</td><td>{dateJst(row.paymentOn)}</td></tr>)}</tbody>
            </table>
          </div>
          <footer>
            作成：{dateTimeJst(report.generatedAt)}｜当期の報告の保存：{dateTimeJst(report.selected.createdAt)}<br />
            当期の売上報告 {report.sourceReports.length}件・当期の経費 {report.sourceExpenses.length}件を集計しています（明細は Excel の「元売上明細」シート）。
          </footer>
        </article>
      )}
    </div>
  );
}

const MG_METRICS = [['eligibleYen', 'MG消化の対象額'], ['appliedYen', '実充当額'], ['overageYen', '超過の報告額'], ['recognizedYen', '計上額']];

function mgColumns(workName) {
  const columns = [
    {key: 'work', label: '作品', type: 'text', sticky: true, value: (row) => workName(row.workId)},
    {key: 'product', label: '商品', type: 'text', wrap: true, value: (row) => `${row.productName || '商品'}${row.productSku ? `（${row.productSku}）` : ''}`},
    {key: 'allocation', label: '配賦', type: 'rate', digits: 2, total: 'none', value: (row) => (row.allocationBps === null || row.allocationBps === undefined ? null : row.allocationBps / 10000)},
    {key: 'evaluation', label: '選んだ版の評価額', type: 'yen', total: 'none', value: (row) => row.evaluationYen ?? null},
  ];
  for (const [key, label] of MG_METRICS) {
    columns.push({key: `current_${key}`, label: `${label}（当期）`, type: 'yen', total: 'sum', value: (row) => row.current[key]});
    columns.push({key: `cumulative_${key}`, label: `${label}（累計）`, type: 'yen', total: 'sum', value: (row) => row.cumulative[key]});
    columns.push({key: `prior_${key}`, label: `${label}（前回まで）`, type: 'yen', total: 'sum', hidden: true, value: (row) => row.prior[key]});
  }
  columns.push({key: 'sources', label: '実績', type: 'text', value: (row) => (row.sources.length ? `報告 ${row.sources.length}件` : '報告未登録・実績未確認')});
  return columns;
}

export function MgReport({request, data}) {
  const shell = useShell();
  const req = request || shell.request;
  const [direction, setDirection] = useState('incoming');
  const [contracts, setContracts] = useState([]);
  const [contractId, setContractId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [month, setMonth] = useState(new Date().toLocaleDateString('sv-SE').slice(0, 7));
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    setContractId(''); setVersionId(''); setReport(null); setContracts([]); setError(null); setLoaded(false);
    req(`/mg/contracts?direction=${direction}`).then((body) => {
      if (!active) return;
      setContracts(body.contracts);
      const defaults = mgSelectionDefaults(body.contracts);
      setContractId(defaults.contractId);
      setVersionId(defaults.versionId);
    }).catch((cause) => { if (active) setError(cause); }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [direction, req]);
  // 契約・条件版・計上月が決まったら表示する（読み取りだけなので確認なしで実行する）
  useEffect(() => {
    let active = true;
    // 前の集計の応答は捨てるので、その「集計中」もここで消す（向きの切替・契約を空にしたときに残らないように）
    setReport(null); setBusy(false);
    if (!contractId || !versionId || !/^\d{4}-\d{2}$/.test(month)) return undefined;
    setBusy(true);
    setError(null);
    req(`/rights-reports/mg?direction=${direction}&contractId=${contractId}&termVersionId=${versionId}&month=${month}`)
      .then((body) => { if (active) setReport(body.report); })
      .catch((cause) => { if (active) setError(cause); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [direction, contractId, versionId, month, req]);

  const contract = useMemo(() => contracts.find((row) => String(row.id) === contractId), [contracts, contractId]);
  const workName = (id) => data.works.find((work) => work.id === id)?.title || '名称未登録の作品';
  const columns = useMemo(() => mgColumns(workName), [data.works]); // eslint-disable-line react-hooks/exhaustive-deps
  function output(format) {
    try {
      exportReport(format, {filename: `MG作品別現況_${report.contract.code}_${report.accountingMonth}`, title: 'MG作品別現況報告書', subtitle: `${directionLabel(report.direction)} ／ ${report.contract.code} ／ ${monthText(report.accountingMonth)}`, generatedAt: report.generatedAt, sheets: mgReportSheets(report, workName)});
    } catch (cause) { setError(cause); }
  }
  const sources = report ? [...new Map(report.rows.flatMap((row) => row.sources).map((source) => [source.entryId, source])).values()] : [];

  return (
    <div className="stack rt-page">
      <section className="card">
        <p className="rt-muted">契約全体の回収の状況と、作品・商品ごとの消化の実績を確認します。契約が1件ならその契約、条件版は最新を自動で選びます。</p>
        <fieldset className="rr-controls">
          <label>商流<select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="incoming">受取MG（販売先）</option><option value="outgoing">支払MG（仕入先）</option></select></label>
          <label>MG契約<select value={contractId} onChange={(event) => { const next = mgSelectionDefaults(contracts, event.target.value); setContractId(next.contractId); setVersionId(next.versionId); }}>
            <option value="">選んでください</option>{contracts.map((row) => <option key={row.id} value={row.id}>{row.code}｜{row.title}</option>)}
          </select></label>
          <label>保証額の条件版<select value={versionId} onChange={(event) => setVersionId(event.target.value)}>
            <option value="">選んでください</option>{contract?.versions.map((version) => <option key={version.id} value={version.id}>版{version.version}｜{MG_MODES[version.mode] || '未確認'}｜{yenCell(version.mg_amount_yen)}円</option>)}
          </select></label>
          <label>集計する計上月<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        </fieldset>
        {busy && <p className="rt-muted" role="status">集計中…</p>}
        <ProblemNotice error={error} onDismiss={() => setError(null)} />
        {loaded && !contracts.length && !error && <Notice tone="info" message="閲覧できるMG契約がありません。「MG契約・台帳」で契約と条件版を登録してください。" />}
      </section>
      {report && (
        <article className="card print-target rr-report">
          <header>
            <div>
              <p className="rt-eyebrow">MG作品別の現況報告書</p>
              <h2>{report.contract.title}</h2>
              <p>{report.contract.code}｜{directionLabel(report.direction)}｜{monthText(report.accountingMonth)}まで｜保証額は条件版{report.selectedVersion.version}</p>
              <p>{MG_MODES[report.selectedVersion.mode] || '未確認'}｜円・登録済みの台帳から集計</p>
            </div>
            <Actions csv={() => output('csv')} output={output} />
          </header>
          <DraftBanner />
          <div className="rr-headline">
            <div><span>契約のMG額</span><strong>{yenCell(report.headline.guaranteeYen)}円</strong></div>
            <div><span>実充当の累計</span><strong>{yenCell(report.headline.cumulativeAppliedYen)}円</strong></div>
            <div><span>未消化の残高{report.headline.remainingIndicative ? '（参考）' : ''}</span><strong>{yenCell(report.headline.contractRemainingYen)}円</strong></div>
            <div><span>保証額を超えた充当</span><strong>{yenCell(report.headline.appliedExceedYen)}円</strong></div>
          </div>
          <Warnings report={report} />
          <p className="rt-muted">判明している訂正を反映し、同じ契約のすべての条件版に属する実績を集計します。クロスリクープでは作品別の評価額を独立した回収残高として扱いません。未受領の報告は集計に含みません。</p>
          <h3>作品・商品別の当期・累計（前回までは「表示する列」から出せます）</h3>
          <DataGrid columns={columns} rows={report.rows} rowKey={(row) => `${row.productId}-${row.workId}`} persistKey="mg-status-rows" ariaLabel="作品・商品別の実績"
            emptyText="この契約に紐付いた商品はありません" />
          <h3>参照した報告と訂正</h3>
          <div className="rr-table">
            <table>
              <thead><tr><th>計上月</th><th>条件版</th><th>元資料の参照</th><th>訂正</th><th>確認</th></tr></thead>
              <tbody>{sources.map((source) => (
                <tr key={source.entryId}><td>{monthText(source.accountingMonth)}</td><td>版{source.termVersion}</td><td>{source.sourceReference}</td><td>{source.reversesEntryId ? '訂正の記録' : '—'}</td>
                  <td><span className={`rt-state ${source.status === 'reviewed' ? 'is-ok' : 'is-warn'}`}>{source.status === 'reviewed' ? '確認済み' : '未確認'}</span></td></tr>
              ))}</tbody>
            </table>
          </div>
          <footer>作成：{dateTimeJst(report.generatedAt)}｜未確認の報告：{report.unverifiedCount}件<br />契約の資料：{report.contract.sourceReference}｜条件の資料：{report.selectedVersion.sourceReference}</footer>
        </article>
      )}
    </div>
  );
}

const TABS = [{id: 'committee', label: SCREEN_TEXT.reports.committeeTab}, {id: 'mg', label: SCREEN_TEXT.reports.mgTab}];

export default function RightsReports({data, request}) {
  return (
    <div className="stack">
      <Tabs tabs={TABS} urlKey="rrTab" label="帳票の種類">
        {(active) => (active === 'committee' ? <CommitteeReport data={data} request={request} /> : <MgReport data={data} request={request} />)}
      </Tabs>
    </div>
  );
}
