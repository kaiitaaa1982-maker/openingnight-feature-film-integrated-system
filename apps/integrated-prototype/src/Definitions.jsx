// 設計・定義。業務基幹と売上基幹が共通に使う「業務のまとまり」「まとまりのつながり」「数字の決め方」を業務の言葉で示す。
// 表名・定義のコード・実装の状況は「技術情報」の折りたたみへ。画面へは useShell().navigate（または onNavigate）で移る。
import React from 'react';
import {useShell} from './shell/context.mjs';
import {displayLabel} from './shell/nav-model.mjs';
import {objects, relations} from './design-model.mjs';
import {analysisDefinitions, definitionVersion, semanticDocument} from './semantic-definitions.mjs';
import {definitionView, relationRows, plainTerms} from './admin/definitions-model.mjs';
import {tableTitle} from './admin/er-model.mjs';
import './admin/admin.css';

export default function Definitions({onNavigate}) {
  const shell = useShell();
  const go = onNavigate || shell.navigate;
  const definitions = analysisDefinitions.map(definitionView);
  const links = relationRows(relations, objects);
  return (
    <div className="stack adm-page">
      <section className="card adm-intro">
        <div>
          <h2>業務の言葉と数字の決め方</h2>
          <p className="adm-muted">業務基幹と売上基幹で共通に使う、業務のまとまり・まとまりのつながり・数字の定義です。金額・日付・件数はDB、意味と判断の根拠は知識の正本（Vault）で管理します。</p>
          <p className="adm-meta"><span>定義の版 {definitionVersion}</span><span>数字の定義 {definitions.length}件</span><span>業務のまとまり {objects.length}件</span></p>
          <p className="adm-muted" role="status">アプリに同梱された定義を表示しています（通信による読み込みはありません）。役割による定義の絞り込みはありません。行の中身は含みません。</p>
        </div>
        <div className="adm-intro-actions">
          <button type="button" onClick={() => go('設計キャンバス', {from: '設計・定義'})}>設計キャンバスで図にする</button>
          <button type="button" className="secondary" onClick={() => go('ER')}>表の構造を見る</button>
          <button type="button" className="secondary" onClick={() => go('データ一覧')}>データ一覧を見る</button>
        </div>
      </section>

      <section className="card">
        <h2>数字の定義</h2>
        <p className="adm-muted">帳票と分析で同じ数字を出すための決め方です。どの単位で集計し、どの月に入れるかを定義ごとに決めています。</p>
        <div className="adm-defs">
          {definitions.length === 0 && <p role="status">数字の定義は0件です。</p>}
          {definitions.map((definition) => (
            <article key={definition.id} className="adm-def" aria-label={definition.name}>
              <h3>{definition.name}</h3>
              <dl className="adm-dl">
                <div><dt>集計の単位</dt><dd>{definition.grain}</dd></div>
                <div><dt>決め方</dt><dd>{definition.rule}</dd></div>
                <div><dt>月の扱い</dt><dd>{definition.month}</dd></div>
                <div><dt>元にするデータ</dt><dd>{definition.sourceText}</dd></div>
              </dl>
              {definition.technical.length > 0 && (
                <details className="adm-tech-inline">
                  <summary>技術情報</summary>
                  <dl className="adm-dl adm-dl-tech">
                    {definition.technical.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                  </dl>
                </details>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>業務のまとまり</h2>
        <p className="adm-muted">作品・売上・請求などの業務を、使う画面とデータのまとまりで分けています。画面の名前を押すとその画面を開きます。</p>
        {objects.length === 0 && <p role="status">業務のまとまりは0件です。</p>}
        <div className="adm-defs">
          {objects.map((object) => (
            <article key={object.id} className="adm-def" aria-label={object.label}>
              <h3>{object.label}</h3>
              <p className="adm-muted">{object.meaning}</p>
              <div className="adm-chips" aria-label={`${object.label}で使う画面`}>
                {object.screens.map((page) => <button key={page} type="button" onClick={() => go(page)}>{displayLabel(page)}</button>)}
              </div>
              <details className="adm-tech-inline">
                <summary>使う表（{object.tables.length}表）</summary>
                <ul className="adm-flow">
                  {object.tables.map((name) => <li key={name}>{tableTitle(name)} <code>{name}</code></li>)}
                </ul>
              </details>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>まとまりのつながり</h2>
        <p className="adm-muted">あるまとまりのデータが、どのまとまりで使われるかを示します（左から右へ）。</p>
        <ul className="adm-relations">
          {links.length === 0 && <li>まとまりのつながりは0件です。</li>}
          {links.map((link) => <li key={link.key}><strong>{link.from}</strong><span>→ {link.label} →</span><strong>{link.to}</strong></li>)}
        </ul>
      </section>

      <section className="card">
        <h2>知見への戻し方</h2>
        <p>{semanticDocument.knowledgePolicy.flow}</p>
        <p className="adm-muted">分析で気づいたことは、定義の版・対象・条件・出所を付けて候補として残し、人が確かめてから知見に採用します。この画面から自動で知見を増やしたり採用したりはしません。</p>
        <h3 className="adm-subhead">まだ決まっていないこと・つながっていないもの</h3>
        <ul className="adm-flow">
          {semanticDocument.limitations.map((text) => <li key={text}>{plainTerms(text)}</li>)}
        </ul>
      </section>
    </div>
  );
}
