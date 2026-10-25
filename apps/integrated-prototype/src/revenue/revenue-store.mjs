// 売上（revenue）の領域の DB の読み書き。いまは案件収支の予実の期間・目標の版・計画の版（ヘッダと稼ぎ方別の子表）・採用の記録・設定の行
// （移行 0014。フェーズ1の仕様書 #11）と、案件×月の予測の版・活動記録とその取消（移行 0015。#13）を置く。SQL と組織（org_id）の絞り込みと
// batch だけを持ち、有効な版の選び方・本人だけの額・月割り・行動の件数の数え方は model（yojitsu/ の *-model.mjs）に任せる。
// 指標マスタ（役×稼ぎ方×段の対応と出どころの状態。移行 0017。行動指標の計画 段B #9）の版もここに置き、有効な版の選び方と読む形は
// metrics/metric-master-model.mjs に任せる（段の率・1件の時間などの値は設定の行だけに持ち、指標マスタには持たない）。
// 目標の読み取りは readTargets の1つだけ（フェーズ1 #14・#15・#18a はこれ経由。FR-REV-YOJITSU-009）、計画の読み取りは readPlans。
// どちらも読む人（viewerUserId）を受け取り、額は owner 本人にだけ返す（FR-REV-YOJITSU-006）。財務の権限の確かめは受け口が先に済ませる。
// 書き込みは文を返す関数（*Statements）を1回の batch で書き、同じ batch で audit_log に1行残す（金額は残さない。docs/rules/logging.md）。
// 施策の受け口（フェーズ1 #12a）と採用（行動指標の計画 #12）は、この文をほかの store の文と1回の batch にまとめて書く。
// 語を選ぶ設定と月の設定（採用するシナリオなど。移行 0018）の読み書きと、予実の4段（#14）が読むものを1回の読み取りの一括（readYojitsuSources）で読む文も置く
import {allIn} from '../sql-in.mjs';
import {latestTargetIds, adoptedPlanVersionIds, latestSettings, settingValue, targetView, planView, latestChoices} from './yojitsu/yojitsu-model.mjs';
import {earningTypesWithDefaultRatesStatement, projectRevenueBasesStatement, revenueCategoryScope, revenueClassInputsFromRows} from '../planning/planning-store.mjs';
import {latestForecastVersionIds, forecastVersionView} from './yojitsu/forecast-model.mjs';
import {activityRecordView} from './yojitsu/activity-model.mjs';
import {effectiveMetricVersionId, metricMasterView} from './metrics/metric-master-model.mjs';

const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const audit = (orgId, userId, entityType, entityId, detail) => ({sql: AUDIT_INSERT, params: [orgId, userId, 'append', entityType, entityId, JSON.stringify(detail)]});

// ---------- 期間（1〜5年目・月初の日） ----------

// 期間を年目の順に足す文。periods は [{yearNo, startsOn}]（startsOn は月初の日。n年目は n−1年目の12か月後。DB のトリガーが断る）
export function periodStatements(orgId, periods, {createdBy}) {
  return [
    ...periods.map((p) => ({sql: 'INSERT INTO yojitsu_periods(org_id,year_no,starts_on,created_by) VALUES(?,?,?,?)', params: [orgId, p.yearNo, p.startsOn, createdBy]})),
    audit(orgId, createdBy, 'yojitsu_period', periods.map((p) => p.yearNo).join(','), {yearNos: periods.map((p) => p.yearNo)}),
  ];
}

export async function definePeriods(db, orgId, periods, {createdBy}) {
  await db.batch(periodStatements(orgId, periods, {createdBy}));
}

const PERIODS_SELECT = 'SELECT id,year_no,starts_on FROM yojitsu_periods WHERE org_id=? ORDER BY year_no';
const periodsFromRows = (rows) => rows.map((r) => ({id: Number(r.id), yearNo: Number(r.year_no), startsOn: r.starts_on}));

export async function listPeriods(db, orgId) {
  return periodsFromRows(await db.all(PERIODS_SELECT, [orgId]));
}

// ---------- 目標の版 ----------

