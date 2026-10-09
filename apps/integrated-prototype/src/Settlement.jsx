// 権利・分配。作品ごとの権利契約（条件版）で、紐付けた売上報告から権利元への配分と自社の受取を試算する。
// 並び: 試算の結果 → 未紐付けの売上報告（前回の契約・最新の条件版・前回の基準を既定値）→ 紐付け済み → 契約と条件版（登録は折りたたみ）。
// 新しい条件版は押した契約のすぐ下に開く。金額の表は DataGrid（右寄せ・桁区切り・合計）。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {RecordForm} from './ui/RecordForm.jsx';
import {Notice} from './ui/Notice.jsx';
import {FormField} from './ui/FormField.jsx';
import {toEntityItems} from './ui/entity-match.mjs';
import {yen, month as monthText, dateJst} from './ui/format.mjs';
import {ProblemNotice} from './CommitteeFinanceFields.jsx';
import {
  SCREEN_TEXT, CONTRACT_TYPE_OPTIONS, REPORT_BASIS_OPTIONS, RECOUP_BASIS_OPTIONS, contractTypeText, reportBasisText, reportKindText,
  settlementVersionText, latestVersion, linkDefaults, contractFormDefaults, settlementContractPayload, versionFormDefaults, versionPayload,
  percentFieldError, translateError, parseMoney, japaneseMessage,
} from './rights/rights-ui-model.mjs';
import './reports/reports.css';
import './RightsReports.css';

const T = SCREEN_TEXT.settlement;
const EMPTY = {workId: null, contracts: [], reports: [], preview: null, intakes: []};

function contractFields({partners, intakes}) {
  const partnerItems = toEntityItems(partners);
  const intakeOptions = intakes.filter((item) => !(item.settlementLinks || []).length).map((item) => ({value: String(item.id), label: `${item.case_code}｜${item.title}`}));
  return [
    {name: 'contractCode', label: '契約コード', type: 'text', required: true, hint: '作品コードと連番で自動で入れています。変えてもかまいません'},
    {name: 'title', label: '契約名', type: 'text', required: true},
    {name: 'contractType', label: '契約の種類', type: 'select', required: true, options: CONTRACT_TYPE_OPTIONS},
    {name: 'holderPartnerId', label: '権利元（1者）', type: 'entity', required: true, items: partnerItems, visible: (raw) => raw.contractType !== 'self_owned', emptyText: '取引先がありません'},
    {name: 'intakeCaseId', label: '調達案件（任意・登録時に固定）', type: 'select', options: intakeOptions, blankLabel: '関連なし（未確認）'},
    {name: 'mgContractYen', label: 'MG契約額', type: 'yen', required: true, visible: (raw) => raw.contractType === 'mg'},
    {name: 'mgPaidYen', label: 'MG実支払額（未確認なら空欄）', type: 'yen', visible: (raw) => raw.contractType === 'mg',
      validate: (value, raw) => {
        const contract = parseMoney(raw.mgContractYen);
        return value !== null && contract.ok && contract.value !== null && value > contract.value ? 'MG実支払額はMG契約額以下にしてください' : null;
      }},
    {name: 'platformRate', label: 'PF料率（%）', type: 'text', required: true, hint: '例: 30（0〜100）', validate: (value) => percentFieldError(value)},
    {name: 'feeRate', label: '代理店手数料率（%・PF控除後が基礎）', type: 'text', required: true, hint: '例: 20（0〜100）', visible: (raw) => raw.contractType !== 'self_owned', validate: (value) => percentFieldError(value)},
    {name: 'recoupBasis', label: 'MG回収の基礎', type: 'select', required: true, options: RECOUP_BASIS_OPTIONS, visible: (raw) => raw.contractType === 'mg'},
  ];
}

