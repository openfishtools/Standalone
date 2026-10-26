/**
 * Studio Synchronization & Manifest Generator
 *
 * Synchronizes production assets from `../Studio` into the Standalone project
 * across macOS, Windows, and Android staging bundles, and calculates SHA-256
 * integrity hashes for dynamic OTA verification.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const CANDIDATE_STUDIO_DIRS = [
  process.env.STUDIO_DIR,
  path.resolve(ROOT_DIR, '../Studio'),
  path.resolve(ROOT_DIR, '.cache/Studio')
].filter(Boolean);
const STUDIO_SRC_DIR = CANDIDATE_STUDIO_DIRS.find(d => fs.existsSync(d)) || path.resolve(ROOT_DIR, '../Studio');
const ASSETS_STAGING_DIR = path.join(ROOT_DIR, 'src/assets/studio');

// Target directories for native embedding
const PLATFORM_TARGETS = [
  path.join(ROOT_DIR, 'src/assets/studio'),
  path.join(ROOT_DIR, 'android/app/src/main/assets/studio'),
  path.join(ROOT_DIR, 'macos/FishToolsStudio/studio'),
  path.join(ROOT_DIR, 'windows/FishToolsStudio/studio')
];

// Folders & files to sync from Studio
const SYNC_INCLUDES = [
  'index.html',
  'desktop.html',
  'editor.html',
  'privacy.html',
  'terms.html',
  'version.json',
  'manifest.webmanifest',
  'js',
  'css',
  'assets',
  'effects',
  'fticons',
  'vendor'
];

// Exclude developer / testing files
const IGNORE_PATTERNS = [
  '.DS_Store',
  'node_modules',
  'tests',
  'cloudflared',
  '.git',
  '.github',
  '.agents',
  '.clinerules',
  '.cursor',
  '.windsurf'
];

function shouldIgnore(name) {
  return IGNORE_PATTERNS.some(pat => name === pat || name.startsWith(pat + '/'));
}

function copyRecursive(src, dest, hashes = {}) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      if (shouldIgnore(entry)) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry), hashes);
    }
  } else {
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    const content = fs.readFileSync(src);
    fs.writeFileSync(dest, content);

    // Compute relative path and hash for manifest
    const rel = path.relative(ASSETS_STAGING_DIR, dest).replace(/\\/g, '/');
    if (!rel.startsWith('..')) {
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      hashes[rel] = { size: content.length, sha256: hash };
    }
  }
}

function syncStudio() {
  console.log(`[Sync] Starting synchronization from Studio: ${STUDIO_SRC_DIR}`);

  if (!fs.existsSync(STUDIO_SRC_DIR)) {
    console.error(`[Sync] Error: Studio directory not found at ${STUDIO_SRC_DIR}`);
    process.exit(1);
  }

  // Read Package appVersion & Studio version
  let appVersion = '1.1.0';
  const pkgFile = path.join(ROOT_DIR, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.version) appVersion = pkg.version;
    } catch (e) {}
  }

  let studioVersion = '0.6.5';
  const versionFile = path.join(STUDIO_SRC_DIR, 'version.json');
  if (fs.existsSync(versionFile)) {
    try {
      const vData = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      studioVersion = vData.version || studioVersion;
    } catch (e) {}
  }
  console.log(`[Sync] App Version: v${appVersion} | Studio Engine Version: v${studioVersion}`);

  // Clean staging
  if (fs.existsSync(ASSETS_STAGING_DIR)) {
    fs.rmSync(ASSETS_STAGING_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(ASSETS_STAGING_DIR, { recursive: true });

  const manifestFiles = {};

  // Copy selected files to staging
  for (const item of SYNC_INCLUDES) {
    const srcPath = path.join(STUDIO_SRC_DIR, item);
    const destPath = path.join(ASSETS_STAGING_DIR, item);
    if (fs.existsSync(srcPath)) {
      copyRecursive(srcPath, destPath, manifestFiles);
    }
  }

  // Create manifest.json with hashes
  const manifest = {
    name: 'FishTools Studio',
    version: appVersion,
    studioVersion: studioVersion,
    timestamp: Date.now(),
    generatedAt: new Date().toISOString(),
    files: manifestFiles
  };

  const manifestPath = path.join(ASSETS_STAGING_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Also write shell/manifest.json for offline loaders
  const shellManifestPath = path.join(ROOT_DIR, 'shell/manifest.json');
  fs.mkdirSync(path.dirname(shellManifestPath), { recursive: true });
  fs.writeFileSync(shellManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[Sync] Manifest generated with ${Object.keys(manifestFiles).length} files.`);

  // Mirror to platform targets
  for (const targetDir of PLATFORM_TARGETS) {
    if (targetDir === ASSETS_STAGING_DIR) continue;
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(targetDir, { recursive: true });
      copyRecursive(ASSETS_STAGING_DIR, targetDir);
      console.log(`[Sync] Mirrored to platform target: ${path.relative(ROOT_DIR, targetDir)}`);
    } catch (err) {
      console.warn(`[Sync] Notice: Platform target ${path.relative(ROOT_DIR, targetDir)} skipped (${err.message})`);
    }
  }

  console.log(`[Sync] Successfully synchronized Studio v${appVersion} assets.`);
  return manifest;
}

if (require.main === module) {
  syncStudio();
}

module.exports = { syncStudio };
