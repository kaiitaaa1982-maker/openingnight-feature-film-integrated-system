// 番販・放送の新しい部品を文字列に描いて確かめる（JSX は esbuild で変換する。DOM は使わない）。
// 壊れたら: 作品を選ぶ前から出力のリンクが出て0件の Excel を落とせる・時間軸の棒が期間と違う位置に出る。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function renderer() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {AvailsListPanel} from './src/broadcast/AvailsListPanel.jsx'; import {ProposalTimeline, ProposalDetail} from './src/broadcast/WindowProposals.jsx'; import {DraftComposer, ProposalDraftsPanel} from './src/broadcast/ProposalDrafts.jsx';\n"
        + 'export const avails = (props) => renderToStaticMarkup(React.createElement(AvailsListPanel, props));\nexport const timeline = (props) => renderToStaticMarkup(React.createElement(ProposalTimeline, props));\n'
        + 'export const detail = (props) => renderToStaticMarkup(React.createElement(ProposalDetail, props));\n'
        + 'export const composer = (props) => renderToStaticMarkup(React.createElement(DraftComposer, props));\nexport const draftsPanel = (props) => renderToStaticMarkup(React.createElement(ProposalDraftsPanel, props));',
      resolveDir: appDir, loader: 'jsx', sourcefile: 'broadcast-windows-ui-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'},
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-broadcast-ui-'));
  const file = join(dir, 'broadcast-ui.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { return createRequire(import.meta.url)(file); } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('放送アベイルズリストの作成は、作品を選ぶまで出力のリンクを出さず「0件では出力しません」と示す', async () => {
  const {avails} = await renderer();
  const html = avails({request: async () => ({}), currentWorks: [{id: 1, code: 'W01', title: '一'}]});
  assert.match(html, /放送アベイルズリストを作る/);
  assert.match(html, /作品を1件以上選ぶと出力できます（0件では出力しません）/);
  assert.doesNotMatch(html, /availability-list\/export\.xlsx/);
  assert.match(html, /放送履歴表に出ている作品をすべて入れる（1件）/);
});

test('提案の時間軸は、基準日〜24か月後に対して棒を期間の位置に置き、各行に名前を付ける', async () => {
  const {timeline} = await renderer();
  const html = timeline({timeline: {from: '2026-01-01', to: '2026-12-31', lanes: [
    {key: 'proposal', label: '提案する期間', bars: [{from: '2026-07-02', to: '2026-12-31', label: '提案'}]},
    {key: 'exclusive', label: '独占の契約', bars: []},
  ]}});
  assert.match(html, /aria-label="時間軸 2026\/01\/01〜2026\/12\/31"/);
  const style = /class="bw-bar is-proposal" style="left:([\d.]+)%;width:([\d.]+)%"/.exec(html);
  assert.ok(style, html);
  assert.equal(Math.round(Number(style[1])), 50, '7月2日は1年の真ん中');
  assert.equal(Math.round(Number(style[2])), 50);
  assert.match(html, /独占の契約<\/span><div class="bw-lane-track"><span class="bw-bar-none">なし<\/span>/);
});

test('提案の行を開くと、許諾回数とホールドバックを入れる場所を案内し、未確認の明細には取引先別リストへ移るボタンを出す', async () => {
  const {detail} = await renderer();
  const base = {state: 'ok', timeline: {from: '2026-09-26', to: '2028-09-26', lanes: []}, basis: [], blocked: [], proposals: [], recent: [], reasons: []};
  const missing = detail({row: {allowed_text: 'なし', result: {...base, licenses: [{entryId: 12, station: '架空BS', exclusivity: 'nonexclusive', licensed: null, used: 0, remaining: null, holdbackMonths: null, partnerId: 7, listId: 3}]}}});
  assert.match(missing, /取引先別リスト › 局のリスト › 明細を開いた「放送の条件」で入れます/);
  assert.match(missing, /取引先別リストで入れる（明細 12）/);
  assert.match(missing, /ホールドバック未確認/);
  const filled = detail({row: {allowed_text: 'なし', result: {...base, licenses: [{entryId: 12, station: '架空BS', exclusivity: 'nonexclusive', licensed: 3, used: 1, remaining: 2, holdbackMonths: 6, partnerId: 7, listId: 3}]}}});
  assert.doesNotMatch(filled, /取引先別リストで入れる/);
});

