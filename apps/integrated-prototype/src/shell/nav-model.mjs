// 外枠のナビゲーション定義。ページID（src/navigation.mjs の名前）は変えずに、表示名・グループ・1行説明・URL の slug を与える。
// ページIDは試験・設計キャンバス・保存済みの状態と互換にするため固定。表示名だけを業務の言葉にする。
import {WORK_PAGES, EIGYO_PAGES, SALES_PAGES, SHARED_PAGES, normalizePage} from '../navigation.mjs';

// scope: 'work' = 対象作品を選んで使う画面、'company' = 会社全体（閲覧権限内）、'none' = 作品に依存しない管理画面
// hidden: ナビに出さない（URL では開ける）。redirect: 開いたときに別の画面へ移す。
// sub: 売上基幹の中の業務（uriage 計上・mg MG・royalty ロイヤリティ・committee 製作委員会）。業務ごとに流れが違うので2段目で切り替える
export const NAV_GROUPS = Object.freeze({
  work: [
    {id: 'start', label: 'はじめに', items: [
      {page: 'ホーム', label: 'ホーム', slug: 'home', description: '選んだ作品の概要と、次に確かめること'},
    ]},
    {id: 'master', label: 'マスタ', items: [
      {page: '作品・商品マスタ', label: '作品・商品', slug: 'catalog', description: '作品と商品（SKU）・販売ウィンドウの正本'},
      {page: '取引先', label: '取引先', slug: 'partners', description: '配給先・配信事業者・販売店などの一覧と登録'},
      {page: '企画・作品', label: '案件・作品', slug: 'planning', description: '案件（プロジェクト）と作品の一覧と登録'},
    ]},
    {id: 'seisaku', label: '制作', items: [
      {page: '制作', label: '香盤・日々スケ', slug: 'production', description: 'シーン・役・衣装・撮影日・ロケ地と香盤'},
      {page: '台本・香盤', label: '台本の取込', slug: 'script', description: '台本の原本からシーンを読み取り、確認して登録'},
    ]},
    {id: 'rights', label: '権利・宣伝', items: [
      {page: '調達・権利', label: '権利の調達', slug: 'rights-intake', description: '製作委員会・単独保有・権利受託の調達条件'},
      {page: '宣伝', label: '宣伝', slug: 'publicity', description: '施策・露出・指標の記録と分析'},
    ]},
    {id: 'bulk', label: '表の一括編集', items: [
      {page: '業務データ編集', label: 'マスタの表編集', slug: 'work-data', description: '作品・商品・取引先を表で直し、承認して反映'},
    ]},
  ],
  // 営業基幹（2026-09-25）。業務基幹の「営業」グループをここへ移した（ページIDと slug は変えない）。取引先リストは新しい画面
  eigyo: [
    {id: 'eigyo-works', label: '作品一覧', items: [
      {page: '全作品のウィンドウ', label: '全作品のウィンドウ', slug: 'release-windows', description: '全作品の劇場公開・パッケージ・配信・放送・海外のウィンドウを1行1作品で', scope: 'company'},
      {page: '提案資料', label: '提案資料', slug: 'proposals', description: 'PVOD・TVOD・EST の月別の提案資料と SVOD の提案資料を Excel で出す', scope: 'company'},
      {page: '営業作品一覧', label: '流通別の販売条件', slug: 'sales-catalog', description: '作品×流通の販売条件と根拠の一覧'},
    ]},
    {id: 'eigyo-partners', label: '取引先リスト', items: [
      {page: '取引先別リスト', label: '取引先別の配信・販売リスト', slug: 'partner-lists', description: '取引先ごとの配信・販売リストの契約期間、作品×取引先の重なり、期間外の売上の確認', scope: 'company'},
    ]},
    {id: 'eigyo-deals', label: '番販・案件・資料', items: [
      {page: '番販・放送', label: '番販・放送枠', slug: 'broadcast', description: '番組販売の作品一覧、放送枠の申請・承認・実績'},
      {page: '商品・営業', label: '営業案件・契約', slug: 'sales-ops', description: '商品の作品配賦、営業案件、販売契約と納品'},
      {page: '営業資料', label: '営業資料', slug: 'sales-materials', description: '作品ごとの営業資料の作成と版'},
    ]},
  ],
  sales: [
    {id: 'uriage', sub: 'uriage', label: '売上', items: [
      {page: '売上', label: '売上明細', slug: 'sales', description: '登録済みの売上明細を会社全体で確かめ、1件入力・取込へ', scope: 'company'},
      {page: '原本取り込み', label: '売上報告の取込', slug: 'import', description: '受領した報告（Excel・CSV・PDF）を原本ごと取り込む'},
      {page: '売上データ編集', label: '売上の表編集・加工', slug: 'sales-data', description: '売上を表で直し、加工手順を保存して承認・反映'},
      {page: '報告書マッピング', label: '取引先別の列対応', slug: 'report-mapping', description: '取引先ごとの報告の列と共通売上の対応（詳細設定）'},
    ]},
    {id: 'billing', sub: 'uriage', label: '請求・入金', items: [
      {page: '請求・入金', label: '請求・入金', slug: 'billing', description: '請求書の発行・取消と入金の登録'},
      {page: '月別消込', label: '月別入金表', slug: 'receipts', description: '取引先×月の入金予定と消込', scope: 'company'},
      {page: '税ルール・台帳', label: '税計算台帳', slug: 'tax', description: '税計算のルールと計算結果の台帳', scope: 'company'},
    ]},
    {id: 'reports', sub: 'uriage', label: '帳票・分析', items: [
      {page: '帳票センター', label: '帳票センター', slug: 'report-center', description: '年間売上・MG売上報告・ロイヤリティ報告書などを選んで出力', scope: 'company'},
      {page: '売上集計シート', label: '売上集計シート', slug: 'sales-sheet', description: '売上明細1件を1行に83列で。表のまま縦横に見て、絞り込み・集計・Excel と CSV', scope: 'company'},
      {page: '経費集計シート', label: '経費集計シート', slug: 'expense-sheet', description: '経費・請求書・取込と保留・出金予定・会計の設定', scope: 'company'},
      {page: '収支', label: '作品の月別収支', slug: 'income', description: '作品ごとの月別の売上・経費・差額'},
      {page: 'PL・BS', label: 'PL・BS', slug: 'pl-bs', description: '作品別と会社のPL・BS（管理会計の試算。決算書ではありません）', scope: 'company'},
      {page: '分析・Lightdash', label: '分析', slug: 'analytics', description: '登録済みデータの分析（Lightdash）', scope: 'company'},
    ]},
    {id: 'mg', sub: 'mg', label: 'MG', items: [
      {page: 'MG契約・台帳', label: 'MG契約・台帳', slug: 'mg', description: 'MG（最低保証）契約と消化・超過の台帳', scope: 'company'},
      {page: '権利先・MG帳票', label: '権利先・MG帳票', slug: 'rights-reports', description: '権利先・MG・委員会向けの帳票', scope: 'company'},
    ]},
    {id: 'royalty', sub: 'royalty', label: 'ロイヤリティ', items: [
      {page: 'ロイヤリティ作成', label: '報告書の作成', slug: 'royalty-periods', description: '締めを過ぎた期間の一覧と、報告書の一括作成', scope: 'company'},
      {page: 'ロイヤリティ集計', label: 'ロイヤリティ集計シート', slug: 'royalty-ledger', description: '権利者×種別×月の発生額と累計・支払・未払・イレギュラー', scope: 'company'},
      {page: 'ロイヤリティ報告書', label: '報告書・支払', slug: 'royalty-statements', description: '権利者ごとの報告書、報告と支払の記録', scope: 'company'},
      {page: 'ロイヤリティ契約', label: '契約・サイクル', slug: 'royalty-agreements', description: '監督料・脚本料・音楽・原作料の契約、料率の版、計上・報告・支払のサイクル', scope: 'company'},
      {page: '権利・分配', label: '配給委託の精算', slug: 'settlement', description: '配給委託（手数料型・MG型）の権利元への精算と試算'},
    ]},
    {id: 'committee', sub: 'committee', label: '製作委員会', items: [
      {page: '委員会月次収支', label: '月次収支', slug: 'committee-monthly', description: '作品ごとの月次の売上・手数料・経費・権利処理費・出資者別の分配と回収率'},
      {page: '製作委員会', label: '委員会の条件・期間報告', slug: 'committee', description: '委員会の条件と収支・分配の報告'},
    ]},
    {id: 'expenses', sub: 'uriage', label: '経費', items: [
      {page: '経費', label: '経費', slug: 'expenses', description: '作品の経費の登録と予算対比'},
    ]},
    {id: 'help', sub: 'uriage', label: 'ヘルプ', items: [
      {page: 'デモ資料', label: 'デモ資料', slug: 'demo', description: '架空の報告書・契約書・台本のサンプルと、香盤のデモへの入口'},
    ]},
  ],
  shared: [
    {id: 'admin', label: '管理・設計', items: [
      {page: '設計・定義', label: '設計・定義', slug: 'definitions', description: '業務の用語・区分・計算の定義', scope: 'none'},
      {page: '設計キャンバス', label: '設計キャンバス', slug: 'design-canvas', description: '概念・ER・実画面を切り替えて確かめる', scope: 'none'},
      {page: 'ER', label: '表の構造', slug: 'er', description: '業務のデータがどの表に入り、どうつながるか（読み取り専用）', scope: 'none'},
      {page: '拡張項目', label: '拡張項目', slug: 'extensions', description: '宣伝指標などの追加項目の提案と採用', scope: 'none'},
      {page: 'チーム', label: 'チーム', slug: 'team', description: 'メンバーの招待と役割', scope: 'none'},
      {page: 'データ一覧', label: 'データ一覧', slug: 'data', description: '表・列・型・意味・関係を確認。行の中身とExcel出力は管理者のみ', scope: 'none'},
      {page: '取込履歴', label: '取込履歴', slug: 'import-history', description: '売上報告の取込とExcel一括登録の記録（管理者）', scope: 'none'},
    ]},
  ],
});

