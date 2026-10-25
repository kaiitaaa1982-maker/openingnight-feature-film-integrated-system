// docs/rules/database.md の「移行の決まり」のうち、機械で守れる部分を確かめる。
// main に入った移行は書き換えない（中身の指紋で守る）。番号は4桁の連番で、抜けも重複も無い。
// 0022 だけは別の枝（#145 の稟議の払込の取消）が使うので、この枝にファイルが無くても連番とみなす。
// 0022 のファイルがこの枝にもあるときは、ふつうの連番（0021 の次が 0022、その次が 0023）に戻る。
// 新しい移行を足す PR では、下の一覧に指紋を1行足す（足し忘れもこのテストが見つける）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// ファイル名と、改行を LF にそろえた中身の SHA-256。
const MERGED = new Map([
  ['0011_cloud_analytics.sql', 'f2194222ccd3753187e16ecab3326c6f67f11e3f4b3f1670aea3025c08708a3f'],
  ['0001_initial.sql', '73ff55a61e48904c4c3306fb21dc43773a80fa209f77cd71bde3e2b44d36b423'],
  ['0002_ux_extensions.sql', 'b7bba18a3b029a18d7ff9cb13da20ec491d8d3a672a3eeefd2b5b89f068bdcc6'],
  ['0003_royalty_committee.sql', '0c5bb1e3dbfe10dec4442d9ad4f1028a513c8dd74f8bbb2321f4930382cd9b6b'],
  ['0004_eigyo_sales_sheet.sql', '40331ee69cb7ab23778828ea33f9f24d519f6ab9ce4895ace6cb5ff72f6ecb66'],
  ['0005_sales_proposals.sql', 'd5e15d3322766ce5e2eb398d51e49fda88733753866d6def9c2c72ddadb37704'],
  ['0006_broadcast_windows.sql', 'd36f3856eb1f0cea8d53f21a9e12e1e0da27da9036c909a616e4453dbf04b28a'],
  ['0007_pl_bs.sql', '54ab01f5421563686da06ac8c95a626d606f50a4aba4ff25fca600d5bff33652'],
  ['0008_broadcast_proposal_drafts.sql', '9f1f958667d4f53b208929a0d0f2daa0a74658a7304131eae598591ea0d14c14'],
  ['0009_req5_master_extensions.sql', '168cd4c050debbdc4cd5431a4775f830b48b92c8748f53c3df483e1fed0fb36e'],
  ['0010_req6_expenses.sql', 'e124b800c7199b73b8e4986c754f41f8ef3dac657fd4b8341147c336fa050ae7'],
  // フェーズ1 #10（案件の型・稼ぎ方・段階）。番号はマージの直前に main の次の番号へ振り直す（計画の「別セッション」の節）
  ['0012_planning_project_classification.sql', 'a8e830590e38655552d68eb38c29ac51d9b24455d5c752ee851fbc435a10d8ef'],
  // フェーズ1 #10b（受託制作の契約の版）。番号は 0012 と同じくマージの直前に振り直す
  ['0013_contract_production_versions.sql', '6b6670592142330d91eaa388ba9062435379c4f6b5e9f500babffe592fd989f4'],
  // フェーズ1 #11（予実の目標・計画の版と期間、行動の設定）。番号は 0012 と同じくマージの直前に振り直す
  ['0014_yojitsu_targets_plans_settings.sql', '0b8dc32f82d58208fc2d6f255a8a2a8989f8336da42b82ad8764aaa10c006db4'],
  // フェーズ1 #13（予実の予測の版と活動記録）。番号は 0012 と同じくマージの直前に振り直す
  ['0015_yojitsu_forecasts_activities.sql', 'f5574507b9814979f22400fc19d551d9b91b1a764d7afbb4dfafa78f12f11cdb'],
  // フェーズ1 #5（制作費の版）。番号は 0012 と同じくマージの直前に振り直す
  ['0016_production_cost_versions.sql', '31a8c470195f8df05acd402851579915cf351047c436172212e2821eb514091f'],
  // 行動指標の計画 段B #9（指標マスタ）。番号は 0012 と同じくマージの直前に振り直す
  ['0017_kpi_metric_master.sql', 'ebb290449bca42c03dc75a8e9b2813233aa11f85756f45c1aaf5c2dc02023621'],
  // フェーズ1 #14（予実の語を選ぶ設定と月の設定）。番号は 0012 と同じくマージの直前に振り直す
  ['0018_yojitsu_choice_settings.sql', '99b78a0ce7c46810115c36e6e9afba0c747d50de2e15de1d5766f6930086485a'],
  // 行動指標の計画 段B #4（稟議の版）。番号は 0012 と同じくマージの直前に振り直す
  ['0019_investment_approval_versions.sql', 'e955f84ca513327d51605ae5beb9b5d5cb3cf588fc6be89464956a0b54dcab87'],
  ['0020_sales_activity_results.sql', '62764fb9a368ec67e194f978d2c79550f986bc94e9085d7d317402489a0d38a4'],
  // フォルダ型の画面の最初の一切れ U1（1通の原本の条件の版・報告の取消の記録）。#131 の仮の 0019 を 0021 へ振り直した
  ['0021_folder_source_terms_report_voids.sql', 'eeb43d8da48b8304b207b2a0f6e7957d411b240323fb423f5db13dd9bc7cd128'],
  // フォルダ型の画面 U2a 後半（検査の決まりの版・正解表・検査の結果・抜き取りの記録）。0022 は #145 が別枝で使う
  ['0023_folder_check_versions_cases_runs.sql', 'ad8b0f8c9ee6fd14e0cdc1deb3bc325639c6bcffdd34cd0509394d15a33e7c6d'],
  ['0024_budget_books.sql', '17921e1c5b47af673ae0bd0e8efee79f19bdbfdb74710cf9b41b744f41581ec8'],
  // 業務を問わない共通の原本の表（会社ルートの plans/2026-10-22-folder-parallel-design.md の X-1）
  ['0025_source_documents.sql', '88b2ba17d7aff0e813d5d461f61cbe31727947b278f12dd0da38d322412985b0'],
  // 支払う MG（買付分）のマスタ（会社ルートの plans/2026-10-22-folder-mg-buy.md の香盤表 #3）。番号 0026 は調整役から受け取った
  ['0026_acq_mg_master.sql', '06a801802c3334ddac9b169aef2bc1796117010b004e238319db199fa6e91087'],
  // 支払う MG の支払の記録。番号 0027 は調整役から受け取った（予算書の型は 0028）
  ['0027_acq_mg_payments.sql', 'd9c82c1daaf508c28228e6b2f530109010ddc0e57e409e5583f0006fc1a7321d'],
  ['0028_budget_templates_line_items.sql', '47ab93c5921e7c420a414c58875c809878cb909fe543acc600a040e896eb836a'],
  // 経費管理のフォルダ（置いた月・外した記録・月の締め）。0029〜0040 は先に並ぶ別の枝（C:\ONwt\MIGRATION-ORDER.md）
  ['0041_expense_folders.sql', '44544b31c0ebb06d10e9afc3cbbf081acbf9758b457d15fc805c7ca164a50d81'],
  // 製作委員会の型と式の部品・日程の版・収支の台帳。番号 0042〜0044 は調整役から受け取った
  ['0042_committee_terms_formula.sql', 'f14ac8117c2bda2db361c130060d4dbb140a8e9d1f4565b653a1296070409c98'],
  ['0043_committee_schedule_versions.sql', '0c217bfdb63e669b6beecea64964b28d7c2d7e367d2a8da89f1ac3f6cbaae90e'],
  ['0044_committee_ledger_entries.sql', 'edb539a4f86039ff25c6aeca8048125e5d3cf7a45ac082face2a7257265bbe73'],
  ['0045_cashbook.sql', '543c6bc8e0614f380c8b148493c7d80c2c2593fb4f0c31de263c61bb7cc25803'],
  // 製造（会社ルートの plans/2026-10-24-folder-seizou.md）。番号 0046 は調整役から受け取った
  ['0046_manufacturing.sql', 'd6ed016a94301b0619a2e97981619395b15f9eada24008eaf26fccb4373fe537'],
  ['0047_produce_tasks.sql', 'f94080646f80ab74d123a370ead1e1c1f7535760c0247d9779e912786e287ee7'],
  // ポストプロダクション（会社ルートの plans/2026-10-22-folder-postprod.md）。番号 0048 は調整役から受け取った
  ['0048_post_production.sql', '903ece094f233489d7f3c6f75b76881b5157a62cbb3e1bd663a2de57f4a4b609'],
  // 営業管理の最初の切れ（1回の提案・評価・要因・接点の言葉）。番号 0049 は調整役から受け取った（0025〜0036 は同じ日の別の PR）
  ['0049_sales_proposals_reviews_notes.sql', 'bc4b3ab71908551b50f4e74e02b776a932bd266f94c512d469924c171931028a'],
  // 企画（企画の項目と体制・3段の試算・担当・原本の結び付き・素材と事実）。番号 0050 は調整役から受け取った
  ['0050_kikaku.sql', 'b8c3b5fb7967a7cde87f35f284fea56597b816bd9614317914d8166c35fdf2d5'],
  ['0051_shooting_day_records.sql', '633ac4603071553d6f1615fdda4534b3274cc1f2571887badf8da5b15607969b'],
  ['0052_chotatsu.sql', '2b74edbc6a572f28984b3678f6d82de63204c9f17b8bd3a8c8c9f03ba3415e6a'],
  ['0053_preprod_arrangements_art.sql', '81b900a3fe3a40e3753220618c27e9d22fb66ef67b55cf06982ba2fc433ff486'],
  ['0054_preprod_document_placements.sql', '16b9c2f9dd65141b81782ce289d896b9be34fcd4d032ae3efef11924d618b492'],
  ['0055_notebook.sql', '6e37e585010b9973255c30d4962b6b7708b9cef539294c91fec9271546c8c5cf'],
  ['0056_source_document_moves.sql', '2bd2b460282c212ef9aec09e7936b0169a1364d65a8f164d29c4787fe301febe'],
]);

