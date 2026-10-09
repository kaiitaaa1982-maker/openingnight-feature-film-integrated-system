// 閲覧用プレビューの入口。vite build --mode preview のときだけ、vite.config.mjs が index.html の /src/main.jsx をここに差し替える。
// 記録した応答・時計・帯を用意してから、アプリ本体（main.jsx）をそのまま読む。通常のビルドにはこのファイルも preview/ の部品も入らない。
import {bootPreview, showBootFailure} from './preview-boot.mjs';

if (import.meta.env.MODE !== 'preview') throw new Error('プレビューの入口は vite build --mode preview のときだけ使います');

bootPreview()
  .then(() => import('../main.jsx'))
  .catch((error) => {
    console.error(error);
    showBootFailure(error);
  });
