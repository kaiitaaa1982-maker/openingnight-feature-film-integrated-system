// 撮影の記録の「未解決」（会社ルートの plans/2026-11-20-genba-inbox.md の手順 14b。要件 FR-PROD-SCHED-099〜102）。
// 共通の表（EditSheet）に、未解決（直せるのは移し先だけ）と全シーン（読むだけ）の2つのシート。上に「! 未解決 N」（赤の面はここだけ）。
// 移し先を確定したらすぐ撮影の結果の受け口へ送り、成功したら読み直す（解けた行は消える）。失敗したら読み直して値を戻し、理由を表の上に1行で出す。
// 記録は追記だけなので、戻す・空にするでは何も送らず、送って読み直したら部品の戻すの履歴を空にする（historyEpoch）。論理は leftover-sheet-model.mjs（試験 test/shoot-records-leftover-sheet.test.mjs）。
// 見た目の決まり: core の docs/design/integrated-system-visual.md §1〜§5・§7
import React, {useCallback, useEffect, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import {EditSheet} from '../../ui/EditSheet.jsx';
import {int as formatInt} from '../../ui/format.mjs';
import {leftoverColumns, leftoverRequests, leftoverSheetRows, moveOptions, sceneColumns, sceneSheetRows} from './leftover-sheet-model.mjs';
import {sceneStateCounts} from './scene-states-model.mjs';

export default function LeftoverSheet({request, workId}) {
  const [data, setData] = useState(null), [error, setError] = useState(null);
  const [failure, setFailure] = useState(''), [busy, setBusy] = useState(false), [shown, setShown] = useState(null);
  // 送って読み直したら進める（部品の戻すの履歴を空にする。記録は追記だけなので、保存した変更は戻せない）
  const [epoch, setEpoch] = useState(0);
  const load = useCallback(async () => {
    try {
      setData(await request(`/production/shoot-records/leftover?workId=${workId}&scenes=all`));
      setError(null);
      return true;
    } catch (failed) {
      setError(failed);
      return false;
    } finally {
      setShown(null);
    }
  }, [request, workId]);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <div className="sr-left"><Notice error={error} onRetry={load} retryLabel="読み直す" /></div>;
  if (!data) return <div className="sr-left"><p aria-busy="true">読込中…</p></div>;

  const year = Number(String(data.today).slice(0, 4));
  const base = leftoverSheetRows(data.rows);
  const open = data.rows.length;
  const counts = sceneStateCounts(data.scenes || []);

  async function onChange({sheet, edits, rows, action}) {
    if (sheet !== 'leftover' || busy) return;
    const plan = leftoverRequests(edits, base, {action});
    if (plan.errors.length) setFailure(plan.errors[0].message);
    if (!plan.requests.length) {
      if (plan.errors.length) setEpoch((n) => n + 1);
      return;
    }
    setShown(rows);
    setBusy(true);
    let message = plan.errors[0]?.message ?? '';
    for (const item of plan.requests) {
      try {
        await request(`/production/shoot-records/days/${item.dayId}/results`, {method: 'POST', body: JSON.stringify(item.body)});
      } catch (failed) {
        message = failed?.message || '移し先を記録できませんでした';
        break;
      }
    }
    await load();
    setEpoch((n) => n + 1);
    setFailure(message);
    setBusy(false);
  }

  const sheets = [
    {id: 'leftover', label: '未解決', editable: Boolean(data.canWrite) && !busy, rows: shown ?? base,
      columns: leftoverColumns({options: moveOptions(data.upcomingDays, {year}), year})},
    {id: 'scenes', label: '全シーン', editable: false, rows: sceneSheetRows(data.scenes), columns: sceneColumns({year}),
      status: <>撮れた<b>{formatInt(counts.shot)}</b> ＋ 予定<b>{formatInt(counts.upcoming)}</b> ＋ 欠番<b>{formatInt(counts.dropped)}</b> ＋ 未解決<b>{formatInt(counts.unresolved)}</b>{counts.unassigned ? <> ＋ 未割当<b>{formatInt(counts.unassigned)}</b></> : null} ＝ 計<b>{formatInt(counts.total)}</b></>},
  ];
  return (
    <div className="sr-left" data-page="shoot-leftover" aria-busy={busy || undefined}>
      <div className="sr-bar">
        <span className={`sr-alert${open ? '' : ' is-done'}`} data-open={open}>{open ? `! 未解決 ${formatInt(open)}` : '未解決 0'}</span>
        {busy && <span className="sr-mute" role="status">送信中…</span>}
      </div>
      {failure && <p className="sr-fail" role="alert">{failure}</p>}
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      <EditSheet label="未解決" sheets={sheets} onChange={onChange} historyEpoch={epoch} />
    </div>
  );
}
