// 流通別の販売条件の月別表示。前月・翌月で送り、その月に解禁・終了する条件と販売中の条件を並べる。月は URL の rm に残る。
import React from 'react';
import {useShell} from '../shell/context.mjs';
import {dateJst, month as monthText} from '../ui/format.mjs';
import {releaseMonthGroups, shiftMonth} from './release-month-model.mjs';

function Group({title, rows, dateKey, dateLabel, onOpen, empty}) {
  return (
    <div className="rm-group">
      <h4>{title}（{rows.length}件）</h4>
      {rows.length ? (
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              <button type="button" className="text" onClick={() => onOpen?.(row)}>
                <strong>{row.work_title}</strong>・{row.distribution}・{row.territory || '地域未確認'}
              </button>
              <small>{dateLabel} {row[dateKey] ? dateJst(row[dateKey]) : '未確認'}・{row.status_label}</small>
            </li>
          ))}
        </ul>
      ) : <p className="rp-muted">{empty}</p>}
    </div>
  );
}

export function ReleaseMonthView({rows, asOf, onOpen}) {
  const shell = useShell();
  const fallback = String(asOf || '').slice(0, 7);
  const param = shell.getParam('rm', '');
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(param) ? param : fallback;
  const groups = releaseMonthGroups(rows, month);
  const go = (n) => shell.setParam('rm', shiftMonth(month, n), {replace: true});
  return (
    <section className="card so-section rm-view" aria-label="月別の解禁・終了">
      <header className="rm-head">
        <h3>月別の解禁・終了（{monthText(month)}）</h3>
        <div className="on-form-actions">
          <button type="button" className="secondary" onClick={() => go(-1)}>← 前月</button>
          <button type="button" className="secondary" onClick={() => shell.setParam('rm', null, {replace: true})} disabled={month === fallback}>確認日の月へ</button>
          <button type="button" className="secondary" onClick={() => go(1)}>翌月 →</button>
        </div>
      </header>
      <div className="rm-groups">
        <Group title="この月に解禁" rows={groups.starting} dateKey="release_on" dateLabel="解禁日" onOpen={onOpen} empty="この月に解禁する条件はありません" />
        <Group title="この月に販売終了" rows={groups.ending} dateKey="sales_end_on" dateLabel="販売終了日" onOpen={onOpen} empty="この月に終わる条件はありません" />
        <Group title="前の月から販売中" rows={groups.continuing} dateKey="release_on" dateLabel="解禁日" onOpen={onOpen} empty="前の月から続いている条件はありません" />
      </div>
      {(groups.undated.length > 0 || groups.withdrawn > 0) && (
        <p className="rp-muted">
          {groups.undated.length > 0 && `解禁日が未確認の条件 ${groups.undated.length}件は月に入れていません。`}
          {groups.withdrawn > 0 && `取り下げた条件 ${groups.withdrawn}件は表示していません。`}
        </p>
      )}
    </section>
  );
}

export default ReleaseMonthView;
