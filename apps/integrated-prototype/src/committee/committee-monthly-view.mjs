// 製作委員会の月次収支の画面・Excel の表の定義（React に依存しない純関数。node で試験する）。
// 月次収支は「行＝項目、列＝月・年度計・期間計・期間前の累計・累計」の表。回収率は率の文字にし、算定できない値は「未確認」のまま（0にしない）。
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {rate as rateText} from '../ui/format.mjs';

export const SHEET_NAMES = Object.freeze(['月次収支', '出資者別', '区分別売上', '権利処理費の内訳', '元明細', '照合']);

// 月次収支の1セルの値。率の行は「12.3%」の文字（出資額0円は「—」、出資額未登録は null＝未確認）。
export function pivotValue(row, columnKey) {
  const value = row?.values?.[columnKey];
  if (row?.unit === 'rate') {
    if (value === null || value === undefined) return row.investmentKnown ? '—' : null;
    return rateText(value, {digits: 1});
  }
  return value ?? null;
}

export function pivotColumns(report) {
  const label = {key: 'label', label: '項目', type: 'text', sticky: true, sortable: false, width: 34,
    value: (row) => `${row.level ? '　' : ''}${row.label}`};
  return [label, ...(report?.columns || []).map((column) => ({
    key: column.key, label: column.label, type: 'yen', total: 'none', sortable: false,
    value: (row) => pivotValue(row, column.key),
  }))];
}

const shareText = (bps) => (bps == null ? null : bps / 10000);

// 出資者別の回収率: 出資額0円は率を出せないので月次収支の表と同じ「—」、出資額の登録が無いときだけ「未確認」（null）。参加者以外も「—」
export function investorRateValue(row) {
  if (row?.recoveryRate !== null && row?.recoveryRate !== undefined) return row.recoveryRate;
  if (row?.member === false) return '—';
  return row?.investmentYen === null || row?.investmentYen === undefined ? null : '—';
}

export const INVESTOR_COLUMNS = Object.freeze([
  {key: 'name', label: '出資者', type: 'text', sticky: true},
  {key: 'shareBps', label: '持分', type: 'rate', total: 'none', digits: 2, value: (row) => (row.member ? shareText(row.shareBps) : '参加者以外')},
  {key: 'roles', label: '役割', type: 'text', value: (row) => [row.isManager ? '幹事' : null, row.windowKinds?.length ? `窓口（${row.windowKindLabels || row.windowKinds.join('、')}）` : null].filter(Boolean).join('・') || '出資のみ'},
  {key: 'investmentYen', label: '出資額', type: 'yen', total: 'sum'},
  {key: 'periodDistribution', label: '分配額（期間）', type: 'yen', value: (row) => row.period.distribution},
  {key: 'periodWindowFee', label: '窓口手数料の取り分（期間）', type: 'yen', value: (row) => row.period.windowFee},
  {key: 'periodManagerFee', label: '幹事手数料（期間）', type: 'yen', value: (row) => row.period.managerFee},
  {key: 'periodAcquisition', label: '取得額（期間）', type: 'yen', value: (row) => row.period.acquisition},
  {key: 'priorAcquisition', label: '期間前の累計取得額', type: 'yen'},
  {key: 'cumulativeAcquisition', label: '累計取得額', type: 'yen', value: (row) => row.cumulative.acquisition},
  {key: 'recoveryRate', label: '回収率（累計取得額÷出資額）', type: 'rate', total: 'none', value: investorRateValue},
  {key: 'profit', label: '利益（累計取得額−出資額）', type: 'yen'},
]);

export const CHANNEL_COLUMNS = Object.freeze([
  {key: 'month', label: '計上月', type: 'month', sticky: true},
  {key: 'channelLabel', label: '流通の区分', type: 'text'},
  {key: 'window', label: '窓口（料率の出どころ）', type: 'text', value: (row) => (row.windowLabel ? `${row.windowKindLabel}｜${row.windowLabel}` : `${row.windowKindLabel}（条件なし）`)},
  {key: 'sales', label: '売上', type: 'yen'},
  {key: 'netReportedSales', label: 'うち控除後の報告', type: 'yen', hidden: true},
  {key: 'platformFee', label: 'PF控除', type: 'yen'},
  {key: 'windowFee', label: '窓口手数料', type: 'yen'},
  {key: 'managerFee', label: '幹事手数料', type: 'yen'},
  {key: 'income', label: '本委員会収入', type: 'yen'},
  {key: 'holdText', label: '保留', type: 'text', wrap: true, value: (row) => row.holdText || ''},
  {key: 'lineCount', label: '明細の行数', type: 'int', total: 'sum', hidden: true},
]);

