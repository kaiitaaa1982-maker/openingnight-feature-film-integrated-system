// 委員会の条件版を足すときの決まり（適用開始月・窓口手数料の取り分の引き継ぎ・確定済みのロイヤリティ報告書への影響）。
// app.mjs の committeeVersionStatements と条件版・契約の登録APIが使う。Worker でも動くよう node:* を import しない。
//
// 適用開始月（committee_term_version_effective）: 版2以降に指定できる計上月（YYYY-MM）。その月から後の月だけ新しい版で計算し、
//   前の月は前の版のまま（committee-income.mjs の termVersionAt）。指定しない版は最初の月から前の版に代わる（訂正）。
// 取り分の引き継ぎ: コピー元の版の同じ種類の窓口に取り分があり、窓口の受取先が同じで、取り分の受取先が新しい版の参加者
//   （か窓口の受取先）のままなら、新しい窓口へ同じ取り分を写す。写せないものは理由を返す（画面・月次収支で知らせる）。
// 確定済みの報告書への影響: 新しい版（または作品の新しい委員会契約）が計算を変える計上月に、取り消していない確定版の
//   ロイヤリティ報告書（本委員会収入を基礎にする契約の明細）があれば、その一覧を返す。登録APIは確認（confirmRetroactive）なしでは409。
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const COMMITTEE_ROYALTY_BASES = Object.freeze(['committee_income', 'committee_income_after_expenses']);
const MAX_LISTED = 50;

// 入力の適用開始月。空は null（最初の月から）。版1には指定できない
export function parseEffectiveFrom(input, {versionNo}) {
  const raw = input?.effectiveFrom;
  const text = raw === null || raw === undefined ? '' : String(raw).normalize('NFKC').trim();
  if (!text) return null;
  if (versionNo <= 1) throw new Error('契約の最初の条件版（版1）は最初の月から適用します。適用開始月は版2から指定できます');
  if (!MONTH.test(text)) throw new Error('適用開始月は「2027-01」の形（計上月）で入れてください');
  return text;
}

// コピー元の版の窓口手数料の取り分を、新しい版の窓口へ写す文（同じ batch で窓口を作った後に当てる）。
// newWindows: [{id, kind, label, windowPartnerId}]、memberIds: 新しい版の参加者の取引先ID
export async function feeShareCopy(db, {orgId, userId, sourceVersionId, newWindows, memberIds, enabled = true}) {
  const result = {statements: [], copied: [], skipped: []};
  if (sourceVersionId == null) return result;
  const [source, sourceWindows, shares] = await Promise.all([
    db.get('SELECT id, version_no FROM committee_term_versions WHERE org_id=? AND id=?', [orgId, sourceVersionId]),
    db.all('SELECT id, kind, label, window_partner_id FROM committee_term_windows WHERE org_id=? AND term_version_id=? ORDER BY id', [orgId, sourceVersionId]),
    db.all(`SELECT s.window_id, s.partner_id, s.share_bps, s.reason FROM committee_term_window_fee_shares s
        JOIN committee_term_windows w ON w.org_id=s.org_id AND w.id=s.window_id WHERE s.org_id=? AND w.term_version_id=? ORDER BY s.window_id, s.partner_id`, [orgId, sourceVersionId]),
  ]);
  if (!source) return result;
  const members = new Set((memberIds || []).map(Number));
  for (const window of newWindows) {
    const before = sourceWindows.find((row) => row.kind === window.kind);
    const rows = before ? shares.filter((row) => row.window_id === before.id) : [];
    if (!rows.length) continue;
    const base = {kind: window.kind, label: window.label, fromVersionNo: source.version_no, shares: rows.map((row) => ({partnerId: row.partner_id, shareBps: row.share_bps}))};
    if (!enabled) { result.skipped.push({...base, reason: '引き継がない設定で作りました'}); continue; }
    if (Number(before.window_partner_id) !== Number(window.windowPartnerId)) {
      result.skipped.push({...base, reason: '窓口の受取先が変わったため引き継いでいません'});
      continue;
    }
    const outsider = rows.find((row) => !members.has(Number(row.partner_id)) && Number(row.partner_id) !== Number(window.windowPartnerId));
    if (outsider) { result.skipped.push({...base, reason: '取り分の受取先が新しい版の参加者にいないため引き継いでいません'}); continue; }
    const total = rows.reduce((sum, row) => sum + Number(row.share_bps), 0);
    if (total !== 10000) { result.skipped.push({...base, reason: 'コピー元の取り分の合計が100%でないため引き継いでいません'}); continue; }
    for (const row of rows) {
      const reason = `条件版${source.version_no}から引き継ぎ: ${row.reason}`.slice(0, 500);
      result.statements.push({sql: 'INSERT INTO committee_term_window_fee_shares(org_id, window_id, partner_id, share_bps, reason, created_by) VALUES(?,?,?,?,?,?)',
        params: [orgId, window.id, row.partner_id, row.share_bps, reason, userId]});
    }
    result.copied.push(base);
  }
  return result;
}

