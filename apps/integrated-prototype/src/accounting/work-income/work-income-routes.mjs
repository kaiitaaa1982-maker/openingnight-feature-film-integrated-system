// 作品の月別収支の受け口（GET /api/analytics/income）。財務の権限で見てよい案件を決め、store で読み、model で配って並べる。
// 制作担当は使えない。権限の無い作品・読めない月・配賦の誤りは 403 で文言を返す。
// ?basis=accrual（既定。計上月）|cash（入金日・出金日の月。フェーズ1 #16）。ほかの値は400。応答に基準（basis・basisLabel）を付ける。
// 入金ベースの入金・出金の読み取りは pl-bs/pl-bs-data.mjs の loadCashSide、税抜への換算は reports/pl-bs-cash-model.mjs
import {integer, month} from '../../csv.mjs';
import {listWorkProjects, listActiveSaleLines, listProductWorkShares, listActiveExpenses} from '../accounting-store.mjs';
import {loadCashSide} from '../../pl-bs/pl-bs-data.mjs';
import {parseBasis, basisFields} from '../../reports/pl-bs-cash-model.mjs';
import {buildWorkIncome, buildWorkIncomeCash, permittedWorkIds} from './work-income-model.mjs';

export function registerWorkIncomeRoutes(app, {db, bad, permittedProjects}) {
  app.get('/api/analytics/income', async c => {
    const i = c.get('identity'); if (i.role === 'production') return bad(c, '収支への権限がありません', 403);
    const basisRead = parseBasis(c.req.query('basis'));
    if (!basisRead.ok) return bad(c, basisRead.error, 400, {field: 'basis'});
    const basis = basisRead.basis;
    try {
      const monthFilter = c.req.query('month') ? month(c.req.query('month')) : null, workFilter = c.req.query('workId') ? integer(c.req.query('workId')) : null;
      const projectIds = (await permittedProjects(db, i, true)).map(x => x.id);
      const works = await listWorkProjects(db, i.org_id);
      if (workFilter && !permittedWorkIds(works, projectIds).has(workFilter)) throw Error('作品への権限がありません');
      if (basis === 'cash') {
        const expenses = await listActiveExpenses(db, i.org_id, null);
        const cashSide = await loadCashSide(db, i.org_id);
        return c.json({ok: true, ...basisFields(basis), ...buildWorkIncomeCash({projectIds, works, expenses, cashSide, monthFilter, workFilter})});
      }
      const sales = await listActiveSaleLines(db, i.org_id, monthFilter);
      const mappings = await listProductWorkShares(db, i.org_id);
      const expenses = await listActiveExpenses(db, i.org_id, monthFilter);
      return c.json({ok: true, ...basisFields(basis), ...buildWorkIncome({projectIds, works, sales, mappings, expenses, monthFilter, workFilter})});
    } catch (e) { return bad(c, e.message, 403, undefined, e); }
  });
}
