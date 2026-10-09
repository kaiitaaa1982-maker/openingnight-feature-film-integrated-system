// 製作委員会（従来の窓口別計算・共同製作）と権利先への帳票の画面で使う純関数。
// - 契約条件のフォーム: 既定値、選択肢が1つなら自動で決める規則、保存前の検査（日本語の理由）、API の入力への変換
// - 期間報告: 前回の条件版・締め期間・基準を既定値にする
// - 表: 共同製作の帳票を日本語の列と型つきの行にする
import {
  parsePercent, percentInput, percentText, parseMoney, moneyInput, parseDayOfMonth, dayInput, dayText, offsetText, intervalText,
  latestVersion, nextCode, workPrefix, windowKindText, reportBasisText, periodDateBasisText, milestoneStageText,
} from './rights-ui-model.mjs';
import {dateJst, UNKNOWN_TEXT} from '../ui/format.mjs';

// ---- 契約条件フォーム ----

// 控除順ごとに選べる計算の基礎（サーバーの検査と同じ規則）
export function windowBasisOptions(feeOrder) {
  if (feeOrder === 'manager_first') {
    return {
      window: [{value: 'platform_net', label: 'PF控除後'}, {value: 'after_manager', label: '幹事手数料控除後'}],
      manager: [{value: 'platform_net', label: 'PF控除後'}],
    };
  }
  if (feeOrder === 'window_first') {
    return {
      window: [{value: 'platform_net', label: 'PF控除後'}],
      manager: [{value: 'platform_net', label: 'PF控除後'}, {value: 'after_window', label: '窓口手数料控除後'}],
    };
  }
  return {window: [], manager: []};
}

const hasManager = (managerPartnerId) => managerPartnerId !== '' && managerPartnerId !== null && managerPartnerId !== undefined;

// 窓口1件の入力を規則に合わせて整える。
// - 選択肢が1つしか無い基礎は自動で決める。選べない基礎は空に戻す。
// - 幹事なしなら経路は「直接」、幹事手数料は0%、幹事手数料の基礎は「PF控除後」。
export function applyWindowRules(window, managerPartnerId) {
  const next = {...window};
  if (!hasManager(managerPartnerId)) {
    next.route = 'direct';
    next.managerFee = '0';
  }
  const options = windowBasisOptions(next.feeOrder);
  if (options.window.length === 1) next.windowFeeBasis = options.window[0].value;
  else if (!options.window.some((item) => item.value === next.windowFeeBasis)) next.windowFeeBasis = '';
  if (options.manager.length === 1) next.managerFeeBasis = options.manager[0].value;
  else if (!options.manager.some((item) => item.value === next.managerFeeBasis)) next.managerFeeBasis = '';
  if (!hasManager(managerPartnerId) && next.feeOrder === 'window_first') next.managerFeeBasis = 'platform_net';
  return next;
}

// 新しい窓口の既定値。窓口担当は出資者が1者だけならその者。控除順は「窓口手数料を先に控除」。
export function blankWindow({members = [], managerPartnerId = ''} = {}) {
  return applyWindowRules({
    kind: '',
    label: '',
    windowPartnerId: members.length === 1 ? String(members[0].partnerId) : '',
    route: '',
    platformRate: '',
    windowFee: '',
    managerFee: '',
    feeOrder: 'window_first',
    windowFeeBasis: '',
    managerFeeBasis: '',
  }, managerPartnerId);
}

// 販路種別を選んだとき、表示名が空なら販路の名前を入れる
export function windowWithKind(window, kind) {
  const previousAuto = window.label === '' || window.label === windowKindText(window.kind);
  return {...window, kind, label: previousAuto && kind ? windowKindText(kind) : window.label};
}

