import test from 'node:test';
import assert from 'node:assert/strict';
import {WORK_PAGES, EIGYO_PAGES, SALES_PAGES, SHARED_PAGES, normalizePage, pageArea} from '../src/navigation.mjs';
import {
  NAV_GROUPS, navItems, slugOf, pageOfSlug, displayLabel, pageScope, areaOf, visibleGroups, describePage,
  SUB_AREAS, DEFAULT_SUB_AREA, subAreaOf, menuGroups, subAreaTabs, subAreaEntry, rememberPage, rememberedPage, lastSubKey, lastAreaKey,
  hiddenPagesForRole, ADMIN_ONLY_PAGES, PRODUCTION_HIDDEN_WORK_PAGES, AREA_LABELS, AREA_HOME, TOP_AREAS, AREA_LOCK_NOTES, isAreaLocked, lockedAreas,
} from '../src/shell/nav-model.mjs';
import {parseLocation} from '../src/shell/url-state.mjs';

test('every page appears exactly once in the navigation groups with a unique slug and a description', () => {
  const pages = [...WORK_PAGES, ...EIGYO_PAGES, ...SALES_PAGES, ...SHARED_PAGES];
  const items = navItems();
  assert.equal(items.length, pages.length);
  for (const page of pages) assert.equal(items.filter((item) => item.page === page).length, 1, page);
  const slugs = items.map((item) => item.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of slugs) assert.match(slug, /^[a-z][a-z0-9-]*$/);
  for (const item of items) assert.ok(item.description.length > 4, item.page);
  for (const page of WORK_PAGES) assert.equal(areaOf(page), 'work', page);
  for (const page of EIGYO_PAGES) assert.equal(areaOf(page), 'eigyo', page);
  for (const page of SALES_PAGES) assert.equal(areaOf(page), 'sales', page);
  for (const page of SHARED_PAGES) assert.equal(areaOf(page), 'shared', page);
});

test('slug and page convert both ways; unknown values fall back safely', () => {
  for (const item of navItems()) assert.equal(pageOfSlug(slugOf(item.page)), item.page);
  assert.equal(pageOfSlug('no-such-page'), null);
  assert.equal(slugOf('存在しない画面'), 'home');
  assert.equal(normalizePage('流通マスタ'), '売上');
  assert.equal(displayLabel('原本取り込み'), '売上報告の取込');
  assert.equal(pageScope('帳票センター'), 'company');
  assert.equal(pageScope('制作'), 'work');
  assert.equal(pageScope('ER'), 'none');
  assert.ok(describePage('帳票センター').includes('年間売上'));
});

test('role-hidden pages disappear and empty groups are dropped', () => {
  const hidden = new Set(['経費']);
  const groups = visibleGroups('sales', hidden);
  assert.ok(!groups.some((group) => group.items.some((item) => item.page === '経費')));
  assert.ok(!groups.some((group) => group.id === 'expenses'));
  assert.equal(visibleGroups('sales').length, NAV_GROUPS.sales.length);
  const help = NAV_GROUPS.sales.find((group) => group.id === 'help');
  // デモ資料の入口が見つからないので、ヘルプは最初から開いておく（2026-09-26）
  assert.ok(!help.collapsed, 'ヘルプのグループは畳まない');
  assert.deepEqual(help.items.map((item) => item.page), ['デモ資料']);
  // メニューの説明から、香盤のデモ・台本もここにあると分かる
  assert.match(help.items[0].description, /台本/);
  assert.match(help.items[0].description, /香盤/);
});

// ---- 売上基幹の2段目（業務）----

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {data, getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }};
}

test('every sales group belongs to one of the four sub-areas, and only sales pages have a sub-area', () => {
  assert.deepEqual(SUB_AREAS.map((sub) => [sub.id, sub.label]), [['uriage', '計上'], ['mg', 'MG'], ['royalty', 'ロイヤリティ'], ['committee', '製作委員会']]);
  assert.equal(DEFAULT_SUB_AREA, 'uriage');
  const ids = new Set(SUB_AREAS.map((sub) => sub.id));
  for (const group of NAV_GROUPS.sales) assert.ok(ids.has(group.sub), group.id);
  for (const group of [...NAV_GROUPS.work, ...NAV_GROUPS.eigyo, ...NAV_GROUPS.shared]) assert.equal(group.sub, undefined, group.id);
  for (const page of SALES_PAGES) assert.ok(ids.has(subAreaOf(page)), page);
  for (const page of [...WORK_PAGES, ...EIGYO_PAGES, ...SHARED_PAGES]) assert.equal(subAreaOf(page), null, page);
  // 各業務の最初の画面は、その業務の中にある
  for (const sub of SUB_AREAS) assert.equal(subAreaOf(sub.home), sub.id, sub.home);
  assert.deepEqual(SUB_AREAS.map((sub) => sub.home), ['帳票センター', 'MG契約・台帳', 'ロイヤリティ作成', '委員会月次収支']);
});

