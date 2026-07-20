const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isGoogleVideoUrl,
  isVideoPlaybackUrl,
  extractPlaybackTokens,
  repairMediaUrl,
  applyPlaybackTokens,
  looksLikeMp4,
  looksLikeTextPayload,
  findFtypOffset,
  classifyMediaProbe,
  readResponsePrefix,
  resolveMediaUrl,
  candidateUrls,
} = require('../src/core/media-url.js');

const rawUrl = 'https://r1---sn.googlevideo.com/videoplayback?itag=18&id=abc&n=raw-token&sig=signed&c=WEB';
const observedUrls = [
  {
    url: 'https://r2---sn.googlevideo.com/videoplayback?itag=137&id=abc&n=working-n&pot=proof-token&range=0-999999',
    observedAt: 200,
    itag: '137',
  },
  {
    url: 'https://r3---sn.googlevideo.com/videoplayback?itag=18&id=abc&n=exact-n&pot=exact-pot&range=0-1',
    observedAt: 300,
    itag: '18',
  },
];

function mp4Prefix(extraBefore = 0) {
  const ftyp = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (!extraBefore) return ftyp;
  // free box then ftyp
  const free = new Uint8Array(8 + extraBefore);
  free[0] = 0; free[1] = 0; free[2] = 0; free[3] = 8 + extraBefore;
  free[4] = 0x66; free[5] = 0x72; free[6] = 0x65; free[7] = 0x65; // free
  const out = new Uint8Array(free.length + ftyp.length);
  out.set(free, 0);
  out.set(ftyp, free.length);
  return out;
}

function makeStreamResponse(chunks, status = 200, contentType = 'video/mp4') {
  let index = 0;
  let cancelled = false;
  const body = {
    getReader() {
      return {
        async read() {
          if (cancelled || index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
        async cancel() {
          cancelled = true;
        },
        releaseLock() {},
      };
    },
  };
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    body,
    get cancelled() { return cancelled; },
    get readCount() { return index; },
  };
}

test('recognizes only HTTPS googlevideo delivery URLs', () => {
  assert.equal(isGoogleVideoUrl(rawUrl), true);
  assert.equal(isVideoPlaybackUrl(rawUrl), true);
  assert.equal(isGoogleVideoUrl('http://r1.googlevideo.com/videoplayback'), false);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com.evil.test/videoplayback'), false);
});

test('extracts newest n and pot tokens from observed player requests', () => {
  const tokens = extractPlaybackTokens(observedUrls);
  assert.equal(tokens.n, 'exact-n');
  assert.equal(tokens.pot, 'exact-pot');
});

test('prefers an observed URL with the same itag', () => {
  const repaired = new URL(repairMediaUrl(rawUrl, observedUrls));
  assert.equal(repaired.searchParams.get('itag'), '18');
  assert.equal(repaired.searchParams.get('n'), 'exact-n');
  assert.equal(repaired.searchParams.get('pot'), 'exact-pot');
  assert.equal(repaired.searchParams.has('range'), false);
});

test('repairs progressive URL with adaptive tokens when same itag is absent', () => {
  const adaptiveOnly = [observedUrls[0]];
  const repaired = new URL(repairMediaUrl(rawUrl, adaptiveOnly, { replaceExisting: true }));
  assert.equal(repaired.searchParams.get('itag'), '18');
  assert.equal(repaired.searchParams.get('n'), 'working-n');
  assert.equal(repaired.searchParams.get('pot'), 'proof-token');
});

test('applies and refreshes PO token on retry', () => {
  const withPot = applyPlaybackTokens(rawUrl, { pot: 'token-a' });
  assert.equal(new URL(withPot).searchParams.get('pot'), 'token-a');
  const refreshed = applyPlaybackTokens(withPot, { pot: 'token-b', n: 'n2' }, { replaceExisting: true });
  assert.equal(new URL(refreshed).searchParams.get('pot'), 'token-b');
  assert.equal(new URL(refreshed).searchParams.get('n'), 'n2');
});

test('detects MP4 ftyp at start and after a leading free box', () => {
  assert.equal(looksLikeMp4(mp4Prefix()), true);
  assert.equal(findFtypOffset(mp4Prefix()), 0);
  const nested = mp4Prefix(8);
  assert.equal(looksLikeMp4(nested), true);
  assert.ok(findFtypOffset(nested) > 0);
  assert.equal(looksLikeMp4(new TextEncoder().encode('SERVER_FORBIDDEN')), false);
  assert.equal(looksLikeTextPayload(new TextEncoder().encode('SERVER_FORBIDDEN')), true);
});

test('classifies only real MP4 prefixes as successful probes', () => {
  assert.deepEqual(classifyMediaProbe(403, 'text/plain'), { ok: false, errorCode: 'MEDIA_URL_FORBIDDEN' });
  assert.deepEqual(classifyMediaProbe(200, 'text/plain', new TextEncoder().encode('nope')), {
    ok: false,
    errorCode: 'MEDIA_BAD_CONTENT',
  });
  assert.deepEqual(classifyMediaProbe(200, 'text/html', new TextEncoder().encode('<html>')), {
    ok: false,
    errorCode: 'MEDIA_BAD_CONTENT',
  });
  assert.deepEqual(classifyMediaProbe(206, 'video/mp4', mp4Prefix()), { ok: true, errorCode: null });
  assert.deepEqual(classifyMediaProbe(200, 'video/mp4', mp4Prefix(8)), { ok: true, errorCode: null });

  const randomBinary = new Uint8Array(64);
  for (let i = 0; i < randomBinary.length; i += 1) randomBinary[i] = (i * 37 + 11) & 0xff;
  assert.deepEqual(classifyMediaProbe(200, 'video/mp4', randomBinary), {
    ok: false,
    errorCode: 'MEDIA_NOT_MP4',
  });
  assert.deepEqual(classifyMediaProbe(200, 'application/octet-stream', randomBinary), {
    ok: false,
    errorCode: 'MEDIA_NOT_MP4',
  });
});

test('readResponsePrefix bounds a huge HTTP 200 stream and cancels the reader', async () => {
  const hugeTail = new Uint8Array(5 * 1024 * 1024);
  hugeTail.fill(7);
  const response = makeStreamResponse([
    mp4Prefix(),
    hugeTail,
    new Uint8Array([9, 9, 9]),
  ], 200, 'video/mp4');

  const result = await readResponsePrefix(response, 1024);
  assert.equal(result.bytesRead <= 1024, true);
  assert.equal(result.bytes.length <= 1024, true);
  assert.equal(result.cancelled, true);
  assert.equal(response.cancelled, true);
  // Only the first chunk needed to fill the budget should be consumed before cancel.
  assert.ok(response.readCount <= 2);
  assert.equal(looksLikeMp4(result.bytes), true);
});

test('readResponsePrefix hard-caps arrayBuffer fallback responses', async () => {
  const giant = new Uint8Array(4096);
  giant.set(mp4Prefix(), 0);
  giant.fill(1, 32);
  const response = {
    status: 200,
    headers: { get: () => 'video/mp4' },
    arrayBuffer: async () => giant.buffer,
  };
  const result = await readResponsePrefix(response, 128);
  assert.equal(result.bytesRead, 128);
  assert.equal(result.bytes.length, 128);
  assert.equal(result.cancelled, true);
});

test('uses the raw URL when a bounded media probe succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return makeStreamResponse([mp4Prefix()], 206, 'video/mp4');
  };
  const result = await resolveMediaUrl(rawUrl, observedUrls, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'raw');
  assert.equal(result.url, rawUrl);
  assert.equal(calls[0].options.headers.Range, 'bytes=0-1023');
});