const addDays = (iso, days) => {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// 新しい日程フェーズ。前のフェーズがあれば開始日を翌日にし、締め・報告・支払の決め方を引き継ぐ。
export function blankPhase(previous = null) {
  if (previous) {
    return {
      label: '', startsOn: previous.endsOn ? addDays(previous.endsOn, 1) : '', endsOn: '', firstCloseOn: '',
      intervalMonths: previous.intervalMonths ?? '', closeDay: previous.closeDay || '月末',
      reportOffsetMonths: previous.reportOffsetMonths ?? '', reportDay: previous.reportDay || '月末',
      paymentOffsetMonths: previous.paymentOffsetMonths ?? '', paymentDay: previous.paymentDay || '月末',
      referenceType: previous.referenceType || '', referenceDate: previous.referenceDate || '',
    };
  }
  return {
    label: '', startsOn: '', endsOn: '', firstCloseOn: '', intervalMonths: '', closeDay: '月末', reportOffsetMonths: '', reportDay: '月末',
    paymentOffsetMonths: '', paymentDay: '月末', referenceType: '', referenceDate: '',
  };
}

// 架空の日程例（入力の手本。実契約の値ではない）
export function samplePhases() {
  const base = {closeDay: '月末', reportOffsetMonths: '1', reportDay: '月末', paymentOffsetMonths: '2', paymentDay: '月末', referenceType: 'release', referenceDate: '2026-09-01'};
  return [
    {...base, label: '架空例・初回は月次', startsOn: '2026-09-01', endsOn: '2026-09-30', firstCloseOn: '2026-09-30', intervalMonths: '1'},
    {...base, label: '架空例・四半期', startsOn: '2026-10-01', endsOn: '2028-08-31', firstCloseOn: '2026-12-31', intervalMonths: '3'},
    {...base, label: '架空例・半年', startsOn: '2028-09-01', endsOn: '2029-08-31', firstCloseOn: '2029-02-28', intervalMonths: '6'},
    {...base, label: '架空例・年次', startsOn: '2029-09-01', endsOn: '2031-08-31', firstCloseOn: '2030-08-31', intervalMonths: '12'},
  ];
}

const windowFromSaved = (row, memberIds = null) => ({
  kind: row.kind,
  label: row.label || '',
  windowPartnerId: memberIds && !memberIds.has(Number(row.window_partner_id)) ? '' : String(row.window_partner_id ?? ''),
  route: row.route || '',
  platformRate: percentInput(row.platform_rate_bps),
  windowFee: percentInput(row.window_fee_bps),
  managerFee: percentInput(row.manager_fee_bps),
  feeOrder: row.fee_order || '',
  windowFeeBasis: row.window_fee_basis || '',
  managerFeeBasis: row.manager_fee_basis || '',
});

const phaseFromSaved = (row) => ({
  label: row.label || '',
  startsOn: row.starts_on || '',
  endsOn: row.ends_on || '',
  firstCloseOn: row.first_close_on || '',
  intervalMonths: row.interval_months === null || row.interval_months === undefined ? '' : String(row.interval_months),
  closeDay: dayInput(row.close_day),
  reportOffsetMonths: row.report_offset_months === null || row.report_offset_months === undefined ? '' : String(row.report_offset_months),
  reportDay: dayInput(row.report_day),
  paymentOffsetMonths: row.payment_offset_months === null || row.payment_offset_months === undefined ? '' : String(row.payment_offset_months),
  paymentDay: dayInput(row.payment_day),
  referenceType: row.reference_type || '',
  referenceDate: row.reference_date || '',
});

const fundingFromSaved = (funding) => (funding
  ? {productionCostYen: moneyInput(funding.productionCostYen), investments: (funding.investments || []).map((item) => ({partnerId: item.partnerId, amountYen: moneyInput(item.amountYen)}))}
  : null);

// 委員会契約の新規登録フォーム（空）
export function newTermsForm({work = null, contracts = []} = {}) {
  return {
    intakeCaseId: '', documentId: '', managerPartnerId: '', note: '', contractId: null, sourceVersionId: null, funding: null,
    contractCode: nextCode(`${workPrefix(work)}-委員会`, (contracts || []).map((row) => row.contract_code)),
    title: '',
    windows: [blankWindow()],
    phases: [blankPhase()],
  };
}

// 保存済みの版から新しい版の入力（すべて写す）
export function termsFormFromVersion(contract, version) {
  return {
    intakeCaseId: String(contract.intake_case_id ?? ''),
    documentId: String(contract.document_id ?? ''),
    contractCode: contract.contract_code,
    title: contract.title,
    managerPartnerId: version.manager_partner_id === null || version.manager_partner_id === undefined ? '' : String(version.manager_partner_id),
    note: version.note || '',
    contractId: contract.id,
    sourceVersionId: version.id,
    // 新しい版の適用開始月（計上月。空は最初の月から＝過去の月も訂正）と、コピー元の窓口手数料の取り分を引き継ぐか
    effectiveFrom: '',
    copyFeeShares: true,
    funding: fundingFromSaved(version.funding),
    windows: (version.windows || []).map((row) => windowFromSaved(row)),
    phases: (version.phases || []).map(phaseFromSaved),
  };
}

// 既存の契約の版から、新しい契約の入力へ窓口と日程を写す（出資者にいない窓口担当は空に戻す）
export function copyTermsInto(form, version, members = []) {
  const memberIds = new Set(members.map((row) => Number(row.partnerId)));
  const manager = version.manager_partner_id !== null && version.manager_partner_id !== undefined && memberIds.has(Number(version.manager_partner_id))
    ? String(version.manager_partner_id) : form.managerPartnerId;
  const windows = (version.windows || []).map((row) => applyWindowRules(windowFromSaved(row, memberIds), manager));
  return {
    ...form,
    managerPartnerId: manager,
    windows: windows.length ? windows : form.windows,
    phases: (version.phases || []).length ? version.phases.map(phaseFromSaved) : form.phases,
  };
}

// 調達案件の参加者（出資者）。取引先が決まっている者だけ。
export function membersOfIntake(intake) {
  return (intake?.participants || []).filter((row) => row.partner_id !== null && row.partner_id !== undefined)
    .map((row) => ({partnerId: row.partner_id, partnerName: row.partner_name || '名称未登録の取引先', shareBps: row.explicit_share_bps, role: row.role}));
}

const isInt = (value, min, max) => /^\d+$/.test(String(value ?? '').normalize('NFKC').trim()) && Number(String(value).normalize('NFKC')) >= min && Number(String(value).normalize('NFKC')) <= max;
const toInt = (value) => Number(String(value).normalize('NFKC').trim());

// 保存前の検査。サーバーと同じ規則を日本語で先に示す。errors: [{section, message}]
// section: basic（基本）| funding（出資）| windows（窓口）| deductions（控除）| schedule（日程）
export function validateTermsForm(form, {members = [], isNew = true} = {}) {
  const errors = [];
  const add = (section, message) => errors.push({section, message});
  if (isNew) {
    if (!form.intakeCaseId) add('basic', '製作委員会の調達案件を選んでください');
    if (!form.documentId) add('basic', '契約書の参照を選んでください');
    if (!String(form.contractCode || '').trim()) add('basic', '契約コードを入力してください');
    if (!String(form.title || '').trim()) add('basic', '契約名を入力してください');
  }
  if (!members.length) add('basic', '参加者と持分が確定した調達案件を選んでください');
  if (!isNew && String(form.effectiveFrom || '').trim() && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(form.effectiveFrom).normalize('NFKC').trim())) {
    add('basic', '適用開始月は「2027-01」の形（計上月）で入れてください');
  }
  const manager = hasManager(form.managerPartnerId);
  if (form.funding) {
    const cost = parseMoney(form.funding.productionCostYen);
    if (!cost.ok) add('funding', `製作費総額: ${cost.error}`);
    else if (cost.value === null) add('funding', '製作費総額を入力してください');
    for (const member of members) {
      const value = form.funding.investments?.find((item) => Number(item.partnerId) === Number(member.partnerId))?.amountYen;
      const amount = parseMoney(value);
      if (!amount.ok) add('funding', `${member.partnerName}の出資額: ${amount.error}`);
      else if (amount.value === null) add('funding', `${member.partnerName}の出資額を入力してください`);
    }
  }
  const windows = form.windows || [];
  if (!windows.length) add('windows', '販路の窓口を1件以上登録してください');
  const kinds = new Set();
  windows.forEach((window, index) => {
    const name = `窓口${index + 1}`;
    if (!window.kind) add('windows', `${name}の販路を選んでください`);
    else if (kinds.has(window.kind)) add('windows', `${name}: 販路「${windowKindText(window.kind)}」が重複しています`);
    kinds.add(window.kind);
    if (!String(window.label || '').trim()) add('windows', `${name}の表示名を入力してください`);
    if (!window.windowPartnerId) add('windows', `${name}の窓口担当を選んでください`);
    else if (!members.some((row) => String(row.partnerId) === String(window.windowPartnerId))) add('windows', `${name}の窓口担当は出資者から選んでください`);
    if (!window.route) add('windows', `${name}の分配経路を選んでください`);
    if (window.route === 'via_manager' && !manager) add('windows', `${name}: 幹事を経由する経路には幹事の指定が必要です`);
    for (const [key, label, section] of [['platformRate', 'PF料率', 'windows'], ['windowFee', '窓口手数料率', 'deductions'], ['managerFee', '幹事手数料率', 'deductions']]) {
      const parsed = parsePercent(window[key]);
      if (!parsed.ok) add(section, `${name}の${label}: ${parsed.error}`);
      else if (parsed.value === null) add(section, `${name}の${label}を入力してください`);
      else if (key === 'managerFee' && parsed.value > 0 && !manager) add(section, `${name}: 幹事手数料があるときは幹事を指定してください`);
    }
    if (!window.feeOrder) add('deductions', `${name}の控除の順序を選んでください`);
    const options = windowBasisOptions(window.feeOrder);
    if (window.feeOrder && !options.window.some((item) => item.value === window.windowFeeBasis)) add('deductions', `${name}の窓口手数料の計算の基礎を選んでください`);
    if (window.feeOrder && !options.manager.some((item) => item.value === window.managerFeeBasis)) add('deductions', `${name}の幹事手数料の計算の基礎を選んでください`);
  });
  const phases = form.phases || [];
  if (!phases.length) add('schedule', '日程を1件以上登録してください');
  phases.forEach((phase, index) => {
    const name = `日程${index + 1}`;
    if (!String(phase.label || '').trim()) add('schedule', `${name}の名称を入力してください`);
    for (const [key, label] of [['startsOn', '開始日'], ['endsOn', '終了日'], ['firstCloseOn', '初回の締め日'], ['referenceDate', '基準日']]) {
      if (!phase[key]) add('schedule', `${name}の${label}を入力してください`);
    }
    if (phase.startsOn && phase.endsOn && phase.endsOn < phase.startsOn) add('schedule', `${name}の終了日が開始日より前です`);
    if (phase.firstCloseOn && ((phase.startsOn && phase.firstCloseOn < phase.startsOn) || (phase.endsOn && phase.firstCloseOn > phase.endsOn))) add('schedule', `${name}の初回の締め日は期間の中にしてください`);
    if (!isInt(phase.intervalMonths, 1, 12)) add('schedule', `${name}の締めの間隔は1〜12か月で入力してください`);
    if (!isInt(phase.reportOffsetMonths, 0, 24)) add('schedule', `${name}の報告までの月数は0〜24で入力してください`);
    if (!isInt(phase.paymentOffsetMonths, 0, 24)) add('schedule', `${name}の支払までの月数は0〜24で入力してください`);
    for (const [key, label] of [['closeDay', '締め日'], ['reportDay', '報告予定日'], ['paymentDay', '支払予定日']]) {
      const parsed = parseDayOfMonth(phase[key]);
      if (!parsed.ok) add('schedule', `${name}の${label}: ${parsed.error}`);
    }
    if (!phase.referenceType) add('schedule', `${name}の基準日の種類を選んでください`);
  });
  const sorted = phases.filter((phase) => phase.startsOn && phase.endsOn).sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startsOn !== addDays(sorted[index - 1].endsOn, 1)) {
      add('schedule', '日程の期間は途切れず重ならないように続けてください（次の開始日＝前の終了日の翌日）');
      break;
    }
  }
  return {ok: errors.length === 0, errors};
}

