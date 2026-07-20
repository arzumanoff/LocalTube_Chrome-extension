(function attachDownloadCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function downloadFactory() {
  function ensureMp4Filename(filename, fallback = 'video.mp4') {
    const raw = String(filename || '').trim() || String(fallback || 'video.mp4');
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
      filename: ensureMp4Filename(input.filename || 'video.mp4'),
      downloadId: Number.isInteger(input.downloadId) ? input.downloadId : null,
      claimed: false,
      expiresAt: Number(input.expiresAt || Date.now() + 60000),
    };
  }

  /**
   * Resolve filename for an onDeterminingFilename event.
   * Order:
   * 1) exact downloadId match (after download() callback)
   * 2) oldest unclaimed pending entry for this extension (event often fires BEFORE downloadId exists)
   */
  function claimForcedFilename(downloadItem, pendingEntries, options = {}) {
    const entries = (Array.isArray(pendingEntries) ? pendingEntries : []).filter(Boolean);
    if (!downloadItem || !entries.length) {
      return { filename: '', entryId: '', strategy: 'none' };
    }

    const now = Number(options.now || Date.now());
    const active = entries.filter((entry) => Number(entry.expiresAt || 0) > now && !entry.claimed);

    const downloadId = Number.isInteger(downloadItem.id) ? downloadItem.id : null;
    if (downloadId != null) {
      const byId = active.find((entry) => entry.downloadId === downloadId)
        || entries.find((entry) => entry.downloadId === downloadId);
      if (byId) {
        return {
          filename: ensureMp4Filename(byId.filename || ''),
          entryId: byId.id,
          strategy: 'downloadId',
        };
      }
    }

    // Race-safe path: onDeterminingFilename usually runs before downloadId is known.
    const next = active[0];
    if (next) {
      return {
        filename: ensureMp4Filename(next.filename || ''),
        entryId: next.id,
        strategy: 'queue',
      };
    }

    return { filename: '', entryId: '', strategy: 'none' };
  }

  // Back-compat alias used by older tests/call sites.
  function findForcedFilename(downloadItem, pendingEntries) {
    return claimForcedFilename(downloadItem, pendingEntries);
  }

  function matchesExpectedFilename(actualName, expectedName) {
    const actual = String(actualName || '').trim();
    const expected = ensureMp4Filename(expectedName || 'video.mp4');
    if (!actual || !expected) return false;
    if (/^videoplayback(\s*\(\d+\))?\.mp4$/i.test(actual)) return false;
    if (actual.toLowerCase() === expected.toLowerCase()) return true;
    // Chrome uniquify: "Title (1).mp4"
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\.mp4$/i, '');
    const pattern = new RegExp(`^${escaped}( \\(\\d+\\))?\\.mp4$`, 'i');
    return pattern.test(actual);
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
    claimForcedFilename,
    findForcedFilename,
    matchesExpectedFilename,
    isExtensionContextInvalidated,
  };
});