test('retries with observed player tokens after SERVER_FORBIDDEN', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const ok = String(url).includes('exact-n');
    if (!ok) {
      return makeStreamResponse([new TextEncoder().encode('SERVER_FORBIDDEN')], 403, 'text/plain');
    }
    return makeStreamResponse([mp4Prefix()], 206, 'video/mp4');
  };
  const result = await resolveMediaUrl(rawUrl, observedUrls, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'observed-same-itag');
  assert.equal(new URL(result.url).searchParams.get('n'), 'exact-n');
  assert.ok(calls.length >= 2);
});

test('does not open a download when all candidates are forbidden', async () => {
  const result = await resolveMediaUrl(rawUrl, observedUrls, async () => (
    makeStreamResponse([new TextEncoder().encode('SERVER_FORBIDDEN')], 403, 'text/plain')
  ));
  assert.deepEqual(result, { ok: false, errorCode: 'MEDIA_URL_FORBIDDEN' });
});

test('builds candidate list with tab tokens without duplicates', () => {
  const list = candidateUrls(rawUrl, observedUrls, { n: 'tab-n', pot: 'tab-pot' });
  const urls = list.map((item) => item.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(list.some((item) => item.source === 'tab-token'));
});

test('treats missing pot as a still-attemptable but non-special case', async () => {
  const withoutPot = [{
    url: 'https://r2---sn.googlevideo.com/videoplayback?itag=137&n=only-n',
    observedAt: 1,
    itag: '137',
  }];
  const result = await resolveMediaUrl(rawUrl, withoutPot, async () => (
    makeStreamResponse([new TextEncoder().encode('no')], 403, 'text/plain')
  ));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MEDIA_URL_FORBIDDEN');
});