const TARGET_INSERT = `INSERT INTO yojitsu_target_versions(org_id,period_id,target_kind,target_scope,version_no,basis_kind,amount_yen,multiplier_x100,
    source1_yen,source2_yen,source3_yen,source4_yen,source5_yen,unit,basis,status,decided_on,decided_by,owner_user_id,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

// 目標の版を1つ足す文（版の行と audit_log の1行）。target は normalizeTargetInput の value で、版の番号は画面が見ていた版の次
// （ほかの画面が先に足していれば DB の yojitsu_target_versions_sequence が断り、記録の行も入らない）。記録に額・倍率は入れない
export function targetVersionStatements(orgId, target, {createdBy}) {
  const versionNo = target.previousVersionNo + 1;
  return [
    {sql: TARGET_INSERT, params: [orgId, target.periodId, target.kind, target.scope, versionNo, target.basisKind, target.amountYen, target.multiplierX100,
      target.sources[1], target.sources[2], target.sources[3], target.sources[4], target.sources[5], target.unit, target.basis, target.status,
      target.decidedOn, target.decidedBy, target.ownerUserId, createdBy]},
    audit(orgId, createdBy, 'yojitsu_target_version', `${target.periodId}:${target.kind}:${target.scope}:${versionNo}`,
      {periodId: target.periodId, kind: target.kind, scope: target.scope, versionNo}),
  ];
}

export async function addTargetVersion(db, orgId, target, {createdBy}) {
  await db.batch(targetVersionStatements(orgId, target, {createdBy}));
  return target.previousVersionNo + 1;
}

// 1人（ownerUserId）の報酬の行（フェーズ1 #17。会計の報酬の表。月収・家賃補助・交通費の3種類。J-1 (a)）の、期間ごとの12か月の合計
// （期間の id → 円か null）。報酬の行は登録した本人だけが読むので、呼ぶ側は読む人本人の ID だけを渡す。報酬の表がまだ無いので、どの期間も null
// （未接続）。#17 が入ったら、ここで本人×期間の合計を1回の問い合わせで読む（期間ごと・目標ごとに読まない）。読み手は目標の読み取り関数
// （readTargets）と本人の倍率の API（行動指標の計画 段B #8。src/revenue/metrics/self-multiplier-routes.mjs）の2つで、ほかに足さない
export async function readAnnualCompensations(db, orgId, {ownerUserId, periodIds}) {
  return new Map(periodIds.map((id) => [Number(id), null]));
}

// 目標の読み取り関数（FR-REV-YOJITSU-009）。有効な目標（期間×種類×範囲ごとの最新の版）を返し、history なら改めた前の版も返す。
// 額は owner 本人にだけ返し、本人以外には項目を残して null にする。根拠が人件費×倍率の目標は、報酬の行が無い間は null（resolution 'unconnected'）。
// 報酬の行は読む人が owner の人件費×倍率の目標の期間だけを読み、本人以外の目標には渡さない。並びは 年目・種類（本人・会社）・範囲・版
export async function readTargets(db, orgId, {viewerUserId, history = false} = {}) {
  const rows = await db.all(`SELECT t.id,t.period_id,p.year_no,t.target_kind,t.target_scope,t.version_no,t.basis_kind,t.amount_yen,t.multiplier_x100,
      t.source1_yen,t.source2_yen,t.source3_yen,t.source4_yen,t.source5_yen,t.unit,t.basis,t.status,t.decided_on,t.decided_by,t.owner_user_id
    FROM yojitsu_target_versions t JOIN yojitsu_periods p ON p.org_id=t.org_id AND p.id=t.period_id
    WHERE t.org_id=? ORDER BY p.year_no,t.target_kind DESC,t.target_scope,t.version_no`, [orgId]);
  const effective = latestTargetIds(rows);
  const shown = rows.filter((row) => history || effective.has(Number(row.id)));
  const ownLabor = (row) => row.basis_kind === 'labor_cost_multiple' && viewerUserId !== null && viewerUserId !== undefined
    && Number(row.owner_user_id) === Number(viewerUserId);
  const periodIds = [...new Set(shown.filter(ownLabor).map((row) => Number(row.period_id)))];
  const compensations = periodIds.length ? await readAnnualCompensations(db, orgId, {ownerUserId: viewerUserId, periodIds}) : new Map();
  return shown.map((row) => targetView(row, {viewerUserId, effective: effective.has(Number(row.id)),
    annualCompensationYen: ownLabor(row) ? compensations.get(Number(row.period_id)) ?? null : null}));
}

// ---------- 計画の版と採用の記録 ----------

const PLAN_INSERT = `INSERT INTO yojitsu_plan_versions(org_id,period_id,version_no,owner_user_id,earning_type_count,status,basis,created_on,created_by)
  VALUES(?,?,?,?,?,?,?,?,?)`;
const PLAN_ID = '(SELECT v.id FROM yojitsu_plan_versions v WHERE v.org_id=? AND v.period_id=? AND v.version_no=?)';
const ADOPTION_INSERT = `INSERT INTO plan_adoptions(org_id,period_id,seq,plan_version_id,adopted_on,created_by)
  VALUES(?,?,(SELECT COALESCE(MAX(a.seq),0)+1 FROM plan_adoptions a WHERE a.org_id=? AND a.period_id=?),${PLAN_ID},?,?)`;

// 版を採用する文（採用の記録の1行と audit_log の1行）。「戻す」は古い版の番号でこれを書く。連番は DB の最新の次
export function planAdoptionStatements(orgId, {periodId, versionNo, adoptedOn}, {createdBy}) {
  return [
    {sql: ADOPTION_INSERT, params: [orgId, periodId, orgId, periodId, orgId, periodId, versionNo, adoptedOn, createdBy]},
    audit(orgId, createdBy, 'plan_adoption', `${periodId}:${versionNo}`, {periodId, versionNo}),
  ];
}

// 計画の版を1つ足して採用する文（ヘッダ・稼ぎ方別の子表・採用の記録・audit_log。第1版も採用の記録を1行書く。FR-REV-YOJITSU-011・012）。
// plan は {periodId, previousVersionNo, ownerUserId, status, basis, createdOn, adoptedOn, amounts:[{earningType, amountYen}]}。
// 版の番号は画面が見ていた版の次。記録に額は入れない
export function planVersionStatements(orgId, plan, {createdBy}) {
  const versionNo = plan.previousVersionNo + 1;
  return [
    {sql: PLAN_INSERT, params: [orgId, plan.periodId, versionNo, plan.ownerUserId, plan.amounts.length, plan.status, plan.basis ?? null, plan.createdOn, createdBy]},
    ...plan.amounts.map((a) => ({sql: `INSERT INTO yojitsu_plan_amounts(org_id,plan_version_id,earning_type,amount_yen) VALUES(?,${PLAN_ID},?,?)`,
      params: [orgId, orgId, plan.periodId, versionNo, a.earningType, a.amountYen]})),
    audit(orgId, createdBy, 'yojitsu_plan_version', `${plan.periodId}:${versionNo}`, {periodId: plan.periodId, versionNo, earningTypeCount: plan.amounts.length}),
    ...planAdoptionStatements(orgId, {periodId: plan.periodId, versionNo, adoptedOn: plan.adoptedOn}, {createdBy}),
  ];
}

export async function addPlanVersion(db, orgId, plan, {createdBy}) {
  await db.batch(planVersionStatements(orgId, plan, {createdBy}));
  return plan.previousVersionNo + 1;
}

export async function adoptPlanVersion(db, orgId, adoption, {createdBy}) {
  await db.batch(planAdoptionStatements(orgId, adoption, {createdBy}));
}

// 計画の読み取り（FR-REV-YOJITSU-011〜013）。有効な計画（期間ごとの最新の採用の記録が指す版）を返し、history なら採用していない版・改めた前の版も返す。
// 稼ぎ方別の額は稼ぎ方の参照表の並び。第1版の額は owner 本人にだけ返す（model の planView）。並びは 年目・版
export async function readPlans(db, orgId, {viewerUserId, history = false} = {}) {
  const [versions, amounts, adoptions] = await db.readBatch([
    {sql: `SELECT v.id,v.period_id,p.year_no,v.version_no,v.owner_user_id,v.status,v.basis,v.created_on
      FROM yojitsu_plan_versions v JOIN yojitsu_periods p ON p.org_id=v.org_id AND p.id=v.period_id WHERE v.org_id=? ORDER BY p.year_no,v.version_no`, params: [orgId]},
    {sql: `SELECT a.plan_version_id,a.earning_type,a.amount_yen FROM yojitsu_plan_amounts a JOIN earning_types e ON e.code=a.earning_type
      WHERE a.org_id=? ORDER BY a.plan_version_id,e.sort_order`, params: [orgId]},
    {sql: 'SELECT period_id,seq,plan_version_id FROM plan_adoptions WHERE org_id=?', params: [orgId]},
  ]);
  const effective = adoptedPlanVersionIds(adoptions);
  const byVersion = new Map();
  for (const a of amounts) {
    const id = Number(a.plan_version_id);
    if (!byVersion.has(id)) byVersion.set(id, []);
    byVersion.get(id).push(a);
  }
  return versions.filter((v) => history || effective.has(Number(v.id)))
    .map((v) => planView(v, byVersion.get(Number(v.id)) ?? [], {viewerUserId, effective: effective.has(Number(v.id))}));
}

// 有効な計画だけを1つの問い合わせで読む文（予実の4段の読み取りの一括に入れる。readPlans の history なしと同じ定義: 期間ごとの最新の seq の
// 採用の記録が指す版。FR-REV-YOJITSU-012）。行は版×稼ぎ方（稼ぎ方の参照表の並び）で、effectivePlansFromRows が版ごとの planView にする
const EFFECTIVE_PLANS_SELECT = `SELECT v.id,v.period_id,p.year_no,v.version_no,v.owner_user_id,v.status,v.basis,v.created_on,a.earning_type,a.amount_yen
    FROM plan_adoptions pa
    JOIN yojitsu_plan_versions v ON v.org_id=pa.org_id AND v.id=pa.plan_version_id
    JOIN yojitsu_periods p ON p.org_id=v.org_id AND p.id=v.period_id
    JOIN yojitsu_plan_amounts a ON a.org_id=v.org_id AND a.plan_version_id=v.id
    JOIN earning_types e ON e.code=a.earning_type
    WHERE pa.org_id=? AND pa.seq=(SELECT MAX(x.seq) FROM plan_adoptions x WHERE x.org_id=pa.org_id AND x.period_id=pa.period_id)
    ORDER BY p.year_no,e.sort_order`;

function effectivePlansFromRows(rows, {viewerUserId}) {
  const versions = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!versions.has(id)) versions.set(id, {version: row, amounts: []});
    versions.get(id).amounts.push(row);
  }
  return [...versions.values()].map(({version, amounts}) => planView(version, amounts, {viewerUserId, effective: true}));
}

// 有効な計画（期間ごとの最新の採用の記録が指す版）を1つの問い合わせで読む。readPlans(…, {history: false}) と同じ値（試験で照らす）
export async function readEffectivePlans(db, orgId, {viewerUserId} = {}) {
  return effectivePlansFromRows(await db.all(EFFECTIVE_PLANS_SELECT, [orgId]), {viewerUserId});
}

// ---------- 設定の行（行動の率・1件あたりの額など） ----------

// 設定の変数（参照表。値の列の種類とステップの要否）
export async function listSettingVariables(db) {
  return db.all('SELECT code,label,value_kind,per_step,sort_order FROM yojitsu_variables ORDER BY sort_order,code');
}

const SETTING_INSERT = `INSERT INTO yojitsu_setting_versions(org_id,variable_key,scope,earning_type,step,project_id,channel_code,version_no,
    value_bps,value_x100,value_months,value_yen,status,basis,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

// 設定の行を1つ足す文（版の行と audit_log の1行）。setting は {variableKey, scope, earningType, step, projectId, channelCode, previousVersionNo,
// value: {kind, value}, status, basis}。値の列は value.kind の1つだけを埋める（種類が変数と違えば DB が断る）。記録に値は入れない
export function settingVersionStatements(orgId, setting, {createdBy}) {
  const versionNo = setting.previousVersionNo + 1;
  const column = (kind) => (setting.value.kind === kind ? setting.value.value : null);
  const slot = [setting.variableKey, setting.scope, setting.earningType ?? '', setting.step ?? '', setting.projectId ?? '', setting.channelCode ?? ''].join(':');
  return [
    {sql: SETTING_INSERT, params: [orgId, setting.variableKey, setting.scope, setting.earningType ?? null, setting.step ?? null, setting.projectId ?? null,
      setting.channelCode ?? null, versionNo, column('bps'), column('x100'), column('months'), column('yen'), setting.status, setting.basis ?? null, createdBy]},
    audit(orgId, createdBy, 'yojitsu_setting_version', `${slot}:${versionNo}`, {variableKey: setting.variableKey, scope: setting.scope, versionNo}),
  ];
}

export async function addSettingVersion(db, orgId, setting, {createdBy}) {
  await db.batch(settingVersionStatements(orgId, setting, {createdBy}));
  return setting.previousVersionNo + 1;
}

const SETTINGS_SELECT = `SELECT s.variable_key,s.scope,s.earning_type,s.step,s.project_id,s.channel_code,s.version_no,
      s.value_bps,s.value_x100,s.value_months,s.value_yen,s.status,s.basis
    FROM yojitsu_setting_versions s JOIN yojitsu_variables v ON v.code=s.variable_key
    LEFT JOIN earning_types e ON e.code=s.earning_type LEFT JOIN action_steps st ON st.code=s.step
    WHERE s.org_id=?
    ORDER BY v.sort_order,COALESCE(e.sort_order,-1),COALESCE(st.sort_order,-1),COALESCE(s.project_id,-1),COALESCE(s.channel_code,''),s.version_no`;
const effectiveSettingsFromRows = (rows) => latestSettings(rows).map((r) => ({variableKey: r.variable_key, scope: r.scope, earningType: r.earning_type ?? null,
  step: r.step ?? null, projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id), channelCode: r.channel_code ?? null,
  versionNo: Number(r.version_no), value: settingValue(r), status: r.status, basis: r.basis ?? null}));

