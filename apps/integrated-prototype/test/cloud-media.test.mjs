import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_RANGE_OBJECT_BYTES, respondToMediaRange } from '../src/cloud-media.mjs';

function asset(body = '0123456789', status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(Buffer.byteLength(body)), ...headers }
  });
}

function request(range, method = 'GET') {
  return new Request('https://app.example.invalid/media/workflow.mp4', {
    method,
    headers: range ? { Range: range } : undefined
  });
}

test('buffers a native Assets 206 response while retaining its range metadata and length', async () => {
  const result = await respondToMediaRange(request('bytes=2-4'), asset('234', 206, {
    'Content-Range': 'bytes 2-4/10'
  }));
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('Content-Length'), '3');
  assert.equal(result.headers.get('Content-Range'), 'bytes 2-4/10');
  assert.equal(result.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(await result.text(), '234');
});

test('rejects oversized or mismatched native Assets 206 responses without reading HEAD', async () => {
  const tooLarge = new Response('not read', {
    status: 206,
    headers: { 'Content-Length': String(MAX_RANGE_OBJECT_BYTES + 1), 'Content-Range': 'bytes 0-0/1' }
  });
  assert.equal((await respondToMediaRange(request('bytes=0-0'), tooLarge)).status, 413);

  const mismatch = new Response('234', {
    status: 206,
    headers: { 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10' }
  });
  assert.equal((await respondToMediaRange(request('bytes=2-5'), mismatch)).status, 502);

  const nativeHead = asset('234', 206, { 'Content-Range': 'bytes 2-4/10' });
  const headResult = await respondToMediaRange(request('bytes=2-4', 'HEAD'), nativeHead);
  assert.equal(headResult.status, 206);
  assert.equal(headResult.body, null);
  assert.equal(nativeHead.bodyUsed, false);
});

test('builds a leading, open-ended and suffix byte range from an Assets 200 response', async () => {
  for (const [header, expectedRange, expectedBody] of [
    ['bytes=0-3', 'bytes 0-3/10', '0123'],
    ['bytes=6-', 'bytes 6-9/10', '6789'],
    ['bytes=-4', 'bytes 6-9/10', '6789']
  ]) {
    const result = await respondToMediaRange(request(header), asset());
    assert.equal(result.status, 206);
    assert.equal(result.headers.get('Content-Range'), expectedRange);
    assert.equal(result.headers.get('Content-Length'), String(expectedBody.length));
    assert.equal(result.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(await result.text(), expectedBody);
  }
});

test('returns range metadata without a body for HEAD', async () => {
  const result = await respondToMediaRange(request('bytes=4-', 'HEAD'), asset());
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('Content-Range'), 'bytes 4-9/10');
  assert.equal(result.headers.get('Content-Length'), '6');
  assert.equal(result.body, null);
});

test('returns 416 for unsatisfiable, malformed or multi-range requests', async () => {
  for (const header of ['bytes=10-', 'bytes=7-2', 'bytes=0-1,3-4', 'items=0-1']) {
    const result = await respondToMediaRange(request(header), asset());
    assert.equal(result.status, 416);
    assert.equal(result.headers.get('Content-Range'), 'bytes */10');
    assert.equal(result.headers.get('Content-Length'), '0');
  }
});

test('buffers a normal Assets response without Content-Length and determines its final size', async () => {
  const result = await respondToMediaRange(request('bytes=2-5'), new Response('0123456789'));
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('Content-Length'), '4');
  assert.equal(await result.text(), '2345');
});

test('cancels a lengthless stream once it exceeds the bounded media limit', async () => {
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array([0, 1, 2, 3]));
      if (reads > 2) controller.close();
    },
    cancel() { cancelled = true; }
  });
  const result = await respondToMediaRange(request(), new Response(stream), { maxBytes: 5 });
  assert.equal(result.status, 413);
  assert.equal(cancelled, true);
});

test('does not buffer an oversized object and keeps unknown-length HEAD fail-closed', async () => {
  const tooLarge = new Response('not read', {
    headers: { 'Content-Length': String(MAX_RANGE_OBJECT_BYTES + 1) }
  });
  assert.equal((await respondToMediaRange(request('bytes=0-1'), tooLarge)).status, 413);

  assert.equal((await respondToMediaRange(request('bytes=0-1', 'HEAD'), new Response(null))).status, 502);
});

test('preserves a complete Assets 200 response and rejects non-media methods', async () => {
  const complete = await respondToMediaRange(request(), asset());
  assert.equal(complete.status, 200);
  assert.equal(complete.headers.get('Content-Length'), '10');
  assert.equal(complete.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(await complete.text(), '0123456789');

  const post = await respondToMediaRange(request('bytes=0-1', 'POST'), asset());
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
});
