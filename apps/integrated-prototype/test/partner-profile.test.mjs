import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {normalizeProfile, corporateCheckDigitOk} from '../src/partners/partner-profile.mjs';

const validCorporate = () => {
  for (let d = 1; d <= 9; d += 1) if (corporateCheckDigitOk(`${d}123456789012`)) return `${d}123456789012`;
  throw new Error('no check digit');
};

test('profile validation: invoice number format and check digit, email, roles', () => {
  assert.equal(normalizeProfile({invoice_registration_number: 'T123'}).errors.length, 1);
  const ok = normalizeProfile({invoice_registration_number: ` t${validCorporate()} `, roles: ['customer', 'broadcaster'], contact_email: 'keiri@example.invalid'});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.invoice_registration_number, `T${validCorporate()}`);
  assert.deepEqual(ok.warnings, []);
  const warn = normalizeProfile({invoice_registration_number: 'T0000000000001'});
  assert.equal(warn.errors.length, 0);
  assert.equal(warn.warnings.length, 1, 'a check-digit mismatch is only a warning');
  assert.equal(normalizeProfile({contact_email: 'not-mail'}).errors[0].field, 'contact_email');
  assert.equal(normalizeProfile({roles: ['owner']}).errors[0].field, 'roles');
});

test('profile versions are append-only, conflict-checked and permission-checked', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => { const r = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; };
  const first = await req('/partners/2/profile-versions', {roles: ['customer'], invoice_registration_number: `T${validCorporate()}`, contact_name: '経理ご担当', baseVersion: 0});
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal((await req('/partners/2/profile-versions', {roles: ['customer'], baseVersion: 0})).status, 409, 'stale base version');
  assert.equal((await req('/partners/2/profile-versions', {roles: ['customer', 'agency'], contact_name: '新しい担当', baseVersion: 1})).status, 201);
  const profile = (await req('/partners/2/profile')).data;
  assert.equal(profile.current.version_no, 2);
  assert.deepEqual(profile.current.roles, ['customer', 'agency']);
  assert.equal(profile.versions.length, 2, 'the old version is kept');
  assert.equal((await req('/partner-profiles')).data.profiles.length, 1);
  await assert.rejects(() => db.run('UPDATE partner_profile_versions SET contact_name=NULL'), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  const production = await login('production@openingnight.invalid');
  assert.equal((await req('/partners/2/profile-versions', {roles: []}, production)).status, 403);
  assert.equal((await req('/partners/2/profile', null, production)).status, 403, '制作担当は請求・連絡先を読めない');
  assert.equal((await req('/partner-profiles', null, production)).status, 403);
  assert.equal((await req('/partners/999/profile')).status, 404);
});
