const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureMp4Filename,
  findForcedFilename,
  isExtensionContextInvalidated,
} = require('../src/core/download.js');

test('forces a final .mp4 extension and strips server error extensions', () => {
  assert.equal(ensureMp4Filename('Клип.mp4'), 'Клип.mp4');
  assert.equal(ensureMp4Filename('Клип.txt'), 'Клип.mp4');
  assert.equal(ensureMp4Filename('report.html'), 'report.mp4');
  assert.equal(ensureMp4Filename('video.mp4'), 'video.mp4');
  assert.equal(ensureMp4Filename(''), 'video.mp4');
});

test('does not leave a bare name without .mp4', () => {
  assert.equal(ensureMp4Filename('Название ролика'), 'Название ролика.mp4');
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

test('detects extension context invalidated errors', () => {
  assert.equal(isExtensionContextInvalidated(new Error('Extension context invalidated.')), true);
  assert.equal(isExtensionContextInvalidated(new Error('Could not establish connection. Receiving end does not exist.')), true);
  assert.equal(isExtensionContextInvalidated(new Error('network failed')), false);
});
