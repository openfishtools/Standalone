/**
 * OpenFishTools Exp-Studio — Authenticode-Signed & AV-Clean Windows x64 Builder
 *
 * Generates:
 *  1. `FishTools Studio.exe` (Main Gecko WebRender Launcher)
 *  2. `Uninstall FishTools Studio.exe` (Control Panel / Settings > Installed Apps Uninstaller
 *     that removes the app, registry keys, shortcuts, and all downloaded resources/cache)
 *  3. `FishTools_Studio_1.0.0_Firefox_Windows_x64_Setup.exe` & `FishTools_Studio_1.0.0_Firefox_Windows_x64.exe`
 *     (Self-contained Windows Installer with Control Panel Uninstall registration + Deep Links)
 *  4. `FishTools_Studio_1.0.0_Firefox_Windows_x64_Portable.zip`
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { generateManifest } = require('./generate-manifest');
const { ensurePersistentSigningCert } = require('./build-android');

const EXP_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(EXP_ROOT, 'dist-win');
const PORTABLE_DIR = path.join(OUT_DIR, 'FishTools Studio');

function findLldLink() {
  const rustupHome = process.env.RUSTUP_HOME || path.join(process.env.HOME || '', '.rustup');
  const toolchainsDir = path.join(rustupHome, 'toolchains');
  if (fs.existsSync(toolchainsDir)) {
    for (const tc of fs.readdirSync(toolchainsDir)) {
      for (const hostArch of ['x86_64-apple-darwin', 'aarch64-apple-darwin']) {
        const candidate = path.join(toolchainsDir, tc, `lib/rustlib/${hostArch}/bin/gcc-ld/lld-link`);
        const libDir = path.join(toolchainsDir, tc, 'lib');
        if (fs.existsSync(candidate)) {
          return { lldLink: candidate, libDir };
        }
      }
    }
  }
  for (const brewPrefix of ['/opt/homebrew/opt/lld/bin/lld-link', '/usr/local/opt/lld/bin/lld-link', '/opt/homebrew/opt/llvm/bin/lld-link', '/usr/local/opt/llvm/bin/lld-link']) {
    if (fs.existsSync(brewPrefix)) {
      return { lldLink: brewPrefix, libDir: path.dirname(path.dirname(brewPrefix)) + '/lib' };
    }
  }
  throw new Error('lld-link not found in ~/.rustup/toolchains or Homebrew');
}

function align4(buf) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem, 0)]);
}

function makeResHeader(dataSize, typeId, nameId) {
  const hdr = Buffer.alloc(32, 0);
  hdr.writeUInt32LE(dataSize >>> 0, 0);
  hdr.writeUInt32LE(32, 4);
  hdr.writeUInt16LE(0xffff, 8);
  hdr.writeUInt16LE(typeId, 10);
  hdr.writeUInt16LE(0xffff, 12);
  hdr.writeUInt16LE(nameId, 14);
  hdr.writeUInt32LE(0, 16);
  hdr.writeUInt16LE(0x1030, 20);
  hdr.writeUInt16LE(0x0409, 22);
  hdr.writeUInt32LE(0, 24);
  hdr.writeUInt32LE(0, 28);
  return hdr;
}

/**
 * Builds a VS_VERSION_INFO binary struct for RT_VERSION (Type 16, ID 1)
 */
function buildVersionInfoStruct(versionStr, fileDesc, origName) {
  const parts = versionStr.split('.').map((x) => parseInt(x, 10) || 0);
  const vMajor = parts[0] || 1;
  const vMinor = parts[1] || 0;
  const vPatch = parts[2] || 0;

  function makeVersionNode(keyStr, valueBuf, isTextValue, children) {
    const keyU16 = Buffer.from(keyStr + '\0', 'utf16le');
    const headerPlusKey = 6 + keyU16.length;
    const pad1 = (4 - (headerPlusKey % 4)) % 4;
    const valLen = valueBuf ? valueBuf.length : 0;
    const pad2 = (4 - (valLen % 4)) % 4;
    const childBuf = children && children.length > 0 ? Buffer.concat(children) : Buffer.alloc(0);

    const totalLen = headerPlusKey + pad1 + valLen + (childBuf.length > 0 ? pad2 + childBuf.length : 0);
    const out = Buffer.alloc(totalLen, 0);
    out.writeUInt16LE(totalLen, 0);
    out.writeUInt16LE(isTextValue ? valLen / 2 : valLen, 2);
    out.writeUInt16LE(isTextValue ? 1 : 0, 4);
    keyU16.copy(out, 6);
    let pos = headerPlusKey + pad1;
    if (valueBuf && valLen > 0) {
      valueBuf.copy(out, pos);
      pos += valLen + (childBuf.length > 0 ? pad2 : 0);
    }
    if (childBuf.length > 0) {
      childBuf.copy(out, pos);
    }
    return align4(out);
  }

  function makeStringPair(k, v) {
    const valU16 = Buffer.from(v + '\0', 'utf16le');
    return makeVersionNode(k, valU16, true, []);
  }

  const ffi = Buffer.alloc(52, 0);
  ffi.writeUInt32LE(0xfeef04bd, 0);
  ffi.writeUInt32LE(0x00010000, 4);
  ffi.writeUInt32LE((vMajor << 16) | vMinor, 8);
  ffi.writeUInt32LE((vPatch << 16) | 0, 12);
  ffi.writeUInt32LE((vMajor << 16) | vMinor, 16);
  ffi.writeUInt32LE((vPatch << 16) | 0, 20);
  ffi.writeUInt32LE(0x3f, 24);
  ffi.writeUInt32LE(0x00, 28);
  ffi.writeUInt32LE(0x00040004, 32);
  ffi.writeUInt32LE(0x00000001, 36);
  ffi.writeUInt32LE(0x00000000, 40);

  const fullVer = `${vMajor}.${vMinor}.${vPatch}.0`;
  const stringTable = makeVersionNode('040904B0', null, true, [
    makeStringPair('CompanyName', 'Cutefish AEP (com.cutefishaep.ofts)'),
    makeStringPair('FileDescription', fileDesc || 'FishTools Studio Desktop Application'),
    makeStringPair('FileVersion', fullVer),
    makeStringPair('InternalName', 'FishToolsStudio'),
    makeStringPair('LegalCopyright', 'Copyright (c) 2026 Cutefish AEP. All rights reserved.'),
    makeStringPair('OriginalFilename', origName || 'FishTools Studio.exe'),
    makeStringPair('ProductName', 'FishTools Studio'),
    makeStringPair('ProductVersion', fullVer)
  ]);
  const stringFileInfo = makeVersionNode('StringFileInfo', null, true, [stringTable]);

  const transVal = Buffer.from([0x09, 0x04, 0xb0, 0x04]);
  const varTranslation = makeVersionNode('Translation', transVal, false, []);
  const varFileInfo = makeVersionNode('VarFileInfo', null, true, [varTranslation]);

  return makeVersionNode('VS_VERSION_INFO', ffi, false, [stringFileInfo, varFileInfo]);
}

/**
 * Generates a COFF .res file containing:
 *  - RT_ICON + RT_GROUP_ICON
 *  - RT_VERSION
 *  - RT_MANIFEST
 *  - Optional RT_RCDATA (Type 10, ID 101) for Setup Installer payload inside `.rsrc` (zero PE overlay!)
 */
function createWin32FullResFile(icoPath, versionStr, outResPath, options = {}) {
  const chunks = [];

  const nullHdr = Buffer.alloc(32, 0);
  nullHdr.writeUInt32LE(0, 0);
  nullHdr.writeUInt32LE(32, 4);
  nullHdr.writeUInt16LE(0xffff, 8);
  nullHdr.writeUInt16LE(0, 10);
  nullHdr.writeUInt16LE(0xffff, 12);
  nullHdr.writeUInt16LE(0, 14);
  chunks.push(nullHdr);

  if (fs.existsSync(icoPath)) {
    const ico = fs.readFileSync(icoPath);
    const count = ico.readUInt16LE(4);
    const grpDir = Buffer.alloc(6 + count * 14);
    grpDir.writeUInt16LE(0, 0);
    grpDir.writeUInt16LE(1, 2);
    grpDir.writeUInt16LE(count, 4);

    for (let i = 0; i < count; i++) {
      const entryOffset = 6 + i * 16;
      const width = ico.readUInt8(entryOffset);
      const height = ico.readUInt8(entryOffset + 1);
      const colorCount = ico.readUInt8(entryOffset + 2);
      const planes = ico.readUInt16LE(entryOffset + 4);
      const bitCount = ico.readUInt16LE(entryOffset + 6);
      const bytesInRes = ico.readUInt32LE(entryOffset + 8);
      const imageOffset = ico.readUInt32LE(entryOffset + 12);
      const iconId = i + 1;

      const iconData = ico.subarray(imageOffset, imageOffset + bytesInRes);
      chunks.push(makeResHeader(iconData.length, 3, iconId));
      chunks.push(align4(iconData));

      const grpEntryOffset = 6 + i * 14;
      grpDir.writeUInt8(width, grpEntryOffset);
      grpDir.writeUInt8(height, grpEntryOffset + 1);
      grpDir.writeUInt8(colorCount, grpEntryOffset + 2);
      grpDir.writeUInt8(0, grpEntryOffset + 3);
      grpDir.writeUInt16LE(planes || 1, grpEntryOffset + 4);
      grpDir.writeUInt16LE(bitCount || 32, grpEntryOffset + 6);
      grpDir.writeUInt32LE(bytesInRes, grpEntryOffset + 8);
      grpDir.writeUInt16LE(iconId, grpEntryOffset + 12);
    }

    chunks.push(makeResHeader(grpDir.length, 14, 1));
    chunks.push(align4(grpDir));
  }

  const verBuf = buildVersionInfoStruct(versionStr, options.fileDesc, options.origName);
  chunks.push(makeResHeader(verBuf.length, 16, 1));
  chunks.push(align4(verBuf));

  const manifestXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="${versionStr}.0" processorArchitecture="amd64" name="com.cutefishaep.ofts" type="win32"/>
  <description>${options.fileDesc || 'FishTools Studio Desktop Application'}</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/>
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">True/PM</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>`,
    'utf8'
  );
  chunks.push(makeResHeader(manifestXml.length, 24, 1));
  chunks.push(align4(manifestXml));

  if (options.rcDataBuf) {
    // RT_RCDATA = 10, Resource ID = 101
    chunks.push(makeResHeader(options.rcDataBuf.length, 10, 101));
    chunks.push(align4(options.rcDataBuf));
  }

  fs.writeFileSync(outResPath, Buffer.concat(chunks));
}

