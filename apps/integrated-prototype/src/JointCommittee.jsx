// 共同製作・入金基準の製作委員会。保存済みの計算から、契約・制作／窓口報告／分配計算／帳票を表示する。
// - 同じ作品に共同製作の契約が複数あるときは、ここで選べる（製作委員会の画面と帳票センターのどちらから開いても同じ）。
// - 表は DataGrid（右寄せ・桁区切り・合計）。帳票の出力は日本語の列名で Excel・CSV・印刷。
// - タブは共通の Tabs で、選んだタブを URL に残す。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {Tabs} from './ui/Tabs.jsx';
import {DataGrid} from './ui/DataGrid.jsx';
import {Notice} from './ui/Notice.jsx';
import {FormField} from './ui/FormField.jsx';
import {ReportOutputBar} from './ui/ReportOutputBar.jsx';
import {gridSheetSpec} from './ui/grid-model.mjs';
import {yen, dateJst, dateTimeJst} from './ui/format.mjs';
import {ProblemNotice} from './CommitteeFinanceFields.jsx';
import {percentText, milestoneStageText, translateError} from './rights/rights-ui-model.mjs';
import {jointReportViews, JOINT_VIEW_ORDER, jointAssumptionRows} from './rights/committee-ui-model.mjs';
import './reports/reports.css';
import './RightsReports.css';

const TABS = [
  {id: 'terms', label: '契約・制作'},
  {id: 'windows', label: '窓口報告'},
  {id: 'settlement', label: '分配計算'},
  {id: 'reports', label: '帳票'},
];

const MEMBER_COLUMNS = [
  {key: 'name', label: '出資者', type: 'text', sticky: true},
  {key: 'share', label: '持分', type: 'rate', digits: 2, total: 'none'},
  {key: 'planned', label: '出資予定額（税込）', type: 'yen', total: 'sum'},
  {key: 'funded', label: '実際の出資充当（税込）', type: 'yen', total: 'sum'},
];

const ASSUMPTION_COLUMNS = [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '内容', type: 'text', wrap: true}];

