(function installDownloaderUi() {
  if (window.__YTD_UI_INSTALLED__) return;
  window.__YTD_UI_INSTALLED__ = true;

  const SOURCE = 'ytd-extension';
  const BUTTON_ID = 'ytd-extension-download-host';
  const MODAL_ID = 'ytd-extension-modal-host';
  const TARGETS = [2160, 1440, 1080, 720, 480, 360];
  const core = globalThis.YTDCore;
  let metadata = null;
  let metadataRevision = 0;
  let activeJob = null;
  let lastUrl = location.href;
  let lastVideoId = '';
  let mountTimer = null;
  let extensionAlive = true;

  function isContextInvalidated(error) {
    if (core?.isExtensionContextInvalidated?.(error)) return true;
    const message = String(error && error.message || error || '');
    return /extension context invalidated/i.test(message) ||
      /message port closed/i.test(message) ||
      /receiving end does not exist/i.test(message);
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      if (!extensionAlive) {
        reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            if (isContextInvalidated(error)) {
              extensionAlive = false;
              reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
              return;
            }
            reject(new Error(error.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        if (isContextInvalidated(error)) {
          extensionAlive = false;
          reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
          return;
        }
        reject(error);
      }
    });
  }

  function invalidatedMessage() {
    return 'Расширение было обновлено. Нажмите Ctrl+F5, чтобы обновить вкладку YouTube.';
  }

  function supportedPage() {
    return location.pathname === '/watch' || location.pathname.startsWith('/shorts/');
  }

  function currentVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || '';
      return url.searchParams.get('v') || '';
    } catch {
      return '';
    }
  }

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      (document.head || document.documentElement).append(script);
    });
  }

  async function injectBridge() {
    if (document.documentElement.dataset.ytdBridgeInjected === 'true') return;
    if (!extensionAlive) return;
    try {
      document.documentElement.dataset.ytdBridgeInjected = 'true';
      const roots = [
        chrome.runtime.getURL('src/core/media-url.js'),
        chrome.runtime.getURL('src/core/innertube.js'),
        chrome.runtime.getURL('src/core/metadata.js'),
        chrome.runtime.getURL('src/page-bridge.js'),
      ];
      for (const src of roots) await injectScript(src);
    } catch (error) {
      document.documentElement.dataset.ytdBridgeInjected = '';
      if (isContextInvalidated(error)) extensionAlive = false;
    }
  }

  function requestMetadata() {
    window.postMessage({ source: SOURCE, type: 'YTD_REQUEST_METADATA' }, location.origin);
  }

  function findMountTarget() {
    if (location.pathname.startsWith('/shorts/')) {
      const candidates = [
        document.querySelector('ytd-reel-video-renderer[is-active] #actions'),
        document.querySelector('ytd-reel-video-renderer[is-active] #actions-container'),
        document.querySelector('ytd-reel-player-overlay-renderer #actions'),
        document.querySelector('ytd-reel-player-overlay-renderer #actions-container'),
        document.querySelector('#shorts-container #actions'),
        document.querySelector('ytd-shorts #actions'),
        document.querySelector('#like-button')?.parentElement,
        document.querySelector('like-button-view-model')?.parentElement,
      ];
      return candidates.find(Boolean) || null;
    }
    return document.querySelector(
      'ytd-watch-metadata #actions-inner, ytd-watch-metadata #actions, #menu-container #top-level-buttons-computed, #actions-inner, #actions',
    );
  }

  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mountButton();
    }, 100);
  }

  function mountButton() {
    if (!supportedPage()) return;
    const existing = document.getElementById(BUTTON_ID);
    if (existing?.isConnected) return;
    const target = findMountTarget();
    if (!target) return;
    const host = document.createElement('span');
    host.id = BUTTON_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>:host{display:inline-flex;margin-left:8px}button{border:0;border-radius:999px;padding:10px 17px;background:#ff0033;color:#fff;cursor:pointer;font:600 14px Arial}button:hover{background:#d9002c}</style><button type="button">Скачать</button>`;
    shadow.querySelector('button').addEventListener('click', openModal);
    target.append(host);
  }

  function closeModal() {
    document.getElementById(MODAL_ID)?.remove();
  }

  function createModal() {
    closeModal();
    const host = document.createElement('div');
    host.id = MODAL_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}*{box-sizing:border-box}.overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.68);font-family:Arial;color:#f5f5f5}.card{width:min(560px,100%);max-height:calc(100vh - 40px);overflow:auto;background:#171717;border:1px solid #343434;border-radius:18px}.head{display:flex;justify-content:space-between;padding:22px 22px 14px}.head h2{margin:0;font-size:22px}.close{width:36px;height:36px;border:0;border-radius:50%;background:#2a2a2a;color:#fff;font-size:22px;cursor:pointer}.body{padding:0 22px 22px}.title{font-weight:700;font-size:16px}.meta{color:#aaa;font-size:13px}.notice{padding:12px 14px;border-radius:12px;background:#242424;color:#cfcfcf;font-size:13px;line-height:1.45}.qualities{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.quality{border:1px solid #3d3d3d;border-radius:12px;padding:13px 14px;text-align:left;background:#222;color:#fff;cursor:pointer;font:600 14px Arial}.quality:hover:not(:disabled){border-color:#ff0033}.quality small{display:block;margin-top:4px;color:#aaa;font-weight:400}.quality:disabled{opacity:.38;cursor:not-allowed}.status{margin-top:18px;padding:14px;border-radius:12px;background:#222}.status[hidden]{display:none}.line{display:flex;justify-content:space-between;font-size:13px}.bar{height:8px;margin-top:10px;border-radius:999px;background:#3a3a3a;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#ff0033}.error{margin-top:10px;color:#ff8d9f;font-size:13px;line-height:1.4;white-space:pre-wrap}.actions{display:flex;gap:8px;margin-top:12px}.secondary{border:1px solid #555;border-radius:9px;padding:8px 12px;background:transparent;color:#fff;cursor:pointer}@media(max-width:480px){.qualities{grid-template-columns:1fr}}
      </style>
      <div class="overlay" role="dialog" aria-modal="true"><section class="card"><div class="head"><h2>Скачать видео</h2><button class="close" type="button" aria-label="Закрыть">×</button></div><div class="body"><p class="title"></p><p class="meta"></p><p class="notice"></p><label class="filename-label">Имя файла<input class="filename" type="text" spellcheck="false" autocomplete="off"></label><div class="qualities"></div><div class="status" hidden><div class="line"><span class="state"></span><strong class="percent"></strong></div><div class="bar"><i></i></div><div class="error"></div><div class="actions"></div></div></div></section></div>`;
    // inject filename styles
    const style = shadow.querySelector('style');
    if (style) {
      style.textContent += '.filename-label{display:grid;gap:8px;margin:14px 0 16px;color:#ddd;font-size:13px}.filename{width:100%;border:1px solid #444;border-radius:10px;padding:11px 12px;background:#111;color:#fff;font:14px Arial}';
    }
    shadow.querySelector('.close').addEventListener('click', closeModal);
    shadow.querySelector('.overlay').addEventListener('click', (event) => {
      if (event.target.classList.contains('overlay')) closeModal();
    });
    document.documentElement.append(host);
    return shadow;
  }

  function jobStateText(state) {
    return ({
      created: 'Готовимся…',
      downloading: 'Скачивание…',
      paused: 'Приостановлено',
      completed: 'Готово — файл сохранён',
      failed: 'Ошибка скачивания',
      cancelled: 'Скачивание отменено',
      recoverable: 'Можно повторить загрузку',
    })[state] || 'Состояние неизвестно';
  }

  function formatError(response, job) {
    if (response?.message) {
      const code = response.errorCode || job?.errorCode;
      return code ? `${response.message}\nКод: ${code}` : response.message;
    }
    if (job?.errorCode) return `Код ошибки: ${job.errorCode}`;
    return '';
  }

  async function waitForFreshMetadata(expectedVideoId, options = {}) {
    if (typeof core.waitForFreshMetadata === 'function') {
      return core.waitForFreshMetadata({
        getRevision: () => metadataRevision,
        getMetadata: () => metadata,
        requestMetadata,
        expectedVideoId,
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
      });
    }
    return { ok: false, errorCode: 'RETRY_METADATA_REQUIRED', metadata: null, revision: metadataRevision };
  }

  function addAction(container, label, type, jobId, shadow) {
    const button = document.createElement('button');
    button.className = 'secondary';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', async () => {
      try {
        let response;
        if (type === 'YTD_RETRY_JOB') {
          const expectedId = activeJob?.videoId || metadata?.videoId || lastVideoId;
          const fresh = await waitForFreshMetadata(expectedId);
          if (!fresh.ok) {
            shadow.querySelector('.error').textContent = fresh.errorCode === 'RETRY_VIDEO_MISMATCH'
              ? 'Откройте исходный ролик и повторите.'
              : 'Не удалось получить свежие метаданные. Откройте исходный ролик и повторите.';
            return;
          }
          response = await send({
            type,
            payload: { jobId, metadata: fresh.metadata },
          });
        } else {
          response = await send({ type, payload: { jobId } });
        }
        if (response?.job) renderJob(shadow, response.job, response);
        else shadow.querySelector('.error').textContent = response?.message || 'Не удалось выполнить действие.';
      } catch (error) {
        shadow.querySelector('.error').textContent = error.message === 'EXTENSION_CONTEXT_INVALIDATED'
          ? invalidatedMessage()
          : error.message;
      }
    });
    container.append(button);
  }

  function renderJob(shadow, job, response) {
    activeJob = job;
    const status = shadow.querySelector('.status');
    if (!status) return;
    status.hidden = false;
    const total = Number(job.totalBytes || 0);
    const received = Number(job.bytesReceived || 0);
    const percent = job.state === 'completed' ? 100 : total ? Math.round(received / total * 100) : 0;
    shadow.querySelector('.state').textContent = jobStateText(job.state);
    shadow.querySelector('.percent').textContent = total ? `${Math.max(0, Math.min(100, percent))}%` : '';
    shadow.querySelector('.bar i').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    shadow.querySelector('.error').textContent = formatError(response, job);
    const actions = shadow.querySelector('.actions');
    actions.replaceChildren();
    if (['created', 'downloading', 'paused'].includes(job.state)) addAction(actions, 'Отменить', 'YTD_CANCEL_JOB', job.id, shadow);
    if (['failed', 'recoverable'].includes(job.state)) addAction(actions, 'Повторить', 'YTD_RETRY_JOB', job.id, shadow);
  }

  function defaultFilenameForMetadata(meta) {
    if (!meta) return 'video.mp4';
    if (typeof core.resolveRequestedFilename === 'function') {
      return core.resolveRequestedFilename('', meta.title, meta.videoId);
    }
    if (typeof core.buildSuggestedFilename === 'function') {
      return core.buildSuggestedFilename(meta.title || meta.videoId, meta.videoId);
    }
    return `${meta.videoId || 'video'}.mp4`;
  }

  function readRequestedFilename(shadow) {
    const input = shadow.querySelector('.filename');
    return String(input?.value || '').trim();
  }

  function syncFilenameField(shadow, force = false) {
    const input = shadow.querySelector('.filename');
    if (!input) return;
    const nextDefault = defaultFilenameForMetadata(metadata);
    if (force || !input.dataset.userEdited || input.dataset.videoId !== (metadata?.videoId || '')) {
      input.value = nextDefault;
      input.dataset.userEdited = 'false';
      input.dataset.videoId = metadata?.videoId || '';
    }
  }

  async function beginDownload(shadow, targetHeight) {
    const buttons = [...shadow.querySelectorAll('.quality')];
    buttons.forEach((button) => { button.disabled = true; });
    shadow.querySelector('.status').hidden = false;
    shadow.querySelector('.state').textContent = 'Проверяю медиапоток…';
    shadow.querySelector('.percent').textContent = '';
    shadow.querySelector('.bar i').style.width = '0%';
    shadow.querySelector('.error').textContent = '';
    shadow.querySelector('.actions').replaceChildren();
    try {
      if (!metadata) {
        shadow.querySelector('.state').textContent = 'Ошибка';
        shadow.querySelector('.error').textContent = 'Метаданные ролика ещё не получены. Запустите видео и подождите.';
        return;
      }
      const requestedFilename = readRequestedFilename(shadow);
      const response = await send({
        type: 'YTD_START_DOWNLOAD',
        payload: { metadata, targetHeight, requestedFilename },
      });
      if (response?.job) renderJob(shadow, response.job, response);
      if (!response?.ok) {
        shadow.querySelector('.state').textContent = 'Ошибка';
        shadow.querySelector('.error').textContent = formatError(response, response?.job) || 'Не удалось начать скачивание.';
      } else {
        shadow.querySelector('.state').textContent = 'Открыто окно сохранения…';
      }
    } catch (error) {
      shadow.querySelector('.state').textContent = 'Ошибка';
      shadow.querySelector('.error').textContent = error.message === 'EXTENSION_CONTEXT_INVALIDATED'
        ? invalidatedMessage()
        : error.message;
    } finally {
      buttons.forEach((button) => { button.disabled = button.dataset.available !== 'true'; });
    }
  }

  function renderModal(shadow) {
    const qualities = shadow.querySelector('.qualities');
    qualities.replaceChildren();
    const filenameInput = shadow.querySelector('.filename');
    if (filenameInput && !filenameInput.dataset.bound) {
      filenameInput.dataset.bound = 'true';
      filenameInput.addEventListener('input', () => {
        filenameInput.dataset.userEdited = 'true';
      });
    }
    if (!extensionAlive) {
      shadow.querySelector('.title').textContent = 'Требуется обновление вкладки';
      shadow.querySelector('.notice').textContent = invalidatedMessage();
      if (filenameInput) filenameInput.value = '';
      return;
    }
    if (!metadata) {
      shadow.querySelector('.title').textContent = 'Получаю данные ролика…';
      shadow.querySelector('.notice').textContent = 'Запустите воспроизведение на 1–2 секунды, если данные не появляются.';
      if (filenameInput) {
        filenameInput.value = '';
        filenameInput.dataset.videoId = '';
        filenameInput.dataset.userEdited = 'false';
      }
      return;
    }
    shadow.querySelector('.title').textContent = metadata.title;
    shadow.querySelector('.meta').textContent = [metadata.channel, metadata.isShort ? 'Shorts' : null].filter(Boolean).join(' · ');
    syncFilenameField(shadow, false);
    const best = core.selectNearestProgressiveMp4(metadata.formats, null);
    const observedCount = Array.isArray(metadata.observedUrls) ? metadata.observedUrls.length : 0;
    shadow.querySelector('.notice').textContent = best
      ? `Скачивается готовый MP4 с H.264 и AAC. Можно изменить имя файла ниже. Если выбранного качества нет, будет использовано ближайшее ниже.${observedCount ? ` Активных медиатокенов: ${observedCount}.` : ' Запустите ролик на 2–3 секунды перед скачиванием.'}`
      : 'YouTube не предоставил готовый совместимый MP4. Раздельные дорожки появятся в Phase 2.';
    const options = [
      {
        targetHeight: null,
        label: 'Лучшее доступное',
        available: Boolean(best),
        resolvedHeight: best?.height,
        isFallback: false,
      },
      ...core.buildQualityOptions(metadata.formats, TARGETS),
    ];
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quality';
      button.dataset.available = String(option.available);
      button.disabled = !option.available;
      const detail = !option.available
        ? 'Нет подходящего формата'
        : option.targetHeight === null
          ? `Будет скачано ${option.resolvedHeight}p`
          : option.isFallback
            ? `Автоматически: ${option.resolvedHeight}p`
            : 'Доступно точно';
      const label = document.createElement('span');
      label.textContent = option.label;
      const small = document.createElement('small');
      small.textContent = detail;
      button.append(label, small);
      button.addEventListener('click', () => beginDownload(shadow, option.targetHeight));
      qualities.append(button);
    }
    if (activeJob?.videoId === metadata.videoId) renderJob(shadow, activeJob);
  }

  async function openModal() {
    const shadow = createModal();
    renderModal(shadow);
    syncFilenameField(shadow, true);
    requestMetadata();
    try {
      const response = await send({ type: 'YTD_LIST_JOBS' });
      const latest = response?.jobs
        ?.filter((job) => job.videoId === metadata?.videoId)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
      if (latest) renderJob(shadow, latest);
    } catch (error) {
      if (error.message === 'EXTENSION_CONTEXT_INVALIDATED') {
        shadow.querySelector('.title').textContent = 'Требуется обновление вкладки';
        shadow.querySelector('.notice').textContent = invalidatedMessage();
      }
    }
  }

  function navigationChanged() {
    const videoId = currentVideoId();
    if (lastUrl === location.href && document.getElementById(BUTTON_ID) && videoId === lastVideoId) return;
    lastUrl = location.href;
    lastVideoId = videoId;
    metadata = null;
    activeJob = null;
    document.getElementById(BUTTON_ID)?.remove();
    // Close modal so previous title/filename cannot linger across SPA navigations.
    closeModal();
    scheduleMount();
    requestMetadata();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;

    // E2E bridge: page world <-> content script
    if (event.data?.channel === 'ytd-e2e' && event.data?.requestId) {
      (async () => {
        const { requestId, type, payload } = event.data;
        let result = { ok: false };
        try {
          switch (type) {
            case 'GET_STATE':
              result = {
                ok: true,
                metadataRevision,
                videoId: metadata?.videoId || lastVideoId || '',
                hasMetadata: Boolean(metadata),
                formatUrl: metadata?.formats?.[0]?.url || '',
                activeJob: activeJob ? {
                  id: activeJob.id,
                  videoId: activeJob.videoId,
                  state: activeJob.state,
                  errorCode: activeJob.errorCode,
                  suggestedFilename: activeJob.suggestedFilename || null,
                  actualFilename: activeJob.actualFilename || null,
                } : null,
              };
              break;
            case 'WAIT_FRESH_META':
              result = await waitForFreshMetadata(payload?.expectedVideoId || lastVideoId || metadata?.videoId || '', {
                timeoutMs: payload?.timeoutMs,
                pollMs: payload?.pollMs,
              });
              if (result.ok) {
                result.formatUrl = result.metadata?.formats?.[0]?.url || '';
              }
              break;
            case 'MARK_JOB_FAILED':
              result = await send({
                type: 'YTD_MARK_JOB_FAILED',
                payload: {
                  jobId: payload?.jobId || activeJob?.id || '',
                  errorCode: payload?.errorCode || 'E2E_FORCED_FAILURE',
                },
              });
              if (result?.job) activeJob = result.job;
              break;
            case 'CANCEL_JOB':
              result = await send({
                type: 'YTD_CANCEL_JOB',
                payload: { jobId: payload?.jobId || activeJob?.id || '' },
              });
              if (result?.job) activeJob = result.job;
              break;
            case 'FILENAME_DIAGNOSTICS':
              result = await send({ type: 'YTD_FILENAME_DIAGNOSTICS' });
              break;
            case 'RETRY_ACTIVE': {
              const expectedId = activeJob?.videoId || metadata?.videoId || lastVideoId;
              const fresh = await waitForFreshMetadata(expectedId, {
                timeoutMs: payload?.timeoutMs,
              });
              if (!fresh.ok) {
                result = fresh;
                break;
              }
              result = await send({
                type: 'YTD_RETRY_JOB',
                payload: { jobId: activeJob?.id || payload?.jobId || '', metadata: fresh.metadata },
              });
              result.metadataRevision = fresh.revision;
              result.previousRevision = fresh.previousRevision;
              result.formatUrl = fresh.metadata?.formats?.[0]?.url || '';
              if (result?.job) activeJob = result.job;
              break;
            }
            case 'RETRY_MISMATCH': {
              const mismatched = metadata
                ? { ...metadata, videoId: payload?.videoId || 'mismatched-video-id' }
                : null;
              if (!mismatched || !activeJob?.id) {
                result = { ok: false, errorCode: 'JOB_NOT_FOUND' };
                break;
              }
              result = await send({
                type: 'YTD_RETRY_JOB',
                payload: { jobId: activeJob.id, metadata: mismatched },
              });
              break;
            }
            default:
              result = { ok: false, errorCode: 'UNKNOWN_E2E_COMMAND' };
          }
        } catch (error) {
          result = { ok: false, error: String(error && error.message || error) };
        }
        window.postMessage({ channel: 'ytd-e2e-response', requestId, result }, location.origin);
      })();
      return;
    }

    if (event.data?.source !== SOURCE || event.data?.type !== 'YTD_PLAYER_METADATA' || !event.data.payload) return;
    const next = event.data.payload;
    if (lastVideoId && next.videoId && next.videoId !== lastVideoId) return;
    metadata = next;
    metadataRevision += 1;
    lastVideoId = next.videoId || lastVideoId;
    scheduleMount();
    const modal = document.getElementById(MODAL_ID);
    if (modal?.shadowRoot) renderModal(modal.shadowRoot);
  });

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'YTD_JOB_UPDATED' || !message.payload?.job) return;
      const job = message.payload.job;
      if (metadata && job.videoId !== metadata.videoId) return;
      if (lastVideoId && job.videoId !== lastVideoId) return;
      activeJob = job;
      const modal = document.getElementById(MODAL_ID);
      if (modal?.shadowRoot) renderJob(modal.shadowRoot, job);
    });
  } catch (error) {
    if (isContextInvalidated(error)) extensionAlive = false;
  }

  document.addEventListener('yt-navigate-finish', navigationChanged, true);
  window.addEventListener('popstate', navigationChanged);
  new MutationObserver(() => {
    if (lastUrl !== location.href) navigationChanged();
    else scheduleMount();
  }).observe(document.documentElement, { childList: true, subtree: true });

  lastVideoId = currentVideoId();
  injectBridge();
  scheduleMount();
  setTimeout(requestMetadata, 200);
  setTimeout(requestMetadata, 1000);
  setTimeout(requestMetadata, 2500);
})();
