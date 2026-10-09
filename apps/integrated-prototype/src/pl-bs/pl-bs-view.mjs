// PL・BS の画面・Excel の表の定義（React に依存しない純関数。node で試験する）。
// 画面の表と Excel のシートは同じ列定義から作るので、数字は同じになる。未確定の額は空欄（「未確認」）のまま出し、0円にしない。
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {monthLabel, ORIGIN_LABELS, SECTION_LABELS, PL_BS_HEADING, MANUAL_STATUS_LABELS} from '../reports/pl-bs-model.mjs';

export const VIEWS = Object.freeze([
  {id: 'work-pl', label: '作品別PL'},
  {id: 'work-balances', label: '作品別の残高'},
  {id: 'company-pl', label: '会社PL'},
  {id: 'company-bs', label: '会社BS'},
  {id: 'manual', label: '手入力'},
  {id: 'settings', label: '会社の設定'},
]);
export const SHEET_NAMES = Object.freeze({'work-pl': ['作品別PL', '作品別PLの月別', '照合'], 'work-balances': ['作品別の残高'], 'company-pl': ['会社PL', '照合'], 'company-bs': ['会社BS', '差額の手がかり', '参考']});

const originColumn = {key: 'originLabel', label: '由来', type: 'text', value: (row) => row.originLabel || ORIGIN_LABELS[row.origin] || ''};
const indent = (row) => `${'　'.repeat(Math.max(0, (row.level || 0) - 1))}${row.label}`;

// ---------- 作品別PL ----------
export const WORK_PL_COLUMNS = Object.freeze([
  {key: 'code', label: '作品コード', type: 'code', sticky: true},
  {key: 'title', label: '作品', type: 'text', sticky: true},
  {key: 'kindLabel', label: '区分', type: 'text'},
  {key: 'sales', label: '売上（自社作品）', type: 'yen', group: '期間', value: (row) => row.period.sales},
  {key: 'acq', label: '委員会の自社の取得額', type: 'yen', group: '期間', value: (row) => row.period.acq},
  {key: 'royalty', label: 'ロイヤリティ', type: 'yen', group: '期間', value: (row) => row.period.royalty},
  {key: 'direct', label: '直接費', type: 'yen', group: '期間', value: (row) => row.period.direct},
  {key: 'production', label: '制作費（公開月に一括）', type: 'yen', group: '期間', value: (row) => row.period.production},
  {key: 'promotion', label: '広告宣伝費', type: 'yen', group: '期間', value: (row) => row.period.promotion},
  {key: 'workOther', label: 'その他の経費', type: 'yen', group: '期間', value: (row) => row.period.workOther},
  {key: 'additionalExpense', label: '追加科目・費用区分未整備の経費', type: 'yen', group: '期間', value: (row) => row.period.additionalExpense},
  {key: 'manualNet', label: '手入力（収益−費用）', type: 'yen', group: '期間', value: (row) => row.period.manualIncome - row.period.manualCost},
  {key: 'profit', label: '作品の利益', type: 'yen', group: '期間', value: (row) => row.period.profit},
  {key: 'cumulativeRevenue', label: '売上高の累計', type: 'yen', group: '累計', value: (row) => row.cumulative.revenue},
  {key: 'cumulativeProfit', label: '作品の利益の累計', type: 'yen', group: '累計', value: (row) => row.cumulative.profit},
  {key: 'releaseMonth', label: '公開月', type: 'month', value: (row) => row.releaseMonth || null},
  originColumn,
  {key: 'reasons', label: '未確定の理由', type: 'text', wrap: true, value: (row) => (row.reasons || []).join('／')},
]);

// 作品の月別（行＝項目、列＝月・期間計・累計）
export function detailColumns(detail) {
  return [
    {key: 'label', label: '項目', type: 'text', sticky: true, sortable: false, width: 30, value: indent},
    ...(detail?.columns || []).map((column) => ({key: column.key, label: column.label, type: 'yen', total: 'none', sortable: false, value: (row) => row.values?.[column.key] ?? null})),
  ];
}

