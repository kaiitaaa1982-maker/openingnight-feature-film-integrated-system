// デモ資料（売上基幹 › 計上 › ヘルプ）。架空の報告書・契約書・台本のサンプルと試し方。
// ・今の組織の名前を出し、サンプルの Excel は今の組織のマスタに合う組（DEMO-SALES 用／手元用の初期データ用）を先に出す（demo-guide.mjs）
// ・数字のIDを直書きした「正常取込CSV」は、そのIDが今の組織で正しいときだけ出す
// ・香盤のデモ（DEMO-D78）が今の組織に無く、所属する別の組織にあれば、組織を切り替えて開く入口を出す
import React, {useEffect, useState} from 'react';
import './demo-samples.css';
import {orderedSampleSets, NO_MATCHING_MASTER_NOTE, koubanPlaceNote, scriptButtonState} from './demo-guide.mjs';
import {KoubanDemoEntry, useKoubanDemoPlace} from './DemoGuide.jsx';

const BASE = '/demo-fixtures/';
const OTHER_SAMPLES = [
  {title: '放送許諾契約書（デモ）', tag: '契約PDF / 文字抽出', note: '架空の放送会社、作品、期間、回数、地域・媒体、対価、支払期日を記載した2ページの抽出試験用PDFです。', files: [['PDFをダウンロード', 'broadcast-license-demo-contract.pdf']]},
];
const SCRIPT_SAMPLE = {title: '連続ドラマの台本（架空・縦書きPDF）', tag: '台本 / 香盤', note: '架空の連続ドラマ『ふくろう堂の返却期限』第7話・第8話の縦書き台本です。決定稿は番号付き、準備稿は◯の見出しで、準備稿には文字化けした字を3行まぜてあります。',
  files: [['第7話 決定稿', 'scripts/fukurodo-ep07-kettei.pdf'], ['第8話 準備稿', 'scripts/fukurodo-ep08-junbi.pdf'], ['第8話 決定稿', 'scripts/fukurodo-ep08-kettei.pdf']],
  expected: '第7話30シーン・第8話28シーン（S#は 7-1・8-1 のように話数付き）。2話を同じ作品に登録すると、第8話は第7話の撮影日に追記されます。'};

