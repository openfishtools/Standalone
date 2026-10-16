const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const STANDALONE_ROOT = path.resolve(__dirname, '..');
const LOCAL_STUDIO = path.resolve(STANDALONE_ROOT, '../Studio');
const CACHED_STUDIO = path.resolve(STANDALONE_ROOT, '.cache/Studio');
const OUTPUT_MANIFEST = path.resolve(STANDALONE_ROOT, 'shell/manifest.json');

const INCLUDE_DIRS = [
  'assets',
  'css',
  'effects',
  'element',
  'fticons',
  'js',
  'shapes',
  'text',
  'vendor'
];

const INCLUDE_ROOT_FILES = [
  'version.json',
  'index.html',
  'desktop.html',
  'editor.html',
  'privacy.html',
  'terms.html',
  'manifest.webmanifest'
];

const CRITICAL_ENGINE_FILES = new Set([
  'js/fishtool-engine.js',
  'js/FishExport-Enggine.js',
  'js/motion-blur-engine.js',
  'js/text-engine.js',
  'js/video-decoder-worker.js',
  'effects/effects.wasm',
  'effects/loader.js',
  'effects/manifest.json'
]);

function resolveStudioDir() {
  if (fs.existsSync(path.join(LOCAL_STUDIO, 'index.html'))) {
    return LOCAL_STUDIO;
  }
  if (!fs.existsSync(path.join(CACHED_STUDIO, 'index.html'))) {
    fs.mkdirSync(path.dirname(CACHED_STUDIO), { recursive: true });
    execSync(`git clone --depth 1 https://github.com/openfishtools/Studio.git "${CACHED_STUDIO}"`, {
      stdio: 'inherit'
    });
  }
  return CACHED_STUDIO;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkDir(dirPath, relPrefix, outList) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dirPath, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkDir(abs, rel, outList);
    } else if (entry.isFile()) {
      const stat = fs.statSync(abs);
      outList.push({
        path: rel,
        size: stat.size,
        sha256: sha256File(abs),
        criticalEngine: CRITICAL_ENGINE_FILES.has(rel)
      });
    }
  }
}

