'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const BUILD_ROOT = path.join(SRC_TAURI, 'build');

const platform = (process.argv[2] || 'win').toLowerCase(); // win | android
const mode = (process.argv[3] || 'release').toLowerCase(); // debug | release

if (!['win', 'android'].includes(platform)) {
  console.error('Usage: node scripts/build.js <win|android> <debug|release>');
  process.exit(1);
}
if (!['debug', 'release'].includes(mode)) {
  console.error('Usage: node scripts/build.js <win|android> <debug|release>');
  process.exit(1);
}

const outDir = path.join(BUILD_ROOT, mode, platform);
fs.mkdirSync(outDir, { recursive: true });

function buildEnv() {
  const env = Object.assign({}, process.env);
  const userProfile = env.USERPROFILE || '';
  const localAppData = env.LOCALAPPDATA || '';
  const cargoBin = path.join(userProfile, '.cargo', 'bin');
  const jdkDir = 'C:\\Program Files\\Microsoft\\jdk-17.0.21.102-hotspot';
  const androidSdk = path.join(localAppData, 'Android', 'Sdk');
  const ndkDir = path.join(androidSdk, 'ndk', '27.2.12479018');

  if (!env.JAVA_HOME && fs.existsSync(jdkDir)) env.JAVA_HOME = jdkDir;
  if (!env.ANDROID_HOME && fs.existsSync(androidSdk)) env.ANDROID_HOME = androidSdk;
  if (!env.NDK_HOME && fs.existsSync(ndkDir)) env.NDK_HOME = ndkDir;

  const extraPaths = [cargoBin];
  if (env.JAVA_HOME) extraPaths.push(path.join(env.JAVA_HOME, 'bin'));
  env.PATH = extraPaths.join(path.delimiter) + path.delimiter + (env.PATH || env.Path || '');
  return env;
}

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: cwd || ROOT,
    stdio: 'inherit',
    shell: true,
    env: buildEnv(),
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

function copyFilesMatching(srcDir, ext, destDir) {
  if (!fs.existsSync(srcDir)) return [];
  const copied = [];
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const full = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyFilesMatching(full, ext, destDir));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
      const dest = path.join(destDir, entry.name);
      fs.copyFileSync(full, dest);
      copied.push(dest);
    }
  }
  return copied;
}

// Clean previous files in target output folder
for (const entry of fs.readdirSync(outDir)) {
  fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}

if (mode === 'debug') {
  run('node', [path.join('scripts', 'pack-debug-studio.js')]);
}

let produced = [];

if (platform === 'win') {
  if (mode === 'debug') {
    run('npx', ['tauri', 'build', '--debug', '--no-bundle']);
    const exe = path.join(SRC_TAURI, 'target', 'debug', 'openfishtools-standalone.exe');
    if (fs.existsSync(exe)) {
      const dest = path.join(outDir, path.basename(exe));
      fs.copyFileSync(exe, dest);
      produced.push(dest);
    }
  } else {
    run('npx', ['tauri', 'build']);
    const exe = path.join(SRC_TAURI, 'target', 'release', 'openfishtools-standalone.exe');
    if (fs.existsSync(exe)) {
      const dest = path.join(outDir, path.basename(exe));
      fs.copyFileSync(exe, dest);
      produced.push(dest);
    }
    const nsisDir = path.join(SRC_TAURI, 'target', 'release', 'bundle', 'nsis');
    produced.push(...copyFilesMatching(nsisDir, '.exe', outDir));
  }
} else if (platform === 'android') {
  const args = ['tauri', 'android', 'build', '--apk', '--target', 'aarch64'];
  if (mode === 'debug') {
    args.push('--debug');
  }
  run('npx', args);
  const apkRoot = path.join(SRC_TAURI, 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'universal', mode);
  const allApks = copyFilesMatching(apkRoot, '.apk', outDir);
  produced.push(...allApks);
}

console.log(`\n[build] Output placed in: ${outDir}`);
for (const f of produced) {
  const mb = (fs.statSync(f).size / (1024 * 1024)).toFixed(2);
  console.log(`  - ${path.basename(f)} (${mb} MB)`);
}
if (produced.length === 0) {
  console.error('[build] Warning: no output artifacts found.');
  process.exit(1);
}
