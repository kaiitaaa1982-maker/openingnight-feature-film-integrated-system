// 作品の月別収支の画面（main.jsx の収支・IncomeDashboard.jsx）の基準ごとの言葉（フェーズ1 #16）。DB・時刻に触れない純関数。
// 見出しに基準を出し、計上（計上月）と入金（入金日・出金日の月）で項目の名前と注意書きを切り替える
import {BASIS_DESCRIPTIONS, DEFAULT_BASIS} from '../../reports/pl-bs-cash-model.mjs';

export const INCOME_CAUTION = '登録済みデータの集計です。報告の網羅性は未確認で、分配・仕入・代理店手数料は未反映です。差引は「売上報告額 − 登録経費」で、代理店利益ではありません。';
export const CASH_INCOME_CAUTION = '請求の入金と経費の出金の集計です。請求どおりの額の入金と、税込額どおりに払い切った出金だけを税抜にし、それ以外（源泉・手数料・一部入金・分割払いなど）は「未確定」として差引に入れていません（入金の税抜の出し方は U-5 で未決）。';

const LABELS = Object.freeze({
  accrual: {revenue: '売上報告額（税抜）', cost: '登録経費（税抜）', profit: '差引（税抜）', month: '会計の計上月', detail: '会計計上明細',
    pick: 'グラフまたは数値表から会計の計上月を選択してください。', caution: INCOME_CAUTION, empty: 'この作品には月別の売上報告・経費が未登録です。登録すると、会計の計上月ごとに表示します。'},
  cash: {revenue: '入金（税抜）', cost: '出金（税抜）', profit: '差引（税抜）', month: '入金日・出金日の月', detail: '入金の明細',
    pick: 'グラフまたは数値表から月を選択してください。', caution: CASH_INCOME_CAUTION, empty: 'この作品には、税抜にできた入金・出金がありません（未確定の入出金は下に出します）。'},
});

export function incomeLabels(basis = DEFAULT_BASIS) {
  const key = basis === 'cash' ? 'cash' : 'accrual';
  return {...LABELS[key], basis: key, heading: `基準: ${BASIS_DESCRIPTIONS[key]}`};
}

const unattachedCount = (unsettled) => (Number.isSafeInteger(unsettled?.unattachedReceiptCount) && unsettled.unattachedReceiptCount > 0 ? unsettled.unattachedReceiptCount : 0);

// 未確定の入出金の説明（画面の注意に出す。額は税込）。作品を決められない入金は額を出さずに件数だけ
export function unsettledSummary(unsettled) {
  if (!unsettled) return '';
  const parts = [];
  if (unsettled.rows?.length) parts.push(`税抜にできない入出金（未確定・税込）: 入金 ${unsettled.inflowYen.toLocaleString('ja-JP')}円・出金 ${unsettled.outflowYen.toLocaleString('ja-JP')}円（${unsettled.rows.length}件）。差引に入れていません。`);
  const count = unattachedCount(unsettled);
  if (count) parts.push(`請求明細の作品の配賦がそろわない入金が${count}件あり、作品を決められないため、ここに入れていません（会社PLの「未確定」に出ます）。`);
  return parts.join('');
}

// 作品収支の合計の欄（入金・出金・差引）の出し方。月の行があれば額、月の行が無く未確定の入出金（作品を決められない入金を含む）だけがあれば
// 「未確定のみ」、どちらも無ければ「未登録」（未確定だけの作品を未登録に見せない）。format は円の書式（画面の yen）
export const INCOME_STAT_UNSETTLED_ONLY = '未確定のみ';
export const INCOME_STAT_EMPTY = '未登録';
export function incomeStatText(overview, amount, format) {
  if (overview?.monthly?.length) return format(amount);
  return overview?.unsettled?.rows?.length || unattachedCount(overview?.unsettled) ? INCOME_STAT_UNSETTLED_ONLY : INCOME_STAT_EMPTY;
}