// ---------- 作品別の残高 ----------
export const WORK_BALANCE_COLUMNS = Object.freeze([
  {key: 'code', label: '作品コード', type: 'code', sticky: true},
  {key: 'title', label: '作品', type: 'text', sticky: true},
  {key: 'kindLabel', label: '区分', type: 'text'},
  {key: 'receivable', label: '売掛金', type: 'yen', group: '資産'},
  {key: 'wip', label: '制作中の作品', type: 'yen', group: '資産'},
  {key: 'investmentPaid', label: '委員会への出資金（払込済み）', type: 'yen', group: '資産'},
  {key: 'committeeReceivable', label: '委員会からの未収', type: 'yen', group: '資産'},
  {key: 'expensePayable', label: '未払の経費', type: 'yen', group: '負債'},
  {key: 'expenseUnreadyPayable', label: '締め日未整備分（参考の未払残高）', type: 'yen', group: '参考'},
  {key: 'royaltyPayable', label: '未払ロイヤリティ', type: 'yen', group: '負債'},
  {key: 'committeeDeposit', label: '委員会の預り金', type: 'yen', group: '負債'},
  {key: 'net', label: '作品の純額（資産−負債）', type: 'yen'},
  {key: 'investmentCommitted', label: '出資額（約定）', type: 'yen', group: '委員会'},
  {key: 'cumulativeAcquisition', label: '累計取得額', type: 'yen', group: '委員会'},
  {key: 'recoveryRate', label: '回収率（累計取得額÷出資額）', type: 'rate', total: 'none', group: '委員会'},
  {key: 'investmentUnpaid', label: '出資の未払込', type: 'yen', group: '参考（合計に入れない）'},
  {key: 'committeeUnpaidExpense', label: '委員会の経費の未払', type: 'yen', group: '参考（合計に入れない）'},
  {key: 'mgIncomingUnconsumed', label: '受取MGの未消化', type: 'yen', group: '参考（合計に入れない）'},
  {key: 'mgOutgoingUnrecouped', label: '支払MGの未回収', type: 'yen', group: '参考（合計に入れない）'},
  {key: 'royaltyAdvanceUnrecouped', label: 'ロイヤリティの前払金の未充当残', type: 'yen', group: '参考（合計に入れない）'},
  originColumn,
  {key: 'reasons', label: '未確定の理由', type: 'text', wrap: true, value: (row) => (row.reasons || []).join('／')},
]);

// ---------- 会社PL（行＝科目、列＝月・期間計） ----------
export function companyPlColumns(companyPl) {
  return [
    {key: 'accountCode', label: '科目コード', type: 'code', sticky: true, sortable: false, value: (row) => row.accountCode || ''},
    {key: 'label', label: '科目', type: 'text', sticky: true, sortable: false, width: 30, value: indent},
    ...(companyPl?.columns || []).map((column) => ({key: column.key, label: column.label, type: 'yen', total: 'none', sortable: false, value: (row) => row.values?.[column.key] ?? null})),
    {...originColumn, sortable: false},
  ];
}

// ---------- 会社BS ----------
export const COMPANY_BS_COLUMNS = Object.freeze([
  {key: 'accountCode', label: '科目コード', type: 'code', sticky: true, sortable: false, value: (row) => row.accountCode || ''},
  {key: 'label', label: '科目', type: 'text', sticky: true, sortable: false, width: 34, value: indent},
  {key: 'opening', label: '期首残高', type: 'yen', total: 'none', sortable: false},
  {key: 'value', label: '基準月末', type: 'yen', total: 'none', sortable: false},
  {key: 'change', label: '増減', type: 'yen', total: 'none', sortable: false, value: (row) => (row.value === null || row.value === undefined || row.opening === null || row.opening === undefined ? null : row.value - row.opening)},
  {...originColumn, sortable: false},
  {key: 'note', label: '計算', type: 'text', wrap: true, sortable: false, value: (row) => row.note || ''},
]);
export const HINT_COLUMNS = Object.freeze([
  {key: 'label', label: '手がかり', type: 'text', sticky: true, width: 50},
  {key: 'value', label: '額', type: 'yen', total: 'none'},
]);
export const REFERENCE_COLUMNS = Object.freeze([
  {key: 'label', label: '参考（BSの合計に入れない）', type: 'text', sticky: true, width: 44},
  {key: 'value', label: '額', type: 'yen', total: 'none'},
  originColumn,
  {key: 'note', label: '理由', type: 'text', wrap: true},
]);
// 経費の費目の区分（費用区分と勘定科目の対応による）
export const EXPENSE_CLASS_COLUMNS = Object.freeze([
  {key: 'category', label: '費目', type: 'text', sticky: true},
  {key: 'label', label: 'PLでの扱い', type: 'text'},
  {key: 'count', label: '件数', type: 'number'},
  {key: 'exTax', label: '税抜の額（期間）', type: 'yen'},
]);
export const CHECK_COLUMNS = Object.freeze([
  {key: 'item', label: '照合', type: 'text', sticky: true, width: 60},
  {key: 'value', label: '差', type: 'yen', total: 'none'},
  {key: 'detail', label: '結果', type: 'text'},
]);