// 提案の結果（書き下し）: 提案する期間は 2026-10-01〜2026-12-31（初回）と 2027-07-01〜2027-12-31（再放送）、独占 2027-01-01〜2027-06-30
const proposalRowFixture = (extra = {}) => ({
  key: '1:9', work_id: 1, work_code: 'W01', work_title: '一（架空）', product_id: 9, product_sku: 'W01-TV', product_name: '放送権（架空）', state: 'ok', allowed_text: '2026/10/01〜2027/12/31', can_edit: true,
  live_slots: [{slot_id: 77, month: '2026-11', station: '架空BS', status: 'confirmed'}],
  result: {state: 'ok', horizon: {from: '2026-09-26', to: '2027-12-31'}, allowed: [{from: '2026-10-01', to: '2027-12-31'}], basis: [], reasons: [], recent: [], licenses: [],
    blocked: [{kind: 'exclusive', from: '2027-01-01', to: '2027-06-30', station: '架空CS', planned: false}],
    proposals: [{from: '2026-10-01', to: '2026-12-31', run: '初回', others: []}, {from: '2027-07-01', to: '2027-12-31', run: '再放送', others: []}],
    timeline: {from: '2026-09-26', to: '2027-12-31', lanes: []}},
  ...extra,
});

test('提案から下書きを作る入力は、提案する期間の中の月だけを選択肢に出し、選べない月は理由をまとめて示す', async () => {
  const {composer} = await renderer();
  const html = composer({row: proposalRowFixture(), asOf: '2026-09-26', minMonths: '3', request: async () => ({}),
    stations: [{partner_id: 5, name: '架空BS', station_type: 'bs'}, {partner_id: 6, name: '架空テレビ', station_type: null}]});
  assert.match(html, /aria-label="放送権（架空）の提案から放送枠の下書きを作る"/);
  // 選べる月: 2026年10月〜12月・2027年7月〜12月の9か月（checkbox）。2026年9月・2027年1月〜6月は選択肢に無い
  const months = [...html.matchAll(/<input type="checkbox"[^>]*\/>(\d{4}年\d{1,2}月)/g)].map((m) => m[1]);
  assert.deepEqual(months, ['2026年10月', '2026年11月', '2026年12月', '2027年7月', '2027年8月', '2027年9月', '2027年10月', '2027年11月', '2027年12月']);
  assert.match(html, /選べない月（7か月）と理由/);
  assert.match(html, /<li>2026年9月：放送してよい期間の外（権利・放送の解禁・販売条件）<\/li>/);
  assert.match(html, /<li>2027年1月〜2027年6月：独占契約中（架空CS・2027\/01\/01〜2027\/06\/30）<\/li>/);
  // 局は種別つき（未登録は「種別未登録」）。初回／再放送は提案の計算（最初の月は初回）に合わせて選ばれている
  assert.match(html, /<option value="5">架空BS（BS）<\/option>/);
  assert.match(html, /<option value="6">架空テレビ（種別未登録）<\/option>/);
  assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="first"\/>初回/);
  assert.match(html, /提案の計算では初回です/);
  assert.match(html, /下書きを作る（0か月）/);
  // 局を選ぶ前は二重登録の印を出さない（局を選ぶと、その局の生きている枠がある月は選べなくなる）
  assert.doesNotMatch(html, /この局の放送枠あり/);
});

test('提案の行の詳細: 編集できる人には「提案する（下書きを作る）」、閲覧だけの人には案内を出し、提案の無い行には出さない', async () => {
  const {detail} = await renderer();
  const compose = {open: false, stations: [], asOf: '2026-09-26', minMonths: '3', request: async () => ({}), onOpen: () => {}, onClose: () => {}, onCreated: () => {}};
  assert.match(detail({row: proposalRowFixture(), compose}), /<button type="button">提案する（下書きを作る）<\/button>/);
  const viewer = detail({row: proposalRowFixture({can_edit: false}), compose});
  assert.doesNotMatch(viewer, /提案する（下書きを作る）<\/button>/);
  assert.match(viewer, /提案から放送枠の下書きを作れるのは、案件の編集権限がある人です/);
  const full = detail({row: proposalRowFixture({state: 'full', result: {...proposalRowFixture().result, state: 'full', proposals: []}}), compose});
  assert.doesNotMatch(full, /提案する（下書きを作る）/);
  assert.match(detail({row: proposalRowFixture(), compose: {...compose, open: true}}), /放送する月（提案する期間の中の月。複数選べます）/);
  // 下書きを作った後: 入力のあった行の中に知らせ（フォーカスを受けられる枠・作った下書きを見るボタン）を出し、入力とボタンは出さない
  const done = detail({row: proposalRowFixture(), compose: {...compose, created: '架空BSへ放送枠の下書きを2件作りました（2026年11月・2026年12月）', onShowDrafts: () => {}}});
  assert.match(done, /<div class="bw-created" tabindex="-1" aria-label="下書きを作った知らせ"><div class="on-notice on-notice-ok on-notice-compact" role="status">/);
  assert.match(done, /架空BSへ放送枠の下書きを2件作りました（2026年11月・2026年12月）/);
  assert.match(done, /作った下書きを見る<\/button>/);
  assert.match(done, /続けて提案する<\/button>/);
  assert.doesNotMatch(done, /提案する（下書きを作る）<\/button>/);
  assert.doesNotMatch(done, /放送する月（提案する期間の中の月。複数選べます）/);
});

