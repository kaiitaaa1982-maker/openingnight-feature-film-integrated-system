// フォルダ一覧。左ナビと同じ、閲覧できる項目を受け取る。
import React from 'react';
import {FolderName, PageLinks} from './FolderNav.jsx';
import {WorkSelector} from './WorkSelector.jsx';

export function FolderHome({folders, works, onNavigate, onSelectWork, canOpenWork = true}) {
  return <div className="app-folder-home">
    {canOpenWork && works.length > 0 && <WorkSelector works={works} value={null} onChange={onSelectWork} label="作品" />}
    <div className="app-folder-list">
      {folders.map((folder) => <section key={folder.id} className={`app-folder-card${folder.disabled ? ' is-disabled' : ''}`} aria-disabled={folder.disabled || undefined}>
        <h2><FolderName folder={folder} /></h2>
        {!folder.disabled && <PageLinks items={folder.items} onNavigate={onNavigate} />}
      </section>)}
    </div>
  </div>;
}
