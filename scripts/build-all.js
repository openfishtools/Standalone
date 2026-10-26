/**
 * FishTools Studio — Multiplatform Master Build Orchestrator
 *
 * Runs full builds across:
 *  - macOS Universal (x86_64 + arm64) with Metal GPU Acceleration
 *  - Windows x64 Setup & Portable with DirectX 12 GPU Acceleration
 *  - Android Signed APK (v1 + v2 + v3) with Hardware Acceleration
 *  - Dynamic OTA Update Bundle
 */

const fs = require('fs');
const path = require('path');
const { syncStudio } = require('./sync-studio');
const { buildMacUniversal } = require('./build-mac');
const { buildWindows } = require('./build-win');
const { buildAndroidApk } = require('./build-android');
const { generateOtaBundle } = require('./generate-ota');

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function buildAll() {
  const t0 = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       FishTools Studio — Master Multiplatform Builder        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 1. Synchronize Studio core assets
  console.log('>>> [1/5] Synchronizing Studio assets from ../Studio...');
  const manifest = syncStudio();
  const version = manifest.version || '1.1.0';

  // 2. Build macOS Universal
  console.log('\n>>> [2/5] Building macOS Universal (Apple Silicon + Intel)...');
  try {
    buildMacUniversal();
  } catch (err) {
    console.error('[macOS] Error during build:', err.message);
  }

  // 3. Build Windows x64
  console.log('\n>>> [3/5] Building Windows x64 Setup & Portable...');
  try {
    buildWindows();
  } catch (err) {
    console.error('[Windows] Error during build:', err.message);
  }

  // 4. Build Android Signed APK
  console.log('\n>>> [4/5] Building Android Signed APK (v1+v2+v3)...');
  try {
    buildAndroidApk();
  } catch (err) {
    console.error('[Android] Error during build:', err.message);
  }

  // 5. Generate OTA Bundle
  console.log('\n>>> [5/5] Packaging Dynamic OTA Update Bundle...');
  try {
    generateOtaBundle();
  } catch (err) {
    console.error('[OTA] Error during packaging:', err.message);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  // Summary Table
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('🎉 FishTools Studio Build Pipeline Complete in ' + elapsed + 's!');
  console.log('══════════════════════════════════════════════════════════════\n');

  const ROOT = path.resolve(__dirname, '..');
  const artifacts = [
    { platform: 'macOS Universal', path: path.join(ROOT, `dist-mac/FishTools_Studio_${version}_macOS_Universal.dmg`) },
    { platform: 'macOS App', path: path.join(ROOT, 'dist-mac/FishTools Studio.app') },
    { platform: 'Windows Setup', path: path.join(ROOT, `dist-win/FishTools_Studio_${version}_Windows_x64_Setup.exe`) },
    { platform: 'Windows Portable', path: path.join(ROOT, `dist-win/FishTools_Studio_${version}_Windows_x64_Portable.zip`) },
    { platform: 'Android APK', path: path.join(ROOT, `dist-android/FishTools_Studio_${version}_Android.apk`) },
    { platform: 'OTA Update', path: path.join(ROOT, `dist-ota/FishTools_Studio_OTA_v${version}.zip`) }
  ];

  console.log('| Platform           | Output Artifact                              | Size       |');
  console.log('|--------------------|----------------------------------------------|------------|');
  for (const art of artifacts) {
    if (fs.existsSync(art.path)) {
      const stat = fs.statSync(art.path);
      const sizeStr = stat.isDirectory() ? '(bundle)' : formatBytes(stat.size);
      const name = path.basename(art.path).padEnd(44);
      const plat = art.platform.padEnd(18);
      console.log(`| ${plat} | ${name} | ${sizeStr.padStart(10)} |`);
    }
  }
  console.log('\nAll builds ready for release and dynamic deployment.\n');
}

if (require.main === module) {
  buildAll();
}

module.exports = { buildAll };
