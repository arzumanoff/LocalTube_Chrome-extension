const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureMp4Filename,
  createPendingFilenameEntry,
  claimForcedFilename,
  matchesExpectedFilename,
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

test('claims by downloadId when available so parallel jobs keep distinct names', () => {
  const pending = [
    createPendingFilenameEntry({
      id: 'p1',
      jobId: 'job-a',
      filename: 'Alpha.mp4',
      downloadId: 11,
    }),
    createPendingFilenameEntry({
      id: 'p2',
      jobId: 'job-b',
      filename: 'Beta.mp4',
      downloadId: 22,
    }),
  ];

  assert.deepEqual(
    claimForcedFilename({ id: 22 }, pending),
    { filename: 'Beta.mp4', entryId: 'p2', strategy: 'downloadId' },
  );
  assert.deepEqual(
    claimForcedFilename({ id: 11 }, pending),
    { filename: 'Alpha.mp4', entryId: 'p1', strategy: 'downloadId' },
  );
});

test('onDeterminingFilename before downloadId uses FIFO queue order', () => {
  const pending = [
    createPendingFilenameEntry({ id: 'p1', jobId: 'job-a', filename: 'Alpha.mp4' }),
    createPendingFilenameEntry({ id: 'p2', jobId: 'job-b', filename: 'Beta.mp4' }),
  ];
  // Event fires with an id that is not bound yet — claim oldest unclaimed entry.
  const first = claimForcedFilename({ id: 99, url: 'https://r.googlevideo.com/videoplayback' }, pending);
  assert.equal(first.strategy, 'queue');
  assert.equal(first.filename, 'Alpha.mp4');
  assert.equal(first.entryId, 'p1');

  // Mark first claimed and ensure second is next.
  pending[0].claimed = true;
  const second = claimForcedFilename({ id: 100 }, pending);
  assert.equal(second.filename, 'Beta.mp4');
  assert.equal(second.entryId, 'p2');
});

test('matchesExpectedFilename accepts uniquify suffixes and rejects videoplayback', () => {
  assert.equal(matchesExpectedFilename('Me at the zoo.mp4', 'Me at the zoo.mp4'), true);
  assert.equal(matchesExpectedFilename('Me at the zoo (1).mp4', 'Me at the zoo.mp4'), true);
  assert.equal(matchesExpectedFilename('videoplayback.mp4', 'Me at the zoo.mp4'), false);
  assert.equal(matchesExpectedFilename('videoplayback (1).mp4', 'Me at the zoo.mp4'), false);
  assert.equal(matchesExpectedFilename('Мой тестовый ролик.mp4', 'Мой тестовый ролик.mp4'), true);
});

test('detects extension context invalidated errors', () => {
  assert.equal(isExtensionContextInvalidated(new Error('Extension context invalidated.')), true);
  assert.equal(isExtensionContextInvalidated(new Error('Could not establish connection. Receiving end does not exist.')), true);
  assert.equal(isExtensionContextInvalidated(new Error('network failed')), false);
});
