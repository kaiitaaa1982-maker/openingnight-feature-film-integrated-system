// ヘルス専用の経路 GET /api/health/db（PG 計画 段2の準備。代表の決定 2026-10-04 の論点3。F-10 の答え）。
// src/cloud-worker.mjs が、利用者の確かめ（メールとチームの所属）の前に呼ぶ。Node でも import できる。
// - Cloudflare Access の JWT（発行者・AUD・RS256・exp）を、業務の API と同じ src/cloud-security.mjs の verifyAccessToken で確かめる。
//   メールの主張は求めない（サービストークンの JWT はメールを持たない）。JWT が無い・正しくない要求は 403
// - GET だけ。ほかの方法は 405（状態を変える要求は、その前に isSafeCloudRequest がオリジンで断る）
// - 返すのは {ok, database, db} だけ。database は DB の種類（postgres か d1）、db は SELECT 1 の成否（ok か error）。
//   業務データ・利用者・組織・エラーの中身・接続文字列を返さない。メールのある利用者が呼んでも同じ中身
// staging の計測（香盤表 #6・#15）と書いた直後の読み取りの確かめで、代表の手元のスクリプトがサービストークンで呼ぶ
import {verifyAccessToken} from '../cloud-security.mjs';
import {cloudDatabaseName} from './cloud-db.mjs';
import {probeDatabase} from './health-store.mjs';

export const HEALTH_DB_PATH = '/api/health/db';
export const HEALTH_FORBIDDEN_MESSAGE = 'Cloudflare Accessを確認できません。';

// (request, {cfg, db, headers, keys}) → Response。headers は securityHeaders。keys は試験で JWT の鍵を差し替える
export async function respondDatabaseHealth(request, {cfg, db, headers = {}, keys} = {}) {
  if (request.method !== 'GET') return Response.json({ok: false, error: 'GET だけを受け付けます'}, {status: 405, headers: {...headers, Allow: 'GET'}});
  const token = await verifyAccessToken(request, cfg, {requireEmail: false, keys});
  if (!token) return new Response(HEALTH_FORBIDDEN_MESSAGE, {status: 403, headers});
  const result = await probeDatabase(db);
  return Response.json({ok: result === 'ok', database: cloudDatabaseName(db), db: result}, {status: result === 'ok' ? 200 : 503, headers});
}
