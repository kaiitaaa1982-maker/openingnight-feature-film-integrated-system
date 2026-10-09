// 出金・払込の記録と取消を送る共通の手順（React に依存しない。node で試験する）。
// 成功なら true、失敗（400・409 など）なら false を返す。呼び出し側は true のときだけ入力欄を空にしたり閉じたりする
// （失敗したときに入れた金額・理由を消さないため）。
export async function runAction(fn, {onStart, onOk, onError, onFinally} = {}) {
  onStart?.();
  try {
    await fn();
    onOk?.();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  } finally {
    onFinally?.();
  }
}

// 取消日は出金日（払込日）以後。サーバーの 400 を待たずに、欄を開いたまま知らせる
export function reversalDateError(reverse, label = '出金日') {
  if (!reverse?.reversedOn) return '取消日を入れてください';
  return reverse.paidOn && reverse.reversedOn < reverse.paidOn ? `取消日は${label}以後の日付で入れてください` : null;
}
