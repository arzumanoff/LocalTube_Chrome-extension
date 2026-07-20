(function installPageBridge() {
  if (window.__YTD_PAGE_BRIDGE_INSTALLED__) return;
  window.__YTD_PAGE_BRIDGE_INSTALLED__ = true;

  const SOURCE = 'ytd-extension';
  const REQUEST = 'YTD_REQUEST_METADATA';
  const RESPONSE = 'YTD_PLAYER_METADATA';

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
    const response = findCurrentResponse();
    const metadata = window.YTDCore?.extractPlayerMetadata?.(response, window.location.href) || null;
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
  scheduleMetadataEmission();
})();
