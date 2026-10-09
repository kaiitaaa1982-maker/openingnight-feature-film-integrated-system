// 香盤のデモ（架空の連続ドラマ DEMO-D78）への入口。今の組織にあれば香盤を開き、所属する別の組織にあれば
// 「組織を切り替えて香盤のデモを開く」を出す（切り替えたあと、作品コードで作品を引いて香盤タブへ移る）。
// デモ資料と、香盤・日々スケの空の香盤で使う。設計キャンバスのプレビュー（読み取り専用）では組織を切り替えない。
import React, {useEffect, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {KOUBAN_DEMO_DESTINATION, koubanDemoPlace} from './demo-guide.mjs';

// 所属する組織のうち、デモ・機能がある組織（GET /api/session/org-features）。読めなければ空で failed（「どこにも無い」とは言わない）。
// retry で問い合わせ直す
export function useOrgFeatures(request, {enabled = true} = {}) {
  const [features, setFeatures] = useState({loaded: false, koubanDemo: [], salesSheet: []});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled || typeof request !== 'function') return undefined;
    let live = true;
    request('/session/org-features')
      .then((body) => { if (live) setFeatures({loaded: true, koubanDemo: body?.koubanDemo || [], salesSheet: body?.salesSheet || []}); })
      .catch(() => { if (live) setFeatures({loaded: true, koubanDemo: [], salesSheet: [], failed: true}); });
    return () => { live = false; };
  }, [request, enabled, revision]);
  return {...features, retry: () => setRevision((n) => n + 1)};
}

// place: koubanDemoPlace の結果。here は今の組織の作品を開き、other は組織を切り替えてから開く
export function KoubanDemoEntry({place, onNavigate, onSwitchOrg, label = '香盤のデモを見る', note = true}) {
  const shell = useShell();
  const [busy, setBusy] = useState(false);
  if (!place || place.kind === 'none') return null;
  if (place.kind === 'here') {
    return (
      <div className="demo-actions demo-kouban-entry">
        <button type="button" onClick={() => onNavigate?.(KOUBAN_DEMO_DESTINATION.page, {...KOUBAN_DEMO_DESTINATION.params}, {workId: place.work.id})}>{label}（{place.work.title}）</button>
      </div>
    );
  }
  const canSwitch = typeof onSwitchOrg === 'function' && !shell.readOnly;
  return (
    <div className="demo-kouban-entry">
      {note && <p className="demo-org-note">香盤のデモは組織「{place.org.name}」にあります。</p>}
      <div className="demo-actions">
        <button type="button" disabled={!canSwitch || busy} title={canSwitch ? undefined : 'この画面では組織を切り替えられません'}
          onClick={async () => { setBusy(true); try { await onSwitchOrg(place.org.id, {after: KOUBAN_DEMO_DESTINATION}); } finally { setBusy(false); } }}>
          {busy ? '組織を切り替えています…' : '組織を切り替えて香盤のデモを開く'}
        </button>
      </div>
    </div>
  );
}

// 今の組織の作品と所属組織の一覧から、香盤のデモの場所を決める（今の組織に無いときだけ所属組織を問い合わせる）。
// enabled が false の間は問い合わせない（香盤が空と分かるまで待つときなど）
export function useKoubanDemoPlace({request, works = [], currentOrgId, enabled = true}) {
  const here = koubanDemoPlace({works, currentOrgId});
  const features = useOrgFeatures(request, {enabled: enabled && here.kind !== 'here'});
  return here.kind === 'here' ? here : {...koubanDemoPlace({works, currentOrgId, locations: features.koubanDemo}), loaded: features.loaded, failed: Boolean(features.failed), retry: features.retry};
}
