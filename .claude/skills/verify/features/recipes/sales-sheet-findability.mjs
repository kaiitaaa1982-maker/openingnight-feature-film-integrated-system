// features/sales-sheet-findability.md のレシピ。売上集計シートの入口（左メニュー・よく使う帳票・営業基幹）、未採用の案内と組織の切替、固定列・月の列の位置・流通ID・行数・最新の年度。
// 前提: launch した使い捨てDBへ seed-sales-demo.mjs → seed-eigyo-demo.mjs を流し、--user admin@openingnight.invalid（組織1と DEMO-SALES に所属）で drive する。
// 組織1では列を採用しない（採用は取り消せない）。組織を切り替えるので、最後に組織1へ戻す。
import assert from 'node:assert/strict';
import {slugOf} from '../../../../../apps/integrated-prototype/src/shell/nav-model.mjs';
import {openPage, openSubArea} from './_sales.mjs';

const DEMO_ORG = '架空データ（デモ）';
const HOME_ORG = 'オープニングナイト試作チーム';
const TITLE = '売上集計シート（83列）';
const headers = async (table) => (await table.locator('thead tr').last().locator('th').allInnerTexts()).map((text) => text.replace(/[▲▼]/g, '').trim());
async function waitSheet(page) {
  const table = page.getByRole('table', {name: TITLE, exact: true});
  await table.waitFor();
  await page.getByText(/^条件に合う明細 /).first().waitFor();
  return table;
}
async function switchOrgFromTop(page, name) {
  const select = page.getByRole('combobox', {name: '組織'});
  await select.waitFor();
  const label = (await select.locator('option').allInnerTexts()).find((text) => text.startsWith(`${name}・`));
  assert.ok(label, `組織の選択肢に ${name} がありません`);
  await select.selectOption({label});
  await page.getByRole('button', {name: '切り替える', exact: true}).click();
  await page.getByRole('heading', {name: 'ホーム', level: 1, exact: true}).waitFor();
}

