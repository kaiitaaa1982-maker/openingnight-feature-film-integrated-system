// 操作する組織の選び方。認証（ローカルのセッション・Cloudflare Access の JWT）が済んだあとに、どの所属で操作するかだけを決める。
// 既定は有効な所属のうち org_id が最も小さいもの。Cookie on_org（値は「利用者ID:組織ID」）で選んだ組織は、毎回 memberships で
// 所属を確かめてから使う。別の利用者が選んだ組織（同じブラウザで入る人が替わったとき）は使わない。
// 所属が無い・失効・停止のときは既定へ戻すが、それを黙って使ってよいのは今の組織を知るための API（ORG_CHECK_EXEMPT_PATHS）だけで、
// ほかの要求は 409 にして画面に読み直させる（orgMismatch）。画面は描いている組織を X-On-Org に載せ、食い違えば同じく 409。
// Worker でも動くよう node: を import しない。
import {ORG_HEADER, ORG_MISMATCH_CODE} from './org-header.mjs';

export {ORG_HEADER, ORG_MISMATCH_CODE};
export const ORG_COOKIE = 'on_org';
const ORG_COOKIE_MAX_AGE = 30 * 24 * 3600;
const ID = /^[1-9]\d{0,14}$/;

// 組織の照合をしない API。今の組織を知る（/api/session）・所属の一覧・切替と、退出（DELETE /api/session）
export const ORG_CHECK_EXEMPT_PATHS = Object.freeze(['/api/session', '/api/session/orgs', '/api/session/org']);

export const ORG_MISMATCH_MESSAGE = '別の画面で組織が切り替わったか、選んでいた組織の所属が無効になりました。この操作は行っていません。今の組織で読み直してください';

// on_org の値。選んだ利用者と組織の組（別の利用者の選択を使わないため）
export function orgCookieValue(userId, orgId) {
  return `${Number(userId)}:${Number(orgId)}`;
}

// Cookie ヘッダーから、この利用者（userId）が選んだ組織IDを読む。形が違う・別の利用者の選択なら null（既定の組織を使う）
export function requestedOrgId(cookieHeader, userId) {
  const raw = new RegExp(`(?:^|;\\s*)${ORG_COOKIE}=([^;]*)`).exec(String(cookieHeader || ''))?.[1];
  if (raw == null || userId == null) return null;
  let text;
  try { text = decodeURIComponent(raw).trim(); } catch { return null; }
  const [owner, org, ...rest] = text.split(':');
  if (rest.length || !ID.test(owner || '') || !ID.test(org || '')) return null;
  return Number(owner) === Number(userId) ? Number(org) : null;
}

function activeAt(value, now) {
  if (value == null || value === '') return true;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now;
}

// 利用者の有効な所属（active=1・期限内）を org_id の小さい順に。組織の名前・コードつき
export async function activeMemberships(db, userId, now = Date.now()) {
  const rows = await db.all(`SELECT m.org_id, m.role, m.expires_at, o.code AS org_code, o.name AS org_name
    FROM memberships m JOIN organizations o ON o.id=m.org_id
    WHERE m.user_id=? AND m.active=1 ORDER BY m.org_id`, [userId]);
  return rows
    .map((row) => ({...row, org_id: Number(row.org_id)}))
    .filter((row) => activeAt(row.expires_at, now));
}

// 選んだ組織の所属があればそれ、無ければ既定（最初＝org_id が最小）。所属が1つも無ければ null
export function chooseMembership(memberships, requested) {
  const list = Array.isArray(memberships) ? memberships : [];
  return (requested != null && list.find((row) => Number(row.org_id) === Number(requested))) || list[0] || null;
}

// 認証済みの利用者（{user_id,email,display_name}）に、Cookie で選んだ組織（無効なら既定）の所属を付けて返す。
// org_fallback は「選んだ組織が無効で既定へ戻した」印（requested_org_id が選んでいた組織）
export async function identityForUser(db, user, cookieHeader, now = Date.now()) {
  if (!user) return null;
  const requested = requestedOrgId(cookieHeader, user.user_id);
  const chosen = chooseMembership(await activeMemberships(db, user.user_id, now), requested);
  if (!chosen) return null;
  return {
    user_id: user.user_id, email: user.email, display_name: user.display_name, org_id: chosen.org_id, role: chosen.role, expires_at: chosen.expires_at ?? null,
    requested_org_id: requested, org_fallback: requested != null && chosen.org_id !== requested,
  };
}

// Cloudflare Access で確かめたメール（小文字）から利用者を引き、所属を選ぶ
export async function identityForEmail(db, email, cookieHeader, now = Date.now()) {
  const user = await db.get('SELECT id AS user_id,email,display_name FROM users WHERE email=?', [email]);
  return identityForUser(db, user, cookieHeader, now);
}

// 画面が描いている組織（X-On-Org の値）と、この要求で使う組織が食い違うか。食い違えば {currentOrgId, expectedOrgId}、合っていれば null。
// ヘッダーの無い要求（リンクからのダウンロード・試験・スクリプト）は照合しないが、選んでいた組織が無効で既定へ戻したときは食い違いにする
export function orgMismatch(identity, headerValue) {
  const current = Number(identity?.org_id);
  const text = headerValue == null ? '' : String(headerValue).trim();
  if (text) {
    const expected = ID.test(text) ? Number(text) : null;
    return expected === current ? null : {currentOrgId: current, expectedOrgId: expected};
  }
  return identity?.org_fallback ? {currentOrgId: current, expectedOrgId: identity.requested_org_id ?? null} : null;
}

// 食い違いの 409 の本体。画面は code で見分けて、今の組織で読み直す
export function orgMismatchBody(mismatch) {
  return {ok: false, error: ORG_MISMATCH_MESSAGE, code: ORG_MISMATCH_CODE, currentOrgId: mismatch?.currentOrgId ?? null};
}

// on_org の Cookie の設定。HttpOnly・SameSite=Lax、https のときは Secure
export function orgCookieOptions(url) {
  let secure = false;
  try { secure = new URL(url).protocol === 'https:'; } catch { secure = false; }
  return {httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: ORG_COOKIE_MAX_AGE};
}
