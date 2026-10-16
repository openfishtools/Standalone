const fs = require('fs');
const path = require('path');

const STANDALONE_ROOT = path.resolve(__dirname, '..');
const OUTPUT_MANIFEST = path.resolve(STANDALONE_ROOT, 'shell/manifest.json');
const STAGED_STUDIO_DIR = path.resolve(STANDALONE_ROOT, 'shell/studio');

function generateManifest() {
  let version = '1.0.3';
  const pkgPath = path.join(STANDALONE_ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && pkg.version) version = pkg.version;
  }
  if (process.env.APP_VERSION) {
    version = String(process.env.APP_VERSION).replace(/^v/i, '').trim() || version;
  }

  // Remove any legacy local staged studio directory so app always uses https://studio.cutefish.my.id with Service Worker offline cache
  if (fs.existsSync(STAGED_STUDIO_DIR)) {
    fs.rmSync(STAGED_STUDIO_DIR, { recursive: true, force: true });
  }

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    remoteOrigin: 'https://studio.cutefish.my.id',
    offlineMode: 'service-worker-persistent-cache'
  };

  fs.mkdirSync(path.dirname(OUTPUT_MANIFEST), { recursive: true });
  fs.writeFileSync(OUTPUT_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[Manifest] v${version} | Direct Remote + Offline ServiceWorker (${manifest.remoteOrigin})`);
  return manifest;
}

if (require.main === module) {
  generateManifest();
}

module.exports = { generateManifest };
