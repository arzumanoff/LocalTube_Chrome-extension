const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDownloadJob,
  applyDownloadDelta,
  calculateProgressPercent,
  reconcileDownloadState,
} = require('../src/core/jobs.js');

test('creates a persistent download job in created state', () => {
  const job = createDownloadJob({
    id: 'job-1', videoId: 'abc', title: 'Video', targetHeight: 1080,
    selectedFormat: { itag: 22, height: 720, url: 'https://media/720' },
    suggestedFilename: 'Video.mp4', now: 100,
  });
  assert.equal(job.state, 'created');
  assert.equal(job.resolvedHeight, 720);
  assert.equal(job.createdAt, 100);
});

test('applies Chrome download progress and completion deltas', () => {
  const base = createDownloadJob({
    id: 'job-1', videoId: 'abc', title: 'Video', targetHeight: 720,
    selectedFormat: { itag: 22, height: 720, url: 'https://media/720' },
    suggestedFilename: 'Video.mp4', now: 100,
  });
  const downloading = applyDownloadDelta(base, {
    bytesReceived: { current: 50 }, totalBytes: { current: 100 }, state: { current: 'in_progress' },
  }, 200);
  assert.equal(downloading.state, 'downloading');
  assert.equal(calculateProgressPercent(downloading), 50);
  const completed = applyDownloadDelta(downloading, { state: { current: 'complete' } }, 300);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completedAt, 300);
});

test('marks interrupted downloads as failed with an actionable error', () => {
  const base = createDownloadJob({
    id: 'job-1', videoId: 'abc', title: 'Video', targetHeight: 720,
    selectedFormat: { itag: 22, height: 720, url: 'https://media/720' },
    suggestedFilename: 'Video.mp4', now: 100,
  });
  const failed = applyDownloadDelta(base, {
    state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' },
  }, 200);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'NETWORK_FAILED');
});

test('reconciles a missing active Chrome download as recoverable', () => {
  const base = createDownloadJob({
    id: 'job-1', videoId: 'abc', title: 'Video', targetHeight: 720,
    selectedFormat: { itag: 22, height: 720, url: 'https://media/720' },
    suggestedFilename: 'Video.mp4', now: 100,
  });
  base.state = 'downloading';
  base.downloadId = 9;
  assert.equal(reconcileDownloadState(base, null, 500).state, 'recoverable');
});
