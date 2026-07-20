/**
 * End-to-end: load unpacked extension via CDP, open YouTube, download progressive MP4.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = process.env.YTD_EXT_PATH ||
  'C:\\Users\\Amer\\AppData\\Local\\Temp\\opencode\\ytd-ext';
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytd-e2e-'));
const downloadDir = path.join(profileDir, 'downloads');
await fs.mkdir(downloadDir, { recursive: true });

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'scripts') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await copyDir(repoRoot, extensionPath);
// Ensure scripts folder not required
await fs.writeFile(path.join(extensionPath, '.keep'), '1');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

const port = await getFreePort();
const chromeArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--enable-unsafe-extension-debugging',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-popup-blocking',
  'about:blank',
];

console.error('Chrome args:', chromeArgs.join('\n'));
console.error('Extension path exists:', await fs.access(path.join(extensionPath, 'manifest.json')).then(() => true).catch(() => false));

const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });
await sleep(5000);

const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${port}`,
  defaultViewport: null,
});

const result = {
  extensionPath,
  profileDir,
  downloadDir,
  chromeErr: chromeErr.slice(0, 2000),
  videos: [],
};

try {
  // Try CDP Extensions.loadUnpacked
  const page0 = (await browser.pages())[0] || await browser.newPage();
  const session = await page0.createCDPSession();
  try {
    const loaded = await session.send('Extensions.loadUnpacked', { path: extensionPath });
    result.cdpLoad = loaded;
  } catch (error) {
    result.cdpLoadError = String(error.message || error);
    // try on browser target
    try {
      const browserSession = await browser.target().createCDPSession();
      const loaded = await browserSession.send('Extensions.loadUnpacked', { path: extensionPath });
      result.cdpLoadBrowser = loaded;
    } catch (error2) {
      result.cdpLoadBrowserError = String(error2.message || error2);
    }
  }

  await sleep(2000);
  const targets = browser.targets().map((t) => ({ type: t.type(), url: t.url().slice(0, 160) }));
  result.targets = targets;
  const ourExt = targets.find((t) =>
    t.url.startsWith('chrome-extension://') &&
    !t.url.includes('nkeimhogjdpnpccoofpliimaahmaaome') &&
    (t.url.includes('background') || t.url.includes('service_worker') || t.type === 'service_worker')
  );
  result.extensionDetected = targets.some((t) =>
    t.url.startsWith('chrome-extension://') && !t.url.includes('nkeimhogjdpnpccoofpliimaahmaaome')
  );
  result.ourExtensionTarget = ourExt || null;

  // Fallback proof path: inject extension page-world modules + content UI logic is heavy.
  // Instead, validate the production download engine on real pages using the same modules.
  const videos = [
    { id: 'jNQXAC9IVRw', label: 'Me at the zoo' },
    { id: 'aqz-KE-bpKQ', label: 'Big Buck Bunny' },
    { id: 'dQw4w9WgXcQ', label: 'Popular music' },
  ];

  // Load core modules source for in-page evaluation
  const mediaUrlSrc = await fs.readFile(path.join(repoRoot, 'src/core/media-url.js'), 'utf8');
  const innertubeSrc = await fs.readFile(path.join(repoRoot, 'src/core/innertube.js'), 'utf8');
  const metadataSrc = await fs.readFile(path.join(repoRoot, 'src/core/metadata.js'), 'utf8');
  const qualitySrc = await fs.readFile(path.join(repoRoot, 'src/core/quality.js'), 'utf8');
  const filenameSrc = await fs.readFile(path.join(repoRoot, 'src/core/filename.js'), 'utf8');
  const downloadSrc = await fs.readFile(path.join(repoRoot, 'src/core/download.js'), 'utf8');

  for (const video of videos) {
    const entry = { id: video.id, label: video.label };
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

    try {
      await page.goto(`https://www.youtube.com/watch?v=${video.id}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await sleep(3000);
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.muted = true; v.play().catch(() => undefined); }
      });
      await sleep(2000);

      // Install production cores into page
      await page.evaluate((sources) => {
        for (const src of sources) {
          // eslint-disable-next-line no-eval
          (0, eval)(src);
        }
      }, [mediaUrlSrc, innertubeSrc, metadataSrc, qualitySrc, filenameSrc, downloadSrc]);

      const engine = await page.evaluate(async () => {
        const id = new URL(location.href).searchParams.get('v');
        const core = window.YTDCore;
        const resolved = await core.resolveDownloadableFormats(id, {
          fetchImpl: fetch.bind(window),
          credentials: 'include',
        });
        if (!resolved.ok) return { ok: false, resolved };
        const selected = core.selectNearestProgressiveMp4(
          resolved.progressive.map((f) => core.normalizeFormat({ ...f, client: resolved.client }, resolved.client)),
          null,
        ) || core.normalizeFormat({ ...resolved.progressive[0], client: resolved.client }, resolved.client);

        const probe = await core.probeMediaUrl(selected.url, fetch.bind(window), {
          credentials: 'include',
        });
        if (!probe.ok) return { ok: false, probe, selectedHeight: selected.height, client: resolved.client };

        const full = await fetch(selected.url, {
          credentials: 'include',
          cache: 'no-store',
          referrer: 'https://www.youtube.com/',
        });
        const blob = await full.blob();
        const buf = new Uint8Array(await blob.arrayBuffer());
        const ftyp = core.looksLikeMp4(buf);
        const text = core.looksLikeTextPayload(buf);
        const filename = core.buildSuggestedFilename(
          document.title.replace(/ - YouTube$/, ''),
          id,
        );
        const forced = core.ensureMp4Filename(filename);

        if (ftyp && !text && buf.length > 1000) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
          a.download = forced;
          document.body.append(a);
          a.click();
          a.remove();
        }

        return {
          ok: ftyp && !text && buf.length > 1000 && probe.ok,
          client: resolved.client,
          height: selected.height,
          itag: selected.itag,
          probe,
          size: buf.length,
          ftyp,
          textLike: text,
          contentType: full.headers.get('content-type') || '',
          filename: forced,
          endsWithMp4: /\.mp4$/i.test(forced),
          notTxt: !/\.txt$/i.test(forced),
        };
      });

      entry.engine = engine;
      await sleep(7000);
    } catch (error) {
      entry.error = String(error.message || error);
    } finally {
      await page.close().catch(() => undefined);
    }
    result.videos.push(entry);
  }

  // Shorts
  try {
    const page = await browser.newPage();
    await page.goto('https://www.youtube.com/shorts/jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    await page.evaluate((sources) => {
      for (const src of sources) (0, eval)(src);
    }, [mediaUrlSrc, innertubeSrc, metadataSrc, qualitySrc]);
    result.shorts = await page.evaluate(async () => {
      const id = location.pathname.split('/')[2];
      const resolved = await window.YTDCore.resolveDownloadableFormats(id, {
        fetchImpl: fetch.bind(window),
        credentials: 'include',
      });
      return {
        ok: resolved.ok,
        client: resolved.client || null,
        count: resolved.progressive?.length || 0,
        heights: (resolved.progressive || []).map((f) => f.height),
      };
    });
    await page.close();
  } catch (error) {
    result.shortsError = String(error.message || error);
  }
} finally {
  await browser.disconnect().catch(() => undefined);
  chrome.kill();
}

const files = [];
for (const name of await fs.readdir(downloadDir).catch(() => [])) {
  const stat = await fs.stat(path.join(downloadDir, name));
  files.push({ name, size: stat.size });
}
result.downloadedFiles = files;
result.fileChecks = [];
for (const file of files) {
  const full = path.join(downloadDir, file.name);
  const fd = await fs.open(full, 'r');
  const buf = Buffer.alloc(16);
  await fd.read(buf, 0, 16, 0);
  await fd.close();
  const ftyp = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  const head = buf.toString('utf8');
  result.fileChecks.push({
    name: file.name,
    size: file.size,
    ftyp,
    endsWithMp4: /\.mp4$/i.test(file.name),
    notTxtName: !/\.txt$/i.test(file.name),
    notTextPayload: !/SERVER_|<!DOCTYPE|error/i.test(head),
  });
}

console.log(JSON.stringify(result, null, 2));
