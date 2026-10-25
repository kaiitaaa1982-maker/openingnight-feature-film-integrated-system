// 提案の振り返り（営業管理。会社ルートの plans/2026-10-22-folder-eigyo.md の問い10〜12）。
// 1回の提案＝1行に、条件・解禁までの日数・結果と点数・効いた要因・直前の相手の言葉を並べ、採用と不採用を比べる。
// 上に要因の集計（件数5未満は率を出さない）、下に3つの記録の入力（提案・結果と評価・接点の言葉）。取引先・作品の絞り込みは URL に残る（sppartner・spwork）。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useShell} from '../../shell/context.mjs';
import {Notice} from '../../ui/Notice.jsx';
import {yen} from '../../ui/format.mjs';
import {todayJst} from '../partner-list-model.mjs';
import {EXCLUSIVITY, FACTORS, NOTE_KINDS, OUTCOMES, SETTLEMENT_METHODS} from './proposal-model.mjs';
import './proposals.css';

const ADOPTED = new Set(['adopted', 'adopted_changed']);
const outcomeClass = (outcome) => (ADOPTED.has(outcome) ? 'sp-ok' : ['rejected', 'no_answer'].includes(outcome) ? 'sp-bad' : 'sp-mid');

function terms(row) {
  const parts = [SETTLEMENT_METHODS[row.settlementMethod] || row.settlementMethod];
  if (row.amountExTax != null) parts.push(yen(row.amountExTax));
  if (row.rateBps != null) parts.push(`${row.rateBps / 100}%`);
  if (row.termStart || row.termEnd) parts.push(`${row.termStart || '?'}〜${row.termEnd || '?'}`);
  if (row.exclusivity !== 'unknown') parts.push(EXCLUSIVITY[row.exclusivity]);
  return parts.join('・');
}

