// 取込の上限。ローカル（node:sqlite）は2,000行・2MB。Cloudflare D1（mode='worker'）は1回の呼び出しで
// 実行できる文の数に上限があるため、売上100行・一括登録200行に抑える。上限は画面に理由とともに表示する。
// - salesRows: 1回の登録（報告1件）の行数。原本を作品ごとに分けるときは、分けた作品ごと（登録ごと）に数える
// - reportBytes: 1件の報告として D1 の1行に入る原文・変換後の表（report_imports.raw_text など）の大きさ。UTF-8 のバイト数で比べる
//   （クラウドは cloud-r2-db の行内上限 128KiB より少し小さくする）
// - sourceRows・sourceBytes: 取込ウィザードで受け取った原本の表の選択（作品ごとに分ける前の表）全体の大きさ。
//   クラウドでは大きな選択は R2 に退避する（cloud-r2-db の externalColumns）ので、報告1件の上限より大きくてよい
export const LIMITS = Object.freeze({
  local: {salesRows: 2000, bulkRows: 2000, bytes: 2_000_000, batchStatements: Infinity, reportBytes: 2_000_000, sourceRows: 2000, sourceBytes: 2_000_000},
  production: {salesRows: 2000, bulkRows: 2000, bytes: 2_000_000, batchStatements: Infinity, reportBytes: 2_000_000, sourceRows: 2000, sourceBytes: 2_000_000},
  // batchStatements: D1 の1回の batch に積める文の数（cloud-r2-db の上限500から余裕を引いた値）
  worker: {salesRows: 100, bulkRows: 200, bytes: 200_000, batchStatements: 480, reportBytes: 128_000, sourceRows: 2000, sourceBytes: 2_000_000},
});

export function importLimits(mode = 'local') {
  return LIMITS[mode] || LIMITS.worker;
}

export function limitReason(mode = 'local') {
  return mode === 'worker'
    ? 'クラウド環境では、1回の登録で処理できる件数にデータベースの上限があるため'
    : 'ローカル環境の1回あたりの上限';
}

// 文字列の UTF-8 のバイト数（上限は文字数ではなくバイト数で比べる。日本語は1文字3バイト）
const encoder = new TextEncoder();
export const utf8Bytes = (text) => encoder.encode(String(text ?? '')).byteLength;

// 報告1件（登録1回）の表の大きさの上限（バイト）。bytes と、D1 の1行に入る reportBytes の小さい方
export const reportByteLimit = (limits) => Math.min(limits.bytes, limits.reportBytes ?? limits.bytes);

// 上限のバイト数を画面の文にする（「約128KB」）
export const kbText = (bytes) => `約${Math.floor(bytes / 1000).toLocaleString('ja-JP')}KB`;
