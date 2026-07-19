const test = require('node:test');
const assert = require('node:assert/strict');
const { selectNearestProgressiveMp4, buildQualityOptions } = require('../src/core/quality.js');

const formats = [
  { itag: 18, container: 'mp4', codecs: ['avc1.42001E', 'mp4a.40.2'], hasAudio: true, hasVideo: true, height: 360, fps: 30, bitrate: 500000, url: 'https://media/360' },
  { itag: 22, container: 'mp4', codecs: ['avc1.64001F', 'mp4a.40.2'], hasAudio: true, hasVideo: true, height: 720, fps: 30, bitrate: 2000000, url: 'https://media/720' },
  { itag: 136, container: 'mp4', codecs: ['avc1.4d401f'], hasAudio: false, hasVideo: true, height: 720, fps: 60, bitrate: 3000000, url: 'https://media/video-only' },
  { itag: 43, container: 'webm', codecs: ['vp8.0', 'vorbis'], hasAudio: true, hasVideo: true, height: 360, fps: 30, bitrate: 600000, url: 'https://media/webm' },
  { itag: 999, container: 'mp4', codecs: ['av01.0.05M.08', 'opus'], hasAudio: true, hasVideo: true, height: 1080, fps: 30, bitrate: 4000000, url: 'https://media/av1' },
];

test('selects the exact progressive MP4 quality when available', () => {
  assert.equal(selectNearestProgressiveMp4(formats, 720)?.itag, 22);
});

test('falls back to the nearest lower progressive MP4 quality', () => {
  assert.equal(selectNearestProgressiveMp4(formats, 1080)?.height, 720);
  assert.equal(selectNearestProgressiveMp4(formats, 480)?.height, 360);
});

test('never silently selects a quality higher than requested', () => {
  assert.equal(selectNearestProgressiveMp4(formats, 240), null);
});

test('best available ignores the height ceiling but still requires progressive MP4', () => {
  assert.equal(selectNearestProgressiveMp4(formats, null)?.itag, 22);
});

test('quality options explain automatic fallback', () => {
  assert.deepEqual(buildQualityOptions(formats, [1080]).at(0), {
    targetHeight: 1080, label: '1080p', available: true, resolvedHeight: 720, isFallback: true,
  });
});

test('rejects MP4 streams that are not H.264 plus AAC', () => {
  assert.equal(selectNearestProgressiveMp4([formats.at(-1)], 1080), null);
});
