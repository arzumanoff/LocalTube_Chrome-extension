(function installPageBridge() {
  if (window.__YTD_PAGE_BRIDGE_INSTALLED__) return;
  window.__YTD_PAGE_BRIDGE_INSTALLED__ = true;

  const SOURCE = 'ytd-extension';
  const REQUEST = 'YTD_REQUEST_METADATA';
  const RESPONSE = 'YTD_PLAYER_METADATA';
  const observedMediaUrls = new Map();
  let inflight = null;
  let lastEmittedVideoId = '';

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

  function readYtcfg(key) {
    try {
      if (window.ytcfg?.get) return window.ytcfg.get(key);
      return window.ytcfg?.data_?.[key] || null;
    } catch {
      return null;
    }
  }

  function isGoogleVideoRequest(value) {
    if (window.YTDCore?.isVideoPlaybackUrl) return window.YTDCore.isVideoPlaybackUrl(value);
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' &&
        (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) &&
        url.pathname.includes('/videoplayback');
    } catch {
      return false;
    }
  }

  function rememberMediaUrl(value) {
    if (!isGoogleVideoRequest(value)) return;
    let cleaned = String(value);
    let itag = '';
    try {
      const url = new URL(cleaned);
      ['range', 'rn', 'rbuf', 'alr', 'cpn', 'cmt'].forEach((key) => url.searchParams.delete(key));
      itag = url.searchParams.get('itag') || '';
      cleaned = url.toString();
    } catch {
      return;
    }
    observedMediaUrls.set(cleaned, { observedAt: Date.now(), itag });
    if (observedMediaUrls.size > 40) {
      const oldest = [...observedMediaUrls.entries()]
        .sort((a, b) => a[1].observedAt - b[1].observedAt)
        .slice(0, observedMediaUrls.size - 40);
      oldest.forEach(([url]) => observedMediaUrls.delete(url));
    }
  }

  function collectObservedUrls() {
    return [...observedMediaUrls.entries()]
      .map(([url, meta]) => ({
        url,
        observedAt: Number(meta.observedAt || 0),
        itag: String(meta.itag || ''),
      }))
      .sort((a, b) => a.observedAt - b.observedAt);
  }

  function scanPerformanceEntries(entries) {
    for (const entry of entries || []) rememberMediaUrl(entry?.name);
  }

  function observePlaybackUrls() {
    try {
      scanPerformanceEntries(performance.getEntriesByType('resource'));
    } catch {
      // Resource timing may be unavailable during early navigation.
    }
    if (typeof PerformanceObserver !== 'function') return;
    try {
      const observer = new PerformanceObserver((list) => scanPerformanceEntries(list.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // Older Chromium builds can reject buffered resource observers.
    }
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

  async function resolveDownloadableFormats(videoId) {
    if (!videoId || !window.YTDCore?.resolveDownloadableFormats) {
      return { ok: false, progressive: [], client: '' };
    }
    const apiKey = readYtcfg('INNERTUBE_API_KEY') || undefined;
    const visitorData = readYtcfg('VISITOR_DATA') || '';
    const clients = (window.YTDCore.FALLBACK_CLIENTS || []).map((client) => ({
      ...client,
      visitorData: visitorData || client.visitorData,
    }));
    return window.YTDCore.resolveDownloadableFormats(videoId, {
      apiKey,
      clients,
      fetchImpl: window.fetch.bind(window),
      credentials: 'include',
    });
  }

  async function buildMetadata() {
    try {
      scanPerformanceEntries(performance.getEntriesByType('resource'));
    } catch { /* ignore */ }

    const videoId = currentVideoId();
    const webResponse = findCurrentResponse();
    const downloadable = await resolveDownloadableFormats(videoId);
    const downloadFormats = downloadable.ok
      ? (downloadable.progressive || []).map((format) => ({ ...format, client: downloadable.client }))
      : [];

    const metadata = window.YTDCore?.extractPlayerMetadata?.(
      webResponse,
      window.location.href,
      collectObservedUrls(),
      {
        downloadFormats,
        downloadClient: downloadable.client || '',
        videoDetails: webResponse?.videoDetails || downloadable.response?.videoDetails,
      },
    ) || null;

    return metadata;
  }

  async function emitMetadata() {
    const videoId = currentVideoId();
    if (!videoId) {
      window.postMessage({ source: SOURCE, type: RESPONSE, payload: null }, window.location.origin);
      return;
    }

    if (inflight && lastEmittedVideoId === videoId) {
      try {
        const metadata = await inflight;
        window.postMessage({ source: SOURCE, type: RESPONSE, payload: metadata }, window.location.origin);
      } catch { /* ignore */ }
      return;
    }

    lastEmittedVideoId = videoId;
    inflight = buildMetadata();
    try {
      const metadata = await inflight;
      window.postMessage({ source: SOURCE, type: RESPONSE, payload: metadata }, window.location.origin);
    } catch {
      window.postMessage({ source: SOURCE, type: RESPONSE, payload: null }, window.location.origin);
    } finally {
      inflight = null;
    }
  }

  function scheduleMetadataEmission() {
    [0, 300, 900, 1800, 3500].forEach((delay) => window.setTimeout(() => {
      emitMetadata().catch(() => undefined);
    }, delay));
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source === SOURCE && event.data?.type === REQUEST) scheduleMetadataEmission();
  });

  document.addEventListener('yt-navigate-finish', () => {
    lastEmittedVideoId = '';
    scheduleMetadataEmission();
  }, true);
  window.addEventListener('popstate', () => {
    lastEmittedVideoId = '';
    scheduleMetadataEmission();
  });
  observePlaybackUrls();
  scheduleMetadataEmission();
})();