export const ACCRUAL_COLUMNS = Object.freeze([
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'categoryLabel', label: '種別', type: 'text'},
  {key: 'holderName', label: '権利者', type: 'text', value: (row) => row.holderName || null},
  {key: 'agreement', label: 'ロイヤリティ契約', type: 'text', value: (row) => row.agreementCode || row.agreementTitle || (row.agreementId != null ? `契約${row.agreementId}` : null)},
  {key: 'baseYen', label: '基礎', type: 'yen', total: 'none'},
  {key: 'royaltyYen', label: '権利処理費', type: 'yen'},
  {key: 'holdSalesYen', label: '保留の対象売上', type: 'yen'},
]);

export const SOURCE_COLUMNS = Object.freeze([
  {key: 'kind', label: '区分', type: 'text', sticky: true},
  {key: 'month', label: '計上月', type: 'month'},
  {key: 'item', label: '流通の区分・費目', type: 'text'},
  {key: 'partnerName', label: '取引先・支払先', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true},
  {key: 'reportKey', label: '売上報告', type: 'code'},
  {key: 'basisText', label: '報告額の基準', type: 'text'},
  {key: 'windowLabel', label: '窓口', type: 'text'},
  {key: 'amount', label: '金額（税抜・作品へ配賦後）', type: 'yen'},
  {key: 'holdText', label: '保留', type: 'text', wrap: true},
  {key: 'sourceRow', label: '原本の行', type: 'int', total: 'none', hidden: true},
  {key: 'distributionLabel', label: '流通分類', type: 'text', hidden: true},
]);

export const CHECK_COLUMNS = Object.freeze([
  {key: 'item', label: '照合の項目', type: 'text', wrap: true, width: 60},
  {key: 'value', label: '差（0なら一致）', type: 'yen', total: 'none'},
  {key: 'detail', label: '内容', type: 'text', wrap: true},
]);

export const WINDOW_COLUMNS = Object.freeze([
  {key: 'version', label: '条件版（適用開始月）', type: 'text', sticky: true, value: (row) => versionText(row)},
  {key: 'kindLabel', label: '窓口', type: 'text'},
  {key: 'label', label: '名称', type: 'text'},
  {key: 'windowPartnerName', label: '窓口の受取先', type: 'text'},
  {key: 'platformRateBps', label: 'PF料率', type: 'rate', total: 'none', digits: 2, value: (row) => shareText(row.platformRateBps)},
  {key: 'windowFeeBps', label: '窓口手数料率', type: 'rate', total: 'none', digits: 2, value: (row) => shareText(row.windowFeeBps)},
  {key: 'managerFeeBps', label: '幹事手数料率', type: 'rate', total: 'none', digits: 2, value: (row) => shareText(row.managerFeeBps)},
  {key: 'feeOrder', label: '控除の順', type: 'text', value: (row) => (row.feeOrder === 'manager_first' ? '幹事手数料が先' : '窓口手数料が先')},
  {key: 'shares', label: '窓口手数料の取り分', type: 'text', wrap: true, value: (row) => feeShareText(row)},
]);

export function feeShareText(window) {
  const list = window?.feeShares || [];
  if (!list.length) return window?.feeSharesRegistered ? '登録が不完全（合計が100%ではありません）' : '未確認';
  const text = list.map((share) => `${share.name || `取引先${share.partnerId}`} ${(share.shareBps / 100).toLocaleString('ja-JP', {maximumFractionDigits: 2})}%`).join('、');
  if (window.feeSharesRegistered) return text;
  const dropped = window.feeSharesDroppedFrom ? `。条件版${window.feeSharesDroppedFrom}では複数社で分けていました` : '';
  return `${text}（登録なし＝窓口の受取先が100%${dropped}）`;
}