export default function JointCommittee({workId, contractId, request, initialTab = 'terms', role}) {
  const shell = useShell();
  const req = request || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const [contracts, setContracts] = useState([]);
  const [selectedId, setSelectedId] = useState(contractId ? String(contractId) : '');
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reportKind, setReportKind] = useState('joint_period_totals');
  const [revision, setRevision] = useState(0);

  useEffect(() => { if (contractId) setSelectedId(String(contractId)); }, [contractId]);
  // 同じ作品の共同製作の契約（複数あれば選べるようにする）
  useEffect(() => {
    let live = true;
    if (workId) req(`/committee/joint?workId=${workId}`).then((body) => { if (live) setContracts(body.contracts || []); }).catch(() => { /* 一覧が読めなくても選んだ契約は表示する */ });
    return () => { live = false; };
  }, [workId, req]);
  useEffect(() => {
    let live = true;
    if (!selectedId) return undefined;
    setView(null);
    setError(null);
    req(`/committee/joint/${selectedId}?workId=${workId}`).then((body) => { if (live) setView(body); }).catch((cause) => { if (live) setError(cause); });
    return () => { live = false; };
  }, [workId, selectedId, revision, req]);

  const data = view?.contract;
  const snapshot = view?.snapshot;
  const names = useMemo(() => Object.fromEntries((data?.members || []).map((member) => [member.partner_id, member.partner_name])), [data]);
  const results = snapshot?.results || [];
  const views = useMemo(() => jointReportViews(results, data?.milestones || [], names), [results, data, names]);
  const memberRows = useMemo(() => (data?.members || []).map((member) => ({
    id: member.partner_id,
    name: `${member.partner_name}${member.partner_id === data.row.manager_partner_id ? '（幹事）' : ''}`,
    share: member.share_bps === null || member.share_bps === undefined ? null : member.share_bps / 10000,
    planned: member.contribution_inc_tax_yen,
    funded: (data.fundingEvents || []).filter((event) => event.partner_id === member.partner_id).reduce((total, event) => total + event.amount_inc_tax_yen, 0),
  })), [data]);

  if (error && !view) return <ProblemNotice error={error} title="共同製作の計算を読み込めませんでした" onRetry={() => setRevision((value) => value + 1)} />;
  if (!view) return <section className="card"><p className="rt-muted">共同製作の条件と保存済みの計算を読み込んでいます…</p></section>;
  const {row, milestones, sales, costs} = data;
  const conditions = [['作品', row.work_title || row.title], ['契約', `${row.code}｜${row.title}`], ['税の基準', '税込の契約額（架空の追加合意）']];
  const dataAsOf = snapshot?.createdAt;
  const sheets = () => [
    {name: '帳票の前提', title: '共同製作・入金基準の帳票の前提', conditions, columns: ASSUMPTION_COLUMNS, rows: jointAssumptionRows({title: row.title, calculationVersion: snapshot?.calculationVersion})},
    ...JOINT_VIEW_ORDER.map((key) => gridSheetSpec({columns: views[key].columns, rows: views[key].rows, exportSpec: {name: views[key].title, title: views[key].title, conditions, dataAsOf}})),
  ];
  const canSave = !readOnly && (!role || role === 'admin');

  async function recalculate() {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await req(`/committee/joint/${selectedId}/snapshots?workId=${workId}`, {method: 'POST', body: '{}'});
      setNotice({tone: 'ok', message: saved.reused ? '入力が前回と同じため、保存済みの計算をそのまま表示しています' : '条件と実入金から計算し直して保存しました'});
      setRevision((value) => value + 1);
    } catch (cause) {
      setNotice({error: translateError(cause)});
    } finally {
      setBusy(false);
    }
  }

  const grid = (key, extra = {}) => (
    <DataGrid columns={views[key].columns} rows={views[key].rows} rowKey="key" persistKey={`joint-${key}`} ariaLabel={views[key].title}
      emptyText="計算はまだ保存されていません。「帳票」タブで計算して保存します" {...extra} />
  );

  return (
    <div className="stack joint-committee-page rt-page">
      <section className="card rt-intro">
        <p className="rt-eyebrow">共同製作・入金基準</p>
        <h2>{row.title}</h2>
        <p>税込の契約額を使う架空の追加合意です。窓口報告、未送金、実入金、幹事料、出資者への分配を順に確認します。</p>
        {contracts.length > 1 && (
          <div className="on-form-grid">
            <FormField type="select" label="共同製作の契約" includeBlank={false} value={selectedId}
              options={contracts.map((item) => ({value: String(item.id), label: `${item.code}｜${item.title}`}))} onChange={setSelectedId} />
          </div>
        )}
        <details>
          <summary>計算の前提</summary>
          <p className="rt-muted">{row.terms_note}</p>
          <p className="rt-muted">保存済みの計算：{snapshot ? `${dateTimeJst(snapshot.createdAt)} に保存` : 'まだありません'}</p>
        </details>
      </section>
      <Tabs tabs={TABS} urlKey="jointTab" defaultValue={initialTab} label="共同製作の作業">
        {(active) => (
          <>
            {active === 'terms' && (
              <section className="card rp-report">
                <h2>契約条件と制作の委託</h2>
                <div className="rp-tiles">
                  <div><span>直接制作費（税込）</span><strong>{yen(row.production_cost_inc_tax_yen)}</strong></div>
                  <div><span>宣伝費（税込）</span><strong>{yen(row.pa_inc_tax_yen)}</strong></div>
                  <div><span>全体の幹事料率</span><strong>{percentText(row.manager_fee_bps)}</strong></div>
                </div>
                <p className="rt-muted">幹事：{names[row.manager_partner_id] || '未登録'}／受託制作：架空C社（出資者への分配先ではありません）</p>
                <DataGrid columns={MEMBER_COLUMNS} rows={memberRows} rowKey="id" persistKey="joint-members" ariaLabel="出資者" emptyText="出資者は登録されていません" />
                <p className="rt-muted">A社の第1回の制作支払は出資の充当と同じ根拠で管理し、資金の使途へ二重に足しません。宣伝費と制作費は窓口の経費へ自動で振り替えません。</p>
                <h3>制作費の支払</h3>
                {grid('joint_production_milestones', {emptyText: '制作費の支払の条件は登録されていません'})}
                <p className="rt-muted">条件の実績：{milestones.map((m) => `${milestoneStageText(m.stage)} ${m.condition_met_on ? dateJst(m.condition_met_on) : '未成就'}`).join('／') || 'なし'}</p>
              </section>
            )}
            {active === 'windows' && (
              <section className="card rp-report">
                <h2>窓口別の報告と未送金</h2>
                <p className="rt-muted">委員会の収入が {yen(row.income_threshold_yen)} に満たない、または窓口の税込の正味受領額が {yen(row.transfer_threshold_yen)} に満たないときは翌期へ繰り越します（同額は繰り越しません）。繰越中も報告は続けます。</p>
                {grid('joint_window_periods')}
                <details>
                  <summary>報告と費用の入力根拠（売上 {sales.length}件・承認済みの費用 {costs.length}件）</summary>
                  <ul className="rt-errors">{sales.map((sale) => (
                    <li key={sale.id}>{sale.source_ref}：{sale.period_sequence}期／報告 {sale.reported_on ? dateJst(sale.reported_on) : '未登録'}／委員会の受入 {sale.manager_receipt_on ? dateJst(sale.manager_receipt_on) : '未着金'}</li>
                  ))}</ul>
                </details>
              </section>
            )}
            {active === 'settlement' && (
              <section className="card rp-report">
                <h2>委員会全体の計算と分配</h2>
                <p className="rt-muted">窓口からの実受入を合算し、権利処理費を引いてから幹事料を一度だけ計算します。原盤管理費はその後に控除します。</p>
                {grid('joint_period_totals')}
                <h3>出資者への分配</h3>
                {grid('joint_member_distributions')}
                <p className="rt-muted">幹事料と窓口料は出資者への分配に足しません。未払は支払の実績を登録する前の値です。</p>
              </section>
            )}
            {active === 'reports' && (
              <section className="card rp-report">
                <div className="rt-head">
                  <div>
                    <h2>保存済みの計算と帳票</h2>
                    <p className="rt-muted">帳票は保存済みの計算から作ります。計算し直しても入力が同じなら、同じ保存版を表示します。</p>
                  </div>
                  <div className="rt-actions">
                    <button type="button" disabled={!canSave || busy} onClick={recalculate}>{busy ? '計算中…' : '条件と実入金から計算し直して保存'}</button>
                    {!canSave && <span className="rt-muted">{readOnly ? '閲覧専用の表示です' : '計算の保存は管理者だけが行えます'}</span>}
                  </div>
                </div>
                {notice?.message && <Notice tone={notice.tone} message={notice.message} onDismiss={() => setNotice(null)} />}
                {notice?.error && <ProblemNotice error={notice.error} onDismiss={() => setNotice(null)} />}
                {snapshot
                  ? (
                    <>
                      <div className="rt-actions">
                        <FormField type="select" label="表示する帳票" includeBlank={false} value={reportKind}
                          options={JOINT_VIEW_ORDER.map((key) => ({value: key, label: views[key].title}))} onChange={setReportKind} />
                        <ReportOutputBar sheets={sheets} name={`共同製作会計_${row.code}`} title="共同製作・入金基準の帳票" subtitle={`${row.title} ／ 税込の契約額`} label="全帳票の出力" />
                      </div>
                      <p className="rt-muted">作品 {row.work_title || row.title}／保存 {dateTimeJst(snapshot.createdAt)}／税の基準 税込の契約額（架空の追加合意）</p>
                      {grid(reportKind, {exportSpec: {name: `${views[reportKind].title}_${row.code}`, title: views[reportKind].title, conditions, dataAsOf}})}
                    </>
                  )
                  : <Notice tone="info" message="まだ計算を保存していません。管理者が「条件と実入金から計算し直して保存」を押すと帳票を出せます。" />}
              </section>
            )}
          </>
        )}
      </Tabs>
    </div>
  );
}
