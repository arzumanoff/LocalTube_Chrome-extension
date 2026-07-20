import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = process.env.YTD_EXT_PATH ||
  'C:\\Users\\Amer\\AppData\\Local\\Temp\\opencode\\ytd-ext';
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytd-inner-'));
const downloadDir = path.join(profileDir, 'downloads');
await fs.mkdir(downloadDir, { recursive: true });
const videoId = process.argv[2] || 'jNQXAC9IVRw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  defaultViewport: null,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
  ],
});

const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await sleep(3000);
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (v) { v.muted = true; v.play().catch(() => undefined); }
});
await sleep(3000);

const result = await page.evaluate(async (vid) => {
  function cfg(key) {
    try {
      return window.ytcfg?.get?.(key) || window.ytcfg?.data_?.[key] || null;
    } catch { return null; }
  }

  const apiKey = cfg('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const visitorData = cfg('VISITOR_DATA') || '';
  const contextBase = cfg('INNERTUBE_CONTEXT') || {};
  const clients = [
    {
      name: 'WEB',
      client: {
        clientName: 'WEB',
        clientVersion: contextBase?.client?.clientVersion || '2.20260701.00.00',
        hl: 'en',
        gl: 'US',
        visitorData,
      },
    },
    {
      name: 'ANDROID',
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 30,
        hl: 'en',
        gl: 'US',
        visitorData,
      },
    },
    {
      name: 'IOS',
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceModel: 'iPhone16,2',
        hl: 'en',
        gl: 'US',
        visitorData,
      },
    },
    {
      name: 'TVHTML5',
      client: {
        clientName: 'TVHTML5',
        clientVersion: '7.20260701.16.00',
        hl: 'en',
        gl: 'US',
        visitorData,
      },
    },
    {
      name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      client: {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        hl: 'en',
        gl: 'US',
        visitorData,
      },
    },
    {
      name: 'MWEB',
      client: {
        clientName: 'MWEB',
        clientVersion: '2.20260701.00.00',
        hl: 'en',
        gl: 'US',
        visitorData,
      },
    },
  ];

  function summarize(url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        itag: u.searchParams.get('itag'),
        hasN: u.searchParams.has('n'),
        nLen: (u.searchParams.get('n') || '').length,
        hasPot: u.searchParams.has('pot'),
        hasSig: u.searchParams.has('sig') || u.searchParams.has('lsig'),
        c: u.searchParams.get('c'),
      };
    } catch { return null; }
  }

  async function probe(url) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-2047' },
        credentials: 'include',
        cache: 'no-store',
        referrer: 'https://www.youtube.com/',
      });
      const buf = new Uint8Array(await response.arrayBuffer());
      const ftyp = buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
      const head = new TextDecoder().decode(buf.slice(0, Math.min(40, buf.length)));
      return {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        bytes: buf.length,
        ftyp,
        textHead: /^[\x09\x0a\x0d\x20-\x7e]+$/.test(head) ? head : null,
      };
    } catch (error) {
      return { error: String(error.message || error) };
    }
  }

  function pickProgressive(formats) {
    return (formats || []).filter((f) => {
      const mime = String(f.mimeType || '');
      return f.url && mime.includes('avc1') && mime.includes('mp4a');
    }).sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
  }

  const out = {
    apiKeyPresent: Boolean(apiKey),
    visitorDataPresent: Boolean(visitorData),
    button: Boolean(document.getElementById('ytd-extension-download-host')),
    clients: [],
  };

  for (const entry of clients) {
    const body = {
      context: {
        client: entry.client,
      },
      videoId: vid,
      contentCheckOk: true,
      racyCheckOk: true,
    };
    if (entry.name === 'TVHTML5_SIMPLY_EMBEDDED_PLAYER') {
      body.context.thirdParty = { embedUrl: 'https://www.youtube.com/' };
    }

    let json = null;
    let httpStatus = 0;
    try {
      const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-youtube-client-name': String(entry.client.clientName === 'WEB' ? '1' : entry.client.clientName === 'ANDROID' ? '3' : entry.client.clientName === 'IOS' ? '5' : entry.client.clientName === 'MWEB' ? '2' : '7'),
          'x-youtube-client-version': entry.client.clientVersion,
        },
        body: JSON.stringify(body),
        credentials: 'include',
      });
      httpStatus = response.status;
      json = await response.json();
    } catch (error) {
      out.clients.push({ name: entry.name, error: String(error.message || error) });
      continue;
    }

    const formats = json?.streamingData?.formats || [];
    const progressive = pickProgressive(formats);
    const clientResult = {
      name: entry.name,
      httpStatus,
      playability: json?.playabilityStatus?.status || null,
      reason: json?.playabilityStatus?.reason || null,
      formatCount: formats.length,
      progressiveCount: progressive.length,
      progressive: progressive.slice(0, 3).map((f) => ({
        itag: f.itag,
        height: f.height,
        qualityLabel: f.qualityLabel,
        mimeType: f.mimeType,
        contentLength: f.contentLength || null,
        urlSummary: summarize(f.url),
      })),
      probes: [],
    };

    for (const format of progressive.slice(0, 2)) {
      const p = await probe(format.url);
      clientResult.probes.push({
        itag: format.itag,
        height: format.height,
        ...p,
        urlSummary: summarize(format.url),
      });
      if ((p.status === 200 || p.status === 206) && p.ftyp) {
        clientResult.working = {
          itag: format.itag,
          height: format.height,
          contentLength: format.contentLength || null,
        };
        // download full small file if content-length small or just first success full fetch
        try {
          const full = await fetch(format.url, { credentials: 'include', cache: 'no-store', referrer: 'https://www.youtube.com/' });
          const blob = await full.blob();
          const buf = new Uint8Array(await blob.arrayBuffer());
          const ftyp = buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
          clientResult.fullDownload = {
            status: full.status,
            size: buf.length,
            ftyp,
            contentType: full.headers.get('content-type') || blob.type || '',
          };
          if (ftyp && buf.length > 1000) {
            const objectUrl = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = `${vid}-${entry.name}-${format.itag}.mp4`;
            document.body.append(a);
            a.click();
            a.remove();
            clientResult.triggeredSave = true;
          }
        } catch (error) {
          clientResult.fullDownloadError = String(error.message || error);
        }
        break;
      }
    }

    out.clients.push(clientResult);
  }

  // Also try current player response progressive
  try {
    const player = document.querySelector('#movie_player');
    const pr = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    const formats = pr?.streamingData?.formats || [];
    const progressive = pickProgressive(formats);
    const local = {
      name: 'PLAYER_RESPONSE',
      formatCount: formats.length,
      progressiveCount: progressive.length,
      probes: [],
    };
    for (const format of progressive.slice(0, 2)) {
      local.probes.push({ itag: format.itag, height: format.height, ...(await probe(format.url)) });
    }
    out.clients.unshift(local);
  } catch { /* ignore */ }

  return out;
}, videoId);

await sleep(10000);
const files = await fs.readdir(downloadDir).catch(() => []);
const downloadedFiles = [];
for (const name of files) {
  const stat = await fs.stat(path.join(downloadDir, name));
  downloadedFiles.push({ name, size: stat.size });
}

const targets = browser.targets().map((t) => ({ type: t.type(), url: t.url().slice(0, 120) }));
await browser.close();

console.log(JSON.stringify({
  videoId,
  extensionDetected: targets.some((t) => t.url.startsWith('chrome-extension://')),
  targets,
  downloadedFiles,
  result,
}, null, 2));
