import test from 'node:test';
import assert from 'node:assert/strict';
import {FOLDER_GROUPS, FOLDER_LINK_PAGES, folderOf, folderOfView, folderContextId, folderNavigation, folderEntry, folderTarget, validateFolderPages} from '../src/shell/folder-nav.mjs';
import {navItems, navItem, hiddenPagesForRole, REPRESENTATIVE_PAGES} from '../src/shell/nav-model.mjs';
import {initialLocation, buildSearch, parseLocation} from '../src/shell/url-state.mjs';

test('20フォルダが指定の番号順・名前で並び、契約と納品物は固有の画面が空のまま残る', () => {
  assert.deepEqual(FOLDER_GROUPS.map(({id, label}) => [id, label]), [
    ['F01', '企画'], ['F02', 'プロデュース管理'], ['F03', 'プリプロダクション'], ['F04', 'プロダクション'],
    ['F05', 'ポストプロダクション'], ['F06', '営業管理'], ['F07', '販売管理'], ['F08', 'ロイヤリティ報告管理'],
    ['F09', 'MG_買付分管理'], ['F10', 'MG_販売分管理'], ['F11', '予実管理'], ['F12', '経費管理'],
    ['F13', '出金_入金管理'], ['F14', 'PL_BS'], ['F15', '製作委員会プロジェクト'], ['F16', '契約'],
    ['F17', '納品物'], ['F18', '宣伝'], ['F19', '調達'], ['F20', '製造'],
  ]);
  const {folders, common} = folderNavigation({mode: 'local'});
  assert.deepEqual(folders.filter((f) => f.items.length === 0).map((f) => f.id), ['F16', 'F17']);
  // 業務ひな型は全フォルダから開ける。空の F16・F17 も押せる
  assert.deepEqual(folders.filter((f) => f.disabled).map((f) => f.id), []);
  assert.deepEqual(common.items.map((i) => i.page), ['取引先', '業務データ編集', '業務ひな型', 'デモ資料', '原本の置き場', 'チーム', '取込履歴', 'フォルダ', '表の見本']);
});

test('全ページはフォルダ・共通・管理に一度だけ属し、未知・重複・未割当を検出する', () => {
  assert.deepEqual(validateFolderPages(), []);
  assert.equal(folderOf('経費').id, 'F12');
  assert.equal(folderOf('経費集計シート').id, 'F12');
  assert.equal(folderOf('フォルダ').id, 'common');
  for (const page of ['チーム', '取込履歴']) assert.equal(folderOf(page).id, 'common', page);
  assert.equal(folderOf('ホーム').id, 'common');
  assert.equal(folderOf('原本の置き場').id, 'common');
  assert.equal(navItem('原本の置き場').scope, 'company');
  assert.equal(parseLocation('?p=source-tree').page, '原本の置き場');
  assert.equal(hiddenPagesForRole('production').has('原本の置き場'), true);
  assert.equal(folderOf('不存在'), null);
  assert.ok(validateFolderPages([...navItems(), {page: '新画面'}]).includes('未割当: 新画面'));
  assert.ok(validateFolderPages(navItems().filter((i) => i.page !== '経費')).includes('未知: 経費'));
  assert.ok(validateFolderPages(navItems(), [...FOLDER_GROUPS, {id: 'extra', pages: ['経費']}]).includes('重複: 経費'));
});

test('フォルダとページの対応は代表のF01〜F20の表と一致する', () => {
  const expected = [
    ['企画', '予算書', 'シナリオの比較'],
    ['プロデュース管理', '企画・作品', '作品・商品マスタ'],
    ['プリプロ', '許可申請', '小道具', '台本・香盤', '制作'], ['撮影の記録', '実費'], ['ポスプロ'],
    ['全作品のウィンドウ', '提案資料', '営業作品一覧', '取引先別リスト', '番販・放送', '商品・営業', '営業資料'],
    ['売上', '原本取り込み', '売上データ編集', '報告書マッピング', '売上集計シート', '帳票センター', '請求・入金', '月別消込'],
    ['ロイヤリティフォルダ', 'ロイヤリティ作成', 'ロイヤリティ集計', 'ロイヤリティ報告書', 'ロイヤリティ契約', '権利・分配'],
    ['MG 買付'], ['MG契約・台帳', '権利先・MG帳票'], ['予実管理'], ['経費', '経費集計シート'],
    ['入出金', '税ルール・台帳'], ['PL・BS', '収支', '分析・Lightdash'],
    ['委員会月次収支', '製作委員会', '委員会の台帳'], [], [], ['宣伝'], ['調達', '調達・権利'], ['製造'],
  ];
  assert.deepEqual(FOLDER_GROUPS.map((folder) => [...folder.pages]), expected);
});