function generateManifest() {
  const studioRoot = resolveStudioDir();

  let version = '1.0.0';
  const pkgPath = path.join(STANDALONE_ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && pkg.version) version = pkg.version;
  }
  const versionPath = path.join(studioRoot, 'version.json');
  if (fs.existsSync(versionPath)) {
    const parsed = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    if (parsed && parsed.version) version = parsed.version;
  }
  if (process.env.APP_VERSION) {
    version = String(process.env.APP_VERSION).replace(/^v/i, '').trim() || version;
  }

  const files = [];

  for (const rootFile of INCLUDE_ROOT_FILES) {
    const abs = path.join(studioRoot, rootFile);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const stat = fs.statSync(abs);
      files.push({
        path: rootFile,
        size: stat.size,
        sha256: sha256File(abs),
        criticalEngine: CRITICAL_ENGINE_FILES.has(rootFile)
      });
    }
  }

  for (const dir of INCLUDE_DIRS) {
    walkDir(path.join(studioRoot, dir), dir, files);
  }

  const engineSignature = crypto
    .createHash('sha256')
    .update(
      files
        .filter((f) => f.criticalEngine)
        .map((f) => `${f.path}:${f.sha256}`)
        .sort()
        .join('|')
    )
    .digest('hex');

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    engineSignature,
    totalFiles: files.length,
    totalBytes: files.reduce((acc, item) => acc + item.size, 0),
    files
  };

  fs.mkdirSync(path.dirname(OUTPUT_MANIFEST), { recursive: true });
  fs.writeFileSync(OUTPUT_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');

  const stagedStudioDir = path.resolve(STANDALONE_ROOT, 'shell/studio');
  for (const item of files) {
    const srcFile = path.join(studioRoot, item.path);
    const dstFile = path.join(stagedStudioDir, item.path);
    fs.mkdirSync(path.dirname(dstFile), { recursive: true });
    fs.copyFileSync(srcFile, dstFile);
  }

  // Ensure version.json in staged copy matches build version
  fs.writeFileSync(
    path.join(stagedStudioDir, 'version.json'),
    JSON.stringify({ version }, null, 2) + '\n',
    'utf8'
  );

  // Normalize fticons.woff2 path for file:// protocol
  const stagedFticonsCss = path.join(stagedStudioDir, 'fticons/fticons.css');
  const stagedFticonsWoff2 = path.join(stagedStudioDir, 'fticons/fticons.woff2');
  if (fs.existsSync(stagedFticonsCss) && fs.existsSync(stagedFticonsWoff2)) {
    const woff2Base64 = fs.readFileSync(stagedFticonsWoff2).toString('base64');
    const cssRaw = fs.readFileSync(stagedFticonsCss, 'utf8');
    const patchedCss = cssRaw.replace(
      /url\("\.\/\/fticons\.woff2[^"]*"\)\s*format\("woff2"\)/g,
      `url("data:font/woff2;base64,${woff2Base64}") format("woff2"), url("./fticons.woff2") format("woff2")`
    );
    fs.writeFileSync(stagedFticonsCss, patchedCss, 'utf8');
  }

  // Apply standalone WebGL & memory cache settings on staged copy
  const stagedEngineJs = path.join(stagedStudioDir, 'js/fishtool-engine.js');
  if (fs.existsSync(stagedEngineJs)) {
    let engCode = fs.readFileSync(stagedEngineJs, 'utf8');
    engCode = engCode.replace(
      `antialias: true,\n          preserveDrawingBuffer: true,\n          powerPreference: 'high-performance'`,
      `antialias: false,\n          preserveDrawingBuffer: false,\n          desynchronized: true,\n          powerPreference: 'high-performance'`
    );
    engCode = engCode.replace(`const N = 10;`, `const N = 4;`);
    fs.writeFileSync(stagedEngineJs, engCode, 'utf8');
  }

  const stagedPreviewCacheJs = path.join(stagedStudioDir, 'js/preview-cache.js');
  if (fs.existsSync(stagedPreviewCacheJs)) {
    let pcCode = fs.readFileSync(stagedPreviewCacheJs, 'utf8');
    pcCode = pcCode.replace(
      /const devMem = \(typeof navigator !== 'undefined' && navigator\.deviceMemory\) \? navigator\.deviceMemory : 4;/g,
      `const devMem = 16;`
    );
    pcCode = pcCode.replace(
      `this.maxFrames = isMobile ? 180 : (devMem <= 2 ? 150 : (devMem <= 4 ? 300 : 600));`,
      `this.maxFrames = 2400;`
    );
    fs.writeFileSync(stagedPreviewCacheJs, pcCode, 'utf8');
  }

  const stagedVsmJs = path.join(stagedStudioDir, 'js/video-stream-manager.js');
  if (fs.existsSync(stagedVsmJs)) {
    let vsmCode = fs.readFileSync(stagedVsmJs, 'utf8');
    vsmCode = vsmCode.replace(`this.maxCacheSize = 180;`, `this.maxCacheSize = 900;`);
    fs.writeFileSync(stagedVsmJs, vsmCode, 'utf8');
  }

  const stagedFeJs = path.join(stagedStudioDir, 'js/frame-extractor.js');
  if (fs.existsSync(stagedFeJs)) {
    let feCode = fs.readFileSync(stagedFeJs, 'utf8');
    feCode = feCode.replace(`this.maxRamFrames = 600;`, `this.maxRamFrames = 1800;`);
    feCode = feCode.replace(`if (this._interpCache.size >= 150)`, `if (this._interpCache.size >= 600)`);
    fs.writeFileSync(stagedFeJs, feCode, 'utf8');
  }

  const stagedEffectsLoaderJs = path.join(stagedStudioDir, 'effects/loader.js');
  if (fs.existsSync(stagedEffectsLoaderJs)) {
    let loaderCode = fs.readFileSync(stagedEffectsLoaderJs, 'utf8');
    loaderCode = loaderCode.replace(
      `var host = (window.location && window.location.hostname) || (isFileProtocol ? 'file://' : '');`,
      `var host = (window.location && window.location.hostname) || 'localhost';`
    );
    loaderCode = loaderCode.replace(
      `var host = (window.location && window.location.hostname) || '';`,
      `var host = (window.location && window.location.hostname) || 'localhost';`
    );
    loaderCode = loaderCode.replace(
      `var wasmBytes = null;`,
      `var wasmBytes = null;\n  try {\n    var cachedVer = localStorage.getItem('ofts_latest_effects_wasm_ver');\n    var cachedB64 = localStorage.getItem('ofts_latest_effects_wasm_b64');\n    if (cachedB64 && cachedVer && (!window.OFT_VERSION || cachedVer !== window.OFT_VERSION)) {\n      var bin = atob(cachedB64);\n      wasmBytes = new Uint8Array(bin.length);\n      for (var k = 0; k < bin.length; k++) wasmBytes[k] = bin.charCodeAt(k) & 0xff;\n    }\n  } catch (_) {}\n  if (!wasmBytes)`
    );
    loaderCode = loaderCode.replace(
      /if \(xhr\.status >= 200 && xhr\.status < 300 && xhr\.responseText\)/g,
      `if ((xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) && xhr.responseText)`
    );
    loaderCode = loaderCode.replace(
      /if \(cXhr\.status >= 200 && cXhr\.status < 300 && cXhr\.responseText\)/g,
      `if ((cXhr.status === 0 || (cXhr.status >= 200 && cXhr.status < 300)) && cXhr.responseText)`
    );
    fs.writeFileSync(stagedEffectsLoaderJs, loaderCode, 'utf8');
  }

  const liveHotSwapScript = `<script>(function(){window.__OFT_NATIVE_APP__=true;window.__OFT_PACKAGE_NAME__='com.cutefishaep.ofts';try{var rv=localStorage.getItem('ofts_live_cdn_ver');if(rv&&rv!=='${version}'&&navigator.onLine){var base='https://cdn.jsdelivr.net/gh/openfishtools/Studio@main/';var obs=new MutationObserver(function(m){for(var i=0;i<m.length;i++){var nodes=m[i].addedNodes;for(var j=0;j<nodes.length;j++){var el=nodes[j];if(el&&el.tagName==='SCRIPT'){var s=el.getAttribute('src');if(s&&(s.indexOf('js/')===0||s.indexOf('./js/')===0)){el.setAttribute('src',base+s.replace(/^\\.\\//,'')+'?v='+encodeURIComponent(rv));}}else if(el&&el.tagName==='LINK'&&el.getAttribute('rel')==='stylesheet'){var h=el.getAttribute('href');if(h&&(h.indexOf('css/')===0||h.indexOf('./css/')===0)){el.setAttribute('href',base+h.replace(/^\\.\\//,'')+'?v='+encodeURIComponent(rv));}}}}});obs.observe(document.documentElement,{childList:true,subtree:true});}}catch(_){}})();</script>`;
  for (const htmlName of ['index.html', 'desktop.html', 'editor.html']) {
    const htmlPath = path.join(stagedStudioDir, htmlName);
    if (fs.existsSync(htmlPath)) {
      let htmlRaw = fs.readFileSync(htmlPath, 'utf8');
      htmlRaw = htmlRaw
        .replace(/<title>OpenFishTools Studio/g, '<title>FishTools Studio')
        .replace(/ - OpenFishTools Studio'/g, " - FishTools Studio'");
      if (!htmlRaw.includes('ofts_live_cdn_ver')) {
        htmlRaw = htmlRaw.replace('<head>', `<head>\n  ${liveHotSwapScript}`);
      }
      fs.writeFileSync(htmlPath, htmlRaw, 'utf8');
    }
  }

  console.log(`[Manifest] v${version} | ${files.length} files staged`);
  return manifest;
}

if (require.main === module) {
  generateManifest();
}

module.exports = { generateManifest };
