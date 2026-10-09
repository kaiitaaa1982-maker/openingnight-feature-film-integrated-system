// アプリの外枠。見出しつきのナビ、業務基幹／営業基幹／売上基幹の切替、売上基幹の業務（2段目）、対象作品、組織、未保存の確認、狭い画面のドロワー。
// 役割で見える画面が1つも無い領域（制作担当の営業基幹・売上基幹）は、上段のタブを押せない（nav-model.mjs の lockedAreas）。
// 画面は screens（ページID→要素）から描き、ShellProvider で API と URL の操作を配る。
import React, {useEffect, useRef, useState} from 'react';
import {ShellProvider, lastPageOf, lastSubPageOf} from './context.mjs';
import {visibleGroups, menuGroups, subAreaTabs, subAreaEntry, subAreaInfo, subAreaOf, displayLabel, describePage, pageScope, areaOf, lockedAreas, AREA_LABELS, AREA_HOME, AREA_LOCK_NOTES, TOP_AREAS, HOME_PAGE, DEFAULT_SUB_AREA} from './nav-model.mjs';
import {unsavedMessage} from './unsaved.mjs';
import {WorkSelector} from './WorkSelector.jsx';
import {ErrorBoundary} from '../ui/ErrorBoundary.jsx';
import {ROLE_LABELS} from './org-model.mjs';
import {OrgSelector} from './OrgSelector.jsx';
import './shell.css';

export {ROLE_LABELS};
const THEMES = [['light', '明'], ['dark', '暗'], ['auto', '自動']];