export const AREA_LABELS = Object.freeze({work: '業務基幹', eigyo: '営業基幹', sales: '売上基幹', shared: '管理・設計'});
export const AREA_HOME = Object.freeze({work: 'ホーム', eigyo: '全作品のウィンドウ', sales: '帳票センター'});
// 上段のタブ（業務基幹｜営業基幹｜売上基幹）。管理・設計は左メニューの下に常に出す
export const TOP_AREAS = Object.freeze(['work', 'eigyo', 'sales']);
// 見える画面が1つも無い領域（上段のタブを押せない）の説明
export const AREA_LOCK_NOTES = Object.freeze({eigyo: '取引・販売の情報は担当範囲外です', sales: '財務情報は担当範囲外です'});
export const HOME_PAGE = 'ホーム';
// 売上基幹の中の業務（2段目）。home はその業務を選んだときに最初に開く画面。最初の業務（計上）が既定
export const SUB_AREAS = Object.freeze([
  Object.freeze({id: 'uriage', label: '計上', home: '帳票センター'}),
  Object.freeze({id: 'mg', label: 'MG', home: 'MG契約・台帳'}),
  Object.freeze({id: 'royalty', label: 'ロイヤリティ', home: 'ロイヤリティ作成'}),
  Object.freeze({id: 'committee', label: '製作委員会', home: '委員会月次収支'}),
]);

