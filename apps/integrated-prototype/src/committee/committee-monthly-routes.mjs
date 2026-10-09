// 製作委員会の月次収支のAPIと、窓口手数料の取り分の登録。
// 設計: docs/platform/team-development/royalty-committee-design.md §4。Worker でも動くよう node:* を import しない。
//   GET  /api/reports/committee-monthly?workId&from&to[&contractId]  作品の月次収支（読むだけ。保存済みの期間報告は変えない）
//        集計する契約は作品の最後に登録した委員会契約（ロイヤリティの発生額の本委員会収入と同じ契約）。contractId はその確認用で、
//        ほかの契約を指定すると409（権利処理費の基礎と本委員会収入が別の契約になるのを防ぐ）。
//        売上明細・本委員会収入は1回だけ読み、ロイヤリティの発生額（権利処理費）と分け合う（withSharedReads）。
//   GET  /api/reports/committee-monthly/works                         月次収支を出せる作品（委員会契約があり、財務権限がある作品）
//   GET  /api/committee/windows/:windowId/fee-shares                  窓口手数料の取り分（未登録なら窓口の受取先1社が100%）
//   POST /api/committee/windows/:windowId/fee-shares                  取り分を1回だけ登録（合計10000bp・参加者のみ・理由必須）
// 制作担当（role production）は403。作品の財務権限（settlementWork）が要る。問い合わせはすべて組織（identity.org_id）で絞る。
import {isDbConflict} from '../data-platform/db-errors.mjs';
import {loadCommitteeTerms, loadCommitteeIncome, BASIS_SOURCES, HOLD_REASONS, COMMITTEE_INCOME_VERSION} from './committee-income.mjs';
import {buildCommitteeMonthly, checksOk, royaltyCategoryLabel, channelLabel, WINDOW_KIND_LABELS, MAX_PERIOD_MONTHS} from './committee-monthly-model.mjs';
import {withSharedReads} from '../sales/channel-group.mjs';
import {loadRoyaltyAccruals} from '../royalty/royalty-loader.mjs';
import {fiscalSetting} from '../reporting-annual.mjs';
import {allIn} from '../sql-in.mjs';
import {DISTRIBUTION_TYPE_LABELS_SQL} from '../distribution-label.mjs';
import {monthsBetween} from '../ui/condition-model.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_FEE_SHARE_ROWS = 50;

export const REPORT_NOTES = Object.freeze([
  '計上月・税抜。売上は商品の作品配賦で作品へ割り当てた額（帳票センターの年間売上・作品別収支と同じ数え方）です。',
  '計算順: 売上 → PF控除 → 窓口手数料・幹事手数料（窓口の控除順のとおり）→ 本委員会収入 → 経費 → 権利処理費 → 分配原資 → 出資比率で分配。',
  '手数料は、PF控除を売上報告×計上月×流通の区分ごと、窓口手数料・幹事手数料を計上月×流通の区分ごとに計算し、1円未満を切り捨てます（保存済みの期間報告と同じ料率・控除順・基礎）。',
  '窓口: 劇場→劇場（配給）、レンタル・セル・区分未確認のビデオグラム→ビデオグラム、配信→配信、放送→放送、海外・その他→その他の窓口の料率で計算します（表示は流通の区分のまま）。',
  '分配原資の累計が負のあいだは分配しません（累計の分配可能額＝累計が正の分、月の分配額＝その増分）。これは帳票上の扱いで、保存済みの期間報告は変えません。',
  '出資者への分配・窓口手数料の取り分は、月ごとに持分で配分し、端数は最大剰余法（余りの大きい順、同じなら参加者の並び順）で割り当てます。',
  '経費は作品に直接付いた経費（税抜）をすべて委員会の経費として差し引きます。権利処理費はロイヤリティの発生額（計上月）です。',
  '条件版は計上月ごとに、その月に効いている版（適用開始月がその月以前の版のうち最新の版。適用開始月の無い版は最初の月から）の窓口・料率・持分・窓口手数料の取り分・幹事で計算します。',
]);
export const NO_ROYALTY_NOTE = 'この作品にはロイヤリティ契約が登録されていないため、権利処理費を計上していません（分配原資は権利処理費を引く前の額です）。監督料・脚本料などの契約がある場合は、ロイヤリティ契約を登録してください。';

