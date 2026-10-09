#!/usr/bin/env node
// 使いやすさ改修の追加表を D1 の migrations/0002_ux_extensions.sql へ書き出す。
// 中身は src/db.mjs の UX_SQL_FILES をその順で連結したもの（ローカルの LocalDatabase と同じ）。
// 同じく R3_SQL_FILES → 0003_royalty_committee.sql、R4_SQL_FILES → 0004_eigyo_sales_sheet.sql、R5_SQL_FILES → 0005_sales_proposals.sql、R6_SQL_FILES → 0006_broadcast_windows.sql、R7_SQL_FILES → 0007_pl_bs.sql、R8_SQL_FILES → 0008_broadcast_proposal_drafts.sql を書き出す。
// `--check` は書き出さずに一致だけを確かめる（試験 test/ux-migration.test.mjs も同じ判定をする）。
// 追加だけの移行（CREATE … IF NOT EXISTS）なので、Worker を前の版へ戻しても古いコードはそのまま動く。
// 本番 D1 への適用は代表が運用手順（runbook 07）で行う。このスクリプトは Cloudflare に接続しない。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UX_SQL_FILES, uxExtensionsSql, R3_SQL_FILES, r3ExtensionsSql, R4_SQL_FILES, r4ExtensionsSql, R5_SQL_FILES, r5ExtensionsSql, R6_SQL_FILES, r6ExtensionsSql, R7_SQL_FILES, r7ExtensionsSql, R8_SQL_FILES, r8ExtensionsSql } from '../src/db.mjs';
import {R10_SQL_FILES,r10ExtensionsSql} from '../src/db.mjs';
import {R9_SQL_FILES,r9ExtensionsSql} from '../src/db.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UX_MIGRATION_PATH = resolve(app, 'migrations/0002_ux_extensions.sql');
export const R3_MIGRATION_PATH = resolve(app, 'migrations/0003_royalty_committee.sql');
export const R4_MIGRATION_PATH = resolve(app, 'migrations/0004_eigyo_sales_sheet.sql');
export const R5_MIGRATION_PATH = resolve(app, 'migrations/0005_sales_proposals.sql');
export const R6_MIGRATION_PATH = resolve(app, 'migrations/0006_broadcast_windows.sql');
export const R7_MIGRATION_PATH = resolve(app, 'migrations/0007_pl_bs.sql');
export const R8_MIGRATION_PATH = resolve(app, 'migrations/0008_broadcast_proposal_drafts.sql');
export const R9_MIGRATION_PATH = resolve(app, 'migrations/0009_req5_master_extensions.sql');
export const R10_MIGRATION_PATH = resolve(app,'migrations/0010_req6_expenses.sql');
export function buildR10Migration() { return `-- 依頼6：経費と会計の追加表。${R10_SQL_FILES.join('・')} を連結。\n-- scripts/build-ux-migration.mjs で生成。0009 の後に適用。本番には自動適用しない。\n\n${r10ExtensionsSql}`; }
export function buildR9Migration() {
  return `-- 依頼5：作品・商品マスタの追加表。${R9_SQL_FILES.join('・')} を連結。\n-- scripts/build-ux-migration.mjs で生成。0008 の後に適用。本番には自動適用しない。\n\n${r9ExtensionsSql}`;
}

export function buildUxMigration() {
  const header = [
    `-- 使いやすさ改修（2026-09-24）の追加表。src/ の ${UX_SQL_FILES.join('・')} をこの順で連結したもの。`,
    '-- scripts/build-ux-migration.mjs で作る（手で直さない）。既存の本番D1へ自動では適用しない（代表の手順で適用する）。',
    '',
  ].join('\n');
  return `${header}\n${uxExtensionsSql}`;
}

// ロイヤリティ・製作委員会の月次・原本の付け替え（2026-09-25）の追加表。0002 と同じく追加だけ
export function buildR3Migration() {
  const header = [
    `-- ロイヤリティ・製作委員会の月次・原本の付け替え（2026-09-25）の追加表。src/ の ${R3_SQL_FILES.join('・')} をこの順で連結したもの。`,
    '-- scripts/build-ux-migration.mjs で作る（手で直さない）。0002 の後に当てる。既存の本番D1へ自動では適用しない。',
    '',
  ].join('\n');
  return `${header}\n${r3ExtensionsSql}`;
}

