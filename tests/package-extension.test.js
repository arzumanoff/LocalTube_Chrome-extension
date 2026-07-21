import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyExtensionPackage } from '../scripts/package-extension.mjs';

test('packages every file referenced by manifest.json', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extension-package-source-'));
  const destination = await mkdtemp(path.join(os.tmpdir(), 'extension-package-destination-'));

  await mkdir(path.join(root, 'src', 'core'), { recursive: true });
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    background: { service_worker: 'src/background.js' },
    content_scripts: [{
      matches: ['https://example.com/*'],
      js: ['src/core/filename.js', 'src/content.js'],
    }],
  }), 'utf8');
  await writeFile(path.join(root, 'src', 'background.js'), 'void 0;\n', 'utf8');
  await writeFile(path.join(root, 'src', 'content.js'), 'void 0;\n', 'utf8');
  await writeFile(path.join(root, 'src', 'core', 'filename.js'), 'void 0;\n', 'utf8');

  const copied = await copyExtensionPackage(root, destination);

  assert.deepEqual(copied, [
    'manifest.json',
    'src/background.js',
    'src/content.js',
    'src/core/filename.js',
  ]);
  assert.equal(await readFile(path.join(destination, 'src', 'core', 'filename.js'), 'utf8'), 'void 0;\n');
});

test('fails instead of producing an incomplete extension package', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extension-package-source-'));
  const destination = await mkdtemp(path.join(os.tmpdir(), 'extension-package-destination-'));

  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    content_scripts: [{
      matches: ['https://example.com/*'],
      js: ['src/core/filename.js'],
    }],
  }), 'utf8');

  await assert.rejects(
    copyExtensionPackage(root, destination),
    /Manifest references missing file: src\/core\/filename\.js/,
  );
});
