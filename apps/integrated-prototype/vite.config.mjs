import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 閲覧用プレビュー（vite build --mode preview）: 記録した応答で動く静的な版。index.html の入口を src/preview/preview-main.mjs に
// 差し替え、どこに置いても開けるよう相対パス（base './'）で dist-preview へ出す。通常のビルドと開発サーバーの設定は変えない。
export const APP_ENTRY = '/src/main.jsx';
export const PREVIEW_ENTRY = '/src/preview/preview-main.mjs';

export function previewEntry() {
  return {
    name: 'openingnight-preview-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(`src="${APP_ENTRY}"`)) throw new Error(`index.html に入口（${APP_ENTRY}）が見つかりません`);
        return html.replace(`src="${APP_ENTRY}"`, `src="${PREVIEW_ENTRY}"`);
      },
    },
  };
}

export default defineConfig(({ mode }) => (mode === 'preview'
  ? {
    plugins: [react(), previewEntry()],
    base: './',
    build: { outDir: 'dist-preview', sourcemap: false, emptyOutDir: true }
  }
  : {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 9040, proxy: { '/api': 'http://127.0.0.1:9041' } },
    build: { outDir: 'dist', sourcemap: true, emptyOutDir: true }
  }));
