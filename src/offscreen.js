(function installOffscreenBlobHelper() {
  const blobUrls = new Set();

  async function createBlobUrlFromMedia(url) {
    const response = await fetch(String(url || ''), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!(response.status === 200 || response.status === 206)) {
      return { ok: false, errorCode: 'MEDIA_PROBE_FAILED', status: response.status };
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.startsWith('text/') || contentType.includes('html') || contentType.includes('json')) {
      return { ok: false, errorCode: 'MEDIA_BAD_CONTENT' };
    }
    const blob = await response.blob();
    if (!blob || blob.size < 1000) {
      return { ok: false, errorCode: 'MEDIA_PROBE_FAILED' };
    }
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const ftyp = head.length >= 8 &&
      head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
    if (!ftyp) {
      return { ok: false, errorCode: 'MEDIA_NOT_MP4' };
    }
    const objectUrl = URL.createObjectURL(new Blob([blob], { type: 'video/mp4' }));
    blobUrls.add(objectUrl);
    return { ok: true, blobUrl: objectUrl, size: blob.size };
  }

  function revokeBlobUrl(url) {
    if (!url || !blobUrls.has(url)) return;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    blobUrls.delete(url);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'ytd-offscreen') return false;
    (async () => {
      if (message.type === 'YTD_CREATE_BLOB_URL') {
        return createBlobUrlFromMedia(message.url);
      }
      if (message.type === 'YTD_REVOKE_BLOB_URL') {
        revokeBlobUrl(message.url);
        return { ok: true };
      }
      return { ok: false, errorCode: 'UNKNOWN_OFFSCREEN_MESSAGE' };
    })().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, errorCode: 'OFFSCREEN_ERROR', message: error.message });
    });
    return true;
  });
})();
