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

  function isGoogleVideoUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'));
    } catch {
      return false;
    }
  }

  function extractPoTokenFromResourceUrls(resourceUrls) {
    let token = '';
    for (const value of Array.isArray(resourceUrls) ? resourceUrls : []) {
      if (!isGoogleVideoUrl(value)) continue;
      try {
        const candidate = new URL(value).searchParams.get('pot');
        if (candidate) token = candidate;
      } catch { /* Ignore malformed performance entries. */ }
    }
    return token;
  }

  function addPoTokenToGoogleVideoUrl(value, poToken, replaceExisting = false) {
    if (!poToken || !isGoogleVideoUrl(value)) return String(value || '');
    const url = new URL(String(value));
    if (replaceExisting || !url.searchParams.has('pot')) url.searchParams.set('pot', poToken);
    return url.toString();
  }

  function parseHeight(format) {
    const direct = Number(format && format.height);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const match = String(format && format.qualityLabel || '').match(/(\d{3,4})p/i);
    return match ? Number(match[1]) : 0;
  }

  function normalizeFormat(format, poToken = '') {
    if (!format || typeof format !== 'object' || !format.url) return null;
    const mimeType = String(format.mimeType || '');
    const codecs = parseCodecs(mimeType);
    const hasVideo = mimeType.startsWith('video/');
    const hasAudio = Boolean(format.audioQuality || format.audioSampleRate || codecs.length > 1);
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
      url: addPoTokenToGoogleVideoUrl(format.url, poToken),
    };
  }

  function extractPlayerMetadata(rawResponse, currentUrl, resourceUrls = []) {
    const response = parseResponse(rawResponse);
    const details = response && response.videoDetails;
    if (!response || !details || !details.videoId) return null;

    const poToken = extractPoTokenFromResourceUrls(resourceUrls);
    const formats = (response.streamingData && Array.isArray(response.streamingData.formats)
      ? response.streamingData.formats
      : [])
      .map((format) => normalizeFormat(format, poToken))
      .filter(Boolean);

    return {
      videoId: String(details.videoId),
      title: String(details.title || details.videoId),
      channel: String(details.author || ''),
      durationSeconds: Number(details.lengthSeconds || 0),
      isLive: Boolean(details.isLiveContent),
      isShort: /\/shorts\//.test(String(currentUrl || '')),
      formats,
    };
  }

  return {
    parseCodecs,
    isGoogleVideoUrl,
    extractPoTokenFromResourceUrls,
    addPoTokenToGoogleVideoUrl,
    normalizeFormat,
    extractPlayerMetadata,
  };
});
