import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREEN_TEXT, COMMITTEE_FLOW, REPORT_BASIS_OPTIONS, RECOUP_BASIS_OPTIONS, CONTRACT_TYPE_OPTIONS, INTAKE_TYPE_OPTIONS, EXCLUSIVITY_OPTIONS,
  PERIOD_DATE_BASIS_OPTIONS, WINDOW_KIND_OPTIONS, ROUTE_OPTIONS, FEE_ORDER_OPTIONS, REFERENCE_TYPE_OPTIONS, DEDUCTION_CATEGORY_OPTIONS,
  reportBasisText, recoupBasisText, routeText, feeBasisText, feeOrderText, windowKindText, reportKindText, contractTypeText, intakeTypeText,
  exclusivityText, periodDateBasisText, referenceTypeText, deductionCategoryText, milestoneStageText, snapshotStatusText,
  parsePercent, percentInput, percentText, parseMoney, parseDayOfMonth, dayInput, dayText, offsetText, intervalText, nextCode, workPrefix,
  latestVersion, settlementVersionText, linkDefaults, contractFormDefaults, settlementContractPayload, versionFormDefaults, versionPayload,
  percentFieldError, mediaOptions, ALL_MEDIA, intakeCodeDefault, revisionCode, newIntakeForm, intakeFormFromCase, intakePayload, intakeRows,
  japaneseMessage, translateError,
} from '../src/rights/rights-ui-model.mjs';
import {ApiError} from '../src/ui/api-client.mjs';

// 英字の語（2文字以上）。業界の略語 MG・PF だけは認める。
const ALLOWED = new Set(['MG', 'PF']);
function englishWords(text) {
  return (String(text).match(/[A-Za-z]{2,}/g) || []).filter((word) => !ALLOWED.has(word));
}
function assertJapanese(text, where) {
  assert.deepEqual(englishWords(text), [], `${where}: 英語が残っている「${text}」`);
}

test('画面の見出しと分配の流れに英語の見出し・コード値が無い', () => {
  for (const [screen, texts] of Object.entries(SCREEN_TEXT)) {
    for (const [key, text] of Object.entries(texts)) assertJapanese(text, `${screen}.${key}`);
  }
  assert.equal(COMMITTEE_FLOW.length, 4);
  COMMITTEE_FLOW.forEach((text, index) => assertJapanese(text, `流れ${index + 1}`));
  // 旧画面の英語見出しは使わない
  const all = JSON.stringify(SCREEN_TEXT);
  for (const old of ['RIGHTS', 'SETTLEMENT', 'PROTOTYPE', 'PLANNING', 'INTAKE', 'COMMITTEE', 'DRAFT', 'WINDOW']) assert.ok(!all.includes(old), old);
});

test('選択肢のラベルはすべて日本語（gross/net・draft・commission 等のコード値を出さない）', () => {
  const tables = {REPORT_BASIS_OPTIONS, RECOUP_BASIS_OPTIONS, CONTRACT_TYPE_OPTIONS, INTAKE_TYPE_OPTIONS, EXCLUSIVITY_OPTIONS, PERIOD_DATE_BASIS_OPTIONS,
    WINDOW_KIND_OPTIONS, ROUTE_OPTIONS, FEE_ORDER_OPTIONS, REFERENCE_TYPE_OPTIONS, DEDUCTION_CATEGORY_OPTIONS};
  for (const [name, options] of Object.entries(tables)) {
    assert.ok(options.length > 0, name);
    for (const option of options) {
      assertJapanese(option.label, `${name}.${option.value}`);
      assert.notEqual(option.label, option.value, `${name}: 値がそのまま表示されている`);
    }
  }
  assert.deepEqual(REPORT_BASIS_OPTIONS.map((o) => o.value), ['gross', 'net']);
  assert.deepEqual(CONTRACT_TYPE_OPTIONS.map((o) => o.label), ['手数料型', 'MG調達型', '自社権利型']);
});

