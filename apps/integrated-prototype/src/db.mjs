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