const ITEMS = Object.freeze(Object.entries(NAV_GROUPS).flatMap(([area, groups]) => groups.flatMap((group) => group.items.map((item) => Object.freeze({
  scope: 'work', hidden: false, redirect: null, ...item, area, sub: group.sub || null, groupId: group.id, groupLabel: group.label,
})))));
const BY_PAGE = new Map(ITEMS.map((item) => [item.page, item]));
const BY_SLUG = new Map(ITEMS.map((item) => [item.slug, item]));

export const ALL_PAGES = Object.freeze([...WORK_PAGES, ...EIGYO_PAGES, ...SALES_PAGES, ...SHARED_PAGES]);

export function navItems() {
  return ITEMS;
}

export function navItem(page) {
  return BY_PAGE.get(normalizePage(page)) || null;
}

export function slugOf(page) {
  return navItem(page)?.slug || 'home';
}

export function pageOfSlug(slug) {
  const item = BY_SLUG.get(String(slug || '').trim().toLowerCase());
  return item ? item.page : null;
}

// 売上基幹の中の業務（uriage・mg・royalty・committee）。売上基幹以外は null
export function subAreaOf(page) {
  return navItem(page)?.sub || null;
}

export function displayLabel(page) {
  return navItem(page)?.label || String(page || '');
}

export function pageScope(page) {
  return navItem(page)?.scope || 'work';
}

export function areaOf(page) {
  return navItem(page)?.area || 'work';
}

export function groupOf(page) {
  const item = navItem(page);
  return item ? {id: item.groupId, label: item.groupLabel, area: item.area} : null;
}

export function describePage(page) {
  return navItem(page)?.description || '';
}

// 転送先。{page, params} または null。
export function redirectOf(page) {
  return navItem(page)?.redirect || null;
}

