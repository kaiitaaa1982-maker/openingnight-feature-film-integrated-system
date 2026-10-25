// 本人の倍率の受け口（行動指標の計画 段B #8。要件 kpi-scenario-forecast.md の FR-REV-KPI-013〜015、J-5 (a)・K2-12・K2-18）。
// GET /api/revenue/metrics/self-multiplier は、目標の版の持ち主（owner）本人にだけ、期間ごとの年の目標（本人・会社）の倍率と額、人件費、
// 年の粗利、本人の倍率（年の粗利÷年の報酬）を返す。本人以外は管理者も含めて 403 で、目標・報酬・倍率に由来する値を応答に入れない。
// 目標は目標の読み取り関数（readTargets）だけで読み、目標の版の表を名前で読まない。人件費は報酬の行（フェーズ1 #17）の12か月の合計、
// 年の粗利は5源泉の粗利の和（段B #2）で、どちらもまだ無いので null（未接続）。読むだけで書かない（audit_log も書かない）。
// 倍率を変える（目標の版を足す）受け口と画面は段B #8b（P1 #11 の設定の画面に欄を足す）
import {listPeriods, readAnnualCompensations, readTargets} from '../revenue-store.mjs';
import {ownedTargets, selfMultiplierView} from './self-multiplier-model.mjs';

export function registerSelfMultiplierRoutes(app, {db, bad}) {
  if (!app || !db || typeof bad !== 'function') throw new Error('self multiplier routes require app, db and bad');

  app.get('/api/revenue/metrics/self-multiplier', async (c) => {
    const identity = c.get('identity');
    if (identity.role === 'production') return bad(c, 'この役割では財務データを参照できません', 403);
    const periods = await listPeriods(db, identity.org_id);
    const targets = await readTargets(db, identity.org_id, {viewerUserId: identity.user_id});
    // 持ち主の判定を先に済ませ、本人以外には報酬を読みにいかない。目標の版が無いときも同じ 403（版の有無を本人以外に見せない）
    const owned = ownedTargets(targets);
    if (!owned.length) return bad(c, '本人の倍率と年の目標は、目標の版の持ち主（本人）だけが見られます', 403);
    const periodIds = [...new Set(owned.map((t) => t.periodId))];
    const annualCompensations = await readAnnualCompensations(db, identity.org_id, {ownerUserId: identity.user_id, periodIds});
    // 年の粗利（期間 → 円）は段B #2 の5源泉の合成が入ったらここで読む。それまでは空（どの期間も null＝未接続）
    const annualProfits = new Map();
    const {allowed, ...view} = selfMultiplierView({periods, targets, annualCompensations, annualProfits});
    return c.json({ok: true, ...view});
  });
}
