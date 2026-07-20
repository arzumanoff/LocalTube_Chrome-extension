(function attachMediaUrlCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function mediaUrlFactory() {
  const TOKEN_KEYS = ['n', 'pot'];
  const DROP_FROM_OBSERVED = new Set([
    'range', 'rn', 'rbuf', 'alr', 'cpn', 'cmt', 'dur', 'clen', 'lmt',
  ]);

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

  function isVideoPlaybackUrl(value) {
    const url = parseUrl(value);
    return Boolean(url && isGoogleVideoUrl(url) && url.pathname.includes('/videoplayback'));
  }

  function stripRangeParams(value) {
    const url = parseUrl(value);
    if (!url) return '';
    DROP_FROM_OBSERVED.forEach((key) => url.searchParams.delete(key));
    return url.toString();
  }

  function normalizeObservedEntry(entry) {
    if (typeof entry === 'string') {
      if (!isVideoPlaybackUrl(entry)) return null;
      return { url: stripRangeParams(entry), observedAt: 0, itag: new URL(entry).searchParams.get('itag') || '' };
    }
    if (!entry || typeof entry !== 'object') return null;
    if (!isVideoPlaybackUrl(entry.url)) return null;
    const cleaned = stripRangeParams(entry.url);
    const itag = String(entry.itag || parseUrl(cleaned)?.searchParams.get('itag') || '');
    return {
      url: cleaned,
      observedAt: Number(entry.observedAt || 0),
      itag,
    };
  }

  function normalizeObservedUrls(values, limit = 40) {
    const list = (Array.isArray(values) ? values : [])
      .map(normalizeObservedEntry)
      .filter(Boolean)
      .sort((a, b) => Number(a.observedAt || 0) - Number(b.observedAt || 0));
    return list.slice(-Math.max(1, Number(limit) || 40));
  }

  function extractPlaybackTokens(observedUrls) {
    const tokens = { n: '', pot: '', sourceUrl: '' };
    const newest = normalizeObservedUrls(observedUrls)
      .slice()
      .sort((a, b) => Number(b.observedAt || 0) - Number(a.observedAt || 0));
    for (const entry of newest) {
      const url = parseUrl(entry.url);
      if (!url) continue;
      for (const key of TOKEN_KEYS) {
        if (!tokens[key]) {
          const value = url.searchParams.get(key);
          if (value) tokens[key] = value;
        }
      }
      if (!tokens.sourceUrl) tokens.sourceUrl = entry.url;
      if (tokens.n && tokens.pot) break;
    }
    return tokens;
  }

  function findExactItagUrl(rawUrl, observedUrls) {
    const raw = parseUrl(rawUrl);
    if (!raw) return null;
    const itag = raw.searchParams.get('itag');
    if (!itag) return null;
    const match = normalizeObservedUrls(observedUrls)
      .filter((entry) => String(entry.itag) === String(itag))
      .sort((a, b) => Number(b.observedAt || 0) - Number(a.observedAt || 0))[0];
    return match ? match.url : null;
  }

  function applyPlaybackTokens(rawUrl, tokens, options = {}) {
    const raw = parseUrl(rawUrl);
    if (!raw || !isGoogleVideoUrl(raw)) return '';
    const replaceExisting = Boolean(options.replaceExisting);
    for (const key of TOKEN_KEYS) {
      const value = tokens && tokens[key];
      if (!value) continue;
      if (replaceExisting || !raw.searchParams.has(key) || key === 'n') {
        raw.searchParams.set(key, value);
      }
    }
    DROP_FROM_OBSERVED.forEach((key) => raw.searchParams.delete(key));
    return raw.toString();
  }

  function repairMediaUrl(rawUrl, observedUrls, options = {}) {
    if (!isVideoPlaybackUrl(rawUrl)) return null;
    const exact = findExactItagUrl(rawUrl, observedUrls);
    if (exact) return exact;
    const tokens = extractPlaybackTokens(observedUrls);
    if (!tokens.n && !tokens.pot) return String(rawUrl);
    return applyPlaybackTokens(rawUrl, tokens, options);
  }

  function looksLikeMp4(bytes) {
    if (!bytes || bytes.length < 12) return false;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // ISO BMFF: size(4) + 'ftyp'(4)
    return view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70;
  }

  function looksLikeTextPayload(bytes) {
    if (!bytes || !bytes.length) return false;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const sample = view.subarray(0, Math.min(view.length, 64));
    let textLike = 0;
    for (const byte of sample) {
      if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) textLike += 1;
    }
    return textLike / sample.length > 0.9;
  }

  function classifyMediaProbe(status, contentType, bytes) {
    const code = Number(status || 0);
    const type = String(contentType || '').toLowerCase();
    if (code === 403) return { ok: false, errorCode: 'MEDIA_URL_FORBIDDEN' };
    if (code === 401) return { ok: false, errorCode: 'MEDIA_URL_UNAUTHORIZED' };
    if (code === 404) return { ok: false, errorCode: 'MEDIA_URL_NOT_FOUND' };
    if (code !== 200 && code !== 206) return { ok: false, errorCode: 'MEDIA_PROBE_FAILED' };
    if (type.startsWith('text/') || type.includes('json') || type.includes('html') || type.includes('xml')) {
      return { ok: false, errorCode: 'MEDIA_BAD_CONTENT' };
    }
    if (bytes && bytes.length) {
      if (looksLikeTextPayload(bytes) && !looksLikeMp4(bytes)) {
        return { ok: false, errorCode: 'MEDIA_BAD_CONTENT' };
      }
      if (type.includes('mp4') || type.includes('octet-stream') || type === '') {
        if (bytes.length >= 12 && !looksLikeMp4(bytes) && looksLikeTextPayload(bytes)) {
          return { ok: false, errorCode: 'MEDIA_BAD_CONTENT' };
        }
      }
    }
    return { ok: true, errorCode: null };
  }

  async function probeMediaUrl(url, fetchImpl, options = {}) {
    if (!isGoogleVideoUrl(url) || typeof fetchImpl !== 'function') {
      return { ok: false, errorCode: 'INVALID_FORMAT' };
    }
    const headers = Object.assign({ Range: 'bytes=0-1023' }, options.headers || {});
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        credentials: options.credentials || 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      let bytes = null;
      try {
        const buffer = await response.arrayBuffer();
        bytes = new Uint8Array(buffer);
      } catch {
        bytes = null;
      }
      return classifyMediaProbe(
        response.status,
        response.headers?.get?.('content-type') || response.headers?.get?.('Content-Type') || '',
        bytes,
      );
    } catch {
      return { ok: false, errorCode: 'MEDIA_PROBE_FAILED' };
    }
  }

  function candidateUrls(rawUrl, observedUrls, extraTokens) {
    const out = [];
    const seen = new Set();
    function push(url, source) {
      if (!url || seen.has(url) || !isVideoPlaybackUrl(url)) return;
      seen.add(url);
      out.push({ url, source });
    }

    push(String(rawUrl || ''), 'raw');
    const exact = findExactItagUrl(rawUrl, observedUrls);
    push(exact, 'observed-same-itag');
    const repaired = repairMediaUrl(rawUrl, observedUrls, { replaceExisting: true });
    push(repaired, 'observed-player-token');
    if (extraTokens && (extraTokens.n || extraTokens.pot)) {
      push(applyPlaybackTokens(rawUrl, extraTokens, { replaceExisting: true }), 'tab-token');
      if (repaired) {
        push(applyPlaybackTokens(repaired, extraTokens, { replaceExisting: true }), 'observed+tab-token');
      }
    }
    return out;
  }

  async function resolveMediaUrl(rawUrl, observedUrls, fetchImpl, options = {}) {
    if (!isVideoPlaybackUrl(rawUrl)) return { ok: false, errorCode: 'INVALID_FORMAT' };
    const candidates = candidateUrls(rawUrl, observedUrls, options.extraTokens);
    let lastError = 'MEDIA_URL_FORBIDDEN';
    for (const candidate of candidates) {
      const probe = await probeMediaUrl(candidate.url, fetchImpl, options);
      if (probe.ok) {
        return { ok: true, url: candidate.url, source: candidate.source };
      }
      lastError = probe.errorCode || lastError;
    }
    return { ok: false, errorCode: lastError };
  }

  return {
    TOKEN_KEYS,
    isGoogleVideoUrl,
    isVideoPlaybackUrl,
    stripRangeParams,
    normalizeObservedUrls,
    extractPlaybackTokens,
    findExactItagUrl,
    applyPlaybackTokens,
    repairMediaUrl,
    looksLikeMp4,
    looksLikeTextPayload,
    classifyMediaProbe,
    probeMediaUrl,
    candidateUrls,
    resolveMediaUrl,
  };
});
