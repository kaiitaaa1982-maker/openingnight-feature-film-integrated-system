import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateReportFamilies } from './local-migrations.mjs';
import { migrateMgCloseDays } from './mg-migration.mjs';
import { migrateCommitteeChannels } from './committee-channel-migration.mjs';
import { attachDbError } from './data-platform/db-errors.mjs';
import { assertReadBatch } from './data-platform/pg-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const schemaSql = readFileSync(resolve(here, 'schema.sql'), 'utf8');
export const reportingSql = readFileSync(resolve(here, 'reporting.sql'), 'utf8');
export const distributionMasterSql = readFileSync(resolve(here, 'distribution-master.sql'), 'utf8');
export const catalogSql = readFileSync(resolve(here, 'catalog.sql'), 'utf8');
export const workflowSql = readFileSync(resolve(here, 'workflow.sql'), 'utf8');
export const mgSql = readFileSync(resolve(here, 'mg.sql'), 'utf8');
export const taxSql = readFileSync(resolve(here, 'tax.sql'), 'utf8');
export const workbenchSql = readFileSync(resolve(here, 'workbench.sql'), 'utf8');
export const channelSalesSql = readFileSync(resolve(here, 'channel-sales.sql'), 'utf8');
export const sourceControlsSql = readFileSync(resolve(here, 'source-controls.sql'), 'utf8');

export const broadcastSql = readFileSync(resolve(here, 'broadcast.sql'), 'utf8');
export const productionSql = readFileSync(resolve(here, 'production.sql'), 'utf8');
export const reportDimensionsSql = readFileSync(resolve(here, 'report-dimensions.sql'), 'utf8');

export const rightsPaymentsSql = readFileSync(resolve(here, 'rights-payments.sql'), 'utf8');
export const committeeFinanceSql = readFileSync(resolve(here, 'committee-finance.sql'), 'utf8');
export const jointCommitteeSql = readFileSync(resolve(here, 'committee-joint.sql'), 'utf8');
// 使いやすさ改修の追加表。D1 へは migrations/0002_ux_extensions.sql（scripts/build-ux-migration.mjs がこの順で連結）で適用する。
export const UX_SQL_FILES = Object.freeze(['ux-extensions.sql', 'report-issuance.sql', 'progress/expected-reports.sql']);
export const uxExtensionsSql = UX_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');
// ロイヤリティ・製作委員会の月次・原本の付け替え（2026-09-25）の追加表。D1 へは migrations/0003_royalty_committee.sql（同じスクリプトが連結）で適用する。
export const R3_SQL_FILES = Object.freeze(['royalty/royalty.sql', 'committee/committee-extras.sql', 'sales-source.sql', 'session-org.sql']);
export const r3ExtensionsSql = R3_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');
// 営業基幹・全作品のウィンドウ・取引先別リスト・売上集計シート（2026-09-25）の追加表。D1 へは migrations/0004_eigyo_sales_sheet.sql
// （同じスクリプトが連結）で適用する。後から足す表は、この一覧の後ろに足して node scripts/build-ux-migration.mjs で 0004 を作り直す
export const R4_SQL_FILES = Object.freeze(['sales-ops/release-windows.sql', 'sales-ops/partner-lists.sql', 'sales-sheet/sales-sheet.sql', 'sales-ops/distribution-additions.sql']);
export const r4ExtensionsSql = R4_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');
// 営業基幹の提案資料（2026-09-26）の追加表（提案資料に出す作品情報の版）。D1 へは migrations/0005_sales_proposals.sql
// （同じスクリプトが連結）で適用する。0004 の後に当てる
export const R5_SQL_FILES = Object.freeze(['sales-ops/proposal-profiles.sql']);
export const r5ExtensionsSql = R5_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');
// 番販・放送の放送履歴表・アベイルズリスト・放送ウィンドウ提案（2026-09-26）の追加表（放送局の種別・明細ごとの許諾回数とホールドバック）。
// D1 へは migrations/0006_broadcast_windows.sql（同じスクリプトが連結）で適用する。0004 の後に当てる（取引先別リストの明細を参照する）
export const R6_SQL_FILES = Object.freeze(['broadcast/broadcast-windows.sql']);
export const r6ExtensionsSql = R6_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');
// PL・BS（管理会計の試算）の法人情報・勘定科目・手入力の額・経費の出金・出資の払込（2026-09-26）の追加表。D1 へは migrations/0007_pl_bs.sql
// （同じスクリプトが連結）で適用する。0006 の後に当てる（どれも追加だけ）
export const R7_SQL_FILES = Object.freeze(['pl-bs/pl-bs.sql']);
export const r7ExtensionsSql = R7_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');
// 放送ウィンドウ提案から作った放送枠の下書きの記録と、合意に至らず削除した記録（2026-09-26）の追加表。D1 へは migrations/0008_broadcast_proposal_drafts.sql
// （同じスクリプトが連結）で適用する。0007 の後に当てる（放送枠・取引先・商品を参照する。どれも追加だけ）
export const R8_SQL_FILES = Object.freeze(['broadcast/proposal-drafts.sql']);
export const r8ExtensionsSql = R8_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');
export const R9_SQL_FILES = Object.freeze(['master-extensions/work-master.sql', 'master-extensions/product-master.sql']);
export const r9ExtensionsSql = R9_SQL_FILES.map((name) => readFileSync(resolve(here, name), 'utf8')).join('\n');

