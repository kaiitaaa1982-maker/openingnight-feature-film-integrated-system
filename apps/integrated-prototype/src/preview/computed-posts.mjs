// 閲覧用プレビューで、保存しない（読むだけの）POST を記録した GET の応答から組み立てる決まり（snapshot-client の computedPosts）。
// サーバーと同じ純関数で計算するので、応答の形と中身は API と同じになる。記録（scripts/build-preview.mjs）は source の GET を記録しておく。
import {availsMatchResult} from '../broadcast/avails-list-model.mjs';

export const PREVIEW_COMPUTED_POSTS = Object.freeze({
  // 放送アベイルズリストの作品名の照合。元は照合の範囲の作品と商品（/api/broadcast/availability-list/candidates）
  '/api/broadcast/availability-list/match': Object.freeze({
    source: '/api/broadcast/availability-list/candidates',
    compute(input, source) {
      const result = availsMatchResult(input?.text, source || {});
      return result.error ? {status: 400, body: {ok: false, error: result.error}} : {status: 200, body: {ok: true, rows: result.rows, counts: result.counts}};
    },
  }),
});

// 記録するときに一緒に読んでおく GET（computedPosts の元）
export const PREVIEW_COMPUTED_SOURCES = Object.freeze(Object.values(PREVIEW_COMPUTED_POSTS).map((rule) => rule.source));
