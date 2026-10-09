// API の受け口が、DB のエラーの種類（src/data-platform/db-errors.mjs）を応答に載せ、画面が言い換えるまでを通しで確かめる（FR-CORE-DATA-016）。
// - catch でエラーを受けて bad(c, error.message, 409) と返す受け口も、dbError を載せる（載せないと言い換えが黙って消える）
// - D1 の形のトリガーの拒否（「D1_ERROR: 文: SQLITE_CONSTRAINT」）は、置き換える前の照合（/constraint/i）と同じく 409 を返す
// 架空のデータだけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './test-db.mjs';
import { createApp } from '../src/app.mjs';
import { createApi } from '../src/ui/api-client.mjs';
import { translateError, problemText } from '../src/rights/rights-ui-model.mjs';
import { isDbConflict, isConstraintViolation, dbErrorKind } from '../src/data-platform/db-errors.mjs';
import { fixture, good } from './committee-independent-fixture.mjs';

const members = [{ partnerId: 1, role: '出資者・配信窓口', shareBps: 6000 }, { partnerId: 2, role: '出資者・幹事・ビデオ窓口', shareBps: 4000 }];
const digital = () => ({ kind: 'digital', label: '架空配信', windowPartnerId: 1, managerPartnerId: 2, route: 'via_manager', platformRateBps: 5000, windowFeeBps: 2000, managerFeeBps: 500, feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'after_window' });
const phases = () => [{ label: '架空契約日程', startsOn: '2026-09-01', endsOn: '2026-09-30', firstCloseOn: '2026-09-30', intervalMonths: 1, closeDay: 'eom', reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', referenceType: 'release', referenceDate: '2026-09-01' }];

test('FR-CORE-DATA-016 委員会の契約コードの重複は、API が dbError を載せ、画面の文が「同じコードが既に登録されています」になる（DB の文で照合しない）', async (t) => {
  const f = await fixture({t});
  try {
    const contract = (code) => ({ managerPartnerId: 2, members, windows: [digital()], phases: phases(), workId: 1, intakeCaseId: f.intakeCase.id, documentId: f.intakeCase.documents[0].id, contractCode: code, title: '架空委員会の重複確認' });
    good(await f.req('/committee/contracts', contract('DUP-CODE')));
    const dup = await f.req('/committee/contracts', contract('DUP-CODE'));
    assert.equal(dup.status, 409);
    assert.equal(dup.data.dbError?.kind, 'unique', JSON.stringify(dup.data));
    assert.ok(dup.data.dbError.columns.includes('contract_code'), JSON.stringify(dup.data.dbError));
    // 画面の経路: API の部品（createApi）が投げる ApiError → translateError と ProblemNotice の文
    const cookie = await f.login('admin@openingnight.invalid');
    const api = createApi({ fetchImpl: (url, init) => f.app.request(url, { ...init, headers: { ...init.headers, cookie } }) });
    const error = await api('/committee/contracts', { method: 'POST', body: contract('DUP-CODE') }).then(() => null, (e) => e);
    assert.ok(error, '重複は失敗するはず');
    assert.equal(error.status, 409);
    assert.equal(translateError(error).message, '同じコードが既に登録されています。別のコードにしてください');
    assert.equal(problemText(error), '同じコードが既に登録されています。別のコードにしてください');
    assert.equal(problemText(translateError(error)), '同じコードが既に登録されています。別のコードにしてください');
    assert.doesNotMatch(problemText(error), /UNIQUE|constraint/);
  } finally {
    f.db.close();
  }
});

test('FR-CORE-DATA-016 D1 の形のトリガーの拒否（… : SQLITE_CONSTRAINT）は、置き換える前と同じく onError でも受け口の wrap でも 409 を返す', async (t) => {
  const d1Raise = () => new Error('D1_ERROR: 確定した記録は変更できません: SQLITE_CONSTRAINT');
  assert.equal(dbErrorKind(d1Raise()), 'raise');
  assert.equal(isConstraintViolation(d1Raise()), false, '制約の違反の判定はトリガーの拒否を含めない');
  assert.equal(isDbConflict(d1Raise()), true, '状態の番号の判定は、トリガーの拒否も衝突（409）にする');
  assert.equal(isDbConflict(Object.assign(new Error('x'), { code: 'P0001', severity: 'ERROR' })), true, 'PostgreSQL のトリガーの拒否も同じ');
  assert.equal(isDbConflict(new Error('接続が切れました')), false);
  // 置き換える前の照合は、D1 の結果コードの後ろの部分に当たって 409 を返していた（同じ番号を保つ）
  assert.match(d1Raise().message, /constraint/i);

  const db = await openTestDb({ t });
  try {
    const failing = Object.create(db);
    failing.get = async (sql, params) => { if (/^INSERT INTO partners/.test(sql)) throw d1Raise(); return db.get(sql, params); };
    failing.run = async (sql, params) => { if (/^INSERT INTO mg_suppliers/.test(sql)) throw d1Raise(); return db.run(sql, params); };
    const app = createApp({ db: failing, mode: 'local' });
    const cookie = (await app.request('/api/local/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@openingnight.invalid' }) })).headers.get('set-cookie').split(';')[0];
    const post = (path, body) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    // onError（受け口が catch しない）
    const viaOnError = await post('/api/partners', { code: 'RAISE-1', name: '架空の取引先', kind: 'other' });
    const onErrorBody = await viaOnError.json();
    assert.equal(viaOnError.status, 409);
    assert.equal(onErrorBody.error, d1Raise().message, '文は DB の文のまま（前と同じ）');
    assert.equal(onErrorBody.dbError?.kind, 'raise');
    // 受け口の wrap（mg の routeError。前は /UNIQUE|CHECK|FOREIGN KEY|constraint/i で 409）
    const viaWrap = await post('/api/mg/suppliers', { code: 'SUP-RAISE', name: '架空の仕入先' });
    assert.equal(viaWrap.status, 409);
    assert.equal((await viaWrap.json()).dbError?.kind, 'raise');
  } finally {
    await db.close();
  }
});