// 有効な設定の行（変数×範囲ごとの最新の版）。並びは 変数の並び・稼ぎ方の並び・ステップの並び・案件・窓口（範囲で使わない列は先）
export async function readEffectiveSettings(db, orgId) {
  return effectiveSettingsFromRows(await db.all(SETTINGS_SELECT, [orgId]));
}

// ---------- 語を選ぶ設定と月の設定（移行 0018。フェーズ1 #14。採用するシナリオ・月別の表に入れる案件の範囲・締めた月） ----------

const CHOICE_INSERT = 'INSERT INTO yojitsu_choice_versions(org_id,choice_key,version_no,value_code,value_month,basis,created_by) VALUES(?,?,?,?,?,?,?)';
const CHOICES_SELECT = 'SELECT choice_key,version_no,value_code,value_month FROM yojitsu_choice_versions WHERE org_id=? ORDER BY choice_key,version_no';

// 設定の版を1つ足す文（版の行と audit_log の1行）。choice は yojitsu-model の normalizeChoiceInput の value。版の番号は画面が見ていた版の次
// （ほかの画面が先に足していれば DB の yojitsu_choice_versions_sequence が断り、記録の行も入らない）
export function choiceVersionStatements(orgId, choice, {createdBy}) {
  const versionNo = choice.previousVersionNo + 1;
  return [
    {sql: CHOICE_INSERT, params: [orgId, choice.choiceKey, versionNo, choice.valueCode, choice.valueMonth, choice.basis ?? null, createdBy]},
    audit(orgId, createdBy, 'yojitsu_choice_version', `${choice.choiceKey}:${versionNo}`, {choiceKey: choice.choiceKey, versionNo}),
  ];
}

