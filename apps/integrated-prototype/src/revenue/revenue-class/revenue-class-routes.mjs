// 売上の4区分の受け口（フェーズ1の仕様書 #10b。要件 FR-REV-YOJITSU-022、FR-REV-CWORK-036）。財務の権限のある案件ごとに、
// 案件の型・稼ぎ方・契約から導いた4区分と使う売上率（理由つき）を返す。4区分は保存せず、読むたびに導く（U-9 の答え）。
// 入金の行の4区分の集計（summarizeRevenueClasses）は、入金を案件に結ぶ規則（フェーズ1 #14b）と予測の行（#13）が呼ぶ。ここは導いた結果だけ
import {readRevenueClassInputs} from '../../planning/planning-store.mjs';
import {REVENUE_CLASSES, revenueClassBases} from './revenue-class-model.mjs';

export function registerRevenueClassRoutes(app, {db, bad, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof permittedProjects !== 'function') throw new Error('revenue class routes require app, db, bad and permittedProjects');

  app.get('/api/revenue/revenue-classes', async (c) => {
    const identity = c.get('identity');
    if (identity.role === 'production') return bad(c, 'この役割では財務データを参照できません', 403);
    const projectIds = (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
    const inputs = await readRevenueClassInputs(db, identity.org_id, projectIds);
    // 型の無い案件（移行の前からある行）は、4区分を導く前の段なので返さない
    const registered = {...inputs, projects: inputs.projects.filter((p) => p.project_type !== null && p.project_type !== undefined)};
    const bases = [...revenueClassBases(registered).values()];
    return c.json({ok: true, classes: REVENUE_CLASSES, projects: bases});
  });
}
