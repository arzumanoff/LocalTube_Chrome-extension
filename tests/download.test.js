const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureMp4Filename,
  createPendingFilenameEntry,
  findForcedFilename,
  isExtensionContextInvalidated,
} = require('../src/core/download.js');

test('forces a final .mp4 extension and strips server error extensions', () => {
  assert.equal(ensureMp4Filename('Клип.mp4'), 'Клип.mp4');
  assert.equal(ensureMp4Filename('Клип.txt'), 'Клип.mp4');
  assert.equal(ensureMp4Filename('report.html'), 'report.mp4');
  assert.equal(ensureMp4Filename('video.mp4'), 'video.mp4');
  assert.equal(ensureMp4Filename('video.mp4.mp4'), 'video.mp4');
  assert.equal(ensureMp4Filename(''), 'video.mp4');
});

test('does not leave a bare name without .mp4', () => {
  assert.equal(ensureMp4Filename('Название ролика'), 'Название ролика.mp4');
});

test('matches forced filename by downloadId first so parallel jobs do not swap names', () => {
  const pending = [
    createPendingFilenameEntry({
      id: 'p1',
      jobId: 'job-a',
      url: 'https://r1.googlevideo.com/videoplayback?itag=18&id=a',
      filename: 'Alpha.mp4',
      downloadId: 11,
    }),
    createPendingFilenameEntry({
      id: 'p2',
      jobId: 'job-b',
      url: 'https://r2.googlevideo.com/videoplayback?itag=18&id=b',
      filename: 'Beta.mp4',
      downloadId: 22,
    }),
  ];

  assert.deepEqual(
    findForcedFilename({ id: 22, url: 'https://r2.googlevideo.com/videoplayback?itag=18&id=b' }, pending),
    { filename: 'Beta.mp4', entryId: 'p2' },
  );
  assert.deepEqual(
    findForcedFilename({ id: 11, url: 'https://r1.googlevideo.com/videoplayback?itag=18&id=a' }, pending),
    { filename: 'Alpha.mp4', entryId: 'p1' },
  );
});

test('falls back to exact media URL when downloadId is not bound yet', () => {
  const pending = [
    createPendingFilenameEntry({
      id: 'p3',
      jobId: 'job-c',
      url: 'https://r3.googlevideo.com/videoplayback?itag=18&id=c',
      filename: 'Gamma.mp4',
    }),
  ];
  const match = findForcedFilename({
    url: 'https://r3.googlevideo.com/videoplayback?itag=18&id=c',
    finalUrl: '',
  }, pending);
  assert.equal(match.filename, 'Gamma.mp4');
  assert.equal(match.entryId, 'p3');
});

test('detects extension context invalidated errors', () => {
  assert.equal(isExtensionContextInvalidated(new Error('Extension context invalidated.')), true);
  assert.equal(isExtensionContextInvalidated(new Error('Could not establish connection. Receiving end does not exist.')), true);
  assert.equal(isExtensionContextInvalidated(new Error('network failed')), false);
});
