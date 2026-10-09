// features/pl-bs.md のレシピ。売上基幹 › 計上 › 帳票・分析の「PL・BS」（管理会計の試算）と、経費の出金・帳票センターの入口を確かめる。
// 前提: launch した使い捨てDBへ seed-sales-demo.mjs → seed-plbs-demo.mjs（または seed-all-demo.mjs）を流し、--user demo-admin@openingnight.invalid（組織 DEMO-SALES だけに所属）で drive する。
// 手入力を1行足して取り消し、作品のある未払の経費のうち計上月の早い最初の1件に出金を記録する（seed-sales→seed-plbs 直後は DEMO-W01 の海外素材費。
// 流し直すと次の未払へ移る）。作品のある未払が尽きると失敗する。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {slugOf} from '../../../../../apps/integrated-prototype/src/shell/nav-model.mjs';
import {decodeXlsx} from '../../../../../apps/integrated-prototype/src/xlsx.mjs';
import {openSubArea, yen, tile, gridCell, until} from './_sales.mjs';

const FY = {fy: '2025', period: 'fy'};
const BS_MONTH = '2026-06';
const url = (params) => `/?${new URLSearchParams({p: slugOf('PL・BS'), ...FY, bsMonth: BS_MONTH, ...params})}`;
const tabs = (page) => page.getByRole('tablist', {name: 'PL・BS の表'});
const report = async (api) => (await api.get(`/api/reports/pl-bs?from=2025-05&to=2026-04&asOf=${BS_MONTH}`)).json();
// 帳票の見出しの出力（region の最初の group「出力」）は3シート。表ごとの出力（DataGrid）はその表だけ。
// 2段の見出し（期間・累計などのまとまり）の表は、見出しの最後の行の列名で数える（_sales.mjs の gridCell はまとまりの行も数える）
const dataRows = (table) => table.locator('tbody > tr[data-pos]');
async function cellOf(table, row, label) {
  const names = (await table.locator('thead tr').last().locator('th').allInnerTexts()).map((text) => text.replace(/[▲▼]/g, '').trim());
  const index = names.indexOf(label);
  if (index < 0) throw new Error(`列「${label}」が無い（${names.join('・')}）`);
  const target = typeof row === 'string' ? dataRows(table).filter({hasText: row}).first() : row;
  await target.waitFor();
  return (await target.locator('td').nth(index).innerText()).trim();
}

