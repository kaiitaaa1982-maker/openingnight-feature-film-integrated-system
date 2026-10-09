// 閲覧用プレビューの起動（ブラウザだけで使う。preview-main.mjs から、アプリ本体を読む前に呼ぶ）。
// 1. preview-data.json（ページと同じ場所からの相対）を読み、記録した応答の表を作る
// 2. 時計を記録した時点に合わせる（「今日」「今月」を既定にする画面の問い合わせが記録と同じ鍵になるように）
// 3. window.fetch を記録の再生に差し替える（保存しない照合は computed-posts.mjs の決まりで記録から組み立てる）。createApi（ui/api-client.mjs）の既定と、画面の直接の fetch('/api/...')
//    （main.jsx の売上サンプルの取得）はどちらも globalThis.fetch を呼ぶので、ここでまとめて再生になる
// 4. <a href="/api/..."> のリンク（分析の照合帳票・番販のExcel/CSV）は、記録があればその内容を開き・保存し、無ければ理由を出す。
//    /demo-fixtures/ など / から始まる静的ファイルのリンクは、プレビューを置いた場所からの相対に直す
// 5. 常に見える帯「閲覧用のプレビュー（架空データ・保存はできません）」を出す
import {
  blobFromRecord, createSnapshotFetch, downloadName, isApiPath, mergePreviewData, snapshotKey,
  PREVIEW_BANNER_TEXT, PREVIEW_DATA_FILE, PREVIEW_MISSING_MESSAGE,
} from './snapshot-client.mjs';
import {installPreviewClock} from './preview-clock.mjs';
import {PREVIEW_COMPUTED_POSTS} from './computed-posts.mjs';
import './preview.css';

async function readJson(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, {cache: 'no-cache'});
  } catch (cause) {
    throw new Error(`プレビューのデータ（${url.pathname.split('/').pop()}）を読み込めませんでした`, {cause});
  }
  if (!response.ok) throw new Error(`プレビューのデータ（${url.pathname.split('/').pop()}）を読み込めませんでした（HTTP ${response.status}）`);
  return response.json();
}

export async function loadPreviewData(fetchImpl, baseUrl) {
  const index = await readJson(fetchImpl, new URL(PREVIEW_DATA_FILE, baseUrl));
  const names = Array.isArray(index?.parts) ? index.parts : [];
  const parts = await Promise.all(names.map((name) => readJson(fetchImpl, new URL(name, baseUrl))));
  return mergePreviewData(index, parts);
}

function dateText(recordedAt) {
  const date = new Date(recordedAt);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ja-JP', {timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function mountBanner(doc, {recordedAt} = {}) {
  const banner = doc.createElement('div');
  banner.className = 'on-preview-banner';
  banner.setAttribute('role', 'status');
  const strong = doc.createElement('strong');
  strong.textContent = PREVIEW_BANNER_TEXT;
  banner.append(strong);
  const when = dateText(recordedAt);
  if (when) {
    const small = doc.createElement('small');
    small.textContent = `${when} 時点の記録`;
    banner.append(small);
  }
  doc.body.classList.add('on-preview');
  doc.body.append(banner);
  return banner;
}

export function createNotifier(doc) {
  let toast = null;
  let timer = null;
  return (message) => {
    if (!toast) {
      toast = doc.createElement('div');
      toast.className = 'on-preview-toast';
      toast.setAttribute('role', 'alert');
      doc.body.append(toast);
    }
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { toast.hidden = true; }, 8000);
  };
}

// / から始まるリンクの扱い。/api/ は記録から開く・保存する。それ以外（/demo-fixtures/ など）はプレビューの置き場所からの相対に直す
export function installLinkGuard(win, {responses, notify}) {
  const doc = win.document;
  const onClick = (event) => {
    if (event.button !== 0 && event.type === 'click') return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    const raw = anchor.getAttribute('href') || '';
    if (!raw.startsWith('/') || raw.startsWith('//')) return;
    const url = new URL(raw, win.location.href);
    if (!isApiPath(url.pathname)) {
      // フォルダ（/workflow-demo/ など）は index.html を付ける（フォルダの既定のページを返さない置き場所があるため）
      const target = new URL(raw.slice(1), doc.baseURI);
      if (target.pathname.endsWith('/')) target.pathname += 'index.html';
      anchor.setAttribute('href', target.href);
      return;
    }
    event.preventDefault();
    const record = responses.get(snapshotKey('GET', url));
    if (!record || Number(record.status) >= 400) {
      notify(record ? '記録した時点で、この内容は開けませんでした' : PREVIEW_MISSING_MESSAGE);
      return;
    }
    const objectUrl = win.URL.createObjectURL(blobFromRecord(record));
    if (anchor.hasAttribute('download')) {
      const link = doc.createElement('a');
      link.href = objectUrl;
      link.download = anchor.getAttribute('download') || downloadName(record, url);
      doc.body.append(link);
      link.click();
      link.remove();
    } else {
      win.open(objectUrl, '_blank', 'noopener');
    }
    setTimeout(() => win.URL.revokeObjectURL(objectUrl), 60000);
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}

export function showBootFailure(error, doc = document) {
  const root = doc.getElementById('root') || doc.body;
  const box = doc.createElement('main');
  box.className = 'on-preview-failure';
  const title = doc.createElement('h1');
  title.textContent = PREVIEW_BANNER_TEXT;
  const text = doc.createElement('p');
  text.textContent = error?.message || 'プレビューを開けませんでした';
  box.append(title, text);
  root.replaceChildren(box);
}

export async function bootPreview(win = window) {
  const realFetch = win.fetch.bind(win);
  const {meta, responses} = await loadPreviewData(realFetch, win.document.baseURI);
  installPreviewClock(win, meta.recordedAt);
  win.fetch = createSnapshotFetch({responses, fallbackFetch: realFetch, base: () => win.location.href, computedPosts: PREVIEW_COMPUTED_POSTS});
  const notify = createNotifier(win.document);
  installLinkGuard(win, {responses, notify});
  mountBanner(win.document, {recordedAt: meta.recordedAt});
  win.__ON_PREVIEW__ = Object.freeze({recordedAt: meta.recordedAt, count: responses.size});
  return {meta, count: responses.size};
}