function SampleCard({sample, showCanonical, onNavigate}) {
  return (
    <article className="demo-card">
      <span>{sample.tag}</span>
      <h3>{sample.title}</h3>
      <p>{sample.note}</p>
      <dl className="demo-facts">
        {sample.steps.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <p className="demo-expected">期待値: {sample.expected}</p>
      <div className="demo-actions">
        {sample.files.map(([label, file]) => <a key={file} href={`${BASE}${file}`} download>{label}</a>)}
        {showCanonical && sample.canonical && <a className="canonical" href={`${BASE}${sample.canonical}`} download>正常取込CSV</a>}
      </div>
      <button type="button" className="text" onClick={() => onNavigate('原本取り込み')}>ダウンロード後、売上報告の取込で開く</button>
      {showCanonical && sample.canonical && <button type="button" className="text" onClick={() => onNavigate('売上データ編集')}>正常取込CSVは、売上の表編集・加工で読み込む</button>}
    </article>
  );
}

// scripts: null（読み込み中）・{rows}・{error}。onRetryScripts で読み直す
export function ScriptCard({place, scripts, onNavigate, onSwitchOrg, onRetryScripts}) {
  const button = scriptButtonState(scripts);
  const placeNote = koubanPlaceNote(place);
  return (
    <article className="demo-card">
      <span>{SCRIPT_SAMPLE.tag}</span>
      <h3>{SCRIPT_SAMPLE.title}</h3>
      <p>{SCRIPT_SAMPLE.note}</p>
      <p className="demo-expected">期待値: {SCRIPT_SAMPLE.expected}</p>
      <div className="demo-actions">{SCRIPT_SAMPLE.files.map(([label, file]) => <a key={file} href={`${BASE}${file}`} download>{label}</a>)}</div>
      {place.kind === 'here' && (
        <>
          <KoubanDemoEntry place={place} onNavigate={onNavigate} label="香盤のデモを開く" />
          <div className="demo-actions">
            <button type="button" className="secondary" disabled={button.disabled} onClick={() => onNavigate('台本・香盤', {artifact: String(button.script.id)}, {workId: place.work.id})}>
              {button.label}
            </button>
            {button.retry && <button type="button" className="text" onClick={onRetryScripts}>もう一度読み込む</button>}
          </div>
        </>
      )}
      {place.kind === 'other' && <KoubanDemoEntry place={place} onNavigate={onNavigate} onSwitchOrg={onSwitchOrg} />}
      {placeNote && (
        <p className="demo-org-note">{placeNote.text}
          {placeNote.kind === 'unknown' && typeof place.retry === 'function' && <button type="button" className="text" onClick={place.retry}>再読込</button>}
        </p>
      )}
      <button type="button" className="text" onClick={() => onNavigate('台本・香盤')}>ダウンロード後、台本の取込で開く</button>
    </article>
  );
}

export default function DemoSamples({onNavigate, works = [], partners = [], products = [], request, currentOrgId = null, currentOrgName = '', onSwitchOrg}) {
  const place = useKoubanDemoPlace({request, works, currentOrgId});
  const [scripts, setScripts] = useState(null);
  const [scriptRevision, setScriptRevision] = useState(0);
  const dramaId = place.kind === 'here' ? place.work.id : null;
  useEffect(() => {
    if (!dramaId || typeof request !== 'function') return undefined;
    let live = true;
    setScripts(null);
    request(`/workflow/scripts?workId=${dramaId}`).then((body) => live && setScripts({rows: body?.rows || []})).catch(() => live && setScripts({error: true}));
    return () => { live = false; };
  }, [dramaId, request, scriptRevision]);
  const sets = orderedSampleSets({works, partners, products});
  const anyCanonical = sets.some((row) => row.showCanonical);
  return (
    <div className="demo-samples">
      <section className="demo-intro">
        <p className="eyebrow">架空のデモ資料</p>
        <h2>取込・加工を試すためのデモ資料</h2>
        <p className="demo-org">表示中の組織: <b>{currentOrgName || (currentOrgId ? `組織 ${currentOrgId}` : '確認中')}</b>。サンプルは組織のマスタ（作品・取引先・商品）に合わせてあるので、この組織に合う組から並べています。</p>
        <p><strong>すべて非公式の架空データです。</strong>実在企業が発行した資料や、その書式を再現したものではありません。契約PDFに法的効力はなく、法務アドバイスでもありません。</p>
      </section>
      <section className="demo-steps">
        <h3>制作から売上・分配までの操作デモ</h3>
        <p>香盤、番販、放送承認、帳票、Lightdashの確認順を、架空データの字幕動画で説明します。</p>
        <a href="/workflow-demo/">動画とサンプル帳票を開く（3分52秒）</a>
      </section>
      <section className="demo-steps">
        <h3>試し方</h3>
        <ol>
          <li>資料をダウンロードします。</li>
          <li>XLSXは「売上報告の取込」で、カードに書いた取引先と報告の種類を選んでから読み込みます。見出し行（4行目）は自動で推定されます。</li>
          <li>作品の決め方をカードのとおりに選びます。要修正の行は、理由を書いて取込から除きます。列の対応・表での確認・登録まで順に進み、期待値と合うかを確かめます。</li>
          {anyCanonical && <li>表の形のまま直したり加工したりする練習は「売上の表編集・加工」で行います。すぐ登録まで試す場合は「正常取込CSV」を使います。</li>}
          <li>契約PDFは「売上報告の取込」の詳細モードで読み込みます。PDFの文字・表が抽出され、列対応の候補を確かめられます。</li>
        </ol>
        <div>
          <button type="button" onClick={() => onNavigate('原本取り込み')}>売上報告の取込を開く</button>
          <button type="button" className="secondary" onClick={() => onNavigate('売上データ編集')}>売上の表編集・加工を開く</button>
        </div>
      </section>
      {sets.map(({set, matches, showCanonical}) => (
        <section key={set.id} className="demo-set" aria-label={`サンプルの組: ${set.label}`}>
          <header className="demo-set-head">
            <h3>{set.label}</h3>
            {matches ? <span className="demo-match">この組織のマスタに合います</span> : <p className="demo-org-note">{NO_MATCHING_MASTER_NOTE}</p>}
            <p className="demo-mapping">{set.mapping}</p>
            {!showCanonical && set.samples.some((sample) => sample.canonical) && <p className="demo-mapping">正常取込CSVは数字のIDで取引先・商品を指すため、IDが合わないこの組織では出していません。</p>}
          </header>
          <div className="demo-grid">
            {set.samples.map((sample) => <SampleCard key={sample.key} sample={sample} showCanonical={showCanonical} onNavigate={onNavigate} />)}
          </div>
        </section>
      ))}
      <section className="demo-set" aria-label="そのほかの資料">
        <header className="demo-set-head"><h3>契約書・台本</h3></header>
        <div className="demo-grid">
          {OTHER_SAMPLES.map((sample) => (
            <article className="demo-card" key={sample.title}>
              <span>{sample.tag}</span>
              <h3>{sample.title}</h3>
              <p>{sample.note}</p>
              <div className="demo-actions">{sample.files.map(([label, file]) => <a key={file} href={`${BASE}${file}`} download>{label}</a>)}</div>
              <button type="button" className="text" onClick={() => onNavigate('原本取り込み')}>ダウンロード後、原本取り込みで開く</button>
            </article>
          ))}
          <ScriptCard place={place} scripts={scripts} onNavigate={onNavigate} onSwitchOrg={onSwitchOrg} onRetryScripts={() => setScriptRevision((n) => n + 1)} />
        </div>
      </section>
      <section className="demo-notes">
        <h3>データの対応</h3>
        <p>元XLSXは取引先から受け取る表を想定した列名です。そのまま共通列ではないので、加工練習では見出し行4を指定し、列名を整理してください。</p>
        <a href={`${BASE}fixture-manifest.json`} target="_blank" rel="noreferrer">検証期待値manifestを見る</a>
      </section>
    </div>
  );
}
