(function attachMetadataCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function metadataFactory() {
  function parseResponse(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return typeof value === 'object' ? value : null;
  }

  function parseCodecs(mimeType) {
    const match = String(mimeType || '').match(/codecs="([^"]+)"/i);
    if (!match) return [];
    return match[1].split(',').map((codec) => codec.trim()).filter(Boolean);
  }

  function parseContainer(mimeType) {
    const mediaType = String(mimeType || '').split(';', 1)[0].trim();
    return mediaType.includes('/') ? mediaType.split('/')[1].toLowerCase() : '';
  }

  function parseHeight(format) {
    const direct = Number(format && format.height);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const match = String(format && format.qualityLabel || '').match(/(\d{3,4})p/i);
    return match ? Number(match[1]) : 0;
  }

  function resolveFormatUrl(format) {
    if (format && format.url) return String(format.url);
    const cipher = format && (format.signatureCipher || format.cipher);
    if (!cipher) return '';
    try {
      const params = new URLSearchParams(String(cipher));
      return String(params.get('url') || '');
    } catch {
      return '';
    }
  }

  function stripVolatileParams(value) {
    try {
      const url = new URL(String(value || ''));
      ['range', 'rn', 'rbuf', 'alr', 'cpn', 'cmt', 'dur'].forEach((key) => url.searchParams.delete(key));
      return url.toString();
    } catch {
      return String(value || '');
    }
  }

  function normalizeObservedUrls(values) {
    if (globalThis.YTDCore && typeof globalThis.YTDCore.normalizeObservedUrls === 'function' &&
        globalThis.YTDCore.normalizeObservedUrls !== normalizeObservedUrls) {
      return globalThis.YTDCore.normalizeObservedUrls(values);
    }
    return (Array.isArray(values) ? values : [])
      .filter((entry) => entry && typeof entry.url === 'string')
      .slice(-40)
      .map((entry) => {
        const cleaned = stripVolatileParams(entry.url);
        let itag = String(entry.itag || '');
        try { itag = itag || new URL(cleaned).searchParams.get('itag') || ''; } catch { /* ignore */ }
        return {
          url: cleaned,
          observedAt: Number(entry.observedAt || 0),
          itag,
        };
      });
  }

  function normalizeFormat(format, source = 'web') {
    if (!format || typeof format !== 'object') return null;
    const url = resolveFormatUrl(format);
    if (!url) return null;
    const mimeType = String(format.mimeType || '');
    const codecs = parseCodecs(mimeType);
    const hasVideo = mimeType.startsWith('video/');
    const hasAudio = Boolean(format.audioQuality || format.audioSampleRate || codecs.some((c) => /^mp4a\./i.test(c)));
    const height = parseHeight(format);
    if (!hasVideo || !height) return null;

    return {
      itag: Number(format.itag),
      mimeType,
      container: parseContainer(mimeType),
      codecs,
      qualityLabel: String(format.qualityLabel || `${height}p`),
      width: Number(format.width || 0),
      height,
      fps: Number(format.fps || 0),
      bitrate: Number(format.bitrate || 0),
      contentLength: format.contentLength ? Number(format.contentLength) : null,
      hasAudio,
      hasVideo,
      url,
      client: String(source || 'web'),
    };
  }

  function mergeFormats(primary, secondary) {
    const map = new Map();
    for (const format of [...(secondary || []), ...(primary || [])]) {
      if (!format) continue;
      const key = `${format.itag}:${format.height}:${format.client || ''}`;
      map.set(key, format);
    }
    return [...map.values()].sort((a, b) =>
      Number(b.height || 0) - Number(a.height || 0) ||
      (String(a.client).startsWith('ANDROID') || String(a.client) === 'IOS' ? -1 : 0) -
      (String(b.client).startsWith('ANDROID') || String(b.client) === 'IOS' ? -1 : 0)
    );
  }

  function detailsMatchVideoId(details, expectedVideoId) {
    if (!details || typeof details !== 'object') return false;
    if (!expectedVideoId) return Boolean(details.videoId);
    return String(details.videoId || '') === String(expectedVideoId);
  }

  function pickVideoDetails(options = {}) {
    const expectedVideoId = String(options.expectedVideoId || '');
    const candidates = [
      options.downloadDetails,
      options.webDetails,
      options.domDetails,
      options.videoDetails,
    ];
    for (const candidate of candidates) {
      if (detailsMatchVideoId(candidate, expectedVideoId)) return candidate;
    }
    return null;
  }

  function extractPlayerMetadata(rawResponse, currentUrl, observedUrls = [], options = {}) {
    const response = parseResponse(rawResponse);
    const expectedVideoId = String(options.expectedVideoId || '');

    // Never accept mismatched WEB response body.
    const webDetails = response && response.videoDetails && detailsMatchVideoId(response.videoDetails, expectedVideoId)
      ? response.videoDetails
      : null;
    const downloadDetails = options.downloadDetails && detailsMatchVideoId(options.downloadDetails, expectedVideoId)
      ? options.downloadDetails
      : null;
    const fallbackDetails = options.videoDetails && detailsMatchVideoId(options.videoDetails, expectedVideoId)
      ? options.videoDetails
      : null;
    const domDetails = options.domDetails && detailsMatchVideoId(options.domDetails, expectedVideoId)
      ? options.domDetails
      : null;

    const details = pickVideoDetails({
      expectedVideoId,
      downloadDetails,
      webDetails,
      domDetails,
      videoDetails: fallbackDetails,
    });
    if (!details || !details.videoId) return null;
    if (expectedVideoId && String(details.videoId) !== expectedVideoId) return null;

    const webFormats = (response && webDetails && response.streamingData && Array.isArray(response.streamingData.formats)
      ? response.streamingData.formats
      : [])
      .map((format) => normalizeFormat(format, 'web'))
      .filter(Boolean);

    const downloadFormats = (Array.isArray(options.downloadFormats) ? options.downloadFormats : [])
      .map((format) => normalizeFormat(format, format.client || options.downloadClient || 'android'))
      .filter(Boolean);

    const formats = mergeFormats(downloadFormats, webFormats);
    if (!formats.length) return null;

    const title = String(details.title || options.domTitle || details.videoId || expectedVideoId || 'video');

    return {
      videoId: String(details.videoId),
      title,
      channel: String(details.author || ''),
      durationSeconds: Number(details.lengthSeconds || 0),
      isLive: Boolean(details.isLiveContent),
      isShort: /\/shorts\//.test(String(currentUrl || '')),
      formats,
      observedUrls: normalizeObservedUrls(observedUrls),
      downloadClient: String(options.downloadClient || (downloadFormats[0] && downloadFormats[0].client) || ''),
    };
  }

  return {
    parseCodecs,
    normalizeFormat,
    normalizeObservedUrls,
    resolveFormatUrl,
    mergeFormats,
    detailsMatchVideoId,
    pickVideoDetails,
    extractPlayerMetadata,
  };
});