const fingerprint = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

// #145 が別枝で 0022 を使う。この枝にそのファイルが無いときだけ、22 を飛ばして次の番号を連番とみなす。
// 0029〜0040 と 0042〜0048 は 2026-10-24 の波で先に入る別の枝（C:/ONwt/MIGRATION-ORDER.md）。main に寄せたら消す。
const RESERVED_MISSING = new Set([22, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);

export function numberingProblems(names) {
  const problems = [];
  let expect = 1;
  for (const name of names) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!m) {
      problems.push(`${name}: 名前は「4桁の番号_英小文字.sql」にする`);
      continue;
    }
    const n = Number(m[1]);
    while (n > expect && RESERVED_MISSING.has(expect)) expect += 1;
    if (n !== expect) problems.push(`${name}: ${String(expect).padStart(4, '0')} のはず（抜けか重複）`);
    expect = n + 1;
  }
  return problems;
}

const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();

test('移行の番号は4桁の連番で、抜けも重複も無い', () => {
  assert.deepEqual(numberingProblems(files), []);
});

test('main に入った移行は書き換えていない', () => {
  const changed = [...MERGED].filter(([name, hash]) =>
    files.includes(name) && fingerprint(readFileSync(join(dir, name), 'utf8')) !== hash).map(([name]) => name);
  assert.deepEqual(changed, [], '書き換えずに、次の番号の移行を足して直す');
});

