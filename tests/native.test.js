const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NATIVE_HOST_NAME,
  isSupportedYouTubeUrl,
  qualityLabel,
  normalizeProbeResponse,
  buildProbePayload,
  buildDownloadPayload,
  buildCancelPayload,
} = require('../src/core/native.js');

test('uses stable neutral native host name', () => {
  assert.equal(NATIVE_HOST_NAME, 'com.arzumanoff.media_engine');
});

test('accepts supported YouTube watch and Shorts URLs only', () => {
  assert.equal(isSupportedYouTubeUrl('https://www.youtube.com/watch?v=abc123'), true);
  assert.equal(isSupportedYouTubeUrl('https://youtu.be/abc123'), true);
  assert.equal(isSupportedYouTubeUrl('https://www.youtube.com/shorts/abc123'), true);
  assert.equal(isSupportedYouTubeUrl('https://example.com/watch?v=abc123'), false);
  assert.equal(isSupportedYouTubeUrl('http://www.youtube.com/watch?v=abc123'), false);
});

test('labels high frame rate qualities without inventing resolution', () => {
  assert.equal(qualityLabel(1080, 60), '1080p60');
  assert.equal(qualityLabel(1080, 30), '1080p');
  assert.equal(qualityLabel(360, 0), '360p');
});

test('normalizes, deduplicates and sorts real qualities', () => {
  const result = normalizeProbeResponse({
    ok: true,
    videoId: 'abc',
    title: 'Demo',
    channel: 'Channel',
    duration: 12,
    qualities: [
      { id: 'h360-f30', height: 360, fps: 30, requiresMerge: false, requiresTranscode: false },
      { id: 'h1080-f60', height: 1080, fps: 60, requiresMerge: true, requiresTranscode: false },
      { id: 'h1080-f30', height: 1080, fps: 30, requiresMerge: true, requiresTranscode: true },
      { id: 'h1080-f60', height: 1080, fps: 60 },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.qualities.map((q) => q.label), ['1080p60', '1080p', '360p']);
  assert.equal(result.qualities[0].requiresMerge, true);
  assert.equal(result.qualities[1].requiresTranscode, true);
});

test('does not create fake qualities when the host reports only low resolutions', () => {
  const result = normalizeProbeResponse({
    ok: true,
    qualities: [
      { id: 'h360-f30', height: 360, fps: 30 },
      { id: 'h240-f30', height: 240, fps: 30 },
    ],
  });
  assert.deepEqual(result.qualities.map((q) => q.height), [360, 240]);
  assert.equal(result.qualities.some((q) => q.height === 1080), false);
});

test('rejects malformed probe responses', () => {
  assert.deepEqual(normalizeProbeResponse({ ok: true, qualities: [] }), {
    ok: false,
    errorCode: 'NO_QUALITIES',
    message: 'Доступные качества не найдены.',
  });
  assert.equal(normalizeProbeResponse({ ok: false, errorCode: 'X' }).errorCode, 'X');
});

test('builds strict probe, download and cancel payloads', () => {
  assert.equal(buildProbePayload('https://www.youtube.com/watch?v=abc').ok, true);
  assert.equal(buildProbePayload('https://example.com').ok, false);

  assert.deepEqual(buildDownloadPayload({
    url: 'https://www.youtube.com/watch?v=abc',
    qualityId: 'h1080-f60',
    suggestedFilename: 'Demo.mp4',
  }), {
    ok: true,
    payload: {
      url: 'https://www.youtube.com/watch?v=abc',
      qualityId: 'h1080-f60',
      suggestedFilename: 'Demo.mp4',
    },
  });
  assert.equal(buildDownloadPayload({ url: 'https://www.youtube.com/watch?v=abc', qualityId: '', suggestedFilename: 'x.mp4' }).ok, false);
  assert.equal(buildCancelPayload('job-123').ok, true);
  assert.equal(buildCancelPayload('../bad').ok, false);
});
