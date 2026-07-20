const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDownloadJob,
  applyDownloadDelta,
  reconcileDownloadState,
  sanitizeJobForStorage,
  migrateStoredJobs,
  validateRetryPayload,
} = require('../src/core/jobs.js');

const selectedFormat = {
  itag: 18,
  height: 360,
  contentLength: 1000,
  url: 'https://r1.googlevideo.com/videoplayback?itag=18&expire=1&sig=old',
};

test('creates a persistent download job without storing signed sourceUrl', () => {
  const job = createDownloadJob({
    id: 'job-1',
    videoId: 'abc',
    title: 'Title',
    targetHeight: 720,
    selectedFormat,
    suggestedFilename: 'Title.mp4',
    now: 100,
  });
  assert.equal(job.state, 'created');
  assert.equal(job.videoId, 'abc');
  assert.equal(job.targetHeight, 720);
  assert.equal(job.resolvedHeight, 360);
  assert.equal(job.selectedItag, 18);
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'sourceUrl'), false);
  assert.deepEqual(sanitizeJobForStorage(job).sourceUrl, undefined);
});

test('sanitizeJobForStorage strips sourceUrl and unknown fields', () => {
  const clean = sanitizeJobForStorage({
    id: '1',
    videoId: 'v',
    title: 't',
    targetHeight: 360,
    resolvedHeight: 360,
    selectedItag: 18,
    suggestedFilename: 't.mp4',
    state: 'failed',
    downloadId: 9,
    bytesReceived: 1,
    totalBytes: 2,
    errorCode: 'X',
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    sourceUrl: 'https://r1.googlevideo.com/videoplayback?sig=secret',
    pot: 'token',
  });
  assert.equal(clean.sourceUrl, undefined);
  assert.equal(clean.pot, undefined);
  assert.equal(clean.id, '1');
  assert.equal(clean.downloadId, 9);
});

test('migrateStoredJobs removes sourceUrl from legacy records', () => {
  const { jobs, changed } = migrateStoredJobs([{
    id: 'legacy',
    videoId: 'abc',
    title: 'Old',
    targetHeight: 360,
    resolvedHeight: 360,
    selectedItag: 18,
    sourceUrl: 'https://r1.googlevideo.com/videoplayback?expire=1',
    suggestedFilename: 'Old.mp4',
    state: 'failed',
    downloadId: null,
    bytesReceived: 0,
    totalBytes: 0,
    errorCode: 'MEDIA_URL_FORBIDDEN',
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
  }]);
  assert.equal(changed, true);
  assert.equal(jobs.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(jobs[0], 'sourceUrl'), false);
  assert.equal(jobs[0].videoId, 'abc');
  assert.equal(jobs[0].errorCode, 'MEDIA_URL_FORBIDDEN');
});

test('applies Chrome download progress and completion deltas', () => {
  const job = createDownloadJob({
    id: 'job-2', videoId: 'abc', title: 'T', targetHeight: null,
    selectedFormat, suggestedFilename: 'T.mp4', now: 1,
  });
  const progress = applyDownloadDelta(job, {
    bytesReceived: { current: 50 },
    totalBytes: { current: 100 },
    state: { current: 'in_progress' },
  }, 2);
  assert.equal(progress.state, 'downloading');
  assert.equal(progress.bytesReceived, 50);
  const done = applyDownloadDelta(progress, { state: { current: 'complete' } }, 3);
  assert.equal(done.state, 'completed');
  assert.equal(done.completedAt, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(done, 'sourceUrl'), false);
});

test('marks interrupted downloads as failed with an actionable error', () => {
  const job = createDownloadJob({
    id: 'job-3', videoId: 'abc', title: 'T', targetHeight: 360,
    selectedFormat, suggestedFilename: 'T.mp4', now: 1,
  });
  const failed = applyDownloadDelta(job, {
    state: { current: 'interrupted' },
    error: { current: 'NETWORK_FAILED' },
  }, 2);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'NETWORK_FAILED');
});

test('reconciles a missing active Chrome download as recoverable', () => {
  const job = createDownloadJob({
    id: 'job-4', videoId: 'abc', title: 'T', targetHeight: 360,
    selectedFormat, suggestedFilename: 'T.mp4', now: 1,
  });
  job.state = 'downloading';
  job.downloadId = 42;
  const recovered = reconcileDownloadState(job, null, 9);
  assert.equal(recovered.state, 'recoverable');
  assert.equal(recovered.errorCode, 'DOWNLOAD_RECORD_MISSING');
});

test('validateRetryPayload rejects mismatched video ids and accepts matching metadata', () => {
  const job = createDownloadJob({
    id: 'job-5', videoId: 'abc', title: 'T', targetHeight: 720,
    selectedFormat, suggestedFilename: 'T.mp4', now: 1,
  });
  assert.deepEqual(validateRetryPayload(job, { videoId: 'other' }), {
    ok: false,
    errorCode: 'RETRY_VIDEO_MISMATCH',
  });
  assert.deepEqual(validateRetryPayload(job, { videoId: 'abc' }), { ok: true });
});

test('retry keeps original targetHeight and videoId semantics', () => {
  const job = createDownloadJob({
    id: 'job-6', videoId: 'vid-1', title: 'Clip', targetHeight: 1080,
    selectedFormat, suggestedFilename: 'Clip.mp4', now: 1,
  });
  assert.equal(job.targetHeight, 1080);
  assert.equal(job.videoId, 'vid-1');
  const match = validateRetryPayload(job, { videoId: 'vid-1' });
  assert.equal(match.ok, true);
});
