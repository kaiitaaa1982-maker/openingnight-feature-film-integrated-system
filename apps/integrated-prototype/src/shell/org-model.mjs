// 組織・ログイン状態まわりの純関数（main.jsx と AppShell.jsx が使う）。
// ・画面の読み込みは、まず /api/session で今の組織を知り、その組織を X-On-Org に載せて残りを読む（loadSessionData）
// ・読み込みに失敗したとき、前の組織の画面を残すかどうか（loadFailurePlan）
// ・組織の選択肢の表示と、選択と切替の実行を分けるための判定（orgOptionLabel・orgSwitchTarget）
// ・退出の行き先（ローカルはログイン画面、Worker は Cloudflare Access のサインアウト）
// ・別のタブでの切替を知らせる BroadcastChannel
// node: を import しない（ブラウザ・Node で同じに動く）。
import {isOrgMismatch} from '../org-header.mjs';

export const ROLE_LABELS = Object.freeze({admin: '管理者', editor: '編集担当', production: '制作担当'});
export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';
export const ORG_CHANNEL = 'on-org';
export const ORG_LOAD_FAILED_TITLE = '組織は切り替わりましたが、読み込めませんでした。前の組織の画面は閉じました';
export const ORG_LIST_FAILED_MESSAGE = '組織の一覧を読み込めませんでした';

const positiveId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

// 選択肢の文字。組織名に括弧があっても読めるよう、役割は「・」で区切る（例 架空データ（デモ）・管理者）
export function orgOptionLabel(org) {
  const name = String(org?.name ?? '').trim() || `組織 ${org?.id ?? ''}`.trim();
  return `${name}・${ROLE_LABELS[org?.role] || '役割未確認'}`;
}

// 選択欄で選んだ組織（draft）へ切り替えるか。今の組織と同じ・値が不正なら null（「切り替える」を押せない）
export function orgSwitchTarget(draft, currentOrgId) {
  const target = positiveId(draft);
  if (target === null) return null;
  return target === positiveId(currentOrgId) ? null : target;
}

// ローカルの試作（mode local）だけが架空メンバーのログイン画面を使う
export function usesLocalLogin(mode) {
  return mode === 'local';
}

// 退出したあとの行き先。ローカルは null（ログイン画面を出す）。Worker は Cloudflare Access のサインアウト（Access のセッションも消す）
export function logoutDestination(mode) {
  return usesLocalLogin(mode) ? null : ACCESS_LOGOUT_PATH;
}

// 画面の読み込み。/api/session（組織の照合の対象外）で今の組織を知り、その組織を載せて作品・取引先などを読む。
// 読む間に別の画面で組織が変わると 409（org_mismatch）になるので、今の組織を確かめ直して読み直す（attempts 回まで）。
// 所属の一覧だけが読めなかったときは、ほかを使えるようにして orgsError に残す（orgs は null＝前の一覧を使う）
export async function loadSessionData(request, {attempts = 3} = {}) {
  let last = null;
  let orgReset = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await request('/session', {orgId: null, notifyOrgMismatch: false});
    orgReset = orgReset || current?.orgReset === true;
    const options = {orgId: positiveId(current?.user?.orgId), notifyOrgMismatch: false};
    try {
      const [bootstrap, capabilities, orgs] = await Promise.all([
        request('/bootstrap', options),
        request('/workflow/capabilities', options),
        request('/session/orgs', options).then(
          (value) => ({list: Array.isArray(value?.orgs) ? value.orgs : [], error: null}),
          (error) => ({list: null, error}),
        ),
      ]);
      return {session: current.user, mode: current.mode ?? null, orgReset, bootstrap, capabilities: capabilities || {}, orgs: orgs.list, orgsError: orgs.error};
    } catch (error) {
      if (!isOrgMismatch(error)) throw error;
      last = error;
    }
  }
  throw last;
}

// 読み込みに失敗したときの扱い。
// signed-out: 認証切れ（ログイン画面／サインアウト表示へ）。discard: 組織が変わる読み直しの失敗（前の組織の画面とデータを捨てて、読み込みの失敗を出す）。
// notice: 同じ組織の読み直しの失敗（今の画面は残して、画面の上に誤りを出す）。fatal: 最初の読み込みの失敗
export function loadFailurePlan({error, orgTransition = false, rendered = false} = {}) {
  if (error?.kind === 'auth') return 'signed-out';
  if (orgTransition || isOrgMismatch(error)) return 'discard';
  return rendered ? 'notice' : 'fatal';
}

// 別の画面での切替・所属の失効に合わせて開き直したときのお知らせ
export function orgSyncedNotice({orgName, reset = false, rejected = false} = {}) {
  const name = orgName ? `「${orgName}」` : '今の組織';
  const head = reset ? `選んでいた組織の所属が無効になったため、${name}で開き直しました。` : `別の画面で組織が切り替わったため、この画面を${name}で開き直しました。`;
  return rejected ? `${head}直前の操作は行っていません。必要なら、この組織で確かめてからやり直してください。` : head;
}

export function orgNameOf(loaded) {
  const orgId = positiveId(loaded?.session?.orgId);
  return (Array.isArray(loaded?.orgs) ? loaded.orgs : []).find((org) => positiveId(org?.id) === orgId)?.name || '';
}

// 別のタブへ組織の切替を知らせる。送ったタブ自身には届かないよう、同じ BroadcastChannel で送受信する。使えない環境では null
export function openOrgChannel(onChange, Channel = globalThis.BroadcastChannel) {
  if (typeof Channel !== 'function') return null;
  let channel;
  try { channel = new Channel(ORG_CHANNEL); } catch { return null; }
  channel.onmessage = (event) => {
    const orgId = positiveId(event?.data?.orgId);
    if (orgId !== null) onChange(orgId);
  };
  return {
    post(orgId) { try { channel.postMessage({orgId: Number(orgId)}); } catch { /* 知らせられなくても、各タブは要求の 409 で気づく */ } },
    close() { try { channel.close(); } catch { /* 閉じ済み */ } },
  };
}