test('subAreaOf follows the design table (計上・MG・ロイヤリティ・製作委員会)', () => {
  const expected = {
    uriage: ['売上', '売上集計シート', '経費集計シート', '原本取り込み', '売上データ編集', '報告書マッピング', '請求・入金', '月別消込', '税ルール・台帳', '帳票センター', '収支', 'PL・BS', '分析・Lightdash', '経費', 'デモ資料'],
    mg: ['MG契約・台帳', '権利先・MG帳票'],
    royalty: ['ロイヤリティ作成', 'ロイヤリティ集計', 'ロイヤリティ報告書', 'ロイヤリティ契約', '権利・分配'],
    committee: ['委員会月次収支', '製作委員会'],
  };
  for (const [sub, pages] of Object.entries(expected)) for (const page of pages) assert.equal(subAreaOf(page), sub, page);
  assert.equal(Object.values(expected).flat().length, SALES_PAGES.length);
  assert.equal(displayLabel('権利・分配'), '配給委託の精算');
});

test('old ?p= links keep their slugs and land in the right sub-area', () => {
  const cases = {
    billing: ['請求・入金', 'uriage'], 'report-center': ['帳票センター', 'uriage'], receipts: ['月別消込', 'uriage'], expenses: ['経費', 'uriage'], demo: ['デモ資料', 'uriage'],
    mg: ['MG契約・台帳', 'mg'], 'rights-reports': ['権利先・MG帳票', 'mg'], settlement: ['権利・分配', 'royalty'], committee: ['製作委員会', 'committee'],
  };
  for (const [slug, [page, sub]] of Object.entries(cases)) {
    const location = parseLocation(`?p=${slug}&work=1`);
    assert.equal(location.page, page, slug);
    assert.equal(subAreaOf(location.page), sub, slug);
    assert.equal(slugOf(page), slug);
  }
});

test('the left menu shows only the current sub-area groups; other areas are unchanged', () => {
  const ids = (groups) => groups.map((group) => group.id);
  assert.deepEqual(ids(menuGroups('sales', 'uriage')), ['uriage', 'billing', 'reports', 'expenses', 'help']);
  assert.deepEqual(ids(menuGroups('sales', 'mg')), ['mg']);
  assert.deepEqual(ids(menuGroups('sales', 'royalty')), ['royalty']);
  assert.deepEqual(ids(menuGroups('sales', 'committee')), ['committee']);
  // 不明な業務は計上として扱う
  assert.deepEqual(ids(menuGroups('sales', 'nope')), ids(menuGroups('sales', 'uriage')));
  assert.deepEqual(ids(menuGroups('work', 'mg')), ids(visibleGroups('work')));
  assert.deepEqual(ids(menuGroups('eigyo', 'mg')), ['eigyo-works', 'eigyo-partners', 'eigyo-deals']);
  assert.deepEqual(ids(menuGroups('shared', 'mg')), ids(visibleGroups('shared')));
  // 計上（既定の業務）のメニューに請求・入金がある（検証レシピ login-roles の前提）
  assert.ok(menuGroups('sales', DEFAULT_SUB_AREA).some((group) => group.items.some((item) => item.page === '請求・入金')));
  // 4つの業務のメニューを合わせると売上基幹の全画面
  const all = SUB_AREAS.flatMap((sub) => menuGroups('sales', sub.id).flatMap((group) => group.items.map((item) => item.page)));
  assert.deepEqual([...all].sort(), [...SALES_PAGES].sort());
  // 役割で隠した画面は業務のメニューからも消える
  assert.deepEqual(ids(menuGroups('sales', 'mg', new Set(['MG契約・台帳', '権利先・MG帳票']))), []);
});

test('the sub-area tab model marks the selected tab and drops sub-areas with no visible page', () => {
  const tabs = subAreaTabs('royalty');
  assert.deepEqual(tabs.map((tab) => tab.label), ['計上', 'MG', 'ロイヤリティ', '製作委員会']);
  assert.deepEqual(tabs.filter((tab) => tab.selected).map((tab) => tab.id), ['royalty']);
  assert.deepEqual(tabs.map((tab) => tab.pageCount), [15, 2, 5, 2], '計上は経費集計シートを含めて15画面');
  const withoutMg = subAreaTabs('uriage', new Set(['MG契約・台帳', '権利先・MG帳票']));
  assert.deepEqual(withoutMg.map((tab) => tab.id), ['uriage', 'royalty', 'committee']);
  assert.deepEqual(subAreaTabs('uriage', hiddenPagesForRole('production')), []);
  assert.equal(subAreaTabs('uriage', hiddenPagesForRole('editor')).length, 4);
});