// BS の行の見た目の区分（合計・差額の行は太字）
export const isEmphasis = (row) => Boolean(row?.emphasis);

// ---------- 手入力（勘定科目×月の表） ----------
// rows: /api/pl-bs/manual の rows（取消を含む履歴）。取り消されていない行だけを科目×月で足す
export function manualMatrix(rows = [], months = []) {
  const live = rows.filter((row) => row.live);
  const accounts = new Map();
  for (const row of live) {
    const key = `${row.accountId}:${row.kind}`;
    if (!accounts.has(key)) accounts.set(key, {key, accountId: row.accountId, accountCode: row.accountCode, accountName: row.accountName, section: row.section, kind: row.kind, values: {}, unverified: false, count: 0});
    const entry = accounts.get(key);
    entry.values[row.month] = (entry.values[row.month] || 0) + row.amountYen;
    entry.count += 1;
    if (row.status !== 'reviewed') entry.unverified = true;
  }
  const list = [...accounts.values()].sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
  return list.map((entry) => ({...entry, kindLabel: entry.kind === 'balance' ? '月末の残高' : '発生額', sectionLabel: SECTION_LABELS[entry.section] || entry.section,
    total: entry.kind === 'flow' ? months.reduce((n, month) => n + (entry.values[month] || 0), 0) : null}));
}
export function manualMatrixColumns(months = []) {
  return [
    {key: 'accountCode', label: '科目コード', type: 'code', sticky: true},
    {key: 'accountName', label: '科目', type: 'text', sticky: true},
    {key: 'kindLabel', label: '種類', type: 'text'},
    ...months.map((month) => ({key: `m:${month}`, label: monthLabel(month), type: 'yen', total: 'none', value: (row) => row.values[month] ?? null})),
    {key: 'total', label: '期間計（発生額）', type: 'yen', total: 'none'},
    {key: 'unverified', label: '状態', type: 'text', value: (row) => (row.unverified ? '未確認を含む' : '確認済み')},
  ];
}
export const MANUAL_HISTORY_COLUMNS = Object.freeze([
  {key: 'month', label: '月', type: 'month', sticky: true},
  {key: 'accountCode', label: '科目コード', type: 'code'},
  {key: 'accountName', label: '科目', type: 'text'},
  {key: 'kind', label: '種類', type: 'text', value: (row) => (row.kind === 'balance' ? '月末の残高' : '発生額')},
  {key: 'amountYen', label: '金額（発生額は税抜）', type: 'yen', total: 'none'},
  {key: 'taxYen', label: '消費税額', type: 'yen', total: 'none', value: (row) => (row.kind === 'flow' ? row.taxYen ?? 0 : null)},
  {key: 'work', label: '作品', type: 'text', value: (row) => (row.workCode ? `${row.workCode}｜${row.workTitle}` : '')},
  {key: 'basis', label: '根拠', type: 'text', wrap: true},
  {key: 'status', label: '状態', type: 'text', value: (row) => MANUAL_STATUS_LABELS[row.status] || row.status},
  {key: 'state', label: '取消', type: 'text', value: (row) => (row.reversesId ? `取消の行（${row.reversesId}の取消）` : row.reversedById ? '取り消し済み' : '')},
  {key: 'createdByName', label: '入れた人', type: 'text', hidden: true},
  {key: 'createdAt', label: '入れた日時', type: 'text', hidden: true},
]);

// ---------- Excel ----------
const conditionsOf = (body) => {
  const c = body?.conditions || {};
  const list = [['基準', PL_BS_HEADING], ['期間', `${monthLabel(c.from)}〜${monthLabel(c.to)}`], ['BSの基準月', `${monthLabel(c.asOf)}末`]];
  list.push(['年度', `期首${c.fiscalStartMonth}月${c.fiscalConfirmed ? '' : '（決算月の解釈は未確定）'}`]);
  list.push(['期首残高の基準月', c.openingMonth ? `${monthLabel(c.openingMonth)}末` : '未設定']);
  if (body?.profile?.legalName) list.push(['会社', body.profile.legalName]);
  return list;
};

