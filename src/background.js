importScripts(
  'core/quality.js',
  'core/filename.js',
  'core/jobs.js',
  'core/messages.js'
);

const {
  selectNearestProgressiveMp4,
  buildSuggestedFilename,
  createDownloadJob,
  applyDownloadDelta,
  reconcileDownloadState,
  validateStartDownloadPayload,
} = self.YTDCore;

const STORAGE_KEY = 'downloadJobs';
const MAX_STORED_JOBS = 100;

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
  };
  return messages[code] || 'Не удалось начать скачивание.';
}

async function startDownload(payload) {
  const validation = validateStartDownloadPayload(payload);
  if (!validation.ok) {
    return { ok: false, errorCode: validation.errorCode, message: errorMessage(validation.errorCode) };
  }

  const selectedFormat = selectNearestProgressiveMp4(payload.metadata.formats, payload.targetHeight);
  if (!selectedFormat) {
    return { ok: false, errorCode: 'NO_COMPATIBLE_FORMAT', message: errorMessage('NO_COMPATIBLE_FORMAT') };
  }

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

  try {
    const downloadId = await chromeCall(chrome.downloads.download, chrome.downloads, {
      url: selectedFormat.url,
      filename: job.suggestedFilename,
      conflictAction: 'uniquify',
      saveAs: true,
    });
    job = {
      ...job,
      downloadId,
      state: 'downloading',
      updatedAt: Date.now(),
    };
    await upsertJob(job);
    await broadcastJob(job);
    return { ok: true, job };
  } catch (error) {
    const cancelled = /cancel/i.test(error.message || '');
    job = {
      ...job,
      state: cancelled ? 'cancelled' : 'failed',
      errorCode: cancelled ? 'DOWNLOAD_CANCELLED' : 'DOWNLOAD_START_FAILED',
      updatedAt: Date.now(),
    };
    await upsertJob(job);
    await broadcastJob(job);
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

async function retryJob(jobId) {
  const jobs = await readJobs();
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return { ok: false, errorCode: 'JOB_NOT_FOUND' };
  try {
    const downloadId = await chromeCall(chrome.downloads.download, chrome.downloads, {
      url: job.sourceUrl,
      filename: job.suggestedFilename,
      conflictAction: 'uniquify',
      saveAs: true,
    });
    const updated = {
      ...job,
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, errorCode: 'UNTRUSTED_SENDER' });
    return false;
  }

  (async () => {
    switch (message?.type) {
      case 'YTD_START_DOWNLOAD':
        return startDownload(message.payload);
      case 'YTD_LIST_JOBS':
        return { ok: true, jobs: await readJobs() };
      case 'YTD_CANCEL_JOB':
        return cancelJob(String(message.payload?.jobId || ''));
      case 'YTD_RETRY_JOB':
        return retryJob(String(message.payload?.jobId || ''));
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
