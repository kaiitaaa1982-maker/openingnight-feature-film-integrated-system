// 調達の受け口（移行 0052。会社ルートの plans/2026-10-24-folder-chotatsu.md。フォルダ台帳 F19）。
// 読めるのも書けるのも、作品の財務の権限を持つ人（管理者と編集担当）。制作担当には見せない（調達案件の決まり FR-PLAN-ACQ-003 と同じ）。
// 段の順番（試算→合意→稟議→契約→素材→渡す）は受け口が守る。番号の取り合いは DB のトリガーが断る（409）。
// 調達はお金を動かさないので postJournal を呼ばない（約束 A-1）。全作品のウィンドウへは営業の関数で下書きを足す（約束 E-1）
import {caseChecks, caseFolderStatus, currentMaterials, estimateTotals, handoffState, helpers, normalizeCaseVersionInput, normalizeEstimateInput, normalizeScopes,
  RINGI_RESULTS, MATERIAL_KINDS, DOC_KINDS, sourceKindForDoc, stageStates} from './chotatsu-model.mjs';
import {addAgreement, addCase, addCaseVersion, addContract, addEstimate, addHandoff, addHandoffEvent, addMaterial, addRingi, addStageEvent, linkDocument, linkExpense,
  expenseExists, nextCaseCode, partnerExists, readCaseRecords, readWork, salesActivityExists, readCaseRows, readPartners, readWorks} from './chotatsu-store.mjs';
import {getSourceDocument, registerSourceDocument, SourceDocumentError} from '../../source-documents/source-documents-store.mjs';
import {createReleaseWindowDraft} from '../../sales-ops/release-window-draft-store.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const FORBIDDEN = '調達は担当範囲外です';
const STALE = 'ほかの画面で調達の記録が変わりました。読み直してください';
const MAX_BASE64 = 17 * 1024 * 1024;
const raced = (error) => (dbErrorKind(error) === 'raise' && /stale chotatsu|chotatsu case closed|chotatsu void target|chotatsu handoff/.test(error.message)) || isUniqueViolation(error);
const todayOf = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const n = (v) => (v == null ? null : Number(v));

const versionView = (v) => ({versionNo: n(v.version_no), title: v.title, holderPartnerId: n(v.holder_partner_id), holderName: v.holder_name ?? null,
  distributorPartnerId: n(v.distributor_partner_id), distributorName: v.distributor_name ?? null, mediaFamily: v.media_family, workId: n(v.work_id), origin: v.origin,
  salesActivityId: n(v.sales_activity_id), theatricalReleaseOn: v.theatrical_release_on, offerFrom: v.offer_from, offerUntil: v.offer_until, releaseMonth: v.release_month,
  releaseSlot: v.release_slot, note: v.note, reason: v.reason, createdAt: v.created_at});
const estimateView = (e, lines) => {
  const view = {id: n(e.id), versionNo: n(e.version_no), format: e.format, setCount: n(e.set_count), bonusNote: e.bonus_note, listPriceExTaxYen: n(e.list_price_ex_tax_yen),
    unitRevenueExTaxYen: n(e.unit_revenue_ex_tax_yen), quantity: n(e.quantity), royaltyKind: e.royalty_kind, royaltyRateBps: n(e.royalty_rate_bps),
    royaltyPerUnitYen: n(e.royalty_per_unit_yen), promotionNote: e.promotion_note, reason: e.reason, createdAt: e.created_at,
    lines: lines.filter((l) => n(l.estimate_id) === n(e.id)).map((l) => ({lineNo: n(l.line_no), expenseType: l.expense_type, name: l.name,
      amountExTaxYen: n(l.amount_ex_tax_yen), sourceDocumentId: n(l.source_document_id)}))};
  return {...view, totals: estimateTotals(view, view.lines)};
};

