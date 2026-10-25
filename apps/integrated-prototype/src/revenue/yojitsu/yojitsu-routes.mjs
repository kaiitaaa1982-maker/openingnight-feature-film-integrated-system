// 予実の4段（目標→行動→予測→実績）と達成率・進みの受け口（フェーズ1の仕様書 #14。要件 FR-REV-YOJITSU-002・005・006・038・042）。
//   GET /api/revenue/yojitsu   入金ベース固定・税別の4段（月・1〜5年目・5年通算）と稼ぎ方ごとの段、行動の表、注記、照合、sourceHash
// - 予実は入金に固定する（D-039 の 2026-10-09 の追記3）。basis は受けず、accrual（cash 以外）を受けたら 400。cash は付けても同じ応答
// - 権限: 制作担当は 403。財務の権限がある案件（管理者は組織の全案件、編集担当は所属が edit の案件）の予測・入金・活動記録だけを読む。
//   財務の権限のある案件が1つも無い編集担当は 403（目標・計画も返さない）。組織は identity の org_id だけ（FR-REV-YOJITSU-005）
// - 目標は目標の読み取り関数（revenue-store の readTargets）、有効な計画は採用の記録の定義（readYojitsuSources の計画の文）で読み、
//   目標の額と目標に由来する値、第1版の計画とそれに由来する値は owner 本人にだけ返す（ほかの人には項目を残して null。FR-REV-YOJITSU-006）
// - SQL は readYojitsuSources の1回の読み取りの一括（9文）と readTargets（1文）の10本（FR-REV-YOJITSU-042。認証の文は数えない）
// - sourceHash は応答の中身（作った時刻を除く）の SHA-256。同じ入力・同じ読む人で同じ値（画面の data-ready の照合に使う）
// Worker でも動くよう node:* を import しない
import {readTargets, readYojitsuSources} from '../revenue-store.mjs';
import {revenueClassBases} from '../revenue-class/revenue-class-model.mjs';
import {countActivitySteps} from './activity-model.mjs';
import {linkReceiptsToProjects} from './receipt-inflow-model.mjs';
import {buildYojitsuView} from './yojitsu-model.mjs';

export function registerYojitsuRoutes(app, {db, bad, permittedProjectScope, sha256, canonical}) {
  if (!app || !db || typeof bad !== 'function' || typeof permittedProjectScope !== 'function' || typeof sha256 !== 'function' || typeof canonical !== 'function') {
    throw new Error('yojitsu routes require app, db, bad, permittedProjectScope, sha256 and canonical');
  }

  app.get('/api/revenue/yojitsu', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '予実は財務の画面です（制作担当は見られません）', 403);
    const basis = c.req.query('basis');
    if (basis !== undefined && basis !== 'cash') return bad(c, '予実の4段は入金ベース固定です（計上の基準では出しません）', 400, {field: 'basis'});
    const sources = await readYojitsuSources(db, identity.org_id, {scope: permittedProjectScope(identity, true), viewerUserId: identity.user_id});
    if (identity.role !== 'admin' && !sources.projects.length) return bad(c, '財務の権限がある案件がありません', 403);
    const targets = await readTargets(db, identity.org_id, {viewerUserId: identity.user_id});
    const view = buildYojitsuView({
      periods: sources.periods, targets, plans: sources.plans, settings: sources.settings, choices: sources.choices, earningTypes: sources.earningTypes,
      projects: sources.projects, bases: revenueClassBases(sources.revenueClassInputs), forecastSums: sources.forecastSums,
      inflows: linkReceiptsToProjects(sources.receiptLines, {projectIds: sources.projects.map((p) => p.id)}),
      activity: countActivitySteps(sources.activityTallies, {steps: sources.activitySteps, periods: sources.periods}),
    });
    const latestReceipt = sources.receiptLines.flatMap((row) => [row.received_on, row.reversed_on]).filter(Boolean)
      .reduce((latest, on) => (latest === null || on > latest ? on : latest), null);
    const dataAsOf = {label: '最後の入金', at: latestReceipt};
    const sourceHash = await sha256(canonical({...view, dataAsOf}));
    return c.json({ok: true, ...view, dataAsOf: {...dataAsOf, generatedAt: new Date().toISOString()}, sourceHash});
  });
}
