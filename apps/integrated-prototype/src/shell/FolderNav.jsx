import React from 'react';
import {FOLDER_HOME_PAGE} from './nav-model.mjs';
import {FOLDER_CONTEXT_PARAM} from './folder-nav.mjs';

// context: 共通の画面を開いた元のフォルダの番号。リンクに ?folder=F04 を付け、移動にも渡す。
export function PageLinks({items, page, onNavigate, id, context = null}) {
  return <ul id={id}>
    {items.map((item) => <li key={item.page}>
      <a href={`?p=${item.slug}${context ? `&${FOLDER_CONTEXT_PARAM}=${context}` : ''}`} className={`app-nav-item${item.page === page ? ' is-current' : ''}`}
        aria-current={item.page === page ? 'page' : undefined} title={item.description}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) return;
          event.preventDefault(); if (context) onNavigate(item.page, {[FOLDER_CONTEXT_PARAM]: context}); else onNavigate(item.page);
        }}><span className="app-nav-label">{item.label}</span></a>
    </li>)}
  </ul>;
}

export function FolderName({folder}) {
  return <><span className="app-folder-number">{folder.id}</span><span>{folder.label}</span></>;
}

export function FolderNav({entries = {items: []}, folders, common, page, onNavigate, onSelectFolder, contextId = null}) {
  return <>
    <nav className="app-nav app-folder-nav" aria-label="フォルダ">
      <PageLinks items={[{page: FOLDER_HOME_PAGE, label: 'フォルダ一覧', slug: 'folder-home'}, ...entries.items]} page={page} onNavigate={onNavigate} />
      {folders.map((folder) => {
        const open = contextId ? folder.id === contextId : folder.items.some((item) => item.page === page);
        const listId = `nav-folder-${folder.id}`;
        return <div key={folder.id} className={`app-nav-group${open ? ' is-open' : ''}`}>
          <button type="button" className="app-folder-head" disabled={folder.disabled}
            aria-expanded={open} aria-controls={open ? listId : undefined}
            onClick={() => onSelectFolder(folder.id)}>
            <FolderName folder={folder} />
            {!folder.disabled && <span className="app-nav-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>}
          </button>
          {open && <>
            <PageLinks id={listId} items={folder.items} page={page} onNavigate={onNavigate} />
            {folder.links?.length > 0 && <PageLinks id={`${listId}-links`} items={folder.links} page={contextId === folder.id ? page : null} onNavigate={onNavigate} context={folder.id} />}
          </>}
        </div>;
      })}
    </nav>
    {[common].filter((group) => !group.disabled).map((group) =>
      <nav key={group.id} className="app-nav app-nav-shared" aria-label={group.label}>
        <div className="app-nav-group">
          <h2 className="app-nav-group-head">{group.label}</h2>
          <PageLinks id={`nav-group-${group.id}`} items={group.items} page={contextId ? null : page} onNavigate={onNavigate} />
        </div>
      </nav>)}
  </>;
}
