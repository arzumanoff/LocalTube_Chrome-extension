(function attachMessagesCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function messagesFactory() {
  const ALLOWED_TARGET_HEIGHTS = new Set([360, 480, 720, 1080, 1440, 2160, 4320]);
  const PAYLOAD_KEYS = ['metadata', 'targetHeight'];
  const METADATA_KEYS = ['videoId', 'title', 'channel', 'durationSeconds', 'isLive', 'isShort', 'formats'];
  const FORMAT_KEYS = [
    'itag', 'mimeType', 'container', 'codecs', 'qualityLabel', 'width', 'height', 'fps',
    'bitrate', 'contentLength', 'hasAudio', 'hasVideo', 'url',
  ];

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
      isAllowedMediaUrl(format.url);
  }

  function validateStartDownloadPayload(payload) {
    if (!hasExactKeys(payload, PAYLOAD_KEYS)) return { ok: false, errorCode: 'INVALID_PAYLOAD' };
    const metadata = payload.metadata;
    if (!hasExactKeys(metadata, METADATA_KEYS)) return { ok: false, errorCode: 'INVALID_METADATA' };
    if (typeof metadata.videoId !== 'string' || !metadata.videoId) return { ok: false, errorCode: 'INVALID_VIDEO_ID' };
    if (typeof metadata.title !== 'string' || !metadata.title) return { ok: false, errorCode: 'INVALID_TITLE' };
    if (typeof metadata.channel !== 'string') return { ok: false, errorCode: 'INVALID_CHANNEL' };
    if (!Number.isFinite(Number(metadata.durationSeconds))) return { ok: false, errorCode: 'INVALID_DURATION' };
    if (typeof metadata.isLive !== 'boolean' || typeof metadata.isShort !== 'boolean') {
      return { ok: false, errorCode: 'INVALID_FLAGS' };
    }
    if (!Array.isArray(metadata.formats) || metadata.formats.length < 1 || metadata.formats.length > 100) {
      return { ok: false, errorCode: 'INVALID_FORMATS' };
    }
    if (!metadata.formats.every(validateFormat)) return { ok: false, errorCode: 'INVALID_FORMAT' };
    if (payload.targetHeight !== null && !ALLOWED_TARGET_HEIGHTS.has(Number(payload.targetHeight))) {
      return { ok: false, errorCode: 'INVALID_TARGET_HEIGHT' };
    }
    return { ok: true };
  }

  return {
    ALLOWED_TARGET_HEIGHTS,
    isAllowedMediaUrl,
    validateStartDownloadPayload,
  };
});
