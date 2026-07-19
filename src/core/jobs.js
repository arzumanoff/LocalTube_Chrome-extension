(function attachJobsCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function jobsFactory() {
  function createDownloadJob(input) {
    const now = Number(input.now || Date.now());
    return {
      id: String(input.id),
      videoId: String(input.videoId),
      title: String(input.title || input.videoId),
      targetHeight: input.targetHeight == null ? null : Number(input.targetHeight),
      resolvedHeight: Number(input.selectedFormat.height),
      selectedItag: Number(input.selectedFormat.itag),
      sourceUrl: String(input.selectedFormat.url),
      suggestedFilename: String(input.suggestedFilename),
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

  function applyDownloadDelta(job, delta, now = Date.now()) {
    const next = Object.assign({}, job, { updatedAt: Number(now) });
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
    return next;
  }

  function calculateProgressPercent(job) {
    const total = Number(job && job.totalBytes || 0);
    const received = Number(job && job.bytesReceived || 0);
    if (!total || total < 1) return 0;
    return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
  }

  function reconcileDownloadState(job, downloadItem, now = Date.now()) {
    if (!downloadItem && ['created', 'downloading', 'paused'].includes(job.state)) {
      return Object.assign({}, job, {
        state: 'recoverable',
        errorCode: 'DOWNLOAD_RECORD_MISSING',
        updatedAt: Number(now),
      });
    }
    if (!downloadItem) return job;
    return applyDownloadDelta(job, {
      bytesReceived: { current: downloadItem.bytesReceived || 0 },
      totalBytes: { current: downloadItem.totalBytes || 0 },
      paused: { current: Boolean(downloadItem.paused) },
      state: { current: downloadItem.state },
      error: downloadItem.error ? { current: downloadItem.error } : undefined,
    }, now);
  }

  return {
    createDownloadJob,
    applyDownloadDelta,
    calculateProgressPercent,
    reconcileDownloadState,
  };
});
