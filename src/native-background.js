importScripts('core/native.js');

const {
  NATIVE_HOST_NAME,
  buildProbePayload,
  buildDownloadPayload,
  buildCancelPayload,
  normalizeProbeResponse,
} = self.YTDCore;

const REQUEST_TIMEOUTS = {
  ping: 5000,
  status: 5000,
  probe: 45000,
  download: 900000,
  cancel: 10000,
};

let nativePort = null;
let requestSequence = 0;
const pending = new Map();

function nextRequestId() {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `ext-${Date.now()}-${requestSequence}`;
}

function errorResponse(errorCode, message) {
  return {
    ok: false,
    errorCode,
    message: message || 'Локальный движок недоступен.',
  };
}

function nativeDisconnectError() {
  const message = chrome.runtime.lastError?.message || '';
  if (/native messaging host not found/i.test(message)) {
    return errorResponse('NATIVE_HOST_NOT_INSTALLED', 'Локальный движок не установлен.');
  }
  if (/access to the specified native messaging host is forbidden/i.test(message)) {
    return errorResponse('NATIVE_HOST_FORBIDDEN', 'Расширение не разрешено в настройках локального движка.');
  }
  return errorResponse('NATIVE_HOST_DISCONNECTED', message || 'Соединение с локальным движком потеряно.');
}

async function broadcastNativeEvent(payload) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://youtube.com/*'] });
  } catch {
    return;
  }
  await Promise.all((tabs || []).map(async (tab) => {
    if (!Number.isInteger(tab.id)) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'YTD_NATIVE_EVENT', payload });
    } catch {
      // Tabs without the current content script are expected.
    }
  }));
}

function rejectAllPending(response) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve(response);
  }
  pending.clear();
}

function attachPort(port) {
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;

    if (typeof message.requestId === 'string' && pending.has(message.requestId)) {
      const entry = pending.get(message.requestId);
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      entry.resolve(message);
      return;
    }

    if (typeof message.event === 'string') {
      broadcastNativeEvent(message).catch(() => undefined);
    }
  });

  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    nativePort = null;
    const response = nativeDisconnectError();
    rejectAllPending(response);
    broadcastNativeEvent({ event: 'host-disconnected', ...response }).catch(() => undefined);
  });
}

function getNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    attachPort(nativePort);
    return nativePort;
  } catch (error) {
    nativePort = null;
    throw error;
  }
}

function sendNativeRequest(action, payload = {}, timeoutMs = REQUEST_TIMEOUTS[action] || 30000) {
  return new Promise((resolve) => {
    let port;
    try {
      port = getNativePort();
    } catch (error) {
      resolve(errorResponse('NATIVE_HOST_NOT_INSTALLED', error.message));
      return;
    }

    const requestId = nextRequestId();
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      resolve(errorResponse('NATIVE_REQUEST_TIMEOUT', `Локальный движок не ответил на запрос ${action}.`));
    }, timeoutMs);

    pending.set(requestId, { resolve, timer, action });
    try {
      port.postMessage({ requestId, action, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      nativePort = null;
      resolve(errorResponse('NATIVE_SEND_FAILED', error.message));
    }
  });
}

async function handleMessage(message) {
  switch (message?.type) {
    case 'YTD_NATIVE_PING':
      return sendNativeRequest('ping');

    case 'YTD_NATIVE_STATUS':
      return sendNativeRequest('status');

    case 'YTD_NATIVE_PROBE': {
      const validation = buildProbePayload(String(message.payload?.url || ''));
      if (!validation.ok) return errorResponse(validation.errorCode, 'Некорректная ссылка YouTube.');
      const response = await sendNativeRequest('probe', validation.payload);
      return normalizeProbeResponse(response);
    }

    case 'YTD_NATIVE_DOWNLOAD': {
      const validation = buildDownloadPayload({
        url: String(message.payload?.url || ''),
        qualityId: String(message.payload?.qualityId || ''),
        suggestedFilename: String(message.payload?.suggestedFilename || ''),
      });
      if (!validation.ok) return errorResponse(validation.errorCode, 'Некорректные параметры скачивания.');
      return sendNativeRequest('download', validation.payload);
    }

    case 'YTD_NATIVE_CANCEL': {
      const validation = buildCancelPayload(String(message.payload?.jobId || ''));
      if (!validation.ok) return errorResponse(validation.errorCode, 'Некорректный идентификатор задания.');
      return sendNativeRequest('cancel', validation.payload);
    }

    default:
      return errorResponse('UNKNOWN_MESSAGE', 'Неизвестная команда расширения.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse(errorResponse('UNTRUSTED_SENDER', 'Недоверенный отправитель.'));
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse(errorResponse('BACKGROUND_ERROR', error.message)));
  return true;
});
