// Rebuild only the reviewed fictional downloads. No original business files are used.
// ・手元用の初期データ（組織1・WRK-DEMO）用: 元の CSV・正常取込CSV と、XLSX（OOXML の部品から組み立てる）
// ・架空データ（デモ）DEMO-SALES 用: XLSX だけ（2026-09-26 に代表へ渡したブックの部品そのもの。数値・行・列・シートを変えない）
// XLSX の組み立ては scripts/fixture-xlsx.mjs（計測の scripts/measure-common.mjs と同じ道具。同じ部品なら同じバイト）
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { buildFixtureXlsx } from './fixture-xlsx.mjs';

const fixtureRoot = new URL('../fixtures/', import.meta.url);
const publicRoot = new URL('../public/demo-fixtures/', import.meta.url);
await mkdir(publicRoot, { recursive: true });
const CSV_SLUGS = ['streaming-platform', 'videogram-rental'];
const XLSX_SLUGS = [...CSV_SLUGS, 'demo-sales-streaming', 'demo-sales-videogram'];
for (const slug of CSV_SLUGS) {
  for (const kind of ['sample', 'canonical']) {
    const name = `${slug}-${kind}.csv`;
    await copyFile(new URL(name, fixtureRoot), new URL(name, publicRoot));
  }
}
for (const slug of XLSX_SLUGS) {
  // Readable OOXML source retains the approved workbook's values, formulas and layout.
  await writeFile(new URL(`${slug}-sample.xlsx`, publicRoot), buildFixtureXlsx(slug));
}
