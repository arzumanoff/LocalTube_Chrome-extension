const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPlayerMetadata } = require('../src/core/metadata.js');
const { validateStartDownloadPayload } = require('../src/core/messages.js');

test('token-enriched metadata still passes strict message validation', () => {
  const metadata = extractPlayerMetadata({
    videoDetails: { videoId: 'abc', title: 'Test', author: 'Channel', lengthSeconds: '1', isLiveContent: false },
    streamingData: { formats: [{
      itag: 18,
      mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      qualityLabel: '360p', width: 640, height: 360, fps: 30, bitrate: 1,
      audioQuality: 'AUDIO_QUALITY_LOW', contentLength: '1',
      url: 'https://r1.googlevideo.com/videoplayback?itag=18&c=WEB',
    }] },
  }, 'https://www.youtube.com/watch?v=abc', [
    'https://r2.googlevideo.com/videoplayback?pot=token',
  ]);
  assert.deepEqual(validateStartDownloadPayload({ metadata, targetHeight: 360 }), { ok: true });
});
