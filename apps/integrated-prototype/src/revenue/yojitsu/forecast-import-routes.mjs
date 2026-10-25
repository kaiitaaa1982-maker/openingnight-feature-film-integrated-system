// 企画の試算の写しを、案件×月の予測の版として取り込む受け口（フェーズ1の仕様書 #13。要件 FR-REV-YOJITSU-023・026）。
// 本文は trials_snapshot.json の形の写し（snapshot）と、試算のファイル名の頭 → 案件コード（projects。build_yojitsu.py の「試算の案件」と同じ形）、
// 窓口の売上と出資を入れる区分マスタのコード（categories: {channel, investment}）、行の状態（status。既定は監督申告）、予測に使わない窓口の項目
// （excludedItems）。xlsx と Excel の COM は統合システムに持ち込まない（写しは代表の手元の extract_trials.ps1 が作る。U-3）。
// 財務の権限のある案件（管理者か、案件の編集の権限）にだけ足し、制作担当には開かない（FR-REV-YOJITSU-005）。読み方と照合は trial-import-model、
// 書き込みは revenue-store の addForecastVersions が全部の冊を1回の batch にまとめる（照合が合わない冊が1つでもあれば何も書かない）
import {listCashflowCategories, readProjectClassifications} from '../../planning/planning-store.mjs';
import {ASSUMPTION_STATUSES} from '../../planning/project/project-model.mjs';
import {FORECAST_BATCH_STATEMENTS, addForecastVersions, readForecastVersions} from '../revenue-store.mjs';
import {normalizeForecastVersionInput} from './forecast-model.mjs';
import {planTrialImport} from './trial-import-model.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const STALE = 'stale yojitsu forecast version';
// 版の番号の取り合いに負けた書き込み。SQLite・D1 は書き込みが直列なので版の番号のトリガーが stale の文で断り、PostgreSQL で同じ案件の版を
// 同時に足すと、両方のトリガーが番号の判定を通ったあと、一意の制約（組織・案件・版の番号）の違反で後の側が落ちる。どちらも同じ 409 にする
const lostVersionRace = (error) => (dbErrorKind(error) === 'raise' && error.message.includes(STALE)) || isUniqueViolation(error, 'yojitsu_forecast_versions');
const DEFAULT_STATUS = 'director_reported'; // 試算は監督の申告を含む見込み（ORG の予実管理表の状態「試算（監督申告を含む）」に当たる）
const MAX_EXCLUDED_ITEMS = 50;
// 取り込んだ日（日本の日付）。版の名前と作った日に使う
const todayJst = (now = new Date()) => new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export function registerForecastImportRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('forecast import routes require app, db, bad, body and permittedProjects');
  }

  app.post('/api/revenue/forecast-imports', async (c) => {
    const identity = c.get('identity');
    if (identity.role === 'production') return bad(c, 'この役割では予測を取り込めません', 403);
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const src = input && typeof input === 'object' ? input : {};
    const status = src.status ?? DEFAULT_STATUS;
    if (!ASSUMPTION_STATUSES.includes(status)) return bad(c, '行の状態は 確認済み・監督申告・報道値・仮置き のどれかです', 400);
    const excludedItems = src.excludedItems ?? [];
    if (!Array.isArray(excludedItems) || excludedItems.length > MAX_EXCLUDED_ITEMS || !excludedItems.every((x) => typeof x === 'string' && x.trim())) {
      return bad(c, `予測に使わない窓口の項目は、${MAX_EXCLUDED_ITEMS}個までの項目の名前で渡してください`, 400);
    }
    // 写しの冊が指す案件は、財務の権限のある案件だけ。権限の無い案件と別の組織の案件は、有無を見せず同じ 403 にする
    const projectByPrefix = src.projects && typeof src.projects === 'object' && !Array.isArray(src.projects) ? src.projects : {};
    const allowed = (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
    const projects = new Map((await readProjectClassifications(db, identity.org_id, allowed)).map((p) => [p.code, p]));
    const codes = [...new Set(Object.values(projectByPrefix))];
    if (codes.some((code) => !projects.has(code))) return bad(c, '試算を取り込む案件への権限がありません', 403);
    // 区分: 窓口の売上は入金の区分、出資は出金の区分（組織の区分マスタのコード）
    const categories = await listCashflowCategories(db, identity.org_id);
    const channel = categories.find((x) => x.code === src.categories?.channel && x.direction === 'in');
    const investment = categories.find((x) => x.code === src.categories?.investment && x.direction === 'out');
    if (!channel || !investment) return bad(c, '窓口の売上を入れる入金の区分と、出資を入れる出金の区分を、区分マスタのコードで選んでください', 400);
    const versions = await readForecastVersions(db, identity.org_id, codes.map((code) => Number(projects.get(code).id)));
    const existing = new Map(codes.map((code) => {
      const own = versions.filter((v) => Number(v.project_id) === Number(projects.get(code).id));
      return [code, {latestVersionNo: own.reduce((max, v) => Math.max(max, Number(v.version_no)), 0),
        sha256s: new Set(own.map((v) => v.source_sha256).filter(Boolean))}];
    }));
    const plan = planTrialImport(src.snapshot, {projectByPrefix, existing, createdOn: todayJst(), status, excludedItems: excludedItems.map((x) => x.trim()),
      categories: {channel: Number(channel.id), investment: Number(investment.id)}});
    if (plan.errors.length) return bad(c, '試算の写しを取り込めません（何も足していません）', 400, {errors: plan.errors, checks: plan.checks});
    const values = [];
    const imported = [];
    for (const v of plan.versions) {
      const project = projects.get(v.projectCode);
      const n = normalizeForecastVersionInput({...v, projectId: Number(project.id)}, {categories});
      if (!n.ok) return bad(c, `試算 ${v.name} の予測の行を読めません（何も足していません）`, 400, {errors: n.errors});
      values.push(n.value);
      imported.push({projectId: Number(project.id), projectCode: v.projectCode, book: v.name, versionNo: v.previousVersionNo + 1, label: v.label,
        lineCount: n.value.lines.length, sha256: v.sourceSha256});
    }
    try {
      const out = await addForecastVersions(db, identity.org_id, values, {createdBy: identity.user_id});
      if (!out.written) {
        return bad(c, `試算の行が多すぎて1回で取り込めません（保存の処理 ${out.statementCount}件・上限 ${FORECAST_BATCH_STATEMENTS}件）。冊を分けて取り込んでください`, 413);
      }
    } catch (error) {
      if (lostVersionRace(error)) return bad(c, 'ほかの画面で予測の版が足されました。読み直してから取り込んでください', 409, undefined, error);
      throw error;
    }
    return c.json({ok: true, imported, skipped: plan.skipped, checks: plan.checks}, imported.length ? 201 : 200);
  });
}
