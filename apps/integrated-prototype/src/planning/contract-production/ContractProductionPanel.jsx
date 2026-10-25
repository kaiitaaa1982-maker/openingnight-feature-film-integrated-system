// 受託制作の案件の契約の版（総製作費・受託費率・支払いの節目）を入れる画面の部品（行動指標の計画 #3「受託費率は案件の編集の1項目」。
// 代表の選んだモック M-4 の受託費率 A。要件 FR-REV-CWORK-035・FR-REV-KPI-006）。「企画・作品」の画面の案件の下に置く。
// 読み書きは受託制作の契約の版の受け口（/api/planning/projects/:projectId/contract-versions。財務の権限のある案件だけ）で、版は追記だけ。
// 案件の選択肢は売上の4区分の受け口（/api/revenue/revenue-classes。財務の権限のある案件だけ）の型「受託制作」の案件。
// 制作担当と、財務の権限のある受託制作の案件が1件も無い人には、何も出さない（総製作費・受託費は財務の値）。
// 受託費は自社の売上（純額）で、制作予備費（制作費の版。FR-EXP-PCOST-041）とは別の値として出し、ここで足さない（J-8 (a)）
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FormField} from '../../ui/FormField.jsx';
import {Notice} from '../../ui/Notice.jsx';
import {fieldErrorsFromDetails, isApiError} from '../../ui/api-client.mjs';
import {month as monthText, yen} from '../../ui/format.mjs';
import {bpsToPercent} from '../../royalty/royalty-model.mjs';
import {MAX_MILESTONES} from './contract-production-model.mjs';
import {RATE_RANGE_TEXT, contractProjectOptions, contractVersionBody, contractVersionFieldNames, feePreview, formFromVersion, shareTotalBps} from './contract-version-form-model.mjs';
import '../../ui/forms.css';

const FEE_REASON = {
  budget: '総製作費を入れると、受託費を出します',
  rate: '受託費率を % の数で入れると、受託費を出します',
  rate_range: `受託費率は ${RATE_RANGE_TEXT} の範囲で入れてください（範囲の外は登録できません）`,
};