test('コード値の表示はすべて日本語', () => {
  const cases = [
    [reportBasisText('gross'), '控除前'], [reportBasisText('net'), '控除後'], [reportBasisText('mixed'), '控除前と控除後が混在'],
    [recoupBasisText('platform_net'), 'PF控除後'], [recoupBasisText('after_fee'), '代理店手数料控除後'],
    [routeText('via_manager'), '窓口から幹事を経由'], [feeBasisText('after_window'), '窓口手数料控除後'], [feeOrderText('manager_first'), '幹事手数料を先に控除'],
    [windowKindText('digital'), '配信'], [reportKindText('package'), 'ビデオグラム'], [contractTypeText('self_owned'), '自社権利型'],
    [intakeTypeText('entrusted'), '権利受託'], [exclusivityText(null), '未確認'], [periodDateBasisText('report_received'), '報告受領日'],
    [referenceTypeText('first_sales'), '初回の販売日'], [deductionCategoryText('production_recoup'), '製作費回収'],
    [milestoneStageText('delivery_accepted'), '納品物の検収合格'], [snapshotStatusText('draft'), '下書き'], [snapshotStatusText(undefined), '下書き'],
  ];
  for (const [actual, expected] of cases) assert.equal(actual, expected);
  for (const [actual] of cases) assertJapanese(actual, actual);
  // 未知のコードは推測で訳さない
  assert.equal(routeText('teleport'), '未登録の値（teleport）');
  assert.equal(recoupBasisText(null), '未確認');
});

test('率の入力: 全角・%・小数2桁まで。範囲外と3桁以上の小数は日本語の理由', () => {
  assert.deepEqual(parsePercent('12.5'), {ok: true, value: 1250});
  assert.deepEqual(parsePercent('１２．５％'), {ok: true, value: 1250});
  assert.deepEqual(parsePercent('12.25%'), {ok: true, value: 1225});
  assert.deepEqual(parsePercent(' 0 '), {ok: true, value: 0});
  assert.deepEqual(parsePercent('100'), {ok: true, value: 10000});
  assert.deepEqual(parsePercent(''), {ok: true, value: null});
  assert.equal(parsePercent('100.01').ok, false);
  assert.match(parsePercent('101').error, /0〜100%/);
  assert.match(parsePercent('12.345').error, /小数第2位/);
  assert.match(parsePercent('abc').error, /数字/);
  assert.equal(parsePercent('-1').ok, false);
  assert.equal(percentInput(1250), '12.5');
  assert.equal(percentInput(null), '');
  assert.equal(percentText(1234), '12.34%');
  assert.equal(percentText(5000), '50%');
  assert.equal(percentText(null), '未確認');
  assert.equal(percentFieldError(''), '率を入力してください');
  assert.equal(percentFieldError('', {required: false}), null);
  assert.equal(percentFieldError('20'), null);
});

test('金額の入力は FormField と同じく全角・カンマ・円を吸収する', () => {
  assert.deepEqual(parseMoney('１２，０００円'), {ok: true, value: 12000, blank: false});
  assert.deepEqual(parseMoney('¥3,000'), {ok: true, value: 3000, blank: false});
  assert.equal(parseMoney('-1').ok, false);
});

test('締め日・報告日: 「月末」と1〜31日。日程は日本語の文にする（+1月 / eom を出さない）', () => {
  assert.deepEqual(parseDayOfMonth('月末'), {ok: true, value: 'eom'});
  assert.deepEqual(parseDayOfMonth('末'), {ok: true, value: 'eom'});
  assert.deepEqual(parseDayOfMonth('eom'), {ok: true, value: 'eom'});
  assert.deepEqual(parseDayOfMonth('２５日'), {ok: true, value: 25});
  assert.deepEqual(parseDayOfMonth(15), {ok: true, value: 15});
  assert.equal(parseDayOfMonth('32').ok, false);
  assert.equal(parseDayOfMonth('').ok, false);
  assert.equal(dayInput('eom'), '月末');
  assert.equal(dayInput(10), '10');
  assert.equal(dayText('eom'), '月末');
  assert.equal(dayText('5'), '5日');
  assert.equal(offsetText(1, 'eom'), '翌月の月末');
  assert.equal(offsetText(0, 20), '締めと同じ月の20日');
  assert.equal(offsetText(2, '10'), '2か月後の10日');
  assert.equal(intervalText(1), '毎月');
  assert.equal(intervalText(3), '3か月ごと');
  for (const text of [offsetText(1, 'eom'), dayText('eom'), intervalText(12)]) assertJapanese(text, text);
});

test('コードの初期値は時刻由来の機械コードにせず、作品コードと連番にする', () => {
  assert.equal(nextCode('W001-分配', []), 'W001-分配-01');
  assert.equal(nextCode('W001-分配', ['W001-分配-01', 'W001-分配-02']), 'W001-分配-03');
  assert.equal(nextCode('W001-分配', ['W001-分配-02']), 'W001-分配-01');
  assert.equal(workPrefix({id: 3, code: 'W003'}), 'W003');
  assert.equal(workPrefix({id: 3}), '作品3');
  assert.equal(intakeCodeDefault({code: 'W1'}, [{case_code: 'W1-調達-01'}]), 'W1-調達-02');
  assert.equal(revisionCode({case_code: 'W1-調達-01', snapshot_version: 1}, []), 'W1-調達-01-版2');
  assert.equal(revisionCode({case_code: 'W1-調達-01-版2', snapshot_version: 2}, [{case_code: 'W1-調達-01-版3'}]), 'W1-調達-01-版4');
  assert.doesNotMatch(newIntakeForm({code: 'W1'}, []).caseCode, /\d{10,}/);
});

