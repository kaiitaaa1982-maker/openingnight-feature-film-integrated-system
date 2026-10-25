// 業務画面「MG 買付」の入力（契約と条件版の登録・人が理由を書いて結ぶ）。受け口は src/acquisition/acq-mg-routes.mjs。
// 契約書を見ながら条件を入れる（紙の写し・文書は全部人が見る）。率は % の文字で入れ、bp に直す（丸めない）。
// 報告の周期の初期値は「3か月・3月基準・締めの翌月末に報告と支払」（計画の仮説 H5。契約書の値で上書きする）。
import React, {useState} from 'react';
import {Notice} from '../ui/Notice.jsx';
import {todayJst} from '../billing/receipt-model.mjs';
import {contractPayload} from './acq-mg-form-model.mjs';

const TRIGGERS = [['signing', '署名'], ['delivery', '納品'], ['release', '公開'], ['date', '日付']];
const blankForm = () => ({
  code: '', title: '', partnerId: '', workIds: [], consideration: 'mg', mgAmount: '', startsOn: todayJst(), endsOn: '',
  recoupBasis: 'platform_net', platformRate: '0', agencyFee: '', overage: 'yes', overageRate: '50', holdAgreementRef: '',
  multiWork: 'actual', schedule: [{trigger: 'signing', amount: '', dueOn: ''}], deductions: [], cycleKind: 'quarterly', anchorMonth: '3', reason: '契約書から登録',
});

