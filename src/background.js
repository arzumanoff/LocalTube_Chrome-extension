importScripts(
  'core/quality.js',
  'core/filename.js',
  'core/jobs.js',
  'core/messages.js',
  'core/metadata.js',
  'core/download.js'
);

const {
  selectNearestProgressiveMp4,
  buildSuggestedFilename,
  createDownloadJob,
  applyDownloadDelta,
  reconcileDownloadState,
  validateStartDownloadPayload,
  extractPoTokenFromResourceUrls,
  addPoTokenToGoogleVideoUrl,
  classifyMediaProbe,
  findForcedFilename,
} = self.YTDCore;

const STORAGE_KEY = 'downloadJobs';
const MAX_STORED_JOBS = 100;
const TOKEN_MAX_AGE_MS = 15000;
const poTokensByTab = new Map();
const pendingFilenames = new Map();

function chromeCall(method, context, ...args) {
  return new Promise((resolve, reject) => {
    method.call(context, ...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function readJobs() {
  const result = await chromeCall(chrome.storage.local.get, chrome.storage.local, STORAGE_KEY);
  return Array.isArray(result?.[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function writeJobs(jobs) {
  const trimmed = [...jobs]
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
    .slice(-MAX_STORED_JOBS);
  await chromeCall(chrome.storage.local.set, chrome.storage.local, { [STORAGE_KEY]: trimmed });
  return trimmed;
}

async function upsertJob(job) {
  const jobs = await readJobs();
  const index = jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) jobs[index] = job;
  else jobs.push(job);
  await writeJobs(jobs);
  return job;
}

async function broadcastJob(job) {
  let tabs = [];
  try {
    tabs = await chromeCall(chrome.tabs.query, chrome.tabs, {});
  } catch {
    return;
  }
  await Promise.all((tabs || []).map(async (tab) => {
    if (!Number.isInteger(tab.id)) return;
    try {
      await chromeCall(chrome.tabs.sendMessage, chrome.tabs, tab.id, {
        type: 'YTD_JOB_UPDATED',
        payload: { job },
      });
    } catch {
      // Tabs without this content script are expected to reject the message.
    }
  }));
}

function createJobId() {
  if (self.crypto?.randomUUID) return self.crypto.randomUUID();
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(code) {
  const messages = {
    INVALID_PAYLOAD: 'Некорректный запрос на скачивание.',
    INVALID_METADATA: 'Не удалось проверить данные ролика.',
    INVALID_FORMAT: 'Ссылка на медиапоток не прошла проверку.',
    INVALID_FORMATS: 'Подходящие форматы не найдены.',
    INVALID_TARGET_HEIGHT: 'Выбрано неподдерживаемое качество.',
    NO_COMPATIBLE_FORMAT: 'Нет готового MP4 с H.264 и AAC для выбранного качества.',
    DOWNLOAD_CANCELLED: 'Скачивание отменено.',
    GVS_FORBIDDEN: 'YouTube не подтвердил доступ к медиапотоку. Запустите ролик на 1–2 секунды и повторите скачивание.',
    MEDIA_BAD_CONTENT: 'YouTube вернул текст ошибки вместо MP4. Обновите страницу, запустите ролик и повторите.',
    MEDIA_PROBE_FAILED: 'Не удалось проверить медиапоток перед скачиванием.',
  };
  return messages[code] || 'Не удалось начать скачивание.';
}

function freshPoTokenForTab(tabId) {
  if (!Number.isInteger(tabId)) return '';
  const entry = poTokensByTab.get(tabId);
  if (!entry || Date.now() - entry.updatedAt > TOKEN_MAX_AGE_MS) return '';
  return entry.token;
}

function prepareFormatForTab(format, tabId, replaceExisting = false) {
  const token = freshPoTokenForTab(tabId);
  if (!token) return format;
  return {
    ...format,
    url: addPoTokenToGoogleVideoUrl(format.url, token, replaceExisting),
  };
}

async function probeMediaUrl(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      credentials: 'include',
    });
    const classification = classifyMediaProbe(
      response.status,
      response.headers.get('content-type') || '',
    );
    try { await response.body?.cancel(); } catch { /* The one-byte probe may already be complete. */ }
    return classification;
  } catch {
    return { ok: false, errorCode: 'MEDIA_PROBE_FAILED' };
  }
}

function rememberForcedFilename(url, filename) {
  pendingFilenames.set(String(url), {
    url: String(url),
    filename: String(filename),
    expiresAt: Date.now() + 60000,
  });
}

function forgetExpiredFilenames() {
  const now = Date.now();
  for (const [url, entry] of pendingFilenames.entries()) {
    if (entry.expiresAt <= now) pendingFilenames.delete(url);
  }
}

async function markJobFailed(job, errorCode) {
  const failed = {
    ...job,
    state: 'failed',
    errorCode,
    updatedAt: Date.now(),
  };
  await upsertJob(failed);
  await broadcastJob(failed);
  return failed;
}

async function launchBrowserDownload(job, sourceUrl) {
  rememberForcedFilename(sourceUrl, job.suggestedFilename);
  try {
    return await chromeCall(chrome.downloads.download, chrome.downloads, {
      url: sourceUrl,
      filename: job.suggestedFilename,
      conflictAction: 'uniquify',
      saveAs: true,
    });
  } catch (error) {
    pendingFilenames.delete(String(sourceUrl));
    throw error;
  }
}

async function startDownload(payload, tabId) {
  const validation = validateStartDownloadPayload(payload);
  if (!validation.ok) {
    return { ok: false, errorCode: validation.errorCode, message: errorMessage(validation.errorCode) };
  }

  const rawFormat = selectNearestProgressiveMp4(payload.metadata.formats, payload.targetHeight);
  if (!rawFormat) {
    return { ok: false, errorCode: 'NO_COMPATIBLE_FORMAT', message: errorMessage('NO_COMPATIBLE_FORMAT') };
  }
  const selectedFormat = prepareFormatForTab(rawFormat, tabId);

  let job = createDownloadJob({
    id: createJobId(),
    videoId: payload.metadata.videoId,
    title: payload.metadata.title,
    targetHeight: payload.targetHeight,
    selectedFormat,
    suggestedFilename: buildSuggestedFilename(payload.metadata.title, payload.metadata.videoId),
  });
  await upsertJob(job);
  await broadcastJob(job);

  const probe = await probeMediaUrl(selectedFormat.url);
  if (!probe.ok) {
    job = await markJobFailed(job, probe.errorCode);
    return { ok: false, errorCode: probe.errorCode, message: errorMessage(probe.errorCode), job };
  }

  try {
    const downloadId = await launchBrowserDownload(job, selectedFormat.url);
    job = {
      ...job,
      sourceUrl: selectedFormat.url,
      downloadId,
      state: 'downloading',
      updatedAt: Date.now(),
    };
    await upsertJob(job);
    await broadcastJob(job);
    return { ok: true, job };
  } catch (error) {
    const cancelled = /cancel/i.test(error.message || '');
    if (cancelled) {
      job = {
        ...job,
        state: 'cancelled',
        errorCode: 'DOWNLOAD_CANCELLED',
        updatedAt: Date.now(),
      };
      await upsertJob(job);
      await broadcastJob(job);
    } else {
      job = await markJobFailed(job, 'DOWNLOAD_START_FAILED');
    }
    return {
      ok: false,
      errorCode: job.errorCode,
      message: cancelled ? errorMessage('DOWNLOAD_CANCELLED') : error.message,
      job,
    };
  }
}

async function cancelJob(jobId) {
  const jobs = await readJobs();
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return { ok: false, errorCode: 'JOB_NOT_FOUND' };
  if (Number.isInteger(job.downloadId)) {
    try { await chromeCall(chrome.downloads.cancel, chrome.downloads, job.downloadId); } catch { /* Already stopped. */ }
  }
  const updated = { ...job, state: 'cancelled', errorCode: null, updatedAt: Date.now() };
  await upsertJob(updated);
  await broadcastJob(updated);
  return { ok: true, job: updated };
}

async function retryJob(jobId, tabId) {
  const jobs = await readJobs();
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return { ok: false, errorCode: 'JOB_NOT_FOUND' };

  const token = freshPoTokenForTab(tabId);
  const sourceUrl = token
    ? addPoTokenToGoogleVideoUrl(job.sourceUrl, token, true)
    : job.sourceUrl;
  const probe = await probeMediaUrl(sourceUrl);
  if (!probe.ok) {
    const failed = await markJobFailed(job, probe.errorCode);
    return { ok: false, errorCode: probe.errorCode, message: errorMessage(probe.errorCode), job: failed };
  }

  try {
    const downloadId = await launchBrowserDownload(job, sourceUrl);
    const updated = {
      ...job,
      sourceUrl,
      downloadId,
      state: 'downloading',
      errorCode: null,
      bytesReceived: 0,
      updatedAt: Date.now(),
    };
    await upsertJob(updated);
    await broadcastJob(updated);
    return { ok: true, job: updated };
  } catch (error) {
    return { ok: false, errorCode: 'RETRY_FAILED', message: error.message };
  }
}

async function reconcileJobs() {
  const jobs = await readJobs();
  let changed = false;
  const reconciled = [];

  for (const job of jobs) {
    if (!Number.isInteger(job.downloadId) || !['created', 'downloading', 'paused'].includes(job.state)) {
      reconciled.push(job);
      continue;
    }
    let item = null;
    try {
      const matches = await chromeCall(chrome.downloads.search, chrome.downloads, { id: job.downloadId });
      item = matches?.[0] || null;
    } catch { /* Keep null and mark recoverable. */ }
    const updated = reconcileDownloadState(job, item, Date.now());
    reconciled.push(updated);
    changed = changed || JSON.stringify(updated) !== JSON.stringify(job);
  }

  if (changed) await writeJobs(reconciled);
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
  const token = extractPoTokenFromResourceUrls([details.url]);
  if (token) poTokensByTab.set(details.tabId, { token, updatedAt: Date.now() });
}, { urls: ['https://*.googlevideo.com/videoplayback*'] });

chrome.tabs.onRemoved.addListener((tabId) => { poTokensByTab.delete(tabId); });

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  forgetExpiredFilenames();
  const entries = [...pendingFilenames.values()];
  const filename = findForcedFilename(downloadItem, entries);
  if (!filename) return;
  suggest({ filename, conflictAction: 'uniquify' });
  for (const [url, entry] of pendingFilenames.entries()) {
    if (entry.filename === filename) pendingFilenames.delete(url);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, errorCode: 'UNTRUSTED_SENDER' });
    return false;
  }

  (async () => {
    switch (message?.type) {
      case 'YTD_START_DOWNLOAD':
        return startDownload(message.payload, sender.tab?.id);
      case 'YTD_LIST_JOBS':
        return { ok: true, jobs: await readJobs() };
      case 'YTD_CANCEL_JOB':
        return cancelJob(String(message.payload?.jobId || ''));
      case 'YTD_RETRY_JOB':
        return retryJob(String(message.payload?.jobId || ''), sender.tab?.id);
      default:
        return { ok: false, errorCode: 'UNKNOWN_MESSAGE' };
    }
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, errorCode: 'BACKGROUND_ERROR', message: error.message });
  });

  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  (async () => {
    const jobs = await readJobs();
    const job = jobs.find((item) => item.downloadId === delta.id);
    if (!job || job.state === 'cancelled') return;
    const updated = applyDownloadDelta(job, delta, Date.now());
    await upsertJob(updated);
    await broadcastJob(updated);
  })().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => { reconcileJobs().catch(() => undefined); });
chrome.runtime.onInstalled.addListener(() => { reconcileJobs().catch(() => undefined); });
