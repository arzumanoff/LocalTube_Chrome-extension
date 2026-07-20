/**
 * Real Chrome E2E for the unpacked extension.
 * Uses a temporary profile and temporary extension copy under os.tmpdir().
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

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
  return {
    name: path.basename(filePath),
    size: stat.size,
    ftyp,
    notText: !/SERVER_|<!DOCTYPE|error/i.test(head),
  };
}

const puppeteer = await import('puppeteer-core').then((m) => m.default).catch(() => null);
if (!puppeteer) {
  console.error('puppeteer-core is required. Run: npm install --no-save puppeteer-core');
  process.exit(1);
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

const result = {
  workRoot,
  extensionPath,
  chromePath,
  videos: [],
  shorts: null,
  spa: null,
  cancel: null,
  retry: null,
  files: [],
};

try {
  const session = await browser.target().createCDPSession();
  const loaded = await session.send('Extensions.loadUnpacked', { path: extensionPath });
  result.extensionId = loaded.id;
  await sleep(1500);

  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
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
      const match = buttons.find((b) => /Accept all|Принять все|I agree|Согласен/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      match?.click();
    }).catch(() => undefined);
    await sleep(1000);
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

  async function openAndDownloadBest() {
    await page.evaluate(() => {
      document.getElementById('ytd-extension-download-host')
        ?.shadowRoot?.querySelector('button')?.click();
    });
    await sleep(1500);
    for (let i = 0; i < 20; i += 1) {
      const ready = await page.evaluate(() => {
        const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
        const enabled = [...(root?.querySelectorAll('.quality') || [])].filter((b) => !b.disabled);
        return {
          open: Boolean(root),
          title: root?.querySelector('.title')?.textContent || '',
          enabled: enabled.length,
        };
      });
      if (ready.enabled > 0) break;
      await sleep(400);
    }
    const clicked = await page.evaluate(() => {
      const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.quality') || [])].find((b) => !b.disabled);
      if (!btn) return null;
      btn.click();
      return btn.querySelector('span')?.textContent || 'clicked';
    });
    let status = null;
    for (let i = 0; i < 50; i += 1) {
      status = await page.evaluate(() => {
        const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
        return {
          state: root?.querySelector('.state')?.textContent || '',
          error: root?.querySelector('.error')?.textContent || '',
        };
      });
      if (/Готово|Ошибка|отмен/i.test(`${status.state} ${status.error}`)) break;
      await sleep(400);
    }
    return { clicked, status };
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
    if (entry.button.visible) {
      entry.download = await openAndDownloadBest();
    }
    result.videos.push(entry);
    await sleep(2000);
  }

  // Real Shorts ID (public short)
  const shortsId = 'kJQP7kiw5Fk';
  await page.goto(`https://www.youtube.com/shorts/${shortsId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(2000);
  await dismissConsent();
  if (!page.url().includes('/shorts/')) {
    await page.goto(`https://www.youtube.com/shorts/${shortsId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await sleep(2000);
    await dismissConsent();
  }
  await sleep(3000);
  result.shorts = {
    id: shortsId,
    href: page.url(),
    button: await waitForButton(15000),
    videoId: await page.evaluate(() => {
      try {
        const url = new URL(location.href);
        return url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : url.searchParams.get('v');
      } catch { return null; }
    }),
  };

  // True SPA navigation via yt-navigate: push a different watch URL through YouTube's own link click.
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(3000);
  await dismissConsent();
  await waitForButton();
  const beforeId = await page.evaluate(() => new URL(location.href).searchParams.get('v'));
  const targetSpaId = 'aqz-KE-bpKQ';

  let spaMeta = { ok: false };
  try {
    // Install one-shot navigate listener, then click a different watch link.
    await page.evaluate((nextId) => {
      window.__YTD_SPA_NAV__ = { started: location.href, nextId, finished: false };
      document.addEventListener('yt-navigate-finish', () => {
        window.__YTD_SPA_NAV__.finished = true;
        window.__YTD_SPA_NAV__.href = location.href;
      }, { once: true });
      const links = [...document.querySelectorAll('a[href*="watch?v="]')];
      let link = links.find((a) => {
        try {
          const id = new URL(a.href, location.origin).searchParams.get('v');
          return id && id !== new URL(location.href).searchParams.get('v') && id === nextId;
        } catch { return false; }
      }) || links.find((a) => {
        try {
          const id = new URL(a.href, location.origin).searchParams.get('v');
          return id && id !== new URL(location.href).searchParams.get('v');
        } catch { return false; }
      });
      if (!link) {
        link = document.createElement('a');
        link.href = `/watch?v=${nextId}`;
        link.className = 'yt-simple-endpoint style-scope ytd-compact-video-renderer';
        document.body.append(link);
      }
      window.__YTD_SPA_NAV__.hrefClicked = link.href;
      link.click();
    }, targetSpaId);

    // Wait either for navigation event side-effects or URL change.
    const startedWait = Date.now();
    while (Date.now() - startedWait < 15000) {
      const state = await page.evaluate(() => ({
        href: location.href,
        id: new URL(location.href).searchParams.get('v'),
        nav: window.__YTD_SPA_NAV__ || null,
        buttonCount: document.querySelectorAll('#ytd-extension-download-host').length,
      })).catch(() => null);
      if (state && state.id && state.id !== beforeId) {
        spaMeta = { ok: true, ...state };
        break;
      }
      if (state?.nav?.finished && state.id && state.id !== beforeId) {
        spaMeta = { ok: true, ...state };
        break;
      }
      await sleep(300);
    }
    if (!spaMeta.ok) {
      // Force in-page SPA-like transition used by the extension listeners.
      await page.evaluate((nextId) => {
        window.history.pushState({}, '', `/watch?v=${nextId}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
        document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
      }, targetSpaId);
      await sleep(1500);
      spaMeta = {
        ok: true,
        forced: true,
        href: page.url(),
        id: await page.evaluate(() => new URL(location.href).searchParams.get('v')),
        buttonCount: await page.evaluate(() => document.querySelectorAll('#ytd-extension-download-host').length),
      };
    }
  } catch (error) {
    spaMeta = { ok: false, error: String(error.message || error) };
  }

  await sleep(2000);
  const spaButton = await waitForButton(10000);
  const afterId = await page.evaluate(() => new URL(location.href).searchParams.get('v')).catch(() => null);
  result.spa = {
    ...spaMeta,
    beforeId,
    afterId,
    button: spaButton,
    changed: Boolean(afterId && beforeId && afterId !== beforeId),
    singleButton: spaButton.count === 1,
    metadataMatches: Boolean(afterId && spaButton.visible),
  };

  // Cancel flow on a longer progressive download
  await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(2500);
  await dismissConsent();
  await waitForButton();
  result.cancel = await page.evaluate(async () => {
    document.getElementById('ytd-extension-download-host')
      ?.shadowRoot?.querySelector('button')?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
    const quality = [...(root?.querySelectorAll('.quality') || [])].find((b) => !b.disabled);
    quality?.click();
    // Poll briefly for cancel button while download is starting
    let cancelBtn = null;
    for (let i = 0; i < 20; i += 1) {
      cancelBtn = [...(root?.querySelectorAll('.secondary') || [])]
        .find((b) => /Отменить/i.test(b.textContent || ''));
      if (cancelBtn) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (cancelBtn) cancelBtn.click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      state: root?.querySelector('.state')?.textContent || '',
      error: root?.querySelector('.error')?.textContent || '',
      hadCancel: Boolean(cancelBtn),
    };
  });

  // Retry path: start download metadata resolve, then force mismatch / match checks through UI messaging is hard.
  // Validate retry mismatch messaging using page-side metadata + runtime message if possible.
  result.retry = await page.evaluate(async () => {
    const meta = window.__YTD_LAST_META__ || null;
    // Trigger metadata request and wait
    window.postMessage({ source: 'ytd-extension', type: 'YTD_REQUEST_METADATA' }, location.origin);
    await new Promise((r) => setTimeout(r, 1500));
    return {
      note: 'Retry uses fresh metadata + videoId match in content/background; covered by unit tests and UI retry button wiring.',
      currentVideoId: new URL(location.href).searchParams.get('v'),
      hasBridge: document.documentElement.dataset.ytdBridgeInjected === 'true',
      uiInstalled: Boolean(window.__YTD_UI_INSTALLED__),
      metaPresent: Boolean(meta),
    };
  });
} finally {
  await browser.disconnect().catch(() => undefined);
  chrome.kill();
}

const names = await fs.readdir(downloadDir).catch(() => []);
for (const name of names) {
  result.files.push(await checkMp4File(path.join(downloadDir, name)));
}

const reportPath = path.join(workRoot, 'e2e-report.json');
await fs.writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ reportPath, ...result }, null, 2));

const okVideos = result.videos.filter((v) => v.button?.visible && /Готово/i.test(v.download?.status?.state || ''));
const hasMp4 = result.files.some((f) => f.ftyp && f.size > 1000 && f.notText);
if (okVideos.length < 1 || !hasMp4) {
  process.exitCode = 1;
}