test('main に入った移行は消していない', () => {
  assert.deepEqual([...MERGED.keys()].filter(name => !files.includes(name)), []);
});

test('新しい移行は指紋の一覧に載っている', () => {
  assert.deepEqual(files.filter(name => !MERGED.has(name)), [], '足した移行の指紋を MERGED に1行足す');
});

test('番号の検査は抜けと重複と名前の崩れを見逃さない', () => {
  assert.deepEqual(numberingProblems(['0001_a.sql', '0002_b.sql']), []);
  assert.equal(numberingProblems(['0001_a.sql', '0003_b.sql']).length, 1);
  assert.equal(numberingProblems(['0001_a.sql', '0001_b.sql']).length, 1);
  assert.equal(numberingProblems(['1_a.sql']).length, 1);
});

test('0022 は別の枝が使う番号なので、ファイルが無くても 0023 を連番とみなし、0022 があればふつうの連番に戻る', () => {
  const through21 = [];
  for (let n = 1; n <= 21; n += 1) through21.push(`${String(n).padStart(4, '0')}_x.sql`);
  assert.deepEqual(numberingProblems([...through21, '0023_y.sql']), []);
  assert.deepEqual(numberingProblems([...through21, '0022_z.sql', '0023_y.sql']), []);
  assert.equal(numberingProblems([...through21, '0024_y.sql']).length, 1);
  assert.equal(numberingProblems([...through21, '0022_z.sql', '0024_y.sql']).length, 1);
});