// 入力 → API の入力（率は bp、日は 'eom' か数、月数は数）
export function termsPayload(form, workId) {
  const bps = (value) => parsePercent(value).value;
  const day = (value) => parseDayOfMonth(value).value;
  const payload = {
    workId: Number(workId),
    intakeCaseId: Number(form.intakeCaseId),
    documentId: Number(form.documentId),
    contractCode: String(form.contractCode || '').trim(),
    title: String(form.title || '').trim(),
    managerPartnerId: hasManager(form.managerPartnerId) ? Number(form.managerPartnerId) : null,
    note: String(form.note || '').trim(),
    funding: form.funding ? {
      productionCostYen: parseMoney(form.funding.productionCostYen).value,
      investments: (form.funding.investments || []).map((item) => ({partnerId: Number(item.partnerId), amountYen: parseMoney(item.amountYen).value})),
    } : null,
    windows: (form.windows || []).map((row) => ({
      kind: row.kind, label: String(row.label || '').trim(), windowPartnerId: Number(row.windowPartnerId), route: row.route,
      platformRateBps: bps(row.platformRate), windowFeeBps: bps(row.windowFee), managerFeeBps: bps(row.managerFee),
      feeOrder: row.feeOrder, windowFeeBasis: row.windowFeeBasis, managerFeeBasis: row.managerFeeBasis,
    })),
    phases: (form.phases || []).map((row) => ({
      label: String(row.label || '').trim(), startsOn: row.startsOn, endsOn: row.endsOn, firstCloseOn: row.firstCloseOn,
      intervalMonths: toInt(row.intervalMonths), closeDay: day(row.closeDay), reportOffsetMonths: toInt(row.reportOffsetMonths), reportDay: day(row.reportDay),
      paymentOffsetMonths: toInt(row.paymentOffsetMonths), paymentDay: day(row.paymentDay), referenceType: row.referenceType, referenceDate: row.referenceDate,
    })),
  };
  if (form.sourceVersionId !== null && form.sourceVersionId !== undefined) {
    payload.sourceVersionId = form.sourceVersionId;
    const effectiveFrom = String(form.effectiveFrom || '').normalize('NFKC').trim();
    if (effectiveFrom) payload.effectiveFrom = effectiveFrom;
    payload.copyFeeShares = form.copyFeeShares !== false;
  }
  if (form.confirmRetroactive === true) payload.confirmRetroactive = true;
  return payload;
}