export async function addChoiceVersion(db, orgId, choice, {createdBy}) {
  await db.batch(choiceVersionStatements(orgId, choice, {createdBy}));
  return choice.previousVersionNo + 1;
}

// 有効な設定（設定ごとの最新の版）。{adoptedScenario, monthlyScope, closedMonth} の値と版の番号で、無いものは null
export async function readEffectiveChoices(db, orgId) {
  return latestChoices(await db.all(CHOICES_SELECT, [orgId]));
}

// ---------- 指標マスタ（移行 0017。行動指標の計画 段B #9） ----------

const METRIC_VERSION_INSERT = 'INSERT INTO kpi_metric_versions(org_id,version_no,step_count,basis,created_on,created_by) VALUES(?,?,?,?,?,?)';
const METRIC_STEP_INSERT = `INSERT INTO kpi_metric_steps(org_id,metric_version_id,role,earning_type,seq,step,status,basis)
  VALUES(?,(SELECT v.id FROM kpi_metric_versions v WHERE v.org_id=? AND v.version_no=?),?,?,?,?,?,?)`;

// 指標マスタの版を1つ足す文（ヘッダ・段の行・audit_log の1行。1回の batch で書く）。master は metric-master-model の normalizeMetricMasterInput の value で、
// 版の番号は画面が見ていた版の次（ほかの画面が先に足していれば DB の kpi_metric_versions_sequence が断り、段の行も入らない）。
// 段の行は役×稼ぎ方ごとに seq の順（DB の kpi_metric_steps_in_order）。文の数は段の数＋2 で、D1 の1回の batch（480文）に収まる（段は200まで）
export function metricMasterVersionStatements(orgId, master, {createdBy}) {
  const versionNo = master.previousVersionNo + 1;
  const steps = master.chains.flatMap((chain) => chain.steps.map((s) => ({role: chain.role, earningType: chain.earningType, ...s})));
  return [
    {sql: METRIC_VERSION_INSERT, params: [orgId, versionNo, steps.length, master.basis ?? null, master.createdOn, createdBy]},
    ...steps.map((s) => ({sql: METRIC_STEP_INSERT, params: [orgId, orgId, versionNo, s.role, s.earningType, s.seq, s.step, s.status, s.basis ?? null]})),
    audit(orgId, createdBy, 'kpi_metric_version', String(versionNo), {versionNo, stepCount: steps.length}),
  ];
}

export async function addMetricMasterVersion(db, orgId, master, {createdBy}) {
  await db.batch(metricMasterVersionStatements(orgId, master, {createdBy}));
  return master.previousVersionNo + 1;
}

// 指標マスタの読み取り（FR-REV-KPI-019）。有効な版（段の行がそろった版のうち最新の version_no）を返し、history なら前の版と、
// 段の行が欠けた版（effective 偽）も返す。版が無ければ空の配列。並びは 版の番号、版の中は 役・稼ぎ方・seq の順（model の metricMasterView）
export async function readMetricMaster(db, orgId, {history = false} = {}) {
  const [versions, steps] = await db.readBatch([
    {sql: 'SELECT id,version_no,step_count,basis,created_on FROM kpi_metric_versions WHERE org_id=? ORDER BY version_no', params: [orgId]},
    {sql: `SELECT m.metric_version_id,m.role,m.earning_type,m.seq,m.step,m.status,m.basis,st.label AS step_label,st.parent_code,
        e.label AS earning_label,e.profit_source,e.sort_order AS earning_sort_order
      FROM kpi_metric_steps m JOIN action_steps st ON st.code=m.step JOIN earning_types e ON e.code=m.earning_type
      WHERE m.org_id=? ORDER BY m.metric_version_id,m.role,m.earning_type,m.seq`, params: [orgId]},
  ]);
  const effective = effectiveMetricVersionId(versions, steps);
  const byVersion = new Map();
  for (const row of steps) {
    const id = Number(row.metric_version_id);
    if (!byVersion.has(id)) byVersion.set(id, []);
    byVersion.get(id).push(row);
  }
  return versions.filter((v) => history || Number(v.id) === effective)
    .map((v) => metricMasterView(v, byVersion.get(Number(v.id)) ?? [], {effective: Number(v.id) === effective}));
}

// ---------- 案件×月の予測の版（移行 0015。フェーズ1 #13） ----------

// D1 の上限: 1文の値は100個まで・1回の batch は480文まで（README の「売上基幹の架空データ」・src/import/limits.mjs）。
// 予測の行は12列なので、1文に8行ずつまとめて入れる
export const FORECAST_BATCH_STATEMENTS = 480;
const MAX_BOUND_VALUES = 100;
const FORECAST_VERSION_INSERT = `INSERT INTO yojitsu_forecast_versions(org_id,project_id,version_no,label,source_kind,source,source_sha256,line_count,created_on,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?)`;
const FORECAST_LINE_COLUMNS = ['org_id', 'project_id', 'version_no', 'line_no', 'scenario', 'forecast_month', 'category_id', 'item', 'counterparty',
  'amount_yen', 'status', 'use_for_forecast'];
const LINES_PER_STATEMENT = Math.floor(MAX_BOUND_VALUES / FORECAST_LINE_COLUMNS.length);

