// 対象作品の選択。作品単位の画面でだけ外枠に出す。コード・名称で検索できる。
import React, {useMemo} from 'react';
import {EntityPicker} from '../ui/EntityPicker.jsx';
import {toEntityItems} from '../ui/entity-match.mjs';

export function WorkSelector({works = [], value, onChange, label = '対象作品', disabled = false}) {
  const items = useMemo(() => toEntityItems(works, {hint: (work) => (work.project_title ? `案件: ${work.project_title}` : '')}), [works]);
  return (
    <div className="app-work-selector">
      <EntityPicker label={label} items={items} value={value ?? null} disabled={disabled} required
        placeholder="作品のコード・名称で検索" onChange={(id) => { if (id !== null && id !== undefined && id !== '') onChange?.(Number(id)); }} />
    </div>
  );
}

export default WorkSelector;