// 保存済みの日程フェーズを1文で（「2026/09/01〜2026/09/30・初回締め 2026/09/30・毎月の月末締め・報告 翌月の月末・支払 2か月後の月末」）
export function phaseSummary(row) {
  return [
    `${dateJst(row.starts_on)}〜${dateJst(row.ends_on)}`,
    `初回締め ${dateJst(row.first_close_on)}`,
    `${intervalText(row.interval_months)}の${dayText(row.close_day)}締め`,
    `報告 ${offsetText(row.report_offset_months, row.report_day)}`,
    `支払 ${offsetText(row.payment_offset_months, row.payment_day)}`,
  ].join('・');
}

// 窓口1件を1文で
export function windowSummary(row) {
  const order = row.fee_order === 'manager_first' ? '幹事手数料が先' : '窓口手数料が先';
  return `${windowKindText(row.kind)}｜窓口 ${row.window_partner_name || '未登録'}｜PF ${percentText(row.platform_rate_bps)}・窓口 ${percentText(row.window_fee_bps)}・幹事 ${percentText(row.manager_fee_bps)}（${order}）`;
}

// ---- 期間報告の追加の控除 ----

// 控除の入力 → API の入力（金額の揺れを吸収）。直せないときは理由の配列を返す。
export function deductionPayload(rows = []) {
  const errors = [];
  const deductions = rows.map((row, index) => {
    const name = `追加の控除${index + 1}`;
    const amount = parseMoney(row.amountYen);
    if (!row.reportId) errors.push(`${name}: 元の売上報告を選んでください`);
    if (!row.recipientPartnerId) errors.push(`${name}: 受取先を選んでください`);
    if (!amount.ok) errors.push(`${name}: ${amount.error}`);
    else if (!amount.value) errors.push(`${name}: 控除額を入力してください`);
    if (!String(row.sourceReference || '').trim()) errors.push(`${name}: 根拠の識別番号を入力してください`);
    return {reportId: Number(row.reportId), category: row.category, recipientPartnerId: Number(row.recipientPartnerId), amountYen: amount.ok ? amount.value : null, sourceReference: String(row.sourceReference || '').trim()};
  });
  return {ok: errors.length === 0, errors, deductions};
}

