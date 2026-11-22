// 表の見本（mode local だけ。代表モードと本番には出さない）。共通の表（EditSheet）の動きを架空の値で確かめる。
// 未解決（未解決・全シーン）と経費（明細・日別・支払先別・費目別）の2つ。直した結果はこの画面の中だけに残り、保存しない。
// 見た目の決まり: core の docs/design/integrated-system-visual.md。UI指針: docs/design/ui-guidelines.md
import React, {useRef, useState} from 'react';
import {useShell} from '../../shell/context.mjs';
import {EditSheet} from '../EditSheet.jsx';
import {CLOSED_MESSAGE, PAYEES, expenseRows, expenseSheets, leftoverRows, leftoverSheets, newExpenseRow} from './sheet-sample-data.mjs';
import './sheet-sample.css';

const SAMPLES = [{id: 'leftover', label: '未解決'}, {id: 'expense', label: '経費'}];

export function SheetSampleClosed() {
  return <section className="ss" data-sheet-sample-open="false"><p className="ss-closed" role="status">{CLOSED_MESSAGE}</p></section>;
}

export default function SheetSample() {
  const shell = useShell();
  const [sample, setSample] = useState('leftover');
  const [leftovers, setLeftovers] = useState(leftoverRows);
  const [expenses, setExpenses] = useState(expenseRows);
  const [payees, setPayees] = useState(PAYEES);
  const [received, setReceived] = useState(0);
  const nextId = useRef(1);
  const nextPayee = useRef(1);

  if (shell.viewMode === 'representative') return <SheetSampleClosed />;

  // 呼び出し側の受け取り方の見本: 部品が渡す edits を数え、行を差し替える（本物の画面はここで版・取消の行を足す）
  const receive = (setRows) => ({edits, rows}) => {
    setRows(rows);
    setReceived((n) => n + edits.length);
  };
  const createPayee = (name) => {
    const option = {value: `P-NEW-${nextPayee.current++}`, label: name};
    setPayees((list) => [...list, option]);
    return option;
  };

  const leftoverList = leftoverSheets(leftovers);
  const counts = leftoverList[1].counts;
  const all = Object.values(counts).reduce((sum, n) => sum + n, 0);
  leftoverList[1].status = <>撮れた<b>{counts.撮れた}</b> ＋ 予定<b>{counts.予定}</b> ＋ 欠番<b>{counts.欠番}</b> ＋ 未解決<b>{counts.未解決}</b> ＝ 計<b>{all}</b></>;
  const open = leftovers.filter((row) => !row.to).length;

  const expenseList = expenseSheets(expenses, {payees, onCreatePayee: createPayee});
  expenseList[0].newRow = () => newExpenseRow(`N${nextId.current++}`);
  const unchecked = expenses.filter((row) => row.ok !== 'yes').length;
  // 空欄の金額は足さない（0 とみなさない）
  const total = expenses.filter((row) => Number.isInteger(row.amount)).reduce((sum, row) => sum + row.amount, 0);

  return (
    <section className="ss" data-sheet-sample-open="true">
      <div className="ss-head">
        <span className="ss-mark">見本</span>
        <div className="ss-switch" role="group" aria-label="見本">
          {SAMPLES.map((item) => <button key={item.id} type="button" aria-pressed={sample === item.id} onClick={() => setSample(item.id)}>{item.label}</button>)}
        </div>
        <span className="ss-received" data-received={received}>記録 <b>{received.toLocaleString('ja-JP')}</b></span>
      </div>
      {sample === 'leftover'
        ? <>
          <div className="ss-bar">
            <span className={`ss-alert${open ? '' : ' is-done'}`} data-open={open}>{open ? `! 未解決 ${open}` : '未解決 0'}</span>
          </div>
          <EditSheet key="leftover" label="未解決" sheets={leftoverList} onChange={receive(setLeftovers)} />
        </>
        : <>
          <div className="ss-bar">
            <span className={`ss-alert${unchecked ? '' : ' is-done'}`} data-unchecked={unchecked}>{unchecked ? `! 未確認 ${unchecked}` : '未確認 0'}</span>
            <span className="ss-total" data-total={total}><b>{total.toLocaleString('ja-JP')}</b> 円 {expenses.length}件</span>
          </div>
          <EditSheet key="expense" label="経費" sheets={expenseList} onChange={receive(setExpenses)} />
        </>}
    </section>
  );
}
