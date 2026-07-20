const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isProgressiveAvcAac,
  buildPlayerRequestBody,
  buildPlayerRequestHeaders,
  extractProgressiveFormats,
  pickBestProgressive,
  resolveDownloadableFormats,
} = require('../src/core/innertube.js');

test('detects progressive AVC+AAC formats with direct URLs', () => {
  assert.equal(isProgressiveAvcAac({
    url: 'https://r1.googlevideo.com/videoplayback',
    mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  }), true);
  assert.equal(isProgressiveAvcAac({
    mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  }), false);
});

test('builds ANDROID player request bodies and headers', () => {
  const body = buildPlayerRequestBody('abc123', {
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
  });
  assert.equal(body.videoId, 'abc123');
  assert.equal(body.context.client.clientName, 'ANDROID');
  const headers = buildPlayerRequestHeaders({ clientName: 'ANDROID', clientVersion: '20.10.38' });
  assert.equal(headers['x-youtube-client-name'], '3');
  assert.equal(headers['x-youtube-client-version'], '20.10.38');
});

test('extracts and picks nearest progressive formats', () => {
  const response = {
    streamingData: {
      formats: [
        {
          itag: 18,
          height: 360,
          url: 'https://r1.googlevideo.com/videoplayback?itag=18',
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        },
        {
          itag: 22,
          height: 720,
          url: 'https://r1.googlevideo.com/videoplayback?itag=22',
          mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
        },
        {
          itag: 137,
          height: 1080,
          url: 'https://r1.googlevideo.com/videoplayback?itag=137',
          mimeType: 'video/mp4; codecs="avc1.640028"',
        },
      ],
    },
  };
  const progressive = extractProgressiveFormats(response);
  assert.equal(progressive.length, 2);
  assert.equal(pickBestProgressive(progressive, 1080).height, 720);
  assert.equal(pickBestProgressive(progressive, 360).height, 360);
  assert.equal(pickBestProgressive(progressive, 240), null);
});

test('resolveDownloadableFormats returns first client with progressive MP4', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const clientName = calls[calls.length - 1].body.context.client.clientName;
    if (clientName !== 'ANDROID') {
      return {
        ok: true,
        json: async () => ({ playabilityStatus: { status: 'UNPLAYABLE' } }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        playabilityStatus: { status: 'OK' },
        streamingData: {
          formats: [{
            itag: 18,
            height: 360,
            url: 'https://r1.googlevideo.com/videoplayback?itag=18&c=ANDROID',
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          }],
        },
      }),
    };
  };

  const result = await resolveDownloadableFormats('abc', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.client, 'ANDROID');
  assert.equal(result.progressive.length, 1);
  assert.equal(result.progressive[0].itag, 18);
});

test('resolveDownloadableFormats fails when no client yields progressive MP4', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: { formats: [] } }),
  });
  const result = await resolveDownloadableFormats('abc', { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NO_ANDROID_PROGRESSIVE');
});