export default async ({page, shot, step, api}) => {
  const orgs = (await (await api.get('/api/session/orgs')).json()).orgs;
  assert.ok(orgs.some((org) => org.name === DEMO_ORG), 'DEMO-SALES に所属していません。seed-sales-demo.mjs を流してください');
  const session = await (await api.get('/api/session')).json();
  if (orgs.find((org) => org.id === session.user.orgId)?.name !== HOME_ORG) await switchOrgFromTop(page, HOME_ORG);
  assert.equal((await (await api.get('/api/sales-sheet/columns')).json()).adopted, false, '組織1の列が採用済みです。launch からやり直してください');

  // ssf-menu：計上の左メニューに「売上集計シート」
  const nav = await openSubArea(page, '計上');
  const labels = (await nav.getByRole('link').allInnerTexts()).map((text) => text.split('\n')[0].trim());
  assert.equal(labels[labels.indexOf('帳票センター') + 1], '売上集計シート', labels.join('・'));
  assert.equal(labels[labels.indexOf('売上集計シート') + 1], '経費集計シート', labels.join('・'));
  await nav.getByRole('link', {name: /^売上集計シート/}).click();
  await page.getByRole('heading', {name: '売上集計シート', level: 1, exact: true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('p'), 'sales-sheet');
  step('ssf-menu: 売上基幹 → 計上 の左メニュー（帳票センターの次）に「売上集計シート」。押すと単独の画面（URL p=sales-sheet）');
  await shot('ssf-menu');

  // ssf-unadopted：未採用の案内 → 採用済みの組織へ切り替えて開く
  await page.getByText('売上集計シートの列がまだありません').waitFor();
  await page.getByText('採用は取り消せません。').waitFor();
  await page.getByText('採用する列の一覧を見る（103列）').click();
  const list = page.getByRole('table', {name: '採用する列の一覧', exact: true});
  await list.waitFor();
  assert.equal(await list.locator('tbody tr').count(), 103);
  await shot('ssf-unadopted');
  await page.getByRole('button', {name: `組織「${DEMO_ORG}」に切り替えて売上集計シートを開く`}).click();
  await page.getByRole('heading', {name: '売上集計シート', level: 1, exact: true}).waitFor();
  // 既定の年度は今日の年度で、0件だと表（role=table）は出ない。切り替えた先が売上集計シートであることを確かめてから、架空データのある年度で開き直す
  await page.getByText(/^条件に合う明細 /).first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('p'), 'sales-sheet');
  await page.goto('/?p=sales-sheet&fy=2025');
  await waitSheet(page);
  step('ssf-unadopted: 組織1では「採用は取り消せません」と採用する列の一覧（103行）。「組織「架空データ（デモ）」に切り替えて売上集計シートを開く」で表が出る');

  // ssf-featured：よく使う帳票のカード → 読み込みのあと表の位置まで送る
  await openPage(page, '帳票センター', {fy: 2025}); // カードは report だけを足すので fy=2025 が残る（今日の年度に依存しない）
  await page.getByRole('button', {name: new RegExp(`^${TITLE.replace(/[()（）]/g, '.')}`)}).first().click();
  const heading = page.getByRole('heading', {name: TITLE, level: 2, exact: true});
  await heading.waitFor();
  await waitSheet(page);
  await page.waitForTimeout(1500);
  const box = await heading.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.y >= 0 && box.y < viewport.height, `見出しの位置 ${box?.y}（画面の高さ ${viewport.height}）`);
  step(`ssf-featured: 帳票センターの「よく使う帳票」の「${TITLE}」を押すと、読み込みのあと見出しが画面の中（上から ${Math.round(box.y)}px）に来る`);
  await shot('ssf-featured');

  // ssf-pinned：明細の先頭3列を固定
  await page.goto(`/?p=sales-sheet&fy=2025`);
  let table = await waitSheet(page);
  const first = await headers(table);
  assert.deepEqual(first.slice(0, 3), ['計上月', '作品コード', '作品名']);
  const positions = await table.locator('thead tr').last().locator('th').evaluateAll((cells) => cells.slice(0, 4).map((cell) => getComputedStyle(cell).position));
  assert.deepEqual(positions.slice(0, 3), ['sticky', 'sticky', 'sticky']);
  step(`ssf-pinned: 基本の列セットの明細は 計上月・作品コード・作品名 が先頭で固定（${positions.join('・')}）`);
  await shot('ssf-pinned');

  // ssf-pivot-order：月を横に並べた集計は、月の列が切り口の直後
  await page.goto(`/?p=sales-sheet&fy=2025&ssgrain=aggregate&ssdims=work&sspivot=1`);
  table = await waitSheet(page);
  const pivot = await headers(table);
  assert.deepEqual(pivot.slice(0, 3), ['作品', '2025-05', '2025-06']);
  assert.ok(pivot.indexOf('2026-04') < pivot.indexOf('明細数'), pivot.join('・'));
  step(`ssf-pivot-order: 作品で集計して月を横に並べると、見出しは ${pivot.slice(0, 4).join('・')}… で、月の列は明細数より前`);
  await shot('ssf-pivot-order');

  // ssf-filters：流通ID（流通マスタの ID）・1ページの行数
  await page.goto(`/?p=sales-sheet&fy=2025`);
  let filtered = await waitSheet(page);
  // 架空データは流通マスタの ID で分類している（2026-09-26 に旧区分から分類し直した）。分類の無い明細（風鈴と転校生のセル1行）は「未分類」と出る
  const master = new Set((await (await api.get('/api/distribution-master')).json()).rows.map((row) => row.code));
  const columnTexts = async (table, label) => {
    const at = (await headers(table)).indexOf(label);
    assert.ok(at >= 0, `${label} の列がありません`);
    return (await table.locator('tbody tr').evaluateAll((rows, i) => rows.map((row) => row.children[i]?.textContent?.trim() || ''), at)).filter(Boolean);
  };
  const shownCodes = await columnTexts(filtered, '流通ID');
  const notMaster = [...new Set(shownCodes.filter((code) => !master.has(code)))];
  assert.ok(shownCodes.length >= 50, `流通IDの列 ${shownCodes.length}件`);
  assert.ok(notMaster.every((code) => code === '未分類'), `流通マスタに無い流通ID: ${notMaster.join('・')}`);
  // 分類の無い明細は件数の行に「流通の分類待ち」として出る（英字の旧区分のキーは出さない）
  const waiting = (await page.getByText(/流通の分類待ち \d+件/).first().innerText()).match(/流通の分類待ち (\d+)件/)?.[1];
  assert.equal(waiting, '1', '2025年度の分類待ちは風鈴と転校生のセル1件');
  const dist = page.getByRole('combobox', {name: '流通ID'});
  assert.ok((await dist.locator('option').allInnerTexts()).includes('未分類（ビデオグラム・区分未確認）'), '分類の無い明細の既定は「未分類（…）」の選択肢');
  const tvod = (await dist.locator('option').allInnerTexts()).find((text) => text.startsWith('D004｜'));
  assert.ok(tvod, '流通IDの選択肢に D004（配信・RS・TVOD）');
  await dist.selectOption({label: tvod});
  await page.waitForURL(/ssdist=D004/);
  await page.getByRole('combobox', {name: '1ページの行数'}).selectOption({label: '500行'});
  await page.waitForURL(/sspsize=500/);
  filtered = await waitSheet(page);
  // 絞り込みの読み直しが終わるまで待つ（最大10秒）
  let tvodCodes = [];
  for (const started = Date.now(); Date.now() - started < 10000; await page.waitForTimeout(250)) {
    tvodCodes = await columnTexts(filtered, '流通ID');
    if (tvodCodes.length && tvodCodes.every((code) => code === 'D004')) break;
  }
  assert.ok(tvodCodes.length > 0 && tvodCodes.every((code) => code === 'D004'), `D004 で絞った流通IDの列: ${[...new Set(tvodCodes)].join('・')}`);
  step(`ssf-filters: 2025年度の明細の流通IDの列は流通マスタの ID（${[...new Set(shownCodes)].sort().join('・')}）。分類の無い明細は「未分類」で、件数の行に「流通の分類待ち ${waiting}件」、選択肢に「未分類（ビデオグラム・区分未確認）」。流通IDで「${tvod}」を選ぶと URL に ssdist=D004 で ${tvodCodes.length}件がすべて D004、1ページの行数で500行を選ぶと sspsize=500`);
  await shot('ssf-filters');

  // ssf-latest-year：行の無い年度では「データのある最新の年度を見る」
  await page.goto(`/?p=sales-sheet&fy=2027`);
  await page.getByText(/^条件に合う明細 0件/).waitFor();
  await page.getByRole('button', {name: 'データのある最新の年度（2026年度）を見る'}).click();
  await page.waitForURL(/fy=2026/);
  await page.getByText(/^条件に合う明細 [1-9]/).waitFor();
  step('ssf-latest-year: 2027年度（行なし）で「データのある最新の年度（2026年度）を見る」を押すと2026年度の行が出る');
  await shot('ssf-latest-year');

  // ssf-royalty-label：ロイヤリティの左メニュー
  const royalty = await openSubArea(page, 'ロイヤリティ');
  const link = royalty.getByRole('link', {name: /^ロイヤリティ集計シート/});
  assert.equal(await link.getAttribute('href'), `?p=${slugOf('ロイヤリティ集計')}`);
  step('ssf-royalty-label: ロイヤリティの左メニューは「ロイヤリティ集計シート」（URL は royalty-ledger のまま）');
  await shot('ssf-royalty-label');

  // ssf-eigyo-link：全作品のウィンドウの行から。先頭の行は売上の無い新作・連続ドラマなので、売上のある DEMO-W01 の行で確かめる
  const w01 = (await (await api.get('/api/bootstrap')).json()).works.find((work) => work.code === 'DEMO-W01');
  assert.ok(w01, 'DEMO-W01 がありません');
  await openPage(page, '全作品のウィンドウ');
  const rowLink = page.getByRole('row').filter({hasText: 'DEMO-W01'}).getByRole('link', {name: '売上集計シートで見る'});
  await rowLink.waitFor();
  await rowLink.click();
  await page.getByRole('heading', {name: '売上集計シート', level: 1, exact: true}).waitFor();
  const workId = new URL(page.url()).searchParams.get('workId');
  assert.equal(workId, String(w01.id));
  await page.getByText(/^条件に合う明細 /).first().waitFor();
  const latest = page.getByRole('button', {name: /^データのある最新の年度（\d+年度）を見る/});
  if (await latest.count()) await latest.first().click(); // 今日の年度に行が無いときは最新の年度へ
  const sheet = await waitSheet(page);
  const columnNames = await headers(sheet);
  const codeAt = columnNames.indexOf('作品コード');
  assert.ok(codeAt >= 0, `作品コードの列が無い（${columnNames.join('・')}）`);
  const codes = (await sheet.locator('tbody tr').evaluateAll((rows, at) => rows.map((row) => row.children[at]?.textContent?.trim() || ''), codeAt)).filter(Boolean);
  assert.ok(codes.length >= 1 && codes.every((code) => code === 'DEMO-W01'), `作品コードの列: ${[...new Set(codes)].join('・')}`);
  step(`ssf-eigyo-link: 全作品のウィンドウの DEMO-W01 の行の「売上集計シートで見る」で workId=${workId}。明細 ${codes.length}件がすべて DEMO-W01`);
  await shot('ssf-eigyo-link');

  await switchOrgFromTop(page, HOME_ORG);
};