export function ContractForm({request, partners = [], works = [], onSaved, onCancel}) {
  const [f, setF] = useState(blankForm);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setF((v) => ({...v, [key]: e.target.value}));
  const setRow = (list, index, key) => (e) => setF((v) => ({...v, [list]: v[list].map((r, i) => (i === index ? {...r, [key]: e.target.value} : r))}));
  const toggleWork = (id) => setF((v) => ({...v, workIds: v.workIds.includes(id) ? v.workIds.filter((x) => x !== id) : [...v.workIds, id]}));
  const save = async (e) => {
    e.preventDefault();
    try {
      const result = await request('/acq-mg/contracts', {method: 'POST', body: JSON.stringify(contractPayload(f))});
      setError(null); onSaved?.(result);
    } catch (err) { setError(err); }
  };
  return (
    <form className="acq-contract-form stack" onSubmit={save}>
      <h3>契約</h3>
      {error && <Notice error={error} />}
      <div className="acq-grid">
        <label>契約番号<input required value={f.code} onChange={set('code')} placeholder="ACQ-001" aria-label="契約の番号" /></label>
        <label>題<input required value={f.title} onChange={set('title')} /></label>
        <label>権利元<select required value={f.partnerId} onChange={set('partnerId')}><option value="">選ぶ</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>対価<select value={f.consideration} onChange={set('consideration')}><option value="mg">MG</option><option value="buyout">買切</option></select></label>
        <label>MG の額（円）<input required inputMode="numeric" value={f.mgAmount} onChange={set('mgAmount')} /></label>
        <label>開始日<input required type="date" value={f.startsOn} onChange={set('startsOn')} /></label>
        <label>終了日<input required type="date" value={f.endsOn} onChange={set('endsOn')} /></label>
        <label>回収の基礎<select value={f.recoupBasis} onChange={set('recoupBasis')}><option value="platform_net">PF の控除後</option><option value="after_fee">手数料の控除後</option></select></label>
        <label>PF の率（%）<input inputMode="decimal" value={f.platformRate} onChange={set('platformRate')} /></label>
        {f.recoupBasis === 'after_fee' && <label>手数料の率（%）<input required inputMode="decimal" value={f.agencyFee} onChange={set('agencyFee')} /></label>}
        {f.consideration === 'mg' && <label>超過後の分配<select value={f.overage} onChange={set('overage')}><option value="yes">有り</option><option value="no">無し</option><option value="unknown">未登録（保留）</option></select></label>}
        {f.consideration === 'mg' && f.overage === 'yes' && <label>権利元へ払う率（%）<input required inputMode="decimal" value={f.overageRate} onChange={set('overageRate')} /></label>}
        <label>報告の周期<select value={f.cycleKind} onChange={set('cycleKind')}><option value="monthly">毎月</option><option value="quarterly">3か月</option><option value="semiannual">半年</option><option value="annual">1年</option></select></label>
        {['quarterly', 'semiannual', 'annual'].includes(f.cycleKind) && <label>基準月<input type="number" min="1" max="12" value={f.anchorMonth} onChange={set('anchorMonth')} /></label>}
      </div>
      <fieldset><legend>対象作品</legend>
        <div className="acq-checks">{works.map((w) => <label key={w.id}><input type="checkbox" checked={f.workIds.includes(String(w.id))} onChange={() => toggleWork(String(w.id))} />{w.title}</label>)}</div>
        {f.workIds.length > 1 && (
          <div className="acq-grid">
            <label>作品をまたぐときの分け方<select value={f.multiWork} onChange={set('multiWork')}><option value="actual">実績の比で分ける</option><option value="hold_until_total">全体の超過まで分配しない</option></select></label>
            {f.multiWork === 'hold_until_total' && <label>約束の根拠<input required value={f.holdAgreementRef} onChange={set('holdAgreementRef')} placeholder="契約書 第◯条" /></label>}
          </div>
        )}
      </fieldset>
      {f.consideration === 'mg' && (
        <fieldset><legend>支払予定</legend>
          {f.schedule.map((s, i) => (
            <div className="acq-form" key={i}>
              <select value={s.trigger} onChange={setRow('schedule', i, 'trigger')} aria-label="きっかけ">{TRIGGERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <input inputMode="numeric" placeholder="円" value={s.amount} onChange={setRow('schedule', i, 'amount')} aria-label="額" />
              {s.trigger === 'date' && <input type="date" value={s.dueOn} onChange={setRow('schedule', i, 'dueOn')} aria-label="予定日" />}
              <button type="button" className="secondary" onClick={() => setF((v) => ({...v, schedule: v.schedule.filter((_, n) => n !== i)}))}>外す</button>
            </div>
          ))}
          <button type="button" className="secondary" onClick={() => setF((v) => ({...v, schedule: [...v.schedule, {trigger: 'delivery', amount: '', dueOn: ''}]}))}>回を足す</button>
        </fieldset>
      )}
      <fieldset><legend>控除費目</legend>
        {f.deductions.map((d, i) => (
          <div className="acq-form" key={i}>
            <input placeholder="費目" value={d.category} onChange={setRow('deductions', i, 'category')} aria-label="費目" />
            <input inputMode="numeric" placeholder="上限（円・任意）" value={d.capAmount} onChange={setRow('deductions', i, 'capAmount')} aria-label="上限" />
            <input required placeholder="根拠（契約 第◯条）" value={d.sourceRef} onChange={setRow('deductions', i, 'sourceRef')} aria-label="根拠" />
            <button type="button" className="secondary" onClick={() => setF((v) => ({...v, deductions: v.deductions.filter((_, n) => n !== i)}))}>外す</button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setF((v) => ({...v, deductions: [...v.deductions, {category: '', capAmount: '', sourceRef: ''}]}))}>費目を足す</button>
      </fieldset>
      <label>登録の理由<input required value={f.reason} onChange={set('reason')} /></label>
      <div className="acq-form"><button type="submit">登録</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>やめる</button>}</div>
    </form>
  );
}

// 自動で結べない報告を、人が契約を選び理由を書いて決める（問い3 A）
export function ManualLink({request, candidate, contracts, onDone}) {
  const [termVersionId, setTermVersionId] = useState(String(candidate.termVersionIds[0] ?? contracts[0]?.termVersionId ?? ''));
  const [decision, setDecision] = useState('include');
  const [reportBasis, setReportBasis] = useState('net');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const save = async () => {
    try {
      await request('/acq-mg/report-links', {method: 'POST', body: JSON.stringify({reportId: candidate.reportId, workId: candidate.workId, termVersionId: Number(termVersionId), decidedBy: 'human', decision, reportBasis, reason})});
      setError(null); onDone?.();
    } catch (err) { setError(err); }
  };
  return (
    <div className="acq-form">
      {error && <Notice error={error} compact />}
      <select value={termVersionId} onChange={(e) => setTermVersionId(e.target.value)} aria-label="契約">{contracts.filter((k) => k.termVersionId && k.workIds.includes(candidate.workId)).map((k) => <option key={k.id} value={k.termVersionId}>{k.code}</option>)}</select>
      <select value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="判断"><option value="include">入れる</option><option value="exclude">外す</option></select>
      <select value={reportBasis} onChange={(e) => setReportBasis(e.target.value)} aria-label="報告の額"><option value="net">控除後</option><option value="gross">控除前</option></select>
      <input placeholder="理由" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="理由" />
      <button type="button" onClick={save} disabled={!reason.trim() || !termVersionId}>決める</button>
    </div>
  );
}
