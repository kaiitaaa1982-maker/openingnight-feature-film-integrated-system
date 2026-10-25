// シナリオの比較（段A）の入力: 条件（期間・締めた月・目標額）・前提と行動（カスタム）・標準の値（仮置き）・商談ごとの指定。結果の表示は ScenarioResults.jsx。
// 入力は文字のまま form（scenario-form-model.mjs）に持ち、画面の外へは出さない。目標額は URL・localStorage・フォームの自動入力に載せない
// （autocomplete=off。入力欄に name を付けない。この画面は shell の URL の条件にも目標額を渡さない）。
// 目標額の欄は、額の例を placeholder に書かず（実額や人件費の倍率を連想させない。計画 K2-12）、保存しないので「…として登録」の案内も出さない（showPreview={false}）。
import React from 'react';
import {FormField} from '../../ui/FormField.jsx';
import {Notice} from '../../ui/Notice.jsx';
import {labelOf} from '../../ui/labels.mjs';
import {percentToBps, bpsToPercent} from '../../royalty/royalty-model.mjs';
import {SOURCES, SOURCE_LABELS, MARKET_ASSUMPTIONS} from './scenario-inputs.mjs';
import {ASSUMPTION_LABELS} from './scenario-model.mjs';
import {
  FORM_DEFAULTS, ASSUMPTION_UNITS, FIELD_LABELS, actionKey, decimalX100, x100Text, setIn, setOpportunity, chooseOpportunitySource, resetCustom, customIsEmpty,
} from './scenario-form-model.mjs';
import {actionLabel, assumptionBounds, assumptionTicks, assumptionValueText, countText, hoursText, yenText, SCENARIO_LABELS} from './scenario-view-model.mjs';

export const CUSTOM_FIRST_INPUT_ID = 'sc-custom-first';

// 数の入力欄（文字のまま持つ。name を付けず、自動補完しない）
function NumInput({id, label, value, onChange, unit, hint, wide = false}) {
  return (
    <label className={`sc-field${wide ? ' is-wide' : ''}`} htmlFor={id}>
      <span className="sc-field-label">{label}</span>
      <span className="sc-field-box">
        <input id={id} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
        {unit && <span className="sc-unit" aria-hidden="true">{unit}</span>}
      </span>
      {hint && <span className="sc-hint">{hint}</span>}
    </label>
  );
}

// ---------- 条件（期間・締めた月・目標額） ----------

export function ConditionsForm({form, onForm, loading, ready, errors}) {
  const set = (path) => (value) => onForm((current) => setIn(current, path, value));
  return (
    <form className="sc-conditions" autoComplete="off" onSubmit={(event) => event.preventDefault()} aria-label="条件">
      <div className="sc-conditions-grid">
        <FormField type="month" label="期間の始まり" value={form.period.from} onChange={set(['period', 'from'])} />
        <FormField type="month" label="期間の終わり" value={form.period.to} onChange={set(['period', 'to'])} />
        <FormField type="month" label="締めた月" value={form.closedMonth} onChange={set(['closedMonth'])} hint="これより前は実績、あとは予測" />
        <FormField type="yen" label="目標（本人）" value={form.targets.selfYen} onChange={set(['targets', 'selfYen'])} placeholder="金額" showPreview={false}
          hint="年の粗利の目標（任意）" />
        <FormField type="yen" label="目標（会社）" value={form.targets.companyYen} onChange={set(['targets', 'companyYen'])} placeholder="金額" showPreview={false}
          hint="任意" />
      </div>
      <p className="sc-hint">目標額はこの入力欄にだけ置きます。URL・ブラウザの保存・入力欄の自動補完に残さず、送った要求の応答にだけ差・達成率・届く確率を出します。入力すると、自動で計算し直します。</p>
      <p className="sc-status-line" role="status" aria-live="polite" data-state={loading ? 'loading' : ready ? 'ready' : 'idle'}>
        {loading ? '計算しています…' : ready ? '最新の入力で計算済みです' : errors.length ? '入力を直すと計算します' : ''}
      </p>
      {errors.length > 0 && (
        <Notice tone="warn" title="入力を確かめてください（直るまで、前の計算の結果のままです）">
          <ul className="sc-errors">{errors.map((error) => <li key={`${error.field}:${error.message}`}>{error.message}</li>)}</ul>
        </Notice>
      )}
    </form>
  );
}

