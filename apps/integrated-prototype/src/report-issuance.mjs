// 帳票の発行記録の純関数（画面・サーバー・試験で共通）。DB に触らず、node:* も import しない。
// ・条件の正規化（同じ条件なら同じハッシュになるよう、キーと型をそろえる）
// ・主要な数字（見出しの金額）と、発行時と現在の比較（「発行後に元データが変わりました（差額n円）」）
// ・発行済みの版を Excel で出し直すためのシート定義（発行時に保存した本体だけから作る。いまの DB は読まない）
import {gridSheetSpec} from './ui/grid-model.mjs';
import {int, yen, rate, month as monthText, dateJst, dateTimeJst} from './ui/format.mjs';
import {partyRows, detailRows, ledgerRows, reconcile} from './reports/mg-sales-model.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const ISSUANCE_KINDS = Object.freeze({
  royalty: Object.freeze({label: '配給委託の精算報告書', recipientLabel: '権利元', recipientType: 'partner'}),
  'mg-sales': Object.freeze({label: 'MG売上報告（台帳ベース）', recipientLabel: '取引先', recipientType: 'partner'}),
});

export const DIRECTION_LABELS = Object.freeze({incoming: '受取MG（販売先）', outgoing: '支払MG（仕入先）'});

export function isIssuanceKind(kind) {
  return Object.hasOwn(ISSUANCE_KINDS, String(kind ?? ''));
}