export const R10_SQL_FILES = Object.freeze(['expense-accounting/expense-accounting.sql', 'expense-sheet/expense-sheet.sql', 'expense-sheet/expense-import.sql']);
export const r10ExtensionsSql = R10_SQL_FILES.map(name => readFileSync(resolve(here,name),'utf8')).join('\n');
// 案件の型・稼ぎ方・段階（フェーズ1 #10）。表の定義の正本は移行のファイル（0011 と同じ）。projects に列を足す移行なので、
// 手元の DB にも D1 と同じく1回だけ当てる（下の LocalDatabase。番号はマージの直前に振り直すので、そのときこの名前も直す）
export const PLANNING_MIGRATION = '0012_planning_project_classification.sql';
export const planningMigrationSql = readFileSync(resolve(here, '../migrations', PLANNING_MIGRATION), 'utf8');
// 受託制作の契約の版（フェーズ1 #10b）。作るだけの文なので 0011 と同じく毎回当てる（0012 の projects の型の列を読むので、そのあと）。
// 番号はマージの直前に振り直すので、そのときこの名前も直す
export const CONTRACT_PRODUCTION_MIGRATION = '0013_contract_production_versions.sql';
export const contractProductionMigrationSql = readFileSync(resolve(here, '../migrations', CONTRACT_PRODUCTION_MIGRATION), 'utf8');
// 案件収支の予実の目標・計画の版と期間、行動の設定（フェーズ1 #11）。設定の変数の参照表の行を INSERT で入れるので、0012 と同じく
// まだ当てていない DB にだけ1回当てる（0013 のあと）。番号はマージの直前に振り直すので、そのときこの名前も直す
export const YOJITSU_MIGRATION = '0014_yojitsu_targets_plans_settings.sql';
export const yojitsuMigrationSql = readFileSync(resolve(here, '../migrations', YOJITSU_MIGRATION), 'utf8');
// 案件収支の予実の案件×月の予測の版と活動記録（フェーズ1 #13）。作るだけの文なので 0013 と同じく毎回当てる（0014 のあと。0012 の区分マスタ・
// 行動のステップを参照する）。番号はマージの直前に振り直すので、そのときこの名前も直す
export const YOJITSU_FORECAST_MIGRATION = '0015_yojitsu_forecasts_activities.sql';
export const yojitsuForecastMigrationSql = readFileSync(resolve(here, '../migrations', YOJITSU_FORECAST_MIGRATION), 'utf8');
// 制作費の版（フェーズ1 #5）。作るだけの文なので 0015 と同じく毎回当てる（0015 のあと。作品・作品の費用の版・委員会の条件版・取引先を参照する）。
// 番号はマージの直前に振り直すので、そのときこの名前も直す
export const PRODUCTION_COST_MIGRATION = '0016_production_cost_versions.sql';
export const productionCostMigrationSql = readFileSync(resolve(here, '../migrations', PRODUCTION_COST_MIGRATION), 'utf8');
// 指標マスタ（行動指標の計画 段B #9）。設定の変数の参照表に行を INSERT で足すので、0014 と同じくまだ当てていない DB にだけ1回当てる
// （0016 のあと。0012 の稼ぎ方・行動のステップと 0014 の設定の変数を参照する）。番号はマージの直前に振り直すので、そのときこの名前も直す
export const KPI_METRIC_MIGRATION = '0017_kpi_metric_master.sql';
export const kpiMetricMigrationSql = readFileSync(resolve(here, '../migrations', KPI_METRIC_MIGRATION), 'utf8');
// 案件収支の予実の語を選ぶ設定と月の設定（採用するシナリオ・月別の表の範囲・締めた月。フェーズ1 #14）。作るだけの文なので 0015 と同じく毎回当てる
// （0017 のあと）。番号はマージの直前に振り直すので、そのときこの名前も直す
export const YOJITSU_CHOICE_MIGRATION = '0018_yojitsu_choice_settings.sql';
export const yojitsuChoiceMigrationSql = readFileSync(resolve(here, '../migrations', YOJITSU_CHOICE_MIGRATION), 'utf8');
// 稟議の版（行動指標の計画 段B #4）。作るだけの文なので 0015 と同じく毎回当てる（0018 のあと。0012 の案件の稼ぎ方を読む）。
// 番号はマージの直前に振り直すので、そのときこの名前も直す
export const INVESTMENT_APPROVAL_MIGRATION = '0019_investment_approval_versions.sql';
export const investmentApprovalMigrationSql = readFileSync(resolve(here, '../migrations', INVESTMENT_APPROVAL_MIGRATION), 'utf8');
export const SALES_ACTIVITY_RESULTS_MIGRATION = '0020_sales_activity_results.sql';
export const salesActivityResultsMigrationSql = readFileSync(resolve(here, '../migrations', SALES_ACTIVITY_RESULTS_MIGRATION), 'utf8');
// フォルダ型の画面の最初の一切れ（区切り U1）の1通の原本の条件の版と、報告の取消の記録。作るだけの文なので 0015 と同じく毎回当てる
// （0020 のあと。原本の表〈0003〉・報告・取引先を参照する）。#131 の仮の 0019 を 0021 へ振り直した
export const FOLDER_SOURCE_MIGRATION = '0021_folder_source_terms_report_voids.sql';
export const folderSourceMigrationSql = readFileSync(resolve(here, '../migrations', FOLDER_SOURCE_MIGRATION), 'utf8');
// フォルダ型の画面 U2a 後半の表3〜6（検査の決まりの版・正解表・検査の結果・抜き取りの記録）。作るだけの文なので 0021 と同じく毎回当てる。
// 0022 は別枝（#145 の稟議の払込の取消）が使うので、この枝の次の番号は 0023。
export const FOLDER_CHECK_MIGRATION = '0023_folder_check_versions_cases_runs.sql';
export const folderCheckMigrationSql = readFileSync(resolve(here, '../migrations', FOLDER_CHECK_MIGRATION), 'utf8');
// 予算書作成の4表（版・行・検査の結果・確定の記録）。作るだけの文なので 0023 と同じく毎回当てる。番号 0024 は調整役から受け取った
export const BUDGET_MIGRATION = '0024_budget_books.sql';
export const budgetMigrationSql = readFileSync(resolve(here, '../migrations', BUDGET_MIGRATION), 'utf8');
// 業務を問わない共通の原本の表（会社ルートの plans/2026-10-22-folder-parallel-design.md の X-1）。作るだけの文なので 0024 と同じく毎回当てる（0024 のあと）
export const SOURCE_DOCUMENTS_MIGRATION = '0025_source_documents.sql';
export const sourceDocumentsMigrationSql = readFileSync(resolve(here, '../migrations', SOURCE_DOCUMENTS_MIGRATION), 'utf8');
// 支払う MG（買付分）のマスタ（会社ルートの plans/2026-10-22-folder-mg-buy.md の香盤表 #3）。作るだけの文なので 0025 と同じく毎回当てる（0025 のあと）。番号 0026 は調整役から受け取った
export const ACQ_MG_MIGRATION = '0026_acq_mg_master.sql';
export const acqMgMigrationSql = readFileSync(resolve(here, '../migrations', ACQ_MG_MIGRATION), 'utf8');
// 支払う MG の支払の記録（0026 のあと）。番号 0027 は調整役から受け取った（予算書の型は 0028）。作るだけの文なので毎回当てる
export const ACQ_MG_PAYMENTS_MIGRATION = '0027_acq_mg_payments.sql';
export const acqMgPaymentsMigrationSql = readFileSync(resolve(here, '../migrations', ACQ_MG_PAYMENTS_MIGRATION), 'utf8');
// 予算書の型（テンプレ）と行の内訳の5表。作るだけの文なので毎回当てる。番号 0028 は調整役から受け取った
export const BUDGET_TEMPLATE_MIGRATION = '0028_budget_templates_line_items.sql';
export const budgetTemplateMigrationSql = readFileSync(resolve(here, '../migrations', BUDGET_TEMPLATE_MIGRATION), 'utf8');
// 経費管理のフォルダ（置いた月・外した記録・月の締め）。作るだけの文なので 0024 と同じく毎回当てる。番号 0041 は調整役から受け取った
export const EXPENSE_FOLDER_MIGRATION = '0041_expense_folders.sql';
export const expenseFolderMigrationSql = readFileSync(resolve(here, '../migrations', EXPENSE_FOLDER_MIGRATION), 'utf8');
// 会計の最初の組（口座・明細・仕訳）の5表。作るだけの文なので毎回当てる。番号 0045 は調整役から（C:/ONwt/MIGRATION-ORDER.md）
export const CASHBOOK_MIGRATION = '0045_cashbook.sql';
export const cashbookMigrationSql = readFileSync(resolve(here, '../migrations', CASHBOOK_MIGRATION), 'utf8');
// 製作委員会の契約の型と式の部品・日程の版・収支の台帳（要件 docs/requirements/settlement/committee.md）。作るだけの文なので毎回当てる。
// 番号 0042〜0044 は調整役から受け取った（委員会の契約と条件版〈0001・0003〉・取引先・所属を参照する）
export const COMMITTEE_LEDGER_MIGRATIONS = ['0042_committee_terms_formula.sql', '0043_committee_schedule_versions.sql', '0044_committee_ledger_entries.sql'];
export const committeeLedgerMigrationSql = COMMITTEE_LEDGER_MIGRATIONS.map((name) => readFileSync(resolve(here, '../migrations', name), 'utf8')).join('\n');
// 営業管理の最初の切れ（1回の提案・結果と自己評価・効いた要因・接点の言葉）。作るだけの文なので 0024 と同じく毎回当てる。番号 0049 は調整役から受け取った
export const SALES_PROPOSAL_MIGRATION = '0049_sales_proposals_reviews_notes.sql';
export const salesProposalMigrationSql = readFileSync(resolve(here, '../migrations', SALES_PROPOSAL_MIGRATION), 'utf8');
// 企画の10表（企画の項目と体制・3段の試算・案件の担当者・原本の結び付き・素材と事実）。作るだけの文なので毎回当てる。番号 0050 は調整役から受け取った
export const KIKAKU_MIGRATION = '0050_kikaku.sql';
export const kikakuMigrationSql = readFileSync(resolve(here, '../migrations', KIKAKU_MIGRATION), 'utf8');
// プロダクションの撮影の記録の3表（撮影の結果・撮影日の記録の原本・日報の項目）。作るだけの文なので 0025 と同じく毎回当てる（0025 の共通の原本の表を指す）。番号 0051 は調整役から受け取った
export const SHOOTING_RECORDS_MIGRATION = '0051_shooting_day_records.sql';
export const shootingRecordsMigrationSql = readFileSync(resolve(here, '../migrations', SHOOTING_RECORDS_MIGRATION), 'utf8');

