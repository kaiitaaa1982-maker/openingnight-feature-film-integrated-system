// 日々スケの確かめと食事の数（撮影日ごと）。判定は call-sheet-check.mjs の決まりだけで行い、AI は使わない。
// 入力中（未保存）の入り・支度完了・バラし・食事の帯・スタッフの数で、その場で数え直す。
import React from 'react';
import './call-sheet-check.css';
import {checkCallSheetDay} from './call-sheet-check.mjs';

const clock = (value) => (value ? value.slice(11, 16).replace(/^0/, '') : '');

export default function CallSheetCheck({day, graph, characters, scenes, readOnly = false, onCrew}) {
  const crew = graph.dayCrews.find((row) => row.day_id === day.id)?.crew_count ?? null;
  const result = checkCallSheetDay({...day, crew_count: crew}, graph);
  const nameOf = (key) => characters.find((c) => c.key === key)?.name || key;
  const sceneOf = (id) => {
    const scene = scenes.find((s) => s.id === id);
    return scene ? `S#${scene.scene_no}` : '';
  };
  const names = (keys) => keys.map(nameOf).join('・');
  return (
    <div className="csc">
      <div className="csc-head">
        <h4>確かめ</h4>
        {result.issues.length
          ? <span className="csc-alert" role="status">! 要確認 {result.issues.length}</span>
          : <span className="csc-tag" role="status">矛盾なし</span>}
        <label className="csc-crew">スタッフ
          <input type="number" min="0" max="9999" inputMode="numeric" value={crew ?? ''} disabled={readOnly}
            onChange={(event) => onCrew(event.target.value)} aria-label="この日のスタッフの数" />
          <span>人</span>
        </label>
        {result.crewMissing && <span className="csc-tag">スタッフ未</span>}
      </div>
      {result.issues.length > 0 && (
        <table className="csc-table" aria-label="矛盾">
          <thead><tr><th>役</th><th>内容</th><th>シーン</th></tr></thead>
          <tbody>{result.issues.map((issue, index) => (
            <tr key={`${issue.kind}-${issue.characterKey}-${issue.sceneId ?? index}`}>
              <td>{nameOf(issue.characterKey)}</td><td className="csc-red">{issue.label}</td><td>{issue.sceneId ? sceneOf(issue.sceneId) : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <h4>食事</h4>
      {result.meals.length === 0
        ? <p className="empty">食事の帯がありません。「移動・食事・撤収」で種類を「食事」にした項目を数えます。</p>
        : (
          <table className="csc-table" aria-label="食事の数">
            <thead><tr><th>食事</th><th>時間</th><th>キャスト</th><th>スタッフ</th><th>計</th><th>未定</th></tr></thead>
            <tbody>{result.meals.map((meal) => (
              <tr key={meal.key}>
                <td>{meal.label}</td>
                <td>{meal.start && meal.end ? `${clock(meal.start)}〜${clock(meal.end)}` : '時刻未定'}</td>
                <td title={names(meal.cast)}>{meal.castCount ?? '—'}</td>
                <td>{meal.crew ?? '—'}</td>
                <td className="csc-total">{meal.total ?? '—'}</td>
                <td className={meal.unknown.length ? 'csc-red' : ''}>{meal.unknown.length ? names(meal.unknown) : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      <p className="production-note">食事は、入り〜バラしが帯に重なるキャストとスタッフの数です。入りかバラしの無い役は「未定」に出し、数に入れません。</p>
    </div>
  );
}