// ---- 期間報告の既定値 ----

const byIdDesc = (a, b) => Number(b.id) - Number(a.id);

// 既定の条件版と期間の基準。直近の保存報告の契約の最新の条件版と、その報告の基準を引き継ぐ。
export function builderDefaults({contracts = [], snapshots = []} = {}) {
  const last = [...(snapshots || [])].sort(byIdDesc)[0] || null;
  const contract = (last && contracts.find((row) => row.id === last.contract_id))
    || [...(contracts || [])].sort(byIdDesc)[0] || null;
  const version = latestVersion(contract?.versions);
  const basis = last && contract && last.contract_id === contract.id ? (last.period_date_basis || last.input?.periodDateBasis || '') : '';
  return {termVersionId: version ? String(version.id) : '', periodDateBasis: basis, contractId: contract?.id ?? null};
}

// 次に作る締め期間。同じ契約で保存済みの最後の期間の次。保存が無ければ最初の期間。すべて保存済みなら ''。
export function nextPeriodIndex(periods = [], snapshots = [], contractId = null) {
  if (!periods?.length) return '';
  const saved = (snapshots || []).filter((row) => contractId === null || row.contract_id === contractId);
  if (!saved.length) return String(periods[0].index);
  const lastEnd = saved.map((row) => row.period_to).filter(Boolean).sort().at(-1);
  const next = periods.find((period) => period.start > lastEnd);
  return next ? String(next.index) : '';
}