function versionFields(contractType) {
  return [
    {name: 'platformRate', label: 'PF料率（%）', type: 'text', required: true, hint: '例: 30（0〜100）', validate: (value) => percentFieldError(value)},
    {name: 'feeRate', label: '代理店手数料率（%・PF控除後が基礎）', type: 'text', required: true, visible: () => contractType !== 'self_owned', validate: (value) => percentFieldError(value)},
    {name: 'recoupBasis', label: 'MG回収の基礎', type: 'select', required: true, options: RECOUP_BASIS_OPTIONS, visible: () => contractType === 'mg'},
    {name: 'note', label: '版のメモ（任意）', type: 'text', wide: true},
  ];
}

// 契約1件。「新しい条件版を作る」はこのカードのすぐ下に開く。
function ContractCard({contract, request, readOnly, onChanged}) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const latest = latestVersion(contract.versions);
  const fields = useMemo(() => versionFields(contract.contract_type), [contract.contract_type]);
  return (
    <article className="settlement-contract">
      <div className="rt-head">
        <div>
          <span className="badge">{contractTypeText(contract.contract_type)}</span>
          <h3>{contract.contract_code}｜{contract.title}</h3>
          <p className="rt-muted">
            {contract.holder_name ? `権利元：${contract.holder_name}` : '自社権利'}
            {contract.contract_type === 'mg' ? `｜MG契約額 ${yen(contract.mg_contract_yen)}｜実支払 ${yen(contract.mg_paid_yen)}` : ''}
          </p>
          {contract.intakeCaseId
            ? <p className="rt-muted">調達案件：{contract.intakeCaseCode}｜{contract.intakeCaseTitle}</p>
            : <p className="rt-muted"><span className="rt-state is-warn">調達案件との関連は未確認</span>（「調達・権利」で関連付けられます）</p>}
        </div>
        <button type="button" className={open ? '' : 'secondary'} aria-expanded={open} disabled={readOnly} onClick={() => { setOpen((value) => !value); setNotice(''); }}>
          {open ? '閉じる' : T.newVersion}
        </button>
      </div>
      <div className="rt-chips" aria-label="条件版">
        {contract.versions.map((version) => (
          <span className="rt-chip" key={version.id}>{settlementVersionText(version)}{version.id === latest?.id ? '（最新）' : ''}</span>
        ))}
      </div>
      {notice && <Notice tone="ok" message={notice} compact onDismiss={() => setNotice('')} />}
      {open && (
        <div className="rt-inline">
          <RecordForm mode="create" collapsible={false} allowContinue={false} fields={fields}
            title={`新しい条件版（版${(latest?.version_no || 0) + 1}）。前の版は変えずに残します`}
            initialValues={versionFormDefaults(contract)} resetKey={latest?.id} submitLabel="この内容で新しい版を保存"
            onSubmit={async (values) => {
              try {
                return await request(`/settlement/contracts/${contract.id}/versions`, {method: 'POST', body: JSON.stringify(versionPayload(values, contract.contract_type))});
              } catch (error) { throw translateError(error); }
            }}
            onSaved={() => { setOpen(false); setNotice(`版${(latest?.version_no || 0) + 1}を保存しました（前の版は残っています）`); onChanged(); }} />
        </div>
      )}
    </article>
  );
}