export function ProposalReview({request: requestProp}) {
  const shell = useShell();
  const requestRef = useRef(null);
  requestRef.current = requestProp || shell.request;
  const partnerId = shell.getParam('sppartner', '') || '';
  const workId = shell.getParam('spwork', '') || '';
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState(null);
  const query = new URLSearchParams({...(partnerId ? {partnerId} : {}), ...(workId ? {workId} : {})}).toString();

  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    requestRef.current(`/sales-proposals${query ? `?${query}` : ''}`)
      .then((body) => { if (live) setState({body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [query, revision]);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const body = state.body;

  const post = async (path, payload, done) => {
    setMessage(null);
    try {
      await requestRef.current(path, {method: 'POST', body: JSON.stringify(payload)});
      setMessage({tone: 'ok', text: done});
      reload();
      return true;
    } catch (error) {
      setMessage({tone: 'bad', text: error.message || '記録できませんでした'});
      return false;
    }
  };

  return (
    <section className="card sp-page" aria-label="提案の振り返り">
      <header className="sp-head">
        <h2>提案の振り返り</h2>
        <label>取引先 <select value={partnerId} onChange={(event) => shell.setParam('sppartner', event.target.value || null, {replace: true})}>
          <option value="">すべて</option>
          {(body?.partners || []).map((partner) => <option key={partner.id} value={partner.id}>{partner.code} {partner.name}</option>)}
        </select></label>
        <label>作品 <select value={workId} onChange={(event) => shell.setParam('spwork', event.target.value || null, {replace: true})}>
          <option value="">すべて</option>
          {(body?.works || []).map((work) => <option key={work.id} value={work.id}>{work.code} {work.title}</option>)}
        </select></label>
        <a className="sp-download" href={`/api/sales-proposals/export.csv${query ? `?${query}` : ''}`} download>つないだ表を落とす（CSV）</a>
      </header>
      {state.error && <Notice error={state.error} onRetry={reload} />}
      {message && <p className={`sp-message sp-${message.tone}`} role="status">{message.text}</p>}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {body && (
        <>
          <FactorTally tally={body.factorTally} />
          <div className="sp-scroll">
            <table className="sp-list" aria-label="提案の一覧">
              <thead><tr><th>提案日</th><th>作品・取引先</th><th>窓口</th><th>条件</th><th>解禁まで</th><th>結果</th><th>点</th><th>効いた要因</th><th>直前の相手の言葉（温度）</th></tr></thead>
              <tbody>
                {!body.rows.length && <tr><td colSpan={9} className="rp-muted">0件</td></tr>}
                {body.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.proposedOn}</td>
                    <td>{row.workCode} {row.workTitle}<br /><span className="rp-muted">{row.partnerName}</span></td>
                    <td>{row.windows.map((w) => w.typeLabel).join('・') || '—'}</td>
                    <td>{terms(row)}{row.pitchNote ? <><br /><span className="rp-muted">{row.pitchNote}</span></> : null}</td>
                    <td>{row.leadDays == null ? '—' : `${row.leadDays}日`}</td>
                    <td className={row.review ? outcomeClass(row.review.outcome) : 'sp-mid'}>{row.review ? OUTCOMES[row.review.outcome] : '—'}</td>
                    <td>{row.review?.score ?? '—'}</td>
                    <td>{(row.review?.factors || []).map((f) => <span key={f.factor} className={f.effect === 'plus' ? 'sp-plus' : 'sp-minus'}>{f.effect === 'plus' ? '＋' : '−'}{FACTORS[f.factor]} </span>)}</td>
                    <td>{row.lastWords ? `「${row.lastWords.body}」（${row.lastWords.tone ?? '—'}）` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sp-forms">
            <OpportunityForm body={body} onSubmit={(payload) => post('/sales-opportunities', payload, '営業案件を作りました')} />
            <ProposalForm body={body} onSubmit={(payload) => post('/sales-proposals', payload, '提案を記録しました')} />
            <ReviewForm body={body} onSubmit={(id, payload) => post(`/sales-proposals/${id}/reviews`, payload, '結果と評価を記録しました')} />
            <NoteForm body={body} onSubmit={(payload) => post('/sales-activity-notes', payload, '接点の言葉を記録しました')} />
          </div>
        </>
      )}
    </section>
  );
}

function FactorTally({tally = []}) {
  if (!tally.length) return null;
  return (
    <table className="sp-tally" aria-label="要因の集計">
      <thead><tr><th>要因</th><th>採用で＋</th><th>採用で−</th><th>不採用で＋</th><th>不採用で−</th><th>採用率</th></tr></thead>
      <tbody>{tally.map((t) => (
        <tr key={t.factor}><th scope="row">{t.label}</th><td>{t.adoptedPlus}</td><td>{t.adoptedMinus}</td><td>{t.rejectedPlus}</td><td>{t.rejectedMinus}</td>
          <td className="rp-muted">{t.enough ? `${t.adoptedRateBps / 100}%（${t.count}件）` : `—（${t.count}件）`}</td></tr>
      ))}</tbody>
    </table>
  );
}

const STAGES = {lead: '見込み', proposal: '提案', negotiation: '交渉', won: '成立', lost: '失注'};

function OpportunityForm({body, onSubmit}) {
  const [values, setValues] = useState({workId: '', partnerId: '', name: '', stage: 'lead', expectedYen: '', closeDate: ''});
  const set = (key) => (event) => setValues((v) => ({...v, [key]: event.target.value}));
  const submit = async (event) => {
    event.preventDefault();
    if (await onSubmit(values)) setValues((v) => ({...v, name: '', expectedYen: '', closeDate: ''}));
  };
  return (
    <form className="sp-form" onSubmit={submit} aria-label="営業案件を作る">
      <h3>営業案件を作る</h3>
      <label>作品 <select required value={values.workId} onChange={set('workId')}>
        <option value="">選ぶ</option>
        {body.works.map((w) => <option key={w.id} value={w.id}>{w.code} {w.title}</option>)}
      </select></label>
      <label>取引先 <select required value={values.partnerId} onChange={set('partnerId')}>
        <option value="">選ぶ</option>
        {body.partners.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
      </select></label>
      <label>名前 <input required maxLength={200} value={values.name} onChange={set('name')} /></label>
      <label>段階 <select value={values.stage} onChange={set('stage')}>{Object.entries(STAGES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <label>見込額（円） <input inputMode="numeric" value={values.expectedYen} onChange={set('expectedYen')} /></label>
      <label>予定日 <input type="date" value={values.closeDate} onChange={set('closeDate')} /></label>
      <button type="submit">作る</button>
    </form>
  );
}

function ProposalForm({body, onSubmit}) {
  const [values, setValues] = useState({opportunityId: '', proposedOn: todayJst(), settlementMethod: 'unverified', amountExTax: '', ratePercent: '', termStart: '', termEnd: '', exclusivity: 'unknown', pitchNote: '', windowIds: []});
  const set = (key) => (event) => setValues((v) => ({...v, [key]: event.target.value}));
  const opportunity = body.opportunities.find((o) => String(o.id) === String(values.opportunityId));
  const windows = useMemo(() => (opportunity ? body.windows.filter((w) => w.workId === opportunity.workId && w.status !== 'withdrawn') : []), [opportunity, body.windows]);
  const toggle = (id) => setValues((v) => ({...v, windowIds: v.windowIds.includes(id) ? v.windowIds.filter((x) => x !== id) : [...v.windowIds, id]}));
  const submit = async (event) => {
    event.preventDefault();
    if (await onSubmit({...values, windowIds: values.windowIds})) setValues((v) => ({...v, amountExTax: '', ratePercent: '', pitchNote: '', windowIds: []}));
  };
  return (
    <form className="sp-form" onSubmit={submit} aria-label="提案を記録する">
      <h3>提案を記録する</h3>
      <label>営業案件 <select required value={values.opportunityId} onChange={set('opportunityId')}>
        <option value="">選ぶ</option>
        {body.opportunities.map((o) => <option key={o.id} value={o.id}>{o.partnerName}・{o.name}</option>)}
      </select></label>
      <label>提案日 <input type="date" required value={values.proposedOn} onChange={set('proposedOn')} /></label>
      <fieldset><legend>窓口（全作品のウィンドウ）</legend>
        {opportunity && !windows.length && <span className="rp-muted">0件</span>}
        {windows.map((w) => <label key={w.windowId} className="sp-check"><input type="checkbox" checked={values.windowIds.includes(w.windowId)} onChange={() => toggle(w.windowId)} />{w.typeLabel}（{w.startOn || '未定'}）</label>)}
      </fieldset>
      <label>精算 <select value={values.settlementMethod} onChange={set('settlementMethod')}>{Object.entries(SETTLEMENT_METHODS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <label>金額（税抜・円） <input inputMode="numeric" value={values.amountExTax} onChange={set('amountExTax')} disabled={values.settlementMethod === 'RS'} /></label>
      <label>料率（%） <input inputMode="decimal" value={values.ratePercent} onChange={set('ratePercent')} disabled={values.settlementMethod === 'FLAT'} /></label>
      <label>期間 <input type="date" value={values.termStart} onChange={set('termStart')} aria-label="期間の開始" />〜<input type="date" value={values.termEnd} onChange={set('termEnd')} aria-label="期間の終了" /></label>
      <label>独占 <select value={values.exclusivity} onChange={set('exclusivity')}>{Object.entries(EXCLUSIVITY).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <label className="sp-wide">提案の内容 <textarea rows={2} value={values.pitchNote} onChange={set('pitchNote')} maxLength={2000} /></label>
      <button type="submit">記録する</button>
    </form>
  );
}

function ReviewForm({body, onSubmit}) {
  const [values, setValues] = useState({proposalId: '', reviewedOn: todayJst(), outcome: 'adopted', score: '3', worked: '', missed: '', agreementId: '', factors: {}});
  const set = (key) => (event) => setValues((v) => ({...v, [key]: event.target.value}));
  const proposal = body.rows.find((row) => String(row.id) === String(values.proposalId));
  const agreements = proposal ? body.agreements.filter((a) => a.opportunityId === proposal.opportunityId) : [];
  const setFactor = (factor, effect) => setValues((v) => ({...v, factors: {...v.factors, [factor]: v.factors[factor] === effect ? '' : effect}}));
  const submit = async (event) => {
    event.preventDefault();
    const {proposalId, ...payload} = values;
    if (await onSubmit(proposalId, payload)) setValues((v) => ({...v, worked: '', missed: '', agreementId: '', factors: {}}));
  };
  return (
    <form className="sp-form" onSubmit={submit} aria-label="結果と評価を記録する">
      <h3>結果と評価を記録する</h3>
      <label>提案 <select required value={values.proposalId} onChange={set('proposalId')}>
        <option value="">選ぶ</option>
        {body.rows.map((row) => <option key={row.id} value={row.id}>{row.proposedOn}・{row.partnerName}・{row.workTitle}</option>)}
      </select></label>
      <label>評価した日 <input type="date" required value={values.reviewedOn} onChange={set('reviewedOn')} /></label>
      <label>結果 <select value={values.outcome} onChange={set('outcome')}>{Object.entries(OUTCOMES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <label>点数 <select value={values.score} onChange={set('score')}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <fieldset className="sp-wide"><legend>効いた要因</legend>
        {Object.entries(FACTORS).map(([factor, label]) => (
          <span key={factor} className="sp-factor">{label}
            <button type="button" aria-pressed={values.factors[factor] === 'plus'} onClick={() => setFactor(factor, 'plus')}>＋</button>
            <button type="button" aria-pressed={values.factors[factor] === 'minus'} onClick={() => setFactor(factor, 'minus')}>−</button>
          </span>
        ))}
      </fieldset>
      {ADOPTED.has(values.outcome) && agreements.length > 0 && (
        <label>契約 <select value={values.agreementId} onChange={set('agreementId')}><option value="">結ばない</option>{agreements.map((a) => <option key={a.id} value={a.id}>{a.contractCode} {a.title}</option>)}</select></label>
      )}
      <label className="sp-wide">効いたこと <textarea rows={2} value={values.worked} onChange={set('worked')} maxLength={2000} /></label>
      <label className="sp-wide">足りなかったこと <textarea rows={2} value={values.missed} onChange={set('missed')} maxLength={2000} /></label>
      <button type="submit">記録する</button>
    </form>
  );
}

function NoteForm({body, onSubmit}) {
  const [values, setValues] = useState({activityId: '', noteKind: 'their_words', body: '', tone: ''});
  const set = (key) => (event) => setValues((v) => ({...v, [key]: event.target.value}));
  const opportunityName = new Map(body.opportunities.map((o) => [o.id, `${o.partnerName}・${o.name}`]));
  const submit = async (event) => {
    event.preventDefault();
    if (await onSubmit(values)) setValues((v) => ({...v, body: '', tone: ''}));
  };
  return (
    <form className="sp-form" onSubmit={submit} aria-label="接点の言葉を記録する">
      <h3>接点の言葉を記録する</h3>
      <label>営業活動 <select required value={values.activityId} onChange={set('activityId')}>
        <option value="">選ぶ</option>
        {body.activities.map((a) => <option key={a.id} value={a.id}>{a.occurredOn}・{opportunityName.get(a.opportunityId)}・{a.summary.slice(0, 20)}</option>)}
      </select></label>
      <label>種類 <select value={values.noteKind} onChange={set('noteKind')}>{Object.entries(NOTE_KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <label>温度 <select value={values.tone} onChange={set('tone')}><option value="">付けない</option>{[2, 1, 0, -1, -2].map((n) => <option key={n} value={n}>{n > 0 ? `+${n}` : n}</option>)}</select></label>
      <label className="sp-wide">言葉 <textarea rows={2} required value={values.body} onChange={set('body')} maxLength={2000} /></label>
      <button type="submit">記録する</button>
    </form>
  );
}

export default ProposalReview;
