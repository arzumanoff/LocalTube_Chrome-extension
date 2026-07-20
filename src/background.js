importScripts(
  'core/quality.js',
  'core/filename.js',
  'core/jobs.js',
  'core/messages.js',
  'core/media-url.js',
  'core/download.js',
  'core/innertube.js',
  'core/metadata.js'
);

const {
  selectNearestProgressiveMp4,
  resolveRequestedFilename,
  createDownloadJob,
  applyDownloadDelta,
  reconcileDownloadState,
  sanitizeJobForStorage,
  migrateStoredJobs,
  validateRetryPayload,
  validateStartDownloadPayload,
  validateRetryDownloadPayload,
  resolveMediaUrl,
  extractPlaybackTokens,
  ensureMp4Filename,
  createPendingFilenameEntry,
  findForcedFilename,
} = self.YTDCore;

const STORAGE_KEY = 'downloadJobs';
const MAX_STORED_JOBS = 100;
const TOKEN_MAX_AGE_MS = 30000;
const tabTokens = new Map();
/** @type {Map<string, object>} pending filename entries keyed by entry id */
const pendingFilenames = new Map();
/** @type {Map<string, { url: string, updatedAt: number }>} */
const activeSourceUrls = new Map();

function chromeCall(method, context, ...args) {
  return new Promise((resolve, reject) => {
    method.call(context, ...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function rememberActiveSourceUrl(jobId, url) {
  if (!jobId || !url) return;
  activeSourceUrls.set(String(jobId), { url: String(url), updatedAt: Date.now() });
}

function forgetActiveSourceUrl(jobId) {
  activeSourceUrls.delete(String(jobId || ''));
}

async function readJobs() {
  const result = await chromeCall(chrome.storage.local.get, chrome.storage.local, STORAGE_KEY);
  const raw = Array.isArray(result?.[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  const migrated = migrateStoredJobs(raw);
  if (migrated.changed) {
    await chromeCall(chrome.storage.local.set, chrome.storage.local, { [STORAGE_KEY]: migrated.jobs });
  }
  return migrated.jobs;
}

async function writeJobs(jobs) {
  const trimmed = migrateStoredJobs(jobs).jobs
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
    .slice(-MAX_STORED_JOBS)
    .map((job) => sanitizeJobForStorage(job))
    .filter(Boolean);
  await chromeCall(chrome.storage.local.set, chrome.storage.local, { [STORAGE_KEY]: trimmed });
  return trimmed;
}

async function upsertJob(job) {
  const clean = sanitizeJobForStorage(job);
  if (!clean) throw new Error('INVALID_JOB');
  const jobs = await readJobs();
  const index = jobs.findIndex((item) => item.id === clean.id);
  if (index >= 0) jobs[index] = clean;
  else jobs.push(clean);
  await writeJobs(jobs);
  return clean;
}

async function broadcastJob(job) {
  const clean = sanitizeJobForStorage(job) || job;
  let tabs = [];
  try {
    tabs = await chromeCall(chrome.tabs.query, chrome.tabs, { url: ['https://www.youtube.com/*', 'https://youtube.com/*'] });
  } catch {
    return;
  }
  await Promise.all((tabs || []).map(async (tab) => {
    if (!Number.isInteger(tab.id)) return;
    try {
      await chromeCall(chrome.tabs.sendMessage, chrome.tabs, tab.id, {
        type: 'YTD_JOB_UPDATED',
        payload: { job: clean },
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
    INVALID_OBSERVED_URLS: 'Не удалось проверить активный медиапоток YouTube.',
    INVALID_OBSERVED_URL: 'Активный медиапоток YouTube не прошёл проверку.',
    INVALID_DOWNLOAD_CLIENT: 'Некорректный источник медиассылки.',
    NO_COMPATIBLE_FORMAT: 'Нет готового MP4 с H.264 и AAC для выбранного качества.',
    MEDIA_URL_FORBIDDEN: 'YouTube отклонил доступ к медиапотоку (403). Обновите страницу, запустите ролик и повторите.',
    MEDIA_URL_UNAUTHORIZED: 'Нет доступа к медиапотоку (401).',
    MEDIA_URL_NOT_FOUND: 'Медиапоток не найден (404). Обновите страницу.',
    MEDIA_BAD_CONTENT: 'YouTube вернул текст ошибки вместо MP4. Обновите страницу и повторите.',
    MEDIA_NOT_MP4: 'Ответ сервера не является MP4-контейнером. Скачивание отменено.',
    MEDIA_PROBE_FAILED: 'Не удалось проверить медиапоток перед скачиванием.',
    MEDIA_EXPIRED: 'Срок действия ссылки истёк. Обновите страницу и повторите.',
    NO_ANDROID_PROGRESSIVE: 'Не удалось получить рабочий progressive MP4. Повторите через несколько секунд.',
    DOWNLOAD_CANCELLED: 'Скачивание отменено.',
    DOWNLOAD_START_FAILED: 'Не удалось открыть окно сохранения.',
    JOB_NOT_FOUND: 'Задание не найдено.',
    RETRY_FAILED: 'Не удалось повторить скачивание.',
    RETRY_VIDEO_MISMATCH: 'Откройте исходный ролик и повторите.',
    RETRY_METADATA_REQUIRED: 'Не удалось получить свежие метаданные. Откройте исходный ролик и повторите.',
  };
  return messages[code] || 'Не удалось начать скачивание.';
}

function rememberTabTokens(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0 || !url) return;
  const tokens = extractPlaybackTokens([{ url, observedAt: Date.now() }]);
  if (!tokens.n && !tokens.pot) return;
  const prev = tabTokens.get(tabId) || { n: '', pot: '', updatedAt: 0 };
  tabTokens.set(tabId, {
    n: tokens.n || prev.n,
    pot: tokens.pot || prev.pot,
    updatedAt: Date.now(),
  });
}

function freshTabTokens(tabId) {
  if (!Number.isInteger(tabId)) return { n: '', pot: '' };
  const entry = tabTokens.get(tabId);
  if (!entry || Date.now() - entry.updatedAt > TOKEN_MAX_AGE_MS) return { n: '', pot: '' };
  return { n: entry.n || '', pot: entry.pot || '' };
}

function rememberForcedFilename(jobId, url, filename) {
  const entry = createPendingFilenameEntry({
    jobId,
    url,
    filename: ensureMp4Filename(filename),
    expiresAt: Date.now() + 60000,
  });
  pendingFilenames.set(entry.id, entry);
  return entry;
}

function bindPendingDownloadId(entryId, downloadId) {
  const entry = pendingFilenames.get(String(entryId || ''));
  if (!entry || !Number.isInteger(downloadId)) return;
  entry.downloadId = downloadId;
  pendingFilenames.set(entry.id, entry);
}

function forgetPendingEntry(entryId) {
  pendingFilenames.delete(String(entryId || ''));
}

function forgetExpiredFilenames() {
  const now = Date.now();
  for (const [id, entry] of pendingFilenames.entries()) {
    if (entry.expiresAt <= now) pendingFilenames.delete(id);
  }
}

async function markJobFailed(job, errorCode) {
  const failed = sanitizeJobForStorage({
    ...job,
    state: 'failed',
    errorCode,
    updatedAt: Date.now(),
  });
  await upsertJob(failed);
  await broadcastJob(failed);
  return failed;
}

async function launchBrowserDownload(job, sourceUrl) {
  const filename = ensureMp4Filename(job.suggestedFilename);
  const pending = rememberForcedFilename(job.id, sourceUrl, filename);
  try {
    const downloadId = await chromeCall(chrome.downloads.download, chrome.downloads, {
      url: sourceUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: true,
    });
    bindPendingDownloadId(pending.id, downloadId);
    return downloadId;
  } catch (error) {
    forgetPendingEntry(pending.id);
    throw error;
  }
}

async function resolveSelectedFormat(selectedFormat, observedUrls, tabId) {
  const extraTokens = freshTabTokens(tabId);
  const result = await resolveMediaUrl(
    selectedFormat.url,
    observedUrls,
    self.fetch.bind(self),
    { extraTokens },
  );
  if (!result.ok) return result;
  return {
    ok: true,
    selectedFormat: { ...selectedFormat, url: result.url },
    resolutionSource: result.source,
  };
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

  const resolved = await resolveSelectedFormat(rawFormat, payload.metadata.observedUrls, tabId);
  if (!resolved.ok) {
    return { ok: false, errorCode: resolved.errorCode, message: errorMessage(resolved.errorCode) };
  }

  const suggestedFilename = resolveRequestedFilename(
    payload.requestedFilename,
    payload.metadata.title,
    payload.metadata.videoId,
  );

  let job = createDownloadJob({
    id: createJobId(),
    videoId: payload.metadata.videoId,
    title: payload.metadata.title,
    targetHeight: payload.targetHeight,
    selectedFormat: resolved.selectedFormat,
    suggestedFilename,
  });
  rememberActiveSourceUrl(job.id, resolved.selectedFormat.url);
  await upsertJob(job);
  await broadcastJob(job);

  try {
    const downloadId = await launchBrowserDownload(job, resolved.selectedFormat.url);
    job = sanitizeJobForStorage({
      ...job,
      downloadId,
      state: 'downloading',
      updatedAt: Date.now(),
    });
    await upsertJob(job);
    await broadcastJob(job);
    return { ok: true, job, resolutionSource: resolved.resolutionSource };
  } catch (error) {
    forgetActiveSourceUrl(job.id);
    const cancelled = /cancel/i.test(error.message || '');
    if (cancelled) {
      job = sanitizeJobForStorage({
        ...job,
        state: 'cancelled',
        errorCode: 'DOWNLOAD_CANCELLED',
        updatedAt: Date.now(),
      });
      await upsertJob(job);
      await broadcastJob(job);
      return { ok: false, errorCode: 'DOWNLOAD_CANCELLED', message: errorMessage('DOWNLOAD_CANCELLED'), job };
    }
    job = await markJobFailed(job, 'DOWNLOAD_START_FAILED');
    return {
      ok: false,
      errorCode: job.errorCode,
      message: error.message || errorMessage(job.errorCode),
      job,
    };
  }
}

async function cancelJob(jobId) {
  const jobs = await readJobs();
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return { ok: false, errorCode: 'JOB_NOT_FOUND', message: errorMessage('JOB_NOT_FOUND') };
  if (Number.isInteger(job.downloadId)) {
    try { await chromeCall(chrome.downloads.cancel, chrome.downloads, job.downloadId); } catch { /* Already stopped. */ }
  }
  forgetActiveSourceUrl(job.id);
  const updated = sanitizeJobForStorage({ ...job, state: 'cancelled', errorCode: null, updatedAt: Date.now() });
  await upsertJob(updated);
  await broadcastJob(updated);
  return { ok: true, job: updated };
}

async function markJobFailedById(jobId, errorCode = 'E2E_FORCED_FAILURE') {
  const jobs = await readJobs();
  const job = jobs.find((item) => item.id === String(jobId || ''));
  if (!job) return { ok: false, errorCode: 'JOB_NOT_FOUND', message: errorMessage('JOB_NOT_FOUND') };
  if (Number.isInteger(job.downloadId)) {
    try { await chromeCall(chrome.downloads.cancel, chrome.downloads, job.downloadId); } catch { /* optional */ }
  }
  forgetActiveSourceUrl(job.id);
  const failed = await markJobFailed(job, errorCode || 'E2E_FORCED_FAILURE');
  // Ensure no signed URL remains associated with the failed job.
  forgetActiveSourceUrl(failed.id);
  return { ok: true, job: failed, hasSourceUrl: false };
}

async function retryJob(payload, tabId) {
  const validation = validateRetryDownloadPayload(payload);
  if (!validation.ok) {
    return { ok: false, errorCode: validation.errorCode, message: errorMessage(validation.errorCode) };
  }

  const jobs = await readJobs();
  const job = jobs.find((item) => item.id === String(payload.jobId || ''));
  if (!job) return { ok: false, errorCode: 'JOB_NOT_FOUND', message: errorMessage('JOB_NOT_FOUND') };

  const match = validateRetryPayload(job, payload.metadata);
  if (!match.ok) {
    return { ok: false, errorCode: match.errorCode, message: errorMessage(match.errorCode) };
  }

  // Never reuse a persisted/expired signed URL. Always pick from fresh metadata.
  const rawFormat = selectNearestProgressiveMp4(payload.metadata.formats, job.targetHeight);
  if (!rawFormat) {
    const failed = await markJobFailed(job, 'NO_COMPATIBLE_FORMAT');
    return {
      ok: false,
      errorCode: 'NO_COMPATIBLE_FORMAT',
      message: errorMessage('NO_COMPATIBLE_FORMAT'),
      job: failed,
    };
  }

  const resolved = await resolveSelectedFormat(rawFormat, payload.metadata.observedUrls, tabId);
  if (!resolved.ok) {
    const failed = await markJobFailed(job, resolved.errorCode);
    return {
      ok: false,
      errorCode: resolved.errorCode,
      message: errorMessage(resolved.errorCode),
      job: failed,
    };
  }

  rememberActiveSourceUrl(job.id, resolved.selectedFormat.url);

  try {
    const downloadId = await launchBrowserDownload(job, resolved.selectedFormat.url);
    const updated = sanitizeJobForStorage({
      ...job,
      resolvedHeight: Number(resolved.selectedFormat.height),
      selectedItag: Number(resolved.selectedFormat.itag),
      totalBytes: Number(resolved.selectedFormat.contentLength || job.totalBytes || 0),
      downloadId,
      state: 'downloading',
      errorCode: null,
      bytesReceived: 0,
      updatedAt: Date.now(),
    });
    await upsertJob(updated);
    await broadcastJob(updated);
    return {
      ok: true,
      job: updated,
      resolutionSource: resolved.resolutionSource,
      reusedOldUrl: false,
    };
  } catch (error) {
    forgetActiveSourceUrl(job.id);
    return { ok: false, errorCode: 'RETRY_FAILED', message: error.message || errorMessage('RETRY_FAILED') };
  }
}

async function reconcileJobs() {
  const jobs = await readJobs();
  let changed = false;
  const reconciled = [];

  for (const job of jobs) {
    if (!Number.isInteger(job.downloadId) || !['created', 'downloading', 'paused'].includes(job.state)) {
      reconciled.push(sanitizeJobForStorage(job));
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

async function migrateOnBoot() {
  const jobs = await readJobs();
  await writeJobs(jobs);
  await reconcileJobs();
}

if (chrome.webRequest?.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    rememberTabTokens(details.tabId, details.url);
  }, { urls: ['https://*.googlevideo.com/videoplayback*'] });
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  tabTokens.delete(tabId);
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  forgetExpiredFilenames();
  const match = findForcedFilename(downloadItem, [...pendingFilenames.values()]);
  if (!match || !match.filename) return;
  suggest({ filename: match.filename, conflictAction: 'uniquify' });
  // Remove only the exact pending entry that matched this download.
  if (match.entryId) forgetPendingEntry(match.entryId);
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
        return retryJob(message.payload, sender.tab?.id);
      case 'YTD_MARK_JOB_FAILED':
        return markJobFailedById(
          String(message.payload?.jobId || ''),
          String(message.payload?.errorCode || 'E2E_FORCED_FAILURE'),
        );
      case 'YTD_PING':
        return { ok: true, version: chrome.runtime.getManifest().version };
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
    if (updated.state === 'completed' || updated.state === 'failed') {
      forgetActiveSourceUrl(job.id);
      for (const [id, entry] of pendingFilenames.entries()) {
        if (entry.downloadId === delta.id || entry.jobId === job.id) pendingFilenames.delete(id);
      }
    }
    await upsertJob(updated);
    await broadcastJob(updated);
  })().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => { migrateOnBoot().catch(() => undefined); });
chrome.runtime.onInstalled.addListener(() => { migrateOnBoot().catch(() => undefined); });