// 予測の版を1つ足す文（版の行・予測の行・audit_log の1行。1回の batch で書く）。version は forecast-model の normalizeForecastVersionInput の value で、
// 版の番号は画面が見ていた版の次（ほかの画面・取り込みが先に足していれば DB の yojitsu_forecast_versions_sequence が断り、ほかの行も入らない）。
// 記録に金額は入れない（docs/rules/logging.md）
export function forecastVersionStatements(orgId, version, {createdBy}) {
  const versionNo = version.previousVersionNo + 1;
  const marks = `(${FORECAST_LINE_COLUMNS.map(() => '?').join(',')})`;
  const lineStatements = [];
  for (let start = 0; start < version.lines.length; start += LINES_PER_STATEMENT) {
    const chunk = version.lines.slice(start, start + LINES_PER_STATEMENT);
    lineStatements.push({sql: `INSERT INTO yojitsu_forecast_lines(${FORECAST_LINE_COLUMNS.join(',')}) VALUES ${chunk.map(() => marks).join(',')}`,
      params: chunk.flatMap((l) => [orgId, version.projectId, versionNo, l.lineNo, l.scenario, l.month, l.categoryId, l.item, l.counterparty ?? null,
        l.amountYen, l.status, l.useForForecast ? 1 : 0])});
  }
  return [
    {sql: FORECAST_VERSION_INSERT, params: [orgId, version.projectId, versionNo, version.label, version.sourceKind, version.source, version.sourceSha256 ?? null,
      version.lines.length, version.createdOn, createdBy]},
    ...lineStatements,
    audit(orgId, createdBy, 'yojitsu_forecast_version', `${version.projectId}:${versionNo}`,
      {projectId: version.projectId, versionNo, sourceKind: version.sourceKind, lineCount: version.lines.length}),
  ];
}

// 1つの版は D1 の1回の batch に収まる（forecast-model の MAX_FORECAST_LINES が (480 - 2) × 8 行）。入力の読み取りを通らない版で超えたら書かずに止める
export async function addForecastVersion(db, orgId, version, {createdBy}) {
  const statements = forecastVersionStatements(orgId, version, {createdBy});
  if (statements.length > FORECAST_BATCH_STATEMENTS) throw new Error(`予測の版の行が多すぎます（保存の処理 ${statements.length}件・上限 ${FORECAST_BATCH_STATEMENTS}件）`);
  await db.batch(statements);
  return version.previousVersionNo + 1;
}

// いくつかの案件の予測の版を1回の batch で足す（試算の写しの取り込み。どれかが断られたら何も残らない）。
// 文の数が D1 の1回の batch の上限を超えるときは書かずに {written: false} を返す（受け口が 413 にする）
export async function addForecastVersions(db, orgId, versions, {createdBy}) {
  const statements = versions.flatMap((version) => forecastVersionStatements(orgId, version, {createdBy}));
  if (statements.length > FORECAST_BATCH_STATEMENTS) return {written: false, statementCount: statements.length};
  if (statements.length) await db.batch(statements);
  return {written: true, statementCount: statements.length};
}

// 案件ごとの予測の版のヘッダ（全部の版。案件・版の番号の順）。projectIds は受け口が財務の権限で絞った案件の ID（組織の外の ID は org_id で落ちる）。
// stored_line_count は DB にある行の数（line_count に満たない版は有効な予測にしない。forecast-model の latestForecastVersionIds）
export async function readForecastVersions(db, orgId, projectIds) {
  return allIn(db, `SELECT v.id,v.project_id,v.version_no,v.label,v.source_kind,v.source,v.source_sha256,v.line_count,v.created_on,v.created_by,
      (SELECT COUNT(*) FROM yojitsu_forecast_lines l WHERE l.org_id=v.org_id AND l.project_id=v.project_id AND l.version_no=v.version_no) AS stored_line_count
    FROM yojitsu_forecast_versions v WHERE v.org_id=? AND v.project_id IN (:in)`, {before: [orgId], ids: projectIds,
    sortBy: (a, b) => Number(a.project_id) - Number(b.project_id) || Number(a.version_no) - Number(b.version_no)});
}

// 予測の読み取り（FR-REV-YOJITSU-023）。有効な予測（案件ごとの最新の版）を返し、history なら前の版も返す（前の版の行は used が偽＝予測に使う いいえ）。
// 形は forecast-model の forecastVersionView。並びは 案件・版、行は行の番号の順
export async function readForecasts(db, orgId, projectIds, {history = false} = {}) {
  const versions = await readForecastVersions(db, orgId, projectIds);
  const effective = latestForecastVersionIds(versions);
  const shown = versions.filter((v) => history || effective.has(Number(v.id)));
  // 前の版の行は history のときだけ読む
  const latestOnly = history ? '' : ' AND l.version_no=(SELECT MAX(x.version_no) FROM yojitsu_forecast_versions x WHERE x.org_id=l.org_id AND x.project_id=l.project_id)';
  const lines = await allIn(db, `SELECT l.project_id,l.version_no,l.line_no,l.scenario,l.forecast_month,l.category_id,l.item,l.counterparty,l.amount_yen,l.status,l.use_for_forecast
    FROM yojitsu_forecast_lines l WHERE l.org_id=? AND l.project_id IN (:in)${latestOnly}`, {before: [orgId], ids: shown.map((v) => Number(v.project_id))});
  const byVersion = new Map();
  for (const l of lines) {
    const key = `${l.project_id}:${l.version_no}`;
    if (!byVersion.has(key)) byVersion.set(key, []);
    byVersion.get(key).push(l);
  }
  return shown.map((v) => forecastVersionView(v, (byVersion.get(`${v.project_id}:${v.version_no}`) ?? []).sort((a, b) => Number(a.line_no) - Number(b.line_no)),
    {effective: effective.has(Number(v.id))}));
}

// ---------- 活動記録（移行 0015。フェーズ1 #13） ----------

const ACTIVITY_INSERT = `INSERT INTO yojitsu_activity_records(org_id,project_id,occurred_on,earning_type,step,counterparty,summary,deliverable,next_action,next_due_on,
    result,work_id,source_sales_activity_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`;

// 活動記録の audit_log の1行。対象は足した行の id（同じ batch の中で、記録した人の最後の行）で、案件・ステップ・行の中身は残さない
// （audit_log は管理者が読めるので、本人以外に「どの案件で・どのステップの行動をしたか」を見せない。FR-REV-YOJITSU-037）。
// D1 は batch を1つずつ流すので、直前に足した行を指す。PostgreSQL で同じ人の2つの書き込みが重なったときは、後に確定した行の id になりうる
const ACTIVITY_AUDIT = `INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json)
  SELECT ?,?,'append','yojitsu_activity_record',CAST(MAX(a.id) AS TEXT),'{}' FROM yojitsu_activity_records a WHERE a.org_id=? AND a.created_by=?`;

