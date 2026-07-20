const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPoTokenFromResourceUrls,
  addPoTokenToGoogleVideoUrl,
  extractPlayerMetadata,
} = require('../src/core/metadata.js');

test('extracts the newest PO token from observed Google Video requests', () => {
  const token = extractPoTokenFromResourceUrls([
    'https://example.com/file?pot=ignore-me',
    'https://r1---sn.googlevideo.com/videoplayback?itag=18&pot=old-token',
    'https://r2---sn.googlevideo.com/videoplayback?itag=22&pot=new-token',
  ]);
  assert.equal(token, 'new-token');
});

test('adds a captured PO token to a player-response Google Video URL', () => {
  const result = addPoTokenToGoogleVideoUrl(
    'https://r1---sn.googlevideo.com/videoplayback?itag=18&c=WEB',
    'token-value',
  );
  const url = new URL(result);
  assert.equal(url.searchParams.get('pot'), 'token-value');
  assert.equal(url.searchParams.get('itag'), '18');
});

test('does not overwrite an existing PO token', () => {
  const result = addPoTokenToGoogleVideoUrl(
    'https://r1---sn.googlevideo.com/videoplayback?itag=18&pot=original',
    'replacement',
  );
  assert.equal(new URL(result).searchParams.get('pot'), 'original');
});

test('applies the captured token to progressive formats in metadata', () => {
  const response = {
    videoDetails: { videoId: 'abc', title: 'Test', author: 'Channel' },
    streamingData: {
      formats: [{
        itag: 18,
        mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        qualityLabel: '360p',
        height: 360,
        audioQuality: 'AUDIO_QUALITY_LOW',
        url: 'https://r1---sn.googlevideo.com/videoplayback?itag=18&c=WEB',
      }],
    },
  };
  const metadata = extractPlayerMetadata(response, 'https://www.youtube.com/watch?v=abc', [
    'https://r2---sn.googlevideo.com/videoplayback?itag=399&pot=page-token',
  ]);
  assert.equal(new URL(metadata.formats[0].url).searchParams.get('pot'), 'page-token');
});

test('can refresh an existing PO token for a retry', () => {
  const result = addPoTokenToGoogleVideoUrl(
    'https://r1---sn.googlevideo.com/videoplayback?itag=18&pot=old',
    'fresh',
    true,
  );
  assert.equal(new URL(result).searchParams.get('pot'), 'fresh');
});