const contracts = [
  {id: 1, contract_code: 'A', contract_type: 'commission', holder_partner_id: 7, versions: [{id: 11, version_no: 1, platform_rate_bps: 3000, agency_fee_bps: 2000}, {id: 12, version_no: 2, platform_rate_bps: 3500, agency_fee_bps: 1500}]},
  {id: 2, contract_code: 'B', contract_type: 'mg', holder_partner_id: 8, versions: [{id: 21, version_no: 1, platform_rate_bps: 4000, agency_fee_bps: 1000, recoup_basis: 'after_fee'}]},
];

test('権利・分配: 最新の条件版を既定にし、報告額の基準は前回の紐付けを引き継ぐ', () => {
  assert.equal(latestVersion(contracts[0].versions).id, 12);
  assert.equal(latestVersion([]), null);
  const reports = [
    {id: 100, partner_id: 5, kind: 'digital', accounting_month: '2026-07', link: {contract_id: 1, term_version_id: 11, report_basis: 'net'}},
    {id: 101, partner_id: 6, kind: 'package', accounting_month: '2026-08', link: {contract_id: 2, term_version_id: 21, report_basis: 'gross'}},
    {id: 102, partner_id: 5, kind: 'digital', accounting_month: '2026-09', link: null},
    {id: 103, partner_id: 9, kind: 'broadcast', accounting_month: '2026-09', link: null},
  ];
  // 同じ取引先・同じ流通の前回 → 契約1の最新の版12（前回の版11ではない）、基準は前回の net
  assert.deepEqual(linkDefaults(reports[2], contracts, reports), {contractId: '1', versionId: '12', reportBasis: 'net', source: 'previous'});
  // 同じ流通の前回が無ければ直近の紐付け（2026-08 の契約2）
  assert.deepEqual(linkDefaults(reports[3], contracts, reports), {contractId: '2', versionId: '21', reportBasis: 'gross', source: 'previous'});
  // 前回が無く契約が1件 → その契約の最新版。基準は推測しない
  assert.deepEqual(linkDefaults(reports[3], [contracts[0]], [reports[3]]), {contractId: '1', versionId: '12', reportBasis: '', source: 'single'});
  // 契約が複数で前回なし → 選んでもらう
  assert.deepEqual(linkDefaults(reports[3], contracts, [reports[3]]), {contractId: '', versionId: '', reportBasis: '', source: 'none'});
  assert.equal(settlementVersionText(contracts[1].versions[0]), '版1・PF 40%・手数料 10%・回収の基礎 代理店手数料控除後');
  assertJapanese(settlementVersionText(contracts[1].versions[0]), '条件版');
});

test('権利契約の登録: 前回の料率を既定にし、率は bp・金額は数値で送る', () => {
  const defaults = contractFormDefaults(contracts, {code: 'W1'});
  assert.equal(defaults.contractCode, 'W1-分配-01');
  assert.equal(defaults.contractType, 'mg');
  assert.equal(defaults.platformRate, '40');
  assert.equal(defaults.feeRate, '10');
  assert.equal(defaults.recoupBasis, 'after_fee');
  const empty = contractFormDefaults([], {code: 'W1'});
  assert.equal(empty.platformRate, '');
  assert.equal(empty.contractType, 'commission');
  const payload = settlementContractPayload({contractCode: 'C', title: 'T', contractType: 'mg', holderPartnerId: '8', platformRate: '１２.５', feeRate: '20%', mgContractYen: 1000000, mgPaidYen: null, recoupBasis: 'platform_net', intakeCaseId: '4'}, 3);
  assert.deepEqual(payload, {workId: 3, contractCode: 'C', title: 'T', contractType: 'mg', intakeCaseId: 4, holderPartnerId: 8, mgContractYen: 1000000, mgPaidYen: null, terms: {platformRateBps: 1250, agencyFeeBps: 2000, recoupBasis: 'platform_net'}});
  const own = settlementContractPayload({contractCode: 'C', title: 'T', contractType: 'self_owned', platformRate: '30', feeRate: '', holderPartnerId: ''}, 3);
  assert.deepEqual(own, {workId: 3, contractCode: 'C', title: 'T', contractType: 'self_owned', terms: {platformRateBps: 3000}});
  assert.throws(() => settlementContractPayload({contractType: 'commission', platformRate: '200', feeRate: '1'}, 3), /0〜100%/);
  assert.deepEqual(versionFormDefaults(contracts[0]), {platformRate: '35', feeRate: '15', recoupBasis: 'platform_net', note: ''});
  assert.deepEqual(versionPayload({platformRate: '35', feeRate: '15', recoupBasis: 'after_fee', note: ' '}, 'mg'), {platformRateBps: 3500, agencyFeeBps: 1500, recoupBasis: 'after_fee', note: null});
  assert.deepEqual(versionPayload({platformRate: '35', feeRate: '', note: 'メモ'}, 'self_owned'), {platformRateBps: 3500, note: 'メモ'});
});

