// 処理環境（コンテナ workbench-extractor-v1）の再起動。cloud-worker.mjs の POST /api/workbench/runtime/restart から呼ぶ。
// コンテナは全組織で共有し、分析（cloud-analytics.mjs の createCloudAnalytics）は組織1に固定されている。
// そのため権限は「いま選んでいる組織」ではなく分析の組織（1）の管理者で確かめ、分析中かどうかはどの組織のロックでも止める。
// 組織を切り替えたあとの別の組織の管理者の要求で、組織1の分析中にコンテナを壊さないため。node: を import しない。
import {ORG_HEADER, orgMismatch, orgMismatchBody} from './session-org.mjs';

export const ANALYTICS_ORG_ID = 1;
export const RESTART_FORBIDDEN_MESSAGE = '処理環境の再起動は、分析を持つ組織の管理者だけが行えます。組織を切り替えてから操作してください';
export const RESTART_BUSY_MESSAGE = '分析処理中は再起動できません';

// {db, identity, request, destroy, now} → {status, body}。destroy はコンテナを止める関数（ここでは呼ぶ順だけを決める）
export async function restartWorkbenchRuntime({db, identity, request, destroy, now = () => new Date()}) {
  const mismatch = orgMismatch(identity, request?.headers?.get?.(ORG_HEADER));
  if (mismatch) return {status: 409, body: orgMismatchBody(mismatch)};
  if (Number(identity?.org_id) !== ANALYTICS_ORG_ID || identity?.role !== 'admin') return {status: 403, body: {ok: false, error: RESTART_FORBIDDEN_MESSAGE}};
  const busy = await db.get('SELECT org_id FROM cloud_analytics_state WHERE lock_until>? LIMIT 1', [now().toISOString()]);
  if (busy) return {status: 409, body: {ok: false, error: RESTART_BUSY_MESSAGE}};
  await destroy();
  return {status: 200, body: {ok: true}};
}