// 案件ごとに記録を組み立てる（一覧と1件で同じ）
function assemble(caseRow, records, today, allOpen) {
  const id = n(caseRow.id);
  const own = (rows, key = 'case_id') => rows.filter((r) => n(r[key]) === id);
  const versions = own(records.versions).map(versionView);
  const version = versions.at(-1);
  const estimates = own(records.estimates).map((e) => estimateView(e, records.lines));
  const agreements = own(records.agreements).map((a) => ({id: n(a.id), estimateId: n(a.estimate_id), estimateVersionNo: n(a.estimate_version_no), agreedOn: a.agreed_on,
    sourceDocumentId: n(a.source_document_id)}));
  const ringi = own(records.ringi).map((r) => ({id: n(r.id), estimateId: n(r.estimate_id), estimateVersionNo: n(r.estimate_version_no), result: r.result, resultOn: r.result_on,
    sourceDocumentId: n(r.source_document_id), note: r.note}));
  const contractRow = own(records.contracts).at(-1) ?? null;
  const scopes = contractRow ? records.scopes.filter((s) => n(s.intake_case_id) === n(contractRow.intake_case_id)).map((s) => ({channel: s.channel, territory: s.territory,
    rightsStart: s.rights_start, rightsEnd: s.rights_end, exclusivity: s.exclusivity})) : [];
  const contract = contractRow ? {intakeCaseId: n(contractRow.intake_case_id), intakeCaseCode: contractRow.intake_case_code, settlementContractId: n(contractRow.settlement_contract_id),
    settlementContractCode: contractRow.settlement_contract_code, workId: n(contractRow.work_id), workTitle: contractRow.work_title, signedOn: contractRow.signed_on,
    signedDocumentId: n(contractRow.signed_document_id), scopes} : null;
  const materialRows = own(records.materials).map((m) => ({seq: n(m.seq), materialKind: m.material_kind, required: Number(m.required) === 1, receivedOn: m.received_on,
    checkResult: m.check_result, sourceDocumentId: n(m.source_document_id), note: m.note}));
  const handoffs = own(records.handoffs).map((h) => {
    const events = records.handoffEvents.filter((x) => n(x.handoff_id) === n(h.id)).map((x) => ({seq: n(x.seq), event: x.event, reason: x.reason, createdAt: x.created_at}));
    return {id: n(h.id), handoffNo: n(h.handoff_no), estimateId: n(h.estimate_id), estimateVersionNo: n(h.estimate_version_no), releaseMonth: h.release_month,
      releaseSlot: h.release_slot, workId: n(h.work_id), intakeCaseId: n(h.intake_case_id), allowedFormats: JSON.parse(h.allowed_formats), territory: h.territory,
      rightsEnd: h.rights_end, events, state: handoffState(events)};
  });
  const events = own(records.events).map((e) => ({seq: n(e.seq), stage: e.stage, event: e.event, voidsSeq: n(e.voids_seq), onDate: e.on_date, reason: e.reason, createdAt: e.created_at}));
  const derived = stageStates({estimates, agreements, ringi, contract, materials: materialRows, handoffs, events, today, releaseMonth: version?.releaseMonth ?? null,
    offerUntil: version?.offerUntil ?? null});
  const siblings = allOpen.filter((o) => o.id !== id && version && o.workId && o.workId === version.workId && o.holderPartnerId === version.holderPartnerId
    && o.mediaFamily === version.mediaFamily).length;
  const checks = caseChecks({version, estimates, ringi, contract, scopes, handoffs, openSiblings: siblings});
  const live = handoffs.filter((h) => h.state !== 'void');
  return {id, caseCode: caseRow.case_code, version, versions, estimates, agreements, ringi, contract, materialRows, materials: currentMaterials(materialRows), handoffs, events,
    derived, checks, folder: caseFolderStatus(derived), liveHandoff: live.at(-1) ?? null,
    documents: own(records.documents).map((d) => ({sourceDocumentId: n(d.source_document_id), docKind: d.doc_kind, fileName: d.file_name, receivedOn: d.received_on,
      byteLength: n(d.byte_length)})),
    expenses: own(records.expenses).map((x) => ({expenseId: n(x.expense_id), estimateLineId: n(x.estimate_line_id)}))};
}

