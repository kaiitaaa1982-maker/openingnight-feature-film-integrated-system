// staging の統合システムの受け口を、Cloudflare Access のサービストークンで呼ぶときの共通の決まり（会社ルートの plans/2026-11-06-r2-ingest.md の B・C）。
// トークンは環境変数 ON_STAGING_ACCESS_ID・ON_STAGING_ACCESS_SECRET で受け取り（ps1 が DPAPI の登録から子のプロセスにだけ渡す）、
// CF-Access-Client-Id・CF-Access-Client-Secret の見出しにだけ載せる。値は出力しない・URL や本文に入れない。
// 呼べるのは /api/ の下だけ。Access のログイン画面への転送は追わない（redirect: 'manual'）。
// 書き込み（POST・PUT・PATCH・DELETE）は Worker が Origin を確かめる（cloud-security.mjs の isSafeCloudRequest）ので、Origin に staging の起点を載せる。

export const STAGING_ORIGIN = 'https://staging.example.invalid';
export const ACCESS_ENV = Object.freeze({id: 'ON_STAGING_ACCESS_ID', secret: 'ON_STAGING_ACCESS_SECRET'});

export function accessToken(env = process.env) {
  const id = env[ACCESS_ENV.id], secret = env[ACCESS_ENV.secret];
  if (!id || !secret) throw new Error(`トークンが渡されていない（${ACCESS_ENV.id}・${ACCESS_ENV.secret}。ps1 から呼ぶ）`);
  return {id, secret};
}

export function assertApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\s#]|\.\./.test(path)) throw new Error('受け口は /api/ で始まる道にする');
  return path;
}

// origin は書き込みの Origin と組織の確かめの宛先。既定は staging（本番は production-api.mjs が渡す）
export function accessHeaders({id, secret}, method = 'GET', origin = STAGING_ORIGIN) {
  if (!id || !secret) throw new Error('トークンが渡されていない');
  const headers = {'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, accept: 'application/json'};
  if (method !== 'GET' && method !== 'HEAD') headers.origin = origin;
  return headers;
}

// 操作する組織を選ぶ（画面の組織の切替と同じ Cookie on_org＝利用者ID:組織ID）。利用者 ID は /api/session で読み、
// Cookie を付けた /api/session の orgId が選んだ組織になったかを確かめる。なれなければ（所属していない・無効で既定の組織へ戻った）投げる。
// 返すのは Cookie の見出しの値。呼ぶ側は本命の要求にだけ付ける（確かめる前に書き込みを送らない）
// 使い捨て DB へは origin と headers（ログインの Cookie を含む GET の見出し）を渡す。headers の cookie には on_org を足して送る
export const ORG_ID = /^[1-9]\d{0,14}$/;
export async function selectOrgCookie({token, orgId, fetchImpl = fetch, origin = STAGING_ORIGIN, headers = null}) {
  if (!ORG_ID.test(String(orgId))) throw new Error('組織は id（1以上の整数）で指定する');
  const base = headers ?? accessHeaders(token, 'GET', origin);
  const session = async (cookie) => {
    const sent = [base.cookie, cookie].filter(Boolean).join('; ');
    const response = await fetchImpl(origin + '/api/session', {method: 'GET', redirect: 'manual', headers: {...base, ...(sent ? {cookie: sent} : {})}});
    return response.ok ? (await response.json())?.user ?? null : null;
  };
  const me = await session(null);
  if (!me) throw new Error('/api/session が読めない（組織を選ぶ前の確かめ）');
  const cookie = `on_org=${Number(me.id)}:${Number(orgId)}`;
  if (Number((await session(cookie))?.orgId) !== Number(orgId)) throw new Error(`組織 ${orgId} を選べなかった（所属していないか無効）。本命の要求は送っていない`);
  return cookie;
}

// 返った応答の中身に、万一トークンが写っていても出力しない
export function redact(text, {id, secret}) {
  let out = String(text);
  for (const value of [secret, id]) if (value) out = out.split(value).join('***');
  return out;
}
