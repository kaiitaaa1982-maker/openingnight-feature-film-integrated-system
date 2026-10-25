// Rebuild only the reviewed fictional downloads. No original business files are used.
// ・手元用の初期データ（組織1・WRK-DEMO）用: 元の CSV・正常取込CSV と、XLSX（OOXML の部品から組み立てる）
// ・架空データ（デモ）DEMO-SALES 用: XLSX だけ（2026-09-26 に代表へ渡したブックの部品そのもの。数値・行・列・シートを変えない）
// XLSX の組み立ては scripts/fixture-xlsx.mjs（計測の scripts/measure-common.mjs と同じ道具。同じ部品なら同じバイト）
import { writeFile, mkdir, copyFile, cp } from 'node:fs/promises';
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

// 台本の構造化画面（src/production/script-structuring/ScriptStructuring.jsx）が原本の PDF を描くための、
// pdf.js の文字の対応表（CMap。埋め込みの無い日本語の書体を読むのに要る）と標準の書体と、JPEG 2000・JBIG2 の画像の復号。
// node_modules から public/pdfjs/ へ写し、ビルドで dist/pdfjs/ に入る（git には入れない。版は package-lock.json の pdfjs-dist と同じ）
const pdfjsRoot = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const pdfjsPublic = new URL('../public/pdfjs/', import.meta.url);
for (const folder of ['cmaps/', 'standard_fonts/']) {
  await cp(new URL(folder, pdfjsRoot), new URL(folder, pdfjsPublic), { recursive: true });
}
// 復号は WebAssembly を使わない JavaScript の版だけを写す（画面は useWasm: false。*.wasm と、フォームの式を動かす quickjs-eval は写さない）
await mkdir(new URL('wasm/', pdfjsPublic), { recursive: true });
for (const file of ['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2']) {
  await copyFile(new URL(`wasm/${file}`, pdfjsRoot), new URL(`wasm/${file}`, pdfjsPublic));
}