// 販路ごとの前回の報告額の基準（新しい保存報告を優先）
export function basisByKind(snapshots = [], contractId = null) {
  const out = {};
  for (const row of [...(snapshots || [])].filter((item) => contractId === null || item.contract_id === contractId).sort(byIdDesc)) {
    for (const report of row.calculation?.selectedReports || []) {
      if (report.kind && report.reportBasis && !out[report.kind]) out[report.kind] = report.reportBasis;
    }
  }
  return out;
}

// 保存済みの期間報告の一覧（DataGrid の行）
export function snapshotRows(snapshots = [], contracts = []) {
  return (snapshots || []).map((row) => {
    const contract = contracts.find((item) => item.id === row.contract_id);
    const version = contract?.versions?.find((item) => item.id === row.term_version_id);
    const calc = row.calculation || {};
    return {
      ...row,
      contractText: calc.contract ? `${calc.contract.code}｜${calc.contract.title}` : contract ? `${contract.contract_code}｜${contract.title}` : UNKNOWN_TEXT,
      versionText: version ? `版${version.version_no}` : calc.termVersion?.versionNo ? `版${calc.termVersion.versionNo}` : UNKNOWN_TEXT,
      periodText: `${dateJst(row.period_from)}〜${dateJst(row.period_to)}${row.stub ? '（端数期間）' : ''}`,
      basisText: periodDateBasisText(row.period_date_basis),
      pool: calc.totals?.distributionPool ?? null,
      platformNet: calc.totals?.platformNet ?? null,
      statusText: '下書き（未確認）',
    };
  });
}

