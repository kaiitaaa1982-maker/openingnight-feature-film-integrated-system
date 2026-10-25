// 受託制作の契約の版（総製作費・受託費率・支払いの節目）の入力の読み取りと、受託費と節目ごとの額を決める純関数（フェーズ1の仕様書 #10b）。
// 要件は docs/requirements/revenue/contract-work.md の FR-REV-CWORK-035・036 と、project-cashflow-forecast-actual.md の FR-REV-YOJITSU-044。
// 版の表は移行 0013（contract_production_versions・contract_production_milestones）。DB・時刻・環境変数を読まない（docs/rules/architecture.md）。
// 金額は整数の円、率は整数の bp。受託費は料率の額として truncate（FR-SETL-ACCR-009 と同じ。docs/rules/money.md の signedRateAmount）
import {signedRateAmount} from '../../royalty/royalty-model.mjs';
import {splitByAllocation} from '../../money-allocation.mjs';

// 受託費率は案件ごと 1000〜1500 bps、既定 1000（J-4 (a)。移行 0013 の markup_bps の CHECK と DEFAULT と同じ）
export const DEFAULT_MARKUP_BPS = 1000;
export const MIN_MARKUP_BPS = 1000;
export const MAX_MARKUP_BPS = 1500;
// 総製作費の上限（1兆円。work_finance_versions の制作費と同じ。移行 0013 の budget_yen の CHECK と同じ）
export const MAX_BUDGET_YEN = 1_000_000_000_000;
// 節目の行の数の上限（移行 0013 の milestone_count の CHECK と同じ）
export const MAX_MILESTONES = 60;

const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// 受託費＝総製作費×受託費率（truncate した整数円）。受託費は自社の売上で、制作予備費（D-037 決定2）とは別の値（J-8 (a)）
export function contractFeeYen(budgetYen, markupBps) {
  if (!isInt(budgetYen, 1, MAX_BUDGET_YEN)) throw new Error(`総製作費は 1〜${MAX_BUDGET_YEN} の整数の円で持ちます: ${budgetYen}`);
  if (!isInt(markupBps, MIN_MARKUP_BPS, MAX_MARKUP_BPS)) throw new Error(`受託費率は ${MIN_MARKUP_BPS}〜${MAX_MARKUP_BPS} の整数の bp で持ちます: ${markupBps}`);
  return signedRateAmount(budgetYen, markupBps);
}

// 月初の日（YYYY-MM-01）だけを節目の月として受ける
export function isMonthStart(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-01$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

function text(errors, field, value, {max, label}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') { errors.push({field, message: `${label}は文字で入れてください`}); return null; }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) errors.push({field, message: `${label}は${max}文字までです`});
  return trimmed;
}

// 契約の版の入力（画面・受け口が渡す JSON）を、store に渡す形にそろえる。
// previousVersionNo は画面が見ていた最新の版の番号（版が無ければ 0 か null）。足す版の番号はその次で、ほかの画面が先に足していれば DB が断る
// （移行 0013 の contract_production_versions_sequence）。受託費率が空なら既定の 1000。節目は月初の日の順に並べ、割合の和はちょうど 10000。
// 返り値: {ok, value, errors:[{field, message}]}。ok が false のときは value を使わない
export function normalizeContractVersionInput(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const previousVersionNo = src.previousVersionNo ?? 0;
  if (!isInt(previousVersionNo, 0, Number.MAX_SAFE_INTEGER - 1)) errors.push({field: 'previousVersionNo', message: '見ていた版の番号を読めません'});
  const budgetYen = src.budgetYen ?? null;
  if (!isInt(budgetYen, 1, MAX_BUDGET_YEN)) errors.push({field: 'budgetYen', message: '総製作費は1円〜1兆円の整数の円（税別）で入れてください'});
  const markupBps = src.markupBps ?? DEFAULT_MARKUP_BPS;
  if (!isInt(markupBps, MIN_MARKUP_BPS, MAX_MARKUP_BPS)) errors.push({field: 'markupBps', message: `受託費率は ${MIN_MARKUP_BPS}〜${MAX_MARKUP_BPS} の整数の bp（10〜15%）で入れてください`});
  const list = Array.isArray(src.milestones) ? src.milestones : null;
  const milestones = [];
  if (!list || list.length < 1 || list.length > MAX_MILESTONES) {
    errors.push({field: 'milestones', message: `支払いの節目を 1〜${MAX_MILESTONES} 行で入れてください`});
  } else {
    let total = 0;
    list.forEach((item, index) => {
      const m = item && typeof item === 'object' ? item : {};
      const field = `milestones.${index}`;
      if (!isMonthStart(m.dueOn)) errors.push({field: `${field}.dueOn`, message: '節目の月は月初の日（YYYY-MM-01）で入れてください'});
      else if (index > 0 && isMonthStart(list[index - 1]?.dueOn) && list[index - 1].dueOn >= m.dueOn) errors.push({field: `${field}.dueOn`, message: '節目は月の順に、同じ月を重ねずに並べてください'});
      if (!isInt(m.shareBps, 1, 10000)) errors.push({field: `${field}.shareBps`, message: '節目の割合は 1〜10000 の整数の bp で入れてください'});
      else total += m.shareBps;
      milestones.push({seq: index + 1, dueOn: m.dueOn, shareBps: m.shareBps});
    });
    if (!errors.some((e) => e.field.startsWith('milestones.')) && total !== 10000) errors.push({field: 'milestones', message: `節目の割合の和を 10000 bp（100%）にしてください（いまは ${total}）`});
  }
  const value = {
    previousVersionNo, budgetYen, markupBps, feeYen: null, milestones,
    contractReference: text(errors, 'contractReference', src.contractReference, {max: 500, label: '契約書の参照'}),
    note: text(errors, 'note', src.note, {max: 2000, label: 'メモ'}),
  };
  if (!errors.length) value.feeYen = contractFeeYen(budgetYen, markupBps);
  return {ok: errors.length === 0, value, errors};
}

// 版の行（store の読み取り。milestone_count と、入っている節目の行の数・割合の和）が揃っているか。
// アプリは版と節目を1回の batch で書くので揃わない版はできないが、アプリを通さない書き込みで節目の欠けた版が残りうる。
// 揃っていない版の率は使わない（effectiveRevenueRate が理由 contract_version_incomplete を返す）
export function contractVersionComplete(row) {
  if (!row) return false;
  return Number(row.recorded_milestones) === Number(row.milestone_count) && Number(row.share_total_bps) === 10000;
}

// 節目ごとの制作費（入金の予定）と受託費（純額。J-14 (a): 受託費×節目の割合）。どちらも最大剰余法で配り、和が総製作費・受託費と一致する
// （docs/rules/money.md の「内訳の和＝元の額」。同点は節目の連番の小さい順）。milestones は {seq, share_bps}（store の行）か {seq, shareBps}
export function milestoneAmounts({budgetYen, feeYen, milestones}) {
  const shares = milestones.map((m) => ({work_id: Number(m.seq), allocation_bps: Number(m.share_bps ?? m.shareBps)}));
  const budget = splitByAllocation(budgetYen, shares);
  const fee = splitByAllocation(feeYen, shares);
  return milestones.map((m) => ({seq: Number(m.seq), budgetYen: budget.get(Number(m.seq)), feeYen: fee.get(Number(m.seq))}));
}