// 未紐付けの売上報告1件。既定値は前回の紐付けと最新の条件版。
function LinkRow({report, contracts, reports, request, readOnly, onLinked}) {
  const defaults = useMemo(() => linkDefaults(report, contracts, reports), [report, contracts, reports]);
  const [draft, setDraft] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // 既定値は、利用者がまだ選んでいない間だけ入れ直す（別の報告の紐付け・契約の保存で既定値が変わっても、選んだ値は消さない）。
  // 選んだ契約・条件版が一覧から消えたときだけ、その欄を空に戻す
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) { setDraft(defaults); return; }
    setDraft((current) => {
      const picked = contracts.find((item) => String(item.id) === String(current.contractId));
      if (current.contractId && !picked) return {...current, contractId: '', versionId: ''};
      if (picked && current.versionId && !(picked.versions || []).some((version) => String(version.id) === String(current.versionId))) return {...current, versionId: ''};
      return current;
    });
  }, [defaults, touched, contracts]);
  const edit = (patch) => { setTouched(true); setDraft((current) => ({...current, ...patch})); };
  const contract = contracts.find((item) => String(item.id) === String(draft.contractId));
  const latest = latestVersion(contract?.versions);
  const contractOptions = contracts.map((item) => ({value: String(item.id), label: `${item.contract_code}｜${item.title}`}));
  const versionOptions = (contract?.versions || []).map((version) => ({value: String(version.id), label: `${settlementVersionText(version)}${version.id === latest?.id ? '（最新）' : ''}`}));
  const ready = draft.contractId && draft.versionId && draft.reportBasis;
  async function link() {
    setBusy(true);
    setError(null);
    try {
      await request('/settlement/links', {method: 'POST', body: JSON.stringify({reportId: report.id, workId: report.targetWorkId, contractId: Number(draft.contractId), termVersionId: Number(draft.versionId), reportBasis: draft.reportBasis})});
      onLinked(`売上報告「${report.report_key}」を「${contract?.contract_code}」の版${contract?.versions.find((v) => String(v.id) === String(draft.versionId))?.version_no}へ紐付けました（${reportBasisText(draft.reportBasis)}）`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  const note = touched ? '選んだ契約・条件版・報告額の基準で紐付けます。'
    : defaults.source === 'previous'
    ? '前回の紐付けから契約と報告額の基準を引き継ぎ、最新の条件版を選んでいます。'
    : defaults.source === 'single' ? '契約が1件のため、その契約の最新の条件版を選んでいます。報告額の基準を選んでください。' : '契約・条件版・報告額の基準を選んでください。';
  return (
    <article className="rt-link">
      <div>
        <strong>{report.report_key}</strong>
        <p className="rt-muted">{reportKindText(report.kind)}｜計上月 {monthText(report.accounting_month)}｜対象期間 {dateJst(report.period_from)}〜{dateJst(report.period_to)}</p>
      </div>
      <div className="rt-link-controls">
        <FormField type="select" label="契約" required value={draft.contractId} options={contractOptions} disabled={readOnly || busy}
          onChange={(value) => {
            const next = contracts.find((item) => String(item.id) === value);
            const nextLatest = latestVersion(next?.versions);
            edit({contractId: value, versionId: nextLatest ? String(nextLatest.id) : ''});
          }} />
        <FormField type="select" label="条件版" required value={draft.versionId} options={versionOptions} disabled={readOnly || busy || !contract}
          onChange={(value) => edit({versionId: value})} />
        <FormField type="select" label="この報告の報告額の基準" required value={draft.reportBasis} options={REPORT_BASIS_OPTIONS} disabled={readOnly || busy}
          onChange={(value) => edit({reportBasis: value})} />
        <button type="button" disabled={readOnly || busy || !ready} onClick={link}>{busy ? '保存中…' : '紐付ける'}</button>
      </div>
      <p className="rt-default-note">{note}</p>
      <ProblemNotice error={error} onDismiss={() => setError(null)} />
    </article>
  );
}

const LINKED_COLUMNS = (contracts) => [
  {key: 'report_key', label: '売上報告', type: 'text', sticky: true},
  {key: 'kind', label: '流通', type: 'text', value: (row) => reportKindText(row.kind)},
  {key: 'accounting_month', label: '計上月', type: 'month'},
  {key: 'period', label: '対象期間', type: 'text', value: (row) => `${dateJst(row.period_from)}〜${dateJst(row.period_to)}`},
  {key: 'basis', label: '報告額の基準', type: 'text', value: (row) => reportBasisText(row.link.report_basis)},
  {key: 'contract', label: '契約', type: 'text', value: (row) => {
    const contract = contracts.find((item) => item.id === row.link.contract_id);
    return contract ? `${contract.contract_code}｜${contract.title}` : '未登録の契約';
  }},
  {key: 'version', label: '条件版', type: 'text', value: (row) => {
    const version = contracts.find((item) => item.id === row.link.contract_id)?.versions.find((item) => item.id === row.link.term_version_id);
    return version ? `版${version.version_no}` : '未確認';
  }},
];

function ReportLinks({reports, contracts, request, readOnly, onChanged}) {
  const [notice, setNotice] = useState('');
  const unlinked = reports.filter((report) => !report.link);
  const linked = reports.filter((report) => report.link);
  const columns = useMemo(() => LINKED_COLUMNS(contracts), [contracts]);
  return (
    <section className="card rp-report" aria-label={T.links}>
      <div className="rt-head">
        <div>
          <h2>{T.links}</h2>
          <p className="rt-muted">売上報告ごとに、使う契約の条件版と報告額の基準（手数料を引く前か後か）を決めます。紐付けた報告だけが試算に入ります。</p>
        </div>
        <span className={`rt-count ${unlinked.length ? 'is-warn' : ''}`}>未紐付け {unlinked.length}件</span>
      </div>
      {notice && <Notice tone="ok" message={notice} onDismiss={() => setNotice('')} />}
      {!contracts.length && unlinked.length > 0 && <Notice tone="info" message="先に下の「権利契約と条件版」で契約を登録してください。" compact />}
      {unlinked.length === 0
        ? <p className="rt-muted">この作品へ配賦された有効な売上報告は、すべて紐付け済みです。</p>
        : unlinked.map((report) => (
          <LinkRow key={report.id} report={report} contracts={contracts} reports={reports} request={request} readOnly={readOnly}
            onLinked={(message) => { setNotice(message); onChanged(); }} />
        ))}
      <h3>{T.linked}（{linked.length}件）</h3>
      <DataGrid columns={columns} rows={linked} rowKey="id" emptyText="紐付け済みの売上報告はありません" persistKey="settlement-linked" ariaLabel={T.linked} maxHeight="50vh" />
    </section>
  );
}

function basisColumns(reportKeyOf) {
  return [
    {key: 'reportKey', label: '売上報告', type: 'text', sticky: true, value: (row) => reportKeyOf(row.reportId)},
    {key: 'description', label: '売上明細', type: 'text', wrap: true, value: (row) => row.description || '内容未登録'},
    {key: 'accountingMonth', label: '計上月', type: 'month'},
    {key: 'contractCode', label: '契約', type: 'code'},
    {key: 'versionNo', label: '条件版', type: 'text', value: (row) => `版${row.versionNo}`},
    {key: 'reportBasis', label: '報告額の基準', type: 'text', value: (row) => reportBasisText(row.reportBasis)},
    {key: 'allocation', label: '作品への配賦率', type: 'rate', digits: 2, total: 'none', value: (row) => (row.allocationBps === null || row.allocationBps === undefined ? null : row.allocationBps / 10000)},
    {key: 'reportedAmount', label: '報告額（税抜）', type: 'yen', total: 'sum'},
    {key: 'platformDeduction', label: 'PF控除', type: 'yen', total: 'sum'},
    {key: 'platformNet', label: 'PF控除後の受取', type: 'yen', total: 'sum'},
    {key: 'agencyFee', label: '代理店手数料', type: 'yen', total: 'sum', value: (row) => (row.contractType === 'self_owned' ? 0 : row.agencyFee)},
    {key: 'holderAmount', label: '権利元への配分', type: 'yen', total: 'sum', value: (row) => (row.contractType === 'commission' ? row.holderAmount : 0)},
    {key: 'ownReceipts', label: '自社の受取', type: 'yen', total: 'sum', value: (row) => (row.contractType === 'self_owned' ? row.ownReceipts : 0)},
    {key: 'recoupSource', label: 'MG回収の原資', type: 'yen', total: 'sum', value: (row) => (row.contractType === 'mg' ? row.recoupSource : 0)},
    {key: 'sourceRow', label: '原本の行', type: 'int', total: 'none', hidden: true},
    {key: 'reportId', label: '売上報告の番号', type: 'id', hidden: true},
    {key: 'saleId', label: '売上明細の番号', type: 'id', hidden: true},
  ];
}

function Summary({summary}) {
  const rows = summary.contractType === 'commission'
    ? [['PF控除後の受取', summary.platformNet], ['代理店手数料', summary.agencyFee], ['権利元への配分', summary.holderAmount]]
    : summary.contractType === 'self_owned'
      ? [['PF控除後の自社受取', summary.ownReceipts]]
      : [['MG契約額', summary.mgContractYen], ['MG実支払額', summary.mgPaidYen], ['PF控除後の受取', summary.netReceipts], ['累計の回収原資', summary.recoupSource],
        ['MGへの充当（試算）', summary.recouped], ['MGの未回収残高', summary.mgBalance], ['MGを超えた原資', summary.excess], ['権利元への追加分配', summary.holderAdditional]];
  return (
    <article>
      <span>{contractTypeText(summary.contractType)}</span>
      <strong>{summary.contractCode}{summary.title ? `｜${summary.title}` : ''}</strong>
      <small>紐付けた売上報告 {summary.linkedReportCount}件・明細 {summary.lineCount}行{summary.reportBasis ? `・${reportBasisText(summary.reportBasis)}` : ''}</small>
      <dl>
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="num">{value === null || value === undefined ? '未確認' : yen(value)}</dd></div>)}
      </dl>
      {summary.contractType === 'mg' && <p className="rt-muted">MG超過後の追加分配の条件は未確認のため、追加分配は計算しません。</p>}
    </article>
  );
}

