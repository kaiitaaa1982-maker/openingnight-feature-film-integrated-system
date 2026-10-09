// ヘルス専用の経路（src/data-platform/cloud-health.mjs）が使う DB の確かめ。SELECT 1 だけを流し、業務の表を読まない。
// 成否だけを返し、エラーの中身（接続先・SQL・DB の文）は返さない
export async function probeDatabase(db) {
  try {
    const row = await db.get('SELECT 1 AS ok');
    return Number(row?.ok) === 1 ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}
