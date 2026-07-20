(function attachInnertubeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YTDCore = Object.assign(root.YTDCore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function innertubeFactory() {
  const ANDROID_CLIENT = {
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    androidSdkVersion: 30,
    hl: 'en',
    gl: 'US',
  };

  const FALLBACK_CLIENTS = [
    ANDROID_CLIENT,
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.62.27',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      hl: 'en',
      gl: 'US',
    },
    {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceModel: 'iPhone16,2',
      hl: 'en',
      gl: 'US',
    },
  ];

  function isProgressiveAvcAac(format) {
    const mime = String(format && format.mimeType || '');
    return Boolean(
      format &&
      format.url &&
      mime.startsWith('video/mp4') &&
      /avc1/i.test(mime) &&
      /mp4a/i.test(mime)
    );
  }

  function buildPlayerRequestBody(videoId, client, extras = {}) {
    return {
      context: {
        client: Object.assign({}, client),
      },
      videoId: String(videoId || ''),
      contentCheckOk: true,
      racyCheckOk: true,
      ...extras,
    };
  }

  function buildPlayerRequestUrl(apiKey) {
    const key = String(apiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8');
    return `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`;
  }

  function clientHeaderName(clientName) {
    switch (String(clientName || '')) {
      case 'WEB': return '1';
      case 'MWEB': return '2';
      case 'ANDROID': return '3';
      case 'IOS': return '5';
      case 'TVHTML5': return '7';
      case 'ANDROID_VR': return '28';
      default: return '3';
    }
  }

  function buildPlayerRequestHeaders(client) {
    return {
      'content-type': 'application/json',
      'x-youtube-client-name': clientHeaderName(client.clientName),
      'x-youtube-client-version': String(client.clientVersion || ''),
    };
  }

  function extractProgressiveFormats(playerResponse) {
    const formats = playerResponse &&
      playerResponse.streamingData &&
      Array.isArray(playerResponse.streamingData.formats)
      ? playerResponse.streamingData.formats
      : [];
    return formats.filter(isProgressiveAvcAac);
  }

  function pickBestProgressive(formats, targetHeight) {
    const ceiling = targetHeight == null ? Number.POSITIVE_INFINITY : Number(targetHeight);
    const list = (Array.isArray(formats) ? formats : [])
      .filter(isProgressiveAvcAac)
      .filter((format) => Number(format.height || 0) > 0)
      .filter((format) => Number(format.height || 0) <= ceiling)
      .sort((a, b) =>
        Number(b.height || 0) - Number(a.height || 0) ||
        Number(b.bitrate || 0) - Number(a.bitrate || 0)
      );
    return list[0] || null;
  }

  async function fetchPlayerResponse(videoId, client, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      return { ok: false, errorCode: 'FETCH_UNAVAILABLE' };
    }
    const apiKey = options.apiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    try {
      const response = await fetchImpl(buildPlayerRequestUrl(apiKey), {
        method: 'POST',
        headers: buildPlayerRequestHeaders(client),
        body: JSON.stringify(buildPlayerRequestBody(videoId, client, options.bodyExtras)),
        credentials: options.credentials || 'include',
        cache: 'no-store',
      });
      if (!response.ok) {
        return { ok: false, errorCode: 'INNERTUBE_HTTP', status: response.status, client: client.clientName };
      }
      const json = await response.json();
      const status = json && json.playabilityStatus && json.playabilityStatus.status;
      if (status && status !== 'OK') {
        return {
          ok: false,
          errorCode: 'INNERTUBE_UNPLAYABLE',
          status,
          reason: json.playabilityStatus.reason || null,
          client: client.clientName,
          response: json,
        };
      }
      return { ok: true, client: client.clientName, response: json };
    } catch {
      return { ok: false, errorCode: 'INNERTUBE_FETCH_FAILED', client: client.clientName };
    }
  }

  async function resolveDownloadableFormats(videoId, options = {}) {
    const clients = Array.isArray(options.clients) && options.clients.length
      ? options.clients
      : FALLBACK_CLIENTS;
    const attempts = [];
    for (const client of clients) {
      const result = await fetchPlayerResponse(videoId, client, options);
      attempts.push({
        client: client.clientName,
        ok: result.ok,
        errorCode: result.errorCode || null,
        status: result.status || null,
      });
      if (!result.ok) continue;
      const progressive = extractProgressiveFormats(result.response);
      if (!progressive.length) continue;
      return {
        ok: true,
        client: client.clientName,
        response: result.response,
        progressive,
        attempts,
      };
    }
    return { ok: false, errorCode: 'NO_ANDROID_PROGRESSIVE', attempts };
  }

  return {
    ANDROID_CLIENT,
    FALLBACK_CLIENTS,
    isProgressiveAvcAac,
    buildPlayerRequestBody,
    buildPlayerRequestUrl,
    buildPlayerRequestHeaders,
    clientHeaderName,
    extractProgressiveFormats,
    pickBestProgressive,
    fetchPlayerResponse,
    resolveDownloadableFormats,
  };
});