// view: 'work-pl' | 'work-balances' | 'company-pl' | 'company-bs'。画面の表と同じ列・同じ行
export function plBsSheets(body, view, {title, workId = null} = {}) {
  const conditions = conditionsOf(body);
  const dataAsOf = body?.dataAsOf?.latestImportAt || null;
  const notes = [...(body?.headingNotes || []), ...(body?.notes || [])];
  const spec = (name, sheetTitle, extra = []) => ({name, sheetName: name, title: sheetTitle, conditions, dataAsOf, notes: [...notes, ...extra]});
  const name = title || PL_BS_HEADING;
  if (view === 'work-pl') {
    const sheets = [gridSheetSpec({columns: WORK_PL_COLUMNS, rows: body.workPl, exportSpec: spec(SHEET_NAMES['work-pl'][0], `${name} 作品別PL`,
      ['委員会作品は自社の取り分（委員会の月次収支の自社の取得額）だけ。委員会の経費・権利処理費は自社の費用にしていません。'])})];
    const target = workId ? body.workPl.find((row) => String(row.workId) === String(workId)) : null;
    const detail = target ? body.workDetail?.[target.workId] : null;
    if (detail) sheets.push(gridSheetSpec({columns: detailColumns(detail), rows: detail.rows, showTotals: false, exportSpec: spec(SHEET_NAMES['work-pl'][1], `${name} ${target.code} ${target.title} の月別`)}));
    sheets.push(gridSheetSpec({columns: CHECK_COLUMNS, rows: body.checks || [], showTotals: false, exportSpec: spec(SHEET_NAMES['work-pl'][2], `${name} 照合`)}));
    return sheets;
  }
  // BS の基準月が期首残高の基準月より前のときは、残高の表の代わりに理由だけのシートを出す（誤った残高を Excel に出さない）
  const unavailableSheet = (sheetName) => gridSheetSpec({columns: [{key: 'reason', label: '出していない理由', type: 'text', width: 90}], rows: [{reason: body.bsUnavailable || body.companyBs?.reason}], showTotals: false,
    exportSpec: spec(sheetName, `${name} ${sheetName}`)});
  if (view === 'work-balances') {
    if (body.bsUnavailable) return [unavailableSheet(SHEET_NAMES['work-balances'][0])];
    return [gridSheetSpec({columns: WORK_BALANCE_COLUMNS, rows: body.workBalances, exportSpec: spec(SHEET_NAMES['work-balances'][0], `${name} 作品別の残高（${monthLabel(body.conditions.asOf)}末）`,
      ['作品の純額は資産−負債で、会社の純資産とは結び付けていません（回収の見通しを見る管理の指標）。参考の列はBSの合計に入れていません。'])})];
  }
  if (view === 'company-pl') {
    if (!body.companyPl) throw new Error('会社PLを見る権限がありません');
    return [
      gridSheetSpec({columns: companyPlColumns(body.companyPl), rows: body.companyPl.rows, showTotals: false, exportSpec: spec(SHEET_NAMES['company-pl'][0], `${name} 会社PL`)}),
      gridSheetSpec({columns: CHECK_COLUMNS, rows: body.checks || [], showTotals: false, exportSpec: spec(SHEET_NAMES['company-pl'][1], `${name} 照合`)}),
    ];
  }
  if (view === 'company-bs') {
    if (!body.companyBs) throw new Error('会社BSを見る権限がありません');
    if (body.companyBs.unavailable) return [unavailableSheet(SHEET_NAMES['company-bs'][0])];
    return [
      gridSheetSpec({columns: COMPANY_BS_COLUMNS, rows: body.companyBs.rows, showTotals: false, exportSpec: spec(SHEET_NAMES['company-bs'][0], `${name} 会社BS（${monthLabel(body.companyBs.asOf)}末）`,
        ['最後の「説明のつかない差額」は、資産−負債−純資産です。複式の仕訳を持たない試算のため、0になるとは限りません。'])}),
      gridSheetSpec({columns: HINT_COLUMNS, rows: body.companyBs.hints, showTotals: false, exportSpec: spec(SHEET_NAMES['company-bs'][1], `${name} 差額の手がかり`)}),
      gridSheetSpec({columns: REFERENCE_COLUMNS, rows: body.companyBs.reference, showTotals: false, exportSpec: spec(SHEET_NAMES['company-bs'][2], `${name} 参考（BSの合計に入れない）`)}),
    ];
  }
  throw new Error(`出力できない表です: ${view}`);
}

// 表示してよい応答か（条件を変えて読み込み中の間は前の条件の数字を出さない）
export function currentBody(state, conditions) {
  const body = state?.body;
  if (!body?.conditions || !conditions) return null;
  const c = body.conditions;
  return c.from === conditions.from && c.to === conditions.to && c.asOf === conditions.asOf ? body : null;
}
