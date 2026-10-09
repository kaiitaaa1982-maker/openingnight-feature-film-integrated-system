import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, createApi, describeError, errorNotice, isApiError, kindForStatus, normalizeDetails, technicalDetail, NETWORK_MESSAGE, fieldErrorsFromDetails,
} from '../src/ui/api-client.mjs';

const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});

function stub(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    return responder(url, init);
  };
  return {calls, request: createApi({fetchImpl})};
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('例外が起きませんでした');
}

test('通信失敗は kind:network と日本語の文で投げる', async () => {
  const {request} = stub(() => { throw new TypeError('fetch failed'); });
  const error = await rejection(request('/bootstrap'));
  assert.ok(error instanceof ApiError);
  assert.equal(error.kind, 'network');
  assert.equal(error.status, 0);
  assert.equal(error.message, NETWORK_MESSAGE);
  assert.match(error.message, /サーバーに接続できません/);
  assert.equal(describeError(error), 'サーバーに接続できません。通信を確認して再試行してください');
  assert.equal(error.cause.message, 'fetch failed');
});

test('HTTP 状態で kind を分ける（401 auth・403 forbidden・409 conflict・5xx server・404 not_found）', async () => {
  const cases = [[401, 'auth'], [403, 'forbidden'], [409, 'conflict'], [500, 'server'], [503, 'server'], [404, 'not_found'], [400, 'validation'], [413, 'validation'], [428, 'validation']];
  for (const [status, kind] of cases) {
    const {request} = stub(() => json(status, {ok: false, error: `理由${status}`}));
    const error = await rejection(request('/x'));
    assert.equal(error.kind, kind, `HTTP ${status}`);
    assert.equal(error.status, status);
    assert.equal(error.message, `理由${status}`, '既存画面が読む message はサーバーの理由のまま');
    assert.equal(kindForStatus(status), kind);
  }
});

test('422 は validation で details を保持する', async () => {
  const details = [{rowNo: 3, column: '税抜', message: '数値ではありません'}, {rowNo: 5, message: '取引先がありません'}];
  const {request} = stub(() => json(422, {ok: false, error: '入力に誤りがあります', details}));
  const error = await rejection(request('/bulk/partners/preview', {method: 'POST', body: '{}'}));
  assert.equal(error.kind, 'validation');
  assert.deepEqual(error.details, details);
  assert.deepEqual(error.body.details, details);
  assert.deepEqual(normalizeDetails(error.details), [
    {row: 3, column: '税抜', message: '数値ではありません'},
    {row: 5, column: null, message: '取引先がありません'},
  ]);
  assert.equal(describeError(error), '入力に誤りがあります');
});

test('既定では 2xx の ok:false 本体をそのまま返し、strict:true で validation として投げる', async () => {
  const body = {ok: false, errors: [{rowNo: 2, message: '日付が不正です'}], preview: {rows: 3}};
  const {request} = stub(() => json(200, body));
  assert.deepEqual(await request('/preview', {method: 'POST', body: '{}'}), body);
  const error = await rejection(request('/preview', {method: 'POST', body: '{}', strict: true}));
  assert.equal(error.kind, 'validation');
  assert.equal(error.status, 200);
  assert.deepEqual(error.details, body.errors);
  assert.equal(describeError(error), '入力内容を確認してください');
  const ok = {ok: true, id: 7};
  const second = stub(() => json(201, ok));
  assert.deepEqual(await second.request('/projects', {method: 'POST', body: '{}', strict: true}), ok);
});

test('本体つきの要求に JSON の content-type を付け、/api を前に付ける', async () => {
  const {request, calls} = stub(() => json(200, {ok: true}));
  await request('/projects', {method: 'POST', body: JSON.stringify({code: 'P1'})});
  await request('/works', {method: 'PATCH', body: {title: '作品'}, headers: {'If-Match': '2'}});
  await request('/bootstrap');
  assert.equal(calls[0].url, '/api/projects');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[1].init.body, JSON.stringify({title: '作品'}), '素のオブジェクトは JSON にする');
  assert.equal(calls[1].init.headers['If-Match'], '2');
  assert.equal(calls[2].init.headers['content-type'], undefined, '本体なしでは付けない');
  assert.equal('body' in calls[2].init, false);
  assert.equal('strict' in calls[0].init, false, 'strict は fetch に渡さない');
});