function Preview({preview, reports, loading}) {
  const reportKeyOf = useMemo(() => {
    const keys = new Map(reports.map((row) => [row.id, row.report_key]));
    return (id) => keys.get(id) || '売上報告';
  }, [reports]);
  const columns = useMemo(() => basisColumns(reportKeyOf), [reportKeyOf]);
  if (!preview) return <section className="card"><p className="rt-muted">{loading ? '分配の試算を読み込んでいます…' : '分配の試算はまだありません。'}</p></section>;
  return (
    <section className="card rp-report" aria-label={T.preview}>
      <div className="rt-head">
        <div>
          <h2>{T.preview}</h2>
          <p className="rt-muted">{japaneseMessage(preview.scopeNote)}</p>
        </div>
        {preview.unlinkedCount > 0 && <span className="rt-count is-warn">未紐付け {preview.unlinkedCount}件は試算に含みません</span>}
      </div>
      {preview.contractSummaries.length
        ? <div className="settlement-summaries">{preview.contractSummaries.map((summary) => <Summary key={summary.contractId} summary={summary} />)}</div>
        : <p className="rt-muted">権利契約を登録し、売上報告を紐付けると、ここに試算が出ます。</p>}
      <details open={preview.lineResults.length > 0 && preview.lineResults.length <= 30}>
        <summary>{T.basis}（{preview.lineResults.length}行）</summary>
        <DataGrid columns={columns} rows={preview.lineResults} rowKey={(row) => `${row.reportId}-${row.saleId}`} persistKey="settlement-basis"
          emptyText="紐付けた有効な売上報告の明細はありません" ariaLabel={T.basis}
          exportSpec={{name: '権利分配の試算', title: '権利・分配の試算（計算根拠）', conditions: [['範囲', '紐付けた有効な売上報告（作品配賦後・税抜）']], notes: [preview.roundingRule, preview.scopeNote]}} />
      </details>
      <p className="rt-muted">端数の扱い：{preview.roundingRule}</p>
    </section>
  );
}