test('switching sub-area opens the remembered page of that sub-area, else its home', () => {
  assert.equal(subAreaEntry('mg', null), 'MG契約・台帳');
  assert.equal(subAreaEntry('mg', '権利先・MG帳票'), '権利先・MG帳票');
  // 別の業務の画面・売上基幹以外の画面・不明な画面・旧名は、覚えた画面として使わない
  assert.equal(subAreaEntry('mg', '請求・入金'), 'MG契約・台帳');
  assert.equal(subAreaEntry('royalty', 'ホーム'), 'ロイヤリティ作成');
  assert.equal(subAreaEntry('uriage', '存在しない画面'), '帳票センター');
  assert.equal(subAreaEntry('uriage', '流通マスタ'), '帳票センター');
  // 覚えた画面が役割で隠れていたら最初の画面、最初の画面も隠れていたらその業務で見える最初の画面
  assert.equal(subAreaEntry('royalty', 'ロイヤリティ集計', new Set(['ロイヤリティ集計'])), 'ロイヤリティ作成');
  assert.equal(subAreaEntry('royalty', null, new Set(['ロイヤリティ作成'])), 'ロイヤリティ集計');
  assert.equal(subAreaEntry('mg', null, new Set(['MG契約・台帳', '権利先・MG帳票'])), null);
  assert.equal(subAreaEntry('nope', null), null);
});

test('remembered pages are stored per area and per sales sub-area', () => {
  const storage = memoryStorage();
  rememberPage(storage, '権利先・MG帳票');
  rememberPage(storage, '請求・入金');
  rememberPage(storage, 'ロイヤリティ集計');
  rememberPage(storage, '制作');
  rememberPage(storage, 'ER');
  assert.equal(lastSubKey('mg'), 'on-last-sales:mg');
  assert.equal(lastAreaKey('sales'), 'on-last-sales');
  assert.equal(storage.getItem('on-last-sales'), 'ロイヤリティ集計');
  assert.equal(storage.getItem('on-last-work'), '制作');
  assert.equal(storage.getItem('on-last-shared'), 'ER');
  assert.equal(rememberedPage(storage, 'mg'), '権利先・MG帳票');
  assert.equal(rememberedPage(storage, 'uriage'), '請求・入金');
  assert.equal(rememberedPage(storage, 'royalty'), 'ロイヤリティ集計');
  assert.equal(rememberedPage(storage, 'committee'), null);
  assert.equal(rememberedPage(storage, 'work'), null);
  assert.equal(subAreaEntry('mg', rememberedPage(storage, 'mg')), '権利先・MG帳票');
  assert.equal(subAreaEntry('committee', rememberedPage(storage, 'committee')), '委員会月次収支');
  // 未知の画面は覚えない。保存できない環境（プライベートブラウズなど）でも落ちない
  rememberPage(storage, '存在しない画面');
  assert.equal(storage.data.size, 6);
  const broken = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }};
  assert.doesNotThrow(() => rememberPage(broken, '請求・入金'));
  assert.equal(rememberedPage(broken, 'uriage'), null);
  assert.equal(rememberedPage(null, 'uriage'), null);
});

test('production hides every sales page automatically; other roles keep the visible set', () => {
  const production = hiddenPagesForRole('production');
  for (const page of [...SALES_PAGES, ...EIGYO_PAGES]) assert.ok(production.has(page), page);
  for (const page of [...PRODUCTION_HIDDEN_WORK_PAGES, ...ADMIN_ONLY_PAGES]) assert.ok(production.has(page), page);
  const visible = (hidden, pages) => pages.filter((page) => !hidden.has(page));
  assert.deepEqual(visible(production, WORK_PAGES), ['ホーム', '作品・商品マスタ', '企画・作品', '制作', '台本・香盤', '宣伝']);
  assert.deepEqual(visible(production, SHARED_PAGES), ['設計・定義', '設計キャンバス', 'ER', '拡張項目', 'データ一覧']);
  assert.deepEqual(visible(production, SALES_PAGES), []);
  assert.deepEqual(visible(production, EIGYO_PAGES), []);
  assert.deepEqual(visibleGroups('sales', production), []);
  assert.deepEqual(visibleGroups('eigyo', production), []);
  assert.deepEqual([...hiddenPagesForRole('editor')], ['チーム', '取込履歴']);
  assert.deepEqual([...hiddenPagesForRole('admin')], []);
  assert.deepEqual([...hiddenPagesForRole(undefined)], ['チーム', '取込履歴']);
});

