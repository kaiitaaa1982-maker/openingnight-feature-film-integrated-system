// 制作の実費の画面（ページ ID `実費`、`?p=actual-lines`。フォルダ F04 プロダクション。会社ルートの plans/2026-11-20-genba-inbox.md の手順 14b。
// 要件 FR-EXP-PCOST-048〜052）。共通の表（EditSheet）に、明細（直せる）と日別・支払先別・費目別（読むだけ。受け口の合計）。
// 上に「! 未確認 N」（赤の面はここだけ）・累計（税込。確認済み・未確認の内訳）・今日の合計。
// 明細はセルを確定したらすぐ送る: 下書きは日付・支払先・費目・金額がそろったら足す、保存した行は取消と置き換え。成功したら読み直し、
// 失敗したら読み直して値を戻し、理由を表の上に1行で出す。戻すでは保存した行に何も送らない（記録は追記だけ）。
// 論理は actual-sheet-model.mjs（試験 test/actual-sheet-model.test.mjs）。見た目の決まり: core の docs/design/integrated-system-visual.md §1〜§5・§7
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import {EditSheet} from '../../ui/EditSheet.jsx';
import {int as formatInt} from '../../ui/format.mjs';
import {checkTargets, detailColumns, detailRows, draftRow, failureText, headline, planDetailChange, selectionFromSheet, summaryColumns, summaryRows,
  voidTargets} from './actual-sheet-model.mjs';
import './actual-lines.css';

const SUMMARIES = [{id: 'byDay', label: '日別'}, {id: 'byPayee', label: '支払先別'}, {id: 'byCategory', label: '費目別'}];
const NO_SELECTION = {selected: [], visible: [], range: false};

export default function ActualLines({request, workId}) {
  if (!workId) return <section className="al"><p className="al-mute">作品が未選択</p></section>;
  return <ActualLinesWork key={workId} request={request} workId={workId} />;
}