// 「条件版2（2027年1月から）」「条件版1（最初の月から）」
export function versionText(version) {
  if (!version || version.versionNo == null) return '';
  const from = version.effectiveFrom ? `${monthLabelOf(version.effectiveFrom)}から` : '最初の月から';
  return `条件版${version.versionNo}（${from}）`;
}
const monthLabelOf = (month) => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  return match ? `${match[1]}年${Number(match[2])}月` : String(month ?? '');
};

// 表示・出力してよい帳票の応答。いま選んでいる条件（作品・期間）で集計した応答だけを返し、条件を変えて読み込み中の間は null
// （前の作品・期間の数字を新しい条件の名前で出さないため）。state: {body, loading}、conditions: {workId, from, to}
export function currentReportBody(state, conditions) {
  const body = state?.body;
  if (!body?.report || !body.conditions || !conditions) return null;
  const same = String(body.conditions.workId) === String(conditions.workId) && body.conditions.from === conditions.from && body.conditions.to === conditions.to;
  return same ? body : null;
}

// 画面と Excel の注意（保留・未登録）の文。report・body から作る（CommitteeMonthlyPage と committeeMonthlySheets が同じ文を使う）
export function royaltyHoldText(report) {
  const summary = report?.holds?.royaltyPeriod;
  if (!summary?.count) return null;
  const parts = [];
  if (summary.unknownCount) parts.push(`算定できない権利処理費が${summary.unknownCount}件あり、権利処理費に含めていません`);
  if (summary.partialCount) parts.push(`一部だけ算定できた権利処理費が${summary.partialCount}件あり、算定できた${yenText(summary.includedYen)}は権利処理費に含め、残りは含めていません`);
  return `期間内（${summary.months.map(monthLabelOf).join('、')}）に${parts.join('。')}。算定できない部分の対象売上${yenText(summary.holdSalesYen)}を「権利処理費の保留」の行に示しています。その月の分配原資は、含めていない分を差し引く前の額です。`;
}
const yenText = (value) => `${Number(value || 0).toLocaleString('ja-JP')}円`;

export function feeSharesDroppedText(report) {
  const list = report?.holds?.feeSharesDropped || [];
  if (!list.length) return null;
  const items = list.map((row) => `条件版${row.versionNo}の${row.kindLabel}「${row.label}」（条件版${row.fromVersionNo}では複数社で分けていました）`).join('、');
  return `窓口手数料の取り分が未登録の窓口があります: ${items}。未登録の窓口は、窓口の受取先1社が100%として計算しています。分ける場合は、その版の窓口に取り分を登録してください。`;
}

// 元明細: 売上明細と経費を1つの表に（区分の列で見分ける）
export function sourceRows(body) {
  const sales = (body?.lines || []).map((line) => ({
    id: `s:${line.saleId}:${line.allocationBps}`, kind: '売上', month: line.accountingMonth, item: line.channelLabel, partnerName: line.partnerName,
    description: line.description, reportKey: line.reportKey, basisText: `${line.basisText}（${line.basisSourceText}）`, windowLabel: line.windowLabel,
    amount: line.amount, holdText: line.holdText || '', sourceRow: line.sourceRow, distributionLabel: line.distributionLabel,
  }));
  const expenses = (body?.expenseLines || []).map((row) => ({
    id: `e:${row.id}`, kind: '経費', month: row.month, item: row.category, partnerName: row.partnerName, description: row.description,
    reportKey: null, basisText: '', windowLabel: '', amount: row.amount, holdText: '', sourceRow: null, distributionLabel: '',
  }));
  return [...sales, ...expenses];
}

export function investorRows(report) {
  return (report?.investors || []).map((row) => ({
    ...row, priorAcquisition: row.priorAcquisition, cumulativeAcquisition: row.cumulative.acquisition,
    windowKindLabels: (report.windows || []).filter((window) => row.windowKinds.includes(window.kind)).map((window) => window.kindLabel).join('、'),
  }));
}

