// アプリの外枠。全フォルダ、表示モード、対象作品、組織、未保存の確認とドロワー。
import React, {useEffect, useRef, useState} from 'react';
import {ShellProvider} from './context.mjs';
import {displayLabel, pageScope, navItems, FOLDER_HOME_PAGE, HOME_PAGE, VIEW_MODES, environmentHiddenPages, readViewMode, rememberViewMode} from './nav-model.mjs';
import {folderNavigation, folderOf, folderEntry} from './folder-nav.mjs';
import {FolderNav, FolderName} from './FolderNav.jsx';
import {FolderHome} from './FolderHome.jsx';
import {unsavedMessage} from './unsaved.mjs';
import {WorkSelector} from './WorkSelector.jsx';
import {ErrorBoundary} from '../ui/ErrorBoundary.jsx';
import {ROLE_LABELS} from './org-model.mjs';
import {OrgSelector} from './OrgSelector.jsx';
import './shell.css';

export {ROLE_LABELS};

// 表示モード（全表示｜代表モード）の記録先。読めない・書けない環境（プライベートブラウズなど）では null にして、全表示で始める
function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function AppShell({
  state, session, bootstrap, screens = {}, hiddenPages = new Set(), onLogout, financeLocked = false,
  orgs = [], onSwitchOrg, orgSwitching = false, orgError = '', orgsError = null, onRetryOrgs, notice = null, mode = null,
}) {
  const {page, workId, shell: baseShell, navigate, selectWork, unsaved, pending, confirmPending, cancelPending} = state;
  const [viewMode, setViewMode] = useState(() => readViewMode(browserStorage()));
  // 画面部品が役割と表示モードに応じて中身を出し分けられるよう、文脈に足す（権限の判定そのものはサーバーが行う）
  const shell = React.useMemo(() => ({...baseShell, role: session?.role || null, viewMode}), [baseShell, session?.role, viewMode]);
  const navigation = React.useMemo(() => {
    // financeLocked は以前の呼び出しとの互換。通常は役割由来の hiddenPages が財務を隠す。
    const hidden = financeLocked ? new Set([...hiddenPages, ...navItems().filter((item) => item.area === 'sales').map((item) => item.page)]) : hiddenPages;
    return folderNavigation({hiddenPages: hidden, viewMode, mode});
  }, [hiddenPages, financeLocked, viewMode, mode]);
  const chooseViewMode = (next) => {
    setViewMode(next);
    rememberViewMode(browserStorage(), next);
  };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const headingRef = useRef(null);
  const focusAfterNav = useRef(false);

  const works = bootstrap?.works || [];
  const selectedWork = works.find((work) => Number(work.id) === Number(workId));
  const scope = pageScope(page);
  const label = displayLabel(page);
  const folder = folderOf(page);
  const numberedFolder = folder?.id.startsWith('F') ? folder : null;
  const locked = hiddenPages.has(page) || environmentHiddenPages(mode).has(page);

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
  const go = (target, params, options) => {
    setDrawerOpen(false);
    focusAfterNav.current = true;
    return navigate(target, params, options);
  };
  const selectFolder = (id) => {
    const target = folderEntry(id, navigation.folders);
    if (!target || folder?.id === id) return;
    // 狭い画面でも開いたフォルダの画面を選べるようドロワーは残す。未保存で止まれば本文の確認へ。
    focusAfterNav.current = !drawerOpen;
    if (navigate(target) === false) setDrawerOpen(false);
  };
  const content = locked
    ? (
      <section className="card app-locked">
        <h2>この役割では表示しません</h2>
      </section>
    )
    : page === FOLDER_HOME_PAGE
      ? <FolderHome folders={navigation.folders} works={works} onNavigate={go}
          canOpenWork={!hiddenPages.has(HOME_PAGE)} onSelectWork={(id) => go(HOME_PAGE, {}, {workId: id})} />
      : screens[page] ?? (
      <section className="card app-locked">
        <h2>画面が見つかりません</h2>
        <p><button type="button" onClick={() => go(FOLDER_HOME_PAGE)}>フォルダ一覧へ戻る</button></p>
      </section>
    );

  return (
    <ShellProvider value={shell}>
      <div className={`shell app-shell${drawerOpen ? ' is-drawer-open' : ''}`} data-page={page}>
        <a className="app-skip" href="#app-main">本文へ移動</a>
        <aside className="app-side" id="app-nav" aria-label="メニュー">
          <a className="app-brand" href="?p=folder-home" onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) return;
            event.preventDefault(); go(FOLDER_HOME_PAGE);
          }} aria-label="フォルダ一覧へ戻る">
            <span aria-hidden="true">ON</span>
            <span className="app-brand-text"><strong>OpeningNight</strong></span>
          </a>
          {/* 状態を選ぶ切り替え（明・暗・自動のテーマと同じ型）。ラベルは選ぶ状態の名で、押した側を aria-pressed で示す。動詞にすると「全部出す（押されている）」のように状態が読めなくなるので、ui-guidelines §9 (47) の動詞の例外として扱う */}
          <div className="app-view-mode" role="group" aria-label="メニューの表示">
            {VIEW_MODES.map((mode) => <button key={mode.id} type="button" aria-pressed={viewMode === mode.id} onClick={() => chooseViewMode(mode.id)}>{mode.label}</button>)}
          </div>
          <FolderNav {...navigation} page={page} onNavigate={go} onSelectFolder={selectFolder} />
        </aside>
        {drawerOpen && <button type="button" className="app-scrim" aria-label="メニューを閉じる" onClick={() => setDrawerOpen(false)} />}
        <main className="app-main">
          <header className="topbar app-topbar">
            <button type="button" className="secondary app-menu-button" aria-expanded={drawerOpen} aria-controls="app-nav" onClick={() => setDrawerOpen((value) => !value)}>メニュー</button>
            <button type="button" className="secondary app-admin-entry" onClick={() => go('設計・定義')}>管理・設計</button>
            {scope === 'work' && works.length > 0 && (
              <WorkSelector works={works} value={workId} onChange={selectWork} label="対象作品" />
            )}
            <OrgSelector orgs={orgs} currentOrgId={session?.orgId} onSwitch={onSwitchOrg} busy={orgSwitching} error={orgError} listError={orgsError} onRetryList={onRetryOrgs} />
            <div className="user app-user">
              <span>{session?.displayName}<small>{ROLE_LABELS[session?.role] || session?.role}</small></span>
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
            {numberedFolder && <div className="app-folder-title"><FolderName folder={numberedFolder} /></div>}
            <div className="page-title app-page-title">
              <h1 tabIndex={-1} ref={headingRef}>{label}</h1>
              <span>{scope === 'company' ? '会社全体' : scope === 'work' ? selectedWork?.title || '作品未選択' : ''}</span>
            </div>
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
