// 未保存の変更の登録と、画面移動を止める判定。画面部品は useShell().registerUnsaved(id, 件数, ラベル) で登録し、
// 件数0で解除する。外枠は合計が1以上のとき、画面移動・作品切替・タブを閉じる操作の前に確認を出す。

export function createUnsavedStore() {
  const entries = new Map();
  const listeners = new Set();
  let snapshot = {count: 0, items: []};
  const rebuild = () => {
    const items = [...entries.entries()].map(([id, entry]) => ({id, ...entry}));
    snapshot = {count: items.reduce((sum, item) => sum + item.count, 0), items};
    for (const listener of listeners) listener();
  };
  return {
    register(id, count, label = '未保存の変更') {
      const n = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 0;
      const before = entries.get(id);
      if (n === 0) {
        if (!before) return;
        entries.delete(id);
      } else {
        if (before && before.count === n && before.label === label) return;
        entries.set(id, {count: n, label});
      }
      rebuild();
    },
    clear() {
      if (!entries.size) return;
      entries.clear();
      rebuild();
    },
    total: () => snapshot.count,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function shouldBlock(total) {
  return Number(total) > 0;
}

// 「未保存の変更が3件あります（売上の表編集 2件、新規登録の入力 1件）」
export function unsavedMessage(snapshot) {
  if (!snapshot?.count) return '';
  const parts = snapshot.items.map((item) => `${item.label} ${item.count}件`);
  return `未保存の変更が${snapshot.count}件あります${parts.length ? `（${parts.join('、')}）` : ''}`;
}

export function beforeUnloadHandler(getTotal) {
  return (event) => {
    if (!shouldBlock(getTotal())) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  };
}
