import test from 'node:test';
import assert from 'node:assert/strict';
import {FOLDER_GROUPS, folderOf, folderNavigation, folderEntry, validateFolderPages} from '../src/shell/folder-nav.mjs';
import {navItems, navItem, hiddenPagesForRole, REPRESENTATIVE_PAGES} from '../src/shell/nav-model.mjs';
import {initialLocation, buildSearch, parseLocation} from '../src/shell/url-state.mjs';

test('20フォルダが指定の番号順・名前で並び、契約と納品物は空のまま残る', () => {
  assert.deepEqual(FOLDER_GROUPS.map(({id, label}) => [id, label]), [
    ['F01', '企画'], ['F02', 'プロデュース管理'], ['F03', 'プリプロダクション'], ['F04', 'プロダクション'],
    ['F05', 'ポストプロダクション'], ['F06', '営業管理'], ['F07', '販売管理'], ['F08', 'ロイヤリティ報告管理'],
    ['F09', 'MG_買付分管理'], ['F10', 'MG_販売分管理'], ['F11', '予実管理'], ['F12', '経費管理'],
    ['F13', '出金_入金管理'], ['F14', 'PL_BS'], ['F15', '製作委員会プロジェクト'], ['F16', '契約'],
    ['F17', '納品物'], ['F18', '宣伝'], ['F19', '調達'], ['F20', '製造'],
  ]);
  const {folders, common} = folderNavigation({mode: 'local'});
  assert.deepEqual(folders.filter((f) => f.disabled).map((f) => f.id), ['F16', 'F17']);
  assert.deepEqual(common.items.map((i) => i.page), ['取引先', '業務データ編集', 'デモ資料']);
});

test('全ページはフォルダ・共通・管理に一度だけ属し、未知・重複・未割当を検出する', () => {
  assert.deepEqual(validateFolderPages(), []);
  assert.equal(folderOf('経費').id, 'F12');
  assert.equal(folderOf('経費集計シート').id, 'F12');
  assert.equal(folderOf('フォルダ').id, 'admin');
  assert.equal(folderOf('ホーム').id, 'common');
  assert.equal(folderOf('不存在'), null);
  assert.ok(validateFolderPages([...navItems(), {page: '新画面'}]).includes('未割当: 新画面'));
  assert.ok(validateFolderPages(navItems().filter((i) => i.page !== '経費')).includes('未知: 経費'));
  assert.ok(validateFolderPages(navItems(), [...FOLDER_GROUPS, {id: 'extra', pages: ['経費']}]).includes('重複: 経費'));
});

test('フォルダとページの対応は代表のF01〜F20の表と一致する', () => {
  const expected = [
    ['企画', '予算書', 'シナリオの比較'],
    ['プロデュース管理', '企画・作品', '作品・商品マスタ'],
    ['プリプロ', '台本・香盤', '制作'], ['撮影の記録'], ['ポスプロ'],
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
  assert.deepEqual(folderNavigation().folders[2].items.map((i) => i.page), ['プリプロ', '台本・香盤', '制作']);
  assert.deepEqual(folderNavigation().folders[12].items.map((i) => i.page), ['入出金', '税ルール・台帳']);
});

test('制作担当には財務のリンクが出ず、見える画面のないフォルダも20個の中に残る', () => {
  const hiddenPages = hiddenPagesForRole('production');
  const {folders, common, admin} = folderNavigation({hiddenPages, mode: 'local'});
  assert.equal(folders.length, 20);
  for (const id of ['F01', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F19', 'F20']) {
    assert.equal(folders.find((f) => f.id === id).disabled, true, id);
  }
  for (const group of [...folders, common, admin]) for (const item of group.items) assert.equal(hiddenPages.has(item.page), false);
  assert.equal(folders[2].disabled, false);
});

test('代表モードと役割・localOnly・hiddenを重ねても権限で隠す画面が戻らない', () => {
  const rep = folderNavigation({viewMode: 'representative', mode: 'local'});
  assert.deepEqual(rep.folders.flatMap((f) => f.items.map((i) => i.page)).sort(), REPRESENTATIVE_PAGES.filter((p) => p !== 'ホーム').sort());
  assert.deepEqual(rep.admin.items, []);
  assert.deepEqual(rep.common.items, []);
  assert.equal(folderNavigation({mode: 'local'}).admin.items.some((i) => i.page === 'フォルダ'), true);
  for (const mode of ['worker', null, undefined]) assert.equal(folderNavigation({mode}).admin.items.some((i) => i.page === 'フォルダ'), false);
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
