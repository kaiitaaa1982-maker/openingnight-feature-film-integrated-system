// 製造の受け口（会社ルートの plans/2026-10-24-folder-seizou.md。移行 0046）。
// 読み書きできるのは、案件の財務の権限のある人（管理者と、案件の編集の権限を持つ編集担当）。発注の金額を含むので制作担当には出さない。
// 権限の無い案件と別の組織の行は、有無を見せず同じ 403 にする。請求の額と仕訳は経費の側（ここでは経費の明細の行を指すだけ）
import {CHANNELS, MEDIA, PO_KINDS, PO_STAGES, PO_STAGE_LABELS, SOURCE_KINDS, STEP_GROUPS, isDate, liveEvents, normalizeOrderInput, normalizeStepEvent,
  normalizeVersionInput, productProgress, purchaseOrderState, stepStates} from './mfg-model.mjs';
import {addExpenseLink, addOrder, addOrderEvent, addProduct, addReceipt, addStepEvent, addVersion, countOrders, readExpense, readOrder, readOrderLine,
  readOrders, readPartners, readProduct, readProducts, readStepEvents, readVersions, readWorksFor} from './mfg-store.mjs';
import {dbErrorKind, isUniqueViolation} from '../data-platform/db-errors.mjs';

const FORBIDDEN = 'この商品への権限がありません';
const STALE = 'ほかの画面で変わりました。読み直してください';

// 今日（日本時間）。試験は ?today= で渡せる
const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const versionView = (r) => ({id: Number(r.id), versionNo: Number(r.version_no), name: r.name, channel: r.channel, media: r.media, editionLabel: r.edition_label,
  episodeFrom: r.episode_from == null ? null : Number(r.episode_from), episodeTo: r.episode_to == null ? null : Number(r.episode_to), releaseOn: r.release_on,
  scheduleRule: r.schedule_rule, plannedQty: r.planned_qty == null ? null : Number(r.planned_qty), note: r.note, reason: r.reason, createdAt: r.created_at});
const eventView = (r) => ({id: Number(r.id), stepKey: r.step_key, kind: r.kind, onDate: r.on_date, voidsEventId: r.voids_event_id == null ? null : Number(r.voids_event_id),
  note: r.note, createdAt: r.created_at});

function ordersView(raw) {
  const lines = raw.lines.map((l) => ({id: Number(l.id), poId: Number(l.po_id), lineNo: Number(l.line_no), item: l.item, spec: l.spec, qty: Number(l.qty),
    unitPriceX100: Number(l.unit_price_x100), amountExTaxYen: Number(l.amount_ex_tax_yen)}));
  const events = raw.events.map((e) => ({id: Number(e.id), poId: Number(e.po_id), kind: e.kind, onDate: e.on_date,
    amountExTaxYen: e.amount_ex_tax_yen == null ? null : Number(e.amount_ex_tax_yen), note: e.note}));
  const receipts = raw.receipts.map((r) => ({id: Number(r.id), poLineId: Number(r.po_line_id), receivedOn: r.received_on, qty: Number(r.qty),
    defectQty: Number(r.defect_qty), result: r.result, note: r.note}));
  const links = raw.links.map((x) => ({id: Number(x.id), poLineId: Number(x.po_line_id), expenseId: Number(x.expense_id), action: x.action, reason: x.reason,
    actualExTax: x.actual_ex_tax == null ? null : Number(x.actual_ex_tax)}));
  return raw.orders.map((o) => {
    const id = Number(o.id);
    const own = lines.filter((l) => l.poId === id);
    const ownEvents = events.filter((e) => e.poId === id);
    const ownReceipts = receipts.filter((r) => own.some((l) => l.id === r.poLineId));
    const linked = new Map();
    for (const x of links.filter((x) => own.some((l) => l.id === x.poLineId))) {
      const key = `${x.poLineId}:${x.expenseId}`;
      if (x.action === 'link') linked.set(key, x); else linked.delete(key);
    }
    const invoicedExTax = [...linked.values()].reduce((sum, x) => sum + (x.actualExTax ?? 0), 0);
    return {id, productId: Number(o.product_id), poNo: o.po_no, poKind: o.po_kind, partnerId: o.partner_id == null ? null : Number(o.partner_id),
      partnerName: o.partner_name ?? o.partner_label, deliverTo: o.deliver_to, dueOn: o.due_on, note: o.note, createdAt: o.created_at,
      lines: own.map((l) => ({...l, receipts: ownReceipts.filter((r) => r.poLineId === l.id), expenses: [...linked.values()].filter((x) => x.poLineId === l.id)})),
      events: ownEvents, orderedExTax: own.reduce((sum, l) => sum + l.amountExTaxYen, 0), invoicedExTax: linked.size ? invoicedExTax : null,
      ...purchaseOrderState({events: ownEvents, lines: own, receipts: ownReceipts})};
  });
}

