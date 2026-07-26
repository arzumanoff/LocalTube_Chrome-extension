(function installHardwareStatusUi() {
  if (window.__YTD_HARDWARE_STATUS_INSTALLED__) return;
  window.__YTD_HARDWARE_STATUS_INSTALLED__ = true;

  const MODAL_ID = 'ytd-native-download-modal';

  function updateDetails(payload) {
    if (!payload?.encoderLabel) return;
    queueMicrotask(() => {
      const modal = document.getElementById(MODAL_ID);
      const details = modal?.shadowRoot?.querySelector('.details');
      if (!details) return;
      const parts = [
        String(payload.encoderLabel),
        payload.speed ? String(payload.speed) : '',
        payload.eta ? `Осталось: ${payload.eta} с` : '',
      ].filter(Boolean);
      details.textContent = parts.join(' · ');
    });
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'YTD_NATIVE_EVENT') return;
      updateDetails(message.payload);
    });
  } catch {
    // The main content script handles invalidated extension contexts.
  }
})();