function parseId(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const basisText = (basis) => (basis === 'net' ? '控除後' : '控除前');

export function registerCommitteeMonthlyRoutes(app, ctx) {
  const {db, bad, body, settlementWork, permittedProjects} = ctx;
  const denied = (i) => !i || i.role === 'production';

  app.get('/api/reports/committee-monthly/works', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '製作委員会の月次収支は財務担当の帳票です', 403);
    try {
      const projects = new Set((await permittedProjects(db, i, true)).map((row) => row.id));
      const rows = await db.all(`SELECT w.id, w.project_id, w.code, w.title, COUNT(c.id) AS contract_count, MAX(c.id) AS latest_contract_id
          FROM works w JOIN committee_contracts c ON c.org_id=w.org_id AND c.work_id=w.id
          WHERE w.org_id=? GROUP BY w.id, w.project_id, w.code, w.title ORDER BY w.code, w.id`, [i.org_id]);
      const works = rows.filter((row) => projects.has(row.project_id))
        .map((row) => ({id: row.id, code: row.code, title: row.title, contractCount: Number(row.contract_count), latestContractId: row.latest_contract_id}));
      return c.json({ok: true, works});
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });

  app.get('/api/reports/committee-monthly', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '製作委員会の月次収支は財務担当の帳票です', 403);
    const rawWork = c.req.query('workId');
    if (!rawWork) return bad(c, '作品を選んでください');
    const workId = parseId(rawWork);
    if (!workId) return bad(c, '作品の指定を読み取れません');
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!MONTH.test(from || '') || !MONTH.test(to || '')) return bad(c, '期間（from・to）を「2026-05」の形で指定してください');
    if (from > to) return bad(c, '期間の開始月が終了月より後になっています');
    if (monthsBetween(from, to).length > MAX_PERIOD_MONTHS) return bad(c, `期間は${MAX_PERIOD_MONTHS}か月以内にしてください`);
    const rawContract = c.req.query('contractId');
    const contractId = rawContract ? parseId(rawContract) : null;
    if (rawContract && !contractId) return bad(c, '委員会契約の指定を読み取れません');
    try {
      const work = await settlementWork(i, workId);
      if (!work) return bad(c, '作品の財務権限がありません', 403);
      // 1回の要求の中で、売上明細・本委員会収入・委員会の条件をロイヤリティの発生額と分け合う
      const shared = withSharedReads(db);
      const terms = await loadCommitteeTerms(shared, i.org_id, [workId]);
      const term = terms.get(workId);
      if (!term) return bad(c, 'この作品には製作委員会の契約が登録されていません', 404);
      if (contractId && term.contract.id !== contractId) {
        if (!term.contracts.some((row) => row.id === contractId)) return bad(c, '指定した委員会契約はこの作品のものではありません', 404);
        return bad(c, `委員会の月次収支は、作品の最後に登録した委員会契約（${term.contract.code}）で集計します。権利処理費（ロイヤリティの発生額）の基礎も同じ契約の本委員会収入のため、ほかの契約は指定できません`, 409);
      }
      if (!term.version) return bad(c, '委員会契約に条件版がありません。製作委員会の画面で条件を登録してください', 409);
      const income = await loadCommitteeIncome(shared, i, {workIds: [workId], from: '0000-01', to}, ctx);
      const [workRow, accrualRows, royaltyAgreements, fiscal, types, partnerRows, latest] = await Promise.all([
        db.get('SELECT id, code, title FROM works WHERE org_id=? AND id=?', [i.org_id, workId]),
        loadRoyaltyAccruals(shared, i, {workIds: [workId], from: '0000-01', to}, ctx),
        db.get('SELECT COUNT(*) AS n FROM royalty_agreements WHERE org_id=? AND work_id=?', [i.org_id, workId]),
        fiscalSetting(db, i.org_id),
        db.all(DISTRIBUTION_TYPE_LABELS_SQL),
        db.all('SELECT id, code, name FROM partners WHERE org_id=?', [i.org_id]),
        db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active' AND kind<>'publicity'", [i.org_id]),
      ]);
      const accruals = (Array.isArray(accrualRows) ? accrualRows : []).filter((row) => Number(row.workId) === workId && MONTH.test(row.accrualMonth || '') && row.accrualMonth <= to);
      const {rows: incomeRows, lines, expenses, expenseLines} = income;
      const agreementCount = Number(royaltyAgreements?.n || 0);
      const report = buildCommitteeMonthly({
        from, to, fiscalStartMonth: fiscal.fiscalStartMonth,
        incomeRows, expenses, accruals, lines, expenseLines,
        members: term.members, windows: term.windows, feeShares: term.feeShares, managerPartnerId: term.version.managerPartnerId, investments: term.investments,
        versions: term.versions,
      });
      const inPeriod = (month) => month >= from && month <= to;
      const periodLines = lines.filter((line) => inPeriod(line.accountingMonth));
      const details = periodLines.length ? await allIn(db, 'SELECT id, description, source_row, sales_period_from, sales_period_to FROM sale_lines WHERE org_id=? AND id IN (:in)',
        {before: [i.org_id], ids: periodLines.map((line) => line.saleId)}) : [];
      const detailOf = new Map(details.map((row) => [row.id, row]));
      const partnerName = new Map(partnerRows.map((row) => [row.id, row.name]));
      const typeLabel = new Map(types.map((row) => [row.code, row.label]));
      const windowLabel = new Map(report.windows.map((window) => [window.id, window.label]));
      return c.json({
        ok: true,
        work: {id: workRow.id, code: workRow.code, title: workRow.title},
        contract: term.contract, contracts: term.contracts,
        term: {
          versionId: term.version.id, versionNo: term.version.versionNo, versionCount: term.version.versionCount, note: term.version.note,
          effectiveFrom: term.version.effectiveFrom, managerPartnerId: term.version.managerPartnerId, managerName: term.version.managerName,
          members: term.members, windows: report.windows.filter((window) => window.versionId === term.version.id), funding: term.funding, investments: term.investments,
        },
        // 条件版ごとの適用開始月と、この帳票でその版を使った月（累計の対象の月のうち）。窓口はその版のもの
        versions: term.versions.map((version) => {
          const used = report.versions.find((item) => item.id === version.id) || {};
          return {id: version.id, versionNo: version.versionNo, effectiveFrom: version.effectiveFrom, managerPartnerId: version.managerPartnerId, managerName: version.managerName,
            note: version.note, monthCount: used.monthCount || 0, periodMonthCount: used.periodMonthCount || 0, firstMonth: used.firstMonth || null, lastMonth: used.lastMonth || null,
            windows: report.windows.filter((window) => window.versionId === version.id)};
        }),
        royalty: {agreementCount, note: agreementCount ? null : NO_ROYALTY_NOTE},
        conditions: {workId, from, to, contractId: term.contract.id},
        fiscal: {fiscalStartMonth: fiscal.fiscalStartMonth, confirmed: fiscal.confirmed},
        report,
        checksOk: checksOk(report.checks),
        incomeRows: incomeRows.filter((row) => inPeriod(row.month)).map((row) => ({
          ...row, windowKindLabel: WINDOW_KIND_LABELS[row.windowKind] || row.windowKind, holdText: row.hold ? HOLD_REASONS[row.hold] || '保留' : null,
        })),
        lines: periodLines.map((line) => {
          const detail = detailOf.get(line.saleId);
          return {
            saleId: line.saleId, reportId: line.reportId, reportKey: line.reportKey, accountingMonth: line.accountingMonth, amount: line.amount, allocationBps: line.allocationBps,
            partnerId: line.partnerId, partnerName: partnerName.get(line.partnerId) || null, description: detail?.description ?? null, sourceRow: detail?.source_row ?? null,
            salesPeriodFrom: detail?.sales_period_from ?? null, salesPeriodTo: detail?.sales_period_to ?? null,
            channelGroup: line.channelGroup, channelLabel: channelLabel(line.channelGroup), distributionCode: line.distributionCode,
            distributionLabel: line.distributionCode ? typeLabel.get(line.distributionCode) || line.distributionCode : null, territory: line.territory,
            windowKind: line.windowKind, windowLabel: line.windowId ? windowLabel.get(line.windowId) : null, termVersionNo: line.termVersionNo ?? null,
            basis: line.basis, basisText: basisText(line.basis),
            basisSource: line.basisSource, basisSourceText: BASIS_SOURCES[line.basisSource] || line.basisSource, hold: line.hold, holdText: line.hold ? HOLD_REASONS[line.hold] : null,
          };
        }),
        expenseLines: expenseLines.filter((row) => inPeriod(row.month)),
        accruals: accruals.filter((row) => inPeriod(row.accrualMonth)).map((row) => ({...row, categoryLabel: royaltyCategoryLabel(row.category)})),
        dataAsOf: {latestImportAt: latest?.at || null, generatedAt: new Date().toISOString()},
        calculationVersion: {income: COMMITTEE_INCOME_VERSION, monthly: report.calculationVersion},
        notes: agreementCount ? REPORT_NOTES : [...REPORT_NOTES, NO_ROYALTY_NOTE],
        scope: '読むだけの集計です。保存済みの委員会の期間報告（スナップショット）の計算・金額は変えません。',
      });
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });

  async function windowFor(i, windowId) {
    return db.get(`SELECT w.id, w.term_version_id, w.kind, w.label, w.window_partner_id, v.contract_id, v.version_no, c.work_id, c.contract_code, c.title AS contract_title,
        p.name AS window_partner_name,
        (SELECT MAX(x.version_no) FROM committee_term_versions x WHERE x.org_id=v.org_id AND x.contract_id=v.contract_id) AS latest_version_no
      FROM committee_term_windows w
      JOIN committee_term_versions v ON v.org_id=w.org_id AND v.id=w.term_version_id
      JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id
      JOIN partners p ON p.org_id=w.org_id AND p.id=w.window_partner_id
      WHERE w.org_id=? AND w.id=?`, [i.org_id, windowId]);
  }
  async function feeShareState(i, window) {
    const [members, shares] = await Promise.all([
      db.all(`SELECT m.partner_id, m.share_bps, m.member_order, p.name, p.code FROM committee_term_members m JOIN partners p ON p.org_id=m.org_id AND p.id=m.partner_id
        WHERE m.org_id=? AND m.term_version_id=? ORDER BY m.member_order`, [i.org_id, window.term_version_id]),
      db.all(`SELECT s.partner_id, s.share_bps, s.reason, s.created_at, p.name, u.display_name AS created_by_name
        FROM committee_term_window_fee_shares s JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id LEFT JOIN users u ON u.id=s.created_by
        WHERE s.org_id=? AND s.window_id=? ORDER BY s.partner_id`, [i.org_id, window.id]),
    ]);
    const registered = shares.length > 0;
    const orderOf = new Map(members.map((row) => [row.partner_id, row.member_order]));
    const list = shares.map((row) => ({partnerId: row.partner_id, name: row.name, shareBps: row.share_bps, reason: row.reason, createdAt: row.created_at, createdByName: row.created_by_name || null}))
      .sort((a, b) => (orderOf.get(a.partnerId) ?? 999) - (orderOf.get(b.partnerId) ?? 999) || a.partnerId - b.partnerId);
    return {
      window: {id: window.id, kind: window.kind, kindLabel: WINDOW_KIND_LABELS[window.kind] || window.kind, label: window.label,
        windowPartnerId: window.window_partner_id, windowPartnerName: window.window_partner_name, termVersionId: window.term_version_id,
        versionNo: window.version_no, isLatestVersion: window.version_no === window.latest_version_no, contractId: window.contract_id,
        contractCode: window.contract_code, contractTitle: window.contract_title, workId: window.work_id},
      registered,
      shares: list,
      effective: registered ? list.map(({partnerId, name, shareBps}) => ({partnerId, name, shareBps, default: false}))
        : [{partnerId: window.window_partner_id, name: window.window_partner_name, shareBps: 10000, default: true}],
      candidates: members.map((row) => ({partnerId: row.partner_id, name: row.name, code: row.code, shareBps: row.share_bps, memberOrder: row.member_order})),
    };
  }

  app.get('/api/committee/windows/:windowId/fee-shares', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '制作担当は窓口手数料の取り分を参照できません', 403);
    const windowId = parseId(c.req.param('windowId'));
    if (!windowId) return bad(c, '窓口の指定を読み取れません');
    try {
      const window = await windowFor(i, windowId);
      if (!window) return bad(c, '窓口が見つかりません', 404);
      if (!await settlementWork(i, window.work_id)) return bad(c, '作品の財務権限がありません', 403);
      return c.json({ok: true, ...(await feeShareState(i, window))});
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });

  app.post('/api/committee/windows/:windowId/fee-shares', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '制作担当は窓口手数料の取り分を登録できません', 403);
    const windowId = parseId(c.req.param('windowId'));
    if (!windowId) return bad(c, '窓口の指定を読み取れません');
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    try {
      const window = await windowFor(i, windowId);
      if (!window) return bad(c, '窓口が見つかりません', 404);
      if (!await settlementWork(i, window.work_id)) return bad(c, '作品の財務権限がありません', 403);
      const errors = [];
      const reason = String(input?.reason ?? '').trim();
      if (!reason) errors.push({field: 'reason', message: '登録の理由（契約書の条項など）を入れてください'});
      else if (reason.length > 500) errors.push({field: 'reason', message: '理由は500文字以内にしてください'});
      const raw = Array.isArray(input?.shares) ? input.shares : [];
      if (!raw.length) errors.push({field: 'shares', message: '取り分を1社以上入れてください'});
      if (raw.length > MAX_FEE_SHARE_ROWS) errors.push({field: 'shares', message: `取り分は${MAX_FEE_SHARE_ROWS}社以内にしてください`});
      const state = await feeShareState(i, window);
      const candidates = new Map(state.candidates.map((row) => [row.partnerId, row]));
      const shares = [];
      const seen = new Set();
      raw.slice(0, MAX_FEE_SHARE_ROWS).forEach((row, index) => {
        const partnerId = typeof row?.partnerId === 'number' ? row.partnerId : parseId(row?.partnerId);
        const shareBps = typeof row?.shareBps === 'number' ? row.shareBps : Number(String(row?.shareBps ?? '').trim() || NaN);
        if (!Number.isSafeInteger(partnerId) || partnerId < 1) { errors.push({row: index + 1, field: 'partnerId', message: `${index + 1}行目: 受取先を選んでください`}); return; }
        if (seen.has(partnerId)) { errors.push({row: index + 1, field: 'partnerId', message: `${index + 1}行目: 同じ受取先が重なっています`}); return; }
        seen.add(partnerId);
        if (!candidates.has(partnerId) && partnerId !== window.window_partner_id) errors.push({row: index + 1, field: 'partnerId', message: `${index + 1}行目: 受取先は、この条件版の委員会の参加者から選んでください`});
        if (!Number.isInteger(shareBps) || shareBps < 1 || shareBps > 10000) errors.push({row: index + 1, field: 'shareBps', message: `${index + 1}行目: 取り分は0.01%〜100%で入れてください`});
        shares.push({partnerId, shareBps});
      });
      const total = shares.reduce((sum, row) => sum + (Number.isInteger(row.shareBps) ? row.shareBps : 0), 0);
      if (raw.length && total !== 10000) errors.push({field: 'shares', message: `取り分の合計を100%にしてください（いまは${(total / 100).toLocaleString('ja-JP', {maximumFractionDigits: 2})}%）`});
      if (errors.length) return bad(c, errors.map((error) => error.message).join(' ／ '), 400, {errors});
      if (state.registered) return bad(c, 'この窓口の取り分は登録済みです。変える場合は、製作委員会の画面で新しい条件版を「取り分を引き継がない」で作り（変える月を適用開始月にします）、その版の窓口に登録してください', 409);
      const statements = shares.map((row) => ({
        sql: 'INSERT INTO committee_term_window_fee_shares(org_id, window_id, partner_id, share_bps, reason, created_by) VALUES(?,?,?,?,?,?)',
        params: [i.org_id, windowId, row.partnerId, row.shareBps, reason, i.user_id],
      }));
      statements.push({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
        params: [i.org_id, i.user_id, 'create', 'committee_window_fee_shares', String(windowId), JSON.stringify({windowId, termVersionId: window.term_version_id, workId: window.work_id, shares, reason})]});
      try {
        await db.batch(statements);
      } catch (error) {
        if (/100%以内/.test(String(error?.message)) || isDbConflict(error)) {
          return bad(c, '同じ窓口の取り分が先に登録されました。再読込して登録済みの内容を確かめてください', 409);
        }
        throw error;
      }
      return c.json({ok: true, ...(await feeShareState(i, window))}, 201);
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });
}