function NavGroup({group, page, onNavigate}) {
  const containsCurrent = group.items.some((item) => item.page === page);
  const [open, setOpen] = useState(!group.collapsed || containsCurrent);
  useEffect(() => { if (containsCurrent) setOpen(true); }, [containsCurrent]);
  const listId = `nav-group-${group.id}`;
  const alwaysOpen = group.id === 'admin';
  return (
    <div className={`app-nav-group${open ? ' is-open' : ''}`}>
      {alwaysOpen ? <h2 className="app-nav-group-head">{group.label}</h2> : <button type="button" className="app-nav-group-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        <span>{group.label}</span>
        {!open && containsCurrent && <span className="app-nav-here" title="この中に表示中の画面があります">表示中</span>}
        <span className="app-nav-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>}
      <ul id={listId} hidden={!alwaysOpen && !open}>
        {group.items.map((item) => (
          <li key={item.page}>
            <a href={`?p=${item.slug}`} className={`app-nav-item${item.page === page ? ' is-current' : ''}`} aria-current={item.page === page ? 'page' : undefined}
              onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return; event.preventDefault(); onNavigate(item.page); }}>
              <span className="app-nav-label">{item.label}</span>
              <span className="app-nav-desc">{item.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 売上基幹の2段目（計上｜MG｜ロイヤリティ｜製作委員会）。左右の矢印・Home・End でタブ間を移り、押すとその業務の画面を開く
function SubAreaTabs({tabs, onSelect}) {
  const listRef = useRef(null);
  const moveFocus = (event) => {
    const buttons = [...(listRef.current?.querySelectorAll('[role="tab"]') || [])];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const next = {ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div className="app-sub-tabs" role="tablist" aria-label="売上の業務" ref={listRef} onKeyDown={moveFocus}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={tab.selected} tabIndex={tab.selected ? 0 : -1}
          onClick={() => onSelect(tab.id)}>{tab.label}</button>
      ))}
    </div>
  );
}

export function AppShell({
  state, session, bootstrap, screens = {}, hiddenPages = new Set(), theme = 'auto', onTheme, onLogout, financeLocked = false,
  orgs = [], onSwitchOrg, orgSwitching = false, orgError = '', orgsError = null, onRetryOrgs, notice = null,
}) {
  const {page, workId, shell: baseShell, navigate, selectWork, unsaved, pending, confirmPending, cancelPending} = state;
  // 画面部品が役割に応じて操作を出し分けられるよう、ログイン中の役割を文脈に足す（権限の判定そのものはサーバーが行う）
  const shell = React.useMemo(() => ({...baseShell, role: session?.role || null}), [baseShell, session?.role]);
  const pageArea = areaOf(page);
  const [selectedArea, setArea] = useState(pageArea === 'shared' ? 'work' : pageArea);
  // 見える画面が無い領域（制作担当の営業基幹・売上基幹）は選べない。URL でその画面を開いても、左メニューは業務基幹のまま。
  // financeLocked は以前の呼び出し（売上基幹だけを止める）との互換
  const closedAreas = React.useMemo(() => {
    const set = lockedAreas(hiddenPages);
    if (financeLocked) set.add('sales');
    return set;
  }, [hiddenPages, financeLocked]);
  const area = closedAreas.has(selectedArea) ? 'work' : selectedArea;
  // 売上基幹の業務。売上の画面を開いていればその業務、そうでなければ最後に選んだ業務（初めてなら計上）
  const pageSub = subAreaOf(page);
  const [sub, setSub] = useState(() => pageSub || subAreaOf(lastPageOf('sales')) || DEFAULT_SUB_AREA);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const headingRef = useRef(null);
  const focusAfterNav = useRef(false);
  useEffect(() => { if (pageArea !== 'shared') setArea(pageArea); }, [pageArea]);
  useEffect(() => { if (pageSub) setSub(pageSub); }, [pageSub]);

  const works = bootstrap?.works || [];
  const selectedWork = works.find((work) => Number(work.id) === Number(workId));
  const scope = pageScope(page);
  const label = displayLabel(page);
  const locked = hiddenPages.has(page);

  useEffect(() => {
    const parts = [label, scope === 'work' ? selectedWork?.title : scope === 'company' ? '会社全体' : null, 'OpeningNight'].filter(Boolean);
    document.title = parts.join('｜');
  }, [label, scope, selectedWork?.title]);

  useEffect(() => {
    if (focusAfterNav.current) {
      focusAfterNav.current = false;
      headingRef.current?.focus?.();
    }
  }, [page]);

  // 画面の移動。未保存の変更があるときは navigate が確認を出して止め、false を返す
  const go = (target, params) => {
    setDrawerOpen(false);
    focusAfterNav.current = true;
    return navigate(target, params);
  };
  const switchArea = (next) => {
    if (closedAreas.has(next)) return;
    const last = lastPageOf(next);
    const moved = go(last && areaOf(last) === next && !hiddenPages.has(last) ? last : AREA_HOME[next]);
    // 未保存の確認で止まったときは領域を変えない（確かめて移ったら、開いた画面の領域に合わせる）
    if (moved !== false) setArea(next);
  };
  // 業務（2段目）を切り替える。その業務で最後に開いた画面（無ければ業務の最初の画面）を開く。
  // 狭い画面ではドロワーを開いたままにし、切り替えた業務の左メニューからそのまま選べるようにする。
  // 未保存の確認で止まったときは、本文の確認が見えるようドロワーを閉じる
  const switchSub = (next) => {
    const target = subAreaEntry(next, lastSubPageOf(next), hiddenPages);
    if (!target) return;
    if (navigate(target) === false) setDrawerOpen(false);
  };

  const groups = menuGroups(area, sub, hiddenPages);
  const sharedGroups = visibleGroups('shared', hiddenPages);
  const subTabs = area === 'sales' && !closedAreas.has('sales') ? subAreaTabs(sub, hiddenPages) : [];
  const navLabel = area === 'sales' ? `${AREA_LABELS.sales}・${subAreaInfo(sub)?.label || subAreaInfo(DEFAULT_SUB_AREA).label}` : AREA_LABELS[area];
  const content = locked
    ? (
      <section className="card app-locked">
        <h2>この役割では表示しません</h2>
        <p>財務・取引の情報またはチーム管理は、あなたの担当範囲に含まれません。左のメニューから別の画面を選んでください。</p>
      </section>
    )
    : screens[page] ?? (
      <section className="card app-locked">
        <h2>画面が見つかりません</h2>
        <p><button type="button" onClick={() => go(HOME_PAGE)}>ホームへ戻る</button></p>
      </section>
    );

  return (
    <ShellProvider value={shell}>
      <div className={`shell app-shell${drawerOpen ? ' is-drawer-open' : ''}`} data-page={page}>
        <a className="app-skip" href="#app-main">本文へ移動</a>
        <aside className="app-side" id="app-nav" aria-label="メニュー">
          <a className="app-brand" href="?p=home" onClick={(event) => { event.preventDefault(); go(HOME_PAGE); }} aria-label="ホームへ戻る">
            <span aria-hidden="true">ON</span>
            <span className="app-brand-text"><strong>OpeningNight</strong><small>業務基幹・営業基幹・売上基幹</small></span>
          </a>
          <div className="app-area-tabs" role="tablist" aria-label="基幹業務">
            {TOP_AREAS.map((key) => (
              <button key={key} type="button" role="tab" aria-selected={area === key}
                disabled={closedAreas.has(key)} title={closedAreas.has(key) ? AREA_LOCK_NOTES[key] || '担当範囲外です' : undefined}
                onClick={() => switchArea(key)}>{AREA_LABELS[key]}</button>
            ))}
          </div>
          {TOP_AREAS.filter((key) => closedAreas.has(key)).map((key) => <p key={key} className="app-area-note">{AREA_LABELS[key]}: {AREA_LOCK_NOTES[key] || '担当範囲外です'}</p>)}
          {subTabs.length > 0 && <SubAreaTabs tabs={subTabs} onSelect={switchSub} />}
          <nav className="app-nav" aria-label={navLabel}>
            {groups.map((group) => <NavGroup key={`${area}-${group.id}`} group={group} page={page} onNavigate={go} />)}
          </nav>
          {sharedGroups.length > 0 && (
            <nav className="app-nav app-nav-shared" aria-label={AREA_LABELS.shared}>
              {sharedGroups.map((group) => <NavGroup key={`shared-${group.id}`} group={group} page={page} onNavigate={go} />)}
            </nav>
          )}
        </aside>
        {drawerOpen && <button type="button" className="app-scrim" aria-label="メニューを閉じる" onClick={() => setDrawerOpen(false)} />}
        <main className="app-main">
          <header className="topbar app-topbar">
            <button type="button" className="secondary app-menu-button" aria-expanded={drawerOpen} aria-controls="app-nav" onClick={() => setDrawerOpen((value) => !value)}>メニュー</button>
            <button type="button" className="secondary app-admin-entry" onClick={() => go('設計・定義')}>管理・設計</button>
            {scope === 'work' && works.length > 0 && (
              <WorkSelector works={works} value={workId} onChange={selectWork} label={area === 'sales' ? '対象作品（個別処理）' : '対象作品'} />
            )}
            {scope === 'company' && <div className="app-scope"><strong>会社全体の管理</strong><small>閲覧権限のある作品・商品を集約</small></div>}
            <OrgSelector orgs={orgs} currentOrgId={session?.orgId} onSwitch={onSwitchOrg} busy={orgSwitching} error={orgError} listError={orgsError} onRetryList={onRetryOrgs} />
            <div className="user app-user">
              <span>{session?.displayName}<small>{ROLE_LABELS[session?.role] || session?.role}</small></span>
              <div className="theme" role="group" aria-label="表示テーマ">
                {THEMES.map(([key, text]) => <button key={key} type="button" className={theme === key ? 'selected' : ''} aria-pressed={theme === key} onClick={() => onTheme?.(key)}>{text}</button>)}
              </div>
              <button type="button" className="text" onClick={onLogout}>退出</button>
            </div>
          </header>
          <div className="content" id="app-main">
            {notice}
            {pending && (
              <div className="app-unsaved" role="alert">
                <p><strong>{unsavedMessage(unsaved) || '未保存の変更があります'}</strong>。移動すると入力した内容は失われます。</p>
                <div className="on-form-actions">
                  <button type="button" onClick={confirmPending}>破棄して移動</button>
                  <button type="button" className="secondary" onClick={cancelPending}>この画面に戻る</button>
                </div>
              </div>
            )}
            <div className="page-title app-page-title">
              <h1 tabIndex={-1} ref={headingRef}>{label}</h1>
              <span>{scope === 'company' ? '会社全体（閲覧権限内）' : scope === 'work' ? selectedWork?.title || '作品未選択' : ''}</span>
            </div>
            {describePage(page) && <p className="app-page-desc">{describePage(page)}</p>}
            <ErrorBoundary name={label} resetKeys={[page, workId]}>
              {content}
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </ShellProvider>
  );
}

export default AppShell;
