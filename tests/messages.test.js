const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedMediaUrl, validateStartDownloadPayload } = require('../src/core/messages.js');

const format = {
  itag: 18,
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  container: 'mp4', codecs: ['avc1.42001E', 'mp4a.40.2'], qualityLabel: '360p',
  width: 640, height: 360, fps: 30, bitrate: 500000, contentLength: 1000,
  hasAudio: true, hasVideo: true,
  url: 'https://r1---sn.googlevideo.com/videoplayback?id=abc',
};
const payload = {
  metadata: {
    videoId: 'abc', title: 'Video', channel: 'Channel', durationSeconds: 10,
    isLive: false, isShort: false, formats: [format],
  },
  targetHeight: 720,
};

test('allows only HTTPS YouTube media delivery URLs', () => {
  assert.equal(isAllowedMediaUrl(format.url), true);
  assert.equal(isAllowedMediaUrl('http://r1.googlevideo.com/video'), false);
  assert.equal(isAllowedMediaUrl('https://googlevideo.com.evil.test/video'), false);
});

test('accepts the exact typed start-download payload', () => {
  assert.deepEqual(validateStartDownloadPayload(payload), { ok: true });
});

test('rejects unknown fields and unsupported target heights', () => {
  assert.equal(validateStartDownloadPayload({ ...payload, extra: true }).ok, false);
  assert.equal(validateStartDownloadPayload({ ...payload, targetHeight: 999 }).ok, false);
});

test('rejects untrusted media URLs', () => {
  const bad = JSON.parse(JSON.stringify(payload));
  bad.metadata.formats[0].url = 'https://evil.test/file.mp4';
  assert.equal(validateStartDownloadPayload(bad).ok, false);
});