function computePeChecksum(buf, checksumOffset) {
  let sum = 0;
  const len = buf.length;
  for (let i = 0; i < len; i += 2) {
    if (i === checksumOffset || i === checksumOffset + 2) continue;
    const word = i + 1 < len ? buf.readUInt16LE(i) : buf[i];
    sum += word;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + len) >>> 0;
}

function signWindowsPeAuthenticode(exePath, certInfo, tmpDir) {
  let pe = fs.readFileSync(exePath);
  const padRem = pe.length % 8;
  if (padRem !== 0) {
    pe = Buffer.concat([pe, Buffer.alloc(8 - padRem, 0)]);
  }

  const peOffset = pe.readUInt32LE(0x3c);
  const optHeaderOffset = peOffset + 24;
  const magic = pe.readUInt16LE(optHeaderOffset);
  if (magic !== 0x020b) {
    throw new Error('Expected PE32+ (64-bit) OptionalHeader magic 0x020b');
  }

  const checksumOffset = optHeaderOffset + 64;
  const certTableDirOffset = optHeaderOffset + 144;

  const h = crypto.createHash('sha256');
  h.update(pe.subarray(0, checksumOffset));
  h.update(pe.subarray(checksumOffset + 4, certTableDirOffset));
  h.update(pe.subarray(certTableDirOffset + 8, pe.length));
  const peDigest = h.digest();

  const spcAttr = Buffer.from(
    '301e060a2b06010401823702010f3010030100a00ba2098007003c003c003c00',
    'hex'
  );
  const sha256AlgoId = Buffer.from('300d06096086480165030402010500', 'hex');
  const digestOctet = Buffer.concat([Buffer.from([0x04, 0x20]), peDigest]);
  const digestInfo = Buffer.concat([
    Buffer.from([0x30, sha256AlgoId.length + digestOctet.length]),
    sha256AlgoId,
    digestOctet
  ]);
  const spcContentInner = Buffer.concat([spcAttr, digestInfo]);
  const spcDer = Buffer.concat([
    Buffer.from([0x30, spcContentInner.length]),
    spcContentInner
  ]);

  const spcPath = path.join(tmpDir, 'spc.der');
  const pkcs7Path = path.join(tmpDir, 'authenticode.p7b');
  fs.writeFileSync(spcPath, spcDer);

  execSync(
    `"${certInfo.opensslBin}" cms -sign -binary -nodetach -md sha256 -econtent_type 1.3.6.1.4.1.311.2.1.4 -in "${spcPath}" -signer "${certInfo.certPemPath}" -inkey "${certInfo.keyPath}" -outform DER -out "${pkcs7Path}"`,
    { stdio: 'ignore' }
  );

  const pkcs7Der = fs.readFileSync(pkcs7Path);
  const certPad = (8 - ((8 + pkcs7Der.length) % 8)) % 8;
  const winCertLen = 8 + pkcs7Der.length + certPad;
  const winCert = Buffer.alloc(winCertLen, 0);
  winCert.writeUInt32LE(8 + pkcs7Der.length, 0);
  winCert.writeUInt16LE(0x0200, 4);
  winCert.writeUInt16LE(0x0002, 6);
  pkcs7Der.copy(winCert, 8);

  const certFileOffset = pe.length;
  pe.writeUInt32LE(certFileOffset, certTableDirOffset);
  pe.writeUInt32LE(winCert.length, certTableDirOffset + 4);

  const signedPe = Buffer.concat([pe, winCert]);
  const finalChecksum = computePeChecksum(signedPe, checksumOffset);
  signedPe.writeUInt32LE(finalChecksum, checksumOffset);

  fs.writeFileSync(exePath, signedPe);
}