// 活動記録を1行足す文（行と audit_log の1行）。record は activity-model の normalizeActivityInput の value、記録した人は受け口が identity から渡す。
// 施策の受け口（フェーズ1 #12a）は、この文を案件・予測の文と1回の batch にまとめて書く（行の文のすぐあとに audit の文を置く）
export function activityRecordStatements(orgId, record, {createdBy}) {
  return [
    {sql: ACTIVITY_INSERT, params: [orgId, record.projectId, record.occurredOn, record.earningType ?? null, record.step ?? null, record.counterparty ?? null,
      record.summary, record.deliverable ?? null, record.nextAction ?? null, record.nextDueOn ?? null, record.result, record.workId ?? null,
      record.sourceSalesActivityId ?? null, createdBy]},
    {sql: ACTIVITY_AUDIT, params: [orgId, createdBy, orgId, createdBy]},
  ];
}

// 活動記録を1行足し、その id を返す
export async function addActivityRecord(db, orgId, record, {createdBy}) {
  const out = await db.batch(activityRecordStatements(orgId, record, {createdBy}));
  return Number(out[0].rows[0].id);
}

// 活動記録を取り消す（取消の行と audit_log の1行）。取り消せるのは記録した人だけ（DB の yojitsu_activity_cancellations_recorder_only）
export async function cancelActivityRecord(db, orgId, {activityId, cancelledOn, reason}, {createdBy}) {
  await db.batch([
    {sql: 'INSERT INTO yojitsu_activity_cancellations(org_id,activity_id,cancelled_on,reason,created_by) VALUES(?,?,?,?,?)', params: [orgId, activityId, cancelledOn, reason, createdBy]},
    audit(orgId, createdBy, 'yojitsu_activity_cancellation', String(activityId), {activityId}),
  ]);
}

// 活動記録の行（FR-REV-YOJITSU-035・037）。行動履歴を会社の人に見せるかの裁定（R4）まで、記録した人（viewerUserId）の本人の行だけを返す
// （取り消した行も、取り消した日と理由を付けて返す）。projectIds は受け口が財務の権限で絞った案件の ID。並びは 日付・id
export async function readActivityRecords(db, orgId, projectIds, {viewerUserId}) {
  if (viewerUserId === null || viewerUserId === undefined) return [];
  const rows = await allIn(db, `SELECT a.id,a.project_id,a.occurred_on,a.earning_type,a.step,a.counterparty,a.summary,a.deliverable,a.next_action,a.next_due_on,
      a.result,a.work_id,a.source_sales_activity_id,a.created_by,c.cancelled_on,c.reason AS cancel_reason
    FROM yojitsu_activity_records a LEFT JOIN yojitsu_activity_cancellations c ON c.org_id=a.org_id AND c.activity_id=a.id
    WHERE a.org_id=? AND a.created_by=? AND a.project_id IN (:in)`, {before: [orgId, viewerUserId], ids: projectIds,
    sortBy: (x, y) => (x.occurred_on < y.occurred_on ? -1 : x.occurred_on > y.occurred_on ? 1 : Number(x.id) - Number(y.id))});
  return rows.map(activityRecordView);
}

// 行動の実績件数の元（FR-REV-YOJITSU-017・029）。行の中身を出さず、案件×稼ぎ方（行の稼ぎ方、空なら案件の稼ぎ方）×ステップ×月（YYYY-MM）の件数と、
// そのうち成果物のある件数だけを返す（記録した人を問わず数える。予実の画面の「行動の実績件数」は本人以外にも見える。要件の受け入れシナリオ8）。
// 取り消した行は数えない。数え方（細目の段を親へ畳む・期間に割り当てる）は activity-model の countActivitySteps・engagedProjectCounts
export async function readActivityTallies(db, orgId, projectIds) {
  return allIn(db, `SELECT a.project_id,COALESCE(a.earning_type,p.earning_type) AS earning_type,a.step,substr(a.occurred_on,1,7) AS month,
      COUNT(*) AS n,SUM(CASE WHEN a.deliverable IS NULL THEN 0 ELSE 1 END) AS with_deliverable
    FROM yojitsu_activity_records a JOIN projects p ON p.org_id=a.org_id AND p.id=a.project_id
    WHERE a.org_id=? AND a.project_id IN (:in)
      AND NOT EXISTS(SELECT 1 FROM yojitsu_activity_cancellations c WHERE c.org_id=a.org_id AND c.activity_id=a.id)
    GROUP BY a.project_id,COALESCE(a.earning_type,p.earning_type),a.step,substr(a.occurred_on,1,7)`, {before: [orgId], ids: projectIds,
    sortBy: (x, y) => Number(x.project_id) - Number(y.project_id) || (x.month < y.month ? -1 : x.month > y.month ? 1 : 0)
      || String(x.step ?? '').localeCompare(String(y.step ?? ''))});
}

// ---------- 営業の活動の取り込み（行動指標の計画 段B #10。K2-15） ----------

// 取り込みの元（FR-REV-KPI-020・FR-REV-YOJITSU-035）: 見てよい案件（scope。受け口が渡す副問い合わせ）の sales_activities の全部の行と、商談の段階・
// 取引先の名前、記録された結果、取り込み済みならその活動記録の id（imported_id）。結果未記録の行は取り込まない。
// sales_activities・sales_opportunities・partners はまだ領域フォルダへ移していない古い形の表。行の中身は受け口が件数にしてから返す
export async function readSalesActivityImportRows(db, orgId, {scope}) {
  if (!scope || typeof scope.sql !== 'string' || !Array.isArray(scope.params)) throw new Error('readSalesActivityImportRows は見てよい案件の副問い合わせ（scope）で呼んでください');
  return db.all(`SELECT s.id,s.project_id,s.work_id,s.opportunity_id,o.stage AS opportunity_stage,pt.name AS partner_name,s.occurred_on,s.activity_type,
      s.summary,s.next_action,s.next_due_on,s.created_by,s.result,a.id AS imported_id
    FROM sales_activities s
    JOIN sales_opportunities o ON o.org_id=s.org_id AND o.id=s.opportunity_id
    LEFT JOIN partners pt ON pt.org_id=s.org_id AND pt.id=s.partner_id
    LEFT JOIN yojitsu_activity_records a ON a.org_id=s.org_id AND a.source_sales_activity_id=s.id
    WHERE s.org_id=? AND s.project_id IN (${scope.sql})
    ORDER BY s.opportunity_id,s.occurred_on,s.id`, [orgId, ...scope.params]);
}

