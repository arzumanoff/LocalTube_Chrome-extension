(function attachNativeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function nativeFactory() {
  const NATIVE_HOST_NAME = 'com.arzumanoff.media_engine';
  const MAX_URL_LENGTH = 4096;
  const MAX_FILENAME_LENGTH = 260;
  const MAX_QUALITIES = 100;
  const RETRYABLE_NATIVE_ACTIONS = new Set(['ping', 'status', 'probe']);
  const RETRYABLE_NATIVE_ERROR_CODES = new Set(['NATIVE_HOST_DISCONNECTED', 'NATIVE_SEND_FAILED']);

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isSupportedYouTubeUrl(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return false;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return false;
      const host = url.hostname.toLowerCase();
      if (host === 'youtu.be') return Boolean(url.pathname.slice(1));
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return false;
      if (url.pathname === '/watch') return Boolean(url.searchParams.get('v'));
      return url.pathname.startsWith('/shorts/') && Boolean(url.pathname.split('/')[2]);
    } catch {
      return false;
    }
  }

  function normalizePositiveInt(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.round(number);
  }

  function qualityLabel(height, fps) {
    const safeHeight = normalizePositiveInt(height);
    const safeFps = normalizePositiveInt(fps);
    if (!safeHeight) return '';
    return safeFps > 30 ? `${safeHeight}p${safeFps}` : `${safeHeight}p`;
  }

  function normalizeQuality(raw) {
    if (!isPlainObject(raw)) return null;
    const height = normalizePositiveInt(raw.height);
    const fps = normalizePositiveInt(raw.fps);
    if (!height) return null;
    const id = typeof raw.id === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(raw.id)
      ? raw.id
      : `h${height}-f${fps || 0}`;
    return {
      id,
      height,
      fps,
      label: qualityLabel(height, fps),
      requiresMerge: Boolean(raw.requiresMerge),
      requiresTranscode: Boolean(raw.requiresTranscode),
    };
  }

  function normalizeProbeResponse(response) {
    if (!isPlainObject(response) || response.ok !== true) {
      return {
        ok: false,
        errorCode: typeof response?.errorCode === 'string' ? response.errorCode : 'NATIVE_PROBE_FAILED',
        message: typeof response?.message === 'string' ? response.message : 'Не удалось получить данные ролика.',
      };
    }

    const rawQualities = Array.isArray(response.qualities) ? response.qualities : [];
    if (!rawQualities.length || rawQualities.length > MAX_QUALITIES) {
      return { ok: false, errorCode: 'NO_QUALITIES', message: 'Доступные качества не найдены.' };
    }

    const seen = new Set();
    const qualities = rawQualities
      .map(normalizeQuality)
      .filter(Boolean)
      .filter((quality) => {
        if (seen.has(quality.id)) return false;
        seen.add(quality.id);
        return true;
      })
      .sort((a, b) => b.height - a.height || b.fps - a.fps || a.id.localeCompare(b.id));

    if (!qualities.length) {
      return { ok: false, errorCode: 'NO_QUALITIES', message: 'Доступные качества не найдены.' };
    }

    return {
      ok: true,
      videoId: typeof response.videoId === 'string' ? response.videoId : '',
      title: typeof response.title === 'string' && response.title.trim() ? response.title.trim() : 'Видео',
      channel: typeof response.channel === 'string' ? response.channel.trim() : '',
      duration: Number.isFinite(Number(response.duration)) ? Math.max(0, Number(response.duration)) : 0,
      thumbnail: typeof response.thumbnail === 'string' ? response.thumbnail : '',
      qualities,
    };
  }

  function validateFilename(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_FILENAME_LENGTH;
  }

  function buildProbePayload(url) {
    if (!isSupportedYouTubeUrl(url)) return { ok: false, errorCode: 'INVALID_VIDEO_URL' };
    return { ok: true, payload: { url } };
  }

  function buildDownloadPayload({ url, qualityId, suggestedFilename }) {
    if (!isSupportedYouTubeUrl(url)) return { ok: false, errorCode: 'INVALID_VIDEO_URL' };
    if (typeof qualityId !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(qualityId)) {
      return { ok: false, errorCode: 'INVALID_QUALITY' };
    }
    if (!validateFilename(suggestedFilename)) {
      return { ok: false, errorCode: 'INVALID_REQUESTED_FILENAME' };
    }
    return { ok: true, payload: { url, qualityId, suggestedFilename: suggestedFilename.trim() } };
  }

  function buildCancelPayload(jobId) {
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(jobId)) {
      return { ok: false, errorCode: 'INVALID_JOB_ID' };
    }
    return { ok: true, payload: { jobId } };
  }

  function shouldRetryNativeRequest(action, response, attempt = 0) {
    if (attempt !== 0) return false;
    if (!RETRYABLE_NATIVE_ACTIONS.has(String(action || ''))) return false;
    return RETRYABLE_NATIVE_ERROR_CODES.has(String(response?.errorCode || ''));
  }

  return {
    NATIVE_HOST_NAME,
    isSupportedYouTubeUrl,
    qualityLabel,
    normalizeQuality,
    normalizeProbeResponse,
    buildProbePayload,
    buildDownloadPayload,
    buildCancelPayload,
    shouldRetryNativeRequest,
  };
});
