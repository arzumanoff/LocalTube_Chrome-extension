(function attachMessagesCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function messagesFactory() {
  const ALLOWED_TARGET_HEIGHTS = new Set([360, 480, 720, 1080, 1440, 2160, 4320]);
  const PAYLOAD_KEYS = ['metadata', 'targetHeight', 'requestedFilename'];
  const RETRY_PAYLOAD_KEYS = ['jobId', 'metadata'];
  const METADATA_KEYS = [
    'videoId', 'title', 'channel', 'durationSeconds', 'isLive', 'isShort',
    'formats', 'observedUrls', 'downloadClient',
  ];
  const FORMAT_KEYS = [
    'itag', 'mimeType', 'container', 'codecs', 'qualityLabel', 'width', 'height', 'fps',
    'bitrate', 'contentLength', 'hasAudio', 'hasVideo', 'url', 'client',
  ];
  const OBSERVED_URL_KEYS = ['url', 'observedAt', 'itag'];

  function hasExactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  }

  function isAllowedMediaUrl(value) {
    try {
      const url = new URL(String(value));
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && (host === 'googlevideo.com' || host.endsWith('.googlevideo.com'));
    } catch {
      return false;
    }
  }

  function validateFormat(format) {
    return hasExactKeys(format, FORMAT_KEYS) &&
      Number.isFinite(Number(format.itag)) &&
      typeof format.mimeType === 'string' &&
      format.container === 'mp4' &&
      Array.isArray(format.codecs) &&
      typeof format.qualityLabel === 'string' &&
      Number.isFinite(Number(format.width)) &&
      Number.isFinite(Number(format.height)) &&
      Number(format.height) > 0 &&
      Number.isFinite(Number(format.fps)) &&
      Number.isFinite(Number(format.bitrate)) &&
      (format.contentLength === null || Number.isFinite(Number(format.contentLength))) &&
      typeof format.hasAudio === 'boolean' &&
      typeof format.hasVideo === 'boolean' &&
      typeof format.client === 'string' &&
      isAllowedMediaUrl(format.url);
  }

  function validateObservedUrl(entry) {
    return hasExactKeys(entry, OBSERVED_URL_KEYS) &&
      isAllowedMediaUrl(entry.url) &&
      Number.isFinite(Number(entry.observedAt)) &&
      typeof entry.itag === 'string';
  }

  function validateMetadata(metadata) {
    if (!hasExactKeys(metadata, METADATA_KEYS)) return { ok: false, errorCode: 'INVALID_METADATA' };
    if (typeof metadata.videoId !== 'string' || !metadata.videoId) return { ok: false, errorCode: 'INVALID_VIDEO_ID' };
    if (typeof metadata.title !== 'string' || !metadata.title) return { ok: false, errorCode: 'INVALID_TITLE' };
    if (typeof metadata.channel !== 'string') return { ok: false, errorCode: 'INVALID_CHANNEL' };
    if (!Number.isFinite(Number(metadata.durationSeconds))) return { ok: false, errorCode: 'INVALID_DURATION' };
    if (typeof metadata.isLive !== 'boolean' || typeof metadata.isShort !== 'boolean') {
      return { ok: false, errorCode: 'INVALID_FLAGS' };
    }
    if (typeof metadata.downloadClient !== 'string') return { ok: false, errorCode: 'INVALID_DOWNLOAD_CLIENT' };
    if (!Array.isArray(metadata.formats) || metadata.formats.length < 1 || metadata.formats.length > 100) {
      return { ok: false, errorCode: 'INVALID_FORMATS' };
    }
    if (!metadata.formats.every(validateFormat)) return { ok: false, errorCode: 'INVALID_FORMAT' };
    if (!Array.isArray(metadata.observedUrls) || metadata.observedUrls.length > 40) {
      return { ok: false, errorCode: 'INVALID_OBSERVED_URLS' };
    }
    if (!metadata.observedUrls.every(validateObservedUrl)) {
      return { ok: false, errorCode: 'INVALID_OBSERVED_URL' };
    }
    return { ok: true };
  }

  function validateStartDownloadPayload(payload) {
    if (!hasExactKeys(payload, PAYLOAD_KEYS)) return { ok: false, errorCode: 'INVALID_PAYLOAD' };
    const meta = validateMetadata(payload.metadata);
    if (!meta.ok) return meta;
    if (payload.targetHeight !== null && !ALLOWED_TARGET_HEIGHTS.has(Number(payload.targetHeight))) {
      return { ok: false, errorCode: 'INVALID_TARGET_HEIGHT' };
    }
    if (typeof payload.requestedFilename !== 'string') {
      return { ok: false, errorCode: 'INVALID_REQUESTED_FILENAME' };
    }
    if (payload.requestedFilename.length > 260) {
      return { ok: false, errorCode: 'INVALID_REQUESTED_FILENAME' };
    }
    return { ok: true };
  }

  function validateRetryDownloadPayload(payload) {
    if (!hasExactKeys(payload, RETRY_PAYLOAD_KEYS)) return { ok: false, errorCode: 'INVALID_PAYLOAD' };
    if (typeof payload.jobId !== 'string' || !payload.jobId) return { ok: false, errorCode: 'JOB_NOT_FOUND' };
    return validateMetadata(payload.metadata);
  }

  return {
    ALLOWED_TARGET_HEIGHTS,
    isAllowedMediaUrl,
    validateMetadata,
    validateStartDownloadPayload,
    validateRetryDownloadPayload,
  };
});
