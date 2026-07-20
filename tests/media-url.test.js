const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isGoogleVideoUrl,
  repairMediaUrl,
  resolveMediaUrl,
} = require('../src/core/media-url.js');

const rawUrl = 'https://r1---sn.googlevideo.com/videoplayback?itag=18&id=abc&n=raw-token&sig=signed';
const observedUrls = [
  {
    url: 'https://r2---sn.googlevideo.com/videoplayback?itag=137&id=abc&n=working-token&pot=proof-token&range=0-999999',
    observedAt: 200,
  },
];

test('recognizes only HTTPS googlevideo delivery URLs', () => {
  assert.equal(isGoogleVideoUrl(rawUrl), true);
  assert.equal(isGoogleVideoUrl('http://r1.googlevideo.com/videoplayback'), false);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com.evil.test/videoplayback'), false);
});

test('repairs a raw URL with tokens observed from the active YouTube player', () => {
  const repaired = new URL(repairMediaUrl(rawUrl, observedUrls));
  assert.equal(repaired.searchParams.get('itag'), '18');
  assert.equal(repaired.searchParams.get('n'), 'working-token');
  assert.equal(repaired.searchParams.get('pot'), 'proof-token');
  assert.equal(repaired.searchParams.has('range'), false);
});

test('uses the raw URL when a one-byte probe succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status: 206, body: { cancel: async () => undefined } };
  };

  const result = await resolveMediaUrl(rawUrl, observedUrls, fetchImpl);
  assert.deepEqual(result, { ok: true, url: rawUrl, source: 'raw' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Range, 'bytes=0-0');
});

test('retries with the observed player token after SERVER_FORBIDDEN', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      status: calls.length === 1 ? 403 : 206,
      body: { cancel: async () => undefined },
    };
  };

  const result = await resolveMediaUrl(rawUrl, observedUrls, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'observed-player-token');
  assert.equal(new URL(result.url).searchParams.get('n'), 'working-token');
  assert.equal(calls.length, 2);
});

test('does not open a download when both raw and repaired URLs are forbidden', async () => {
  const result = await resolveMediaUrl(rawUrl, observedUrls, async () => ({
    status: 403,
    body: { cancel: async () => undefined },
  }));
  assert.deepEqual(result, { ok: false, errorCode: 'MEDIA_URL_FORBIDDEN' });
});