test('提案から作った下書きの一覧: 下書きのうちだけ「削除（合意に至らず）」を出し、申請中は出さず、閲覧用では出さない。削除したものは別に理由つきで出す', async () => {
  const {draftsPanel} = await renderer();
  const base = {work_id: 1, work_code: 'W01', work_title: '一（架空）', product_sku: 'W01-TV', product_name: '放送権（架空）', station_name: '架空BS', station_type: 'bs', period_from: '2026-11-01', period_to: '2026-11-30',
    run_label: '初回', as_of: '2026-09-26', proposal_from: '2026-10-01', proposal_to: '2026-12-31', created_by_name: '編集担当', created_at: '2026-09-26 03:00:00', revision: 1, can_edit: true};
  const drafts = {
    rows: [{...base, slot_id: 11, broadcast_month: '2026-11', status: 'draft', can_delete: true}, {...base, slot_id: 12, broadcast_month: '2026-12', status: 'pending_first', revision: 2, can_delete: false}],
    deleted: [{...base, slot_id: 13, broadcast_month: '2027-07', status: 'cancelled', deleted: true, deleted_reason: '局の編成と合わず（架空）', deleted_by_name: '編集担当', deleted_at: '2026-09-26 04:00:00', can_delete: false}],
    counts: {drafts: 1, inFlow: 1, rejected: 0, cancelled: 0, deleted: 1},
  };
  const html = draftsPanel({drafts, request: async () => ({}), onReload: () => {}, onOpenSlot: () => {}});
  assert.match(html, /下書き 1件・申請中〜確定 1件・削除した下書き 1件/, '差し戻しと中止は0件なら省く');
  assert.doesNotMatch(html, /申請中から先/);
  assert.equal([...html.matchAll(/削除（合意に至らず）…/g)].length, 1, '下書きの行だけ');
  assert.match(html, /放送枠を開く（合意したら申請）/);
  assert.match(html, /架空BS（BS）/);
  assert.match(html, /削除した下書き（1件・合意に至らず）/);
  assert.match(html, /局の編成と合わず（架空）/);
  const readOnly = draftsPanel({drafts, readOnly: true, request: async () => ({}), onReload: () => {}, onOpenSlot: () => {}});
  assert.doesNotMatch(readOnly, /削除（合意に至らず）…/);
  assert.doesNotMatch(readOnly, /合意したら申請/);
  assert.match(draftsPanel({drafts: {rows: [], deleted: [], counts: {drafts: 0, inFlow: 0, rejected: 0, cancelled: 0, deleted: 0}}, request: async () => ({})}), /提案から作った下書きはまだありません/);
});

test('提案から作った下書きの一覧: 売上を紐付けた下書きは削除を出さずに中止を案内し、放送枠のタブで直した行・提案する期間の外の行に印を出す。件数は差し戻し・中止も分ける', async () => {
  const {draftsPanel} = await renderer();
  const base = {work_id: 1, work_code: 'W01', work_title: '一（架空）', product_sku: 'W01-TV', product_name: '放送権（架空）', station_name: '架空BS', station_type: 'bs', period_from: '2026-11-01', period_to: '2026-11-30',
    run_label: '初回', as_of: '2026-09-26', proposal_from: '2026-10-01', proposal_to: '2026-12-31', created_by_name: '編集担当', created_at: '2026-09-26 03:00:00', revision: 1, can_edit: true,
    proposed_station_name: '架空BS', proposed_month: '2026-11', status: 'draft'};
  const drafts = {
    rows: [
      {...base, slot_id: 21, broadcast_month: '2026-11', has_sales: true, can_delete: false},
      {...base, slot_id: 22, broadcast_month: '2027-02', station_name: '架空地上波', station_type: 'terrestrial', period_from: '2027-02-01', period_to: '2027-02-28', revision: 3,
        changed_after_proposal: true, outside_proposal: true, needs_check: true, check_reason: '2027年2月は提案する期間の外です（独占契約中（架空CS・2027/01/01〜2027/06/30））', can_delete: true},
    ],
    deleted: [],
    counts: {drafts: 2, inFlow: 0, rejected: 1, cancelled: 2, deleted: 0},
  };
  const html = draftsPanel({drafts, request: async () => ({}), onReload: () => {}, onOpenSlot: () => {}});
  assert.match(html, /下書き 2件・申請中〜確定 0件・差し戻し 1件・中止 2件・削除した下書き 0件/);
  assert.equal([...html.matchAll(/削除（合意に至らず）…/g)].length, 1, '売上ありの下書きには削除のボタンを出さない');
  assert.match(html, /売上が紐付いているため削除できません。放送枠のタブで中止してください/);
  assert.match(html, /架空地上波（地上波）/);
  assert.match(html, /放送枠のタブで修正済み（提案の後に月・局を変更）/);
  assert.match(html, /提案する期間の外（要確認）：2027年2月は提案する期間の外です（独占契約中（架空CS・2027\/01\/01〜2027\/06\/30））/);
  assert.equal([...html.matchAll(/放送枠のタブで修正済み/g)].length, 1, '直していない行には印を付けない');
});
