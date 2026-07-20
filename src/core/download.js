(function attachDownloadCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function downloadFactory() {
  function ensureMp4Filename(filename, fallback = 'video.mp4') {
    const raw = String(filename || '').trim() || String(fallback || 'video.mp4');
    // Reject path-like input by keeping only the last segment.
    const leaf = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() || raw;
    const withoutTrailingDots = leaf.replace(/[. ]+$/g, '');
    let base = withoutTrailingDots;
    while (/\.mp4$/i.test(base)) base = base.replace(/\.mp4$/i, '');
    base = base.replace(/\.(txt|html?|json|bin|download|crdownload)$/i, '');
    base = base.replace(/[. ]+$/g, '').trim() || 'video';
    return `${base}.mp4`;
  }

  function createPendingFilenameEntry(input) {
    return {
      id: String(input.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      jobId: String(input.jobId || ''),
      url: String(input.url || ''),
      filename: ensureMp4Filename(input.filename || 'video.mp4'),
      downloadId: Number.isInteger(input.downloadId) ? input.downloadId : null,
      expiresAt: Number(input.expiresAt || Date.now() + 60000),
    };
  }

  function findForcedFilename(downloadItem, pendingEntries) {
    const entries = Array.isArray(pendingEntries) ? pendingEntries.filter(Boolean) : [];
    if (!downloadItem || !entries.length) return { filename: '', entryId: '' };

    const downloadId = Number.isInteger(downloadItem.id) ? downloadItem.id : null;
    if (downloadId != null) {
      const byId = entries.find((entry) => entry.downloadId === downloadId);
      if (byId) {
        return { filename: ensureMp4Filename(byId.filename || ''), entryId: byId.id };
      }
    }

    const urls = [downloadItem.finalUrl, downloadItem.url].filter(Boolean).map(String);
    const byUrl = entries.find((entry) => urls.includes(String(entry.url || '')));
    if (byUrl) {
      return { filename: ensureMp4Filename(byUrl.filename || ''), entryId: byUrl.id };
    }

    return { filename: '', entryId: '' };
  }

  function isExtensionContextInvalidated(error) {
    const message = String(error && error.message || error || '');
    return /extension context invalidated/i.test(message) ||
      /message port closed/i.test(message) ||
      /receiving end does not exist/i.test(message);
  }

  return {
    ensureMp4Filename,
    createPendingFilenameEntry,
    findForcedFilename,
    isExtensionContextInvalidated,
  };
});
