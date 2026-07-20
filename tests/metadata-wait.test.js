const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForFreshMetadata } = require('../src/core/metadata-wait.js');

test('does not return pre-existing metadata until revision advances', async () => {
  let revision = 3;
  const oldMeta = {
    videoId: 'abc',
    formats: [{ url: 'https://r1.googlevideo.com/videoplayback?sig=old' }],
  };
  let metadata = oldMeta;
  let requestCount = 0;
  const sleeps = [];

  const pending = waitForFreshMetadata({
    getRevision: () => revision,
    getMetadata: () => metadata,
    requestMetadata: () => { requestCount += 1; },
    expectedVideoId: 'abc',
    timeoutMs: 1000,
    pollMs: 20,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (requestCount >= 1 && sleeps.length === 2) {
        // New revision arrives with a different URL.
        metadata = {
          videoId: 'abc',
          formats: [{ url: 'https://r9.googlevideo.com/videoplayback?sig=fresh' }],
        };
        revision = 4;
      }
    },
  });

  const result = await pending;
  assert.equal(requestCount >= 1, true);
  assert.equal(result.ok, true);
  assert.equal(result.previousRevision, 3);
  assert.equal(result.revision, 4);
  assert.equal(result.metadata.formats[0].url.includes('sig=fresh'), true);
  assert.notEqual(result.metadata.formats[0].url, oldMeta.formats[0].url);
});

test('timeout returns RETRY_METADATA_REQUIRED and never treats stale object as fresh', async () => {
  let revision = 1;
  const stale = {
    videoId: 'abc',
    formats: [{ url: 'https://r1.googlevideo.com/videoplayback?sig=stale' }],
  };
  let requests = 0;
  const result = await waitForFreshMetadata({
    getRevision: () => revision,
    getMetadata: () => stale,
    requestMetadata: () => { requests += 1; },
    expectedVideoId: 'abc',
    timeoutMs: 60,
    pollMs: 15,
    sleep: async () => undefined,
  });
  assert.equal(requests >= 1, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'RETRY_METADATA_REQUIRED');
  assert.equal(result.previousRevision, 1);
  assert.equal(result.revision, 1);
});

test('rejects when fresh revision belongs to another videoId', async () => {
  let revision = 0;
  let metadata = { videoId: 'abc', formats: [{ url: 'https://r1.googlevideo.com/videoplayback?a=1' }] };
  const resultPromise = waitForFreshMetadata({
    getRevision: () => revision,
    getMetadata: () => metadata,
    requestMetadata: () => undefined,
    expectedVideoId: 'abc',
    timeoutMs: 200,
    pollMs: 10,
    sleep: async () => {
      metadata = { videoId: 'other', formats: [{ url: 'https://r1.googlevideo.com/videoplayback?a=2' }] };
      revision = 2;
    },
  });
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'RETRY_VIDEO_MISMATCH');
  assert.equal(result.revision > result.previousRevision, true);
});
