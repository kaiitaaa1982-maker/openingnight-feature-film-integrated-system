// 帳票センターでカードを押したあと、選んだ帳票（カード一覧の下）の位置まで送る。
// 押した直後は表がまだ読み込み中でページが短く、1回送るだけではほとんど動かない（21pxだけ動いて止まっていた）。
// そこで、表の高さが変わるたびに送り直し、高さが落ち着いて読み込み中の印（aria-busy）が消えたら終える。
// 利用者がスクロール・キー操作をしたら、そこでやめる（勝手に位置を奪わない）。24帳票どれでも同じに効く。

// 判定だけの部品（DOM を触らない。試験で使う）。step に今の時刻・高さ・読み込み中か・画面の上端からの位置を渡すと、
// {action: 'scroll'|'wait'|'done', behavior} を返す
export function createScrollFollower({maxMs = 5000, settleMs = 700, smooth = true, tolerance = 4} = {}) {
  let start = null, lastHeight = null, stableSince = null, stopped = false;
  return {
    stop() { stopped = true; },
    get stopped() { return stopped; },
    step({now, height, busy = false, top = 0}) {
      if (stopped) return {action: 'done'};
      if (start === null) {
        start = now; lastHeight = height; stableSince = now;
        return {action: 'scroll', behavior: smooth ? 'smooth' : 'auto'};
      }
      if (now - start >= maxMs) { stopped = true; return {action: 'done'}; }
      if (height !== lastHeight) {
        lastHeight = height; stableSince = now;
        return {action: 'scroll', behavior: 'auto'};
      }
      if (!busy && now - stableSince >= settleMs) {
        stopped = true;
        return Math.abs(top) > tolerance ? {action: 'scroll', behavior: 'auto', last: true} : {action: 'done'};
      }
      return {action: 'wait'};
    },
  };
}

// ブラウザで要素を追いかける。止める関数を返す（React の useEffect の後片付けにそのまま使える）
export function followElement(element, {win = globalThis.window, intervalMs = 100, ...options} = {}) {
  if (!element || !win) return () => {};
  const reduced = Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const follower = createScrollFollower({...options, smooth: !reduced});
  const doc = win.document;
  const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
  const userMoved = () => finish();
  let timer = null;
  function finish() {
    follower.stop();
    if (timer !== null) win.clearInterval(timer);
    timer = null;
    for (const name of events) doc?.removeEventListener?.(name, userMoved, true);
  }
  function tick() {
    const rect = element.getBoundingClientRect?.() || {top: 0, height: 0};
    // 上端は scroll-margin-top（固定の見出しの下）を引いた位置で比べる
    const margin = Number.parseFloat(win.getComputedStyle?.(element)?.scrollMarginTop) || 0;
    const result = follower.step({now: Date.now(), height: Math.round(element.scrollHeight || rect.height || 0), busy: Boolean(element.querySelector?.('[aria-busy="true"]')), top: rect.top - margin});
    if (result.action === 'scroll') element.scrollIntoView?.({behavior: result.behavior, block: 'start'});
    if (result.action === 'done' || result.last) finish();
  }
  for (const name of events) doc?.addEventListener?.(name, userMoved, true);
  tick();
  if (!follower.stopped) timer = win.setInterval(tick, intervalMs);
  return finish;
}
