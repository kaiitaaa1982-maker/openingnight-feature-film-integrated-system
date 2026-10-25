// 外枠の所属表。ページIDだけを割り当て、表示名・slug・scope は NAV_GROUPS の項目から引く。
import {navItems, menuHiddenPages, FOLDER_HOME_PAGE} from './nav-model.mjs';

const group = (id, label, pages) => Object.freeze({id, label, pages: Object.freeze(pages)});
export const FOLDER_GROUPS = Object.freeze([
  group('F01', '企画', ['企画', '予算書', 'シナリオの比較']),
  group('F02', 'プロデュース管理', ['プロデュース管理', '企画・作品', '作品・商品マスタ']),
  group('F03', 'プリプロダクション', ['プリプロ', '台本・香盤', '制作']),
  group('F04', 'プロダクション', ['撮影の記録']),
  group('F05', 'ポストプロダクション', ['ポスプロ']),
  group('F06', '営業管理', ['全作品のウィンドウ', '提案資料', '営業作品一覧', '取引先別リスト', '番販・放送', '商品・営業', '営業資料']),
  group('F07', '販売管理', ['売上', '原本取り込み', '売上データ編集', '報告書マッピング', '売上集計シート', '帳票センター', '請求・入金', '月別消込']),
  group('F08', 'ロイヤリティ報告管理', ['ロイヤリティフォルダ', 'ロイヤリティ作成', 'ロイヤリティ集計', 'ロイヤリティ報告書', 'ロイヤリティ契約', '権利・分配']),
  group('F09', 'MG_買付分管理', ['MG 買付']),
  group('F10', 'MG_販売分管理', ['MG契約・台帳', '権利先・MG帳票']),
  group('F11', '予実管理', ['予実管理']),
  group('F12', '経費管理', ['経費', '経費集計シート']),
  group('F13', '出金_入金管理', ['入出金', '税ルール・台帳']),
  group('F14', 'PL_BS', ['PL・BS', '収支', '分析・Lightdash']),
  group('F15', '製作委員会プロジェクト', ['委員会月次収支', '製作委員会', '委員会の台帳']),
  group('F16', '契約', []),
  group('F17', '納品物', []),
  group('F18', '宣伝', ['宣伝']),
  group('F19', '調達', ['調達', '調達・権利']),
  group('F20', '製造', ['製造']),
]);
// ホームは一覧の作品選択から開く。外枠の入口2画面は共通に属するがメニューには並べない。
export const COMMON_GROUP = group('common', '共通', ['取引先', '業務データ編集', 'デモ資料', 'ホーム', FOLDER_HOME_PAGE]);
// ローカル専用の販売管理見本は設計の入口として残す（既存の ?p=folders を保つ）。
export const ADMIN_GROUP = group('admin', '管理・設計', ['設計・定義', '設計キャンバス', 'ER', '拡張項目', 'チーム', 'データ一覧', '取込履歴', 'フォルダ']);
const ENTRY_PAGES = new Set(['ホーム', FOLDER_HOME_PAGE]);

export function folderOf(page) {
  return [...FOLDER_GROUPS, COMMON_GROUP, ADMIN_GROUP].find((entry) => entry.pages.includes(page)) || null;
}

// 空のフォルダも残す。表示モードはメニューの絞り込みだけで、URL の閲覧権限を変えない。
export function folderNavigation({hiddenPages = new Set(), viewMode = 'all', mode = null, items = navItems()} = {}) {
  const hidden = menuHiddenPages(viewMode, hiddenPages);
  const byPage = new Map(items.map((item) => [item.page, item]));
  const resolve = (entry) => {
    const visible = entry.pages.map((page) => byPage.get(page)).filter((item) => item
      && !ENTRY_PAGES.has(item.page) && !item.hidden && !hidden.has(item.page) && (!item.localOnly || mode === 'local'));
    return {...entry, items: visible, disabled: visible.length === 0};
  };
  return {folders: FOLDER_GROUPS.map(resolve), common: resolve(COMMON_GROUP), admin: resolve(ADMIN_GROUP)};
}

export function folderEntry(id, folders) {
  return folders.find((folder) => folder.id === id)?.items[0]?.page || null;
}

// 未知のページを normalizePage でホームに丸めず、追加忘れ・誤記・重複を試験で検出する。
export function validateFolderPages(items = navItems(), folders = FOLDER_GROUPS) {
  const known = new Set(items.map((item) => item.page));
  const assigned = [...folders, COMMON_GROUP, ADMIN_GROUP].flatMap((entry) => entry.pages);
  const counts = new Map();
  const errors = [];
  for (const page of assigned) {
    counts.set(page, (counts.get(page) || 0) + 1);
    if (!known.has(page)) errors.push(`未知: ${page}`);
  }
  for (const [page, count] of counts) if (count > 1) errors.push(`重複: ${page}`);
  for (const page of known) if (!counts.has(page)) errors.push(`未割当: ${page}`);
  return errors;
}