// ---------- 前提と行動（カスタム） ----------

const toNumber = (text, fallback) => {
  const value = Number(text);
  return text !== '' && Number.isFinite(value) ? value : fallback;
};

// 標準の前提の数（率は bp、入金の遅れは月）。入力途中で読めなければ既定
function standardAssumption(form, key) {
  const text = form.assumptions[key];
  if (key === 'paymentDelayMonths') return toNumber(text, FORM_DEFAULTS.assumptions[key]);
  return percentToBps(text) ?? FORM_DEFAULTS.assumptions[key];
}

function customAssumption(form, key) {
  const override = form.custom.assumptions[key];
  if (override === undefined) return standardAssumption(form, key);
  if (key === 'paymentDelayMonths') return toNumber(override, standardAssumption(form, key));
  return percentToBps(override) ?? standardAssumption(form, key);
}

// 前提の効きと同じ幅の目盛り（悲観・標準・楽観）。楽観・悲観の列は、このうち売上の倍率・回収の量・提案→契約の率・入金の遅れだけを動かす
function ScenarioTicks({name, standard}) {
  const ticks = assumptionTicks(name, standard);
  return <p className="sc-ticks">悲観 {assumptionValueText(name, ticks.pessimistic)}／標準 {assumptionValueText(name, ticks.standard)}／楽観 {assumptionValueText(name, ticks.optimistic)}</p>;
}

export function CustomPanel({form, onForm}) {
  const empty = customIsEmpty(form);
  const customLabel = SCENARIO_LABELS.custom;
  return (
    <section className="sc-panel" aria-labelledby="sc-custom-title" data-panel="custom">
      <div className="sc-panel-head">
        <h2 id="sc-custom-title">前提と行動（{customLabel}）</h2>
        <button type="button" className="secondary" disabled={empty} onClick={() => onForm(resetCustom)}>標準の値に戻す</button>
      </div>
      <p className="sc-hint">動かした値は「カスタム」の列に出ます。保存はしません（要求の本文で毎回計算します）。</p>

      <h3>行動（自分で決める件数）</h3>
      <p className="sc-hint">残りの期間の件数。段A は件数だけを動かします（1件の額と換算率は標準の値）。</p>
      {form.actions.map((row, index) => {
        const standard = decimalX100(row.count);
        const override = form.custom.actions[actionKey(row)];
        const current = override !== undefined ? decimalX100(override) ?? standard : standard;
        const id = index === 0 ? CUSTOM_FIRST_INPUT_ID : `sc-action-${index}`;
        const moved = override !== undefined;
        const max = Math.max((standard ?? 0) * 3, 1000);
        return (
          <div className="sc-ctl" key={actionKey(row)} data-action={actionKey(row)}>
            <label htmlFor={id}>
              <span className="sc-ctl-name">{actionLabel(row.source, row.step)}</span>
              <span className="sc-ctl-value">{current === null ? '—' : countText(current)}</span>
              {moved && <span className="sc-moved">変えた</span>}
              {row.source === 'contract_work' && <span className="sc-note-inline">実績は未接続（行動の見込だけ）</span>}
            </label>
            <input id={id} type="range" min={0} max={max} step={25} value={current ?? 0} disabled={standard === null} aria-valuetext={current === null ? undefined : countText(current)}
              onChange={(event) => {
                const next = Number(event.target.value);
                onForm((f) => setIn(f, ['custom', 'actions', actionKey(row)], next === standard ? undefined : x100Text(next)));
              }} />
            <p className="sc-ticks">標準 {standard === null ? '—' : countText(standard)}・1件 {hoursText(decimalX100(row.hours) ?? 0)}</p>
          </div>
        );
      })}

      <h3>市場の前提（自分では決められない値）</h3>
      <p className="sc-hint">楽観・悲観の目盛りは、標準から決まった幅で動かした値です。</p>
      {MARKET_ASSUMPTIONS.map((key) => {
        const standard = standardAssumption(form, key);
        const current = customAssumption(form, key);
        const bounds = assumptionBounds(key, standard);
        const moved = form.custom.assumptions[key] !== undefined;
        const id = `sc-assumption-${key}`;
        return (
          <div className="sc-ctl" key={key} data-assumption={key}>
            <label htmlFor={id}>
              <span className="sc-ctl-name">{ASSUMPTION_LABELS[key]}</span>
              <span className="sc-ctl-value">{assumptionValueText(key, current)}</span>
              {moved && <span className="sc-moved">変えた</span>}
            </label>
            <input id={id} type="range" min={bounds.min} max={bounds.max} step={bounds.step} value={Math.min(bounds.max, Math.max(bounds.min, current))}
              aria-valuetext={assumptionValueText(key, current)}
              onChange={(event) => {
                const next = Number(event.target.value);
                const text = key === 'paymentDelayMonths' ? String(next) : bpsToPercent(next);
                onForm((f) => setIn(f, ['custom', 'assumptions', key], next === standard ? undefined : text));
              }} />
            <ScenarioTicks name={key} standard={standard} />
          </div>
        );
      })}

      <ConversionList form={form} />
    </section>
  );
}