function ActualLinesWork({request, workId}) {
  const [data, setData] = useState(null), [error, setError] = useState(null);
  const [failure, setFailure] = useState(''), [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState([]), [shown, setShown] = useState(null);
  const [selection, setSelection] = useState(NO_SELECTION);
  const [voiding, setVoiding] = useState(null);
  // 送って読み直したら進める（部品の戻すの履歴を空にする。保存した変更は戻せない。下書きだけの変更は戻せる）
  const [epoch, setEpoch] = useState(0);
  const nextDraft = useRef(1);
  const url = `/expenses/works/${workId}/actual-lines`;

  const load = useCallback(async () => {
    try {
      setData(await request(url));
      setError(null);
      return true;
    } catch (failed) {
      setError(failed);
      return false;
    } finally {
      setShown(null);
    }
  }, [request, url]);
  useEffect(() => { load(); }, [load]);
  // 部品が渡す選択（明細のシートのときだけ。集計のシートでは選んでいない扱い）
  const onSelect = useCallback((info) => setSelection(info.sheet === 'detail' ? selectionFromSheet(info) : NO_SELECTION), []);

  if (error && !data) return <section className="al"><Notice error={error} onRetry={load} retryLabel="読み直す" /></section>;
  if (!data) return <section className="al"><p aria-busy="true">読込中…</p></section>;

  const year = Number(String(data.today).slice(0, 4));
  const top = headline(data);
  const saved = detailRows(data.lines);
  const rows = shown ?? [...saved, ...drafts];
  const writable = Boolean(data.canWrite);
  const check = checkTargets({lines: data.lines, selection});
  const toVoid = voidTargets({lines: data.lines, selection});

  // 送る（足す → 取消と置き換えの順）。途中で断られたら止め、読み直して値を戻し、理由を1行で出す
  async function send(work, fallback = '') {
    setBusy(true);
    let message = fallback;
    try {
      await work();
    } catch (failed) {
      message = failureText(failed);
    }
    await load();
    setEpoch((n) => n + 1);
    setFailure(message);
    setBusy(false);
  }

  function onChange({sheet, edits, rows: after, action}) {
    if (sheet !== 'detail' || busy) return;
    const plan = planDetailChange({edits, action, rows: after, lines: data.lines});
    setDrafts(plan.drafts);
    const fallback = plan.errors[0]?.message ?? '';
    if (!plan.posts.length && !plan.voids.length) {
      if (fallback) {
        setFailure(fallback);
        setEpoch((n) => n + 1);
      }
      return;
    }
    // 送っている間は直した値のまま見せる（読み直すと受け口の値に戻る）
    setShown(after);
    send(async () => {
      for (const batch of plan.posts) {
        await request(url, {method: 'POST', body: JSON.stringify({lines: batch.lines})});
        setDrafts((list) => list.filter((row) => !batch.keys.includes(row.id)));
      }
      for (const item of plan.voids) {
        await request(`${url}/${item.lineId}/void`, {method: 'POST', body: JSON.stringify(item.body)});
      }
    }, fallback);
  }

  function confirm() {
    if (!check.count) return;
    send(async () => {
      for (const lineIds of check.batches) await request(`${url}/checks`, {method: 'POST', body: JSON.stringify({lineIds})});
    });
  }

  function voidLines(event) {
    event.preventDefault();
    const reason = String(voiding ?? '').trim();
    if (!reason || !toVoid.count) return;
    const targets = toVoid.lineIds;
    setVoiding(null);
    send(async () => {
      for (const lineId of targets) await request(`${url}/${lineId}/void`, {method: 'POST', body: JSON.stringify({reason})});
    });
  }

  const sheets = [
    {id: 'detail', label: '明細', editable: writable && !busy, rows, columns: detailColumns({year}),
      newRow: () => draftRow(nextDraft.current++)},
    ...SUMMARIES.map((item) => ({id: item.id, label: item.label, editable: false, rows: summaryRows(data.totals, item.id), columns: summaryColumns(item.id, {year})})),
  ];
  return (
    <section className="al" data-page="actual-lines" aria-busy={busy || undefined}>
      <div className="al-head">
        <span className={`al-alert${top.unconfirmed ? '' : ' is-done'}`} data-unconfirmed={top.unconfirmed}>
          {top.unconfirmed ? `! 未確認 ${formatInt(top.unconfirmed)}` : '未確認 0'}
        </span>
        <span className="al-sum" data-cumulative={top.cumulative}>
          <span className="al-k">累計</span><b>{formatInt(top.cumulative)}</b><span className="al-u">円</span>
          <small>確認済 {formatInt(top.confirmed)}・未確認 {formatInt(top.pending)}</small>
        </span>
        <span className="al-sum is-today" data-today={top.today}><span className="al-k">今日</span><b>{formatInt(top.today)}</b><span className="al-u">円</span></span>
      </div>
      {(writable || data.canCheck) && (
        <div className="al-tools">
          {data.canCheck && (
            <span className="al-check">
              <button type="button" className="al-primary" disabled={busy || !check.count} onClick={confirm}>確認</button>
              <span className="al-n" data-check-count={check.count}>{formatInt(check.count)}件 {formatInt(check.incTaxYen)}円</span>
            </span>
          )}
          {writable && (voiding === null
            ? <button type="button" disabled={busy || !toVoid.count} onClick={() => setVoiding('')}>行を消す</button>
            : (
              <form className="al-void" onSubmit={voidLines}>
                <span className="al-n">{formatInt(toVoid.count)}行 {formatInt(toVoid.incTaxYen)}円</span>
                <input value={voiding} onChange={(event) => setVoiding(event.target.value)} aria-label="取消の理由" placeholder="理由" autoFocus />
                <button type="submit" disabled={busy || !voiding.trim() || !toVoid.count}>取り消す</button>
                <button type="button" onClick={() => setVoiding(null)}>やめる</button>
              </form>
            ))}
          {busy && <span className="al-mute" role="status">送信中…</span>}
        </div>
      )}
      {failure && <p className="al-fail" role="alert">{failure}</p>}
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      <div className="al-sheet">
        <EditSheet label="実費" sheets={sheets} onChange={onChange} onSelect={onSelect} historyEpoch={epoch} />
      </div>
    </section>
  );
}
