(function installPageBridge() {
  if (window.__YTD_PAGE_BRIDGE_INSTALLED__) return;
  window.__YTD_PAGE_BRIDGE_INSTALLED__ = true;

  const SOURCE = 'ytd-extension';
  const REQUEST = 'YTD_REQUEST_METADATA';
  const RESPONSE = 'YTD_PLAYER_METADATA';
  const observedPlaybackUrls = [];
  const observedPlaybackUrlSet = new Set();

  function rememberPlaybackUrl(value) {
    const url = String(value || '');
    if (!window.YTDCore?.isGoogleVideoUrl?.(url) || observedPlaybackUrlSet.has(url)) return;
    observedPlaybackUrlSet.add(url);
    observedPlaybackUrls.push(url);
    while (observedPlaybackUrls.length > 100) {
      observedPlaybackUrlSet.delete(observedPlaybackUrls.shift());
    }
  }

  function seedPlaybackUrls() {
    try {
      performance.getEntriesByType('resource').forEach((entry) => rememberPlaybackUrl(entry.name));
    } catch { /* Resource timing may be unavailable during early navigation. */ }
  }

  function observePlaybackUrls() {
    seedPlaybackUrls();
    if (typeof PerformanceObserver !== 'function') return;
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => rememberPlaybackUrl(entry.name));
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch { /* Older Chromium builds can reject buffered resource observers. */ }
  }

  function currentVideoId() {
    const url = new URL(window.location.href);
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || '';
    return url.searchParams.get('v') || '';
  }

  function parsePlayerResponse(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return typeof value === 'object' ? value : null;
  }

  function playerCandidates() {
    return [
      document.querySelector('ytd-reel-video-renderer[is-active] #movie_player'),
      document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player'),
      document.querySelector('#movie_player'),
      document.querySelector('.html5-video-player'),
    ].filter(Boolean);
  }

  function collectResponses() {
    const responses = [];
    for (const player of playerCandidates()) {
      try {
        if (typeof player.getPlayerResponse === 'function') {
          const response = parsePlayerResponse(player.getPlayerResponse());
          if (response) responses.push(response);
        }
      } catch { /* YouTube may replace a player during navigation. */ }
    }

    const initial = parsePlayerResponse(window.ytInitialPlayerResponse);
    if (initial) responses.push(initial);

    const configured = parsePlayerResponse(window.ytplayer?.config?.args?.player_response);
    if (configured) responses.push(configured);

    return responses;
  }

  function findCurrentResponse() {
    const expectedId = currentVideoId();
    const responses = collectResponses();
    if (!responses.length) return null;
    return responses.find((response) => response?.videoDetails?.videoId === expectedId) || responses[0];
  }

  function emitMetadata() {
    seedPlaybackUrls();
    const response = findCurrentResponse();
    const metadata = window.YTDCore?.extractPlayerMetadata?.(
      response,
      window.location.href,
      observedPlaybackUrls,
    ) || null;
    window.postMessage({
      source: SOURCE,
      type: RESPONSE,
      payload: metadata,
    }, window.location.origin);
  }

  function scheduleMetadataEmission() {
    [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(emitMetadata, delay));
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source === SOURCE && event.data?.type === REQUEST) scheduleMetadataEmission();
  });

  document.addEventListener('yt-navigate-finish', scheduleMetadataEmission, true);
  window.addEventListener('popstate', scheduleMetadataEmission);
  observePlaybackUrls();
  scheduleMetadataEmission();
})();
