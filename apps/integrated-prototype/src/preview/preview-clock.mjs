// 閲覧用プレビューの時計。記録した時点を「今」にして、「今日」「今月」を既定にする画面の問い合わせが記録と同じ鍵になるようにする。
// ブラウザでは window、試験では Date を持つ任意のオブジェクトに入れる（node:* を使わない）。
// 引数なしの new Date() と Date.now() を「記録した時点＋開いてからの経過」にする。日付を渡したときは変えない
export function installPreviewClock(win, recordedAt) {
  const target = Date.parse(recordedAt);
  if (!Number.isFinite(target)) return;
  const RealDate = win.Date;
  const offset = target - RealDate.now();
  const now = () => RealDate.now() + offset;
  function PreviewDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return args.length ? new RealDate(...args) : new RealDate(now());
  }
  PreviewDate.prototype = RealDate.prototype;
  PreviewDate.now = now;
  PreviewDate.parse = RealDate.parse;
  PreviewDate.UTC = RealDate.UTC;
  win.Date = PreviewDate;
}
