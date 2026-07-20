(function attachMediaUrlCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function mediaUrlFactory() {
  function parseUrl(value) {
    try {
      return new URL(String(value || ''));
    } catch {
      return null;
    }
  }

  function isGoogleVideoUrl(value) {
    const url = parseUrl(value);
    if (!url || url.protocol !== 'https:') return false;
    return url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com');
  }

  function newestObservedUrl(observedUrls) {
    return (Array.isArray(observedUrls) ? observedUrls : [])
      .map((entry) => typeof entry === 'string' ? { url: entry, observedAt: 0 } : entry)
      .filter((entry) => entry && isGoogleVideoUrl(entry.url))
      .sort((a, b) => Number(b.observedAt || 0) - Number(a.observedAt || 0))[0]?.url || null;
  }

  function repairMediaUrl(rawUrl, observedUrls) {
    const raw = parseUrl(rawUrl);
    if (!raw || !isGoogleVideoUrl(raw)) return null;

    const observed = parseUrl(newestObservedUrl(observedUrls));
    if (!observed) return raw.toString();

    const observedN = observed.searchParams.get('n');
    if (raw.searchParams.has('n') && observedN) raw.searchParams.set('n', observedN);

    const observedPot = observed.searchParams.get('pot');
    if (!raw.searchParams.has('pot') && observedPot) raw.searchParams.set('pot', observedPot);

    return raw.toString();
  }

  async function probeMediaUrl(url, fetchImpl) {
    if (!isGoogleVideoUrl(url) || typeof fetchImpl !== 'function') return false;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      const ok = response.status === 200 || response.status === 206;
      try { await response.body?.cancel(); } catch { /* The body may already be closed. */ }
      return ok;
    } catch {
      return false;
    }
  }

  async function resolveMediaUrl(rawUrl, observedUrls, fetchImpl) {
    if (!isGoogleVideoUrl(rawUrl)) return { ok: false, errorCode: 'INVALID_FORMAT' };

    if (await probeMediaUrl(rawUrl, fetchImpl)) {
      return { ok: true, url: rawUrl, source: 'raw' };
    }

    const repairedUrl = repairMediaUrl(rawUrl, observedUrls);
    if (repairedUrl && repairedUrl !== rawUrl && await probeMediaUrl(repairedUrl, fetchImpl)) {
      return { ok: true, url: repairedUrl, source: 'observed-player-token' };
    }

    return { ok: false, errorCode: 'MEDIA_URL_FORBIDDEN' };
  }

  return {
    isGoogleVideoUrl,
    repairMediaUrl,
    probeMediaUrl,
    resolveMediaUrl,
  };
});