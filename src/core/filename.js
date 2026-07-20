(function attachFilenameCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function filenameFactory() {
  const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
  const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const PATH_SEPARATORS = /[\\/]/;
  const KNOWN_BAD_EXTENSIONS = /\.(txt|html?|json|bin|download|crdownload)$/i;

  function stripPathComponents(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() || '';
  }

  function cleanCandidate(value) {
    let text = String(value || '');
    if (PATH_SEPARATORS.test(text) || /^[a-zA-Z]:/.test(text)) {
      text = stripPathComponents(text);
    }
    return text
      .replace(INVALID_WINDOWS_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .trim();
  }

  function stripTrailingKnownExtension(value) {
    let candidate = String(value || '');
    // Collapse duplicated .mp4 and replace server-error extensions.
    while (/\.mp4$/i.test(candidate)) {
      candidate = candidate.replace(/\.mp4$/i, '');
    }
    candidate = candidate.replace(KNOWN_BAD_EXTENSIONS, '');
    return candidate.replace(/[. ]+$/g, '').trim();
  }

  function sanitizeFilename(value, fallback = 'video', maxLength = 180) {
    let candidate = cleanCandidate(value);
    candidate = stripTrailingKnownExtension(candidate);
    if (!candidate) {
      candidate = stripTrailingKnownExtension(cleanCandidate(fallback)) || 'video';
    }
    if (RESERVED_WINDOWS_NAMES.test(candidate)) candidate = `_${candidate}`;
    if (candidate.length > maxLength) {
      candidate = candidate.slice(0, maxLength).replace(/[. ]+$/g, '').trim();
    }
    return candidate || 'video';
  }

  function buildSuggestedFilename(titleOrName, videoId) {
    const base = sanitizeFilename(titleOrName, videoId || 'video', 180);
    return `${base || 'video'}.mp4`;
  }

  function resolveRequestedFilename(requestedFilename, title, videoId) {
    const requested = String(requestedFilename || '').trim();
    if (requested) return buildSuggestedFilename(requested, videoId || title || 'video');
    if (String(title || '').trim()) return buildSuggestedFilename(title, videoId || 'video');
    return buildSuggestedFilename(videoId || 'video', 'video');
  }

  return {
    sanitizeFilename,
    buildSuggestedFilename,
    resolveRequestedFilename,
    stripPathComponents,
  };
});