// 計算が変わる計上月（fromMonth 以後。null は最初の月から）にかかる、取り消していない確定版のロイヤリティ報告書。
// 作品の月次収支・ロイヤリティの本委員会収入は作品の最後に登録した委員会契約で計算するため、contractId がその契約でなければ影響なし。
// newContract=true は、作品の委員会契約を新しく作る（その契約が最後の契約になる）とき。
export async function retroactiveRoyaltyImpact(db, {orgId, workId, contractId = null, fromMonth = null, newContract = false}) {
  if (!newContract) {
    const latest = await db.get('SELECT MAX(id) AS id FROM committee_contracts WHERE org_id=? AND work_id=?', [orgId, workId]);
    if (!latest?.id || Number(latest.id) !== Number(contractId)) return {statements: [], total: 0, fromMonth};
  }
  const rows = await db.all(`SELECT s.id, s.close_month, s.holder_partner_id, p.name AS holder_name, COUNT(*) AS line_count,
        MIN(l.accrual_month) AS first_month, MAX(l.accrual_month) AS last_month
      FROM royalty_statement_lines l
      JOIN royalty_statements s ON s.org_id=l.org_id AND s.id=l.statement_id
      JOIN royalty_agreements a ON a.org_id=l.org_id AND a.id=l.agreement_id
      JOIN royalty_term_versions t ON t.org_id=l.org_id AND t.id=l.term_version_id
      JOIN partners p ON p.org_id=s.org_id AND p.id=s.holder_partner_id
      WHERE l.org_id=? AND a.work_id=? AND l.accrual_month>=? AND l.line_kind IN ('accrual','revision') AND t.base_kind IN (${COMMITTEE_ROYALTY_BASES.map((kind) => `'${kind}'`).join(',')})
        AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=s.org_id AND v.statement_id=s.id)
      GROUP BY s.id, s.close_month, s.holder_partner_id, p.name
      ORDER BY s.close_month, s.id`, [orgId, workId, fromMonth || '0000-01']);
  const statements = rows.map((row) => ({statementId: row.id, closeMonth: row.close_month, holderId: row.holder_partner_id, holderName: row.holder_name,
    lineCount: Number(row.line_count), firstMonth: row.first_month, lastMonth: row.last_month}));
  return {statements: statements.slice(0, MAX_LISTED), total: statements.length, fromMonth};
}

// 409 の文。影響する報告書を権利者×締め月で並べる
export function retroactiveMessage(impact, {newContract = false} = {}) {
  const head = newContract
    ? 'この作品の本委員会収入は最後に登録した委員会契約で計算するため、新しい契約はすべての計上月の計算を変えます。'
    : impact.fromMonth
      ? `適用開始月（${impact.fromMonth}）以後の計上月の本委員会収入が変わります。`
      : '適用開始月を決めずに作る版は、最初の月からすべての計上月の本委員会収入を変えます。';
  const list = impact.statements.slice(0, 5).map((row) => `${row.holderName}（${row.closeMonth}締め）`).join('、');
  const more = impact.total > 5 ? `ほか${impact.total - 5}通` : '';
  return `${head}本委員会収入を基礎にするロイヤリティの確定済みの報告書が${impact.total}通あり（${list}${more}）、次の報告書に「報告後の修正」の差額が出ます。`
    + '将来の月だけを変えるときは、適用開始月を締めていない月にしてください。過去の月も訂正するときは、確認（confirmRetroactive）を付けて登録してください。';
}