function MilestoneTable({version, caption}) {
  return (
    <div className="table-wrap">
      <table aria-label={caption}>
        <thead><tr><th scope="col">節目</th><th scope="col">月</th><th scope="col">割合</th><th scope="col">制作費（入金の予定・円）</th><th scope="col">受託費（自社の売上・円）</th></tr></thead>
        <tbody>
          {version.milestones.map((m) => (
            <tr key={m.seq}>
              <td>{m.seq}</td><td>{monthText(m.dueOn)}</td><td>{bpsToPercent(m.shareBps)}%</td>
              <td>{m.budgetYen === null ? '未確定' : yen(m.budgetYen)}</td><td>{m.feeYen === null ? '未確定' : yen(m.feeYen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VersionSummary({version, latest}) {
  return (
    <div className="cp-version" aria-label={`第${version.versionNo}版`}>
      <p>
        <strong>第{version.versionNo}版</strong>{latest ? '（いま使う版）' : ''}　総製作費 {yen(version.budgetYen)}（税別）・受託費率 {bpsToPercent(version.markupBps)}%
        ・<strong>受託費 {yen(version.feeYen)}</strong>（自社の売上・純額）
        {version.complete ? '' : '　節目が揃っていない版（額は未確定）'}
      </p>
      {version.contractReference && <p className="note">契約書: {version.contractReference}</p>}
    </div>
  );
}

// 画面の本体（読み込みと送信は ContractProductionPanel）。状態をすべて props で受けるので、試験で文字列に描ける
export function ContractVersionEditor({
  projects, projectId, onSelectProject, versions, loadError, onRetry, form, onChange, fieldErrors = {}, notice, busy = false, onSubmit,
}) {
  const latest = versions?.at(-1) ?? null;
  const fee = feePreview(form);
  const total = shareTotalBps(form);
  const setMilestone = (index, key, value) => onChange({...form, milestones: form.milestones.map((row, i) => (i === index ? {...row, [key]: value} : row))});
  return (
    <section className="card cp-panel" aria-label="受託制作の契約（受託費率）">
      <h2>受託制作の契約（受託費率）</h2>
      <p className="note">型「受託制作」の案件の総製作費・受託費率・支払いの節目を、契約の版として足します。受託費＝総製作費×受託費率（1円未満は切り捨て）は自社の売上（純額）で、制作予備費とは別の値です（ここでは制作予備費を足しません）。受託費率は交渉の条件で、シナリオでも逆算でも動かしません。</p>
      <div className="on-form-grid">
        <FormField type="select" label="受託制作の案件" value={projectId ?? ''} options={projects} required onChange={(value) => onSelectProject(value)} />
      </div>
      {loadError && <Notice error={loadError} onRetry={onRetry} />}
      {projectId && versions && (
        <>
          <h3>いまの契約</h3>
          {latest ? <><VersionSummary version={latest} latest /><MilestoneTable version={latest} caption={`第${latest.versionNo}版の支払いの節目`} /></> : <p className="note">契約の版はまだありません。最初の版を足すと、この案件の受託費が決まります。</p>}
          <form className="cp-form" aria-label={`第${(latest?.versionNo ?? 0) + 1}版を足す`} onSubmit={(event) => { event.preventDefault(); onSubmit(); }} noValidate>
            <h3>第{(latest?.versionNo ?? 0) + 1}版を足す</h3>
            <div className="on-form-grid">
              <FormField type="yen" label="総製作費（税別）" value={form.budget} required error={fieldErrors.budgetYen} onChange={(value) => onChange({...form, budget: value})} />
              <FormField type="text" label="受託費率（%）" value={form.ratePercent} required error={fieldErrors.markupBps}
                hint={`既定 10%。案件ごとに ${RATE_RANGE_TEXT} の範囲で決めます`} placeholder="例: 12.5" onChange={(value) => onChange({...form, ratePercent: value})} />
            </div>
            <p className="cp-fee" aria-live="polite">
              {fee.feeYen === null ? FEE_REASON[fee.reason] : <>受託費（自社の売上・純額）: 総製作費 {yen(fee.budgetYen)} × {bpsToPercent(fee.markupBps)}% ＝ <strong>{yen(fee.feeYen)}</strong></>}
            </p>
            <fieldset className="cp-milestones">
              <legend>支払いの節目（割合の和は100%。いまは {bpsToPercent(total)}%）</legend>
              {fieldErrors.milestones && <p className="on-field-error">{fieldErrors.milestones}</p>}
              {form.milestones.map((row, index) => (
                <div className="on-form-grid" key={index} role="group" aria-label={`節目${index + 1}`}>
                  <FormField type="month" label={`節目${index + 1}の月`} value={row.month} required error={fieldErrors[`milestones.${index}.dueOn`]} onChange={(value) => setMilestone(index, 'month', value)} />
                  <FormField type="text" label={`節目${index + 1}の割合（%）`} value={row.sharePercent} required error={fieldErrors[`milestones.${index}.shareBps`]} placeholder="例: 50" onChange={(value) => setMilestone(index, 'sharePercent', value)} />
                  {form.milestones.length > 1 && <button type="button" className="secondary" onClick={() => onChange({...form, milestones: form.milestones.filter((_, i) => i !== index)})}>節目{index + 1}を外す</button>}
                </div>
              ))}
              {form.milestones.length < MAX_MILESTONES && <button type="button" className="secondary" onClick={() => onChange({...form, milestones: [...form.milestones, {month: '', sharePercent: ''}]})}>節目を足す</button>}
            </fieldset>
            <div className="on-form-grid">
              <FormField type="text" label="契約書の参照" value={form.contractReference} error={fieldErrors.contractReference} onChange={(value) => onChange({...form, contractReference: value})} />
              <FormField type="textarea" label="メモ" value={form.note} error={fieldErrors.note} onChange={(value) => onChange({...form, note: value})} />
            </div>
            {notice && <Notice {...notice} />}
            <p><button type="submit" disabled={busy}>{busy ? '足しています…' : '版を足す'}</button>　<span className="note">前の版は消さず、書き換えません</span></p>
          </form>
          {versions.length > 1 && (
            <details>
              <summary>前の版（{versions.length - 1}件）</summary>
              {versions.slice(0, -1).reverse().map((version) => <VersionSummary key={version.versionNo} version={version} />)}
            </details>
          )}
        </>
      )}
    </section>
  );
}

// 案件の選択肢を読む。財務の権限のある型「受託制作」の案件だけ。財務の値を読めない人（受け口が 403）は空にして、画面を出さない。
// ほかの失敗（通信・サーバー）は投げる（画面は理由と再試行を出す。財務の値は出さない）
export async function loadContractProjects(request) {
  try {
    return contractProjectOptions(await request('/revenue/revenue-classes'));
  } catch (error) {
    if (isApiError(error) && error.status === 403) return [];
    throw error;
  }
}

// 案件の契約の版の一覧（古い順）
export async function loadContractVersions(request, projectId) {
  return (await request(`/planning/projects/${projectId}/contract-versions`)).versions;
}

// 版を1つ足す。返り値: {added（足した版の番号か null）, fieldErrors（項目の名前→理由）, notice（Notice の props）, reload（最新の版を読み直すか）}。
// 読めない欄は送らずに項目のエラーにし、範囲の外などは受け口の項目ごとの 400 を項目の直下へ出す。ほかの画面が先に足した 409 は入力を残して読み直す
export async function submitContractVersion(request, {projectId, form, versions}) {
  const built = contractVersionBody(form, versions?.at(-1)?.versionNo ?? 0);
  if (!built.ok) return {added: null, fieldErrors: built.errors, notice: {tone: 'error', message: '入力を確かめてください（項目の下に理由があります）'}, reload: false};
  try {
    const result = await request(`/planning/projects/${projectId}/contract-versions`, {method: 'POST', body: built.body});
    return {added: result.versionNo, fieldErrors: {}, notice: {tone: 'ok', message: `第${result.versionNo}版を足しました（受託費 ${yen(result.feeYen)}）`}, reload: true};
  } catch (error) {
    if (isApiError(error) && error.status === 400) {
      const {errors, rest} = fieldErrorsFromDetails(error.details, contractVersionFieldNames(form.milestones.length).map((name) => ({name})));
      return {added: null, fieldErrors: errors, notice: {tone: 'error', message: error.message, details: rest}, reload: false};
    }
    return {added: null, fieldErrors: {}, notice: {error}, reload: isApiError(error) && error.status === 409};
  }
}

// 読み込みと送信。role が制作担当なら何も読まず出さない。案件の選択肢が無い（財務の権限のある受託制作の案件が無い・403）ときも出さない
export function ContractProductionPanel({request, role}) {
  const [projects, setProjects] = useState(null);
  const [projectsError, setProjectsError] = useState(null);
  const [projectsNo, setProjectsNo] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [versions, setVersions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(() => formFromVersion(null));
  const [fieldErrors, setFieldErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadNo = useRef(0);
  const hidden = role === 'production';

  useEffect(() => {
    if (hidden) return undefined;
    let alive = true;
    setProjectsError(null);
    loadContractProjects(request).then((options) => {
      if (!alive) return;
      setProjects(options);
      if (options.length === 1) setProjectId(options[0].value);
    }, (error) => { if (alive) setProjectsError(error); });
    return () => { alive = false; };
  }, [request, hidden, projectsNo]);

  const load = useCallback(async (id, {keepForm = false} = {}) => {
    const n = ++loadNo.current;
    setLoadError(null);
    if (!id) { setVersions(null); return; }
    try {
      const list = await loadContractVersions(request, id);
      if (n !== loadNo.current) return;
      setVersions(list);
      if (!keepForm) { setForm(formFromVersion(list.at(-1) ?? null)); setFieldErrors({}); }
    } catch (error) {
      if (n !== loadNo.current) return;
      setVersions(null);
      setLoadError(error);
    }
  }, [request]);

  useEffect(() => { load(projectId); }, [projectId, load]);

  if (hidden) return null;
  if (projectsError) {
    return <section className="card cp-panel" aria-label="受託制作の契約（受託費率）"><h2>受託制作の契約（受託費率）</h2><Notice error={projectsError} onRetry={() => setProjectsNo((n) => n + 1)} /></section>;
  }
  if (!projects || !projects.length) return null;

  async function submit() {
    setNotice(null);
    setBusy(true);
    try {
      const result = await submitContractVersion(request, {projectId, form, versions});
      if (result.reload) await load(projectId, {keepForm: !result.added});
      setFieldErrors(result.fieldErrors);
      setNotice(result.notice);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ContractVersionEditor projects={projects} projectId={projectId} onSelectProject={(value) => { setNotice(null); setProjectId(value); }}
      versions={versions} loadError={loadError} onRetry={() => load(projectId)} form={form} onChange={setForm} fieldErrors={fieldErrors}
      notice={notice} busy={busy} onSubmit={submit} />
  );
}

export default ContractProductionPanel;
