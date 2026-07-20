(function attachDownloadCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function downloadFactory() {
  function ensureMp4Filename(filename, fallback = 'video.mp4') {
    const raw = String(filename || '').trim() || String(fallback || 'video.mp4');
    const withoutTrailingDots = raw.replace(/[. ]+$/g, '');
    if (/\.mp4$/i.test(withoutTrailingDots)) return withoutTrailingDots;
    const strippedKnown = withoutTrailingDots.replace(/\.(txt|html?|json|bin|download)$/i, '');
    const base = strippedKnown || 'video';
    return `${base}.mp4`;
  }

  function findForcedFilename(downloadItem, pendingEntries) {
    const urls = [downloadItem && downloadItem.finalUrl, downloadItem && downloadItem.url]
      .filter(Boolean)
      .map(String);
    for (const entry of Array.isArray(pendingEntries) ? pendingEntries : []) {
      if (!entry) continue;
      if (urls.includes(String(entry.url || ''))) {
        return ensureMp4Filename(entry.filename || '');
      }
    }
    return '';
  }

  function isExtensionContextInvalidated(error) {
    const message = String(error && error.message || error || '');
    return /extension context invalidated/i.test(message) ||
      /message port closed/i.test(message) ||
      /receiving end does not exist/i.test(message);
  }

  return {
    ensureMp4Filename,
    findForcedFilename,
    isExtensionContextInvalidated,
  };
});