// 表示するグループ（役割で使わない画面を除く）。空のグループは出さない。
export function visibleGroups(area, hiddenPages = new Set()) {
  const groups = NAV_GROUPS[area] || [];
  return groups
    .map((group) => ({...group, items: group.items.filter((item) => !item.hidden && !hiddenPages.has(item.page))}))
    .filter((group) => group.items.length > 0);
}

// 見える画面が1つも無い領域は、上段のタブを押せない（制作担当の営業基幹・売上基幹など）。役割で隠す画面から決める
export function isAreaLocked(area, hiddenPages = new Set()) {
  return visibleGroups(area, hiddenPages).length === 0;
}
export function lockedAreas(hiddenPages = new Set()) {
  return new Set(TOP_AREAS.filter((area) => isAreaLocked(area, hiddenPages)));
}

// ---- 売上基幹の2段目（業務）----

const SUB_IDS = new Set(SUB_AREAS.map((sub) => sub.id));
export const DEFAULT_SUB_AREA = SUB_AREAS[0].id;

export function isSubArea(sub) {
  return SUB_IDS.has(sub);
}

export function subAreaInfo(sub) {
  return SUB_AREAS.find((item) => item.id === sub) || null;
}

// 左メニューに出すグループ。売上基幹は、選んでいる業務のグループだけ（業務が不明なら計上）
export function menuGroups(area, sub, hiddenPages = new Set()) {
  const groups = visibleGroups(area, hiddenPages);
  if (area !== 'sales') return groups;
  const current = isSubArea(sub) ? sub : DEFAULT_SUB_AREA;
  return groups.filter((group) => group.sub === current);
}

// 2段目のタブ。役割で1画面も開けない業務は出さない。selected は今の業務
export function subAreaTabs(currentSub, hiddenPages = new Set()) {
  return SUB_AREAS
    .map((sub) => ({id: sub.id, label: sub.label, home: sub.home, selected: sub.id === currentSub, pageCount: menuGroups('sales', sub.id, hiddenPages).reduce((sum, group) => sum + group.items.length, 0)}))
    .filter((tab) => tab.pageCount > 0);
}

// 業務を選んだときに開く画面。最後に開いたその業務の画面 → 業務の最初の画面 → 業務の見える最初の画面。どれも無ければ null
export function subAreaEntry(sub, rememberedPage, hiddenPages = new Set()) {
  const info = subAreaInfo(sub);
  if (!info) return null;
  const remembered = rememberedPage ? navItem(rememberedPage) : null;
  if (remembered && remembered.page === rememberedPage && remembered.sub === sub && !remembered.hidden && !hiddenPages.has(remembered.page)) return remembered.page;
  const first = menuGroups('sales', sub, hiddenPages)[0]?.items[0]?.page || null;
  return hiddenPages.has(info.home) ? first : info.home;
}

// 最後に開いた画面の記録（localStorage）。area ごと（on-last-work・on-last-eigyo など）と、売上基幹は業務ごと（on-last-sales:mg など）
export const lastAreaKey = (area) => `on-last-${area}`;
export const lastSubKey = (sub) => `on-last-sales:${sub}`;

export function rememberPage(storage, page) {
  const item = navItem(page);
  if (!storage || !item || item.page !== page) return;
  try {
    storage.setItem(lastAreaKey(item.area), page);
    if (item.sub) storage.setItem(lastSubKey(item.sub), page);
  } catch { /* 保存できない環境では覚えない */ }
}

export function rememberedPage(storage, sub) {
  if (!storage || !isSubArea(sub)) return null;
  try { return storage.getItem(lastSubKey(sub)) || null; } catch { return null; }
}

// ---- 役割で隠す画面 ----

// 管理者だけが使う画面
export const ADMIN_ONLY_PAGES = Object.freeze(['チーム', '取込履歴']);
// 制作担当に出さない業務基幹の画面（財務・取引の情報を含む）。営業基幹・売上基幹の画面は EIGYO_PAGES・SALES_PAGES から全部隠すので、ここには書かない
export const PRODUCTION_HIDDEN_WORK_PAGES = Object.freeze(['業務データ編集', '取引先', '調達・権利']);

// 役割ごとに左メニューから隠し、URL で開いても表示しない画面。権限の判定そのものはサーバーが行う
export function hiddenPagesForRole(role) {
  if (role === 'admin') return new Set();
  if (role === 'production') return new Set([...EIGYO_PAGES, ...SALES_PAGES, ...PRODUCTION_HIDDEN_WORK_PAGES, ...ADMIN_ONLY_PAGES]);
  return new Set(ADMIN_ONLY_PAGES);
}
