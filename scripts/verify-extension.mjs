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
assert(manifest.background?.service_worker === 'src/native-background.js', 'native background service worker is required');
assert(manifest.permissions?.includes('nativeMessaging'), 'nativeMessaging permission is required');
assert(manifest.permissions?.includes('storage'), 'storage permission is required');
assert(!manifest.permissions?.includes('downloads'), 'downloads permission must not be used by the native-engine UI');
assert(!manifest.permissions?.includes('webRequest'), 'webRequest permission must not be used by the native-engine UI');
assert(!manifest.permissions?.includes('offscreen'), 'offscreen permission must not be used by the native-engine UI');
assert(typeof manifest.key === 'string' && manifest.key.length > 100, 'a stable extension key is required');
assert(!JSON.stringify(manifest).includes('http://'), 'manifest must not grant insecure HTTP origins');
assert(!JSON.stringify(manifest).includes('googlevideo.com'), 'the extension must not download googlevideo URLs directly');

const referenced = new Set([
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((entry) => entry.js || []),
  ...Object.values(manifest.icons || {}),
  'native-host/bootstrap.py',
  'native-host/host.py',
  'native-host/engine.py',
  'native-host/protocol.py',
  'native-host/install_host.ps1',
  'native-host/uninstall_host.ps1',
  'native-host/build_host.ps1',
  'native-host/native-host-manifest.template.json',
  'native-host/requirements.txt',
]);

for (const relative of referenced) {
  const absolute = path.join(root, relative);
  await access(absolute, constants.R_OK);
  if (relative.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    assert(result.status === 0, `${relative} failed syntax check:\n${result.stderr}`);
  }
}

const nativeCore = await readFile(path.join(root, 'src/core/native.js'), 'utf8');
assert(nativeCore.includes("com.arzumanoff.media_engine"), 'native host identifier must be stable and neutral');

console.log(`Verified native-engine Manifest V3 extension with ${referenced.size} referenced files.`);
