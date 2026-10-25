// MG 作品の一覧（受取 MG）。作品ごとに、MG の到達地点（回収の帯）と償却期間の経過（期間の帯）を1行に重ね、
// いまのペースで回収し終わる見込みの位置に目印を置く。赤くするのは「届かない見込」だけ（例外だけを目立たせる）。
// 行を押すと、月ごとの消化と、その契約の台帳の行（原本の参照つき）が開く。数字は mg-sell-list-model.mjs の純関数。
import React, {useMemo, useState} from 'react';
import {yen, rate, month as monthText} from '../ui/format.mjs';
import {buildSellList} from './sell-list-model.mjs';

// 万円の表示（表示だけ。小数1桁で丸めるのは toLocaleString に任せる）
const man = (value) => `${(value / 10000).toLocaleString('ja-JP', {maximumFractionDigits: 1})}万`;

function Bars({row}) {
  const recovered = row.rate === null ? 0 : Math.min(100, row.rate * 100);
  const elapsed = row.totalMonths ? (row.elapsedMonths / row.totalMonths) * 100 : 0;
  return (
    <div className="mgs-bars" aria-label={`回収 ${row.rate === null ? '—' : rate(row.rate)}、期間 ${row.elapsedMonths}/${row.totalMonths}か月`}>
      <span className="mgs-track"><span className="mgs-fill" style={{width: `${recovered}%`}} /></span>
      <span className="mgs-ttrack">
        <span className="mgs-tfill" style={{width: `${elapsed}%`}} />
        {row.state !== 'reached' && row.projectedPercent !== null && <span className={`mgs-proj${row.state === 'atRisk' ? ' is-risk' : ''}`} style={{left: `${row.projectedPercent}%`}} />}
      </span>
      <span className="mgs-cap"><span>{row.rate === null ? '—' : rate(row.rate)}</span><span>{row.elapsedMonths}/{row.totalMonths}か月</span></span>
    </div>
  );
}

function reachText(row) {
  if (row.state === 'reached') return row.reachedMonth ? `${monthText(row.reachedMonth)} 到達` : '到達';
  if (row.state === 'waiting') return '報告待ち';
  if (row.state === 'zero') return '—';
  if (!row.projectedMonth) return '見込なし';
  return `${monthText(row.projectedMonth)} 見込`;
}

function Detail({row, entries: raw, onOpen}) {
  const entries = useMemo(() => [...raw].sort((a, b) => String(a.accounting_month).localeCompare(String(b.accounting_month)) || Number(a.id) - Number(b.id)), [raw]);
  const max = Math.max(1, ...row.months.map((m) => m.appliedYen));
  let running = 0;
  return (
    <div className="mgs-detail">
      <div className="mgs-detail-head">
        <span className="mg-muted">{row.startsOn}〜{row.endsOn}・保証額 {yen(row.guaranteeYen)}・直近{Math.min(3, row.months.length)}回の平均 {yen(row.paceYen)}/月</span>
        <button type="button" className="secondary" onClick={() => onOpen(row.contractId)}>この契約を開く（報告の入力・訂正）</button>
      </div>
      {row.months.length > 0 && (
        <div className="mgs-month-bars" aria-label="計上月ごとの実充当">
          {row.months.map((m) => <span key={m.month} title={`${monthText(m.month)} ${yen(m.appliedYen)}`} style={{height: `${(m.appliedYen / max) * 100}%`}} />)}
        </div>
      )}
      {entries.length ? (
        <div className="mgs-scroll">
          <table className="mgs-table">
            <thead><tr><th>計上月</th><th>商品</th><th className="num">消化対象</th><th className="num">実充当</th><th className="num">累計の実充当</th><th>報告資料（原本）</th><th>確認</th></tr></thead>
            <tbody>
              {entries.map((e) => {
                running += Number(e.applied_recoup_yen);
                return (
                  <tr key={e.id}>
                    <td>{monthText(e.accounting_month)}</td><td>{e.sku}</td>
                    <td className="num">{yen(e.reported_eligible_yen)}</td><td className="num">{yen(e.applied_recoup_yen)}</td><td className="num">{yen(running)}</td>
                    <td>{e.source_reference}</td><td>{e.status === 'reviewed' ? '確認済み' : '未確認'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="mg-muted">報告なし</p>}
    </div>
  );
}

// items: MG 契約・台帳の画面が作る {contract, progress（contractProgress）, entries（その契約の有効な台帳の行）} の並び
export function MgSellList({items = [], partners = [], today, onOpen}) {
  const [open, setOpen] = useState(null);
  const {rows, summary} = useMemo(() => buildSellList({items, partners, today}), [items, partners, today]);
  const entriesOf = useMemo(() => new Map(items.map((item) => [Number(item.contract.id), item.entries])), [items]);
  if (!rows.length) return null;
  return (
    <section className="card mgs" aria-label="MG 作品の一覧">
      <header className="mg-section-head">
        <div>
          <h3>MG 作品の一覧</h3>
        </div>
      </header>
      <div className="mgs-kpis">
        <div><span>MG 契約</span><strong>{summary.contractCount}<small>件</small></strong></div>
        <div><span>回収</span><strong>{summary.rate === null ? '—' : rate(summary.rate)}</strong></div>
        <div><span>未回収</span><strong>{man(summary.remainingYen)}<small>円</small></strong></div>
        <div><span>到達</span><strong>{summary.reachedCount}<small>件</small></strong></div>
        <div className={summary.atRiskCount ? 'is-risk' : ''}><span>届かない見込</span><strong>{summary.atRiskCount}<small>件</small></strong></div>
      </div>
      <div className="mgs-scroll">
        <table className="mgs-table mgs-main">
          <thead><tr><th>作品・契約</th><th>取引先</th><th>回収 ／ 期間</th><th className="num">MG額</th><th className="num">残り</th><th className="num">期間の残り</th><th>到達</th><th>状態</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <React.Fragment key={row.contractId}>
                <tr className={`mgs-row${open === row.contractId ? ' is-open' : ''}`} onClick={() => setOpen(open === row.contractId ? null : row.contractId)}
                  tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === row.contractId ? null : row.contractId); } }} aria-expanded={open === row.contractId}>
                  <td><strong>{row.products.map((p) => p.name).join('・') || row.title}</strong><small>{row.code}｜{row.title}</small></td>
                  <td>{row.partnerName || '—'}</td>
                  <td className="mgs-bars-cell"><Bars row={row} /></td>
                  <td className="num">{man(row.guaranteeYen)}</td>
                  <td className="num">{row.remainingYen ? man(row.remainingYen) : <span className="mg-muted">超過 +{man(row.exceedYen)}</span>}</td>
                  <td className="num">{row.leftMonths}か月</td>
                  <td>{reachText(row)}{row.state === 'atRisk' && row.overrunMonths ? <span className="mgs-risk-text">（期限+{row.overrunMonths}か月）</span> : null}</td>
                  <td><span className={`mgs-st is-${row.tone}`}>{row.stateLabel}</span>{row.unverifiedCount > 0 && <small className="mg-diff">未確認 {row.unverifiedCount}</small>}</td>
                </tr>
                {open === row.contractId && <tr className="mgs-detail-row"><td colSpan={8}><Detail row={row} entries={entriesOf.get(row.contractId) || []} onOpen={onOpen} /></td></tr>}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