export default function Settlement({data, request}) {
  const shell = useShell();
  const req = request || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const workId = data.selectedWorkId;
  const work = data.selectedWork || data.works?.find((item) => item.id === workId) || null;
  const [state, setState] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);
  useEffect(() => {
    if (!workId) return undefined;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setState((current) => (current.workId === workId ? current : {...EMPTY, workId}));
    Promise.all([
      req(`/settlement/contracts?workId=${workId}`), req(`/settlement/reports?workId=${workId}`), req(`/settlement/preview?workId=${workId}`), req(`/intakes?workId=${workId}`),
    ]).then(([contracts, reports, preview, intakes]) => {
      if (id !== requestId.current) return;
      setState({workId, contracts: contracts.contracts, reports: reports.reports.map((row) => ({...row, targetWorkId: workId})), preview, intakes: intakes.cases});
    }).catch((cause) => {
      if (id === requestId.current) setError(cause);
    }).finally(() => {
      if (id === requestId.current) setLoading(false);
    });
    return () => { requestId.current += 1; };
  }, [workId, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => setRevision((value) => value + 1);
  const linkedCount = state.reports.filter((report) => report.link).length;
  const unlinkedCount = state.reports.length - linkedCount;
  const fields = useMemo(() => contractFields({partners: data.partners || [], intakes: state.intakes}), [data.partners, state.intakes]);
  const defaults = useMemo(() => {
    const values = contractFormDefaults(state.contracts, work);
    return {...values, holderPartnerId: values.holderPartnerId ? Number(values.holderPartnerId) : ''};
  }, [state.contracts, work]);

  if (!workId) return <Notice tone="info" message="作品を選ぶと、権利契約と分配の試算を表示します。" />;
  return (
    <div className="stack rt-page">
      <section className="card rt-intro">
        <p className="rt-eyebrow">{T.eyebrow}</p>
        <h2>{T.title}</h2>
        <p>{T.lead}</p>
        <div className="rp-tiles">
          <div><span>権利契約</span><strong>{state.contracts.length}件</strong></div>
          <div><span>紐付け済みの売上報告</span><strong>{linkedCount}件</strong></div>
          <div><span>未紐付けの売上報告</span><strong className={unlinkedCount ? 'rt-state is-warn' : undefined}>{unlinkedCount}件</strong></div>
        </div>
      </section>
      <ProblemNotice error={error} title="権利・分配の情報を読み込めませんでした" onRetry={changed} />
      <Preview preview={state.preview} reports={state.reports} loading={loading} />
      <ReportLinks reports={state.reports} contracts={state.contracts} request={req} readOnly={readOnly} onChanged={changed} />
      <section className="card rp-report" aria-label={T.contracts}>
        <div className="rt-head">
          <div>
            <h2>{T.contracts}（{state.contracts.length}件）</h2>
            <p className="rt-muted">契約の条件は版として固定します。料率を変えるときは前の版を残して新しい版を作ります。MG契約額と実支払額は契約に1つだけ持ち、版を増やしてもMG枠は増えません。</p>
          </div>
        </div>
        <RecordForm mode="create" openLabel={T.register} title="権利契約を登録（条件は版1として保存）" fields={fields} initialValues={defaults}
          resetKey={`${workId}:${state.contracts.length}`} submitLabel="契約と版1を登録" allowContinue={false}
          successMessage="権利契約と条件版1を登録しました"
          onSubmit={async (values) => {
            const payload = settlementContractPayload(values, workId);
            try {
              return await req('/settlement/contracts', {method: 'POST', body: JSON.stringify(payload)});
            } catch (cause) { throw translateError(cause); }
          }}
          onSaved={changed} />
        <p className="rt-muted">複数の権利元への分割はこの試作の対象外です（1契約につき権利元は1者）。料率の既定値は、この作品で最後に登録した契約の最新の版です。</p>
        {state.contracts.length === 0
          ? <p className="rt-muted">{loading ? '読み込んでいます…' : 'この作品の権利契約はまだありません。'}</p>
          : state.contracts.map((contract) => <ContractCard key={contract.id} contract={contract} request={req} readOnly={readOnly} onChanged={changed} />)}
      </section>
    </div>
  );
}