test('JSON 以外の応答は文字列で返し、HTML のエラーページは主表示に出さない', async () => {
  const text = stub(() => new Response('a,b\n1,2', {status: 200, headers: {'content-type': 'text/csv'}}));
  assert.equal(await text.request('/download'), 'a,b\n1,2');
  const html = stub(() => new Response('<html><body>Internal</body></html>', {status: 502, headers: {'content-type': 'text/html'}}));
  const error = await rejection(html.request('/x'));
  assert.equal(error.kind, 'server');
  assert.equal(describeError(error), 'サーバーで処理に失敗しました。時間をおいて再試行してください');
  const empty = stub(() => new Response(null, {status: 204}));
  assert.equal(await empty.request('/x', {method: 'DELETE'}), null);
});

test('raw:true は成功時に Response を返し、失敗時は同じ分類で投げる', async () => {
  const good = stub(() => new Response('<p>請求書</p>', {status: 200, headers: {'content-type': 'text/html'}}));
  const response = await good.request('/billing/invoices/1/html', {raw: true});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<p>請求書</p>');
  const bad = stub(() => json(403, {ok: false, error: '作品の財務権限がありません'}));
  const error = await rejection(bad.request('/billing/invoices/1/html', {raw: true}));
  assert.equal(error.kind, 'forbidden');
  assert.equal(describeError(error), '作品の財務権限がありません');
});

test('describeError はサーバー障害の生の文を主表示に出さず、技術情報に回す', () => {
  const server = new ApiError('SQLITE_ERROR: no such table: x', {status: 500, kind: 'server', body: {ok: false, error: 'SQLITE_ERROR: no such table: x'}});
  assert.equal(describeError(server), 'サーバーで処理に失敗しました。時間をおいて再試行してください');
  assert.match(technicalDetail(server), /HTTP 500/);
  assert.match(technicalDetail(server), /no such table/);
  const conflict = new ApiError('別の利用者が更新しました。再読込してください', {status: 409, kind: 'conflict'});
  assert.equal(describeError(conflict), '別の利用者が更新しました。再読込してください');
  const duplicate = new ApiError('同じコードが登録済みです', {status: 409, kind: 'conflict'});
  assert.equal(describeError(duplicate), '同じコードが登録済みです。再読込して確認してください');
  const auth = new ApiError('認証または所属の有効期限を確認できません', {status: 401, kind: 'auth'});
  assert.equal(describeError(auth), 'ログインの有効期限が切れました。もう一度ログインしてください');
  assert.equal(describeError(new ApiError('', {status: 403, kind: 'forbidden'})), 'この操作の権限がありません');
  assert.equal(describeError(new Error('ふつうの例外')), 'ふつうの例外');
  assert.equal(describeError(Object.assign(new Error('x'), {name: 'AbortError'})), '処理を中断しました');
  assert.equal(describeError('文字列'), '文字列');
  assert.equal(describeError(null), '');
});

test('中断（AbortError）は network にせずそのまま投げる', async () => {
  const {request} = stub(() => { throw new DOMException('aborted', 'AbortError'); });
  const error = await rejection(request('/x'));
  assert.equal(error.name, 'AbortError');
  assert.equal(isApiError(error), false);
});

test('errorNotice は tone を error に固定し、行の詳細と再試行の可否を返す', () => {
  const notice = errorNotice(new ApiError('3行に誤りがあります', {status: 422, kind: 'validation', details: {errors: [{row: 1, field: 'code', error: '必須です'}]}}));
  assert.equal(notice.tone, 'error');
  assert.equal(notice.message, '3行に誤りがあります');
  assert.deepEqual(notice.details, [{row: 1, column: 'code', message: '必須です'}]);
  assert.equal(notice.retryable, false);
  assert.equal(errorNotice(new ApiError(NETWORK_MESSAGE, {kind: 'network'})).retryable, true);
  assert.deepEqual(normalizeDetails({cause: 'x'}), [], '行の配列でない details は表にしない');
  assert.deepEqual(normalizeDetails(['文字列の理由']), [{row: null, column: null, message: '文字列の理由'}]);
});

test('行・列つきのエラーのうちフォームの項目に当たるものを項目の直下へ回す', () => {
  const fields = [{name: 'code', label: '案件コード'}, {name: 'budget_yen', label: '予算'}];
  const {errors, rest} = fieldErrorsFromDetails([
    {column: 'code', message: '同じコードがあります'},
    {field: '予算', error: '0以上にしてください'},
    {column: 'unknown', message: '別の理由'},
    '全体の理由',
  ], fields);
  assert.deepEqual(errors, {code: '同じコードがあります', budget_yen: '0以上にしてください'});
  assert.deepEqual(rest, [{row: null, column: 'unknown', message: '別の理由'}, {row: null, column: null, message: '全体の理由'}]);
});