// 交渉の条件（動かさない）: 商談と行動の換算率。作り手の取り分の裏返しなので、シナリオでも逆算でも動かさない
function ConversionList({form}) {
  const lines = new Map();
  for (const row of form.actions) lines.set(`action:${actionKey(row)}`, `${actionLabel(row.source, row.step)}（行動）: ${row.conversionPct}%`);
  const bySource = new Map();
  for (const spec of form.opportunities ?? []) {
    if (!spec.source) continue;
    if (!bySource.has(spec.source)) bySource.set(spec.source, new Set());
    bySource.get(spec.source).add(spec.conversionPct);
  }
  for (const [source, values] of bySource) lines.set(`opp:${source}`, `${SOURCE_LABELS[source]}（商談）: ${[...values].map((value) => `${value}%`).join('・')}`);
  return (
    <>
      <h3>交渉の条件（動かさない）</h3>
      <p className="sc-hint">換算率は契約の版から読む値の仮置きです。作り手の取り分の裏返しになるので、シナリオでも逆算でも動かしません。</p>
      <ul className="sc-sub-list" data-list="conversions">{[...lines.values()].map((text) => <li key={text}>{text}</li>)}</ul>
    </>
  );
}

// ---------- 標準の値（仮置き） ----------

export function StandardPanel({form, onForm}) {
  const set = (path) => (value) => onForm((current) => setIn(current, path, value));
  return (
    <details className="sc-panel sc-fold" data-panel="standard">
      <summary><h2>標準の値を直す（仮置き）</h2></summary>
      <p className="sc-hint">確度・段の率・1件の額・換算率・窓口別の支払いの間は仮置きです（実績がたまったら直します）。標準を直すと、楽観・悲観・カスタムも動きます。</p>

      <h3>段階ごとの確度</h3>
      <div className="sc-fields">
        {Object.keys(FORM_DEFAULTS.stageProbabilityBps).map((stage) => (
          <NumInput key={stage} id={`sc-stage-${stage}`} label={FIELD_LABELS[stage]} unit="%" value={form.stageProbabilityPct[stage]} onChange={set(['stageProbabilityPct', stage])} />
        ))}
      </div>

      <h3>窓口（取引先の種類）ごとの支払いの間</h3>
      <p className="sc-hint">売上の月から入金までの月数。無い窓口の商談は、入金の月を決められません。</p>
      <div className="sc-fields">
        {Object.keys(form.paymentGapMonths).map((channel) => (
          <NumInput key={channel} id={`sc-gap-${channel}`} label={labelOf('partnerKind', channel)} unit="か月" value={form.paymentGapMonths[channel]} onChange={set(['paymentGapMonths', channel])} />
        ))}
      </div>

      <h3>市場の前提（標準）</h3>
      <div className="sc-fields">
        {MARKET_ASSUMPTIONS.map((key) => (
          <NumInput key={key} id={`sc-standard-${key}`} label={ASSUMPTION_LABELS[key]} unit={ASSUMPTION_UNITS[key]} value={form.assumptions[key]} onChange={set(['assumptions', key])} />
        ))}
      </div>

      <h3>標準の行動</h3>
      {form.actions.map((row, index) => (
        <fieldset className="sc-fields sc-action-fields" key={actionKey(row)}>
          <legend>{actionLabel(row.source, row.step)}</legend>
          <NumInput id={`sc-act-count-${index}`} label="件数" unit="件" value={row.count} onChange={set(['actions', index, 'count'])} />
          <NumInput id={`sc-act-deal-${index}`} label="1件の額" unit="円" value={row.dealYen} onChange={set(['actions', index, 'dealYen'])} />
          <NumInput id={`sc-act-conv-${index}`} label="換算率" unit="%" value={row.conversionPct} onChange={set(['actions', index, 'conversionPct'])} />
          <NumInput id={`sc-act-hours-${index}`} label="1件の時間" unit="時間" value={row.hours} onChange={set(['actions', index, 'hours'])} />
        </fieldset>
      ))}
    </details>
  );
}