// Excel の6シート（月次収支／出資者別／区分別売上／権利処理費の内訳／元明細／照合）
export function committeeMonthlySheets(body, {title, conditions = [], dataAsOf} = {}) {
  const report = body.report;
  const spec = (name, sheetTitle, notes = []) => ({name, title: sheetTitle, conditions, dataAsOf, notes});
  const holdsNote = [];
  if (body.royalty && !body.royalty.agreementCount && body.royalty.note && !(body.notes || []).includes(body.royalty.note)) holdsNote.push(body.royalty.note);
  if (report.holds.windowMissing.length) holdsNote.push(`窓口の条件が無い区分の売上（${report.holds.windowMissing.map((row) => row.label).join('、')}）は保留として収入にしていません。`);
  const royaltyHold = royaltyHoldText(report);
  if (royaltyHold) holdsNote.push(royaltyHold);
  const dropped = feeSharesDroppedText(report);
  if (dropped) holdsNote.push(dropped);
  if (report.holds.defaultBasisReports) holdsNote.push(`報告額の基準が決まっていない売上報告${report.holds.defaultBasisReports}件は、控除前として計算しています（元明細の「報告額の基準」）。`);
  return [
    gridSheetSpec({columns: pivotColumns(report), rows: report.rows, showTotals: false,
      exportSpec: spec(SHEET_NAMES[0], title, [...(body.notes || []), ...holdsNote])}),
    gridSheetSpec({columns: INVESTOR_COLUMNS, rows: investorRows(report), exportSpec: spec(SHEET_NAMES[1], `${title} 出資者別`,
      ['取得額＝分配額＋窓口手数料の取り分＋幹事手数料。回収率＝累計取得額÷出資額（出資額の登録が無い出資者は未確認）。'])}),
    gridSheetSpec({columns: CHANNEL_COLUMNS.map((column) => ({...column, hidden: false})), rows: body.incomeRows || [],
      exportSpec: spec(SHEET_NAMES[2], `${title} 区分別売上`, ['PF控除・手数料は、計上月×流通の区分ごとに窓口の料率で計算し、1円未満を切り捨てています。'])}),
    gridSheetSpec({columns: ACCRUAL_COLUMNS, rows: body.accruals || [], exportSpec: spec(SHEET_NAMES[3], `${title} 権利処理費の内訳`,
      ['ロイヤリティの発生額（計上月）です。算定できない分は権利処理費に含めず、対象売上を「保留の対象売上」に残しています。'])}),
    gridSheetSpec({columns: SOURCE_COLUMNS.map((column) => ({...column, hidden: false})), rows: sourceRows(body), showTotals: false,
      exportSpec: spec(SHEET_NAMES[4], `${title} 元明細（売上明細と経費）`)}),
    gridSheetSpec({columns: CHECK_COLUMNS, rows: report.checks, showTotals: false, exportSpec: spec(SHEET_NAMES[5], `${title} 照合`, holdsNote)}),
  ];
}

// ---- 窓口手数料の取り分の入力 ----

// 「50」「33.33」「50%」「５０」→ bp（整数）。小数は2桁まで。
export function parsePercentToBps(text) {
  const raw = String(text ?? '').normalize('NFKC').replace(/[%％\s]/g, '');
  if (!raw) return {ok: true, bps: null};
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return {ok: false, message: '0.01〜100の数で、小数は2桁までにしてください'};
  const [whole, fraction = ''] = raw.split('.');
  const bps = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (bps < 1 || bps > 10000) return {ok: false, message: '0.01〜100の数にしてください'};
  return {ok: true, bps};
}

// 入力欄（参加者ごとの%）→ 検査結果と送る内容
export function feeShareDraftState(candidates = [], inputs = {}, reason = '') {
  const errors = [];
  const shares = [];
  let total = 0;
  for (const candidate of candidates) {
    const parsed = parsePercentToBps(inputs[candidate.partnerId]);
    if (!parsed.ok) { errors.push(`${candidate.name}: ${parsed.message}`); continue; }
    if (parsed.bps == null) continue;
    total += parsed.bps;
    shares.push({partnerId: candidate.partnerId, shareBps: parsed.bps});
  }
  if (!shares.length) errors.push('取り分を1社以上入れてください');
  else if (total !== 10000) errors.push(`取り分の合計を100%にしてください（いまは${(total / 100).toLocaleString('ja-JP', {maximumFractionDigits: 2})}%）`);
  if (!String(reason).trim()) errors.push('登録の理由（契約書の条項など）を入れてください');
  const dirty = Object.values(inputs).some((value) => String(value ?? '').trim() !== '') || String(reason).trim() !== '';
  return {ok: errors.length === 0, errors, shares, totalBps: total, dirty, payload: {shares, reason: String(reason).trim()}};
}
