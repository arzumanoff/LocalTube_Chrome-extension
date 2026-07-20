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
  classifyMediaProbe,
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

test('detects MP4 ftyp magic and rejects text payloads', () => {
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const text = new TextEncoder().encode('SERVER_FORBIDDEN');
  assert.equal(looksLikeMp4(mp4), true);
  assert.equal(looksLikeMp4(text), false);
  assert.equal(looksLikeTextPayload(text), true);
});

test('classifies 403 text responses and accepts partial MP4', () => {
  assert.deepEqual(classifyMediaProbe(403, 'text/plain'), { ok: false, errorCode: 'MEDIA_URL_FORBIDDEN' });
  assert.deepEqual(classifyMediaProbe(200, 'text/plain'), { ok: false, errorCode: 'MEDIA_BAD_CONTENT' });
  assert.deepEqual(classifyMediaProbe(200, 'text/html'), { ok: false, errorCode: 'MEDIA_BAD_CONTENT' });
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  assert.deepEqual(classifyMediaProbe(206, 'video/mp4', mp4), { ok: true, errorCode: null });
  assert.deepEqual(
    classifyMediaProbe(200, 'application/octet-stream', new TextEncoder().encode('SERVER_ERROR')),
    { ok: false, errorCode: 'MEDIA_BAD_CONTENT' },
  );
});

test('uses the raw URL when a media probe succeeds', async () => {
  const calls = [];
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 206,
      headers: { get: () => 'video/mp4' },
      arrayBuffer: async () => mp4.buffer,
    };
  };
  const result = await resolveMediaUrl(rawUrl, observedUrls, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'raw');
  assert.equal(result.url, rawUrl);
  assert.equal(calls[0].options.headers.Range, 'bytes=0-1023');
});

test('retries with observed player tokens after SERVER_FORBIDDEN', async () => {
  const calls = [];
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const fetchImpl = async (url) => {
    calls.push(url);
    const ok = String(url).includes('exact-n');
    return {
      status: ok ? 206 : 403,
      headers: { get: () => (ok ? 'video/mp4' : 'text/plain') },
      arrayBuffer: async () => (ok ? mp4.buffer : new TextEncoder().encode('SERVER_FORBIDDEN').buffer),
    };
  };
  const result = await resolveMediaUrl(rawUrl, observedUrls, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'observed-same-itag');
  assert.equal(new URL(result.url).searchParams.get('n'), 'exact-n');
  assert.ok(calls.length >= 2);
});

test('does not open a download when all candidates are forbidden', async () => {
  const result = await resolveMediaUrl(rawUrl, observedUrls, async () => ({
    status: 403,
    headers: { get: () => 'text/plain' },
    arrayBuffer: async () => new TextEncoder().encode('SERVER_FORBIDDEN').buffer,
  }));
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
  const result = await resolveMediaUrl(rawUrl, withoutPot, async () => ({
    status: 403,
    headers: { get: () => 'text/plain' },
    arrayBuffer: async () => new TextEncoder().encode('no').buffer,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MEDIA_URL_FORBIDDEN');
});