// ---- 共同製作・入金基準の帳票 ----

const Y = (key, label, extra = {}) => ({key, label, type: 'yen', total: 'sum', ...extra});
const T = (key, label, extra = {}) => ({key, label, type: 'text', ...extra});
const D = (key, label) => ({key, label, type: 'date'});
// 日付が無いことに意味がある列（未着金・未払など）は、その意味を文字で出す（「未確認」にしない）
const DT = (key, label) => ({key, label, type: 'text'});
const dateOr = (value, text) => (value ? dateJst(value) : text);

// 保存済みの計算から、帳票4種を日本語の列と型つきの行にする。
export function jointReportViews(results = [], milestones = [], names = {}) {
  const partner = (id) => names[id] || '名称未登録の取引先';
  return {
    joint_period_totals: {
      title: '委員会収支',
      columns: [T('period', '期', {sticky: true}), D('to', '売上対象の期末'), DT('receiptOn', '委員会の実受入日'), Y('income', '実受入'), Y('rights', '権利処理費'),
        Y('feeBasis', '幹事料の基礎', {total: 'none'}), Y('fee', '幹事料'), Y('master', '原盤管理費'), Y('bank', '立替の返済'), Y('pool', '分配原資'), Y('residual', '未配分の端数'), DT('payDue', '出資者への支払期限')],
      rows: results.map((p) => ({key: String(p.periodSequence), period: `${p.periodSequence}期`, to: p.to || null, receiptOn: dateOr(p.managerReceiptOn, '実受入なし'), income: p.committeeIncomeYen, rights: p.rightsCostYen,
        feeBasis: p.managerFeeBasisYen, fee: p.managerFeeYen, master: p.masterCostYen, bank: p.bankAdvanceRepaidYen, pool: p.distributableYen, residual: p.roundingResidualYen, payDue: dateOr(p.investorPaymentDueOn, '実受入なし')})),
    },
    joint_window_periods: {
      title: '窓口報告',
      columns: [T('period', '期', {sticky: true}), T('window', '窓口'), T('partner', '窓口担当'), Y('net', '正味収入・税込契約額'), Y('expense', '直接経費'), Y('fee', '窓口料'), Y('music', '音楽使用料'),
        Y('income', '当期の委員会収入'), Y('carryIn', '前期からの繰越', {total: 'none'}), Y('cash', '実受入'), Y('carryOut', '期末の未送金', {total: 'none'}), DT('receiptOn', '実受入日'), D('reportDue', '報告期限'), D('payDue', '送金期限')],
      rows: results.flatMap((p) => (p.windows || []).map((w) => ({key: `${p.periodSequence}-${w.windowId}`, period: `${p.periodSequence}期`, window: w.windowLabel, partner: partner(w.partnerId), net: w.netReceiptYen,
        expense: w.directExpenseYen, fee: w.windowFeeYen, music: w.musicFeeYen, income: w.committeeIncomeYen, carryIn: w.previousCarryYen, cash: w.cashReceivedYen, carryOut: w.carriedYen,
        receiptOn: dateOr(w.managerReceiptOn, '未着金'), reportDue: w.windowReportDueOn || null, payDue: w.windowPaymentDueOn || null}))),
    },
    joint_member_distributions: {
      title: '出資者への分配',
      columns: [T('period', '期', {sticky: true}), T('partner', '出資者'), {key: 'share', label: '持分', type: 'rate', digits: 2, total: 'none'}, Y('earned', '分配額'), Y('paid', '支払済み'), Y('outstanding', '未払'), DT('payDue', '支払期限')],
      rows: results.flatMap((p) => (p.distributions || []).map((d) => ({key: `${p.periodSequence}-${d.partnerId}`, period: `${p.periodSequence}期`, partner: partner(d.partnerId), share: d.shareBps === null || d.shareBps === undefined ? null : d.shareBps / 10000,
        earned: d.earnedYen, paid: d.paidYen, outstanding: d.outstandingYen, payDue: dateOr(p.investorPaymentDueOn, '実受入なし')}))),
    },
    joint_production_milestones: {
      title: '制作費の支払',
      columns: [T('stage', '支払の条件', {sticky: true}), D('due', '予定日'), Y('amount', '予定額（税込）'), DT('met', '条件の成就日'), DT('accepted', '検収日'), DT('paidOn', '支払日'), Y('paid', '支払済み（税込）')],
      rows: (milestones || []).map((m) => ({key: String(m.id ?? m.stage), stage: milestoneStageText(m.stage), due: m.due_on || null, amount: m.amount_inc_tax_yen, met: dateOr(m.condition_met_on, '未成就'),
        accepted: dateOr(m.acceptance_on, '未検収'), paidOn: dateOr(m.paid_on, '未払'), paid: m.paid_inc_tax_yen ?? null})),
    },
  };
}