// 営業基幹・全作品のウィンドウ・取引先別リスト・売上集計シート（2026-09-25）の追加表。0002・0003 と同じく追加だけ
export function buildR4Migration() {
  const header = [
    `-- 営業基幹・全作品のウィンドウ・取引先別リスト・売上集計シート（2026-09-25）の追加表。src/ の ${R4_SQL_FILES.join('・')} をこの順で連結したもの。`,
    '-- scripts/build-ux-migration.mjs で作る（手で直さない）。0003 の後に当てる。既存の本番D1へ自動では適用しない。',
    '',
  ].join('\n');
  return `${header}\n${r4ExtensionsSql}`;
}

// 営業基幹の提案資料（2026-09-26）の追加表（提案資料に出す作品情報の版）。0002〜0004 と同じく追加だけ
export function buildR5Migration() {
  const header = [
    `-- 営業基幹の提案資料（2026-09-26）の追加表。src/ の ${R5_SQL_FILES.join('・')} をこの順で連結したもの。`,
    '-- scripts/build-ux-migration.mjs で作る（手で直さない）。0004 の後に当てる。既存の本番D1へ自動では適用しない。',
    '',
  ].join('\n');
  return `${header}\n${r5ExtensionsSql}`;
}

// 番販・放送の放送履歴表・アベイルズリスト・放送ウィンドウ提案（2026-09-26）の追加表。0002〜0004 と同じく追加だけ
export function buildR6Migration() {
  const header = [
    `-- 番販・放送の放送履歴表・アベイルズリスト・放送ウィンドウ提案（2026-09-26）の追加表。src/ の ${R6_SQL_FILES.join('・')} をこの順で連結したもの。`,
    '-- scripts/build-ux-migration.mjs で作る（手で直さない）。0004 の後に当てる（取引先別リストの明細を参照する）。既存の本番D1へ自動では適用しない。',
    '',
  ].join('\n');
  return `${header}\n${r6ExtensionsSql}`;
}

// PL・BS（管理会計の試算）の法人情報・勘定科目・手入力の額・経費の出金・出資の払込（2026-09-26）の追加表。0002〜0004 と同じく追加だけ
export function buildR7Migration() {
  const header = [
    `-- PL・BS（管理会計の試算）の法人情報・勘定科目・手入力の額・経費の出金・出資の払込（2026-09-26）の追加表。src/ の ${R7_SQL_FILES.join('・')} をこの順で連結したもの。`,
    '-- scripts/build-ux-migration.mjs で作る（手で直さない）。0006 の後に当てる。既存の本番D1へ自動では適用しない。',
    '',
  ].join('\n');
  return `${header}\n${r7ExtensionsSql}`;
}

// 放送ウィンドウ提案から作った放送枠の下書きの記録と、合意に至らず削除した記録（2026-09-26）の追加表。0002〜0007 と同じく追加だけ
export function buildR8Migration() {
  const header = [
    `-- 放送ウィンドウ提案から作った放送枠の下書きの記録と、合意に至らず削除した記録（2026-09-26）の追加表。src/ の ${R8_SQL_FILES.join('・')} をこの順で連結したもの。`,
    '-- scripts/build-ux-migration.mjs で作る（手で直さない）。0007 の後に当てる。既存の本番D1へ自動では適用しない。',
    '',
  ].join('\n');
  return `${header}\n${r8ExtensionsSql}`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let failed = false;
  for (const [path, expected] of [[UX_MIGRATION_PATH, buildUxMigration()], [R3_MIGRATION_PATH, buildR3Migration()], [R4_MIGRATION_PATH, buildR4Migration()], [R5_MIGRATION_PATH, buildR5Migration()], [R6_MIGRATION_PATH, buildR6Migration()], [R7_MIGRATION_PATH, buildR7Migration()], [R8_MIGRATION_PATH, buildR8Migration()], [R9_MIGRATION_PATH, buildR9Migration()], [R10_MIGRATION_PATH, buildR10Migration()]]) {
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch { current = null; }
    const name = path.split(/[\\/]/).pop();
    if (process.argv.includes('--check')) {
      if (current !== expected) {
        console.error(`migrations/${name} が src の追加表と一致しません。node scripts/build-ux-migration.mjs で作り直してください`);
        failed = true;
      } else console.log(`${name} は最新です`);
    } else if (current === expected) {
      console.log(`${name}: 変更なし`);
    } else {
      writeFileSync(path, expected);
      console.log(`書き出しました: ${path}`);
    }
  }
  if (failed) process.exit(1);
}
