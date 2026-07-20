const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPlayerMetadata } = require('../src/core/metadata.js');

const response = {
  videoDetails: {
    videoId: 'abc123', title: 'Test video', author: 'Test channel',
    lengthSeconds: '125', isLiveContent: false,
  },
  streamingData: {
    formats: [
      {
        itag: 18,
        mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        qualityLabel: '360p', width: 640, height: 360, fps: 30, bitrate: 500000,
        audioQuality: 'AUDIO_QUALITY_LOW', contentLength: '1000',
        url: 'https://r1---sn.googlevideo.com/videoplayback?id=abc123',
      },
      {
        itag: 22,
        mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
        qualityLabel: '720p', width: 1280, height: 720, fps: 30, bitrate: 2000000,
        audioQuality: 'AUDIO_QUALITY_MEDIUM',
        signatureCipher: 'url=https%3A%2F%2Fexample.test%2Fciphered&s=secret&sp=sig',
      },
    ],
  },
};

const observedUrls = [{
  url: 'https://r2---sn.googlevideo.com/videoplayback?itag=137&n=working',
  observedAt: 123,
}];

test('extracts a strict serializable metadata model from a player response', () => {
  const metadata = extractPlayerMetadata(
    response,
    'https://www.youtube.com/watch?v=abc123',
    observedUrls,
  );
  assert.equal(metadata.videoId, 'abc123');
  assert.equal(metadata.title, 'Test video');
  assert.equal(metadata.durationSeconds, 125);
  assert.equal(metadata.isShort, false);
  assert.equal(metadata.formats.length, 1);
  assert.deepEqual(metadata.formats[0].codecs, ['avc1.42001E', 'mp4a.40.2']);
  assert.equal(metadata.formats[0].container, 'mp4');
  assert.equal(metadata.formats[0].hasAudio, true);
  assert.deepEqual(metadata.observedUrls, observedUrls);
});

test('marks Shorts from the current URL', () => {
  assert.equal(extractPlayerMetadata(response, 'https://www.youtube.com/shorts/abc123').isShort, true);
});

test('limits observed media URLs to the newest thirty entries', () => {
  const many = Array.from({ length: 35 }, (_, index) => ({
    url: `https://r1.googlevideo.com/videoplayback?n=${index}`,
    observedAt: index,
  }));
  const metadata = extractPlayerMetadata(response, 'https://www.youtube.com/watch?v=abc123', many);
  assert.equal(metadata.observedUrls.length, 30);
  assert.equal(metadata.observedUrls[0].observedAt, 5);
});

test('returns null for malformed player data', () => {
  assert.equal(extractPlayerMetadata(null, 'https://www.youtube.com/watch?v=x'), null);
  assert.equal(extractPlayerMetadata('{broken', 'https://www.youtube.com/watch?v=x'), null);
});