// ---- 営業基幹（上段の3つ目のタブ）----

test('営業基幹は上段の真ん中のタブで、業務基幹の「営業」グループの画面をページID・slug を変えずに持つ', () => {
  assert.deepEqual(TOP_AREAS, ['work', 'eigyo', 'sales']);
  assert.deepEqual(TOP_AREAS.map((area) => AREA_LABELS[area]), ['業務基幹', '営業基幹', '売上基幹']);
  assert.equal(AREA_HOME.eigyo, '全作品のウィンドウ');
  assert.equal(areaOf(AREA_HOME.eigyo), 'eigyo');
  assert.equal(pageArea('全作品のウィンドウ'), 'eigyo');
  assert.equal(pageArea('作品・商品マスタ'), 'work');
  assert.equal(pageScope('全作品のウィンドウ'), 'company');
  assert.equal(slugOf('全作品のウィンドウ'), 'release-windows');
  // 前からの URL（slug）はそのまま、開くと営業基幹の画面になる
  const moved = {'sales-catalog': '営業作品一覧', broadcast: '番販・放送', 'sales-ops': '商品・営業', 'sales-materials': '営業資料'};
  for (const [slug, page] of Object.entries(moved)) {
    assert.equal(pageOfSlug(slug), page, slug);
    assert.equal(parseLocation(`?p=${slug}&work=1`).page, page, slug);
    assert.equal(areaOf(page), 'eigyo', page);
  }
  assert.deepEqual(NAV_GROUPS.eigyo.map((group) => [group.label, group.items.map((item) => item.label)]), [
    ['作品一覧', ['全作品のウィンドウ', '提案資料', '流通別の販売条件']],
    ['取引先リスト', ['取引先別の配信・販売リスト']],
    ['番販・案件・資料', ['番販・放送枠', '営業案件・契約', '営業資料']],
  ]);
  // 取引先別の配信・販売リスト（設計 §3）は会社全体の画面で、URL は ?p=partner-lists
  assert.equal(slugOf('取引先別リスト'), 'partner-lists');
  assert.equal(pageScope('取引先別リスト'), 'company');
  assert.equal(areaOf('取引先別リスト'), 'eigyo');
  // 提案資料（月別・SVOD）は作品一覧の2つ目で、会社全体の画面。URL は ?p=proposals
  assert.equal(slugOf('提案資料'), 'proposals');
  assert.equal(pageScope('提案資料'), 'company');
  assert.equal(pageOfSlug('proposals'), '提案資料');
  assert.ok(!NAV_GROUPS.work.some((group) => group.id === 'eigyo'), '業務基幹に営業のグループは残さない');
  assert.ok(!visibleGroups('work').some((group) => group.items.some((item) => EIGYO_PAGES.includes(item.page))));
  assert.equal(normalizePage('全作品のウィンドウ'), '全作品のウィンドウ');
});

test('見える画面が無い領域は押せない（制作担当は営業基幹・売上基幹とも）。ほかの役割はどれも押せる', () => {
  const production = hiddenPagesForRole('production');
  assert.equal(isAreaLocked('eigyo', production), true);
  assert.equal(isAreaLocked('sales', production), true);
  assert.equal(isAreaLocked('work', production), false);
  assert.deepEqual([...lockedAreas(production)].sort(), ['eigyo', 'sales']);
  assert.deepEqual([...lockedAreas(hiddenPagesForRole('editor'))], []);
  assert.deepEqual([...lockedAreas(hiddenPagesForRole('admin'))], []);
  // 規則は一般の形: 営業基幹の画面を全部隠せば、どの役割でも押せなくなる
  assert.deepEqual([...lockedAreas(new Set(EIGYO_PAGES))], ['eigyo']);
  assert.deepEqual([...lockedAreas(new Set(EIGYO_PAGES.slice(1)))], []);
  assert.equal(AREA_LOCK_NOTES.sales, '財務情報は担当範囲外です');
  assert.ok(AREA_LOCK_NOTES.eigyo.length > 4);
});

test('営業基幹で最後に開いた画面は on-last-eigyo に覚える', () => {
  const storage = memoryStorage();
  rememberPage(storage, '番販・放送');
  rememberPage(storage, '制作');
  assert.equal(storage.getItem('on-last-eigyo'), '番販・放送');
  assert.equal(storage.getItem('on-last-work'), '制作');
  assert.equal(lastAreaKey('eigyo'), 'on-last-eigyo');
});