test('フォルダの項目は既存の表示名・slug・scopeを使い、ページIDを変えない', () => {
  for (const group of Object.values(folderNavigation({mode: 'local'})).flat()) {
    for (const item of group.items) assert.deepEqual(item, navItem(item.page));
  }
  assert.deepEqual(folderNavigation().folders[2].items.map((i) => i.page), ['プリプロ', '許可申請', '小道具', '台本・香盤', '制作']);
  assert.deepEqual(folderNavigation().folders[12].items.map((i) => i.page), ['入出金', '税ルール・台帳']);
});

test('制作担当には財務のリンクが出ず、見える画面のないフォルダも20個の中に残る', () => {
  const hiddenPages = hiddenPagesForRole('production');
  const navigation = folderNavigation({hiddenPages, mode: 'local'});
  const {folders, common} = navigation;
  assert.equal('admin' in navigation, false, '管理・設計の欄は無い');
  assert.equal(folders.length, 20);
  for (const id of ['F01', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F19', 'F20']) {
    // 財務の固有の画面は出ない。共通の業務ひな型へのリンクだけが残り、フォルダは押せる
    assert.deepEqual(folders.find((f) => f.id === id).items, [], id);
    assert.deepEqual(folders.find((f) => f.id === id).links.map((i) => i.page), ['業務ひな型'], id);
  }
  for (const group of [...folders, common]) for (const item of group.items) assert.equal(hiddenPages.has(item.page), false);
  assert.equal(folders[2].disabled, false);
});

test('代表モードと役割・localOnly・hiddenを重ねても権限で隠す画面が戻らない', () => {
  const rep = folderNavigation({viewMode: 'representative', mode: 'local'});
  // ホームと全案件はフォルダに属さない入口（全案件は左メニューの先頭の入口に出る）
  assert.deepEqual(rep.folders.flatMap((f) => f.items.map((i) => i.page)).sort(), REPRESENTATIVE_PAGES.filter((p) => p !== 'ホーム' && p !== '全案件').sort());
  assert.deepEqual(rep.common.items, []);
  assert.equal(folderNavigation({mode: 'local'}).common.items.some((i) => i.page === 'フォルダ'), true);
  for (const mode of ['worker', null, undefined]) assert.equal(folderNavigation({mode}).common.items.some((i) => i.page === 'フォルダ'), false);
  const hiddenPages = new Set(['経費', '経費集計シート']);
  assert.equal(folderNavigation({hiddenPages, viewMode: 'representative'}).folders[11].disabled, true);
  const items = navItems().map((item) => item.page === '経費' ? {...item, hidden: true} : item);
  assert.equal(folderNavigation({items}).folders[11].items.some((i) => i.page === '経費'), false);
});

test('フォルダの入口は見える最初の画面で、空・未知のフォルダには移動しない', () => {
  const {folders} = folderNavigation({hiddenPages: new Set(['経費'])});
  assert.equal(folderEntry('F12', folders), '経費集計シート');
  assert.equal(folderEntry('F16', folders), null);
  assert.equal(folderEntry('nope', folders), null);
});

test('ページ指定のない初回は古い記録によらず一覧へ入り、作品と保存済みURLは保つ', () => {
  for (const value of ['MG契約・台帳', 'ホーム', '壊れた値', '{', null]) {
    const storage = {getItem: (key) => key === 'on-work' ? '7' : value};
    assert.deepEqual(initialLocation('', storage), {page: 'フォルダ一覧', workId: 7, params: {}});
    assert.equal(initialLocation('?p=home', storage).page, 'ホーム');
    assert.equal(initialLocation('?p=folders', storage).page, 'フォルダ');
    assert.equal(initialLocation('?p=expenses', storage).page, '経費');
  }
  assert.equal(initialLocation('', {getItem() { throw Error('blocked'); }}).page, 'フォルダ一覧');
  assert.equal(buildSearch({page: 'フォルダ一覧'}), '?p=folder-home');
  assert.equal(parseLocation('?p=folder-home').page, 'フォルダ一覧');
});

test('FR-PROD-TMPL-014 業務ひな型は F01〜F20 の全フォルダのメニューにリンクで入り、表の所属は共通のまま変わらない', () => {
  assert.deepEqual([...FOLDER_LINK_PAGES], ['業務ひな型']);
  const {folders, common} = folderNavigation({mode: 'local'});
  assert.equal(folders.length, 20);
  for (const folder of folders) {
    assert.deepEqual(folder.links.map((i) => i.page), ['業務ひな型'], folder.id);
    assert.deepEqual(folder.links[0], navItem('業務ひな型'));
    assert.equal(folder.items.some((i) => i.page === '業務ひな型'), false, `${folder.id} の固有の画面に重複して入れない`);
    assert.equal(folder.pages.includes('業務ひな型'), false);
  }
  assert.equal(folderOf('業務ひな型').id, 'common');
  assert.equal(common.items.some((i) => i.page === '業務ひな型'), true);
  assert.deepEqual(folders.find((f) => f.id === 'F04').items.map((i) => i.page), ['撮影の記録', '実費']);
  assert.deepEqual(validateFolderPages(), []);
  assert.ok(validateFolderPages(navItems().filter((i) => i.page !== '業務ひな型')).includes('未知のリンク: 業務ひな型'));
});

test('FR-PROD-TMPL-014 開いた元のフォルダは URL の folder で持ち、画面の所属は変えずにフォルダの表示だけ切り替える', () => {
  assert.equal(folderContextId('業務ひな型', {folder: 'F04'}), 'F04');
  assert.equal(folderOfView('業務ひな型', {folder: 'F04'}).label, 'プロダクション');
  assert.equal(folderOfView('業務ひな型', {}).id, 'common');
  for (const bad of ['F99', 'F4', 'common', '', null, undefined, 'f04']) assert.equal(folderContextId('業務ひな型', {folder: bad}), null, String(bad));
  // 他の画面には効かない
  assert.equal(folderContextId('経費', {folder: 'F04'}), null);
  assert.equal(folderOfView('経費', {folder: 'F04'}).id, 'F12');
  const search = buildSearch({page: '業務ひな型', params: {folder: 'F04'}});
  assert.equal(search, '?p=work-templates&folder=F04');
  assert.deepEqual(parseLocation(search), {page: '業務ひな型', workId: null, params: {folder: 'F04'}});
});

test('FR-PROD-TMPL-014 フォルダを押した行き先は固有の最初の画面、無ければ業務ひな型（元のフォルダ付き）', () => {
  const {folders} = folderNavigation({mode: 'local'});
  assert.deepEqual(folderTarget('F04', folders), {page: '撮影の記録', params: {}});
  assert.deepEqual(folderTarget('F16', folders), {page: '業務ひな型', params: {folder: 'F16'}});
  assert.deepEqual(folderTarget('F17', folders), {page: '業務ひな型', params: {folder: 'F17'}});
  assert.equal(folderTarget('nope', folders), null);
  // 代表モードではリンクも出ない（代表の対象画面の表を変えない）
  const rep = folderNavigation({viewMode: 'representative', mode: 'local'});
  assert.deepEqual(rep.folders.flatMap((f) => f.links), []);
  assert.equal(folderTarget('F16', rep.folders), null);
  // 画面を隠す役割・環境では、リンクも出ない
  const hidden = folderNavigation({hiddenPages: new Set(['業務ひな型'])});
  assert.deepEqual(hidden.folders.flatMap((f) => f.links), []);
  assert.equal(hidden.folders.find((f) => f.id === 'F16').disabled, true);
});