export function registerChotatsuRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('chotatsu routes require app, db, bad, body and permittedProjects');
  }

  async function access(c) {
    const identity = c.get('identity');
    if (identity.role === 'production') return {error: bad(c, FORBIDDEN, 403)};
    const projectIds = (await permittedProjects(db, identity, true)).map((p) => Number(p.id));
    if (identity.role !== 'admin' && !projectIds.length) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, projectIds};
  }

  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }

  async function loadAll(orgId) {
    const rows = await readCaseRows(db, orgId);
    const records = await readCaseRecords(db, orgId, rows.map((r) => Number(r.id)));
    const today = todayOf();
    const latest = (id) => records.versions.filter((v) => Number(v.case_id) === id).at(-1);
    const openSet = rows.map((r) => ({id: Number(r.id), v: latest(Number(r.id))})).filter((x) => x.v).map((x) => ({id: x.id, workId: n(x.v.work_id),
      holderPartnerId: n(x.v.holder_partner_id), mediaFamily: x.v.media_family}));
    const assembled = rows.map((row) => assemble(row, records, today, openSet));
    const closedIds = new Set(assembled.filter((a) => a.derived.closed).map((a) => a.id));
    // 閉じた案件は二重の検査の相手に数えない
    const openOnly = openSet.filter((o) => !closedIds.has(o.id));
    return rows.map((row) => assemble(row, records, today, openOnly));
  }

  async function loadOne(c, identity) {
    const raw = c.req.param('caseId');
    const caseId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(caseId) || caseId <= 0) return {error: bad(c, '案件の番号を確かめてください', 400)};
    const all = await loadAll(identity.org_id);
    const found = all.find((a) => a.id === caseId);
    if (!found) return {error: bad(c, '調達の案件がありません', 404)};
    return {item: found, all};
  }

  function detailView(a) {
    const v = a.version;
    const contractDone = a.derived.done.contract;
    const live = a.liveHandoff;
    const failing = a.checks.filter((x) => !x.ok);
    return {
      case: {id: a.id, caseCode: a.caseCode, ...v},
      versions: a.versions,
      stages: a.derived.states, folder: a.folder, closed: a.derived.closed, materialsDue: a.derived.materialsDue,
      estimates: a.estimates, agreements: a.agreements, ringi: a.ringi, contract: a.contract, materials: a.materials, handoffs: a.handoffs,
      documents: a.documents, expenses: a.expenses, checks: a.checks, history: a.events,
      canNotice: !a.derived.closed && contractDone && Boolean(v.releaseMonth && v.releaseSlot) && !live && a.estimates.length > 0,
      canReceive: !a.derived.closed && Boolean(live && live.state === 'notice') && a.derived.done.materials && failing.length === 0,
    };
  }

  const listRow = (a) => ({id: a.id, caseCode: a.caseCode, title: a.version.title, holderPartnerId: a.version.holderPartnerId, holderName: a.version.holderName,
    distributorName: a.version.distributorName, mediaFamily: a.version.mediaFamily, workId: a.version.workId, releaseMonth: a.version.releaseMonth,
    releaseSlot: a.version.releaseSlot, offerUntil: a.version.offerUntil, stages: a.derived.states, folder: a.folder,
    grossYen: a.estimates.length ? a.estimates.at(-1).totals.grossYen : null, materialsDue: a.derived.materialsDue, closed: a.derived.closed,
    exceptions: a.checks.filter((x) => !x.ok).length + Object.values(a.derived.states).filter((s) => s === 'late').length});

  app.get('/api/chotatsu/cases', async (c) => {
    const found = await access(c);
    if (found.error) return found.error;
    const {identity, projectIds} = found;
    const [all, partners, works] = await Promise.all([loadAll(identity.org_id), readPartners(db, identity.org_id), readWorks(db, identity.org_id, projectIds)]);
    const cases = all.map(listRow);
    return c.json({ok: true, cases, exceptionsCount: cases.filter((r) => !r.closed && r.exceptions > 0).length,
      partners: partners.map((p) => ({id: Number(p.id), name: p.name})), works: works.map((w) => ({id: Number(w.id), projectId: Number(w.project_id), code: w.code, title: w.title}))});
  });

  // 製造が読む入口（約束 Z-1）: 取消していない引き渡しの行と、その段
  app.get('/api/chotatsu/handoffs', async (c) => {
    const found = await access(c);
    if (found.error) return found.error;
    const all = await loadAll(found.identity.org_id);
    return c.json({ok: true, handoffs: all.flatMap((a) => a.handoffs.filter((h) => h.state !== 'void').map((h) => ({...h, caseId: a.id, caseCode: a.caseCode,
      title: a.version.title, materialsDue: a.derived.materialsDue})))});
  });

  app.get('/api/chotatsu/cases/:caseId', async (c) => {
    const found = await access(c);
    if (found.error) return found.error;
    const one = await loadOne(c, found.identity);
    if (one.error) return one.error;
    return c.json({ok: true, ...detailView(one.item)});
  });

  async function partnerOk(orgId, id) {
    return id == null || await partnerExists(db, orgId, id);
  }
  async function versionRefsOk(found, value) {
    const orgId = found.identity.org_id;
    if (!await partnerOk(orgId, value.holderPartnerId) || !await partnerOk(orgId, value.distributorPartnerId)) return '取引先がありません';
    if (value.workId != null) {
      const work = await readWork(db, orgId, value.workId);
      if (!work || (found.identity.role !== 'admin' && !found.projectIds.includes(Number(work.project_id)))) return '作品の財務の権限がありません';
    }
    if (value.salesActivityId != null && !await salesActivityExists(db, orgId, value.salesActivityId)) return '営業の活動記録がありません';
    return null;
  }

  app.post('/api/chotatsu/cases', async (c) => {
    const found = await access(c);
    if (found.error) return found.error;
    const {input, error} = await readBody(c);
    if (error) return error;
    let value;
    try { value = normalizeCaseVersionInput(input); } catch (e) { return bad(c, e.message, 400); }
    const refError = await versionRefsOk(found, value);
    if (refError) return bad(c, refError, 403);
    const caseCode = await nextCaseCode(db, found.identity.org_id);
    try {
      const caseId = await addCase(db, found.identity.org_id, caseCode, value, {userId: found.identity.user_id, today: todayOf()});
      return c.json({ok: true, caseId, caseCode}, 201);
    } catch (e) {
      if (raced(e)) return bad(c, STALE, 409, undefined, e);
      throw e;
    }
  });

  // 案件の中の書き込みの共通: 権限・案件の読み込み・本文・閉じた案件の拒否
  function caseWrite(path, handler, {allowClosed = false} = {}) {
    app.post(`/api/chotatsu/cases/:caseId${path}`, async (c) => {
      const found = await access(c);
      if (found.error) return found.error;
      const one = await loadOne(c, found.identity);
      if (one.error) return one.error;
      if (!allowClosed && one.item.derived.closed) return bad(c, '閉じた案件です。閉じた記録を取り消してから直してください', 409);
      const {input, error} = await readBody(c);
      if (error) return error;
      try {
        return await handler(c, {identity: found.identity, found, item: one.item, input, orgId: found.identity.org_id, userId: found.identity.user_id});
      } catch (e) {
        if (e instanceof SourceDocumentError) return bad(c, e.message, 400);
        if (raced(e)) return bad(c, STALE, 409, undefined, e);
        if (e && e.userFacing) return bad(c, e.message, e.status ?? 400);
        throw e;
      }
    });
  }
  const userError = (message, status = 400) => Object.assign(new Error(message), {userFacing: true, status});
  const estimateByVersion = (item, versionNo) => {
    const no = Number(versionNo);
    const e = item.estimates.find((x) => x.versionNo === no);
    if (!e) throw userError('試算の版を選んでください');
    return e;
  };
  const docOk = async (orgId, item, id) => {
    if (id == null || id === '') return null;
    const docId = Number(id);
    if (!item.documents.some((d) => d.sourceDocumentId === docId)) throw userError('この案件に置いた原本を選んでください');
    return docId;
  };

  caseWrite('/versions', async (c, {found, item, input, orgId, userId}) => {
    let value;
    try { value = normalizeCaseVersionInput(input, {requireReason: true}); } catch (e) { throw userError(e.message); }
    const base = Number(input.baseVersionNo);
    if (base !== item.version.versionNo) return bad(c, STALE, 409);
    const refError = await versionRefsOk(found, value);
    if (refError) throw userError(refError, 403);
    await addCaseVersion(db, orgId, item.id, base + 1, value, {userId});
    return c.json({ok: true, versionNo: base + 1}, 201);
  });

  caseWrite('/estimates', async (c, {item, input, orgId, userId}) => {
    let value;
    try { value = normalizeEstimateInput(input); } catch (e) { throw userError(e.message); }
    for (const line of value.lines) line.sourceDocumentId = await docOk(orgId, item, line.sourceDocumentId);
    const versionNo = item.estimates.length + 1;
    await addEstimate(db, orgId, item.id, versionNo, value, {userId});
    return c.json({ok: true, versionNo}, 201);
  });

  caseWrite('/agreements', async (c, {item, input, orgId, userId}) => {
    const estimate = estimateByVersion(item, input.estimateVersionNo);
    const agreedOn = helpers.optDate(input.agreedOn, '合意の日');
    if (!agreedOn) throw userError('合意の日を入れてください');
    await addAgreement(db, orgId, item.id, {estimateId: estimate.id, agreedOn, sourceDocumentId: await docOk(orgId, item, input.sourceDocumentId)}, {userId});
    return c.json({ok: true}, 201);
  });

  caseWrite('/ringi', async (c, {item, input, orgId, userId}) => {
    if (!item.agreements.length) throw userError('稟議の前に合意を記録してください', 409);
    const estimate = estimateByVersion(item, input.estimateVersionNo);
    const result = helpers.oneOf(input.result, RINGI_RESULTS, '稟議の結果');
    const resultOn = helpers.optDate(input.resultOn, '結果の日');
    if (!resultOn) throw userError('結果の日を入れてください');
    await addRingi(db, orgId, item.id, {estimateId: estimate.id, result, resultOn, sourceDocumentId: await docOk(orgId, item, input.sourceDocumentId),
      note: helpers.optText(input.note, 1000, 'メモ')}, {userId});
    return c.json({ok: true}, 201);
  });

  caseWrite('/contract', async (c, {found, item, input, orgId, userId}) => {
    if (!item.derived.done.ringi) throw userError('契約の前に稟議の承認を記録してください', 409);
    if (item.contract) throw userError('この案件の契約は記録済みです', 409);
    if (!item.version.holderPartnerId) throw userError('権利元を案件の版に入れてから契約を記録してください', 409);
    const workId = helpers.optInt(input.workId, '作品', {min: 1});
    if (!workId) throw userError('作品を選んでください');
    const work = await readWork(db, orgId, workId);
    if (!work || (found.identity.role !== 'admin' && !found.projectIds.includes(Number(work.project_id)))) throw userError('作品の財務の権限がありません', 403);
    const signedOn = helpers.optDate(input.signedOn, '締結日');
    if (!signedOn) throw userError('締結日を入れてください');
    const scopes = normalizeScopes(input.scopes);
    const terms = input.terms && typeof input.terms === 'object' ? input.terms : {};
    const agencyFeeBps = helpers.optInt(terms.agencyFeeBps, '手数料の率（bp）', {max: 10000});
    if (agencyFeeBps == null) throw userError('手数料の率（bp）を入れてください');
    const platformRateBps = helpers.optInt(terms.platformRateBps ?? 0, 'PF の率（bp）', {max: 10000}) ?? 0;
    const signedDocumentId = await docOk(orgId, item, input.signedDocumentId);
    const signedDocument = signedDocumentId ? await getSourceDocument(db, orgId, signedDocumentId) : null;
    await addContract(db, orgId, item.id, {projectId: Number(work.project_id), workId, title: item.version.title, holderPartnerId: item.version.holderPartnerId,
      intakeCode: `${item.caseCode}-R`, contractCode: `${item.caseCode}-S`, scopes, agencyFeeBps, platformRateBps, signedOn,
      signedDocument: signedDocument ? {id: signedDocument.id, fileName: signedDocument.file_name, sha256: signedDocument.sha256} : null}, {userId});
    return c.json({ok: true}, 201);
  });

  caseWrite('/materials', async (c, {item, input, orgId, userId}) => {
    if (!item.contract) throw userError('素材は契約のあとに記録してください', 409);
    const materialKind = helpers.oneOf(input.materialKind, MATERIAL_KINDS, '素材の種類');
    const checkResult = helpers.oneOf(input.checkResult ?? 'pending', {pending: 1, ok: 1, ng: 1}, '検品の結果');
    const receivedOn = helpers.optDate(input.receivedOn, '受領日');
    if (checkResult !== 'pending' && !receivedOn) throw userError('検品の結果を入れるときは受領日も入れてください');
    const seq = item.materialRows.length + 1;
    await addMaterial(db, orgId, item.id, seq, {materialKind, required: input.required !== false, receivedOn, checkResult,
      sourceDocumentId: await docOk(orgId, item, input.sourceDocumentId), note: helpers.optText(input.note, 1000, 'メモ')}, {userId});
    return c.json({ok: true, seq}, 201);
  });

  caseWrite('/handoffs', async (c, {item, input, orgId, userId}) => {
    const detail = detailView(item);
    const action = input.action;
    if (action === 'notice') {
      if (!detail.canNotice) throw userError('予告できるのは、契約が済み、発売予定月と枠が入り、試算がある案件です（取消していない引き渡しが無いとき）', 409);
      const estimate = item.estimates.at(-1);
      const scopes = item.contract.scopes;
      const ends = scopes.map((s) => s.rightsEnd).filter(Boolean).sort();
      const formats = estimate.format === 'other' ? [] : [estimate.format];
      const handoffNo = item.handoffs.length + 1;
      await addHandoff(db, orgId, item.id, handoffNo, {workId: item.contract.workId, intakeCaseId: item.contract.intakeCaseId, estimateId: estimate.id,
        allowedFormats: formats, territory: scopes[0]?.territory ?? null, rightsEnd: ends.at(-1) ?? null, releaseSlot: item.version.releaseSlot,
        releaseMonth: item.version.releaseMonth}, {userId});
      return c.json({ok: true, handoffNo}, 201);
    }
    const live = item.liveHandoff;
    if (!live) throw userError('先に製造へ予告してください', 409);
    if (action === 'received') {
      if (!detail.canReceive) throw userError('製造へ渡せるのは、要る素材が全部検品済みで、検査の例外が無いときです', 409);
      await addHandoffEvent(db, orgId, live.id, live.events.length + 1, 'received', null, {userId});
      return c.json({ok: true}, 201);
    }
    if (action === 'void') {
      const reason = helpers.optText(input.reason, 1000, '取消の理由');
      if (!reason) throw userError('取消の理由を入れてください');
      await addHandoffEvent(db, orgId, live.id, live.events.length + 1, 'void', reason, {userId});
      return c.json({ok: true}, 201);
    }
    throw userError('操作を選んでください');
  }, {allowClosed: false});

  caseWrite('/events', async (c, {item, input, orgId, userId}) => {
    const event = input.event;
    const reason = helpers.optText(input.reason, 1000, '理由');
    if (!reason) throw userError('理由を入れてください');
    const seq = item.events.length + 1;
    if (event === 'dropped' || event === 'moved_to_mg') {
      if (item.derived.closed) throw userError('既に閉じた案件です', 409);
      const stage = item.derived.firstOpen ?? 'handoff';
      await addStageEvent(db, orgId, item.id, seq, {stage, event, voidsSeq: null, onDate: todayOf(), reason}, {userId});
      return c.json({ok: true, seq}, 201);
    }
    if (event === 'void') {
      const target = item.events.find((e) => e.seq === Number(input.voidsSeq));
      if (!target || target.event === 'void') throw userError('取り消す記録を選んでください');
      await addStageEvent(db, orgId, item.id, seq, {stage: target.stage, event: 'void', voidsSeq: target.seq, onDate: todayOf(), reason}, {userId});
      return c.json({ok: true, seq}, 201);
    }
    throw userError('記録の種類を選んでください');
  }, {allowClosed: true});

  caseWrite('/documents', async (c, {item, input, orgId, userId}) => {
    const docKind = helpers.oneOf(input.docKind, DOC_KINDS, '原本の種類');
    if (typeof input.base64 !== 'string' || !input.base64 || input.base64.length > MAX_BASE64) throw userError('原本の中身（12MB まで）を付けてください');
    let bytes;
    try { bytes = Uint8Array.from(atob(input.base64), (ch) => ch.charCodeAt(0)); } catch { throw userError('原本の中身を読めません'); }
    const receivedOn = helpers.optDate(input.receivedOn, '受けた日') ?? todayOf();
    const registered = await registerSourceDocument(db, {orgId, userId, kind: sourceKindForDoc(docKind), fileName: input.fileName, mediaType: helpers.optText(input.mediaType, 160, '形式'),
      receivedOn, bytes});
    const linked = await linkDocument(db, orgId, item.id, registered.id, docKind, {userId});
    return c.json({ok: true, sourceDocumentId: registered.id, duplicate: registered.duplicate, linked}, 201);
  }, {allowClosed: true});

  app.get('/api/chotatsu/cases/:caseId/documents/:documentId', async (c) => {
    const found = await access(c);
    if (found.error) return found.error;
    const one = await loadOne(c, found.identity);
    if (one.error) return one.error;
    const docId = Number(c.req.param('documentId'));
    if (!one.item.documents.some((d) => d.sourceDocumentId === docId)) return bad(c, '原本がありません', 404);
    const doc = await getSourceDocument(db, found.identity.org_id, docId, {withContent: true});
    if (!doc || !doc.bytes) return bad(c, '中身を持たない原本です（外の置き場）', 404);
    return new Response(doc.bytes, {headers: {'content-type': doc.media_type || 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`}});
  });

  caseWrite('/expenses', async (c, {item, input, orgId, userId}) => {
    const expenseId = helpers.optInt(input.expenseId, '経費の明細', {min: 1});
    if (!expenseId) throw userError('経費の明細を選んでください');
    const expense = await expenseExists(db, orgId, expenseId);
    if (!expense) throw userError('経費の明細がありません', 404);
    await linkExpense(db, orgId, item.id, expenseId, null, {userId});
    return c.json({ok: true}, 201);
  });

  caseWrite('/release-window-draft', async (c, {identity, item, orgId}) => {
    if (!item.contract) throw userError('ウィンドウへ写すのは契約のあとです', 409);
    if (!item.version.releaseMonth) throw userError('発売予定月を案件の版に入れてください', 409);
    const result = await createReleaseWindowDraft(db, orgId, {workId: item.contract.workId, startMonth: item.version.releaseMonth,
      sourceReference: `調達 ${item.caseCode}`, reason: '調達の契約から発売予定月を写した（下書き）'}, identity);
    if (!result.created) throw userError(result.reason, 409);
    return c.json({ok: true, ...result}, 201);
  });
}
