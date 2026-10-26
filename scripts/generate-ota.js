/**
 * FishTools Studio — Dynamic OTA Update Packager
 *
 * Packages the latest synchronized Studio assets into an OTA distribution bundle
 * (`dist-ota/studio-ota-v<version>.zip`) and generates `version.json` with SHA-256
 * checksums for dynamic live updates.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { syncStudio } = require('./sync-studio');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'dist-ota');
const STAGING_DIR = path.join(ROOT_DIR, 'src/assets/studio');

function generateOtaBundle() {
  const t0 = Date.now();
  console.log('====================================================');
  console.log('🐟 Generating FishTools Studio Dynamic OTA Bundle');
  console.log('====================================================');

  const manifest = syncStudio();
  const version = manifest.version || '1.1.0';
  const studioVersion = manifest.studioVersion || '0.6.5';

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const zipName = `FishTools_Studio_OTA_v${version}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);

  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  // Create zip of src/assets/studio
  console.log(`[OTA] Compressing Studio assets into ${zipName}...`);
  execSync(`cd "${STAGING_DIR}" && zip -rq "${zipPath}" . -x "*.DS_Store"`, { stdio: 'inherit' });

  // Calculate bundle hash
  const zipBuf = fs.readFileSync(zipPath);
  const zipSha256 = crypto.createHash('sha256').update(zipBuf).digest('hex');

  // Generate update release version.json
  const releaseInfo = {
    name: 'FishTools Studio',
    version: version,
    studioVersion: studioVersion,
    timestamp: Date.now(),
    releasedAt: new Date().toISOString(),
    bundleFileName: zipName,
    bundleSize: zipBuf.length,
    sha256: zipSha256,
    downloadUrl: `https://studio.cutefish.my.id/updates/${zipName}`,
    changelog: `FishTools Studio v${version} (Engine v${studioVersion}) with full GPU acceleration & real-time WebCodecs.`
  };

  const releaseJsonPath = path.join(OUT_DIR, 'version.json');
  fs.writeFileSync(releaseJsonPath, JSON.stringify(releaseInfo, null, 2), 'utf8');

  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[OTA] Bundle successfully packaged in ${dt}s!`);
  console.log(` -> OTA Zip: ${zipPath} (${(zipBuf.length / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(` -> SHA-256: ${zipSha256}`);
  console.log(` -> Metadata: ${releaseJsonPath}`);
}

if (require.main === module) {
  generateOtaBundle();
}

module.exports = { generateOtaBundle };
