import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function addReference(target, value) {
  if (typeof value === 'string' && value.trim()) target.add(value.trim());
}

function addIconReferences(target, value) {
  if (typeof value === 'string') {
    addReference(target, value);
    return;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const iconPath of Object.values(value)) addReference(target, iconPath);
  }
}

export function collectManifestFiles(manifest) {
  const files = new Set(['manifest.json']);

  addReference(files, manifest?.background?.service_worker);
  addReference(files, manifest?.action?.default_popup);
  addReference(files, manifest?.side_panel?.default_path);
  addReference(files, manifest?.options_page);
  addReference(files, manifest?.options_ui?.page);
  addIconReferences(files, manifest?.icons);
  addIconReferences(files, manifest?.action?.default_icon);

  for (const entry of manifest?.content_scripts || []) {
    for (const file of entry?.js || []) addReference(files, file);
    for (const file of entry?.css || []) addReference(files, file);
  }

  for (const entry of manifest?.web_accessible_resources || []) {
    for (const file of entry?.resources || []) addReference(files, file);
  }

  return [...files].sort();
}

function resolveInside(root, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`Unsafe manifest path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe manifest path: ${relativePath}`);
  }
  return resolved;
}

export async function copyExtensionPackage(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  const manifestPath = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = collectManifestFiles(manifest);

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  for (const relativePath of files) {
    const sourcePath = resolveInside(source, relativePath);
    const destinationPath = resolveInside(destination, relativePath);
    try {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Manifest references missing file: ${relativePath}`);
      }
      throw error;
    }
  }

  return files;
}

async function main() {
  const destination = process.argv[2];
  if (!destination) {
    throw new Error('Usage: node scripts/package-extension.mjs <destination> [source-root]');
  }
  const source = process.argv[3] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const copied = await copyExtensionPackage(source, destination);
  console.log(`Packaged extension with ${copied.length} files.`);
  for (const file of copied) console.log(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