export function registerManufacturingRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('manufacturing routes require app, db, bad, body and permittedProjects');
  }

  async function financeProjectIds(identity) {
    if (identity.role === 'production') return [];
    return (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
  }
  const numberParam = (c, name) => {
    const raw = c.req.param(name);
    const value = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }
  async function productAccess(c, productId) {
    const identity = c.get('identity');
    if (!productId) return {error: bad(c, '商品の番号を確かめてください', 400)};
    const [product, finance] = await Promise.all([readProduct(db, identity.org_id, productId), financeProjectIds(identity)]);
    if (!product || !finance.includes(Number(product.project_id))) return {error: bad(c, FORBIDDEN, 403)};
    const versions = (await readVersions(db, identity.org_id, [productId])).map(versionView);
    return {identity, product, version: versions.at(-1), versions};
  }
  const today = (c) => (isDate(c.req.query('today')) ? c.req.query('today') : todayJst());
  const conflict = (c, error, table) => ((dbErrorKind(error) === 'raise' && /stale manufacturing|purchase order voided/.test(error.message)) || isUniqueViolation(error, table)
    ? bad(c, /voided/.test(error.message) ? '取消した発注書には記録を足せません' : STALE, 409) : null);

  // 一覧: 見てよい案件の商品ごとに、今の版・工程の進み（済／全部・期限超・次の工程）と、発注書の数
  app.get('/api/mfg/products', async (c) => {
    const identity = c.get('identity');
    if (identity.role === 'production') return bad(c, FORBIDDEN, 403);
    const ids = await financeProjectIds(identity);
    const [products, works, partners] = await Promise.all([readProducts(db, identity.org_id, ids), readWorksFor(db, identity.org_id, ids), readPartners(db, identity.org_id)]);
    const productIds = products.map((p) => Number(p.id));
    const [versions, events, raw] = await Promise.all([readVersions(db, identity.org_id, productIds), readStepEvents(db, identity.org_id, productIds),
      readOrders(db, identity.org_id, productIds)]);
    const orders = ordersView(raw);
    const day = today(c);
    const rows = products.map((p) => {
      const id = Number(p.id);
      const version = versionView(versions.filter((v) => Number(v.product_id) === id).at(-1));
      const states = stepStates(version, events.filter((e) => Number(e.product_id) === id).map(eventView), day);
      const own = orders.filter((o) => o.productId === id && o.stage !== 'void');
      return {id, projectId: Number(p.project_id), workId: Number(p.work_id), workCode: p.work_code, workTitle: p.work_title, sourceKind: p.source_kind,
        version, steps: states.map(({key, state, dueOn, doneOn}) => ({key, state, dueOn, doneOn})), progress: productProgress(states),
        orders: {count: own.length, waiting: own.filter((o) => !o.reached.includes('received')).length, uninvoiced: own.filter((o) => o.reached.includes('received') && o.invoicedExTax == null).length}};
    });
    return c.json({ok: true, today: day, products: rows, works: works.map((w) => ({id: Number(w.id), projectId: Number(w.project_id), code: w.code, title: w.title})),
      partners: partners.map((p) => ({id: Number(p.id), code: p.code, name: p.name})),
      labels: {channels: CHANNELS, media: MEDIA, sourceKinds: SOURCE_KINDS, poKinds: PO_KINDS, poStages: PO_STAGES, poStageLabels: PO_STAGE_LABELS, stepGroups: STEP_GROUPS}});
  });

  app.post('/api/mfg/products', async (c) => {
    const identity = c.get('identity');
    const read = await readBody(c);
    if (read.error) return read.error;
    const ids = await financeProjectIds(identity);
    const works = await readWorksFor(db, identity.org_id, ids);
    const work = works.find((w) => Number(w.id) === Number(read.input.workId));
    if (!work) return bad(c, '作品を選んでください', 400);
    const sourceKind = Object.hasOwn(SOURCE_KINDS, read.input.sourceKind) ? read.input.sourceKind : null;
    if (!sourceKind) return bad(c, '出どころ（調達・MG_買付分・自社の企画）を選んでください', 400);
    const normalized = normalizeVersionInput({...read.input, reason: read.input.reason || '登録'});
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    const sourceRef = String(read.input.sourceRef ?? '').trim().slice(0, 80) || null;
    const productId = await addProduct(db, identity.org_id, {projectId: Number(work.project_id), workId: Number(work.id), sourceKind, sourceRef, version: normalized.value},
      {createdBy: identity.user_id});
    return c.json({ok: true, productId}, 201);
  });

  // 1商品: 版の履歴・工程（逆算の予定日と記録）・発注書（明細・段・納品・経費の結び）
  app.get('/api/mfg/products/:productId', async (c) => {
    const found = await productAccess(c, numberParam(c, 'productId'));
    if (found.error) return found.error;
    const {identity, product, version, versions} = found;
    const id = Number(product.id);
    const [events, raw, partners] = await Promise.all([readStepEvents(db, identity.org_id, [id]), readOrders(db, identity.org_id, [id]), readPartners(db, identity.org_id)]);
    const eventRows = events.map(eventView);
    const day = today(c);
    const states = stepStates(version, eventRows, day);
    const live = new Set(liveEvents(eventRows).map((e) => e.id));
    return c.json({ok: true, today: day, product: {id, projectId: Number(product.project_id), workId: Number(product.work_id), workCode: product.work_code,
      workTitle: product.work_title, sourceKind: product.source_kind, sourceRef: product.source_ref}, version, versions, steps: states, progress: productProgress(states),
      events: eventRows.map((e) => ({...e, live: live.has(e.id)})), orders: ordersView(raw), partners: partners.map((p) => ({id: Number(p.id), code: p.code, name: p.name})),
      labels: {channels: CHANNELS, media: MEDIA, sourceKinds: SOURCE_KINDS, poKinds: PO_KINDS, poStages: PO_STAGES, poStageLabels: PO_STAGE_LABELS, stepGroups: STEP_GROUPS}});
  });

  // 版を足す（発売日・名前・枚数を直す）
  app.post('/api/mfg/products/:productId/versions', async (c) => {
    const found = await productAccess(c, numberParam(c, 'productId'));
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    if (!String(read.input.reason ?? '').trim()) return bad(c, '直す理由を入れてください', 400);
    const normalized = normalizeVersionInput(read.input);
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    const versionNo = found.version.versionNo + 1;
    try {
      await addVersion(db, found.identity.org_id, Number(found.product.id), {...normalized.value, versionNo}, {createdBy: found.identity.user_id});
    } catch (error) {
      const answer = conflict(c, error, 'mfg_product_versions'); if (answer) return answer; throw error;
    }
    return c.json({ok: true, versionNo}, 201);
  });

  // 工程の記録（依頼・承認・済・予定日を直す・取消）
  app.post('/api/mfg/products/:productId/steps', async (c) => {
    const found = await productAccess(c, numberParam(c, 'productId'));
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const normalized = normalizeStepEvent(read.input, found.version);
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400);
    if (normalized.value.kind === 'void') {
      const events = (await readStepEvents(db, found.identity.org_id, [Number(found.product.id)])).map(eventView);
      const target = liveEvents(events).find((e) => e.id === normalized.value.voidsEventId && e.stepKey === normalized.value.stepKey);
      if (!target) return bad(c, '取消せる記録がありません', 409);
    }
    await addStepEvent(db, found.identity.org_id, Number(found.product.id), normalized.value, {createdBy: found.identity.user_id});
    return c.json({ok: true}, 201);
  });

  // 発注書を作る（明細つき）。番号は組織の通し番号
  app.post('/api/mfg/products/:productId/orders', async (c) => {
    const found = await productAccess(c, numberParam(c, 'productId'));
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const normalized = normalizeOrderInput(read.input);
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    if (normalized.value.partnerId) {
      const partners = await readPartners(db, found.identity.org_id);
      if (!partners.some((p) => Number(p.id) === normalized.value.partnerId)) return bad(c, '取引先を選び直してください', 400);
    }
    const poNo = `MFG-${String((await countOrders(db, found.identity.org_id)) + 1).padStart(5, '0')}`;
    let poId;
    try {
      poId = await addOrder(db, found.identity.org_id, Number(found.product.id), {...normalized.value, poNo}, {createdBy: found.identity.user_id});
    } catch (error) {
      const answer = conflict(c, error, 'mfg_purchase_orders'); if (answer) return answer; throw error;
    }
    return c.json({ok: true, poId, poNo}, 201);
  });

  async function orderAccess(c) {
    const identity = c.get('identity');
    const orderId = numberParam(c, 'orderId');
    const order = orderId ? await readOrder(db, identity.org_id, orderId) : null;
    if (!order) return {error: bad(c, FORBIDDEN, 403)};
    const found = await productAccess(c, Number(order.product_id));
    return found.error ? found : {...found, order};
  }
  async function lineAccess(c) {
    const identity = c.get('identity');
    const lineId = numberParam(c, 'lineId');
    const line = lineId ? await readOrderLine(db, identity.org_id, lineId) : null;
    if (!line) return {error: bad(c, FORBIDDEN, 403)};
    const found = await productAccess(c, Number(line.product_id));
    return found.error ? found : {...found, line};
  }

  // 発注書の段（見積を依頼した・見積が来た・発注した・請求が来た・支払った・取消）
  app.post('/api/mfg/orders/:orderId/events', async (c) => {
    const found = await orderAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const kind = ['quote_requested', 'quoted', 'ordered', 'invoiced', 'paid', 'void'].includes(read.input.kind) ? read.input.kind : null;
    if (!kind) return bad(c, '段を選んでください', 400);
    if (!isDate(read.input.onDate)) return bad(c, '日付を入れてください（YYYY-MM-DD）', 400);
    const note = String(read.input.note ?? '').trim().slice(0, 500) || null;
    if (kind === 'void' && !note) return bad(c, '取消の理由を入れてください', 400);
    const amount = read.input.amountExTaxYen == null || read.input.amountExTaxYen === '' ? null : Number(read.input.amountExTaxYen);
    if (amount != null && (!Number.isSafeInteger(amount) || amount < 0)) return bad(c, '見積の額（税抜の円）を確かめてください', 400);
    try {
      await addOrderEvent(db, found.identity.org_id, Number(found.order.id), {kind, onDate: read.input.onDate, amountExTaxYen: amount, note}, {createdBy: found.identity.user_id});
    } catch (error) {
      const answer = conflict(c, error, 'mfg_po_events'); if (answer) return answer; throw error;
    }
    return c.json({ok: true}, 201);
  });

  // 明細ごとの納品と検品
  app.post('/api/mfg/order-lines/:lineId/receipts', async (c) => {
    const found = await lineAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const qty = Number(read.input.qty);
    const defectQty = read.input.defectQty == null || read.input.defectQty === '' ? 0 : Number(read.input.defectQty);
    const result = read.input.result === 'fail' ? 'fail' : 'pass';
    const note = String(read.input.note ?? '').trim().slice(0, 500) || null;
    if (!isDate(read.input.receivedOn)) return bad(c, '納品の日を入れてください（YYYY-MM-DD）', 400);
    if (!Number.isSafeInteger(qty) || qty < 0 || !Number.isSafeInteger(defectQty) || defectQty < 0 || defectQty > qty) return bad(c, '数量と不良の数を確かめてください', 400);
    if (result === 'fail' && !note) return bad(c, '不合格の理由を入れてください', 400);
    await addReceipt(db, found.identity.org_id, Number(found.line.id), {receivedOn: read.input.receivedOn, qty, defectQty, result, note}, {createdBy: found.identity.user_id});
    return c.json({ok: true}, 201);
  });

  // 明細と経費の明細の行を結ぶ・外す。経費の行は同じ案件のものだけ
  app.post('/api/mfg/order-lines/:lineId/expenses', async (c) => {
    const found = await lineAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const action = read.input.action === 'unlink' ? 'unlink' : 'link';
    const reason = String(read.input.reason ?? '').trim().slice(0, 500) || null;
    if (action === 'unlink' && !reason) return bad(c, '外す理由を入れてください', 400);
    const expense = await readExpense(db, found.identity.org_id, Number(read.input.expenseId));
    if (!expense || Number(expense.project_id) !== Number(found.product.project_id)) return bad(c, '同じ案件の経費の行の番号を入れてください', 400);
    await addExpenseLink(db, found.identity.org_id, Number(found.line.id), {expenseId: Number(expense.id), action, reason}, {createdBy: found.identity.user_id});
    return c.json({ok: true}, 201);
  });
}
