// 画面が描いている組織をサーバーへ伝えるヘッダーと、組織の食い違い（409）の目印。
// 画面（ui/api-client.mjs）とサーバー（session-org.mjs）で同じ値を使う。node: を import しない（ブラウザ・Node・Worker で同じに動く）。
export const ORG_HEADER = 'X-On-Org';
export const ORG_MISMATCH_CODE = 'org_mismatch';

// API の誤り（ApiError）または応答の本体が、組織の食い違いによる 409 か
export function isOrgMismatch(error) {
  if (!error || typeof error !== 'object') return false;
  return error.code === ORG_MISMATCH_CODE || (Boolean(error.body) && typeof error.body === 'object' && error.body.code === ORG_MISMATCH_CODE);
}