function positiveId(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

const failure = (error, status = 400) => ({ok: false, error, status});

// 画面・API から来た条件を、帳票ごとの決まった形にする。{ok:true, conditions} か {ok:false, error, status}。
// 発行は宛先が1者に決まる条件でだけ記録する（ロイヤリティは権利元、MGは取引先が必須）。
export function normalizeConditions(kind, raw = {}) {
  if (!isIssuanceKind(kind)) return failure('発行を記録できる帳票ではありません');
  const source = raw || {};
  if (kind === 'royalty') {
    const from = String(source.from ?? '');
    const to = String(source.to ?? '');
    if (!MONTH.test(from) || !MONTH.test(to)) return failure('期間（開始月・終了月）を「2026-05」の形で指定してください');
    if (from > to) return failure('期間の開始月が終了月より後になっています');
    const holderId = positiveId(source.holderId);
    if (holderId === null) return failure('発行を記録するには、権利元を1者選んでください');
    if (holderId === undefined) return failure('権利元の指定を読み取れません');
    const workId = positiveId(source.workId);
    if (workId === undefined) return failure('作品の指定を読み取れません');
    return {ok: true, conditions: {from, to, holderId, workId: workId ?? null}};
  }
  const direction = source.direction === 'outgoing' ? 'outgoing' : source.direction === 'incoming' || source.direction == null || source.direction === '' ? 'incoming' : null;
  if (!direction) return failure('受取MGか支払MGを選んでください');
  const month = String(source.month ?? '');
  if (!MONTH.test(month)) return failure('基準月を「2026-09」の形で指定してください');
  const partyId = positiveId(source.partyId);
  if (partyId === null) return failure('発行を記録するには、取引先を1社選んでください');
  if (partyId === undefined) return failure('取引先の指定を読み取れません');
  return {ok: true, conditions: {direction, month, partyId}};
}

// 条件 → 問い合わせ文字列（kind を含む）。
export function conditionsQuery(kind, conditions = {}) {
  const params = new URLSearchParams({kind});
  for (const [key, value] of Object.entries(conditions)) if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  return params.toString();
}

// 宛先の種類。支払MGの相手は仕入先（mg_suppliers）。
export function recipientTypeOf(kind, conditions) {
  return kind === 'mg-sales' && conditions?.direction === 'outgoing' ? 'supplier' : 'partner';
}

// 帳票の主要な数字。primary が見出しの金額（発行時との差額はこの値で示す）。
export function keyFigures(kind, body) {
  if (!body) return [];
  if (kind === 'royalty') {
    const t = body.totals || {};
    return [
      {key: 'current', label: '当期の権利元額', value: t.current ?? 0, unit: 'yen', primary: true},
      {key: 'cumulative', label: '累計の権利元額', value: t.cumulative ?? 0, unit: 'yen'},
      {key: 'paid', label: '累計の支払', value: t.paid ?? 0, unit: 'yen'},
      {key: 'unpaid', label: '未払残', value: t.unpaid ?? 0, unit: 'yen'},
      {key: 'advance', label: 'MG前払（充当未確認）', value: t.advance ?? 0, unit: 'yen'},
      {key: 'holdReported', label: '保留（HOLD）の対象売上', value: t.holdReported ?? 0, unit: 'yen'},
      {key: 'holdCount', label: '保留（HOLD）の件数', value: t.holdCount ?? 0, unit: 'count'},
    ];
  }
  const t = body.totals || {};
  return [
    {key: 'cumulativeApplied', label: '累計の実充当', value: t.cumulative?.appliedYen ?? 0, unit: 'yen', primary: true},
    {key: 'currentApplied', label: '当月の実充当', value: t.current?.appliedYen ?? 0, unit: 'yen'},
    {key: 'remaining', label: '未消化残高', value: t.remainingAppliedYen ?? 0, unit: 'yen'},
    {key: 'cumulativeRecognized', label: '累計の計上', value: t.cumulative?.recognizedYen ?? 0, unit: 'yen'},
    {key: 'guarantee', label: 'MG保証額（契約ごとに1回）', value: t.guaranteeYen ?? 0, unit: 'yen'},
    {key: 'contracts', label: '契約数', value: t.contractCount ?? (body.contracts || []).length, unit: 'count'},
  ];
}

export function headlineYen(kind, body) {
  return keyFigures(kind, body).find((figure) => figure.primary)?.value ?? 0;
}

export function figureText(figure) {
  if (!figure) return '';
  return figure.unit === 'count' ? `${int(figure.value)}件` : yen(figure.value);
}

const signedInt = (n) => `${n > 0 ? '+' : ''}${int(n)}`;

// 発行時の本体と現在の本体を比べる。ハッシュが同じなら変化なし。
export function compareIssued({issuedHash, issuedFigures = [], currentHash, currentFigures = []}) {
  if (!currentHash) return {available: false, changed: null, diffs: [], primaryDiff: null};
  const current = new Map(currentFigures.map((figure) => [figure.key, figure]));
  const diffs = issuedFigures.map((figure) => {
    const now = current.get(figure.key);
    const value = now ? now.value : null;
    return {key: figure.key, label: figure.label, unit: figure.unit, primary: Boolean(figure.primary), issued: figure.value, current: value, diff: value === null ? null : value - figure.value};
  });
  const primary = diffs.find((d) => d.primary);
  return {available: true, changed: issuedHash !== currentHash, diffs, primaryDiff: primary ? primary.diff : null};
}

// 画面に出す1文。変化がなければ null。
export function changeMessage(comparison) {
  if (!comparison?.available || !comparison.changed) return null;
  const moneyDiffs = comparison.diffs.filter((d) => d.unit === 'yen' && d.diff !== null && d.diff !== 0);
  const lead = comparison.diffs.find((d) => d.primary && d.diff) || moneyDiffs[0];
  if (!lead) return '発行後に元データが変わりました（差額0円。金額の合計は同じで、明細の内容が変わっています）';
  const unit = lead.unit === 'count' ? '件' : '円';
  return `発行後に元データが変わりました（差額${signedInt(lead.diff)}${unit}・${lead.label}）`;
}

// 変化の内訳（発行時→現在）。差のある項目だけ。
export function changeDetails(comparison) {
  if (!comparison?.available) return [];
  return comparison.diffs.filter((d) => d.diff !== null && d.diff !== 0).map((d) => {
    const fmt = (v) => (d.unit === 'count' ? `${int(v)}件` : yen(v));
    return `${d.label}: 発行時 ${fmt(d.issued)} → 現在 ${fmt(d.current)}（${signedInt(d.diff)}${d.unit === 'count' ? '件' : '円'}）`;
  });
}

export function issuanceStatus(issuance) {
  return issuance?.void
    ? {code: 'voided', label: '取消済', tone: 'warn'}
    : {code: 'active', label: '発行済', tone: 'ok'};
}

export function periodText(kind, conditions = {}) {
  if (kind === 'royalty') return conditions.from === conditions.to ? monthText(conditions.from) : `${monthText(conditions.from)}〜${monthText(conditions.to)}`;
  return `基準月 ${monthText(conditions.month)}・${DIRECTION_LABELS[conditions.direction] || ''}`;
}

export function issuanceTitle(issuance) {
  const kind = ISSUANCE_KINDS[issuance.kind];
  return `${kind?.label || '帳票'}（${issuance.recipient?.name || '宛先未確認'} 様）第${issuance.versionNo}版`;
}

// 発行を押す前の確認（2段目）に出す要約。
export function issueSummaryRows(kind, {conditions, recipientName, figures = [], note} = {}) {
  const def = ISSUANCE_KINDS[kind];
  const rows = [
    ['帳票', def?.label || ''],
    ['宛先', recipientName ? `${recipientName} 様` : '未確認'],
    [kind === 'royalty' ? '対象期間' : '基準', periodText(kind, conditions)],
  ];
  for (const figure of figures) rows.push([figure.label, figureText(figure)]);
  if (note) rows.push(['メモ', note]);
  rows.push(['記録されるもの', 'サーバーがこの条件で帳票を作り直した内容と、その識別（ハッシュ）。送付は人が行います']);
  return rows;
}

// 発行ボタンを出せるか。理由は画面にそのまま出す。
export function canIssue({readOnly = false, conditionsResult, active, blocked, loading} = {}) {
  if (readOnly) return {allowed: false, reason: 'プレビューでは発行を記録できません'};
  if (conditionsResult && !conditionsResult.ok) return {allowed: false, reason: conditionsResult.error};
  if (loading) return {allowed: false, reason: '読み込み中です'};
  if (blocked) return {allowed: false, reason: blocked};
  if (active) return {allowed: false, reason: `この条件の帳票は第${active.versionNo}版として発行済みです。内容を改めるときは、取り消してから再発行します`};
  return {allowed: true, reason: null};
}

// 取消の理由の検査（画面とサーバーで同じ規則）。
export function voidReasonError(reason) {
  const text = String(reason ?? '').trim();
  if (!text) return '取消の理由を入力してください';
  if (text.length > 1000) return '取消の理由は1000文字以内で入力してください';
  return null;
}

// ---- 発行版の Excel（発行時に保存した本体だけから作る） ----

const ROYALTY_CONTRACT_COLUMNS = [
  {key: 'contractCode', label: '契約', type: 'code', sticky: true},
  {key: 'title', label: '契約名', type: 'text'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'reportedCurrent', label: '当期の対象売上', type: 'yen', total: 'sum', value: (r) => r.current?.reported},
  {key: 'deductionCurrent', label: '当期のPF控除', type: 'yen', total: 'sum', value: (r) => r.current?.platformDeduction},
  {key: 'feeCurrent', label: '当期の手数料', type: 'yen', total: 'sum', value: (r) => r.current?.agencyFee},
  {key: 'holderPrior', label: '前回までの権利元額', type: 'yen', total: 'sum', value: (r) => r.prior?.holderAmount},
  {key: 'holderCurrent', label: '当期の権利元額', type: 'yen', total: 'sum', value: (r) => r.current?.holderAmount},
  {key: 'holderCumulative', label: '累計の権利元額', type: 'yen', total: 'sum', value: (r) => r.cumulative?.holderAmount},
  {key: 'paidPrior', label: '前回までの支払', type: 'yen', total: 'sum', value: (r) => r.prior?.paid},
  {key: 'paidCurrent', label: '当期の支払', type: 'yen', total: 'sum', value: (r) => r.current?.paid},
  {key: 'paidCumulative', label: '累計の支払', type: 'yen', total: 'sum', value: (r) => r.cumulative?.paid},
  {key: 'unpaid', label: '未払残', type: 'yen', total: 'sum'},
  {key: 'advanceCumulative', label: 'MG前払（充当未確認）', type: 'yen', total: 'sum', value: (r) => r.cumulative?.advance},
  {key: 'holdCount', label: '保留件数', type: 'int', total: 'sum', value: (r) => r.cumulative?.holdCount},
];
const ROYALTY_DETAIL_COLUMNS = [
  {key: 'accountingMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'period', label: '区分', type: 'text'},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true},
  {key: 'reportBasis', label: '報告の基準', type: 'text'},
  {key: 'reportedAmount', label: '対象売上', type: 'yen', total: 'sum'},
  {key: 'platformDeduction', label: 'PF控除', type: 'yen', total: 'sum'},
  {key: 'agencyFee', label: '手数料', type: 'yen', total: 'sum'},
  {key: 'holderAmount', label: '権利元額', type: 'yen', total: 'sum'},
  {key: 'status', label: '状態', type: 'text'},
  {key: 'holdReason', label: '保留の理由', type: 'text', wrap: true},
  {key: 'sourceRow', label: '原本の行', type: 'int', total: 'none'},
];
const ROYALTY_PAYMENT_COLUMNS = [
  {key: 'paidOn', label: '支払日', type: 'date', sticky: true},
  {key: 'period', label: '区分', type: 'text'},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'kind', label: '種類', type: 'text'},
  {key: 'amount', label: '金額', type: 'yen', total: 'sum'},
  {key: 'reference', label: '支払の識別番号', type: 'code'},
  {key: 'reason', label: '根拠', type: 'text', wrap: true},
];
const MG_PARTY_COLUMNS = [
  {key: 'partyName', label: '取引先', type: 'text', sticky: true},
  {key: 'contractCount', label: '契約数', type: 'int', total: 'sum'},
  {key: 'guaranteeYen', label: 'MG保証額', type: 'yen', total: 'sum'},
  {key: 'currentApplied', label: '当月の実充当', type: 'yen', total: 'sum'},
  {key: 'cumulativeApplied', label: '累計の実充当', type: 'yen', total: 'sum'},
  {key: 'remainingApplied', label: '未消化残高', type: 'yen', total: 'sum'},
  {key: 'exceedApplied', label: '保証額を超えた充当', type: 'yen', total: 'sum'},
  {key: 'currentRecognized', label: '当月の計上', type: 'yen', total: 'sum'},
  {key: 'cumulativeRecognized', label: '累計の計上', type: 'yen', total: 'sum'},
  {key: 'appliedRate', label: '到達率', type: 'rate', total: 'none', value: (row) => (row.appliedRate == null ? '—' : row.appliedRate)},
];
const MG_DETAIL_COLUMNS = [
  {key: 'partyName', label: '取引先', type: 'text', sticky: true},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'contractTitle', label: '契約名', type: 'text'},
  {key: 'termVersion', label: '条件の版', type: 'int', total: 'none'},
  {key: 'workName', label: '作品', type: 'text'},
  {key: 'productLabel', label: '商品', type: 'text'},
  {key: 'guaranteeYen', label: 'MG保証額（契約）', type: 'yen', total: 'not-summable'},
  {key: 'priorApplied', label: '前月までの実充当', type: 'yen', total: 'sum'},
  {key: 'currentApplied', label: '当月の実充当', type: 'yen', total: 'sum'},
  {key: 'cumulativeApplied', label: '累計の実充当', type: 'yen', total: 'sum'},
  {key: 'remainingApplied', label: '未消化残高（契約）', type: 'yen', total: 'not-summable'},
  {key: 'currentOverage', label: '当月の超過報告', type: 'yen', total: 'sum'},
  {key: 'cumulativeOverage', label: '累計の超過報告', type: 'yen', total: 'sum'},
  {key: 'currentRecognized', label: '当月の計上', type: 'yen', total: 'sum'},
  {key: 'cumulativeRecognized', label: '累計の計上', type: 'yen', total: 'sum'},
  {key: 'reachedMonth', label: '到達月（契約）', type: 'text', total: 'none'},
  {key: 'status', label: '状態（契約）', type: 'text', total: 'none'},
];
const MG_LEDGER_COLUMNS = [
  {key: 'accountingMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'partyName', label: '取引先', type: 'text'},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'productLabel', label: '商品', type: 'text'},
  {key: 'periodFrom', label: '対象期間の開始', type: 'date'},
  {key: 'periodTo', label: '対象期間の終了', type: 'date'},
  {key: 'sourceReference', label: '元資料', type: 'text'},
  {key: 'eligible', label: '消化対象', type: 'yen', total: 'sum'},
  {key: 'applied', label: '実充当', type: 'yen', total: 'sum'},
  {key: 'overage', label: '超過報告', type: 'yen', total: 'sum'},
  {key: 'recognized', label: '計上', type: 'yen', total: 'sum'},
  {key: 'status', label: '確認', type: 'text'},
  {key: 'reverses', label: '訂正', type: 'text'},
];
const KV_COLUMNS = [{key: 'k', label: '項目', type: 'text'}, {key: 'v', label: '内容', type: 'text', wrap: true, width: 80}];

function issuanceRows(issuance) {
  const status = issuanceStatus(issuance);
  const rows = [
    {k: '状態', v: status.label},
    {k: '版', v: `第${issuance.versionNo}版`},
    {k: '発行日', v: dateJst(issuance.issuedOn)},
    {k: '発行を記録した人', v: issuance.issuedByName || '未確認'},
    {k: '記録日時', v: dateTimeJst(issuance.issuedAt)},
  ];
  if (issuance.void) {
    rows.push({k: '取消日時', v: dateTimeJst(issuance.void.voidedAt)}, {k: '取消の理由', v: issuance.void.reason}, {k: '取り消した人', v: issuance.void.voidedByName || '未確認'});
  }
  if (issuance.note) rows.push({k: 'メモ', v: issuance.note});
  rows.push({k: '記録の識別（ハッシュ）', v: issuance.contentHash || ''});
  return rows;
}

// 発行済みの版（GET /api/reports/issuances/:id の issuance）から、Excel・印刷用のシートを作る。
export function issuanceSheets(issuance) {
  const content = issuance?.content;
  if (!content?.body) throw new Error('発行した内容が読み込まれていません');
  const kind = issuance.kind;
  const body = content.body;
  const title = issuanceTitle(issuance);
  const conditions = [['宛先', `${issuance.recipient?.name || '未確認'} 様`], [kind === 'royalty' ? '対象期間' : '基準', periodText(kind, issuance.conditions)],
    ['状態', `${issuanceStatus(issuance).label}（第${issuance.versionNo}版・発行日 ${dateJst(issuance.issuedOn)}）`]];
  const dataAsOf = content.dataAsOf?.latestImportAt || issuance.issuedAt;
  const cover = (extra) => ({name: '表紙', title, conditions, dataAsOf, columns: KV_COLUMNS, rows: [...issuanceRows(issuance), ...extra], freezeCols: 1});
  if (kind === 'royalty') {
    const t = body.totals || {};
    const spec = (name, sheetTitle) => ({name, title: sheetTitle, conditions, dataAsOf});
    return [
      cover([
        {k: '当期の権利元額', v: yen(t.current)}, {k: '累計の権利元額', v: yen(t.cumulative)}, {k: '累計の支払', v: yen(t.paid)}, {k: '未払残', v: yen(t.unpaid)},
        ...(t.advance ? [{k: 'MG前払（充当未確認）', v: `${yen(t.advance)}（未払残と相殺していません）`}] : []),
        {k: '保留（HOLD）', v: `${int(t.holdCount)}件・対象売上 ${yen(t.holdReported)}（権利元額に含めていません）`},
        ...(body.assumptions || []).map((a, i) => ({k: i === 0 ? '前提' : '', v: a})),
      ]),
      gridSheetSpec({columns: ROYALTY_CONTRACT_COLUMNS, rows: body.rows || [], exportSpec: spec('一覧', `${title} 一覧`)}),
      gridSheetSpec({columns: ROYALTY_DETAIL_COLUMNS, rows: body.details || [], exportSpec: spec('明細', `${title} 明細（売上1件×契約1件）`)}),
      gridSheetSpec({columns: ROYALTY_DETAIL_COLUMNS, rows: body.hold || [], exportSpec: spec('保留（HOLD）', '権利元額を算定できない明細')}),
      gridSheetSpec({columns: ROYALTY_PAYMENT_COLUMNS, rows: body.payments || [], exportSpec: spec('支払記録', '支払と取消の記録')}),
      {name: '照合', title: '照合', conditions, dataAsOf, columns: [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '差額', type: 'yen'}], rows: body.checks || [], freezeCols: 1},
    ];
  }
  const t = body.totals || {};
  const spec = (name, sheetTitle, notes) => ({name, title: sheetTitle, conditions, dataAsOf, notes});
  return [
    cover([
      {k: 'MG保証額の合計（契約ごとに1回）', v: yen(t.guaranteeYen)}, {k: '累計の実充当', v: yen(t.cumulative?.appliedYen)},
      {k: '未消化残高', v: yen(t.remainingAppliedYen)}, {k: '保証額を超えた充当', v: yen(t.exceedAppliedYen)},
      {k: '累計の計上', v: yen(t.cumulative?.recognizedYen)}, {k: '到達率（実充当÷保証額）', v: t.appliedRate == null ? '—' : rate(t.appliedRate)},
      {k: '条件の版の選び方', v: body.versionPolicy || ''}, {k: '到達月の定義', v: body.reachPolicy || ''},
      ...(body.warnings || []).map((w, i) => ({k: i === 0 ? '注意' : '', v: w})),
    ]),
    gridSheetSpec({columns: MG_PARTY_COLUMNS, rows: partyRows(body), exportSpec: spec('取引先別', `${title} 取引先別`)}),
    gridSheetSpec({columns: MG_DETAIL_COLUMNS, rows: detailRows(body), exportSpec: spec('明細', `${title} 契約・作品・商品別`,
      ['「（契約）」の列は契約の先頭行だけに記載し、合計しません（合計不可）。MG保証額の合計は表紙を参照。'])}),
    gridSheetSpec({columns: MG_LEDGER_COLUMNS, rows: ledgerRows(body), exportSpec: spec('台帳', `${title} 元の台帳`)}),
    {name: '照合', title: '照合', conditions, dataAsOf, columns: [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '金額', type: 'yen'}], rows: reconcile(body), freezeCols: 1},
  ];
}

// 出し直すファイル名の部品（xlsx-report の reportBaseName に渡す）。
export function issuanceFileParts(issuance) {
  const kind = ISSUANCE_KINDS[issuance.kind];
  const base = issuance.kind === 'royalty' ? '配給委託の精算報告書' : 'MG売上報告';
  const c = issuance.conditions || {};
  const period = issuance.kind === 'royalty' ? `${c.from}〜${c.to}` : `${c.month}`;
  return {name: `${base}_${issuance.recipient?.name || kind?.recipientLabel || ''}_発行第${issuance.versionNo}版${issuance.void ? '（取消済）' : ''}`, period};
}
