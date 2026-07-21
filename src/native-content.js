(function installNativeDownloaderUi() {
  if (window.__YTD_NATIVE_UI_INSTALLED__) return;
  window.__YTD_NATIVE_UI_INSTALLED__ = true;

  const BUTTON_ID = 'ytd-native-download-host';
  const MODAL_ID = 'ytd-native-download-modal';
  const core = globalThis.YTDCore || {};
  const TERMINAL_STAGES = new Set(['completed', 'cancelled', 'failed']);

  let lastUrl = location.href;
  let mountTimer = null;
  let activeJobId = '';
  let extensionAlive = true;

  function isContextInvalidated(error) {
    const message = String(error?.message || error || '');
    return /extension context invalidated|message port closed|receiving end does not exist/i.test(message);
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
            if (isContextInvalidated(error)) extensionAlive = false;
            reject(new Error(error.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        if (isContextInvalidated(error)) extensionAlive = false;
        reject(error);
      }
    });
  }

  function supportedPage() {
    return location.pathname === '/watch' && Boolean(new URL(location.href).searchParams.get('v'));
  }

  function findMountTarget() {
    return document.querySelector(
      'ytd-watch-metadata #actions-inner, ytd-watch-metadata #actions, #menu-container #top-level-buttons-computed, #actions-inner, #actions',
    );
  }

  function closeModal() {
    document.getElementById(MODAL_ID)?.remove();
    activeJobId = '';
  }

  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mountButton();
    }, 120);
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
    shadow.innerHTML = `
      <style>
        :host{display:inline-flex;margin-left:8px}
        button{border:0;border-radius:999px;padding:10px 17px;background:#ff0033;color:#fff;cursor:pointer;font:600 14px Arial}
        button:hover{background:#d9002c}
      </style>
      <button type="button">Скачать</button>`;
    shadow.querySelector('button').addEventListener('click', openModal);
    target.append(host);
  }

  function createModal() {
    closeModal();
    const host = document.createElement('div');
    host.id = MODAL_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}*{box-sizing:border-box}
        .overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.68);font-family:Arial;color:#f5f5f5}
        .card{width:min(580px,100%);max-height:calc(100vh - 40px);overflow:auto;background:#171717;border:1px solid #343434;border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.45)}
        .head{display:flex;justify-content:space-between;align-items:center;padding:22px 22px 14px}.head h2{margin:0;font-size:22px}.close{width:36px;height:36px;border:0;border-radius:50%;background:#2a2a2a;color:#fff;font-size:22px;cursor:pointer}
        .body{padding:0 22px 22px}.title{margin:0 0 7px;font-weight:700;font-size:16px;line-height:1.35}.meta{margin:0 0 14px;color:#aaa;font-size:13px}
        .notice{margin:0 0 14px;padding:12px 14px;border-radius:12px;background:#242424;color:#cfcfcf;font-size:13px;line-height:1.45}
        .filename-label{display:grid;gap:8px;margin:14px 0 16px;color:#ddd;font-size:13px}.filename{width:100%;border:1px solid #444;border-radius:10px;padding:11px 12px;background:#111;color:#fff;font:14px Arial}
        .qualities{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.quality{border:1px solid #3d3d3d;border-radius:12px;padding:13px 14px;text-align:left;background:#222;color:#fff;cursor:pointer;font:600 14px Arial}.quality:hover:not(:disabled){border-color:#ff0033}.quality small{display:block;margin-top:5px;color:#aaa;font-weight:400;line-height:1.35}.quality:disabled{opacity:.45;cursor:not-allowed}
        .status{margin-top:18px;padding:14px;border-radius:12px;background:#222}.line{display:flex;justify-content:space-between;gap:15px;font-size:13px}.percent{white-space:nowrap}.bar{height:8px;margin-top:10px;border-radius:999px;background:#3a3a3a;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#ff0033;transition:width .15s linear}.details{margin-top:8px;color:#aaa;font-size:12px}.error{margin-top:10px;color:#ff8d9f;font-size:13px;line-height:1.4;white-space:pre-wrap}.actions{display:flex;gap:8px;margin-top:12px}.secondary{border:1px solid #555;border-radius:9px;padding:8px 12px;background:transparent;color:#fff;cursor:pointer}.secondary:hover{border-color:#888}
        @media(max-width:480px){.qualities{grid-template-columns:1fr}}
      </style>
      <div class="overlay" role="dialog" aria-modal="true">
        <section class="card">
          <div class="head"><h2>Скачать видео</h2><button class="close" type="button" aria-label="Закрыть">×</button></div>
          <div class="body">
            <p class="title">Получаю доступные качества…</p>
            <p class="meta"></p>
            <p class="notice">Список строится по реальным форматам текущего ролика. Несуществующие качества не будут показаны.</p>
            <label class="filename-label" hidden>Имя файла<input class="filename" type="text" spellcheck="false" autocomplete="off"></label>
            <div class="qualities"></div>
            <div class="status"><div class="line"><span class="state">Подключаю локальный движок…</span><strong class="percent"></strong></div><div class="bar"><i></i></div><div class="details"></div><div class="error"></div><div class="actions"></div></div>
          </div>
        </section>
      </div>`;

    shadow.querySelector('.close').addEventListener('click', closeModal);
    shadow.querySelector('.overlay').addEventListener('click', (event) => {
      if (event.target.classList.contains('overlay')) closeModal();
    });
    document.documentElement.append(host);
    return shadow;
  }

  function defaultFilename(probe) {
    if (typeof core.resolveRequestedFilename === 'function') {
      return core.resolveRequestedFilename('', probe?.title || 'video', probe?.videoId || 'video');
    }
    return `${probe?.title || probe?.videoId || 'video'}.mp4`;
  }

  function durationText(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) return '';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      : `${minutes}:${String(rest).padStart(2, '0')}`;
  }

  function qualityDetail(quality) {
    if (quality.requiresTranscode) return 'Будет преобразовано в MP4 (H.264 + AAC)';
    if (quality.requiresMerge) return 'Видео и звук будут объединены без потери качества';
    return 'Готовый MP4';
  }

  function setError(shadow, response, fallback) {
    const code = response?.errorCode ? `\nКод: ${response.errorCode}` : '';
    shadow.querySelector('.state').textContent = 'Ошибка';
    shadow.querySelector('.error').textContent = `${response?.message || fallback}${code}`;
  }

  function setQualityButtonsDisabled(shadow, disabled) {
    shadow.querySelectorAll('.quality').forEach((button) => { button.disabled = disabled; });
  }

  function setProgress(shadow, payload) {
    const stageLabels = {
      preparing: 'Подготовка…',
      downloading: 'Скачивание…',
      merging: 'Объединение видео и звука…',
      converting: 'Обработка в MP4…',
      finalizing: 'Сохранение файла…',
      completed: 'Готово — файл сохранён',
      cancelled: 'Скачивание отменено',
      failed: 'Ошибка скачивания',
    };
    const stage = String(payload?.stage || '');
    const terminal = TERMINAL_STAGES.has(stage);
    const percent = Number.isFinite(Number(payload?.percent))
      ? Math.max(0, Math.min(100, Number(payload.percent)))
      : null;
    shadow.querySelector('.state').textContent = stageLabels[stage] || payload?.message || 'Выполняется…';
    shadow.querySelector('.percent').textContent = percent === null ? '' : `${Math.round(percent)}%`;
    shadow.querySelector('.bar i').style.width = percent === null ? '0%' : `${percent}%`;
    shadow.querySelector('.details').textContent = [payload?.speed, payload?.eta ? `Осталось: ${payload.eta} с` : ''].filter(Boolean).join(' · ');
    shadow.querySelector('.error').textContent = stage === 'failed' ? (payload.message || 'Не удалось скачать видео.') : '';

    const actions = shadow.querySelector('.actions');
    actions.replaceChildren();
    if (activeJobId && !terminal) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = 'Отменить';
      cancel.addEventListener('click', () => cancelDownload(shadow));
      actions.append(cancel);
    }

    if (terminal) {
      activeJobId = '';
      setQualityButtonsDisabled(shadow, false);
    }
  }

  async function cancelDownload(shadow) {
    if (!activeJobId) return;
    try {
      const response = await send({ type: 'YTD_NATIVE_CANCEL', payload: { jobId: activeJobId } });
      if (!response?.ok) setError(shadow, response, 'Не удалось отменить скачивание.');
      else setProgress(shadow, { stage: 'cancelled' });
    } catch (error) {
      setError(shadow, null, error.message);
    }
  }

  function showExistingJob(shadow, response) {
    activeJobId = String(response?.jobId || '');
    setQualityButtonsDisabled(shadow, true);
    setProgress(shadow, {
      stage: response?.stage || 'preparing',
      percent: response?.percent,
      message: response?.message,
    });
    shadow.querySelector('.error').textContent = 'Уже выполняется другое скачивание. Его можно отменить кнопкой ниже.';
  }

  async function beginDownload(shadow, quality) {
    const buttons = [...shadow.querySelectorAll('.quality')];
    buttons.forEach((button) => { button.disabled = true; });
    shadow.querySelector('.error').textContent = '';
    setProgress(shadow, { stage: 'preparing', percent: 0 });

    try {
      const response = await send({
        type: 'YTD_NATIVE_DOWNLOAD',
        payload: {
          url: location.href,
          qualityId: quality.id,
          suggestedFilename: String(shadow.querySelector('.filename')?.value || '').trim(),
        },
      });
      if (!response?.ok) {
        if (response?.cancelled || response?.errorCode === 'SAVE_DIALOG_CANCELLED') {
          setProgress(shadow, { stage: 'cancelled' });
          return;
        }
        if (response?.errorCode === 'BUSY' && response?.jobId) {
          showExistingJob(shadow, response);
          return;
        }
        setError(shadow, response, 'Не удалось начать скачивание.');
        return;
      }
      activeJobId = String(response.jobId || '');
      setProgress(shadow, { stage: response.stage || 'preparing', percent: 0 });
    } catch (error) {
      setError(shadow, null, isContextInvalidated(error)
        ? 'Расширение обновилось. Перезагрузите вкладку YouTube.'
        : error.message);
    } finally {
      if (!activeJobId) buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function renderProbe(shadow, probe) {
    shadow.querySelector('.title').textContent = probe.title;
    shadow.querySelector('.meta').textContent = [probe.channel, durationText(probe.duration)].filter(Boolean).join(' · ');
    shadow.querySelector('.state').textContent = 'Выберите качество';
    shadow.querySelector('.percent').textContent = '';
    shadow.querySelector('.bar i').style.width = '0%';
    shadow.querySelector('.details').textContent = '';
    shadow.querySelector('.error').textContent = '';

    shadow.querySelector('.filename-label').hidden = false;
    shadow.querySelector('.filename').value = defaultFilename(probe);

    const qualities = shadow.querySelector('.qualities');
    qualities.replaceChildren();
    const entries = [{ ...probe.qualities[0], bestAlias: true }, ...probe.qualities];
    for (const quality of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quality';
      const label = document.createElement('span');
      label.textContent = quality.bestAlias ? `Лучшее — ${quality.label}` : quality.label;
      const small = document.createElement('small');
      small.textContent = qualityDetail(quality);
      button.append(label, small);
      button.addEventListener('click', () => beginDownload(shadow, quality));
      qualities.append(button);
    }
  }

  async function restoreActiveJob(shadow) {
    try {
      const status = await send({ type: 'YTD_NATIVE_STATUS' });
      if (status?.ok && status?.busy && status?.jobId) showExistingJob(shadow, status);
    } catch {
      // Probe already reports connection problems; status restoration is best-effort.
    }
  }

  async function probeCurrentVideo(shadow) {
    try {
      const response = await send({ type: 'YTD_NATIVE_PROBE', payload: { url: location.href } });
      if (!response?.ok) {
        setError(shadow, response, 'Не удалось получить список качеств.');
        if (response?.errorCode === 'NATIVE_HOST_NOT_INSTALLED') {
          shadow.querySelector('.notice').textContent = 'Локальный движок не установлен. На этапе разработки установите Native Host из папки native-host.';
        }
        return;
      }
      renderProbe(shadow, response);
      await restoreActiveJob(shadow);
    } catch (error) {
      setError(shadow, null, isContextInvalidated(error)
        ? 'Расширение обновилось. Перезагрузите вкладку YouTube.'
        : error.message);
    }
  }

  function openModal() {
    probeCurrentVideo(createModal());
  }

  function navigationChanged() {
    if (lastUrl === location.href && document.getElementById(BUTTON_ID)) return;
    lastUrl = location.href;
    activeJobId = '';
    document.getElementById(BUTTON_ID)?.remove();
    closeModal();
    scheduleMount();
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'YTD_NATIVE_EVENT' || !message.payload) return;
      const payload = message.payload;
      if (payload.jobId && activeJobId && payload.jobId !== activeJobId) return;
      if (payload.jobId && !activeJobId) activeJobId = String(payload.jobId);
      const modal = document.getElementById(MODAL_ID);
      if (modal?.shadowRoot) setProgress(modal.shadowRoot, payload);
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

  scheduleMount();
})();