// 取り込んだ行の audit_log。対象は足した行の id（元の行の id で引く。組織の中で1行だけ）で、取り込んだ人を残し、案件・ステップ・行の中身は残さない
// （FR-REV-YOJITSU-037。活動記録を1行足すときの ACTIVITY_AUDIT と同じ範囲）
const ACTIVITY_IMPORT_AUDIT = `INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json)
  SELECT ?,?,'import','yojitsu_activity_record',CAST(a.id AS TEXT),'{}' FROM yojitsu_activity_records a WHERE a.org_id=? AND a.source_sales_activity_id=?`;
// 1行に2文（行と audit_log）なので、D1 の1回の batch（480文）に240行まで
export const ACTIVITY_IMPORT_BATCH_ROWS = Math.floor(FORECAST_BATCH_STATEMENTS / 2);

// 取り込む行を足す（activity-import-model の planSalesActivityImport の records。記録した人は元の行を記録した人、取り込んだ人は importedBy）。
// 240行ごとの batch で足し、batch の中は全部か無しか。途中の batch で落ちても前の batch の行は残り、もう一度流すと残りだけを足す
// （元の行の id は組織の中で UNIQUE なので、同時に流した後の側は一意の違反で落ちる）。返り値は足した行の数
export async function importActivityRecords(db, orgId, records, {importedBy}) {
  let written = 0;
  for (let start = 0; start < records.length; start += ACTIVITY_IMPORT_BATCH_ROWS) {
    const part = records.slice(start, start + ACTIVITY_IMPORT_BATCH_ROWS);
    await db.batch(part.flatMap((record) => [
      activityRecordStatements(orgId, record, {createdBy: record.createdBy})[0],
      {sql: ACTIVITY_IMPORT_AUDIT, params: [orgId, importedBy, orgId, record.sourceSalesActivityId]},
    ]));
    written += part.length;
  }
  return written;
}

// 集計専用。相手・活動本文・次の一手は返さず、取消していない活動の結果だけを読む。
export async function readActivityOutcomeRows(db, orgId, {scope}) {
  if (!scope || typeof scope.sql !== 'string' || !Array.isArray(scope.params)) throw new Error('活動結果の集計には案件の権限範囲が必要です');
  return db.all(`SELECT a.id,a.project_id,COALESCE(a.earning_type,p.earning_type) AS earning_type,a.step,a.occurred_on,a.result
    FROM yojitsu_activity_records a JOIN projects p ON p.org_id=a.org_id AND p.id=a.project_id
    WHERE a.org_id=? AND a.project_id IN (${scope.sql})
      AND NOT EXISTS(SELECT 1 FROM yojitsu_activity_cancellations c WHERE c.org_id=a.org_id AND c.activity_id=a.id)
    ORDER BY a.occurred_on,a.id`, [orgId, ...scope.params]);
}
// 締めた月の版の履歴（新しい順）。根拠（basis）に予実管理のフォルダが「締め・戻し・足りないもの・理由」を書く
export async function readClosedMonthHistory(db, orgId) {
  const rows = await db.all(`SELECT version_no,value_month,basis,created_at FROM yojitsu_choice_versions WHERE org_id=? AND choice_key='closed_month' ORDER BY version_no DESC`, [orgId]);
  return rows.map((r) => ({versionNo: Number(r.version_no), closedMonth: r.value_month, basis: r.basis ?? null, createdAt: r.created_at ?? null}));
}

// 予実管理のフォルダの「行」の印（plans/2026-10-22-folder-yojitsu.md）。結果欄が空の営業の活動を、見てよい案件の範囲で活動日の月ごとに数える。
// 営業の活動の正本は営業管理（sales_activities）。予実は数えるだけ
export async function readEmptySalesResultsByMonth(db, orgId, {scope}) {
  if (!scope || typeof scope.sql !== 'string' || !Array.isArray(scope.params)) throw new Error('結果が空の活動の集計には案件の権限範囲が必要です');
  const rows = await db.all(`SELECT substr(a.occurred_on,1,7) AS month,COUNT(*) AS count FROM sales_activities a
    WHERE a.org_id=? AND a.result IS NULL AND a.project_id IN (${scope.sql})
    GROUP BY substr(a.occurred_on,1,7) ORDER BY substr(a.occurred_on,1,7)`, [orgId, ...scope.params]);
  return rows.map((r) => ({month: r.month, count: Number(r.count)}));
}

// ---------- 予実の4段が読むもの（フェーズ1 #14。FR-REV-YOJITSU-042 の「予実の API の SQL を10本以内」） ----------

// 有効な予測の版（案件ごとの最新の版。行がそろっていない版は有効にしない）の、予測に使う・売上の元になる入金の区分の行を、
// 案件×月×シナリオで足した額。有効な版の決まりは forecast-model の latestForecastVersionIds と同じ（試験で readForecasts と照らす）
function forecastRevenueSumsStatement(orgId, scope) {
  const categories = revenueCategoryScope(orgId);
  return {sql: `SELECT l.project_id,l.forecast_month,l.scenario,SUM(l.amount_yen) AS amount_yen,COUNT(*) AS line_count
    FROM yojitsu_forecast_lines l
    JOIN yojitsu_forecast_versions v ON v.org_id=l.org_id AND v.project_id=l.project_id AND v.version_no=l.version_no
    WHERE l.org_id=? AND l.project_id IN (${scope.sql}) AND l.use_for_forecast=1 AND l.category_id IN (${categories.sql})
      AND v.version_no=(SELECT MAX(x.version_no) FROM yojitsu_forecast_versions x WHERE x.org_id=v.org_id AND x.project_id=v.project_id)
      AND v.line_count=(SELECT COUNT(*) FROM yojitsu_forecast_lines y WHERE y.org_id=v.org_id AND y.project_id=v.project_id AND y.version_no=v.version_no)
    GROUP BY l.project_id,l.forecast_month,l.scenario
    ORDER BY l.project_id,l.forecast_month,l.scenario`, params: [orgId, ...scope.params, ...categories.params]};
}