// ---------- 商談ごとの指定 ----------

export function OpportunityPanel({form, response, onForm}) {
  const specs = new Map((form.opportunities ?? []).map((row) => [row.id, row]));
  const list = response?.opportunityList ?? [];
  const unspecified = list.filter((row) => row.stage !== 'lost' && !(specs.get(row.id)?.source)).length;
  return (
    <details className="sc-panel sc-fold" data-panel="opportunities">
      <summary><h2>商談ごとの指定（仮置き）</h2><span className="sc-sub">　{list.length}件{unspecified > 0 ? `・稼ぎ方が未指定 ${unspecified}件` : ''}</span></summary>
      <p className="sc-hint">商談には稼ぎ方と換算率がありません。ここで仮置きします（作品の稼ぎ方が1つだけなら自動で入れています）。稼ぎ方を指定しない商談は期待値に入れず、件数と額を明細に出します。売上の月は、空なら成約日の月です。</p>
      <div className="sc-table-wrap sc-tall">
        <table className="sc-table">
          <thead><tr><th scope="col">商談</th><th scope="col">段階</th><th scope="col">見込額</th><th scope="col">稼ぎ方</th><th scope="col">換算率</th><th scope="col">売上の月（任意）</th></tr></thead>
          <tbody>
            {list.map((row) => {
              const spec = specs.get(row.id) ?? {id: row.id, source: '', conversionPct: '', revenueMonth: ''};
              const name = `${row.name}`;
              return (
                <tr key={row.id} data-opportunity={row.id}>
                  <th scope="row">{row.name}<span className="sc-sub">　{row.workTitle}</span></th>
                  <td>{labelOf('opportunityStage', row.stage)}</td>
                  <td className="num">{row.expectedYen === null ? '未定' : yenText(row.expectedYen)}</td>
                  <td>
                    <select aria-label={`${name}の稼ぎ方`} value={spec.source} onChange={(event) => onForm((f) => chooseOpportunitySource(f, row.id, event.target.value))}>
                      <option value="">指定しない</option>
                      {SOURCES.map((source) => <option key={source} value={source}>{SOURCE_LABELS[source]}</option>)}
                    </select>
                  </td>
                  <td className="num"><span className="sc-field-box"><input type="text" inputMode="decimal" autoComplete="off" aria-label={`${name}の換算率（%）`} value={spec.conversionPct} disabled={!spec.source}
                    onChange={(event) => onForm((f) => setOpportunity(f, row.id, {conversionPct: event.target.value}))} /><span className="sc-unit" aria-hidden="true">%</span></span></td>
                  <td><input type="month" autoComplete="off" aria-label={`${name}の売上の月`} value={spec.revenueMonth} disabled={!spec.source}
                    onChange={(event) => onForm((f) => setOpportunity(f, row.id, {revenueMonth: event.target.value}))} /></td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={6} className="sc-empty-cell">財務の権限がある案件の商談がありません。</td></tr>}
          </tbody>
        </table>
      </div>
    </details>
  );
}