test('権利の調達: 媒体は流通区分マスタの流通名から選ぶ（会計上の区分は除く・以前の自由入力は残す）', () => {
  const types = [
    {code: 'H001', distribution_name: '配給'}, {code: 'H002', distribution_name: '配給'}, {code: 'H005', distribution_name: '配給_物販'},
    {code: 'D001', distribution_name: '配信'}, {code: 'K001', distribution_name: '相殺'}, {code: 'F001', distribution_name: '調整'},
    {code: 'P001', distribution_name: '製作委員会収入'}, {code: 'digital', label: '配信（旧）', legacy: 1},
  ];
  const options = mediaOptions(types);
  assert.deepEqual(options.map((o) => o.value), [ALL_MEDIA, '配給', '配給・物販', '配信']);
  assert.deepEqual(mediaOptions(types, '劇場・配信').at(-1), {value: '劇場・配信', label: '劇場・配信（以前の入力）'});
  assert.deepEqual(mediaOptions(types, '配信').map((o) => o.value), [ALL_MEDIA, '配給', '配給・物販', '配信']);
  // マスタが読めないときも基本の媒体を選べる
  assert.ok(mediaOptions([]).some((o) => o.value === '配信'));
  for (const option of options) assertJapanese(option.label, option.value);
});

test('権利の調達: 改訂版は前の版の入力を写し、金額・持分の書式の揺れを吸収して送る', () => {
  const source = {
    id: 5, case_code: 'W1-調達-01', snapshot_version: 1, title: '委員会', intake_type: 'committee',
    documents: [{title: '契約書', reference: '棚A', version_label: '第1版', content_hash: null}],
    scopes: [{channel: '配信', territory: '国内', rights_start: '2026-01-01', rights_end: '2030-12-31', exclusivity: 'exclusive'}],
    participants: [{party_kind: 'partner', partner_id: 3, role: '幹事', investment_yen: 5000000, explicit_share_bps: 6000}],
  };
  const form = intakeFormFromCase(source, [], (value) => (value === '国内' ? {select: '日本', other: ''} : {select: '__other__', other: value}));
  assert.equal(form.caseCode, 'W1-調達-01-版2');
  assert.equal(form.sourceCaseId, 5);
  assert.deepEqual(form.scopes[0], {channel: '配信', territory: '日本', territoryOther: '', rightsStart: '2026-01-01', rightsEnd: '2030-12-31', exclusivity: 'exclusive'});
  assert.deepEqual(form.participants[0], {partyKind: 'partner', partnerId: '3', role: '幹事', investmentYen: '5,000,000', explicitShare: '60'});
  const result = intakePayload({...form, participants: [{...form.participants[0], investmentYen: '５００万'.replace('万', '0000'), explicitShare: '６０％'}]}, 1, (scope) => scope.territory);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.participants[0], {partyKind: 'partner', partnerId: 3, role: '幹事', investmentYen: 5000000, explicitShareBps: 6000});
  assert.equal(result.payload.sourceCaseId, 5);
  assert.equal(result.payload.scopes[0].territory, '日本');
  const bad = intakePayload({...form, participants: [{...form.participants[0], explicitShare: '120'}], documents: [{contentHash: 'xyz'}], scopes: [{rightsStart: '2026-02-01', rightsEnd: '2026-01-01'}]}, 1);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 3);
  bad.errors.forEach((message) => assertJapanese(message, message));
});

test('調達案件の一覧の行: 状態は「下書き」、改訂元はコードで示す（IDを出さない）', () => {
  const rows = intakeRows([
    {id: 1, case_code: 'A-01', intake_type: 'committee', status: 'draft', inputComplete: false, missingFields: ['権利範囲'], settlementLinks: []},
    {id: 2, case_code: 'A-01-版2', intake_type: 'committee', status: 'draft', source_case_id: 1, inputComplete: true, missingFields: [], settlementLinks: [{contract_code: 'R-1', contract_title: '配信'}]},
  ]);
  assert.equal(rows[0].readiness, '不足・未確認 1件');
  assert.equal(rows[0].sourceText, '初版');
  assert.equal(rows[1].sourceText, 'A-01から改訂');
  assert.equal(rows[1].linksText, 'R-1｜配信');
  assert.equal(rows[1].statusText, '下書き');
  assert.equal(rows[1].typeText, '製作委員会');
});

