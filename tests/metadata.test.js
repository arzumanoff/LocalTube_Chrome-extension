const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPlayerMetadata, resolveFormatUrl, mergeFormats } = require('../src/core/metadata.js');
const { normalizeObservedUrls } = require('../src/core/media-url.js');
const { validateStartDownloadPayload } = require('../src/core/messages.js');

const response = {
  videoDetails: {
    videoId: 'abc123',
    title: 'Test video',
    author: 'Channel',
    lengthSeconds: '125',
    isLiveContent: false,
  },
  streamingData: {
    formats: [{
      itag: 18,
      mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      qualityLabel: '360p',
      width: 640,
      height: 360,
      fps: 30,
      bitrate: 500000,
      audioQuality: 'AUDIO_QUALITY_LOW',
      contentLength: '12345',
      url: 'https://r1---sn.googlevideo.com/videoplayback?itag=18&c=WEB',
    }],
  },
};

const androidFormats = [{
  itag: 18,
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  qualityLabel: '360p',
  width: 640,
  height: 360,
  fps: 30,
  bitrate: 500000,
  audioQuality: 'AUDIO_QUALITY_LOW',
  contentLength: '12345',
  url: 'https://r9---sn.googlevideo.com/videoplayback?itag=18&c=ANDROID',
  client: 'ANDROID',
}];

const observedUrls = [{
  url: 'https://r2---sn.googlevideo.com/videoplayback?itag=137&n=working&range=0-9',
  observedAt: 123,
  itag: '137',
}];

test('extracts metadata and prefers ANDROID progressive URLs', () => {
  const metadata = extractPlayerMetadata(
    response,
    'https://www.youtube.com/watch?v=abc123',
    observedUrls,
    {
      expectedVideoId: 'abc123',
      downloadFormats: androidFormats,
      downloadClient: 'ANDROID',
      downloadDetails: response.videoDetails,
    },
  );
  assert.equal(metadata.videoId, 'abc123');
  assert.equal(metadata.title, 'Test video');
  assert.equal(metadata.durationSeconds, 125);
  assert.ok(metadata.formats.length >= 1);
  assert.equal(metadata.downloadClient, 'ANDROID');
  const android = metadata.formats.find((f) => f.client === 'ANDROID');
  assert.ok(android);
  assert.equal(android.url.includes('c=ANDROID'), true);
  assert.equal(metadata.observedUrls[0].url.includes('range='), false);
});

test('marks Shorts from the current URL', () => {
  const metadata = extractPlayerMetadata(response, 'https://www.youtube.com/shorts/abc123', [], {
    expectedVideoId: 'abc123',
    downloadFormats: androidFormats,
    downloadClient: 'ANDROID',
    downloadDetails: response.videoDetails,
  });
  assert.equal(metadata.isShort, true);
});

test('limits observed media URLs to the newest entries', () => {
  const many = Array.from({ length: 45 }, (_, index) => ({
    url: `https://r1.googlevideo.com/videoplayback?n=${index}&itag=18`,
    observedAt: index,
    itag: '18',
  }));
  const normalized = normalizeObservedUrls(many);
  assert.equal(normalized.length, 40);
  assert.equal(normalized[0].observedAt, 5);
});

test('returns null for malformed player data', () => {
  assert.equal(extractPlayerMetadata(null, 'https://www.youtube.com/watch?v=x'), null);
  assert.equal(extractPlayerMetadata('{broken', 'https://www.youtube.com/watch?v=x'), null);
});

test('resolves direct url and unsigned cipher url field', () => {
  assert.equal(
    resolveFormatUrl({ url: 'https://r1.googlevideo.com/videoplayback?itag=18' }),
    'https://r1.googlevideo.com/videoplayback?itag=18',
  );
  assert.equal(
    resolveFormatUrl({
      signatureCipher: 'url=https%3A%2F%2Fr1.googlevideo.com%2Fvideoplayback%3Fitag%3D18&sp=sig&s=ABC',
    }),
    'https://r1.googlevideo.com/videoplayback?itag=18',
  );
});

test('token-enriched metadata still passes strict message validation', () => {
  const metadata = extractPlayerMetadata(response, 'https://www.youtube.com/watch?v=abc123', [{
    url: 'https://r2.googlevideo.com/videoplayback?pot=token&itag=399',
    observedAt: 1,
    itag: '399',
  }], {
    expectedVideoId: 'abc123',
    downloadFormats: androidFormats,
    downloadClient: 'ANDROID',
    downloadDetails: response.videoDetails,
  });
  assert.deepEqual(validateStartDownloadPayload({
    metadata,
    targetHeight: 360,
    requestedFilename: '',
  }), { ok: true });
});

test('progressive 360p format is exposed for download selection', () => {
  const metadata = extractPlayerMetadata(response, 'https://www.youtube.com/watch?v=abc123', [], {
    expectedVideoId: 'abc123',
    downloadFormats: androidFormats,
    downloadClient: 'ANDROID',
    downloadDetails: response.videoDetails,
  });
  assert.equal(metadata.formats.some((f) => f.height === 360 && f.hasAudio && f.hasVideo), true);
});

test('mergeFormats keeps both web and android entries', () => {
  const merged = mergeFormats(
    [{ itag: 18, height: 360, client: 'ANDROID', url: 'a' }],
    [{ itag: 18, height: 360, client: 'web', url: 'b' }],
  );
  assert.equal(merged.length, 2);
});
