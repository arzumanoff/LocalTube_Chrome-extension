(function attachDownloadCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function downloadFactory() {
  function classifyMediaProbe(status, contentType) {
    const code = Number(status || 0);
    const type = String(contentType || '').toLowerCase();
    if (code === 403) return { ok: false, errorCode: 'GVS_FORBIDDEN' };
    if (code !== 200 && code !== 206) return { ok: false, errorCode: 'MEDIA_PROBE_FAILED' };
    if (type.startsWith('text/') || type.includes('json') || type.includes('html')) {
      return { ok: false, errorCode: 'MEDIA_BAD_CONTENT' };
    }
    return { ok: true, errorCode: null };
  }

  function findForcedFilename(downloadItem, pendingEntries) {
    const urls = [downloadItem && downloadItem.finalUrl, downloadItem && downloadItem.url]
      .filter(Boolean)
      .map(String);
    for (const entry of Array.isArray(pendingEntries) ? pendingEntries : []) {
      if (entry && urls.includes(String(entry.url || ''))) return String(entry.filename || '');
    }
    return '';
  }

  return { classifyMediaProbe, findForcedFilename };
});
