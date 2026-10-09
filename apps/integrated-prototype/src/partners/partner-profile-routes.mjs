// 取引先の請求・連絡先情報のAPI。修正は新しい版の追加だけで、過去の版は残る（表の更新・削除はトリガーで禁止）。
import {normalizeProfile, PARTNER_ROLES} from './partner-profile.mjs';

const parseRow = (row) => (row ? {...row, roles: JSON.parse(row.roles_json || '[]')} : null);

// 請求・連絡先（インボイス登録番号・住所・請求の備考）は財務の情報なので、制作担当には読ませない（「取引先」画面も制作担当には出さない）
const PRODUCTION_DENIED = '制作担当は取引先の請求・連絡先情報を参照できません';

export function registerPartnerProfileRoutes(app, {db, bad, body}) {
  app.get('/api/partner-profiles', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, PRODUCTION_DENIED, 403);
    const rows = await db.all(`SELECT v.* FROM partner_profile_versions v WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM partner_profile_versions x WHERE x.org_id=v.org_id AND x.partner_id=v.partner_id)`, [i.org_id]);
    return c.json({ok: true, roles: PARTNER_ROLES, profiles: rows.map(parseRow)});
  });

  app.get('/api/partners/:id/profile', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, PRODUCTION_DENIED, 403);
    const partnerId = Number(c.req.param('id'));
    const partner = await db.get('SELECT id, code, name, kind, region FROM partners WHERE org_id=? AND id=?', [i.org_id, partnerId]);
    if (!partner) return bad(c, '取引先が見つかりません', 404);
    const versions = (await db.all(`SELECT v.*, u.display_name AS created_by_name FROM partner_profile_versions v LEFT JOIN users u ON u.id=v.created_by
      WHERE v.org_id=? AND v.partner_id=? ORDER BY v.version_no DESC`, [i.org_id, partnerId])).map(parseRow);
    return c.json({ok: true, partner, roles: PARTNER_ROLES, current: versions[0] || null, versions});
  });

  app.post('/api/partners/:id/profile-versions', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'この役割では取引先の情報を変更できません', 403);
    const partnerId = Number(c.req.param('id'));
    if (!await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [i.org_id, partnerId])) return bad(c, '取引先が見つかりません', 404);
    const input = await body(c);
    const {values, errors, warnings} = normalizeProfile(input);
    if (errors.length) return bad(c, errors.map((e) => e.message).join(' ／ '), 400, {errors});
    const latest = await db.get('SELECT MAX(version_no) AS v FROM partner_profile_versions WHERE org_id=? AND partner_id=?', [i.org_id, partnerId]);
    const expected = Number(input.baseVersion ?? latest?.v ?? 0);
    if (Number(latest?.v || 0) !== expected) return bad(c, '他の人が先に新しい版を作りました。再読込して直してください', 409);
    const version = Number(latest?.v || 0) + 1;
    await db.batch([
      {sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE (SELECT COALESCE(MAX(version_no),0) FROM partner_profile_versions WHERE org_id=? AND partner_id=?)<>?', params: [i.org_id, partnerId, expected]},
      {sql: `INSERT INTO partner_profile_versions(org_id, partner_id, version_no, roles_json, invoice_registration_number, postal_code, address, phone, contact_name, contact_email, billing_note, effective_from, created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [i.org_id, partnerId, version, JSON.stringify(values.roles), values.invoice_registration_number, values.postal_code, values.address, values.phone, values.contact_name, values.contact_email, values.billing_note, values.effective_from, i.user_id]},
      {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, 'version', 'partner_profile', String(partnerId), JSON.stringify({version, values})]},
    ]);
    return c.json({ok: true, version, warnings}, 201);
  });
}
