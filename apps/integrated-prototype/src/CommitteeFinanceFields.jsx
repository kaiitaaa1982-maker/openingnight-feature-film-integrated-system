// 製作委員会の出資・控除の入力と、権利・分配／権利の調達／製作委員会の画面で共通に使う小さな入力部品。
// 金額は FormField の yen（全角・カンマ・¥・円を吸収）、率は PercentField（「12.5」「１２．５％」を吸収）で入れる。
import React, {useState} from 'react';
import {FormField} from './ui/FormField.jsx';
import {Notice} from './ui/Notice.jsx';
import {technicalDetail} from './ui/api-client.mjs';
import {yen} from './ui/format.mjs';
import {parsePercent, parseDayOfMonth, parseMoney, problemText, DEDUCTION_CATEGORY_OPTIONS} from './rights/rights-ui-model.mjs';

// 率（%）の入力。保存値ではなく入力中の文字を持ち、欄を離れたときに理由を出す。
export function PercentField({label, value, onChange, required = false, hint, disabled = false, name}) {
  const [touched, setTouched] = useState(false);
  const parsed = parsePercent(value);
  const error = touched && (!parsed.ok ? parsed.error : required && parsed.value === null ? `${label}を入力してください` : '');
  return (
    <FormField type="text" name={name} label={`${label}（%）`} value={value} required={required} disabled={disabled}
      hint={hint || '例: 12.5（0〜100）'} error={error || undefined} placeholder="例: 12.5"
      onChange={(next) => onChange(next)} onBlur={() => setTouched(true)} />
  );
}

// 日（締め日・報告日・支払日）の入力。「月末」か 1〜31。
export function DayField({label, value, onChange, required = true, disabled = false}) {
  const [touched, setTouched] = useState(false);
  const parsed = parseDayOfMonth(value);
  return (
    <FormField type="text" label={label} value={value} required={required} disabled={disabled} hint="「月末」または1〜31"
      error={touched && !parsed.ok ? parsed.error : undefined} onChange={(next) => onChange(next)} onBlur={() => setTouched(true)} />
  );
}

// API の失敗を日本語で示す（サーバーの生の文は技術情報の折りたたみへ）。一意の違反などは、応答の dbError（共通のエラーの種類）から言い換える（problemText）
export function ProblemNotice({error, onRetry, onDismiss, title}) {
  if (!error) return null;
  return (
    <Notice tone="error" title={title} message={problemText(error)} technical={technicalDetail(error)}
      onRetry={onRetry} onDismiss={onDismiss} />
  );
}

const sumMoney = (values) => values.reduce((total, value) => {
  const parsed = parseMoney(value);
  return parsed.ok && parsed.value !== null ? total + parsed.value : total;
}, 0);

// 製作費・出資額。契約で確定したときだけ入れる（入れないと製作費の回収残高は出さない）。
export function FundingFields({value, onChange, members, disabled = false}) {
  const enabled = value !== null && value !== undefined;
  const amountOf = (partnerId) => value?.investments?.find((item) => Number(item.partnerId) === Number(partnerId))?.amountYen ?? '';
  const setAmount = (partnerId, amountYen) => onChange({
    ...value,
    investments: members.map((member) => ({partnerId: member.partnerId, amountYen: Number(member.partnerId) === Number(partnerId) ? amountYen : amountOf(member.partnerId)})),
  });
  const cost = parseMoney(value?.productionCostYen);
  const invested = enabled ? sumMoney(members.map((member) => amountOf(member.partnerId))) : 0;
  const matched = enabled && cost.ok && cost.value !== null && cost.value === invested;
  return (
    <div className="stack">
      <label className="check">
        <input type="checkbox" checked={enabled} disabled={disabled || !members.length}
          onChange={(event) => onChange(event.target.checked ? {productionCostYen: '', investments: members.map((member) => ({partnerId: member.partnerId, amountYen: ''}))} : null)} />
        <span>契約で確定した製作費と出資額を入力する（入れないときは製作費の回収残高を出しません）</span>
      </label>
      {!members.length && <p className="rt-muted">出資者は調達案件を選ぶと表示されます。</p>}
      {enabled && (
        <>
          <div className="on-form-grid">
            <FormField type="yen" label="製作費の総額" required value={value.productionCostYen} disabled={disabled}
              onChange={(next) => onChange({...value, productionCostYen: next})} />
            {members.map((member) => (
              <FormField key={member.partnerId} type="yen" label={`${member.partnerName}の出資額`} required value={amountOf(member.partnerId)} disabled={disabled}
                onChange={(next) => setAmount(member.partnerId, next)} />
            ))}
          </div>
          <p className="rt-muted">
            出資額の合計 {yen(invested)}／製作費の総額 {cost.ok && cost.value !== null ? yen(cost.value) : '未入力'}
            {cost.ok && cost.value !== null && <span className={`rt-state ${matched ? 'is-ok' : 'is-warn'}`}>（{matched ? '一致' : '不一致'}）</span>}
            。持分は調達案件の明示値を使います。
          </p>
        </>
      )}
    </div>
  );
}

// 権利処理費・製作費の回収（手数料・経費を引いた後に、根拠資料で確定した額を控除する）
export function DeductionFields({rows, onChange, reports, partners, funding, disabled = false}) {
  const change = (index, key, next) => onChange(rows.map((row, i) => (i === index ? {...row, [key]: next} : row)));
  const reportOptions = reports.map((report) => ({value: String(report.reportId), label: report.label || '選択した売上報告'}));
  const partnerOptions = partners.map((partner) => ({value: String(partner.id), label: partner.name}));
  return (
    <div className="stack">
      <p className="rt-muted">
        手数料・経費を控除した後に、根拠資料で確定した額を控除します。登録済みの経費と同じ費用を重ねて指定しないでください。
        製作費の総額：{funding?.productionCostYen === null || funding?.productionCostYen === undefined ? '未登録' : yen(funding.productionCostYen)}
      </p>
      {rows.map((row, index) => (
        <div className="rt-row" key={index}>
          <div className="rt-row-head">
            <span>追加の控除 {index + 1}</span>
            <button type="button" className="text" disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))}>この控除を外す</button>
          </div>
          <div className="on-form-grid">
            <FormField type="select" label="元の売上報告" required value={row.reportId} options={reportOptions} disabled={disabled} onChange={(next) => change(index, 'reportId', next)} />
            <FormField type="select" label="区分" required includeBlank={false} value={row.category} options={DEDUCTION_CATEGORY_OPTIONS} disabled={disabled} onChange={(next) => change(index, 'category', next)} />
            <FormField type="select" label="受取先" required value={row.recipientPartnerId} options={partnerOptions} disabled={disabled} onChange={(next) => change(index, 'recipientPartnerId', next)} />
            <FormField type="yen" label="控除額" required value={row.amountYen} disabled={disabled} onChange={(next) => change(index, 'amountYen', next)} />
            <FormField type="text" label="根拠の識別番号" required value={row.sourceReference} disabled={disabled} wide
              placeholder="契約・計算書・対象期を識別できる番号" onChange={(next) => change(index, 'sourceReference', next)} />
          </div>
        </div>
      ))}
      <div className="rt-actions">
        <button type="button" className="secondary" disabled={disabled || !reports.length}
          onClick={() => onChange([...rows, {reportId: reports.length === 1 ? String(reports[0].reportId) : '', category: 'royalty', recipientPartnerId: '', amountYen: '', sourceReference: ''}])}>
          控除を追加
        </button>
        {!reports.length && <span className="rt-muted">先に対象の売上報告を選んでください。</span>}
      </div>
    </div>
  );
}

