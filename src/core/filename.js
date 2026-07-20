(function attachFilenameCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function filenameFactory() {
  const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
  const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

  function cleanCandidate(value) {
    return String(value || '')
      .replace(INVALID_WINDOWS_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .trim();
  }

  function sanitizeFilename(value, fallback = 'video', maxLength = 180) {
    let candidate = cleanCandidate(value);
    if (!candidate) candidate = cleanCandidate(fallback) || 'video';
    if (RESERVED_WINDOWS_NAMES.test(candidate)) candidate = `_${candidate}`;
    if (candidate.length > maxLength) {
      candidate = candidate.slice(0, maxLength).replace(/[. ]+$/g, '').trim();
    }
    return candidate || 'video';
  }

  function buildSuggestedFilename(title, videoId) {
    const base = sanitizeFilename(title, videoId || 'video', 180);
    const withExt = /\.mp4$/i.test(base) ? base.replace(/\.mp4$/i, '') : base;
    return `${withExt || 'video'}.mp4`;
  }

  return { sanitizeFilename, buildSuggestedFilename };
});
