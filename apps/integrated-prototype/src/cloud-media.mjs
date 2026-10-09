/**
 * Return an already-authorized Cloudflare Assets response with one byte range.
 *
 * The caller owns route selection, authentication and cache policy. This helper
 * does not fetch an object or alter its permissions. It is intentionally capped
 * for the 3.75 MiB private demonstration video, rather than acting as a general
 * large-object streaming proxy.
 */
export const MAX_RANGE_OBJECT_BYTES = 25 * 1024 * 1024;

function responseWithAssetHeaders(asset, body, size, status = asset.status) {
  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(size));
  return new Response(body, { status, statusText: asset.statusText, headers });
}

function rangeNotSatisfiable(size) {
  return new Response(null, {
    status: 416,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${size}`,
      'Content-Length': '0'
    }
  });
}

function parseSize(asset) {
  const value = asset.headers.get('Content-Length');
  if (!value || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

function declaredSizeOrError(asset, maxBytes) {
  const size = parseSize(asset);
  if (size !== null && size > maxBytes) {
    return { error: new Response('Media object exceeds the manual range limit.', { status: 413 }) };
  }
  return { size };
}

async function readAtMost(asset, maxBytes, declaredSize) {
  if (!asset.body) return { error: new Response('Assets response did not include a media body.', { status: 502 }) };
  const reader = asset.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel('media object exceeds the manual range limit'); } catch { /* size limit still wins */ }
        return { error: new Response('Media object exceeds the manual range limit.', { status: 413 }) };
      }
      chunks.push(value);
    }
  } catch {
    return { error: new Response('Assets media response could not be read.', { status: 502 }) };
  }
  if (declaredSize !== null && size !== declaredSize) {
    return new Response('Assets response length did not match Content-Length.', { status: 502 });
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { content, size };
}

function parseSingleByteRange(value, size) {
  if (!value || !/^bytes=\d*-\d*$/.test(value) || value.includes(',')) return null;
  if (size === 0) return null;

  const [, startText, endText] = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= size) return null;
  if (!endText) return { start, end: size - 1 };

  const requestedEnd = Number(endText);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * Keep native Assets range metadata. GET reads Assets in chunks, cancelling as
 * soon as the configured small-object limit is crossed. This makes a missing
 * Assets Content-Length safe while still returning a known final length.
 */
export async function respondToMediaRange(request, asset, { maxBytes = MAX_RANGE_OBJECT_BYTES } = {}) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  if (asset.status !== 200 && asset.status !== 206) return asset;

  const declared = declaredSizeOrError(asset, maxBytes);
  if (declared.error) return declared.error;

  if (method === 'HEAD' && declared.size === null) {
    return new Response('Assets response is missing a valid Content-Length.', { status: 502 });
  }
  if (method === 'HEAD' && asset.status === 206) {
    return responseWithAssetHeaders(asset, null, declared.size);
  }

  const rangeHeader = request.headers.get('Range');
  if (method === 'HEAD' && !rangeHeader) {
    return responseWithAssetHeaders(asset, null, declared.size);
  }

  if (method === 'HEAD') {
    const range = parseSingleByteRange(rangeHeader, declared.size);
    if (!range) return rangeNotSatisfiable(declared.size);
    const length = range.end - range.start + 1;
    const headers = new Headers(asset.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${declared.size}`);
    headers.set('Content-Length', String(length));
    return new Response(null, { status: 206, headers });
  }

  const buffered = await readAtMost(asset, maxBytes, declared.size);
  if (buffered.error) return buffered.error;
  if (buffered instanceof Response) return buffered;
  const { content, size } = buffered;

  if (asset.status === 206 || !rangeHeader) return responseWithAssetHeaders(asset, content, size);

  const range = parseSingleByteRange(rangeHeader, size);
  if (!range) return rangeNotSatisfiable(size);

  const length = range.end - range.start + 1;
  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('Content-Length', String(length));

  return new Response(content.slice(range.start, range.end + 1), { status: 206, headers });
}
