// 受託制作の契約の版の入力の画面（ContractProductionPanel.jsx。行動指標の計画 #3「案件の編集の1項目」、モック M-4 の受託費率 A）の、
// 欄の文字と受け口の本文（POST /api/planning/projects/:projectId/contract-versions）の行き来を決める純関数。
// 範囲（受託費率 10〜15%・総製作費・節目の割合の和）は受け口の normalizeContractVersionInput が項目ごとの 400 で断り、ここは止めない
// （同じ判定を2か所に置かない）。ここで止めるのは、数として読めない欄と空の受託費率だけ（空のまま送ると受け口が既定 10% にするため、
// 打ち間違いで率が黙って既定に戻らないようにする）。受託費の見込みは contractFeeYen（受け口が版に残すのと同じ truncate）で出す
import {contractFeeYen, DEFAULT_MARKUP_BPS, MAX_MARKUP_BPS, MIN_MARKUP_BPS} from './contract-production-model.mjs';
import {bpsToPercent, percentToBps} from '../../royalty/royalty-model.mjs';
import {formatNumberInput, isBlankInput, parseMonth, parseYen} from '../../ui/parse-input.mjs';

export const CONTRACT_PRODUCTION_TYPE = 'contract_production';

// 売上の4区分の受け口（GET /api/revenue/revenue-classes。財務の権限のある案件だけを返す）の本文から、型「受託制作」の案件の選択肢を作る
export function contractProjectOptions(body) {
  const projects = Array.isArray(body?.projects) ? body.projects : [];
  return projects.filter((p) => p?.projectType === CONTRACT_PRODUCTION_TYPE)
    .map((p) => ({value: String(p.projectId), label: `${p.code}｜${p.title}`}));
}

// 欄の初めの値。最新の版があればその値（版を改める入力の元。総製作費は桁区切り）、無ければ受託費率は既定 10%・節目は1行 100%
export function formFromVersion(latest) {
  if (!latest) return {budget: '', ratePercent: bpsToPercent(DEFAULT_MARKUP_BPS), milestones: [{month: '', sharePercent: '100'}], contractReference: '', note: ''};
  return {
    budget: formatNumberInput(latest.budgetYen),
    ratePercent: bpsToPercent(latest.markupBps),
    milestones: latest.milestones.map((m) => ({month: String(m.dueOn).slice(0, 7), sharePercent: bpsToPercent(m.shareBps)})),
    contractReference: latest.contractReference ?? '',
    note: '',
  };
}

// 受け口の項目の名前（エラーの field と同じ）。画面は項目の直下にエラーを出し、当たらないものは上の通知に出す
export function contractVersionFieldNames(milestoneCount) {
  const names = ['previousVersionNo', 'budgetYen', 'markupBps', 'milestones', 'contractReference', 'note'];
  for (let i = 0; i < milestoneCount; i += 1) names.push(`milestones.${i}.dueOn`, `milestones.${i}.shareBps`);
  return names;
}

const text = (value) => (isBlankInput(value) ? null : String(value).trim());

// 欄の文字を受け口の本文にする。previousVersionNo は画面が見ていた最新の版の番号（無ければ 0）。
// 返り値: {ok, body, errors:{項目の名前: 理由}}。ok が false なら送らない
export function contractVersionBody(form, previousVersionNo) {
  const errors = {};
  const budget = parseYen(form.budget, {allowNegative: false});
  if (!budget.ok) errors.budgetYen = budget.error;
  else if (budget.value === null) errors.budgetYen = '総製作費（税別・円）を入れてください';
  let markupBps = null;
  if (isBlankInput(form.ratePercent)) errors.markupBps = `受託費率を入れてください（既定は ${bpsToPercent(DEFAULT_MARKUP_BPS)}%）`;
  else {
    markupBps = percentToBps(form.ratePercent);
    if (markupBps === null) errors.markupBps = '受託費率は「12.5」のように % の数で入れてください（小数は2桁まで）';
  }
  const milestones = (form.milestones ?? []).map((row, index) => {
    const month = parseMonth(row.month);
    let dueOn = null;
    if (!month.ok) errors[`milestones.${index}.dueOn`] = month.error;
    else if (month.value === null) errors[`milestones.${index}.dueOn`] = '節目の月を入れてください';
    else dueOn = `${month.value}-01`;
    const shareBps = isBlankInput(row.sharePercent) ? null : percentToBps(row.sharePercent);
    if (shareBps === null) errors[`milestones.${index}.shareBps`] = '節目の割合は「50」のように % の数で入れてください（小数は2桁まで）';
    return {dueOn, shareBps};
  });
  const body = {
    previousVersionNo: Number(previousVersionNo ?? 0), budgetYen: budget.ok ? budget.value : null, markupBps, milestones,
    contractReference: text(form.contractReference), note: text(form.note),
  };
  return {ok: Object.keys(errors).length === 0, body, errors};
}

// 入力中の受託費の見込み（総製作費×受託費率の truncate。受け口が版に残す額と同じ）。読めない・範囲の外なら feeYen は null で理由を返す
export function feePreview(form) {
  const budget = parseYen(form.budget, {allowNegative: false});
  const markupBps = isBlankInput(form.ratePercent) ? null : percentToBps(form.ratePercent);
  if (!budget.ok || budget.value === null || budget.value < 1) return {feeYen: null, budgetYen: null, markupBps, reason: 'budget'};
  if (markupBps === null) return {feeYen: null, budgetYen: budget.value, markupBps: null, reason: 'rate'};
  if (markupBps < MIN_MARKUP_BPS || markupBps > MAX_MARKUP_BPS) return {feeYen: null, budgetYen: budget.value, markupBps, reason: 'rate_range'};
  try {
    return {feeYen: contractFeeYen(budget.value, markupBps), budgetYen: budget.value, markupBps, reason: null};
  } catch {
    return {feeYen: null, budgetYen: budget.value, markupBps, reason: 'budget'};
  }
}

// 節目の割合の和（bp）。読めない行は数えない（和の表示だけに使う。判定は受け口）
export function shareTotalBps(form) {
  return (form.milestones ?? []).reduce((total, row) => total + (percentToBps(row.sharePercent) ?? 0), 0);
}

export const RATE_RANGE_TEXT = `${bpsToPercent(MIN_MARKUP_BPS)}〜${bpsToPercent(MAX_MARKUP_BPS)}%`;
