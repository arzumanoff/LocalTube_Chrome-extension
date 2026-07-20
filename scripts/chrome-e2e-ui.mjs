import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = 'C:\\Users\\Amer\\AppData\\Local\\Temp\\opencode\\ytd-ext';
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytd-ui-'));
const downloadDir = path.join(profileDir, 'downloads');
await fs.mkdir(downloadDir, { recursive: true });

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (['node_modules', '.git', 'scripts'].includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await copyDir(repoRoot, extensionPath);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getFreePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
  s.on('error', reject);
});

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

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
const result = { downloadDir, steps: [] };

try {
  const bsession = await browser.target().createCDPSession();
  const loaded = await bsession.send('Extensions.loadUnpacked', { path: extensionPath });
  result.extensionId = loaded.id;
  await sleep(1500);

  // Reload service worker target check
  result.targets = browser.targets()
    .filter((t) => t.url().includes(loaded.id) || t.type() === 'service_worker')
    .map((t) => ({ type: t.type(), url: t.url().slice(0, 140) }));

  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: downloadDir,
    eventsEnabled: true,
  }).catch(async () => {
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  });

  const downloads = [];
  client.on('Browser.downloadWillBegin', (e) => downloads.push({ type: 'begin', ...e }));
  client.on('Browser.downloadProgress', (e) => {
    if (e.state === 'completed') downloads.push({ type: 'completed', ...e });
  });

  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2500);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.play().catch(() => undefined); }
  });

  // Wait for button after content script inject
  let button = false;
  for (let i = 0; i < 20; i += 1) {
    button = await page.evaluate(() => Boolean(document.getElementById('ytd-extension-download-host')));
    if (button) break;
    await sleep(500);
  }
  result.buttonVisible = button;
  result.steps.push({ button });

  if (!button) {
    // Debug content script
    result.debug = await page.evaluate(() => ({
      ui: Boolean(window.__YTD_UI_INSTALLED__),
      bridge: document.documentElement.dataset.ytdBridgeInjected || null,
      href: location.href,
    }));
  } else {
    await page.evaluate(() => {
      document.getElementById('ytd-extension-download-host')
        ?.shadowRoot?.querySelector('button')?.click();
    });
    await sleep(2000);

    // Wait for metadata-rendered qualities
    let modal = null;
    for (let i = 0; i < 20; i += 1) {
      modal = await page.evaluate(() => {
        const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
        if (!root) return null;
        const qualities = [...root.querySelectorAll('.quality')].map((btn) => ({
          label: btn.querySelector('span')?.textContent || '',
          disabled: btn.disabled,
          detail: btn.querySelector('small')?.textContent || '',
        }));
        return {
          open: true,
          title: root.querySelector('.title')?.textContent || '',
          notice: root.querySelector('.notice')?.textContent || '',
          qualities,
        };
      });
      if (modal?.qualities?.some((q) => !q.disabled)) break;
      await sleep(500);
    }
    result.modal = modal;

    // Click best available / first enabled quality
    const clicked = await page.evaluate(() => {
      const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.quality') || [])].find((b) => !b.disabled);
      if (!btn) return false;
      btn.click();
      return btn.querySelector('span')?.textContent || true;
    });
    result.clickedQuality = clicked;

    // Wait for download begin/complete or error in modal
    let finalStatus = null;
    for (let i = 0; i < 40; i += 1) {
      finalStatus = await page.evaluate(() => {
        const root = document.getElementById('ytd-extension-modal-host')?.shadowRoot;
        return {
          state: root?.querySelector('.state')?.textContent || '',
          error: root?.querySelector('.error')?.textContent || '',
        };
      });
      if (downloads.some((d) => d.type === 'completed') || /Готово|Ошибка|отклон|403|SERVER/i.test(`${finalStatus.state} ${finalStatus.error}`)) {
        break;
      }
      await sleep(500);
    }
    result.finalStatus = finalStatus;
    result.downloads = downloads;
    await sleep(3000);
  }

  // SPA navigation test
  await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4000);
  result.spaButton = await page.evaluate(() => Boolean(document.getElementById('ytd-extension-download-host')));
  result.buttonCount = await page.evaluate(() => document.querySelectorAll('#ytd-extension-download-host').length);

  // Shorts
  await page.goto('https://www.youtube.com/shorts/jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
  await sleep(4000);
  result.shortsButton = await page.evaluate(() => Boolean(document.getElementById('ytd-extension-download-host')));

  // Service worker direct start download simulation via extension runtime is not accessible from page.
  // Probe SW by opening extension health through chrome-extension page if possible - skip.

} finally {
  await browser.disconnect().catch(() => undefined);
  chrome.kill();
}

const files = [];
for (const name of await fs.readdir(downloadDir).catch(() => [])) {
  const full = path.join(downloadDir, name);
  const stat = await fs.stat(full);
  const buf = Buffer.alloc(12);
  const fd = await fs.open(full, 'r');
  await fd.read(buf, 0, 12, 0);
  await fd.close();
  const ftyp = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  files.push({ name, size: stat.size, ftyp, isMp4Name: /\.mp4$/i.test(name) });
}
result.files = files;
console.log(JSON.stringify(result, null, 2));