// 製造の8表（商品・版・工程の記録・発注書・明細・段・納品・経費の結び）。作るだけの文なので毎回当てる。番号 0046 は調整役から受け取った
export const MANUFACTURING_MIGRATION = '0046_manufacturing.sql';
export const manufacturingMigrationSql = readFileSync(resolve(here, '../migrations', MANUFACTURING_MIGRATION), 'utf8');
// プロデュース管理の進行表の7表（チケットの版・記録・チェック項目・掲示板・関連する場所・テンプレート）。作るだけの文なので毎回当てる。番号 0047 は調整役から受け取った
export const PRODUCE_MIGRATION = '0047_produce_tasks.sql';
export const produceMigrationSql = readFileSync(resolve(here, '../migrations', PRODUCE_MIGRATION), 'utf8');
// ポストプロダクションの7表（版・指摘・対応・工程のタスクと記録・納品物と記録）。作るだけの文なので毎回当てる。番号 0048 は調整役から受け取った
export const POST_MIGRATION = '0048_post_production.sql';
export const postMigrationSql = readFileSync(resolve(here, '../migrations', POST_MIGRATION), 'utf8');
// 調達（フォルダ台帳 F19）の表。作るだけの文なので 0025 と同じく毎回当てる（番号 0052 は調整役から受け取った）
export const CHOTATSU_MIGRATION = '0052_chotatsu.sql';
export const chotatsuMigrationSql = readFileSync(resolve(here, '../migrations', CHOTATSU_MIGRATION), 'utf8');
// プリプロの手配・美術・シーンの撮影の方針（会社ルートの plans/2026-10-22-folder-preprod.md の PP6・PP7）。作るだけの文なので 0024 と同じく毎回当てる。番号 0053 は調整役から受け取った（0052 のあと）
export const PREPROD_ARRANGEMENTS_MIGRATION = '0053_preprod_arrangements_art.sql';
export const preprodArrangementsMigrationSql = readFileSync(resolve(here, '../migrations', PREPROD_ARRANGEMENTS_MIGRATION), 'utf8');
// プリプロの保管庫の置き場の記録（会社ルートの plans/2026-10-22-folder-preprod.md の PP4）。0053 のあとに毎回当てる。番号 0054 は調整役から受け取った
export const PREPROD_VAULT_MIGRATION = '0054_preprod_document_placements.sql';
export const preprodVaultMigrationSql = readFileSync(resolve(here, '../migrations', PREPROD_VAULT_MIGRATION), 'utf8');
// 現場の連絡帳（調整役の X-23。共通の部品 src/notebook/）。0054 のあとに毎回当てる。番号 0055 は調整役から受け取った
export const NOTEBOOK_MIGRATION = '0055_notebook.sql';
export const notebookMigrationSql = readFileSync(resolve(here, '../migrations', NOTEBOOK_MIGRATION), 'utf8');
// 原本の場所の移動（0056）。作るだけの文なので0055のあとに毎回当てる。
export const SOURCE_DOCUMENT_MOVES_MIGRATION = '0056_source_document_moves.sql';
export const sourceDocumentMovesMigrationSql = readFileSync(resolve(here, '../migrations', SOURCE_DOCUMENT_MOVES_MIGRATION), 'utf8');