export const JOINT_VIEW_ORDER = Object.freeze(['joint_period_totals', 'joint_window_periods', 'joint_member_distributions', 'joint_production_milestones']);

// 帳票の前提（Excel の先頭シート）
export function jointAssumptionRows({title, calculationVersion} = {}) {
  return [
    {item: '作品', value: title || UNKNOWN_TEXT},
    {item: '計算の版', value: calculationVersion ? '入金基準の計算（第1版）' : UNKNOWN_TEXT},
    {item: '税の基準', value: '税込の契約額（架空の追加合意）'},
    {item: '窓口送金の判定', value: '税込の正味受領額が基準額に満たないとき翌期へ繰越（同額は繰越しない）'},
    {item: '委員会収入の判定', value: '窓口別の収入と前期繰越の合計が基準額に満たないとき翌期へ繰越'},
    {item: 'MG・製作費の優先回収', value: '設定なし'},
    {item: '実際の支払', value: '分配の計算とは別。支払の実績が未登録なら未払'},
  ];
}

// ---- 権利先への帳票（RightsReports） ----

// 保存報告の既定（最新の保存報告）
export function latestSnapshotId(snapshots = []) {
  const last = [...(snapshots || [])].sort(byIdDesc)[0];
  return last ? String(last.id) : '';
}

// MG帳票の既定の選択。契約が1件ならそれ、条件版は最新。
export function mgSelectionDefaults(contracts = [], contractId = '', versionId = '') {
  const chosen = contractId || ((contracts || []).length === 1 ? String(contracts[0].id) : '');
  const contract = (contracts || []).find((row) => String(row.id) === String(chosen));
  const versionOk = contract?.versions?.some((row) => String(row.id) === String(versionId));
  const latest = latestVersion(contract?.versions, 'version');
  return {contractId: chosen, versionId: versionOk ? String(versionId) : latest ? String(latest.id) : ''};
}

// 権利先別の出資分配（前回まで・当期・累計）と合計行
export function memberDistributionTable(report, partyName = (id) => `取引先${id}`) {
  const periods = ['previous', 'current', 'cumulative'];
  const ids = [...new Set(periods.flatMap((p) => (report?.totals?.[p]?.memberDistributions || []).map((m) => m.partnerId)))];
  const rows = ids.map((id) => ({
    id,
    name: partyName(id),
    ...Object.fromEntries(periods.map((p) => [p, report.totals[p].memberDistributions.find((m) => m.partnerId === id)?.amount || 0])),
  }));
  const total = Object.fromEntries(periods.map((p) => [p, rows.reduce((sum, row) => sum + row[p], 0)]));
  return {rows, total};
}

export {reportBasisText};
