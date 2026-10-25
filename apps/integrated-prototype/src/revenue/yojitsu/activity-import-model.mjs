// 既存の営業の活動（sales_activities。作品の商談ごとの営業の行動で、段A が読む行）を、活動記録（フェーズ1 #13）の行に読み替える純関数
// （行動指標の計画 段B #10。要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-017・020、
// project-cashflow-forecast-actual.md の FR-REV-YOJITSU-035）。取り込んだ行は元の行の id（source_sales_activity_id。組織の中で1回だけ）を持ち、
// すでに取り込んだ行は足さない（二度数えない。K2-15）。結果は移行0020の明示欄から読む。DB・時刻・環境変数を読まない（docs/rules/architecture.md）
import {normalizeActivityInput} from './activity-model.mjs';

// 種別 → 行動のステップ（参照表 action_steps のコード）。数えると段A と同じ親に畳む（contact＝面談・proposal＝提案。FR-REV-KPI-020）。
// 営業の活動は作品の商談の相手（取引先）との行動なので、提案は営業（売り）の細目「取引先への提案」（ontology の「行動の段」）。
// 接触は売りの細目に当たる段が無い（売りの面談の段は「商品化」で、取引先との接触ではない）ので、親の「面談」のまま。
// 交渉とメモは段A も数えないので、ステップを空（数えない。Excel の「その他」）にして取り込む
export const SALES_ACTIVITY_STEPS = Object.freeze({contact: 'meeting', proposal: 'buyer_proposal', negotiation: null, note: null});

const MAX_COUNTERPARTY = 200;
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

// 結果は営業活動に明示した値を使う。商談の状態や後続の有無から推定しない。
// rows は store の readSalesActivityImportRows の行（id・project_id・work_id・opportunity_id・opportunity_stage・partner_name・occurred_on・
// activity_type・summary・next_action・next_due_on・created_by・result・imported_id。取り込み済みの行も含む）。
// steps は行動のステップの参照表の行（code・parent_code）。
// - 稼ぎ方は空（数えるときに案件の稼ぎ方を使う。FR-REV-YOJITSU-017）、成果物は空、記録した人は元の行を記録した人（行は本人にだけ見える。FR-REV-YOJITSU-037）
// - 相手は商談の取引先の名前（200字を超える名前は入れず、件数を counterpartyOmitted に数える）
// - 期日は次の一手に付ける（FR-REV-YOJITSU-035）。次の一手の無い期日は入れず、件数を dueDateDropped に数える
// - 活動記録の入力として読めない行（日付・したことなど）は足さず、元の行の id と項目を rejected に返す
// 返り値: {records（足す行。normalizeActivityInput の value に記録した人 createdBy を添えたもの）, summary（件数と元の行の id だけ。行の中身を持たない）,
// errors（足せない理由。取り込む行が要る細目の段が参照表に無いときで、1つでもあれば受け口は何も足さない）}
export function planSalesActivityImport(rows, {steps}) {
  const known = new Map(steps.map((s) => [s.code, s.parent_code ?? null]));
  const records = [];
  const summary = {read: rows.length, alreadyImported: 0, imported: 0, counted: {meeting: 0, proposal: 0, contract: 0}, uncounted: 0,
    dueDateDropped: 0, counterpartyOmitted: 0, rejected: []};
  const missingSteps = new Set();
  for (const row of rows) {
    if (row.imported_id !== null && row.imported_id !== undefined) { summary.alreadyImported += 1; continue; }
    const salesActivityId = Number(row.id);
    if (!Object.hasOwn(SALES_ACTIVITY_STEPS, row.activity_type)) { summary.rejected.push({salesActivityId, fields: ['activityType']}); continue; }
    const step = SALES_ACTIVITY_STEPS[row.activity_type];
    if (step !== null && !known.has(step)) { missingSteps.add(step); continue; }
    const partner = text(row.partner_name);
    const counterparty = partner !== null && partner.length <= MAX_COUNTERPARTY ? partner : null;
    const nextAction = text(row.next_action);
    const nextDueOn = nextAction === null ? null : row.next_due_on ?? null;
    const n = normalizeActivityInput({projectId: Number(row.project_id), occurredOn: row.occurred_on, earningType: null, step, counterparty,
      summary: row.summary, deliverable: null, nextAction, nextDueOn, result: row.result, workId: Number(row.work_id),
      sourceSalesActivityId: salesActivityId}, {steps, earningTypes: []});
    if (!n.ok) { summary.rejected.push({salesActivityId, fields: n.errors.map((e) => e.field)}); continue; }
    records.push({...n.value, createdBy: Number(row.created_by)});
    if (partner !== null && counterparty === null) summary.counterpartyOmitted += 1;
    if (nextAction === null && row.next_due_on) summary.dueDateDropped += 1;
    if (step === null) summary.uncounted += 1;
    else summary.counted[known.get(step) ?? step] += 1;
  }
  const errors = [...missingSteps].sort().map((code) => ({field: 'steps', step: code,
    message: `行動のステップの参照表に細目の段 ${code} がありません（指標マスタの種 scripts/seed-kpi-metrics-demo.mjs で細目の段を足してから取り込んでください）`}));
  summary.imported = errors.length ? 0 : records.length;
  return {records: errors.length ? [] : records, summary, errors};
}
