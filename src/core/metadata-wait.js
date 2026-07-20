(function attachMetadataWaitCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function metadataWaitFactory() {
  /**
   * Wait until metadataRevision advances past the value observed before requestMetadata().
   * Never treats a pre-existing metadata object as fresh.
   */
  async function waitForFreshMetadata(options = {}) {
    const getRevision = options.getRevision;
    const getMetadata = options.getMetadata;
    const requestMetadata = options.requestMetadata;
    const expectedVideoId = options.expectedVideoId || '';
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 4000;
    const pollMs = Number.isFinite(Number(options.pollMs)) ? Number(options.pollMs) : 50;
    const sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    if (typeof getRevision !== 'function' || typeof getMetadata !== 'function' || typeof requestMetadata !== 'function') {
      return { ok: false, errorCode: 'RETRY_METADATA_REQUIRED', metadata: null, revision: 0 };
    }

    const previousRevision = Number(getRevision() || 0);
    requestMetadata();

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      await sleep(pollMs);
      const revision = Number(getRevision() || 0);
      if (revision <= previousRevision) continue;

      const metadata = getMetadata();
      if (!metadata || typeof metadata !== 'object' || !metadata.videoId) {
        return {
          ok: false,
          errorCode: 'RETRY_METADATA_REQUIRED',
          metadata: metadata || null,
          revision,
          previousRevision,
        };
      }
      if (expectedVideoId && String(metadata.videoId) !== String(expectedVideoId)) {
        return {
          ok: false,
          errorCode: 'RETRY_VIDEO_MISMATCH',
          metadata,
          revision,
          previousRevision,
        };
      }
      return {
        ok: true,
        metadata,
        revision,
        previousRevision,
      };
    }

    return {
      ok: false,
      errorCode: 'RETRY_METADATA_REQUIRED',
      metadata: getMetadata() || null,
      revision: Number(getRevision() || 0),
      previousRevision,
    };
  }

  return { waitForFreshMetadata };
});
