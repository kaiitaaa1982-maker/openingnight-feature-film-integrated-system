// 他の画面（営業基幹の全作品のウィンドウ・取引先別リスト）の行から、その作品・取引先で絞った売上集計シートを開くリンク。
// 財務の画面なので、出すのは財務の権限がある人だけ（GET /api/sales-sheet/access。制作担当・権限の無い作品には出さない）。
import React, {useEffect, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {salesSheetLink} from './sheet-view-model.mjs';
import {slugOf} from '../shell/nav-model.mjs';

export function useSalesSheetAccess(request) {
  const [access, setAccess] = useState(null);
  useEffect(() => {
    if (typeof request !== 'function') return undefined;
    let live = true;
    request('/sales-sheet/access').then((body) => { if (live) setAccess(body); }).catch(() => { if (live) setAccess({canOpen: false, workIds: []}); });
    return () => { live = false; };
  }, [request]);
  return access;
}

export function SalesSheetLink({access, workId = null, partnerId = null, label = '売上集計シートで見る'}) {
  const shell = useShell();
  const link = salesSheetLink(access, {workId, partnerId});
  if (!link) return null;
  const href = `?${new URLSearchParams({p: slugOf(link.page), ...link.params})}`;
  return (
    <a className="rw-sheet-link" href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        shell.navigate(link.page, link.params);
      }}>{label}</a>
  );
}
