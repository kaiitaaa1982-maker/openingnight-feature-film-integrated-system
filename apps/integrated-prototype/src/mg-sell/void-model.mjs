// 受取 MG の報告（台帳の行）の取消。行は変更も削除もできない（src/mg.sql のトリガー）ので、
// 取消は「4つの額を0にした訂正版」を1行足して行う（FR-SETL-MGL-008 の訂正版の仕組みをそのまま使う）。
// 元の行は訂正前として残り、回収の計算（contractProgress・MG 集計・帳票）からは訂正版の0円だけが数えられる。
// 会社ルートの計画 plans/2026-10-22-folder-mg-sell.md の「登録・直し・取消」。純関数（ブラウザ・Node で同じに動く）。

export const VOID_PREFIX = '取消: ';
export const VOID_SUFFIX = '／取消';

// 取消の行かどうか（4つの額が0で、理由が「取消: 」で始まる訂正版）
export function isVoidEntry(row) {
  return Boolean(row?.reverses_entry_id) && String(row?.confirmation_reason || '').startsWith(VOID_PREFIX)
    && ['reported_eligible_yen', 'applied_recoup_yen', 'reported_overage_yen', 'recognized_yen'].every((k) => Number(row[k]) === 0);
}

// 取消の訂正版の入力（POST /api/mg/ledger の本文）。row は ledgerView の行。理由が空なら null
export function buildVoidPayload(row, reason) {
  const text = String(reason ?? '').trim();
  if (!text || !row || row.superseded) return null;
  const base = String(row.sourceReference || '').slice(0, 300 - VOID_SUFFIX.length);
  return {
    termVersionId: row.termVersionId, productId: row.productId,
    periodFrom: row.periodFrom, periodTo: row.periodTo, accountingMonth: row.accountingMonth,
    reportReceivedOn: row.reportReceivedOn || null,
    sourceReference: `${base}${VOID_SUFFIX}`,
    reportedEligibleYen: 0, appliedRecoupYen: 0, reportedOverageYen: 0, recognizedYen: 0,
    status: 'unverified', reversesEntryId: row.id,
    confirmationReason: `${VOID_PREFIX}${text}`.slice(0, 500),
  };
}
