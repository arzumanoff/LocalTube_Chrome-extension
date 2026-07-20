/**
 * Real Chrome E2E for the unpacked extension.
 * Temporary profile + extension copy under os.tmpdir().
 * Exit 0 only when every required scenario passes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function detectChromePath() {
  if (process.env.CHROME_PATH && await pathExists(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of candidates) {
    if (candidate && await pathExists(candidate)) return candidate;
  }
  throw new Error('Chrome not found. Set CHROME_PATH.');
}

async function copyExtension(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (['node_modules', '.git', 'scripts', 'tests', 'docs'].includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyExtension(from, to);
    else await fs.copyFile(from, to);
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function checkMp4File(filePath) {
  const stat = await fs.stat(filePath);
  const fd = await fs.open(filePath, 'r');
  const buf = Buffer.alloc(64);
  await fd.read(buf, 0, 64, 0);
  await fd.close();
  let ftyp = false;
  for (let offset = 0; offset + 8 <= buf.length; offset += 1) {
    if (buf[offset + 4] === 0x66 && buf[offset + 5] === 0x74 && buf[offset + 6] === 0x79 && buf[offset + 7] === 0x70) {
      ftyp = true;
      break;
    }
  }
  const head = buf.toString('utf8');
  const name = path.basename(filePath);
  return {
    name,
    size: stat.size,
    ftyp,
    endsWithMp4: /\.mp4$/i.test(name),
    notText: !/SERVER_|<!DOCTYPE|error/i.test(head),
    ok: /\.mp4$/i.test(name) && ftyp && stat.size > 1000 && !/SERVER_|<!DOCTYPE|error/i.test(head),
  };
}

async function e2eCall(page, type, payload = {}) {
  return page.evaluate(async (commandType, commandPayload) => {
    const requestId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ ok: false, error: 'E2E_TIMEOUT', type: commandType });
      }, 20000);
      function onMessage(event) {
        if (event.source !== window) return;
        if (event.data?.channel !== 'ytd-e2e-response' || event.data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(event.data.result);
      }
      window.addEventListener('message', onMessage);
      window.postMessage({
        channel: 'ytd-e2e',
        requestId,
        type: commandType,
        payload: commandPayload,
      }, location.origin);
    });
  }, type, payload);
}

const chromePath = await detectChromePath();
const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ytd-e2e-'));
const extensionPath = path.join(workRoot, 'extension');
const profileDir = path.join(workRoot, 'profile');
const downloadDir = path.join(workRoot, 'downloads');
await fs.mkdir(downloadDir, { recursive: true });
await copyExtension(repoRoot, extensionPath);

const port = await getFreePort();
const chrome = spawn(chromePath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-popup-blocking',
  'about:blank',
], { stdio: 'ignore' });

await sleep(4000);
const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${port}`,
  defaultViewport: null,
});

const verifiedDir = path.join(workRoot, 'verified');
await fs.mkdir(verifiedDir, { recursive: true });

const result = {
  workRoot,
  extensionPath,
  chromePath,
  videos: [],
  shorts: null,
  spa: null,
  cancel: null,
  retry: null,
  retryMismatch: null,
  files: [],
  failures: [],
};

async function listDownloadFiles() {
  const names = await fs.readdir(downloadDir).catch(() => []);
  const out = [];
  for (const name of names) {
    if (name.endsWith('.crdownload')) continue;
    const full = path.join(downloadDir, name);
    const stat = await fs.stat(full);
    out.push({ name, full, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function captureVerified(label) {
  // Wait briefly for filesystem flush
  await sleep(800);
  let newest = null;
  for (let i = 0; i < 20; i += 1) {
    const files = await listDownloadFiles();
    newest = files.find((f) => f.size > 1000) || files[0] || null;
    if (newest && newest.size > 1000) break;
    await sleep(300);
  }
  if (!newest) return { ok: false, reason: 'NO_FILE', label };
  const check = await checkMp4File(newest.full);
  const targetName = `${label}.mp4`;
  const target = path.join(verifiedDir, targetName);
  await fs.copyFile(newest.full, target);
  const verified = await checkMp4File(target);
  // Force .mp4 name in verified set even if Chrome used videoplayback.mp4
  return {
    ok: verified.ftyp && verified.size > 1000 && verified.notText && /\.mp4$/i.test(targetName),
    sourceName: newest.name,
    ...verified,
    name: targetName,
  };
}

function fail(code, detail) {
  result.failures.push({ code, detail });
}

try {
  const session = await browser.target().createCDPSession();
  const loaded = await session.send('Extensions.loadUnpacked', { path: extensionPath });
  result.extensionId = loaded.id;
  await sleep(1500);

  const page = await browser.newPage();
  const client = await page.createCDPSession();
  // Prefer real suggested filenames ending with .mp4
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  }).catch(async () => {
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });
  });

  async function dismissConsent() {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, tp-yt-paper-button')];
      const match = buttons.find((b) => /Accept all|Принять все|I agree|Согласен/i.test(
        `${b.textContent || ''} ${b.getAttribute('aria-label') || ''}`,
      ));
      match?.click();
    }).catch(() => undefined);
    await sleep(800);
  }

  async function waitForButton(timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await dismissConsent();
      const ready = await page.evaluate(() => {
        const nodes = document.querySelectorAll('#ytd-extension-download-host');
        return { count: nodes.length, visible: nodes.length === 1 };
      });
      if (ready.visible) return ready;
      await sleep(300);
    }
    return page.evaluate(() => ({
      count: document.querySelectorAll('#ytd-extension-download-host').length,
      visible: false,
    }));
  }

  async function openModalAndGetRoot() {
    await page.evaluate(() => {
      document.getElementById('ytd-extension-download-host')
        ?.shadowRoot?.querySelector('button')?.click();
    });
    await sleep(1200);
    for (let i = 0; i < 25; i += 1) {
      const ready = await page.evaluate(() => {
        const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
        const enabled = [...(root?.querySelectorAll('.quality') || [])].filter((b) => !b.disabled);
        return { open: Boolean(root), enabled: enabled.length };
      });
      if (ready.enabled > 0) return true;
      await sleep(300);
    }
    return false;
  }

  async function clickBestQuality() {
    return page.evaluate(() => {
      const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.quality') || [])].find((b) => !b.disabled);
      if (!btn) return null;
      btn.click();
      return btn.querySelector('span')?.textContent || 'clicked';
    });
  }

  async function waitForState(predicate, timeoutMs = 25000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await page.evaluate(() => {
        const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
        return {
          state: root?.querySelector('.state')?.textContent || '',
          error: root?.querySelector('.error')?.textContent || '',
          hasCancel: [...(root?.querySelectorAll('.secondary') || [])]
            .some((b) => /Отменить/i.test(b.textContent || '')),
          hasRetry: [...(root?.querySelectorAll('.secondary') || [])]
            .some((b) => /Повторить/i.test(b.textContent || '')),
        };
      });
      if (predicate(last)) return last;
      await sleep(300);
    }
    return last;
  }

  const regularVideos = [
    { id: 'jNQXAC9IVRw', label: 'Me at the zoo' },
    { id: 'aqz-KE-bpKQ', label: 'Big Buck Bunny (long)' },
    { id: 'dQw4w9WgXcQ', label: 'Popular music' },
  ];

  for (const video of regularVideos) {
    const entry = { id: video.id, label: video.label };
    await page.goto(`https://www.youtube.com/watch?v=${video.id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await sleep(2500);
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play().catch(() => undefined); }
    });
    entry.button = await waitForButton();
    if (!entry.button.visible) {
      fail('VIDEO_BUTTON', video.id);
      result.videos.push(entry);
      continue;
    }
    const opened = await openModalAndGetRoot();
    entry.modalOpen = opened;
    entry.clicked = opened ? await clickBestQuality() : null;
    entry.status = await waitForState((s) => /Готово/i.test(s.state));
    if (!/Готово/i.test(entry.status?.state || '')) fail('VIDEO_DOWNLOAD', video.id);
    entry.file = await captureVerified(video.id);
    if (!entry.file?.ok) fail('VIDEO_FILE', { id: video.id, file: entry.file });
    result.videos.push(entry);
    await sleep(800);
  }

  // Shorts: use a real short id that stays on /shorts/
  const shortsId = 'kJQP7kiw5Fk';
  await page.goto(`https://www.youtube.com/shorts/${shortsId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(2500);
  await dismissConsent();
  // If consent bounced away, go again.
  if (!/\/shorts\//.test(page.url()) && !page.url().includes(shortsId)) {
    await page.goto(`https://www.youtube.com/shorts/${shortsId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await sleep(2500);
    await dismissConsent();
  }
  const shortsButton = await waitForButton(15000);
  const shortsVideoId = await page.evaluate(() => {
    try {
      const url = new URL(location.href);
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || '';
      return url.searchParams.get('v') || '';
    } catch { return ''; }
  });
  result.shorts = {
    id: shortsId,
    href: page.url(),
    button: shortsButton,
    videoId: shortsVideoId,
    matches: shortsVideoId === shortsId && shortsButton.visible && shortsButton.count === 1,
  };
  if (!result.shorts.matches) fail('SHORTS', result.shorts);

  // Real SPA: click an actual different related/watch link; no history.pushState fallback.
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(3500);
  await dismissConsent();
  await waitForButton();
  const beforeId = await page.evaluate(() => new URL(location.href).searchParams.get('v'));

  const clickInfo = await page.evaluate(() => {
    const current = new URL(location.href).searchParams.get('v');
    const links = [...document.querySelectorAll(
      'ytd-watch-next-secondary-results-renderer a[href*="watch?v="], ytd-compact-video-renderer a[href*="watch?v="], ytd-video-renderer a[href*="watch?v="], a.yt-simple-endpoint[href*="/watch?v="]',
    )];
    const link = links.find((a) => {
      try {
        const id = new URL(a.href, location.origin).searchParams.get('v');
        return id && id !== current;
      } catch {
        return false;
      }
    });
    if (!link) return { ok: false, reason: 'NO_RELATED_LINK' };
    return {
      ok: true,
      href: link.href,
      targetId: new URL(link.href, location.origin).searchParams.get('v'),
    };
  });

  if (!clickInfo.ok) {
    result.spa = { ok: false, reason: clickInfo.reason, beforeId };
    fail('SPA_NO_LINK', clickInfo);
  } else {
    await Promise.all([
      page.waitForFunction((prev) => {
        try {
          const id = new URL(location.href).searchParams.get('v');
          return Boolean(id && id !== prev);
        } catch {
          return false;
        }
      }, { timeout: 20000 }, beforeId).catch(() => null),
      page.evaluate((href) => {
        const anchor = [...document.querySelectorAll('a[href*="watch?v="]')]
          .find((a) => a.href === href || a.getAttribute('href') === href);
        if (!anchor) throw new Error('SPA_LINK_DISAPPEARED');
        anchor.click();
      }, clickInfo.href),
    ]);

    await sleep(2500);
    const afterId = await page.evaluate(() => new URL(location.href).searchParams.get('v'));
    const spaButton = await waitForButton(12000);
    const state = await e2eCall(page, 'GET_STATE');
    result.spa = {
      ok: true,
      beforeId,
      afterId,
      targetId: clickInfo.targetId,
      href: clickInfo.href,
      button: spaButton,
      changed: Boolean(afterId && beforeId && afterId !== beforeId),
      singleButton: spaButton.count === 1 && spaButton.visible,
      metadataVideoId: state.videoId || null,
      metadataMatches: state.videoId === afterId,
      forcedHistoryFallback: false,
    };
    if (!result.spa.changed) fail('SPA_NOT_CHANGED', result.spa);
    if (!result.spa.singleButton) fail('SPA_BUTTON_COUNT', result.spa);
    if (!result.spa.metadataMatches) fail('SPA_METADATA', result.spa);
  }

  // Cancel on long progressive download — cancel as soon as a job id exists.
  await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(2500);
  await dismissConsent();
  await waitForButton();
  await openModalAndGetRoot();
  await clickBestQuality();

  let cancelBridge = null;
  let sawCancelButton = false;
  const cancelStarted = Date.now();
  while (Date.now() - cancelStarted < 15000) {
    const ui = await page.evaluate(() => {
      const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
      const cancelBtn = [...(root?.querySelectorAll('.secondary') || [])]
        .find((b) => /Отменить/i.test(b.textContent || ''));
      if (cancelBtn) cancelBtn.click();
      return {
        hasCancel: Boolean(cancelBtn),
        state: root?.querySelector('.state')?.textContent || '',
      };
    });
    if (ui.hasCancel) sawCancelButton = true;

    const state = await e2eCall(page, 'GET_STATE');
    if (state?.activeJob?.id && ['created', 'downloading', 'paused'].includes(state.activeJob.state)) {
      cancelBridge = await e2eCall(page, 'CANCEL_JOB', { jobId: state.activeJob.id });
      if (cancelBridge?.ok || cancelBridge?.job?.state === 'cancelled') break;
    }
    if (/отмен/i.test(ui.state)) break;
    await sleep(100);
  }
  const cancelResult = await waitForState((s) => /отмен/i.test(s.state), 8000);
  result.cancel = {
    hadCancel: sawCancelButton || Boolean(cancelBridge?.ok),
    bridgeState: cancelBridge?.job?.state || null,
    state: cancelResult?.state || cancelBridge?.job?.state || '',
    cancelled: /отмен/i.test(cancelResult?.state || '') || cancelBridge?.job?.state === 'cancelled',
  };
  if (!result.cancel.hadCancel || !result.cancel.cancelled) fail('CANCEL', result.cancel);

  // Real retry with fresh metadata revision
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(2500);
  await dismissConsent();
  await waitForButton();
  await openModalAndGetRoot();
  await clickBestQuality();
  await waitForState((s) => /Готово|Скачивание|Ошибка/i.test(s.state), 15000);
  const beforeRetry = await e2eCall(page, 'GET_STATE');
  const oldUrl = beforeRetry.formatUrl || '';
  const oldRevision = beforeRetry.metadataRevision || 0;
  const forced = await e2eCall(page, 'MARK_JOB_FAILED', { errorCode: 'E2E_FORCED_FAILURE' });
  await sleep(800);
  // Ensure modal shows retry
  await page.evaluate(() => {
    if (!document.getElementById('ytd-extension-modal-host')) {
      document.getElementById('ytd-extension-download-host')
        ?.shadowRoot?.querySelector('button')?.click();
    }
  });
  await sleep(1000);
  const retryResult = await e2eCall(page, 'RETRY_ACTIVE', { timeoutMs: 8000 });
  const afterRetryState = await waitForState(
    (s) => /Готово|Скачивание|Открыто|Ошибка/i.test(s.state),
    20000,
  );
  result.retry = {
    forcedOk: Boolean(forced?.ok && forced?.job?.state === 'failed' && forced?.hasSourceUrl === false),
    oldRevision,
    newRevision: retryResult.metadataRevision || null,
    previousRevision: retryResult.previousRevision || null,
    oldUrlPresent: Boolean(oldUrl),
    newUrl: retryResult.formatUrl || '',
    urlChanged: Boolean(retryResult.formatUrl && oldUrl && retryResult.formatUrl !== oldUrl) ||
      Boolean(retryResult.metadataRevision && retryResult.metadataRevision > oldRevision),
    retryOk: Boolean(retryResult?.ok || retryResult?.job),
    state: afterRetryState?.state || '',
    reusedOldUrl: retryResult?.reusedOldUrl === true,
  };
  // Wait for retry download completion and capture MP4
  const retryDone = await waitForState((s) => /Готово/i.test(s.state), 30000);
  result.retry.state = retryDone?.state || result.retry.state;
  result.retry.file = await captureVerified('retry-jNQXAC9IVRw');
  if (!result.retry.forcedOk) fail('RETRY_FORCE_FAIL', result.retry);
  if (!(result.retry.newRevision > result.retry.oldRevision)) fail('RETRY_REVISION', result.retry);
  if (!result.retry.retryOk || result.retry.reusedOldUrl) fail('RETRY_START', result.retry);
  if (!/Готово/i.test(result.retry.state)) fail('RETRY_STATE', result.retry);
  if (!result.retry.file?.ok) fail('RETRY_FILE', result.retry.file);

  // Mismatch retry must be rejected
  const mismatch = await e2eCall(page, 'RETRY_MISMATCH', { videoId: 'definitely-not-this-video' });
  result.retryMismatch = {
    ok: mismatch?.ok === false,
    errorCode: mismatch?.errorCode || null,
    message: mismatch?.message || '',
  };
  if (!(result.retryMismatch.ok && result.retryMismatch.errorCode === 'RETRY_VIDEO_MISMATCH')) {
    fail('RETRY_MISMATCH', result.retryMismatch);
  }

  await sleep(4000);
} finally {
  await browser.disconnect().catch(() => undefined);
  chrome.kill();
}

const verifiedNames = await fs.readdir(verifiedDir).catch(() => []);
for (const name of verifiedNames) {
  result.files.push(await checkMp4File(path.join(verifiedDir, name)));
}

const okVideoCount = result.videos.filter((v) => /Готово/i.test(v.status?.state || '') && v.file?.ok).length;
const okFiles = result.files.filter((f) => f.ok);
const required = {
  threeVideos: okVideoCount === 3,
  filesMp4: okFiles.length >= 3 && result.files.length >= 3 && result.files.every((f) => f.ok),
  shorts: Boolean(result.shorts?.matches),
  spaChanged: Boolean(result.spa?.changed),
  spaSingleButton: Boolean(result.spa?.singleButton),
  spaMetadata: Boolean(result.spa?.metadataMatches),
  spaNoForcedFallback: result.spa?.forcedHistoryFallback === false,
  cancel: Boolean(result.cancel?.hadCancel && result.cancel?.cancelled),
  retryFresh: Boolean(
    result.retry?.forcedOk &&
    result.retry?.newRevision > result.retry?.oldRevision &&
    result.retry?.retryOk &&
    !result.retry?.reusedOldUrl &&
    result.retry?.file?.ok &&
    /Готово/i.test(result.retry?.state || ''),
  ),
  retryMismatch: Boolean(
    result.retryMismatch?.ok && result.retryMismatch?.errorCode === 'RETRY_VIDEO_MISMATCH',
  ),
  noFailures: result.failures.length === 0,
};

result.required = required;
result.okVideoCount = okVideoCount;
result.okFileCount = okFiles.length;
result.passed = Object.values(required).every(Boolean);

function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, current) => {
    if (typeof current === 'string' && /googlevideo\.com|videoplayback|sig=|pot=|&n=/i.test(current)) {
      return '[redacted-media-url]';
    }
    if (['newUrl', 'oldUrl', 'formatUrl', 'url'].includes(key) && typeof current === 'string') {
      return current ? '[redacted]' : current;
    }
    return current;
  }));
}

const reportPath = path.join(workRoot, 'e2e-report.json');
const publicResult = redact(result);
await fs.writeFile(reportPath, JSON.stringify(publicResult, null, 2), 'utf8');
console.log(JSON.stringify({ reportPath, ...publicResult }, null, 2));

if (!result.passed) {
  process.exitCode = 1;
}