export default async ({page, shot, step, api}) => {
  const body = await report(api);
  assert.equal(body.ok, true, body.error || 'PL・BS の API が読めません。seed-plbs-demo.mjs を流してください');

  // plbs-entry：売上基幹 → 計上 → 左メニューの PL・BS
  const nav = await openSubArea(page, '計上', {expectPage: '帳票センター'});
  await nav.getByRole('link', {name: /^PL・BS/}).click();
  await page.getByRole('heading', {name: 'PL・BS', level: 1, exact: true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('p'), 'pl-bs');
  await page.getByText('管理会計の試算（決算書ではありません）', {exact: true}).first().waitFor();
  assert.deepEqual(await tabs(page).getByRole('tab').allInnerTexts(), ['作品別PL', '作品別の残高', '会社PL', '会社BS', '手入力', '会社の設定']);
  step('plbs-entry: 売上基幹 → 計上 → 左メニュー「PL・BS」（?p=pl-bs）。見出しの帯に「管理会計の試算（決算書ではありません）」、タブは 作品別PL・作品別の残高・会社PL・会社BS・手入力・会社の設定');
  await shot('plbs-entry');

  // plbs-work-pl：2025年度の作品別PL。委員会作品の自社の取得額は委員会の月次収支の DEMO-SELF と同じ
  await page.goto(url({plbsTab: 'work-pl'}));
  const workTable = page.getByRole('table', {name: '作品別PL', exact: true});
  await workTable.waitFor();
  // 行の数は API の作品別PL と同じ（seed-all-demo の順で入れると27作品。売上と PL・BS だけなら20作品）
  assert.equal(await dataRows(workTable).count(), body.workPl.length);
  const w01 = body.workPl.find((row) => row.code === 'DEMO-W01');
  const monthly = await (await api.get(`/api/reports/committee-monthly?workId=${w01.workId}&from=2025-05&to=2026-04`)).json();
  const self = monthly.report.investors.find((row) => /自社/.test(row.name));
  assert.equal(yen(await cellOf(workTable, 'DEMO-W01', '委員会の自社の取得額')), self.period.acquisition);
  assert.equal(yen(await cellOf(workTable, 'DEMO-W01', 'ロイヤリティ')), 0);
  await dataRows(workTable).filter({hasText: 'DEMO-W02'}).first().click();
  await page.getByRole('region', {name: /^DEMO-W02｜.*の月別$/}).waitFor();
  step(`plbs-work-pl: 2025年度の作品別PLは${body.workPl.length}作品（API の作品別PL と同じ数）。DEMO-W01 の「期間 委員会の自社の取得額」が委員会の月次収支の自社の取得額（${self.period.acquisition.toLocaleString('ja-JP')}円）と同じで、ロイヤリティは0。DEMO-W02 の行を押すと月別が開く`);
  await shot('plbs-work-pl');

  // plbs-company-pl：会社PLの当期純利益
  await tabs(page).getByRole('tab', {name: '会社PL', exact: true}).click();
  await page.getByRole('table', {name: '会社PL（月次）', exact: true}).waitFor();
  assert.equal(await tile(page, '当期純利益（期間）'), body.companyPl.netIncome.period);
  for (const label of ['役員報酬', '支払利息', '当期純利益']) await page.getByRole('table', {name: '会社PL（月次）'}).getByRole('row').filter({hasText: label}).first().waitFor();
  step(`plbs-company-pl: 会社PLの当期純利益（期間）が API と同じ ${body.companyPl.netIncome.period.toLocaleString('ja-JP')}円。役員報酬・支払利息の行がある`);
  await shot('plbs-company-pl');

  // plbs-company-bs / plbs-excel：会社BSの説明のつかない差額と、Excel の同じ数字
  await tabs(page).getByRole('tab', {name: '会社BS', exact: true}).click();
  const bsTable = page.getByRole('table', {name: '会社の簡易BS', exact: true});
  await bsTable.waitFor();
  for(const label of ['未払金（カード）','前払金','預り金（源泉）','締め日未整備分（参考の未払残高）'])await bsTable.getByText(label,{exact:true}).waitFor();
  assert.equal(await tile(page, '説明のつかない差額'), body.companyBs.difference);
  assert.equal(body.companyBs.difference, 0, '減価償却費に見合う固定資産の月末残高も入れているので0');
  assert.match(await dataRows(bsTable).last().innerText(), /説明のつかない差額（資産−負債−純資産）/);
  const hints = page.getByRole('table', {name: '差額の手がかり', exact: true});
  assert.equal(yen(await gridCell(hints, '減価償却費', '額')), 1300000);
  assert.equal(yen(await gridCell(hints, '固定資産', '額')), -1300000);
  assert.ok(body.companyBs.rows.find((row) => row.key === 'cash').value > 0, '現預金はプラス（架空の追加借入）');
  assert.equal(await page.getByRole('status').filter({hasText: '現預金がマイナス'}).count(), 0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('region', {name: '会社BS', exact: true}).getByRole('group', {name: '出力'}).first().getByRole('button', {name: 'Excel', exact: true}).click()]);
  const workbook = decodeXlsx(readFileSync(await download.path()));
  assert.deepEqual(workbook.map((sheet) => sheet.name), ['会社BS', '差額の手がかり', '参考']);
  const last = workbook[0].rows.find((cells) => String(cells[1] || '').startsWith('説明のつかない差額'));
  assert.equal(Number(last[3]), body.companyBs.difference);
  step('plbs-company-bs: 2026年6月末の会社BSの最後の行は「説明のつかない差額」で 0。手がかりは減価償却費（26か月分）1,300,000 と固定資産の減少 −1,300,000 が打ち消し合い、現預金はプラスで注意は出ない');
  step('plbs-excel: 会社BSの Excel はシート 会社BS・差額の手がかり・参考で、説明のつかない差額が画面と同じ');
  await shot('plbs-company-bs');

  // plbs-manual：雑費を1行足して取り消す
  await tabs(page).getByRole('tab', {name: '手入力', exact: true}).click();
  const matrix = page.getByRole('table', {name: '手入力の額（勘定科目×月）', exact: true});
  await matrix.waitFor();
  const before = yen(await gridCell(matrix, '雑費', '2026年4月'));
  const form = page.locator('form.plbs-form').filter({hasText: '額を入れる'});
  await form.getByRole('combobox', {name: '勘定科目'}).selectOption({label: '6290 雑費（販売費及び一般管理費）'});
  await form.getByLabel(/^月/).fill('2026-04'); // 必須の印（必須）がラベルの中にある
  await form.getByRole('textbox', {name: /^発生額（税抜・円）/}).fill('1000');
  await form.getByRole('textbox', {name: /^発生額（税抜・円）/}).press('Tab');
  await form.getByRole('textbox', {name: /^根拠/}).fill('検証レシピの架空の雑費');
  await form.getByRole('button', {name: '入れる', exact: true}).click();
  await page.getByRole('status').filter({hasText: '雑費（2026年4月・発生額）に ￥1,000 を入れました'}).waitFor();
  await until(async () => yen(await gridCell(matrix, '雑費', '2026年4月')), (value) => value === before + 1000, {label: '雑費の2026年4月'});
  await page.getByText(/^入れた額の履歴/).click();
  const history = page.getByRole('table', {name: '入れた額の履歴', exact: true});
  await history.getByRole('row').filter({hasText: '検証レシピの架空の雑費'}).last().click();
  const reverseForm = page.locator('form.plbs-form').filter({hasText: 'を取り消す'});
  await reverseForm.getByRole('textbox', {name: /^取り消す理由/}).fill('検証レシピの後片付け');
  await reverseForm.getByRole('button', {name: '取消の行を足す'}).click();
  await page.getByRole('status').filter({hasText: 'を取り消しました'}).waitFor();
  await until(async () => yen(await gridCell(matrix, '雑費', '2026年4月')), (value) => value === before, {label: '取消後の雑費'});
  step('plbs-manual: 手入力で雑費（2026年4月）に 1,000円を入れると表が1,000増え、履歴から取り消すと元に戻る');
  await shot('plbs-manual');

  // plbs-settings：会社の設定
  await tabs(page).getByRole('tab', {name: '会社の設定', exact: true}).click();
  await page.getByText(/DEMO-SELF｜架空データ映像（自社・架空）/).first().waitFor();
  await page.getByText('2024年4月末').first().waitFor();
  step('plbs-settings: 会社の設定に 自社を表す取引先 DEMO-SELF｜架空データ映像（自社・架空）、期首残高の基準月 2024年4月末');
  await shot('plbs-settings');

  // plbs-expense-payments：経費の画面で未払の経費に出金を記録する
  // 架空データで未払のまま残した経費（事務費・海外素材費・宣伝費の一部）のうち、作品のある最初の1件（計上月の早い順）の作品で開く
  const target = (await (await api.get('/api/expense-payments')).json()).rows.find((row) => row.unpaidYen > 0 && row.workId);
  assert.ok(target, '作品のある未払の経費がありません（流し直すときは launch からやり直す）');
  await page.goto(`/?${new URLSearchParams({p: slugOf('経費'), work: String(target.workId)})}`);
  const panel = page.getByRole('region', {name: '経費の出金'});
  await panel.getByText(/^未払の経費 \d+件/).waitFor();
  const table=panel.getByRole('table',{name:'経費集計シート',exact:true});
  await panel.getByLabel('基準日',{exact:true}).fill('2026-11-30');
  await table.getByRole('row').filter({has:page.getByRole('cell',{name:String(target.id),exact:true})}).click();
  const detail=panel.locator('[aria-label="経費の詳細"]'),paymentForm=detail.getByRole('form',{name:'出金の記録',exact:true});
  await paymentForm.getByLabel('出金日',{exact:true}).fill('2026-10-05');
  await paymentForm.getByLabel('出金額（円）').fill(String(target.unpaidYen));await paymentForm.getByLabel('今回の源泉控除額（円）').fill('0');
  const settings=(await (await api.get('/api/expense-accounting/settings')).json()).settings,cash=settings['account-classes'].find(c=>c.settlement_role==='cash'&&c.active);
  await paymentForm.getByLabel('現預金科目',{exact:true}).selectOption(String(cash.id));await paymentForm.getByLabel('出金の理由').fill('画面検証の出金（架空）');
  await paymentForm.getByRole('button',{name:'出金を記録',exact:true}).click();
  await until(async()=>(await (await api.get(`/api/expense-sheet/${target.id}?asOf=2026-11-30`)).json()).row.cash_due_yen,v=>v===0,{label:'支払残額'});
  step('plbs-expense-payments: 未払件数を残し、請求書・会計版つきの共通フォームから出金すると支払残額が0');
  await shot('plbs-expense-payments');

  await page.goto('/?p=expense-sheet');const expenseTabs=page.getByRole('group',{name:'経費の業務'});
  await expenseTabs.getByRole('button',{name:'仕訳の見え方',exact:true}).click();await page.getByLabel('仕訳の終了日').fill('2026-11-30');
  const journal=page.getByRole('region',{name:'仕訳の見え方'});await journal.getByText(/借方合計/).waitFor();
  const j=(await (await api.get('/api/expense-journal?to=2026-11-30')).json());assert.equal(j.debitYen,j.creditYen);assert.ok(j.rows.length>0);
  await journal.getByRole('link',{name:/明細 /}).first().waitFor();await shot('plbs-journal');step('plbs-journal: 借貸合計一致・元明細へのリンク');

  // plbs-report-center：帳票センターの「収支」から会社BSを開く
  await page.goto(`/?${new URLSearchParams({p: slugOf('帳票センター'), ...FY})}`);
  await page.getByRole('button', {name: /^すべての帳票（\d+種類）を見る/}).click();
  for (const title of ['作品別PL（管理会計の試算）', '会社PL（月次・管理会計の試算）', '会社BS（簡易・管理会計の試算）']) await page.getByRole('button', {name: new RegExp(`^${title.replace(/[()（）・]/g, '.')}`)}).waitFor();
  await page.getByRole('button', {name: /^会社BS（簡易・管理会計の試算）/}).click();
  await page.getByRole('table', {name: '会社の簡易BS', exact: true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('report'), 'company-bs');
  assert.equal(await page.getByRole('tablist', {name: 'PL・BS の表'}).count(), 0, '帳票センターからはそのタブだけ');
  step('plbs-report-center: 帳票センターの「収支」に 作品別PL・会社PL・会社BS。会社BSのカードで report=company-bs、PL・BS のタブは出さずに会社BSだけ');
  await shot('plbs-report-center');
};
