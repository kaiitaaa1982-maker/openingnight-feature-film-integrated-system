// 組織の切替のあとの作品の扱い（useAppShellState）を、main.jsx の switchOrg と同じ順で動かして確かめる（DOM は最小の代用品）。
// 手順: 組織Aの作品で開く → navigate('ホーム', {}, {force, clearWork}) → 読み直しの通信の間（前の組織の作品のまま描く）→ 組織Bの作品に差し替える。
// 壊れたら: 通信の間に前の組織の作品IDを URL に書き戻し、読み直した後に「指定の作品（作品ID 1）は…開ける作品にありません」が毎回出る。
// あわせて、作品選択で作品を替えたときに台本の原本ID（artifact）を持ち越さないことも確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';

const ORG_A = [{id: 1, code: 'WRK-DEMO'}, {id: 2, code: 'WRK-2'}];
const ORG_B = [{id: 10, code: 'DEMO-N01'}, {id: 11, code: 'DEMO-W01'}, {id: 23, code: 'DEMO-D78'}];
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// URL と localStorage を持つ最小の window。書いた URL を順に残す
function fakeWindow(search) {
  const loc = {search, pathname: '/'};
  const urls = [];
  const storage = new Map();
  const write = (url) => { loc.search = url.slice(url.indexOf('?')); urls.push(loc.search); };
  globalThis.window = {
    location: loc,
    history: {pushState: (_s, _t, url) => write(url), replaceState: (_s, _t, url) => write(url)},
    addEventListener() {}, removeEventListener() {},
    localStorage: {getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k)},
    HTMLIFrameElement: class {},
  };
  globalThis.localStorage = globalThis.window.localStorage;
  return {loc, urls};
}

async function mount(search) {
  await tick(50); // 前の試験の描画を片付けてから window を差し替える
  const env = fakeWindow(search);
  const React = (await import('react')).default;
  const {createRoot} = await import('react-dom/client');
  const {useAppShellState} = await import('../src/shell/context.mjs');
  const out = {};
  function Harness() {
    const [works, setWorks] = React.useState(ORG_A);
    out.setWorks = setWorks;
    out.nav = useAppShellState({request: async () => ({}), works});
    return null;
  }
  const doc = {nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null};
  const container = {nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc, addEventListener() {}, removeEventListener() {}, set textContent(value) {}};
  const root = createRoot(container);
  root.render(React.createElement(Harness));
  await tick(30);
  return {...env, out, unmount: () => root.unmount()};
}

// main.jsx の switchOrg と同じ順: 組織を変えるときはホームへ（作品を外す）→ 通信の間 → 新しい組織の作品 → 切替後の行き先（あれば）
async function switchOrg(h, after = null) {
  const {destinationAfterOrgChange, afterOrgChangeOptions} = await import('../src/demo-guide.mjs');
  h.urls.length = 0;
  h.out.nav.navigate('ホーム', {}, {force: true, clearWork: true});
  await tick(30);
  h.out.setWorks(ORG_B);
  if (after) {
    const target = destinationAfterOrgChange(after.dest, after.works || ORG_B);
    h.out.nav.navigate(target.page, target.params, afterOrgChangeOptions(target));
  }
  await tick(50);
}

test('組織の切替: 通信の間に前の組織の作品を URL に書き戻さず、切り替えた後に「開ける作品にありません」を出さない', async () => {
  const h = await mount('?p=production&work=1');
  try {
    await switchOrg(h);
    assert.ok(!h.urls.some((url) => /[?&]work=1(&|$)/.test(url)), `前の組織の作品 1 を書き戻さない: ${h.urls.join(' → ')}`);
    assert.match(h.loc.search, /work=10/);
    assert.equal(h.out.nav.missingWork, null);
  } finally { h.unmount(); }
});

test('組織の切替: 売上集計シートへ移るとき・香盤のデモ（DEMO-D78）が切替先に無くてホームへ戻るときも知らせは出ず、DEMO-D78 があればその作品を開く', async () => {
  const {KOUBAN_DEMO_DESTINATION} = await import('../src/demo-guide.mjs');
  const sheet = await mount('?p=production&work=1');
  try {
    await switchOrg(sheet, {dest: {page: '売上集計シート'}});
    assert.equal(sheet.out.nav.page, '売上集計シート');
    assert.equal(sheet.out.nav.missingWork, null);
  } finally { sheet.unmount(); }
  const missing = await mount('?p=production&work=1');
  try {
    await switchOrg(missing, {dest: KOUBAN_DEMO_DESTINATION, works: ORG_B.filter((work) => work.code !== 'DEMO-D78')});
    assert.equal(missing.out.nav.missingWork, null);
  } finally { missing.unmount(); }
  const kouban = await mount('?p=production&work=1');
  try {
    await switchOrg(kouban, {dest: KOUBAN_DEMO_DESTINATION});
    assert.match(kouban.loc.search, /work=23/);
    assert.equal(kouban.out.nav.missingWork, null);
  } finally { kouban.unmount(); }
});

test('対照: 起動時の URL が別の組織の作品（work=99）なら、従来どおり最初の作品に直して知らせる', async () => {
  const h = await mount('?p=production&work=99');
  try {
    assert.equal(h.out.nav.missingWork, 99);
    assert.match(h.loc.search, /work=1/);
  } finally { h.unmount(); }
});

test('作品選択で作品を替えると、台本の原本ID（artifact）を持ち越さない。ほかの条件は残す', async () => {
  const {paramsForWorkChange, WORK_BOUND_PARAMS} = await import('../src/shell/url-state.mjs');
  assert.deepEqual(paramsForWorkChange({artifact: '1', month: '2026-09'}), {month: '2026-09'});
  assert.deepEqual(WORK_BOUND_PARAMS, ['artifact']);
  const h = await mount('?p=script&work=1&artifact=5&month=2026-09');
  try {
    h.out.nav.selectWork(2);
    await tick(20);
    assert.doesNotMatch(h.loc.search, /artifact=/);
    assert.match(h.loc.search, /work=2/);
    assert.match(h.loc.search, /month=2026-09/);
    // 画面の移動で原本と作品を一緒に指定したときは、その原本IDを残す（別の作品の原本なら画面が知らせる）
    h.out.nav.navigate('台本・香盤', {artifact: '5'}, {workId: 1});
    await tick(20);
    assert.match(h.loc.search, /artifact=5/);
  } finally { h.unmount(); }
});