test('サーバーの文言に残る英語のコード値を日本語に直す', () => {
  const cases = [
    ['platformRateBpsは0〜10000bpで明示してください', 'PF料率は0〜100%で明示してください'],
    ['締め日はeomまたは1〜31です', '締め日は月末または1〜31日です'],
    ['reportOffsetMonthsは0〜24か月です', '報告までの月数は0〜24か月です'],
    ['窓口先引きの基礎は窓口=platform_net、幹事=platform_netまたはafter_windowです', '窓口先引きの基礎は窓口=PF控除後、幹事=PF控除後または窓口手数料控除後です'],
    ['報告額基準をgrossまたはnetから選択してください', '報告額基準を控除前または控除後から選択してください'],
    ['調達入口はcommittee、sole_owned、entrustedから選択してください', '調達入口は製作委員会・単独保有・権利受託から選択してください'],
    ['端数期間です。契約上この端数期間を採用する場合だけallowStubを明示してください', '端数期間です。契約上この端数期間を採用する場合だけ「端数期間を採用する」に印を付けてください'],
    ['販路digitalの窓口条件がありません', '販路「配信」の窓口条件がありません'],
    ['invalid mg terms', 'MG調達型の条件が正しくありません。代理店手数料率と回収の基礎を選んでください'],
    ['JPY税抜の予定報告です。', '円・税抜の予定報告です。'],
    ['すべてdraftの入力スナップショットです。', 'すべて下書きの入力スナップショットです。'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(japaneseMessage(input), expected);
    assertJapanese(japaneseMessage(input), input);
  }
  assert.equal(japaneseMessage('作品の財務権限がありません'), '作品の財務権限がありません');
  assert.equal(japaneseMessage(null), '');
});

test('例外の文も日本語に直す（種類・状態・詳細は保つ。日本語だけの例外はそのまま）', () => {
  const error = new ApiError('invalid commission terms', {status: 409, kind: 'conflict', details: [{message: 'x'}]});
  const translated = translateError(error);
  assert.equal(translated.message, '手数料型の条件が正しくありません。代理店手数料率を入れ、MGの項目は空にしてください');
  assert.equal(translated.kind, 'conflict');
  assert.equal(translated.status, 409);
  assert.deepEqual(translated.details, [{message: 'x'}]);
  const japanese = new ApiError('作品の財務権限がありません', {status: 403, kind: 'forbidden'});
  assert.equal(translateError(japanese), japanese);
  assert.equal(translateError(new Error('reportDayはeomまたは1〜31です')).message, '報告予定日は月末または1〜31日です');
  assert.equal(translateError(null), null);
});

test('一意の違反は、API が載せた共通のエラーの種類（dbError）で日本語にする。DB の文（SQLite・PostgreSQL）では分岐しない（FR-CORE-DATA-016）', () => {
  // SQLite の文でも PostgreSQL の文でも、種類と列が同じなら同じ文になる
  for (const raw of ['UNIQUE constraint failed: settlement_contracts.org_id, settlement_contracts.contract_code', 'duplicate key value violates unique constraint "settlement_contracts_org_id_contract_code_key"']) {
    const coded = new ApiError(raw, {status: 409, kind: 'conflict', body: {ok: false, error: raw, dbError: {kind: 'unique', table: 'settlement_contracts', columns: ['org_id', 'contract_code']}}});
    assert.equal(translateError(coded).message, '同じコードが既に登録されています。別のコードにしてください');
    assert.equal(translateError(coded).status, 409);
    const other = new ApiError(raw, {status: 409, kind: 'conflict', body: {dbError: {kind: 'unique', table: 't', columns: ['org_id', 'title']}}});
    assert.equal(translateError(other).message, '同じ内容が既に登録されています');
  }
  // 種類が無い（文だけ）なら言い換えない。CHECK の違反は一意の文にしない
  const plain = new ApiError('UNIQUE constraint failed: t.code', {status: 409, kind: 'conflict'});
  assert.equal(translateError(plain), plain);
  const check = new ApiError('x', {status: 409, kind: 'conflict', body: {dbError: {kind: 'check', table: null, columns: []}}});
  assert.equal(translateError(check), check);
});
