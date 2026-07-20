const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPlayerMetadata } = require('../src/core/metadata.js');

const androidFormat = {
  itag: 18,
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  qualityLabel: '360p',
  width: 640,
  height: 360,
  fps: 30,
  bitrate: 1,
  audioQuality: 'AUDIO_QUALITY_LOW',
  contentLength: '1',
  url: 'https://r1.googlevideo.com/videoplayback?itag=18&c=ANDROID',
  client: 'ANDROID',
};

test('stale WEB response A is ignored when current videoId is B', () => {
  const staleWeb = {
    videoDetails: {
      videoId: 'videoA',
      title: 'Title A',
      author: 'Channel A',
      lengthSeconds: '10',
      isLiveContent: false,
    },
    streamingData: { formats: [androidFormat] },
  };
  const metadata = extractPlayerMetadata(
    staleWeb,
    'https://www.youtube.com/watch?v=videoB',
    [],
    {
      expectedVideoId: 'videoB',
      downloadFormats: [{ ...androidFormat }],
      downloadClient: 'ANDROID',
      downloadDetails: {
        videoId: 'videoB',
        title: 'Title B',
        author: 'Channel B',
        lengthSeconds: '20',
        isLiveContent: false,
      },
    },
  );
  assert.equal(metadata.videoId, 'videoB');
  assert.equal(metadata.title, 'Title B');
  assert.notEqual(metadata.title, 'Title A');
});

test('ANDROID details B take priority over matching WEB A/B mix', () => {
  const web = {
    videoDetails: {
      videoId: 'videoB',
      title: 'Old Web Title B',
      author: 'Web Channel',
      lengthSeconds: '11',
      isLiveContent: false,
    },
    streamingData: {
      formats: [{
        ...androidFormat,
        url: 'https://r1.googlevideo.com/videoplayback?itag=18&c=WEB',
      }],
    },
  };
  const metadata = extractPlayerMetadata(
    web,
    'https://www.youtube.com/watch?v=videoB',
    [],
    {
      expectedVideoId: 'videoB',
      downloadFormats: [androidFormat],
      downloadClient: 'ANDROID',
      downloadDetails: {
        videoId: 'videoB',
        title: 'Fresh Android Title B',
        author: 'Android Channel',
        lengthSeconds: '33',
        isLiveContent: false,
      },
    },
  );
  assert.equal(metadata.title, 'Fresh Android Title B');
  assert.equal(metadata.channel, 'Android Channel');
  assert.equal(metadata.durationSeconds, 33);
});

test('returns null when no details match expected videoId', () => {
  const metadata = extractPlayerMetadata(
    {
      videoDetails: { videoId: 'other', title: 'Nope', author: 'X', lengthSeconds: '1' },
      streamingData: { formats: [androidFormat] },
    },
    'https://www.youtube.com/watch?v=videoB',
    [],
    {
      expectedVideoId: 'videoB',
      downloadFormats: [androidFormat],
      downloadClient: 'ANDROID',
      downloadDetails: { videoId: 'zzz', title: 'Wrong', author: 'Y', lengthSeconds: '2' },
    },
  );
  assert.equal(metadata, null);
});

test('DOM title is used when player details are missing but formats exist', () => {
  const metadata = extractPlayerMetadata(
    null,
    'https://www.youtube.com/watch?v=videoB',
    [],
    {
      expectedVideoId: 'videoB',
      downloadFormats: [androidFormat],
      downloadClient: 'ANDROID',
      domDetails: {
        videoId: 'videoB',
        title: 'DOM Title B',
        author: '',
        lengthSeconds: 0,
        isLiveContent: false,
      },
    },
  );
  assert.equal(metadata.title, 'DOM Title B');
  assert.equal(metadata.videoId, 'videoB');
});
