const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRetryDownloadPayload } = require('../src/core/messages.js');
const { validateRetryPayload, createDownloadJob } = require('../src/core/jobs.js');
const { selectNearestProgressiveMp4 } = require('../src/core/quality.js');
const { resolveMediaUrl } = require('../src/core/media-url.js');

function mp4Bytes() {
  return new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function streamResponse(status, contentType, bytes) {
  let cancelled = false;
  let reads = 0;
  return {
    status,
    headers: { get: () => contentType },
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (reads === 1) return { done: false, value: bytes };
            return { done: true, value: undefined };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
    get cancelled() { return cancelled; },
  };
}

const format = {
  itag: 18,
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  container: 'mp4',
  codecs: ['avc1.42001E', 'mp4a.40.2'],
  qualityLabel: '360p',
  width: 640,
  height: 360,
  fps: 30,
  bitrate: 500000,
  contentLength: 12345,
  hasAudio: true,
  hasVideo: true,
  url: 'https://r1---sn.googlevideo.com/videoplayback?itag=18&expire=999&c=ANDROID&sig=fresh',
  client: 'ANDROID',
};

const metadata = {
  videoId: 'abc',
  title: 'Video',
  channel: 'Channel',
  durationSeconds: 10,
  isLive: false,
  isShort: false,
  formats: [format],
  observedUrls: [],
  downloadClient: 'ANDROID',
};

test('retry payload requires jobId and full fresh metadata', () => {
  assert.deepEqual(validateRetryDownloadPayload({ jobId: 'j1', metadata }), { ok: true });
  assert.equal(validateRetryDownloadPayload({ jobId: 'j1' }).ok, false);
  assert.equal(validateRetryDownloadPayload({ metadata }).ok, false);
});

test('retry is rejected when metadata.videoId does not match job.videoId', () => {
  const job = createDownloadJob({
    id: 'j1',
    videoId: 'abc',
    title: 'Video',
    targetHeight: 720,
    selectedFormat: format,
    suggestedFilename: 'Video.mp4',
  });
  assert.deepEqual(validateRetryPayload(job, { ...metadata, videoId: 'other' }), {
    ok: false,
    errorCode: 'RETRY_VIDEO_MISMATCH',
  });
});

test('retry selects a new URL from fresh metadata and never needs the expired sourceUrl', async () => {
  const job = createDownloadJob({
    id: 'j2',
    videoId: 'abc',
    title: 'Video',
    targetHeight: 720,
    selectedFormat: {
      ...format,
      url: 'https://r1---sn.googlevideo.com/videoplayback?itag=18&expire=1&sig=expired',
    },
    suggestedFilename: 'Video.mp4',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'sourceUrl'), false);

  const freshUrl = 'https://r9---sn.googlevideo.com/videoplayback?itag=18&expire=999999&sig=new&c=ANDROID';
  const freshMetadata = {
    ...metadata,
    formats: [{ ...format, url: freshUrl }],
  };
  assert.deepEqual(validateRetryPayload(job, freshMetadata), { ok: true });
  assert.equal(job.targetHeight, 720);
  assert.equal(job.videoId, 'abc');

  const selected = selectNearestProgressiveMp4(freshMetadata.formats, job.targetHeight);
  assert.equal(selected.url, freshUrl);
  assert.notEqual(selected.url.includes('expire=1'), true);

  const resolved = await resolveMediaUrl(selected.url, [], async (url) => {
    assert.equal(url, freshUrl);
    return streamResponse(206, 'video/mp4', mp4Bytes());
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.url, freshUrl);
});

test('expired old URL is not required and would fail probe if mistakenly used', async () => {
  const expired = 'https://r1---sn.googlevideo.com/videoplayback?itag=18&expire=1&sig=expired';
  const result = await resolveMediaUrl(expired, [], async () => (
    streamResponse(403, 'text/plain', new TextEncoder().encode('expired'))
  ));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MEDIA_URL_FORBIDDEN');
});
