(function attachJobsCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function jobsFactory() {
  const PERSISTED_JOB_KEYS = [
    'id', 'videoId', 'title', 'targetHeight', 'resolvedHeight', 'selectedItag',
    'suggestedFilename', 'actualFilename', 'state', 'downloadId', 'bytesReceived', 'totalBytes',
    'errorCode', 'createdAt', 'updatedAt', 'completedAt',
  ];

  function createDownloadJob(input) {
    const now = Number(input.now || Date.now());
    return {
      id: String(input.id),
      videoId: String(input.videoId),
      title: String(input.title || input.videoId),
      targetHeight: input.targetHeight == null ? null : Number(input.targetHeight),
      resolvedHeight: Number(input.selectedFormat.height),
      selectedItag: Number(input.selectedFormat.itag),
      suggestedFilename: String(input.suggestedFilename),
      actualFilename: null,
      state: 'created',
      downloadId: null,
      bytesReceived: 0,
      totalBytes: Number(input.selectedFormat.contentLength || 0),
      errorCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
  }

  function sanitizeJobForStorage(job) {
    if (!job || typeof job !== 'object') return null;
    const clean = {};
    for (const key of PERSISTED_JOB_KEYS) {
      if (Object.prototype.hasOwnProperty.call(job, key)) clean[key] = job[key];
    }
    // Never persist signed media URLs or token-bearing fields.
    return clean;
  }

  function migrateStoredJobs(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    let changed = false;
    const migrated = list.map((job) => {
      if (!job || typeof job !== 'object') {
        changed = true;
        return null;
      }
      const hadSourceUrl = Object.prototype.hasOwnProperty.call(job, 'sourceUrl');
      const clean = sanitizeJobForStorage(job);
      if (!clean) {
        changed = true;
        return null;
      }
      if (hadSourceUrl || Object.keys(job).some((key) => !PERSISTED_JOB_KEYS.includes(key))) {
        changed = true;
      }
      return clean;
    }).filter(Boolean);
    return { jobs: migrated, changed };
  }

  function applyDownloadDelta(job, delta, now = Date.now()) {
    const next = Object.assign({}, sanitizeJobForStorage(job) || job, { updatedAt: Number(now) });
    if (delta.bytesReceived && delta.bytesReceived.current != null) {
      next.bytesReceived = Number(delta.bytesReceived.current);
    }
    if (delta.totalBytes && delta.totalBytes.current != null) {
      next.totalBytes = Number(delta.totalBytes.current);
    }
    if (delta.paused && delta.paused.current === true) next.state = 'paused';
    if (delta.paused && delta.paused.current === false && next.state === 'paused') next.state = 'downloading';
    if (delta.state && delta.state.current === 'in_progress') next.state = 'downloading';
    if (delta.state && delta.state.current === 'complete') {
      next.state = 'completed';
      next.completedAt = Number(now);
      next.errorCode = null;
    }
    if (delta.state && delta.state.current === 'interrupted') {
      next.state = 'failed';
      next.errorCode = delta.error && delta.error.current ? String(delta.error.current) : 'DOWNLOAD_INTERRUPTED';
    } else if (delta.error && delta.error.current) {
      next.errorCode = String(delta.error.current);
    }
    return sanitizeJobForStorage(next);
  }

  function calculateProgressPercent(job) {
    const total = Number(job && job.totalBytes || 0);
    const received = Number(job && job.bytesReceived || 0);
    if (!total || total < 1) return 0;
    return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
  }

  function reconcileDownloadState(job, downloadItem, now = Date.now()) {
    const base = sanitizeJobForStorage(job) || job;
    if (!downloadItem && ['created', 'downloading', 'paused'].includes(base.state)) {
      return sanitizeJobForStorage(Object.assign({}, base, {
        state: 'recoverable',
        errorCode: 'DOWNLOAD_RECORD_MISSING',
        updatedAt: Number(now),
      }));
    }
    if (!downloadItem) return base;
    return applyDownloadDelta(base, {
      bytesReceived: { current: downloadItem.bytesReceived || 0 },
      totalBytes: { current: downloadItem.totalBytes || 0 },
      paused: { current: Boolean(downloadItem.paused) },
      state: { current: downloadItem.state },
      error: downloadItem.error ? { current: downloadItem.error } : undefined,
    }, now);
  }

  function validateRetryPayload(job, metadata) {
    if (!job || typeof job !== 'object' || !job.id || !job.videoId) {
      return { ok: false, errorCode: 'JOB_NOT_FOUND' };
    }
    if (!metadata || typeof metadata !== 'object') {
      return { ok: false, errorCode: 'INVALID_METADATA' };
    }
    if (String(metadata.videoId || '') !== String(job.videoId)) {
      return { ok: false, errorCode: 'RETRY_VIDEO_MISMATCH' };
    }
    return { ok: true };
  }

  return {
    PERSISTED_JOB_KEYS,
    createDownloadJob,
    sanitizeJobForStorage,
    migrateStoredJobs,
    applyDownloadDelta,
    calculateProgressPercent,
    reconcileDownloadState,
    validateRetryPayload,
  };
});
