(function attachQualityCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function qualityFactory() {
  const DEFAULT_TARGET_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

  function clientPriority(client) {
    const name = String(client || '');
    if (name === 'ANDROID' || name.startsWith('ANDROID')) return 3;
    if (name === 'IOS') return 2;
    if (name === 'web' || name === 'WEB') return 0;
    return 1;
  }

  function isProgressiveMp4(format) {
    const codecs = Array.isArray(format && format.codecs) ? format.codecs : [];
    const hasH264 = codecs.some((codec) => /^avc[13]\./i.test(String(codec)));
    const hasAac = codecs.some((codec) => /^mp4a\./i.test(String(codec)));
    return Boolean(
      format &&
      format.url &&
      format.container === 'mp4' &&
      format.hasAudio === true &&
      format.hasVideo === true &&
      hasH264 &&
      hasAac &&
      Number.isFinite(Number(format.height))
    );
  }

  function compareFormats(a, b) {
    return (
      Number(b.height || 0) - Number(a.height || 0) ||
      clientPriority(b.client) - clientPriority(a.client) ||
      Number(b.fps || 0) - Number(a.fps || 0) ||
      Number(b.bitrate || 0) - Number(a.bitrate || 0)
    );
  }

  function selectNearestProgressiveMp4(formats, targetHeight) {
    const ceiling = targetHeight == null ? Number.POSITIVE_INFINITY : Number(targetHeight);
    if (!Number.isFinite(ceiling) && targetHeight != null) return null;

    const candidates = (Array.isArray(formats) ? formats : [])
      .filter(isProgressiveMp4)
      .filter((format) => Number(format.height) <= ceiling)
      .sort(compareFormats);

    return candidates[0] || null;
  }

  function buildQualityOptions(formats, targets = DEFAULT_TARGET_HEIGHTS) {
    return targets.map((targetHeight) => {
      const selected = selectNearestProgressiveMp4(formats, targetHeight);
      return {
        targetHeight,
        label: `${targetHeight}p`,
        available: Boolean(selected),
        resolvedHeight: selected ? Number(selected.height) : null,
        isFallback: Boolean(selected && Number(selected.height) !== Number(targetHeight)),
      };
    });
  }

  return {
    DEFAULT_TARGET_HEIGHTS,
    isProgressiveMp4,
    selectNearestProgressiveMp4,
    buildQualityOptions,
  };
});
