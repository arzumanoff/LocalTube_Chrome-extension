const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyMediaProbe,
  findForcedFilename,
} = require('../src/core/download.js');

test('accepts a partial MP4 response from Google Video', () => {
  assert.deepEqual(classifyMediaProbe(206, 'video/mp4'), { ok: true, errorCode: null });
});

test('classifies HTTP 403 as a GVS access-token failure', () => {
  assert.deepEqual(classifyMediaProbe(403, 'text/plain'), { ok: false, errorCode: 'GVS_FORBIDDEN' });
});

test('rejects a text response even when the HTTP status is successful', () => {
  assert.deepEqual(classifyMediaProbe(200, 'text/plain'), { ok: false, errorCode: 'MEDIA_BAD_CONTENT' });
});

test('forces the requested MP4 filename for a matching download URL', () => {
  const filename = findForcedFilename({
    url: 'https://r1.googlevideo.com/videoplayback?itag=18',
    finalUrl: '',
  }, [{
    url: 'https://r1.googlevideo.com/videoplayback?itag=18',
    filename: 'Название ролика.mp4',
  }]);
  assert.equal(filename, 'Название ролика.mp4');
});