// 行動の実績件数の元（readActivityTallies と同じ数え方に、ステップの親〈細目の段を面談・提案・契約へ畳む〉を足した形。行の中身は出さない）
function activityTalliesStatement(orgId, scope) {
  return {sql: `SELECT a.project_id,COALESCE(a.earning_type,p.earning_type) AS earning_type,a.step,st.parent_code AS step_parent,substr(a.occurred_on,1,7) AS month,
      COUNT(*) AS n,SUM(CASE WHEN a.deliverable IS NULL THEN 0 ELSE 1 END) AS with_deliverable
    FROM yojitsu_activity_records a JOIN projects p ON p.org_id=a.org_id AND p.id=a.project_id
    LEFT JOIN action_steps st ON st.code=a.step
    WHERE a.org_id=? AND a.project_id IN (${scope.sql})
      AND NOT EXISTS(SELECT 1 FROM yojitsu_activity_cancellations c WHERE c.org_id=a.org_id AND c.activity_id=a.id)
    GROUP BY a.project_id,COALESCE(a.earning_type,p.earning_type),a.step,st.parent_code,substr(a.occurred_on,1,7)
    ORDER BY a.project_id,substr(a.occurred_on,1,7),a.step`, params: [orgId, ...scope.params]};
}

// 入金を案件に結ぶ元の行（消込×請求明細×作品の配賦。入金日・取消日・消込の額・請求の税込額・請求の取引先・明細の税抜額・作品の案件）。
// 見てよい案件の作品を1つでも含む請求の消込だけを読み、ほかの案件の分は receipt-inflow-model の linkReceiptsToProjects が落とす
// （請求明細の作品の配賦を全部読まないと、明細の税抜額を作品へ分けられない）。請求・入金の表はまだ領域フォルダへ移していない古い形の表。
// 予実の4段（readYojitsuSources）と会社への利益額（accounting-store の readProfitSources。フェーズ1 #14b）が同じ文で読む。
// months（{from, to}。YYYY-MM）を渡すと、入金日か取消日の月がその間に入る入金の消込だけを読む（入金の行ごとに絞るので、同じ入金の明細・配賦はそろって読む）
export function receiptLinesStatement(orgId, scope, months = null) {
  const period = months ? `
      AND (substr(r.received_on,1,7) BETWEEN ? AND ? OR substr(x.reversed_on,1,7) BETWEEN ? AND ?)` : '';
  return {sql: `SELECT a.receipt_id,r.received_on,x.reversed_on,a.invoice_id,a.amount_yen AS allocated_yen,i.amount_inc_tax AS invoice_inc_tax,i.partner_id AS invoice_partner_id,
      l.sale_id,l.amount_ex_tax AS line_ex_tax,lw.work_id,lw.allocation_bps,w.project_id
    FROM billing_receipt_allocations a
    JOIN billing_receipts r ON r.org_id=a.org_id AND r.id=a.receipt_id
    JOIN billing_invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id
    JOIN billing_invoice_lines l ON l.org_id=a.org_id AND l.invoice_id=a.invoice_id
    JOIN billing_invoice_line_works lw ON lw.org_id=l.org_id AND lw.invoice_id=l.invoice_id AND lw.sale_id=l.sale_id
    JOIN works w ON w.org_id=lw.org_id AND w.id=lw.work_id
    LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id
    WHERE a.org_id=? AND a.invoice_id IN (SELECT z.invoice_id FROM billing_invoice_line_works z JOIN works zw ON zw.org_id=z.org_id AND zw.id=z.work_id
      WHERE z.org_id=? AND zw.project_id IN (${scope.sql}))${period}
    ORDER BY a.receipt_id,a.invoice_id,l.sale_id,lw.work_id`, params: [orgId, orgId, ...scope.params, ...(months ? [months.from, months.to, months.from, months.to] : [])]};
}

// 予実の4段が読むもの（目標を除く）を1回の読み取りの一括（9文。同じ時点）で読む。目標は目標の読み取り関数 readTargets（1文）で別に読む。
// scope は受け口が渡す「財務の権限で見てよい案件」の副問い合わせ（src/app.mjs の permittedProjectScope(identity, true)）。
// 計画の額は owner 本人にだけ返す（第1版。planView）。返り値の形は src/revenue/yojitsu/yojitsu-routes.mjs が model へ渡す形
export async function readYojitsuSources(db, orgId, {scope, viewerUserId}) {
  if (!scope || typeof scope.sql !== 'string' || !Array.isArray(scope.params)) throw new Error('readYojitsuSources は見てよい案件の副問い合わせ（scope）で呼んでください');
  const [periodRows, settingRows, choiceRows, earningTypeRows, planRows, projectRows, forecastRows, tallyRows, receiptRows] = await db.readBatch([
    {sql: PERIODS_SELECT, params: [orgId]},
    {sql: SETTINGS_SELECT, params: [orgId]},
    {sql: CHOICES_SELECT, params: [orgId]},
    earningTypesWithDefaultRatesStatement(orgId),
    {sql: EFFECTIVE_PLANS_SELECT, params: [orgId]},
    projectRevenueBasesStatement(orgId, scope),
    forecastRevenueSumsStatement(orgId, scope),
    activityTalliesStatement(orgId, scope),
    receiptLinesStatement(orgId, scope),
  ]);
  const steps = new Map();
  for (const row of tallyRows) if (row.step !== null && row.step !== undefined) steps.set(row.step, {code: row.step, parent_code: row.step_parent ?? null});
  return {
    periods: periodsFromRows(periodRows),
    settings: effectiveSettingsFromRows(settingRows),
    choices: latestChoices(choiceRows),
    earningTypes: earningTypeRows,
    plans: effectivePlansFromRows(planRows, {viewerUserId}),
    projects: projectRows.map((p) => ({id: Number(p.id), code: p.code, title: p.title, earning_type: p.earning_type ?? null, stage_code: p.stage_code ?? null,
      probability_bps: p.probability_bps === null || p.probability_bps === undefined ? null : Number(p.probability_bps)})),
    revenueClassInputs: revenueClassInputsFromRows({earningTypeRows, projectRows}),
    forecastSums: forecastRows.map((r) => ({project_id: Number(r.project_id), forecast_month: r.forecast_month, scenario: r.scenario, amount_yen: Number(r.amount_yen),
      line_count: Number(r.line_count)})),
    activityTallies: tallyRows,
    activitySteps: [...steps.values()],
    receiptLines: receiptRows,
  };
}
