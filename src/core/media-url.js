(function attachMediaUrlCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function mediaUrlFactory() {
  const TOKEN_KEYS = ['n', 'pot'];
  const DROP_FROM_OBSERVED = new Set([
    'range', 'rn', 'rbuf', 'alr', 'cpn', 'cmt', 'dur', 'clen', 'lmt',
  ]);
  const DEFAULT_PREFIX_BYTES = 1024;
  const FTYP = [0x66, 0x74, 0x79, 0x70]; // ftyp

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
    const tokens = { n: '', pot: '' };
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

  function readBoxType(view, offset) {
    if (!view || offset + 8 > view.length) return '';
    return String.fromCharCode(view[offset + 4], view[offset + 5], view[offset + 6], view[offset + 7]);
  }

  function readBoxSize(view, offset) {
    if (!view || offset + 8 > view.length) return 0;
    const size = ((view[offset] << 24) | (view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3]) >>> 0;
    if (size === 1) {
      // 64-bit largesize — treat as unknown/unbounded for prefix scans
      return 0;
    }
    return size;
  }

  function findFtypOffset(bytes, scanLimit = 64) {
    if (!bytes || !bytes.length) return -1;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const limit = Math.min(view.length, Math.max(8, Number(scanLimit) || 64));
    let offset = 0;
    while (offset + 8 <= limit) {
      const type = readBoxType(view, offset);
      if (type === 'ftyp') {
        if (
          view[offset + 4] === FTYP[0] &&
          view[offset + 5] === FTYP[1] &&
          view[offset + 6] === FTYP[2] &&
          view[offset + 7] === FTYP[3]
        ) {
          return offset;
        }
      }
      const size = readBoxSize(view, offset);
      if (size < 8) {
        // Malformed or unknown size — only accept ftyp at absolute start as last resort
        if (offset === 0 && type === 'ftyp') return 0;
        break;
      }
      offset += size;
    }
    return -1;
  }

  function looksLikeMp4(bytes) {
    return findFtypOffset(bytes, 64) >= 0;
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
    if (!bytes || !bytes.length) return { ok: false, errorCode: 'MEDIA_PROBE_FAILED' };
    if (looksLikeTextPayload(bytes) && !looksLikeMp4(bytes)) {
      return { ok: false, errorCode: 'MEDIA_BAD_CONTENT' };
    }
    if (!looksLikeMp4(bytes)) {
      return { ok: false, errorCode: 'MEDIA_NOT_MP4' };
    }
    return { ok: true, errorCode: null };
  }

  async function readResponsePrefix(response, maxBytes = DEFAULT_PREFIX_BYTES) {
    const limit = Math.max(1, Math.min(Number(maxBytes) || DEFAULT_PREFIX_BYTES, 8192));
    const chunks = [];
    let total = 0;
    let cancelled = false;

    if (response && response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      try {
        while (total < limit) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          const remaining = limit - total;
          if (value.length <= remaining) {
            chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
            total += value.length;
          } else {
            chunks.push((value instanceof Uint8Array ? value : new Uint8Array(value)).subarray(0, remaining));
            total += remaining;
            try {
              await reader.cancel();
              cancelled = true;
            } catch {
              cancelled = true;
            }
            break;
          }
        }
        if (!cancelled && total >= limit) {
          try {
            await reader.cancel();
            cancelled = true;
          } catch {
            cancelled = true;
          }
        }
      } finally {
        try { reader.releaseLock?.(); } catch { /* ignore */ }
      }
    } else if (response && typeof response.arrayBuffer === 'function') {
      // Test/fallback Response without a stream body — still hard-cap size.
      const buffer = await response.arrayBuffer();
      const view = new Uint8Array(buffer);
      const slice = view.subarray(0, Math.min(view.length, limit));
      chunks.push(slice);
      total = slice.length;
      cancelled = view.length > limit;
    } else {
      return { bytes: new Uint8Array(0), bytesRead: 0, cancelled: false };
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return { bytes: out, bytesRead: total, cancelled };
  }

  async function probeMediaUrl(url, fetchImpl, options = {}) {
    if (!isGoogleVideoUrl(url) || typeof fetchImpl !== 'function') {
      return { ok: false, errorCode: 'INVALID_FORMAT' };
    }
    const maxBytes = Number(options.maxBytes) || DEFAULT_PREFIX_BYTES;
    const headers = Object.assign({ Range: `bytes=0-${maxBytes - 1}` }, options.headers || {});
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        credentials: options.credentials || 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      let bytes = new Uint8Array(0);
      try {
        const prefix = await readResponsePrefix(response, maxBytes);
        bytes = prefix.bytes;
      } catch {
        bytes = new Uint8Array(0);
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
    DEFAULT_PREFIX_BYTES,
    isGoogleVideoUrl,
    isVideoPlaybackUrl,
    stripRangeParams,
    normalizeObservedUrls,
    extractPlaybackTokens,
    findExactItagUrl,
    applyPlaybackTokens,
    repairMediaUrl,
    findFtypOffset,
    looksLikeMp4,
    looksLikeTextPayload,
    classifyMediaProbe,
    readResponsePrefix,
    probeMediaUrl,
    candidateUrls,
    resolveMediaUrl,
  };
});