function buildFirefoxWindowsExe() {
  const t0 = Date.now();
  const manifest = generateManifest();
  const certInfo = ensurePersistentSigningCert();
  const { lldLink, libDir } = findLldLink();

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const resourcesShellDir = path.join(PORTABLE_DIR, 'resources', 'app', 'shell');
  fs.mkdirSync(resourcesShellDir, { recursive: true });

  fs.cpSync(path.join(EXP_ROOT, 'shell'), resourcesShellDir, { recursive: true });

  const tmpDir = path.join(OUT_DIR, '.tmp-build');
  fs.mkdirSync(tmpDir, { recursive: true });

  const kernel32Def = `LIBRARY KERNEL32.dll
EXPORTS
GetModuleFileNameW
GetModuleHandleW
GetCommandLineW
GetEnvironmentVariableW
SetEnvironmentVariableW
CreateDirectoryW
RemoveDirectoryW
GetFileAttributesW
SetFileAttributesW
CreateFileW
WriteFile
DeleteFileW
CopyFileW
CreateHardLinkW
FindFirstFileW
FindNextFileW
FindClose
FindResourceW
LoadResource
LockResource
SizeofResource
CreateProcessW
WaitForSingleObject
TerminateProcess
CloseHandle
ExitProcess
CreateMutexW
GetLastError
GetTickCount
`;

  const user32Def = `LIBRARY USER32.dll
EXPORTS
MessageBoxW
EnumWindows
GetWindowThreadProcessId
IsWindowVisible
GetWindowRect
GetWindowTextW
SetWindowTextW
SetForegroundWindow
LoadIconW
SendMessageW
`;

  const advapi32Def = `LIBRARY ADVAPI32.dll
EXPORTS
RegCreateKeyExW
RegSetValueExW
RegCloseKey
RegDeleteTreeW
`;

  const kernel32DefPath = path.join(tmpDir, 'kernel32.def');
  const user32DefPath = path.join(tmpDir, 'user32.def');
  const advapi32DefPath = path.join(tmpDir, 'advapi32.def');
  const kernel32LibPath = path.join(tmpDir, 'kernel32.lib');
  const user32LibPath = path.join(tmpDir, 'user32.lib');
  const advapi32LibPath = path.join(tmpDir, 'advapi32.lib');

  fs.writeFileSync(kernel32DefPath, kernel32Def, 'utf8');
  fs.writeFileSync(user32DefPath, user32Def, 'utf8');
  fs.writeFileSync(advapi32DefPath, advapi32Def, 'utf8');

  const env = { ...process.env, DYLD_LIBRARY_PATH: libDir };
  execSync(`"${lldLink}" /def:"${kernel32DefPath}" /out:"${kernel32LibPath}" /machine:x64`, { env });
  execSync(`"${lldLink}" /def:"${user32DefPath}" /out:"${user32LibPath}" /machine:x64`, { env });
  execSync(`"${lldLink}" /def:"${advapi32DefPath}" /out:"${advapi32LibPath}" /machine:x64`, { env });

  const icoPath = path.join(EXP_ROOT, 'icons/icon.ico');

  const userChromeCss = `@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");
#navigator-toolbox, #TabsToolbar, #titlebar, #toolbar-menubar, #main-menubar, #nav-bar, #PersonalToolbar, #sidebar-box, #sidebar-splitter, #statuspanel {
  visibility: collapse !important;
  display: none !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
}
`;

  const userContentCss = `@-moz-document url-prefix("about:home"), url-prefix("about:newtab"), url-prefix("about:welcome"), url-prefix("about:blank") {
  body, html {
    background-color: #12170e !important;
    display: none !important;
  }
}
`;

  const userJsTemplate = `user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.tabs.inTitlebar", 0);
user_pref("browser.startup.blankWindow", false);
user_pref("browser.startup.preXulSkeletonUI", false);
user_pref("browser.startup.page", 1);
user_pref("network.protocol-handler.external.ofts", false);
user_pref("network.protocol-handler.external.fishtools", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.newtabpage.activity-stream.feeds.snippets", false);
user_pref("browser.newtabpage.activity-stream.feeds.topsites", false);
user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
user_pref("browser.newtabpage.activity-stream.feeds.section.highlights", false);
user_pref("browser.newtabpage.activity-stream.showSearch", false);
user_pref("browser.newtabpage.activity-stream.showSponsored", false);
user_pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
user_pref("browser.tabs.closeWindowWithLastTab", true);

// Offline file:// WASM & Worker unlock
user_pref("security.fileuri.strict_origin_policy", false);
user_pref("dom.workers.serialized-sab.access", true);
user_pref("dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled", true);

// Zero Sandbox & Zero Site-Isolation IPC Overhead
user_pref("fission.autostart", false);
user_pref("security.sandbox.content.level", 0);
user_pref("dom.ipc.processCount", 8);
user_pref("dom.ipc.processPriorityManager.enabled", false);
user_pref("dom.ipc.processPriorityManager.backgroundPerceivable.GracePeriodMS", 3600000);
user_pref("dom.timeout.enable_budget_timer_throttling", false);
user_pref("dom.timeout.throttling_delay", -1);
user_pref("dom.min_background_timeout_value", 0);
user_pref("dom.min_background_timeout_value_without_budget_throttling", 0);
user_pref("page_load.deprioritization_period", 0);

// Multi-Core CPU & Direct3D11 / DirectComposition WebRender GPU Max Acceleration
user_pref("gfx.webrender.all", true);
user_pref("gfx.webrender.compositor", true);
user_pref("gfx.webrender.compositor.force-enabled", true);
user_pref("gfx.webrender.dcomp-win.enabled", true);
user_pref("gfx.webrender.precache-shaders", true);
user_pref("gfx.webrender.program-binary-disk", true);
user_pref("gfx.webrender.scissored-cache-clears.enabled", true);
user_pref("gfx.direct3d11.reuse-decoder-device", 1);
user_pref("gfx.canvas.accelerated", true);
user_pref("gfx.canvas.accelerated.cache-items", 32768);
user_pref("gfx.canvas.accelerated.cache-size", 2048);
user_pref("gfx.offscreencanvas.enabled", true);
user_pref("layers.acceleration.force-enabled", true);
user_pref("layers.gpu-process.enabled", true);
user_pref("layers.gpu-process.force-enabled", true);
user_pref("webgl.force-enabled", true);
user_pref("webgl.msaa-force", false);
user_pref("webgl.out-of-process", true);
user_pref("webgl.max-contexts", 1024);
user_pref("webgl.max-contexts-per-principal", 1024);
user_pref("webgl.lose-context-on-memory-pressure", false);
user_pref("webgl.allow-immediate-queries", true);
user_pref("webgl.enable-draft-extensions", true);
user_pref("dom.workers.maxPerDomain", 128);
user_pref("layout.frame_rate", 0);

// 100% RAM Cache & Unlimited Memory Allocation (Zero Disk Cache I/O Lag)
user_pref("browser.cache.disk.enable", false);
user_pref("browser.cache.disk_cache_ssl", false);
user_pref("browser.cache.memory.enable", true);
user_pref("browser.cache.memory.capacity", -1);
user_pref("browser.cache.memory.max_entry_size", -1);
user_pref("image.mem.decode_bytes_at_a_time", 1048576);
user_pref("image.multithreaded_decoding.enabled", true);
user_pref("image.mem.shared", true);
user_pref("image.mem.surfacecache.max_size_kb", 2097152);
user_pref("image.mem.surfacecache.size_factor", 1);
user_pref("image.mem.surfacecache.min_expiration_ms", 3600000);
user_pref("media.memory_caches_combined_limit_kb", 4194304);
user_pref("media.memory_caches_combined_limit_pc_sysmem", 50);
user_pref("media.memory_cache_max_size", 2097152);
user_pref("media.cache_readahead_limit", 999999);
user_pref("media.cache_resume_threshold", 999999);

// SpiderMonkey JS / WASM JIT Unlock + Spectre Mitigation Bypass (+25% Speed)
user_pref("javascript.options.mem.max", -1);
user_pref("javascript.options.mem.high_water_mark", 2048);
user_pref("javascript.options.mem.gc_per_zone", true);
user_pref("javascript.options.mem.gc_incremental", true);
user_pref("javascript.options.mem.gc_incremental.slice_ms", 5);
user_pref("javascript.options.mem.gc_parallel_marking", true);
user_pref("javascript.options.mem.gc_high_frequency_heap_growth_max", 400);
user_pref("javascript.options.mem.gc_high_frequency_heap_growth_min", 200);
user_pref("javascript.options.mem.gc_low_frequency_heap_growth", 200);
user_pref("javascript.options.parallel_parsing", true);
user_pref("javascript.options.concurrent_delazification", true);
user_pref("javascript.options.ion.offthread_compilation", true);
user_pref("javascript.options.baselinejit.offthread_compilation", true);
user_pref("javascript.options.warp", true);
user_pref("javascript.options.wasm_baselinejit", true);
user_pref("javascript.options.wasm_optimizingjit", true);
user_pref("javascript.options.wasm_simd", true);
user_pref("javascript.options.wasm_relaxed_simd", true);
user_pref("javascript.options.spectre.index_masking", false);
user_pref("javascript.options.spectre.object_mitigations.barriers", false);
user_pref("javascript.options.spectre.string_mitigations", false);
user_pref("javascript.options.spectre.value_masking", false);
user_pref("javascript.options.spectre.jit_to_cxx_calls", false);

// Persistent Storage & Zero SessionStore Disk Stutter
user_pref("dom.storage.enabled", true);
user_pref("dom.indexedDB.enabled", true);
user_pref("dom.storageManager.enabled", true);
user_pref("dom.storageManager.prompt.testing", true);
user_pref("dom.storageManager.prompt.testing.allow", true);
user_pref("permissions.default.persistent-storage", 1);
user_pref("dom.quotaManager.temporaryStorage.fixedLimit", 20971520);
user_pref("dom.storage.default_quota", 20971520);
user_pref("privacy.clearOnShutdown.cache", false);
user_pref("privacy.clearOnShutdown.cookies", false);
user_pref("privacy.clearOnShutdown.offlineApps", false);
user_pref("privacy.sanitize.sanitizeOnShutdown", false);
user_pref("browser.sessionstore.interval", 36000000);
user_pref("browser.sessionstore.resume_from_crash", false);

// WebCodecs + Hardware Video Decoding Force-Enabled
user_pref("dom.webCodec.enabled", true);
user_pref("dom.media.webcodecs.enabled", true);
user_pref("media.hardware-video-decoding.enabled", true);
user_pref("media.hardware-video-decoding.force-enabled", true);

// Disable Welcome / First-Run / Telemetry
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("startup.homepage_override_url", "");
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.messaging-system.whatsNewPanel.enabled", false);
user_pref("browser.uitour.enabled", false);
user_pref("browser.UITour.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
`;

  const bundledProfileDir = path.join(PORTABLE_DIR, 'resources', 'app', 'gecko-profile');
  fs.mkdirSync(path.join(bundledProfileDir, 'chrome'), { recursive: true });
  fs.writeFileSync(path.join(bundledProfileDir, 'chrome', 'userChrome.css'), userChromeCss, 'utf8');
  fs.writeFileSync(path.join(bundledProfileDir, 'chrome', 'userContent.css'), userContentCss, 'utf8');
  fs.writeFileSync(path.join(bundledProfileDir, 'user.js'), userJsTemplate, 'utf8');

  // Shared C Header for Win32 types & helpers
  const sharedWinHeader = `
typedef unsigned short WCHAR;
typedef unsigned int DWORD;
typedef int BOOL;
typedef void* HANDLE;
typedef void* HWND;
typedef unsigned long long ULONG_PTR;
typedef long LONG;

#define INVALID_FILE_ATTRIBUTES ((DWORD)-1)
#define INVALID_HANDLE_VALUE ((HANDLE)(LONG)-1)
#define FILE_ATTRIBUTE_HIDDEN 0x00000002
#define FILE_ATTRIBUTE_NORMAL 0x00000080
#define FILE_ATTRIBUTE_DIRECTORY 0x00000010
#define GENERIC_WRITE 0x40000000L
#define CREATE_ALWAYS 2
#define HIGH_PRIORITY_CLASS 0x00000080
#define WAIT_TIMEOUT 0x00000102L
#define MB_OK 0x00000000L
#define MB_OKCANCEL 0x00000001L
#define MB_YESNO 0x00000004L
#define MB_ICONERROR 0x00000010L
#define MB_ICONQUESTION 0x00000020L
#define MB_ICONINFORMATION 0x00000040L
#define IDOK 1
#define IDYES 6
#define HKEY_CURRENT_USER ((HANDLE)(ULONG_PTR)((LONG)0x80000001))
#define KEY_WRITE 0x20006
#define REG_SZ 1
#define REG_DWORD 4

typedef struct _SECURITY_ATTRIBUTES {
    DWORD nLength;
    void* lpSecurityDescriptor;
    BOOL bInheritHandle;
} SECURITY_ATTRIBUTES;

typedef struct _FILETIME {
    DWORD dwLowDateTime;
    DWORD dwHighDateTime;
} FILETIME;

typedef struct _WIN32_FIND_DATAW {
    DWORD dwFileAttributes;
    FILETIME ftCreationTime;
    FILETIME ftLastAccessTime;
    FILETIME ftLastWriteTime;
    DWORD nFileSizeHigh;
    DWORD nFileSizeLow;
    DWORD dwReserved0;
    DWORD dwReserved1;
    WCHAR cFileName[260];
    WCHAR cAlternateFileName[14];
} WIN32_FIND_DATAW;

typedef struct _STARTUPINFOW {
    DWORD cb;
    WCHAR* lpReserved;
    WCHAR* lpDesktop;
    WCHAR* lpTitle;
    DWORD dwX;
    DWORD dwY;
    DWORD dwXSize;
    DWORD dwYSize;
    DWORD dwXCountChars;
    DWORD dwYCountChars;
    DWORD dwFillAttribute;
    DWORD dwFlags;
    unsigned short wShowWindow;
    unsigned short cbReserved2;
    unsigned char* lpReserved2;
    HANDLE hStdInput;
    HANDLE hStdOutput;
    HANDLE hStdError;
} STARTUPINFOW;

typedef struct _PROCESS_INFORMATION {
    HANDLE hProcess;
    HANDLE hThread;
    DWORD dwProcessId;
    DWORD dwThreadId;
} PROCESS_INFORMATION;

typedef struct _RECT {
    LONG left;
    LONG top;
    LONG right;
    LONG bottom;
} RECT;

typedef BOOL (__stdcall *WNDENUMPROC)(HWND, ULONG_PTR);

__declspec(dllimport) HANDLE __stdcall GetModuleHandleW(const WCHAR* lpModuleName);
__declspec(dllimport) DWORD __stdcall GetModuleFileNameW(HANDLE hModule, WCHAR* lpFilename, DWORD nSize);
__declspec(dllimport) WCHAR* __stdcall GetCommandLineW(void);
__declspec(dllimport) DWORD __stdcall GetEnvironmentVariableW(const WCHAR* lpName, WCHAR* lpBuffer, DWORD nSize);
__declspec(dllimport) BOOL __stdcall SetEnvironmentVariableW(const WCHAR* lpName, const WCHAR* lpValue);
__declspec(dllimport) BOOL __stdcall CreateDirectoryW(const WCHAR* lpPathName, SECURITY_ATTRIBUTES* lpSecurityAttributes);
__declspec(dllimport) BOOL __stdcall RemoveDirectoryW(const WCHAR* lpPathName);
__declspec(dllimport) DWORD __stdcall GetFileAttributesW(const WCHAR* lpFileName);
__declspec(dllimport) BOOL __stdcall SetFileAttributesW(const WCHAR* lpFileName, DWORD dwFileAttributes);
__declspec(dllimport) HANDLE __stdcall CreateFileW(const WCHAR* lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode, SECURITY_ATTRIBUTES* lpSecurityAttributes, DWORD dwCreationDisposition, DWORD dwFlagsAndAttributes, HANDLE hTemplateFile);
__declspec(dllimport) BOOL __stdcall WriteFile(HANDLE hFile, const void* lpBuffer, DWORD nNumberOfBytesToWrite, DWORD* lpNumberOfBytesWritten, void* lpOverlapped);
__declspec(dllimport) BOOL __stdcall DeleteFileW(const WCHAR* lpFileName);
__declspec(dllimport) BOOL __stdcall CopyFileW(const WCHAR* lpExistingFileName, const WCHAR* lpNewFileName, BOOL bFailIfExists);
__declspec(dllimport) BOOL __stdcall CreateHardLinkW(const WCHAR* lpFileName, const WCHAR* lpExistingFileName, SECURITY_ATTRIBUTES* lpSecurityAttributes);
__declspec(dllimport) HANDLE __stdcall FindFirstFileW(const WCHAR* lpFileName, WIN32_FIND_DATAW* lpFindFileData);
__declspec(dllimport) BOOL __stdcall FindNextFileW(HANDLE hFindFile, WIN32_FIND_DATAW* lpFindFileData);
__declspec(dllimport) BOOL __stdcall FindClose(HANDLE hFindFile);
__declspec(dllimport) HANDLE __stdcall FindResourceW(HANDLE hModule, const WCHAR* lpName, const WCHAR* lpType);
__declspec(dllimport) HANDLE __stdcall LoadResource(HANDLE hModule, HANDLE hResInfo);
__declspec(dllimport) void* __stdcall LockResource(HANDLE hResData);
__declspec(dllimport) DWORD __stdcall SizeofResource(HANDLE hModule, HANDLE hResInfo);
__declspec(dllimport) BOOL __stdcall CloseHandle(HANDLE hObject);
__declspec(dllimport) BOOL __stdcall CreateProcessW(const WCHAR* lpApplicationName, WCHAR* lpCommandLine, SECURITY_ATTRIBUTES* lpProcessAttributes, SECURITY_ATTRIBUTES* lpThreadAttributes, BOOL bInheritHandles, DWORD dwCreationFlags, void* lpEnvironment, const WCHAR* lpCurrentDirectory, STARTUPINFOW* lpStartupInfo, PROCESS_INFORMATION* lpProcessInformation);
__declspec(dllimport) DWORD __stdcall WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);
__declspec(dllimport) BOOL __stdcall TerminateProcess(HANDLE hProcess, unsigned int uExitCode);
__declspec(dllimport) void __stdcall ExitProcess(unsigned int uExitCode);
__declspec(dllimport) int __stdcall MessageBoxW(HWND hWnd, const WCHAR* lpText, const WCHAR* lpCaption, unsigned int uType);
__declspec(dllimport) BOOL __stdcall EnumWindows(WNDENUMPROC lpEnumFunc, ULONG_PTR lParam);
__declspec(dllimport) DWORD __stdcall GetWindowThreadProcessId(HWND hWnd, DWORD* lpdwProcessId);
__declspec(dllimport) BOOL __stdcall IsWindowVisible(HWND hWnd);
__declspec(dllimport) BOOL __stdcall GetWindowRect(HWND hWnd, RECT* lpRect);
__declspec(dllimport) int __stdcall GetWindowTextW(HWND hWnd, WCHAR* lpString, int nMaxCount);
__declspec(dllimport) BOOL __stdcall SetWindowTextW(HWND hWnd, const WCHAR* lpString);
__declspec(dllimport) BOOL __stdcall SetForegroundWindow(HWND hWnd);
__declspec(dllimport) HANDLE __stdcall LoadIconW(HANDLE hInstance, const WCHAR* lpIconName);
__declspec(dllimport) ULONG_PTR __stdcall SendMessageW(HWND hWnd, unsigned int Msg, ULONG_PTR wParam, ULONG_PTR lParam);
__declspec(dllimport) HANDLE __stdcall CreateMutexW(SECURITY_ATTRIBUTES* lpMutexAttributes, BOOL bInitialOwner, const WCHAR* lpName);
__declspec(dllimport) DWORD __stdcall GetLastError(void);
__declspec(dllimport) DWORD __stdcall GetTickCount(void);
__declspec(dllimport) LONG __stdcall RegCreateKeyExW(HANDLE hKey, const WCHAR* lpSubKey, DWORD Reserved, WCHAR* lpClass, DWORD dwOptions, DWORD samDesired, void* lpSecurityAttributes, HANDLE* phkResult, DWORD* lpdwDisposition);
__declspec(dllimport) LONG __stdcall RegSetValueExW(HANDLE hKey, const WCHAR* lpValueName, DWORD Reserved, DWORD dwType, const void* lpData, DWORD cbData);
__declspec(dllimport) LONG __stdcall RegCloseKey(HANDLE hKey);
__declspec(dllimport) LONG __stdcall RegDeleteTreeW(HANDLE hKey, const WCHAR* lpSubKey);

ULONG_PTR wcslen(const WCHAR* s) {
    const volatile WCHAR* p = s;
    ULONG_PTR n = 0;
    while (p[n]) n++;
    return n;
}

ULONG_PTR strlen(const char* s) {
    const volatile char* p = s;
    ULONG_PTR n = 0;
    while (p[n]) n++;
    return n;
}

void* memset(void* dest, int c, ULONG_PTR count) {
    volatile unsigned char* p = (volatile unsigned char*)dest;
    while (count--) *p++ = (unsigned char)c;
    return dest;
}

void* memcpy(void* dest, const void* src, ULONG_PTR count) {
    volatile unsigned char* d = (volatile unsigned char*)dest;
    const volatile unsigned char* s = (const volatile unsigned char*)src;
    while (count--) *d++ = *s++;
    return dest;
}

void* memmove(void* dest, const void* src, ULONG_PTR count) {
    volatile unsigned char* d = (volatile unsigned char*)dest;
    const volatile unsigned char* s = (const volatile unsigned char*)src;
    if (d < s) {
        while (count--) *d++ = *s++;
    } else if (d > s) {
        d += count;
        s += count;
        while (count--) *--d = *--s;
    }
    return dest;
}

static int wlen(const WCHAR* s) {
    return (int)wcslen(s);
}

static void wcpy(WCHAR* dst, const WCHAR* src) {
    volatile WCHAR* d = dst;
    const volatile WCHAR* s = src;
    while ((*d++ = *s++));
}

static void wcat(WCHAR* dst, const WCHAR* src) {
    dst += wlen(dst);
    wcpy(dst, src);
}

static int weq(const WCHAR* a, const WCHAR* b) {
    int i = 0;
    while (a[i] && b[i]) {
        if (a[i] != b[i]) return 0;
        i++;
    }
    return a[i] == b[i];
}

static BOOL file_exists(const WCHAR* path) {
    DWORD attr = GetFileAttributesW(path);
    return (attr != INVALID_FILE_ATTRIBUTES);
}

static void dirname_w(WCHAR* path) {
    int len = wlen(path);
    while (len > 0 && path[len - 1] != L'\\\\' && path[len - 1] != L'/') {
        len--;
    }
    if (len > 0) path[len - 1] = 0;
}

static void reg_set_str(const WCHAR* subKey, const WCHAR* valName, const WCHAR* valStr) {
    HANDLE hKey = 0;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, subKey, 0, 0, 0, KEY_WRITE, 0, &hKey, 0) == 0 && hKey) {
        DWORD bytes = (DWORD)((wlen(valStr) + 1) * 2);
        RegSetValueExW(hKey, valName, 0, REG_SZ, valStr, bytes);
        RegCloseKey(hKey);
    }
}

static void reg_set_dword(const WCHAR* subKey, const WCHAR* valName, DWORD val) {
    HANDLE hKey = 0;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, subKey, 0, 0, 0, KEY_WRITE, 0, &hKey, 0) == 0 && hKey) {
        RegSetValueExW(hKey, valName, 0, REG_DWORD, &val, 4);
        RegCloseKey(hKey);
    }
}

static void register_app_and_control_panel(const WCHAR* installDir) {
    WCHAR mainExe[2048];
    wcpy(mainExe, installDir);
    wcat(mainExe, L"\\\\FishTools Studio.exe");

    WCHAR uninstExe[2048];
    wcpy(uninstExe, installDir);
    wcat(uninstExe, L"\\\\Uninstall FishTools Studio.exe");

    WCHAR iconSpec[2048];
    wcpy(iconSpec, mainExe);
    wcat(iconSpec, L",0");

    WCHAR uninstCmd[2048];
    wcpy(uninstCmd, L"\\"");
    wcat(uninstCmd, uninstExe);
    wcat(uninstCmd, L"\\"");

    WCHAR quietUninstCmd[2048];
    wcpy(quietUninstCmd, L"\\"");
    wcat(quietUninstCmd, uninstExe);
    wcat(quietUninstCmd, L"\\" /S");

    const WCHAR* uninstKey = L"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\com.cutefishaep.ofts";
    reg_set_str(uninstKey, L"DisplayName", L"FishTools Studio");
    reg_set_str(uninstKey, L"DisplayVersion", L"${manifest.version}");
    reg_set_str(uninstKey, L"Publisher", L"Cutefish AEP");
    reg_set_str(uninstKey, L"URLInfoAbout", L"https://studio.cutefish.my.id");
    reg_set_str(uninstKey, L"DisplayIcon", iconSpec);
    reg_set_str(uninstKey, L"InstallLocation", installDir);
    reg_set_str(uninstKey, L"UninstallString", uninstCmd);
    reg_set_str(uninstKey, L"QuietUninstallString", quietUninstCmd);
    reg_set_dword(uninstKey, L"NoModify", 1);
    reg_set_dword(uninstKey, L"NoRepair", 1);
    reg_set_dword(uninstKey, L"EstimatedSize", 48500);

    WCHAR protoCmd[2048];
    wcpy(protoCmd, L"\\"");
    wcat(protoCmd, mainExe);
    wcat(protoCmd, L"\\" \\"%1\\"");

    reg_set_str(L"Software\\\\Classes\\\\ofts", 0, L"URL:FishTools Studio Protocol");
    reg_set_str(L"Software\\\\Classes\\\\ofts", L"URL Protocol", L"");
    reg_set_str(L"Software\\\\Classes\\\\ofts\\\\DefaultIcon", 0, iconSpec);
    reg_set_str(L"Software\\\\Classes\\\\ofts\\\\shell\\\\open\\\\command", 0, protoCmd);

    reg_set_str(L"Software\\\\Classes\\\\fishtools", 0, L"URL:FishTools Studio Protocol");
    reg_set_str(L"Software\\\\Classes\\\\fishtools", L"URL Protocol", L"");
    reg_set_str(L"Software\\\\Classes\\\\fishtools\\\\DefaultIcon", 0, iconSpec);
    reg_set_str(L"Software\\\\Classes\\\\fishtools\\\\shell\\\\open\\\\command", 0, protoCmd);
}

static void delete_dir_recursive(const WCHAR* dirPath) {
    if (!file_exists(dirPath)) return;
    WCHAR searchPat[2048];
    wcpy(searchPat, dirPath);
    wcat(searchPat, L"\\\\*");

    WIN32_FIND_DATAW ffd;
    for (int i = 0; i < (int)sizeof(ffd); i++) ((unsigned char*)&ffd)[i] = 0;

    HANDLE hFind = FindFirstFileW(searchPat, &ffd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (weq(ffd.cFileName, L".") || weq(ffd.cFileName, L"..")) continue;
            WCHAR childPath[2048];
            wcpy(childPath, dirPath);
            wcat(childPath, L"\\\\");
            wcat(childPath, ffd.cFileName);
            SetFileAttributesW(childPath, FILE_ATTRIBUTE_NORMAL);
            if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                delete_dir_recursive(childPath);
            } else {
                DeleteFileW(childPath);
            }
        } while (FindNextFileW(hFind, &ffd));
        FindClose(hFind);
    }
    SetFileAttributesW(dirPath, FILE_ATTRIBUTE_NORMAL);
    RemoveDirectoryW(dirPath);
}
`;

  // ---------------------------------------------------------------------------
  // 1. Build `FishTools Studio.exe` (Main Launcher)
  // ---------------------------------------------------------------------------
  const winLauncherSource = `
${sharedWinHeader}

static int wcontains(const WCHAR* hay, const WCHAR* needle) {
    if (!hay || !needle || !needle[0]) return 0;
    for (int i = 0; hay[i]; i++) {
        int j = 0;
        while (needle[j] && hay[i + j] == needle[j]) j++;
        if (!needle[j]) return 1;
    }
    return 0;
}

static void path_to_file_url(const WCHAR* winPath, WCHAR* outUrl) {
    wcpy(outUrl, L"file:///");
    int j = wlen(outUrl);
    for (int i = 0; winPath[i]; i++) {
        WCHAR c = winPath[i];
        if (c == L'\\\\') {
            outUrl[j++] = L'/';
        } else if (c == L' ') {
            outUrl[j++] = L'%';
            outUrl[j++] = L'2';
            outUrl[j++] = L'0';
        } else {
            outUrl[j++] = c;
        }
    }
    outUrl[j] = 0;
}

static void extract_first_cli_arg(WCHAR* outArg) {
    outArg[0] = 0;
    const WCHAR* cmd = GetCommandLineW();
    if (!cmd) return;
    int i = 0;
    while (cmd[i] == L' ' || cmd[i] == L'\\t') i++;
    if (cmd[i] == L'"') {
        i++;
        while (cmd[i] && cmd[i] != L'"') i++;
        if (cmd[i] == L'"') i++;
    } else {
        while (cmd[i] && cmd[i] != L' ' && cmd[i] != L'\\t') i++;
    }
    while (cmd[i] == L' ' || cmd[i] == L'\\t') i++;
    if (!cmd[i]) return;
    int j = 0;
    if (cmd[i] == L'"') {
        i++;
        while (cmd[i] && cmd[i] != L'"' && j < 1020) outArg[j++] = cmd[i++];
    } else {
        while (cmd[i] && cmd[i] != L' ' && cmd[i] != L'\\t' && j < 1020) outArg[j++] = cmd[i++];
    }
    outArg[j] = 0;
}

static void extract_clean_import_id(const WCHAR* raw, WCHAR* outId) {
    outId[0] = 0;
    int len = wlen(raw);
    int end = len;
    while (end > 0 && (raw[end - 1] == L'/' || raw[end - 1] == L'\\\\' || raw[end - 1] == L' ')) end--;
    int start = end;
    while (start > 0 && raw[start - 1] != L'/' && raw[start - 1] != L'\\\\' && raw[start - 1] != L'=') start--;
    int j = 0;
    for (int i = start; i < end && j < 250; i++) {
        WCHAR c = raw[i];
        if ((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'_' || c == L'-') {
            outId[j++] = c;
        }
    }
    outId[j] = 0;
}

static void write_ascii_file(const WCHAR* path, const char* data) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(h, data, (DWORD)strlen(data), &written, 0);
        CloseHandle(h);
    }
}

static void write_deeplink_bridge(const WCHAR* exeDir, const WCHAR* cliArg) {
    WCHAR jsonPath[2048], jsPath[2048];
    wcpy(jsonPath, exeDir); wcat(jsonPath, L"\\\\resources\\\\app\\\\shell\\\\deeplink-live.json");
    wcpy(jsPath, exeDir); wcat(jsPath, L"\\\\resources\\\\app\\\\shell\\\\deeplink.js");

    if (!cliArg[0]) {
        write_ascii_file(jsPath, "window.__OFT_DEEPLINK__ = null;\\n");
        return;
    }

    char safeUrl[1024];
    int p = 0;
    for (int i = 0; cliArg[i] && p < 980; i++) {
        WCHAR c = cliArg[i];
        if (c == L'\\\\' || c == L'"') safeUrl[p++] = '\\\\';
        if (c >= 32 && c < 127) safeUrl[p++] = (char)c;
    }
    safeUrl[p] = 0;

    DWORD tick = GetTickCount();
    char tickBuf[32];
    int tp = 0;
    if (tick == 0) {
        tickBuf[tp++] = '1';
    } else {
        char rev[32];
        int rp = 0;
        while (tick > 0) {
            rev[rp++] = (char)('0' + (tick % 10));
            tick /= 10;
        }
        while (rp > 0) tickBuf[tp++] = rev[--rp];
    }
    tickBuf[tp] = 0;

    char jsonBuf[1536];
    const char* p1 = "{\\"url\\":\\"";
    const char* p2 = "\\",\\"ts\\":";
    const char* p3 = "}\\n";
    int k = 0;
    for (int i = 0; p1[i]; i++) jsonBuf[k++] = p1[i];
    for (int i = 0; safeUrl[i]; i++) jsonBuf[k++] = safeUrl[i];
    for (int i = 0; p2[i]; i++) jsonBuf[k++] = p2[i];
    for (int i = 0; tickBuf[i]; i++) jsonBuf[k++] = tickBuf[i];
    for (int i = 0; p3[i]; i++) jsonBuf[k++] = p3[i];
    jsonBuf[k] = 0;
    write_ascii_file(jsonPath, jsonBuf);

    char jsBuf[1536];
    const char* j1 = "window.__OFT_DEEPLINK__ = \\"";
    const char* j2 = "\\";\\n";
    k = 0;
    for (int i = 0; j1[i]; i++) jsBuf[k++] = j1[i];
    for (int i = 0; safeUrl[i]; i++) jsBuf[k++] = safeUrl[i];
    for (int i = 0; j2[i]; i++) jsBuf[k++] = j2[i];
    jsBuf[k] = 0;
    write_ascii_file(jsPath, jsBuf);
}

static void mirror_gecko_dir(const WCHAR* srcDir, const WCHAR* dstDir, int depth) {
    if (depth > 4) return;
    CreateDirectoryW(dstDir, 0);
    WCHAR searchPat[2048];
    wcpy(searchPat, srcDir);
    wcat(searchPat, L"\\\\*");

    WIN32_FIND_DATAW ffd;
    for (int i = 0; i < (int)sizeof(ffd); i++) ((unsigned char*)&ffd)[i] = 0;

    HANDLE hFind = FindFirstFileW(searchPat, &ffd);
    if (hFind == INVALID_HANDLE_VALUE) return;
    do {
        if (weq(ffd.cFileName, L".") || weq(ffd.cFileName, L"..")) continue;
        if (weq(ffd.cFileName, L"uninstall") ||
            weq(ffd.cFileName, L"updater.exe") ||
            weq(ffd.cFileName, L"crashreporter.exe") ||
            weq(ffd.cFileName, L"maintenanceservice.exe") ||
            weq(ffd.cFileName, L"maintenanceservice_installer.exe") ||
            weq(ffd.cFileName, L"pingsender.exe") ||
            weq(ffd.cFileName, L"default-browser-agent.exe")) {
            continue;
        }
        WCHAR sPath[2048], dPath[2048];
        wcpy(sPath, srcDir); wcat(sPath, L"\\\\"); wcat(sPath, ffd.cFileName);
        wcpy(dPath, dstDir); wcat(dPath, L"\\\\"); wcat(dPath, ffd.cFileName);

        if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            mirror_gecko_dir(sPath, dPath, depth + 1);
        } else {
            if (!file_exists(dPath)) {
                if (!CreateHardLinkW(dPath, sPath, 0)) {
                    CopyFileW(sPath, dPath, 0);
                }
            }
        }
    } while (FindNextFileW(hFind, &ffd));
    FindClose(hFind);
}

typedef struct {
    DWORD targetPid;
    int count;
    HANDLE hIcon;
} WatchdogCtx;

static BOOL __stdcall enum_windows_cb(HWND hwnd, ULONG_PTR lParam) {
    WatchdogCtx* ctx = (WatchdogCtx*)lParam;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == ctx->targetPid && IsWindowVisible(hwnd)) {
        RECT r;
        if (GetWindowRect(hwnd, &r)) {
            if ((r.right - r.left) > 200 && (r.bottom - r.top) > 200) {
                ctx->count++;
                if (ctx->hIcon) {
                    // WM_SETICON = 0x0080, ICON_SMALL = 0, ICON_BIG = 1
                    SendMessageW(hwnd, 0x0080, 0, (ULONG_PTR)ctx->hIcon);
                    SendMessageW(hwnd, 0x0080, 1, (ULONG_PTR)ctx->hIcon);
                }
                WCHAR title[256];
                title[0] = 0;
                if (GetWindowTextW(hwnd, title, 255) > 0) {
                    if (wcontains(title, L"Firefox") || wcontains(title, L"Mozilla")) {
                        SetWindowTextW(hwnd, L"FishTools Studio");
                    }
                }
            }
        }
    }
    return 1;
}

void mainCRTStartup(void) {
    SetEnvironmentVariableW(L"MOZ_WEBRENDER", L"1");
    SetEnvironmentVariableW(L"MOZ_ACCELERATED", L"1");
    SetEnvironmentVariableW(L"MOZ_DISABLE_CONTENT_SANDBOX", L"1");
    SetEnvironmentVariableW(L"MOZ_DISABLE_GMP_SANDBOX", L"1");
    SetEnvironmentVariableW(L"MOZ_DISABLE_GPU_SANDBOX", L"1");
    SetEnvironmentVariableW(L"MOZ_DISABLE_RDD_SANDBOX", L"1");
    SetEnvironmentVariableW(L"MOZ_DISABLE_SOCKET_PROCESS_SANDBOX", L"1");
    SetEnvironmentVariableW(L"JSGC_DISABLE_POISONING", L"1");
    SetEnvironmentVariableW(L"MOZ_CRASHREPORTER_DISABLE", L"1");

    WCHAR exeDir[2048];
    GetModuleFileNameW(0, exeDir, 2048);
    dirname_w(exeDir);

    // Ensure Control Panel Uninstall & ofts:// protocol point to current installation
    register_app_and_control_panel(exeDir);

    WCHAR cliArg[1024];
    extract_first_cli_arg(cliArg);
    write_deeplink_bridge(exeDir, cliArg);

    HANDLE hMutex = CreateMutexW(0, 1, L"Local\\\\FishToolsStudioSingleInstance");
    if (hMutex && GetLastError() == 183) {
        ExitProcess(0);
    }

    // Hide internal resources directory from File Explorer
    WCHAR resDir[2048];
    wcpy(resDir, exeDir);
    wcat(resDir, L"\\\\resources");
    if (file_exists(resDir)) {
        SetFileAttributesW(resDir, FILE_ATTRIBUTE_HIDDEN);
    }

    WCHAR loaderPath[2048];
    wcpy(loaderPath, exeDir);
    wcat(loaderPath, L"\\\\resources\\\\app\\\\shell\\\\loader.html");

    // Store Gecko profile & skinned runtime in AppData\\Local\\com.cutefishaep.ofts
    WCHAR appDataRoot[2048];
    WCHAR profileDir[2048];
    appDataRoot[0] = 0;
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", appDataRoot, 1024) > 0) {
        wcat(appDataRoot, L"\\\\com.cutefishaep.ofts");
        CreateDirectoryW(appDataRoot, 0);
        SetFileAttributesW(appDataRoot, FILE_ATTRIBUTE_HIDDEN);
        wcpy(profileDir, appDataRoot);
        wcat(profileDir, L"\\\\gecko-profile");
    } else {
        wcpy(profileDir, exeDir);
        wcat(profileDir, L"\\\\resources\\\\app\\\\gecko-profile");
    }
    CreateDirectoryW(profileDir, 0);

    WCHAR chromeDir[2048];
    wcpy(chromeDir, profileDir);
    wcat(chromeDir, L"\\\\chrome");
    CreateDirectoryW(chromeDir, 0);

    // Seed user.js, userChrome.css, userContent.css from bundled profile into app-bound storage
    WCHAR srcUserJs[2048], dstUserJs[2048];
    wcpy(srcUserJs, exeDir); wcat(srcUserJs, L"\\\\resources\\\\app\\\\gecko-profile\\\\user.js");
    wcpy(dstUserJs, profileDir); wcat(dstUserJs, L"\\\\user.js");
    CopyFileW(srcUserJs, dstUserJs, 0);

    WCHAR srcChrome[2048], dstChrome[2048];
    wcpy(srcChrome, exeDir); wcat(srcChrome, L"\\\\resources\\\\app\\\\gecko-profile\\\\chrome\\\\userChrome.css");
    wcpy(dstChrome, chromeDir); wcat(dstChrome, L"\\\\userChrome.css");
    CopyFileW(srcChrome, dstChrome, 0);

    WCHAR srcContent[2048], dstContent[2048];
    wcpy(srcContent, exeDir); wcat(srcContent, L"\\\\resources\\\\app\\\\gecko-profile\\\\chrome\\\\userContent.css");
    wcpy(dstContent, chromeDir); wcat(dstContent, L"\\\\userContent.css");
    CopyFileW(srcContent, dstContent, 0);

    WCHAR loaderUrl[4096];
    path_to_file_url(loaderPath, loaderUrl);

    if (cliArg[0]) {
        WCHAR cleanId[256];
        extract_clean_import_id(cliArg, cleanId);
        if (cleanId[0]) {
            wcat(loaderUrl, L"?import=");
            wcat(loaderUrl, cleanId);
            wcat(loaderUrl, L"#import=");
            wcat(loaderUrl, cleanId);
        }
    }

    WCHAR ffBin[2048];
    ffBin[0] = 0;

    const WCHAR* fixedCandidates[] = {
        L"C:\\\\Program Files\\\\Mozilla Firefox\\\\firefox.exe",
        L"C:\\\\Program Files (x86)\\\\Mozilla Firefox\\\\firefox.exe",
        L"C:\\\\Program Files\\\\Firefox Developer Edition\\\\firefox.exe",
        L"C:\\\\Program Files\\\\Waterfox\\\\waterfox.exe",
        L"C:\\\\Program Files\\\\Zen Browser\\\\zen.exe",
        L"C:\\\\Program Files\\\\Floorp\\\\floorp.exe",
        L"C:\\\\Program Files\\\\LibreWolf\\\\librewolf.exe",
        0
    };

    for (int i = 0; fixedCandidates[i]; i++) {
        if (file_exists(fixedCandidates[i])) {
            wcpy(ffBin, fixedCandidates[i]);
            break;
        }
    }

    if (!ffBin[0]) {
        WCHAR localAppData[1024];
        if (GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, 1024) > 0) {
            WCHAR localCandidate[2048];
            wcpy(localCandidate, localAppData);
            wcat(localCandidate, L"\\\\Mozilla Firefox\\\\firefox.exe");
            if (file_exists(localCandidate)) {
                wcpy(ffBin, localCandidate);
            }
        }
    }

    if (!ffBin[0]) {
        MessageBoxW(
            0,
            L"Please install Mozilla Firefox (64-bit) to run FishTools Studio with Gecko WebRender GPU acceleration.",
            L"FishTools Studio - Gecko Runtime Required",
            MB_ICONERROR
        );
        ExitProcess(1);
    }

    // Zero-Copy Skinning: Hardlink Gecko runtime into AppData\\Local\\com.cutefishaep.ofts\\gecko-engine
    // and run as "FishTools Studio.exe" with Enterprise Policies injected
    WCHAR launchBin[2048];
    wcpy(launchBin, ffBin);
    if (appDataRoot[0]) {
        WCHAR ffDir[2048];
        wcpy(ffDir, ffBin);
        dirname_w(ffDir);

        WCHAR engineDir[2048];
        wcpy(engineDir, appDataRoot);
        wcat(engineDir, L"\\\\gecko-engine");
        mirror_gecko_dir(ffDir, engineDir, 0);

        WCHAR distDir[2048], polPath[2048];
        wcpy(distDir, engineDir); wcat(distDir, L"\\\\distribution");
        CreateDirectoryW(distDir, 0);
        wcpy(polPath, distDir); wcat(polPath, L"\\\\policies.json");
        write_ascii_file(polPath, "{\\"policies\\":{\\"DisableAppUpdate\\":true,\\"DisableTelemetry\\":true,\\"DontCheckDefaultBrowser\\":true,\\"DisableFirefoxStudies\\":true,\\"DisablePocket\\":true,\\"DisableFirefoxAccounts\\":true,\\"OverrideFirstRunPage\\":\\"\\",\\"OverridePostUpdatePage\\":\\"\\"}}\\n");

        WCHAR skinnedExe[2048];
        wcpy(skinnedExe, engineDir);
        wcat(skinnedExe, L"\\\\FishTools Studio.exe");
        if (!file_exists(skinnedExe)) {
            if (!CreateHardLinkW(skinnedExe, ffBin, 0)) {
                CopyFileW(ffBin, skinnedExe, 0);
            }
        }
        if (file_exists(skinnedExe)) {
            wcpy(launchBin, skinnedExe);
        }
    }

    WCHAR cmdLine[8192];
    wcpy(cmdLine, L"\\"");
    wcat(cmdLine, launchBin);
    wcat(cmdLine, L"\\" --no-remote -profile \\"");
    wcat(cmdLine, profileDir);
    wcat(cmdLine, L"\\" \\"");
    wcat(cmdLine, loaderUrl);
    wcat(cmdLine, L"\\"");

    STARTUPINFOW si;
    for (int i = 0; i < (int)sizeof(si); i++) ((unsigned char*)&si)[i] = 0;
    si.cb = sizeof(si);

    PROCESS_INFORMATION pi;
    for (int i = 0; i < (int)sizeof(pi); i++) ((unsigned char*)&pi)[i] = 0;

    BOOL ok = CreateProcessW(
        launchBin,
        cmdLine,
        0,
        0,
        0,
        HIGH_PRIORITY_CLASS,
        0,
        exeDir,
        &si,
        &pi
    );

    if (!ok) {
        ExitProcess(1);
    }

    HANDLE hAppIcon = LoadIconW(GetModuleHandleW(0), (const WCHAR*)(ULONG_PTR)1);

    int seenWindow = 0;
    int zeroStreak = 0;
    while (WaitForSingleObject(pi.hProcess, 120) == WAIT_TIMEOUT) {
        WatchdogCtx ctx;
        ctx.targetPid = pi.dwProcessId;
        ctx.count = 0;
        ctx.hIcon = hAppIcon;
        EnumWindows(enum_windows_cb, (ULONG_PTR)&ctx);
        if (ctx.count > 0) {
            seenWindow = 1;
            zeroStreak = 0;
        } else if (seenWindow) {
            zeroStreak++;
            if (zeroStreak >= 3) {
                TerminateProcess(pi.hProcess, 0);
                break;
            }
        }
    }

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    ExitProcess(0);
}
`;

  const launcherResPath = path.join(tmpDir, 'launcher.res');
  createWin32FullResFile(icoPath, manifest.version, launcherResPath, {
    fileDesc: 'FishTools Studio Desktop Application',
    origName: 'FishTools Studio.exe'
  });

  const launcherCPath = path.join(tmpDir, 'win_launcher.c');
  const launcherObjPath = path.join(tmpDir, 'win_launcher.obj');
  const exePath = path.join(PORTABLE_DIR, 'FishTools Studio.exe');

  fs.writeFileSync(launcherCPath, winLauncherSource, 'utf8');
  execSync(`clang -O2 --target=x86_64-pc-windows-msvc -ffreestanding -fno-builtin -fno-stack-protector -mno-stack-arg-probe -c "${launcherCPath}" -o "${launcherObjPath}"`);
  execSync(
    `"${lldLink}" /subsystem:windows /entry:mainCRTStartup /out:"${exePath}" "${launcherObjPath}" "${kernel32LibPath}" "${user32LibPath}" "${advapi32LibPath}" "${launcherResPath}"`,
    { env }
  );
  signWindowsPeAuthenticode(exePath, certInfo, tmpDir);

  // ---------------------------------------------------------------------------
  // 2. Build `Uninstall FishTools Studio.exe` (Control Panel Uninstaller)
  // ---------------------------------------------------------------------------
  const winUninstallerSource = `
${sharedWinHeader}

static BOOL is_silent_mode(void) {
    const WCHAR* cmd = GetCommandLineW();
    if (!cmd) return 0;
    for (int i = 0; cmd[i]; i++) {
        if ((cmd[i] == L'/' || cmd[i] == L'-') && (cmd[i + 1] == L'S' || cmd[i + 1] == L's' || cmd[i + 1] == L'Q' || cmd[i + 1] == L'q')) {
            return 1;
        }
    }
    return 0;
}

void mainCRTStartup(void) {
    BOOL silent = is_silent_mode();
    if (!silent) {
        int resp = MessageBoxW(
            0,
            L"Are you sure you want to completely uninstall FishTools Studio and remove all downloaded resources and cache?",
            L"FishTools Studio Uninstaller",
            MB_YESNO | MB_ICONQUESTION
        );
        if (resp != IDYES) {
            ExitProcess(0);
        }
    }

    WCHAR exeDir[2048];
    GetModuleFileNameW(0, exeDir, 2048);
    dirname_w(exeDir);

    // 1. Remove Control Panel Uninstall & Deep Link Registry Keys
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\com.cutefishaep.ofts");
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\\\Classes\\\\ofts");
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\\\Classes\\\\fishtools");

    // 2. Remove AppData\\Local\\com.cutefishaep.ofts (all downloaded resources, WASM cache, IndexedDB, Gecko profile)
    WCHAR localAppData[1024];
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, 1024) > 0) {
        WCHAR appDataDir[2048];
        wcpy(appDataDir, localAppData);
        wcat(appDataDir, L"\\\\com.cutefishaep.ofts");
        delete_dir_recursive(appDataDir);

        WCHAR stdInstallDir[2048];
        wcpy(stdInstallDir, localAppData);
        wcat(stdInstallDir, L"\\\\Programs\\\\FishTools Studio\\\\resources");
        delete_dir_recursive(stdInstallDir);

        WCHAR stdExe[2048];
        wcpy(stdExe, localAppData);
        wcat(stdExe, L"\\\\Programs\\\\FishTools Studio\\\\FishTools Studio.exe");
        SetFileAttributesW(stdExe, FILE_ATTRIBUTE_NORMAL);
        DeleteFileW(stdExe);
    }

    // 3. Remove Start Menu & Desktop Shortcuts if present
    WCHAR appDataRoaming[1024];
    if (GetEnvironmentVariableW(L"APPDATA", appDataRoaming, 1024) > 0) {
        WCHAR startLnk[2048];
        wcpy(startLnk, appDataRoaming);
        wcat(startLnk, L"\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\FishTools Studio.lnk");
        DeleteFileW(startLnk);
    }
    WCHAR userProfile[1024];
    if (GetEnvironmentVariableW(L"USERPROFILE", userProfile, 1024) > 0) {
        WCHAR deskLnk[2048];
        wcpy(deskLnk, userProfile);
        wcat(deskLnk, L"\\\\Desktop\\\\FishTools Studio.lnk");
        DeleteFileW(deskLnk);
    }

    // 4. Remove resources and FishTools Studio.exe in current directory
    WCHAR localRes[2048];
    wcpy(localRes, exeDir);
    wcat(localRes, L"\\\\resources");
    delete_dir_recursive(localRes);

    WCHAR localMainExe[2048];
    wcpy(localMainExe, exeDir);
    wcat(localMainExe, L"\\\\FishTools Studio.exe");
    SetFileAttributesW(localMainExe, FILE_ATTRIBUTE_NORMAL);
    DeleteFileW(localMainExe);

    WCHAR localCer[2048];
    wcpy(localCer, exeDir);
    wcat(localCer, L"\\\\FishToolsStudio-CodeSign.cer");
    DeleteFileW(localCer);

    if (!silent) {
        MessageBoxW(
            0,
            L"FishTools Studio and all downloaded resources have been uninstalled successfully.",
            L"FishTools Studio Uninstaller",
            MB_OK | MB_ICONINFORMATION
        );
    }

    ExitProcess(0);
}
`;

  const uninstResPath = path.join(tmpDir, 'uninstaller.res');
  createWin32FullResFile(icoPath, manifest.version, uninstResPath, {
    fileDesc: 'FishTools Studio Uninstaller',
    origName: 'Uninstall FishTools Studio.exe'
  });

  const uninstCPath = path.join(tmpDir, 'win_uninstaller.c');
  const uninstObjPath = path.join(tmpDir, 'win_uninstaller.obj');
  const uninstExePath = path.join(PORTABLE_DIR, 'Uninstall FishTools Studio.exe');

  fs.writeFileSync(uninstCPath, winUninstallerSource, 'utf8');
  execSync(`clang -O2 --target=x86_64-pc-windows-msvc -ffreestanding -fno-builtin -fno-stack-protector -mno-stack-arg-probe -c "${uninstCPath}" -o "${uninstObjPath}"`);
  execSync(
    `"${lldLink}" /subsystem:windows /entry:mainCRTStartup /out:"${uninstExePath}" "${uninstObjPath}" "${kernel32LibPath}" "${user32LibPath}" "${advapi32LibPath}" "${uninstResPath}"`,
    { env }
  );
  signWindowsPeAuthenticode(uninstExePath, certInfo, tmpDir);

  // Bundle the public certificate (.cer)
  const cerOutPath = path.join(PORTABLE_DIR, 'FishToolsStudio-CodeSign.cer');
  fs.copyFileSync(certInfo.certDerPath, cerOutPath);

  // Create Portable ZIP
  const zipPath = path.join(OUT_DIR, `FishTools_Studio_${manifest.version}_Windows_x64_Portable.zip`);
  execSync(`cd "${OUT_DIR}" && zip -rq "${zipPath}" "FishTools Studio"`);

  // ---------------------------------------------------------------------------
  // 3. Build Self-Contained Windows Setup Installer (`FishTools_Studio_1.0.0_Firefox_Windows_x64_Setup.exe`)
  //    Embeds the app payload inside `.rsrc` (`RT_RCDATA` ID 101) -> Zero PE Overlay!
  // ---------------------------------------------------------------------------
  const innerZipPath = path.join(tmpDir, 'setup-payload.zip');
  execSync(`cd "${PORTABLE_DIR}" && zip -rq "${innerZipPath}" "FishTools Studio.exe" "Uninstall FishTools Studio.exe" "FishToolsStudio-CodeSign.cer" "resources"`);
  const payloadZipBuf = fs.readFileSync(innerZipPath);

  const winSetupSource = `
${sharedWinHeader}

#define MAKEINTRESOURCEW(i) ((const WCHAR*)((ULONG_PTR)((unsigned short)(i))))

static BOOL is_silent_setup(void) {
    const WCHAR* cmd = GetCommandLineW();
    if (!cmd) return 0;
    for (int i = 0; cmd[i]; i++) {
        if ((cmd[i] == L'/' || cmd[i] == L'-') && (cmd[i + 1] == L'S' || cmd[i + 1] == L's' || cmd[i + 1] == L'Q' || cmd[i + 1] == L'q')) {
            return 1;
        }
    }
    return 0;
}

void mainCRTStartup(void) {
    BOOL silent = is_silent_setup();
    if (!silent) {
        int resp = MessageBoxW(
            0,
            L"Install FishTools Studio v${manifest.version} (com.cutefishaep.ofts)?\\n\\nThis will install FishTools Studio, register Control Panel Uninstall & studio.cutefish.my.id Deep Links, and launch the application.",
            L"FishTools Studio v${manifest.version} Setup",
            MB_OKCANCEL | MB_ICONINFORMATION
        );
        if (resp != IDOK) {
            ExitProcess(0);
        }
    }

    WCHAR localAppData[1024];
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, 1024) == 0) {
        ExitProcess(1);
    }

    WCHAR programsDir[2048];
    wcpy(programsDir, localAppData);
    wcat(programsDir, L"\\\\Programs");
    CreateDirectoryW(programsDir, 0);

    WCHAR installDir[2048];
    wcpy(installDir, programsDir);
    wcat(installDir, L"\\\\FishTools Studio");
    CreateDirectoryW(installDir, 0);

    WCHAR appDataDir[2048];
    wcpy(appDataDir, localAppData);
    wcat(appDataDir, L"\\\\com.cutefishaep.ofts");
    CreateDirectoryW(appDataDir, 0);
    SetFileAttributesW(appDataDir, FILE_ATTRIBUTE_HIDDEN);

    // Extract RT_RCDATA (Type 10, ID 101) payload from .rsrc section
    HANDLE hRes = FindResourceW(0, MAKEINTRESOURCEW(101), MAKEINTRESOURCEW(10));
    if (!hRes) {
        MessageBoxW(0, L"Setup payload resource not found.", L"FishTools Studio Setup", MB_ICONERROR);
        ExitProcess(1);
    }
    DWORD resSize = SizeofResource(0, hRes);
    HANDLE hGlobal = LoadResource(0, hRes);
    void* resPtr = LockResource(hGlobal);
    if (!resPtr || resSize == 0) {
        ExitProcess(1);
    }

    WCHAR tmpZipPath[2048];
    wcpy(tmpZipPath, appDataDir);
    wcat(tmpZipPath, L"\\\\ofts-setup-payload.zip");

    HANDLE hFile = CreateFileW(tmpZipPath, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (hFile == INVALID_HANDLE_VALUE) {
        ExitProcess(1);
    }
    DWORD written = 0;
    WriteFile(hFile, resPtr, resSize, &written, 0);
    CloseHandle(hFile);

    // Extract payload into %LOCALAPPDATA%\\Programs\\FishTools Studio using Windows System32 tar.exe
    WCHAR tarBin[1024];
    wcpy(tarBin, L"C:\\\\Windows\\\\System32\\\\tar.exe");

    WCHAR tarCmd[4096];
    wcpy(tarCmd, L"\\"");
    wcat(tarCmd, tarBin);
    wcat(tarCmd, L"\\" -xf \\"");
    wcat(tarCmd, tmpZipPath);
    wcat(tarCmd, L"\\" -C \\"");
    wcat(tarCmd, installDir);
    wcat(tarCmd, L"\\"");

    STARTUPINFOW si;
    for (int i = 0; i < (int)sizeof(si); i++) ((unsigned char*)&si)[i] = 0;
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    for (int i = 0; i < (int)sizeof(pi); i++) ((unsigned char*)&pi)[i] = 0;

    if (CreateProcessW(tarBin, tarCmd, 0, 0, 0, 0, 0, installDir, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, 60000);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    DeleteFileW(tmpZipPath);

    // Hide internal resources directory so downloaded/runtime files never clutter File Explorer
    WCHAR installedResDir[2048];
    wcpy(installedResDir, installDir);
    wcat(installedResDir, L"\\\\resources");
    SetFileAttributesW(installedResDir, FILE_ATTRIBUTE_HIDDEN);

    // Register in Windows Control Panel (Programs and Features / Installed Apps) & ofts:// Deep Link Protocol
    register_app_and_control_panel(installDir);

    // Launch installed FishTools Studio.exe
    WCHAR installedExe[2048];
    wcpy(installedExe, installDir);
    wcat(installedExe, L"\\\\FishTools Studio.exe");

    WCHAR launchCmd[2048];
    wcpy(launchCmd, L"\\"");
    wcat(launchCmd, installedExe);
    wcat(launchCmd, L"\\"");

    STARTUPINFOW siLaunch;
    for (int i = 0; i < (int)sizeof(siLaunch); i++) ((unsigned char*)&siLaunch)[i] = 0;
    siLaunch.cb = sizeof(siLaunch);
    PROCESS_INFORMATION piLaunch;
    for (int i = 0; i < (int)sizeof(piLaunch); i++) ((unsigned char*)&piLaunch)[i] = 0;

    if (CreateProcessW(installedExe, launchCmd, 0, 0, 0, 0, 0, installDir, &siLaunch, &piLaunch)) {
        CloseHandle(piLaunch.hThread);
        CloseHandle(piLaunch.hProcess);
    }

    ExitProcess(0);
}
`;

  const setupResPath = path.join(tmpDir, 'setup.res');
  createWin32FullResFile(icoPath, manifest.version, setupResPath, {
    fileDesc: 'FishTools Studio Setup Installer',
    origName: `FishTools_Studio_${manifest.version}_Windows_x64_Setup.exe`,
    rcDataBuf: payloadZipBuf
  });

  const setupCPath = path.join(tmpDir, 'win_setup.c');
  const setupObjPath = path.join(tmpDir, 'win_setup.obj');
  const setupExePath = path.join(OUT_DIR, `FishTools_Studio_${manifest.version}_Windows_x64_Setup.exe`);
  const standaloneExeCopy = path.join(OUT_DIR, `FishTools_Studio_${manifest.version}_Windows_x64.exe`);

  fs.writeFileSync(setupCPath, winSetupSource, 'utf8');
  execSync(`clang -O2 --target=x86_64-pc-windows-msvc -ffreestanding -fno-builtin -fno-stack-protector -mno-stack-arg-probe -c "${setupCPath}" -o "${setupObjPath}"`);
  execSync(
    `"${lldLink}" /subsystem:windows /entry:mainCRTStartup /out:"${setupExePath}" "${setupObjPath}" "${kernel32LibPath}" "${user32LibPath}" "${advapi32LibPath}" "${setupResPath}"`,
    { env }
  );
  signWindowsPeAuthenticode(setupExePath, certInfo, tmpDir);
  fs.copyFileSync(setupExePath, standaloneExeCopy);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[Windows Build] Completed in ${elapsed}s -> ${setupExePath}`);
}

if (require.main === module) {
  buildFirefoxWindowsExe();
}

module.exports = { buildFirefoxWindowsExe };
