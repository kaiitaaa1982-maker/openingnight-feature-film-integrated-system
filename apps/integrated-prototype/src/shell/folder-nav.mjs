// 外枠の所属表。ページIDだけを割り当て、表示名・slug・scope は NAV_GROUPS の項目から引く。
import {navItems, menuHiddenPages, FOLDER_HOME_PAGE} from './nav-model.mjs';

const group = (id, label, pages) => Object.freeze({id, label, pages: Object.freeze(pages)});
export const FOLDER_GROUPS = Object.freeze([
  group('F01', '企画', ['企画', '予算書', 'シナリオの比較']),
  group('F02', 'プロデュース管理', ['プロデュース管理', '企画・作品', '作品・商品マスタ']),
  group('F03', 'プリプロダクション', ['プリプロ', '許可申請', '小道具', '台本・香盤', '制作']),
  group('F04', 'プロダクション', ['撮影の記録', '実費']),
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
// 全フォルダ（F01〜F20）のメニューから同じ画面を開けるようにする共通の画面。所属は共通のまま（folderOf は変えない）。
// F01〜F20 の pages の表は変えない。開いた元のフォルダは URL の folder=F04 に持ち、メニューの開閉とタイトルに使う。
export const FOLDER_LINK_PAGES = Object.freeze(['業務ひな型']);
export const FOLDER_CONTEXT_PARAM = 'folder';
// ホームは一覧の作品選択から開く。外枠の入口2画面は共通に属するがメニューには並べない。
// チーム・取込履歴は管理者だけが開く（nav-model.mjs の ADMIN_ONLY_PAGES）。フォルダはローカル専用の販売管理見本（既存の ?p=folders を保つ）。
export const COMMON_GROUP = group('common', '共通', ['取引先', '業務データ編集', '業務ひな型', 'デモ資料', '原本の置き場', 'チーム', '取込履歴', 'フォルダ', '表の見本', 'ホーム', '全案件', FOLDER_HOME_PAGE]);
// 左メニューの先頭（フォルダ一覧の次）に並べる入口。共通に属するが、共通の欄には並べない。役割と表示モード（代表モードの REPRESENTATIVE_PAGES に無いとき）で隠す
export const ENTRY_LINK_PAGES = Object.freeze(['全案件']);
const ENTRY_PAGES = new Set(['ホーム', FOLDER_HOME_PAGE, ...ENTRY_LINK_PAGES]);

export function folderOf(page) {
  return [...FOLDER_GROUPS, COMMON_GROUP].find((entry) => entry.pages.includes(page)) || null;
}

// 共通の画面を、開いた元のフォルダ付きで開いているときのフォルダの番号。それ以外は null。
export function folderContextId(page, params = {}) {
  const id = params?.[FOLDER_CONTEXT_PARAM];
  return FOLDER_LINK_PAGES.includes(page) && FOLDER_GROUPS.some((folder) => folder.id === id) ? id : null;
}

// 画面から見たフォルダ。元のフォルダ付きならそのフォルダ、なければ所属のフォルダ。
export function folderOfView(page, params = {}) {
  const id = folderContextId(page, params);
  return id ? FOLDER_GROUPS.find((folder) => folder.id === id) : folderOf(page);
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
  // 共通の画面へのリンク。items とは別に持ち、F01〜F20 の表と代表モードの対象を変えない。
  const withLinks = (entry) => {
    const own = resolve(entry);
    const links = FOLDER_LINK_PAGES.map((page) => byPage.get(page)).filter((item) => item
      && !item.hidden && !hidden.has(item.page) && (!item.localOnly || mode === 'local'));
    return {...own, links, disabled: own.items.length === 0 && links.length === 0};
  };
  const entries = {id: 'entries', label: '入口', items: ENTRY_LINK_PAGES.map((page) => byPage.get(page)).filter((item) => item && !item.hidden && !hidden.has(item.page))};
  return {entries, folders: FOLDER_GROUPS.map(withLinks), common: resolve(COMMON_GROUP)};
}

export function folderEntry(id, folders) {
  return folders.find((folder) => folder.id === id)?.items[0]?.page || null;
}

// フォルダを押したときの行き先。固有の画面があれば最初の画面、なければ共通の画面へのリンク（元のフォルダ付き）。
export function folderTarget(id, folders) {
  const folder = folders.find((entry) => entry.id === id);
  if (!folder) return null;
  if (folder.items[0]) return {page: folder.items[0].page, params: {}};
  if (folder.links?.[0]) return {page: folder.links[0].page, params: {[FOLDER_CONTEXT_PARAM]: id}};
  return null;
}

// 未知のページを normalizePage でホームに丸めず、追加忘れ・誤記・重複を試験で検出する。
export function validateFolderPages(items = navItems(), folders = FOLDER_GROUPS) {
  const known = new Set(items.map((item) => item.page));
  const assigned = [...folders, COMMON_GROUP].flatMap((entry) => entry.pages);
  const counts = new Map();
  const errors = [];
  for (const page of assigned) {
    counts.set(page, (counts.get(page) || 0) + 1);
    if (!known.has(page)) errors.push(`未知: ${page}`);
  }
  for (const page of FOLDER_LINK_PAGES) if (!known.has(page)) errors.push(`未知のリンク: ${page}`);
  for (const [page, count] of counts) if (count > 1) errors.push(`重複: ${page}`);
  for (const page of known) if (!counts.has(page)) errors.push(`未割当: ${page}`);
  return errors;
}
