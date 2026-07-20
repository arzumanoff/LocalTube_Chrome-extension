import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manifest.manifest_version === 3, 'manifest_version must be 3');
assert(manifest.background?.service_worker, 'background service worker is required');
assert(manifest.permissions?.includes('downloads'), 'downloads permission is required');
assert(manifest.permissions?.includes('storage'), 'storage permission is required');
assert(manifest.permissions?.includes('webRequest'), 'webRequest permission is required for playback token capture');
assert(!JSON.stringify(manifest).includes('http://'), 'manifest must not grant insecure HTTP origins');

const referenced = new Set([
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((entry) => entry.js || []),
  ...manifest.web_accessible_resources.flatMap((entry) => entry.resources || []),
  ...Object.values(manifest.icons || {}),
  'src/core/media-url.js',
  'src/core/download.js',
  'src/core/innertube.js',
  'src/core/metadata.js',
  'src/core/metadata-wait.js',
  'src/core/messages.js',
  'src/core/jobs.js',
]);

for (const relative of referenced) {
  const absolute = path.join(root, relative);
  await access(absolute, constants.R_OK);
  if (relative.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    assert(result.status === 0, `${relative} failed syntax check:\n${result.stderr}`);
  }
}

console.log(`Verified Manifest V3 extension with ${referenced.size} referenced files.`);
