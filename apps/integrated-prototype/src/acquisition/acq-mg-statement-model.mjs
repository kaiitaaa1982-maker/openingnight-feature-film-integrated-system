// 支払う MG の締め月の分配報告書（純関数）。要件は docs/requirements/planning/rights-acquisition.md の FR-PLAN-ACQ-016・017・031・033、
// 計画は会社ルートの plans の 2026-10-22-folder-mg-buy（問い4 A・問い5 A、約束 F-2）。
// 本体は回収の計算（acq-mg-recoup.mjs の computeRecoup）の結果だけから組み立て、同じ入力なら同じ本体になる（ハッシュで作り直しを確かめる）。
// 前回の発行との差（当期の消化の増分と作品ごとの分配額の増分）を本体に持つ。会計の仕訳は、この増分を読む（postJournal が入ったらつなぐ）。
import {recoupIncrement} from './acq-mg-recoup.mjs';

export const STATEMENT_FORMAT = 'acq-mg-statement/1';

// 発行してよいか。検査が全部合うこと、全体の超過まで報告しない契約で超過していないときは出さないこと（問い5 A）
export function statementGate(recoup) {
  if (!recoup) return {ok: false, reason: '条件版がありません'};
  if (!recoup.statementAllowed) return {ok: false, reason: '全体が超過するまで報告書を出さない契約です'};
  const failed = recoup.checks.filter((c) => !c.ok).map((c) => c.key);
  if (failed.length) return {ok: false, reason: `検査が合いません: ${failed.join('・')}`};
  return {ok: true, reason: null};
}

// 発行済みの報告書の行（DB の列）から、増分を求めるための前回の値を戻す
export function previousFromRow(row) {
  if (!row) return null;
  const body = typeof row.body_json === 'string' ? JSON.parse(row.body_json) : row.body_json;
  return {recouped: row.recouped, distribution: row.distribution, works: body?.works?.map((w) => ({workId: w.workId, distribution: w.distribution})) ?? []};
}

// 報告書の本体。日時・発行した人は入れない（同じ締め月を作り直したら同じ本体になるように）
export function buildStatementBody({contract, version, closeMonth, recoup, previous}) {
  const increment = recoupIncrement(previous, recoup);
  return {
    format: STATEMENT_FORMAT,
    contract: {id: contract.id, code: contract.code, title: contract.title, partnerId: contract.partner_id, partnerName: contract.partner_name},
    termVersion: {id: version.id, versionNo: version.version_no, consideration: version.consideration, currency: version.currency, mgAmount: version.mg_amount,
      startsOn: version.starts_on, endsOn: version.ends_on, overageEnabled: version.overage_enabled, overageRateBps: version.overage_rate_bps},
    closeMonth,
    status: recoup.status,
    // 回収中の報告は分配額を0円の支払と分けて示す（FR-PLAN-ACQ-031）
    distributionLabel: recoup.status === 'recouping' ? '回収中' : recoup.status === 'hold' ? '超過後の分配の条件が未登録（保留）' : recoup.status === 'buyout' ? '買切（分配なし）' : null,
    amounts: {gross: recoup.gross, deducted: recoup.deducted, base: recoup.base, recouped: recoup.recouped, balance: recoup.balance, overage: recoup.overage, distribution: recoup.distribution},
    deductions: recoup.deductions,
    works: recoup.works,
    media: recoup.media,
    increment,
    exceptions: recoup.exceptions,
    lineCount: recoup.lineCount,
    note: '金額は税抜の売上から出した源泉徴収前の額（D-025）',
  };
}
