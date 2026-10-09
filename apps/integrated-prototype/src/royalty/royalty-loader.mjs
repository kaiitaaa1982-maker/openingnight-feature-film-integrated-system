// ロイヤリティの発生額を読む口（製作委員会の月次収支が権利処理費として使う）。
// loadRoyaltyAccruals(db, identity, {workIds, from, to}, ctx) → [{agreementId, workId, holderPartnerId, holderName, category, accrualMonth,
//   baseYen, royaltyYen, holdSalesYen}]（計上月・税抜。保留の分は royaltyYen に入れず holdSalesYen に残す）
// ・計上月ごとの発生額（締め月・報告書にはよらない）。計上無しのフェーズの月は返さない。
// ・算定できない月（委員会の条件が未登録など）は royaltyYen を null にし、対象売上を holdSalesYen に残す（0円にしない）。
// ・区分未確認の売上がある月は、決まった分だけを royaltyYen に入れ、決められない売上を holdSalesYen に残す。
// ・イレギュラーの台帳の「保留」は報告・支払を止める記録で、発生額は変えない（royaltyYen に入れ、held を true にする）。
// ・作品の財務権限がある契約だけ（ctx.settlementWork）。制作担当は空。追加の項目: agreementCode, closeMonth, held, holdReasons, calcMethod, termVersionId。
import {loadAgreements, loadEntries, loadManual, loadItems} from './royalty-data.mjs';
import {isMonth} from './royalty-model.mjs';

export async function loadRoyaltyAccruals(db, identity, {workIds = [], from, to} = {}, ctx = {}) {
  if (!identity || identity.role === 'production' || typeof ctx.settlementWork !== 'function') return [];
  if (!isMonth(from) || !isMonth(to) || from > to) return [];
  const targets = new Set((workIds || []).map(Number));
  if (!targets.size) return [];
  const {agreements} = await loadAgreements(db, identity, ctx, {});
  const scoped = agreements.filter((agreement) => targets.has(agreement.workId));
  if (!scoped.length) return [];
  const holderIds = [...new Set(scoped.map((agreement) => agreement.holderId))];
  const entries = await loadEntries(db, identity.org_id, holderIds);
  const manual = await loadManual(db, identity.org_id, scoped.map((agreement) => agreement.id));
  const items = await loadItems(db, identity, scoped, entries, manual, {toMonth: to, fromMonth: from}, ctx);
  const byId = new Map(scoped.map((agreement) => [agreement.id, agreement]));
  return items
    .filter((item) => item.accrualMonth >= from && item.accrualMonth <= to)
    .map((item) => {
      const agreement = byId.get(item.agreementId);
      return {
        agreementId: item.agreementId, agreementCode: agreement.code, workId: agreement.workId, holderPartnerId: agreement.holderId, holderName: agreement.holderName,
        category: agreement.category, accrualMonth: item.accrualMonth, baseYen: item.baseYen, royaltyYen: item.royaltyYen, holdSalesYen: item.holdSalesYen || 0,
        closeMonth: item.closeMonth, held: item.held, holdReasons: item.holdReasons, calcMethod: item.calcMethod, termVersionId: item.termVersionId,
      };
    })
    .sort((a, b) => a.workId - b.workId || a.accrualMonth.localeCompare(b.accrualMonth) || a.agreementId - b.agreementId);
}
