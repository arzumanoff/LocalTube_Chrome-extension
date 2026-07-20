const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStartDownloadPayload, isAllowedMediaUrl } = require('../src/core/messages.js');

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
  url: 'https://r1---sn.googlevideo.com/videoplayback?itag=18',
  client: 'ANDROID',
};

const payload = {
  metadata: {
    videoId: 'abc',
    title: 'Video',
    channel: 'Channel',
    durationSeconds: 10,
    isLive: false,
    isShort: false,
    formats: [format],
    observedUrls: [{
      url: 'https://r2---sn.googlevideo.com/videoplayback?itag=137&n=working',
      observedAt: 100,
      itag: '137',
    }],
    downloadClient: 'ANDROID',
  },
  targetHeight: 720,
};

test('allows only HTTPS YouTube media delivery URLs', () => {
  assert.equal(isAllowedMediaUrl(format.url), true);
  assert.equal(isAllowedMediaUrl('https://evil.test/file.mp4'), false);
});

test('accepts the exact typed start-download payload', () => {
  assert.deepEqual(validateStartDownloadPayload(payload), { ok: true });
});

test('rejects unknown fields and unsupported target heights', () => {
  const bad = JSON.parse(JSON.stringify(payload));
  bad.extra = true;
  assert.equal(validateStartDownloadPayload(bad).ok, false);
  const height = JSON.parse(JSON.stringify(payload));
  height.targetHeight = 123;
  assert.equal(validateStartDownloadPayload(height).ok, false);
});

test('rejects untrusted media URLs', () => {
  const bad = JSON.parse(JSON.stringify(payload));
  bad.metadata.formats[0].url = 'https://evil.test/file.mp4';
  assert.equal(validateStartDownloadPayload(bad).ok, false);
});

test('rejects untrusted observed player URLs', () => {
  const bad = JSON.parse(JSON.stringify(payload));
  bad.metadata.observedUrls[0].url = 'https://evil.test/videoplayback';
  assert.deepEqual(validateStartDownloadPayload(bad), {
    ok: false,
    errorCode: 'INVALID_OBSERVED_URL',
  });
});

test('accepts empty observed URL list when player has not started', () => {
  const idle = JSON.parse(JSON.stringify(payload));
  idle.metadata.observedUrls = [];
  assert.deepEqual(validateStartDownloadPayload(idle), { ok: true });
});