export class LocalDatabase {
  // init: false は、表の定義も試作用の行も流さずに開く（本番の写しの上で書き込みを記録するとき。写しに行を黙って足さない）
  constructor(filename = resolve(here, '../data/integrated.sqlite'), { init = true } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    if (!init) return;
    migrateReportFamilies(this.raw);
    migrateCommitteeChannels(this.raw,schemaSql);
    this.raw.exec(schemaSql);
    this.raw.exec(productionSql);
    this.raw.exec(reportingSql);
    this.raw.exec(workflowSql);
    this.raw.exec(distributionMasterSql);
    this.raw.exec(catalogSql);
    this.raw.exec(taxSql);
    this.raw.exec(workbenchSql);
    this.raw.exec(channelSalesSql);
    this.raw.exec(sourceControlsSql);
    this.raw.exec(broadcastSql);
    this.raw.exec(reportDimensionsSql);
    this.raw.exec(rightsPaymentsSql);
    this.raw.exec(committeeFinanceSql);
    this.raw.exec(jointCommitteeSql);
    this.raw.exec(uxExtensionsSql);
    this.raw.exec(r3ExtensionsSql);
    this.raw.exec(r4ExtensionsSql);
    this.raw.exec(r5ExtensionsSql);
    this.raw.exec(r6ExtensionsSql);
    // 手入力の額の消費税額（0007 の作成中に足した列）。先に作った作業用の DB にだけ列を足す（本番の D1 は 0007 で列ごと作る）
    const manualColumns=new Set(this.raw.prepare('PRAGMA table_info(gl_manual_amounts)').all().map(row=>row.name));
    if(manualColumns.size&&!manualColumns.has('tax_yen'))this.raw.exec('ALTER TABLE gl_manual_amounts ADD COLUMN tax_yen INTEGER NOT NULL DEFAULT 0');
    this.raw.exec(r7ExtensionsSql);
    this.raw.exec(r8ExtensionsSql);
    this.raw.exec(r9ExtensionsSql);
    this.raw.exec(r10ExtensionsSql);
    this.raw.exec(readFileSync(resolve(here, '../migrations/0011_cloud_analytics.sql'), 'utf8'));
    const draftColumns=new Set(this.raw.prepare('PRAGMA table_info(workbench_drafts)').all().map(row=>row.name));
    if(!draftColumns.has('source_artifact_id'))this.raw.exec('ALTER TABLE workbench_drafts ADD COLUMN source_artifact_id TEXT REFERENCES workbench_source_artifacts(id)');
    if(!draftColumns.has('lookup_refs_json'))this.raw.exec("ALTER TABLE workbench_drafts ADD COLUMN lookup_refs_json TEXT NOT NULL DEFAULT '[]'");
    const recipeColumns=new Set(this.raw.prepare('PRAGMA table_info(workbench_recipe_versions)').all().map(row=>row.name));
    if(!recipeColumns.has('lookup_refs_json'))this.raw.exec("ALTER TABLE workbench_recipe_versions ADD COLUMN lookup_refs_json TEXT NOT NULL DEFAULT '[]'");
    migrateMgCloseDays(this.raw,mgSql);
    this.raw.exec(mgSql);
    // 移行 0012（ALTER TABLE と参照表の行を含む）は、projects に型の列がまだ無い DB にだけ、1つのトランザクションで当てる
    const projectColumns=new Set(this.raw.prepare('PRAGMA table_info(projects)').all().map(row=>row.name));
    if(!projectColumns.has('project_type'))this.transaction('BEGIN IMMEDIATE',()=>this.raw.exec(planningMigrationSql));
    this.raw.exec(contractProductionMigrationSql);
    // 移行 0014（参照表の行を含む）は、設定の変数の表がまだ無い DB にだけ、1つのトランザクションで当てる
    const variableColumns=this.raw.prepare('PRAGMA table_info(yojitsu_variables)').all();
    if(!variableColumns.length)this.transaction('BEGIN IMMEDIATE',()=>this.raw.exec(yojitsuMigrationSql));
    this.raw.exec(yojitsuForecastMigrationSql);
    this.raw.exec(productionCostMigrationSql);
    // 移行 0017（参照表の行を含む）は、指標マスタの版の表がまだ無い DB にだけ、1つのトランザクションで当てる
    const metricColumns=this.raw.prepare('PRAGMA table_info(kpi_metric_versions)').all();
    if(!metricColumns.length)this.transaction('BEGIN IMMEDIATE',()=>this.raw.exec(kpiMetricMigrationSql));
    this.raw.exec(yojitsuChoiceMigrationSql);
    this.raw.exec(investmentApprovalMigrationSql);
    const activityColumns = new Set(this.raw.prepare('PRAGMA table_info(sales_activities)').all().map((row) => row.name));
    if (!activityColumns.has('result')) this.transaction('BEGIN IMMEDIATE', () => this.raw.exec(salesActivityResultsMigrationSql));
    this.raw.exec(folderSourceMigrationSql);
    this.raw.exec(folderCheckMigrationSql);
    this.raw.exec(budgetMigrationSql);
    this.raw.exec(sourceDocumentsMigrationSql);
    this.raw.exec(acqMgMigrationSql);
    this.raw.exec(acqMgPaymentsMigrationSql);
    this.raw.exec(budgetTemplateMigrationSql);
    this.raw.exec(expenseFolderMigrationSql);
    this.raw.exec(committeeLedgerMigrationSql);
    this.raw.exec(cashbookMigrationSql);
    this.raw.exec(manufacturingMigrationSql);
    this.raw.exec(produceMigrationSql);
    this.raw.exec(postMigrationSql);
    this.raw.exec(salesProposalMigrationSql);
    this.raw.exec(kikakuMigrationSql);
    this.raw.exec(shootingRecordsMigrationSql);
    this.raw.exec(chotatsuMigrationSql);
    this.raw.exec(preprodArrangementsMigrationSql);
    this.raw.exec(preprodVaultMigrationSql);
    this.raw.exec(notebookMigrationSql);
    this.raw.exec(sourceDocumentMovesMigrationSql);
  }
  // 入口の4つと読み取りの一括（FR-CORE-DATA-003・009）。エラーには共通のエラーの種類を付ける（src/data-platform/db-errors.mjs）。
  // 新しい行の ID は INSERT … RETURNING id を get で受け取る（lastInsertRowid は返さない。docs/rules/dialect.md）
  async all(sql, params = []) { return this.sync(() => this.raw.prepare(sql).all(...params)); }
  async get(sql, params = []) { return this.sync(() => this.raw.prepare(sql).get(...params) ?? null); }
  async run(sql, params = []) { return this.sync(() => ({ changes: Number(this.raw.prepare(sql).run(...params).changes) })); }
  // 1つのトランザクションで書く。RETURNING のある文は、その行を rows で返す（D1 の batch の results と同じ）
  async batch(statements) {
    return this.transaction('BEGIN IMMEDIATE', () => statements.map(({ sql, params = [] }) => {
      const statement = this.raw.prepare(sql);
      if (!statement.columns().length) return { changes: Number(statement.run(...params).changes), rows: [] };
      const rows = statement.all(...params);
      return { changes: rows.length, rows };
    }));
  }
  // 複数の読み取りを1つの時点で返す（文ごとの行の配列）。node:sqlite は同期なので、1つの読み取りのトランザクションに入れる。
  // 書き込みの文は先に断り、一括のあいだは PRAGMA query_only で DB も書き込みを断る（PostgreSQL の READ ONLY と同じく、手元の試験で混入に気づく）
  async readBatch(statements) {
    assertReadBatch(statements);
    this.raw.exec('PRAGMA query_only=ON');
    try {
      return this.transaction('BEGIN', () => statements.map(({ sql, params = [] }) => this.raw.prepare(sql).all(...params)));
    } finally {
      this.raw.exec('PRAGMA query_only=OFF');
    }
  }
  sync(fn) {
    try { return fn(); } catch (error) { throw attachDbError(error); }
  }
  transaction(begin, fn) {
    this.raw.exec(begin);
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw attachDbError(error);
    }
  }
  close() { this.raw.close(); }
}

