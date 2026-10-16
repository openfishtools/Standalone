const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { generateManifest } = require('./generate-manifest');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'dist-mac');
const APP_NAME = 'FishTools Studio.app';
const APP_PATH = path.join(OUT_DIR, APP_NAME);

function buildMacApp() {
  const t0 = Date.now();
  const manifest = generateManifest();
  const version = manifest.version;
  const dmgPath = path.join(OUT_DIR, `FishTools_Studio_${version}_macOS_Universal.dmg`);

  const loaderHtml = fs.readFileSync(path.join(ROOT_DIR, 'shell/loader.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT_DIR, 'shell/index.html'), loaderHtml, 'utf8');

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const contentsDir = path.join(APP_PATH, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const appRuntimeDir = path.join(resourcesDir, 'app');

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(appRuntimeDir, { recursive: true });

  const icnsSrc = path.join(ROOT_DIR, 'icons/icon.icns');
  if (fs.existsSync(icnsSrc)) {
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'icon.icns'));
  }

  fs.cpSync(path.join(ROOT_DIR, 'shell'), path.join(appRuntimeDir, 'shell'), { recursive: true });

  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>fishtools-studio</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.cutefishaep.ofts</string>
  <key>CFBundleName</key>
  <string>FishTools Studio</string>
  <key>CFBundleDisplayName</key>
  <string>FishTools Studio</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>com.cutefishaep.ofts</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>ofts</string>
        <string>fishtools</string>
      </array>
    </dict>
  </array>
</dict>
</plist>`;
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist, 'utf8');

  const launcherSh = `#!/bin/bash
set -e

BUNDLE_SHELL="$(cd "$(dirname "$0")/../Resources/app/shell" && pwd)"
APP_DATA_DIR="$HOME/Library/Caches/com.cutefishaep.ofts"
RUNTIME_DIR="$APP_DATA_DIR/runtime"
PROFILE_DIR="$APP_DATA_DIR/gecko-profile"
mkdir -p "$PROFILE_DIR/chrome"

apply_studio_patches() {
  local TARGET_STUDIO="\$1"
  if [ -f "\$TARGET_STUDIO/effects/loader.js" ]; then
    sed -i '' "s/var host = (window.location && window.location.hostname) || (isFileProtocol ? 'file:\\/\\/' : '');/var host = (window.location \\&\\& window.location.hostname) || 'localhost';/g" "\$TARGET_STUDIO/effects/loader.js" 2>/dev/null || true
    sed -i '' "s/var host = (window.location && window.location.hostname) || '';/var host = (window.location \\&\\& window.location.hostname) || 'localhost';/g" "\$TARGET_STUDIO/effects/loader.js" 2>/dev/null || true
  fi
  if [ -f "\$TARGET_STUDIO/js/preview-cache.js" ]; then
    sed -i '' "s/this.maxFrames = isMobile ? 180 : (devMem <= 2 ? 150 : (devMem <= 4 ? 300 : 600));/this.maxFrames = 2400;/g" "\$TARGET_STUDIO/js/preview-cache.js" 2>/dev/null || true
  fi
  if [ -f "\$TARGET_STUDIO/js/video-stream-manager.js" ]; then
    sed -i '' "s/this.maxCacheSize = 180;/this.maxCacheSize = 900;/g" "\$TARGET_STUDIO/js/video-stream-manager.js" 2>/dev/null || true
  fi
  if [ -f "\$TARGET_STUDIO/js/frame-extractor.js" ]; then
    sed -i '' "s/this.maxRamFrames = 600;/this.maxRamFrames = 1800;/g" "\$TARGET_STUDIO/js/frame-extractor.js" 2>/dev/null || true
  fi
}

mkdir -p "$RUNTIME_DIR"
cp "$BUNDLE_SHELL/loader.html" "$BUNDLE_SHELL/index.html" "$BUNDLE_SHELL/shell.css" "$BUNDLE_SHELL/shell.js" "$RUNTIME_DIR/" 2>/dev/null || true
if [ ! -f "$RUNTIME_DIR/deeplink.js" ]; then
  cp "$BUNDLE_SHELL/deeplink.js" "$RUNTIME_DIR/" 2>/dev/null || true
fi
if [ ! -f "$RUNTIME_DIR/studio/version.json" ] || ! cmp -s "$BUNDLE_SHELL/manifest.json" "$RUNTIME_DIR/manifest.json" 2>/dev/null; then
  cp -R "$BUNDLE_SHELL/"* "$RUNTIME_DIR/"
  apply_studio_patches "$RUNTIME_DIR/studio"
  rm -f "$RUNTIME_DIR/.github_updated"
fi

INCOMING_LINK="\$1"
MANAGED_BY_COCOA="\$2"
IMPORT_ID=""
if [ -n "\$INCOMING_LINK" ]; then
  IMPORT_ID=\$(printf '%s' "\$INCOMING_LINK" | sed -E 's#^.*(ofts|fishtools)://(import/|project/|p/)?##; s#[/?#].*\$##; s/[^a-zA-Z0-9_-]//g')
  SAFE_LINK=\$(printf '%s' "\$INCOMING_LINK" | sed 's/"/\\\\"/g')
  echo "window.__OFT_DEEPLINK__ = \\"\$SAFE_LINK\\";" > "$RUNTIME_DIR/deeplink.js"
  TS_MS=\$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo "\$(date +%s)000")
  echo "{\\"url\\":\\"\$SAFE_LINK\\",\\"id\\":\\"\$IMPORT_ID\\",\\"ts\\":\$TS_MS}" > "$RUNTIME_DIR/deeplink-live.json"
elif [ -z "\$MANAGED_BY_COCOA" ]; then
  echo "window.__OFT_DEEPLINK__ = null;" > "$RUNTIME_DIR/deeplink.js"
fi

if curl -fsSL --max-time 3 "https://raw.githubusercontent.com/openfishtools/Studio/main/version.json" -o "/tmp/ofts_remote_ver.json" 2>/dev/null; then
  REMOTE_VER=\$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /tmp/ofts_remote_ver.json | cut -d'"' -f4)
  LOCAL_VER=""
  if [ -f "$RUNTIME_DIR/studio/version.json" ]; then
    LOCAL_VER=\$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$RUNTIME_DIR/studio/version.json" | cut -d'"' -f4)
  fi
  if [ -n "\$REMOTE_VER" ] && [ "\$REMOTE_VER" != "\$LOCAL_VER" ]; then
    if [ -d "$RUNTIME_DIR/studio/.git" ]; then
      git -C "$RUNTIME_DIR/studio" pull --ff-only origin main >/dev/null 2>&1 || true
    else
      curl -fsSL --max-time 20 "https://codeload.github.com/openfishtools/Studio/tar.gz/refs/heads/main" | tar -xz --strip-components=1 -C "$RUNTIME_DIR/studio" 2>/dev/null || true
    fi
    apply_studio_patches "$RUNTIME_DIR/studio"
    touch "$RUNTIME_DIR/.github_updated"
  fi
fi

rm -rf "$PROFILE_DIR/startupCache"
if [ -f "$PROFILE_DIR/prefs.js" ]; then
  sed -i '' '/browser\\.tabs\\.inTitlebar/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.homepage/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.page/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.blankWindow/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.preXulSkeletonUI/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
fi

ENCODED_RUNTIME_DIR="\${RUNTIME_DIR// /%20}"
if [ -n "\$IMPORT_ID" ]; then
  LOADER_URL="file://\$ENCODED_RUNTIME_DIR/loader.html?import=\$IMPORT_ID#import=\$IMPORT_ID"
else
  LOADER_URL="file://\$ENCODED_RUNTIME_DIR/loader.html"
fi

cat > "$PROFILE_DIR/chrome/userChrome.css" << 'EOF'
@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");

#navigator-toolbox,
#TabsToolbar,
#nav-bar,
#PersonalToolbar,
#sidebar-box,
#sidebar-splitter,
#statuspanel {
  visibility: collapse !important;
  display: none !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
}
EOF

cat > "$PROFILE_DIR/chrome/userContent.css" << 'EOF'
@-moz-document url-prefix("about:home"), url-prefix("about:newtab"), url-prefix("about:welcome"), url-prefix("about:blank") {
  body, html {
    background-color: #12170e !important;
    display: none !important;
  }
}
EOF

cat > "$PROFILE_DIR/user.js" << EOF
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.tabs.inTitlebar", 0);
user_pref("browser.startup.blankWindow", false);
user_pref("browser.startup.preXulSkeletonUI", false);
user_pref("browser.startup.page", 1);
user_pref("browser.startup.homepage", "\$LOADER_URL");
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
user_pref("security.fileuri.strict_origin_policy", false);
user_pref("dom.workers.serialized-sab.access", true);
user_pref("dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled", true);
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
user_pref("gfx.webrender.all", true);
user_pref("gfx.webrender.compositor", true);
user_pref("gfx.webrender.compositor.force-enabled", true);
user_pref("gfx.webrender.precache-shaders", true);
user_pref("gfx.webrender.program-binary-disk", true);
user_pref("gfx.webrender.scissored-cache-clears.enabled", true);
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
user_pref("dom.webCodec.enabled", true);
user_pref("dom.media.webcodecs.enabled", true);
user_pref("media.hardware-video-decoding.enabled", true);
user_pref("media.hardware-video-decoding.force-enabled", true);
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
EOF

ulimit -n 65536 2>/dev/null || true

export MOZ_WEBRENDER=1
export MOZ_ACCELERATED=1
export MOZ_DISABLE_CONTENT_SANDBOX=1
export MOZ_DISABLE_GMP_SANDBOX=1
export MOZ_DISABLE_GPU_SANDBOX=1
export MOZ_DISABLE_RDD_SANDBOX=1
export MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1
export JSGC_DISABLE_POISONING=1

FIREFOX_BIN=""
for candidate in \\
  "/Applications/Firefox.app/Contents/MacOS/firefox" \\
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox" \\
  "$HOME/Applications/Firefox.app/Contents/MacOS/firefox" \\
  "/Applications/Waterfox.app/Contents/MacOS/waterfox" \\
  "/Applications/Zen Browser.app/Contents/MacOS/zen"; do
  if [ -x "$candidate" ]; then
    FIREFOX_BIN="$candidate"
    break
  fi
done

if [ -z "$FIREFOX_BIN" ]; then
  osascript -e 'display alert "Firefox Runtime Required" message "Please install Firefox.app in /Applications to run FishTools Studio."'
  exit 1
fi

"$FIREFOX_BIN" --no-remote -profile "$PROFILE_DIR" "\$LOADER_URL" &
FF_PID=\$!
echo "\$FF_PID" > "$APP_DATA_DIR/ff.pid"

if [ "\$MANAGED_BY_COCOA" != "--managed-by-cocoa" ]; then
  "$(dirname "$0")/window-watchdog" "\$FF_PID"
fi
`;

  const launcherShPath = path.join(macosDir, 'gecko-launcher.sh');
  fs.writeFileSync(launcherShPath, launcherSh, { mode: 0o755 });

  const watchdogSource = `
#include <ApplicationServices/ApplicationServices.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>

static int count_normal_windows_for_pid(pid_t target_pid) {
    int count = 0;
    CFArrayRef window_list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (!window_list) return 0;
    CFIndex n = CFArrayGetCount(window_list);
    for (CFIndex i = 0; i < n; i++) {
        CFDictionaryRef dict = (CFDictionaryRef)CFArrayGetValueAtIndex(window_list, i);
        if (!dict) continue;
        CFNumberRef pid_ref = (CFNumberRef)CFDictionaryGetValue(dict, kCGWindowOwnerPID);
        int pid = 0;
        if (pid_ref && CFNumberGetValue(pid_ref, kCFNumberIntType, &pid) && pid == target_pid) {
            CFNumberRef layer_ref = (CFNumberRef)CFDictionaryGetValue(dict, kCGWindowLayer);
            int layer = 0;
            if (layer_ref) CFNumberGetValue(layer_ref, kCFNumberIntType, &layer);
            CFBooleanRef onscreen_ref = (CFBooleanRef)CFDictionaryGetValue(dict, kCGWindowIsOnscreen);
            bool is_onscreen = onscreen_ref ? CFBooleanGetValue(onscreen_ref) : false;
            CFDictionaryRef bounds_ref = (CFDictionaryRef)CFDictionaryGetValue(dict, kCGWindowBounds);
            CGRect bounds = CGRectZero;
            if (bounds_ref) CGRectMakeWithDictionaryRepresentation(bounds_ref, &bounds);
            if (layer == 0 && bounds.size.width > 200 && bounds.size.height > 200 && is_onscreen) {
                count++;
            }
        }
    }
    CFRelease(window_list);
    return count;
}

int main(int argc, char *argv[]) {
    if (argc < 2) return 0;
    pid_t ff_pid = (pid_t)atoi(argv[1]);
    if (ff_pid <= 0) return 0;

    int seen_window = 0;
    int zero_streak = 0;
    while (kill(ff_pid, 0) == 0) {
        int win_count = count_normal_windows_for_pid(ff_pid);
        if (win_count > 0) {
            seen_window = 1;
            zero_streak = 0;
        } else if (seen_window) {
            zero_streak++;
            if (zero_streak >= 3) {
                kill(ff_pid, SIGTERM);
                break;
            }
        }
        usleep(120000);
    }
    return 0;
}
`;
  const watchdogCPath = path.join(OUT_DIR, 'watchdog.c');
  const watchdogBinPath = path.join(macosDir, 'window-watchdog');
  fs.writeFileSync(watchdogCPath, watchdogSource, 'utf8');
  execSync(`clang -O2 -mmacosx-version-min=10.15 -arch x86_64 -arch arm64 -framework ApplicationServices -framework CoreFoundation "${watchdogCPath}" -o "${watchdogBinPath}"`);
  fs.unlinkSync(watchdogCPath);
  fs.chmodSync(watchdogBinPath, 0o755);

  const objcSource = `
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <mach-o/dyld.h>
#include <libgen.h>
#include <unistd.h>
#include <signal.h>

static int count_normal_windows_for_pid(pid_t target_pid) {
    int count = 0;
    CFArrayRef window_list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (!window_list) return 0;
    CFIndex n = CFArrayGetCount(window_list);
    for (CFIndex i = 0; i < n; i++) {
        CFDictionaryRef dict = (CFDictionaryRef)CFArrayGetValueAtIndex(window_list, i);
        if (!dict) continue;
        CFNumberRef pid_ref = (CFNumberRef)CFDictionaryGetValue(dict, kCGWindowOwnerPID);
        int pid = 0;
        if (pid_ref && CFNumberGetValue(pid_ref, kCFNumberIntType, &pid) && pid == target_pid) {
            CFNumberRef layer_ref = (CFNumberRef)CFDictionaryGetValue(dict, kCGWindowLayer);
            int layer = 0;
            if (layer_ref) CFNumberGetValue(layer_ref, kCFNumberIntType, &layer);
            CFBooleanRef onscreen_ref = (CFBooleanRef)CFDictionaryGetValue(dict, kCGWindowIsOnscreen);
            bool is_onscreen = onscreen_ref ? CFBooleanGetValue(onscreen_ref) : false;
            CFDictionaryRef bounds_ref = (CFDictionaryRef)CFDictionaryGetValue(dict, kCGWindowBounds);
            CGRect bounds = CGRectZero;
            if (bounds_ref) CGRectMakeWithDictionaryRepresentation(bounds_ref, &bounds);
            if (layer == 0 && bounds.size.width > 200 && bounds.size.height > 200 && is_onscreen) {
                count++;
            }
        }
    }
    CFRelease(window_list);
    return count;
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property (nonatomic, copy) NSString *pendingURL;
@property (nonatomic, assign) pid_t trackedPid;
@property (nonatomic, assign) BOOL seenWindow;
@property (nonatomic, assign) int zeroStreak;
@property (nonatomic, assign) BOOL launchTriggered;
@end

@implementation AppDelegate

- (instancetype)init {
    self = [super init];
    if (self) {
        [[NSAppleEventManager sharedAppleEventManager]
            setEventHandler:self
            andSelector:@selector(handleGetURLEvent:withReplyEvent:)
            forEventClass:kInternetEventClass
            andEventID:kAEGetURL];
    }
    return self;
}

- (NSString *)appDataDir {
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches/com.cutefishaep.ofts"];
}

- (NSString *)runtimeDir {
    return [[self appDataDir] stringByAppendingPathComponent:@"runtime"];
}

- (NSString *)pidFilePath {
    return [[self appDataDir] stringByAppendingPathComponent:@"ff.pid"];
}

- (pid_t)readRunningFirefoxPid {
    NSString *pidStr = [NSString stringWithContentsOfFile:[self pidFilePath] encoding:NSUTF8StringEncoding error:nil];
    if (!pidStr) return 0;
    pid_t pid = (pid_t)[pidStr intValue];
    if (pid > 0 && kill(pid, 0) == 0) {
        return pid;
    }
    return 0;
}

- (void)activateFirefoxPid:(pid_t)pid {
    if (pid <= 0) return;
    NSRunningApplication *ffApp = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (ffApp) {
        [ffApp activateWithOptions:(NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps)];
    }
}

- (void)writeDeepLinkBridgeFiles:(NSString *)rawUrl {
    if (!rawUrl || rawUrl.length == 0) return;
    NSString *rtDir = [self runtimeDir];
    [[NSFileManager defaultManager] createDirectoryAtPath:rtDir withIntermediateDirectories:YES attributes:nil error:nil];

    NSString *escaped = [[rawUrl stringByReplacingOccurrencesOfString:@"\\\\" withString:@"\\\\\\\\"]
                         stringByReplacingOccurrencesOfString:@"\\"" withString:@"\\\\\\""];
    long long ts = (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);

    NSString *jsonContent = [NSString stringWithFormat:@"{\\"url\\":\\"%@\\",\\"ts\\":%lld}\\n", escaped, ts];
    NSString *jsonPath = [rtDir stringByAppendingPathComponent:@"deeplink-live.json"];
    [jsonContent writeToFile:jsonPath atomically:YES encoding:NSUTF8StringEncoding error:nil];

    NSString *jsContent = [NSString stringWithFormat:@"window.__OFT_DEEPLINK__ = \\"%@\\";\\n", escaped];
    NSString *jsPath = [rtDir stringByAppendingPathComponent:@"deeplink.js"];
    [jsContent writeToFile:jsPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

- (void)handleGetURLEvent:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)replyEvent {
    NSString *urlStr = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
    if (!urlStr || urlStr.length == 0) return;
    self.pendingURL = urlStr;
    [self writeDeepLinkBridgeFiles:urlStr];

    pid_t runningPid = [self readRunningFirefoxPid];
    if (runningPid > 0) {
        [self activateFirefoxPid:runningPid];
    }
}

- (void)applicationWillFinishLaunching:(NSNotification *)notification {
    [[NSAppleEventManager sharedAppleEventManager]
        setEventHandler:self
        andSelector:@selector(handleGetURLEvent:withReplyEvent:)
        forEventClass:kInternetEventClass
        andEventID:kAEGetURL];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self performSelector:@selector(startOrForward) withObject:nil afterDelay:0.12];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)theApplication hasVisibleWindows:(BOOL)flag {
    pid_t runningPid = [self readRunningFirefoxPid];
    if (runningPid > 0) {
        [self activateFirefoxPid:runningPid];
    }
    return NO;
}

- (void)startOrForward {
    if (self.launchTriggered) return;
    self.launchTriggered = YES;

    if (self.pendingURL && self.pendingURL.length > 0) {
        [self writeDeepLinkBridgeFiles:self.pendingURL];
    }

    pid_t existingPid = [self readRunningFirefoxPid];
    if (existingPid > 0) {
        [self activateFirefoxPid:existingPid];
        if (self.trackedPid == 0) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                [NSApp terminate:nil];
            });
        }
        return;
    }

    char exe_path[4096];
    uint32_t size = sizeof(exe_path);
    if (_NSGetExecutablePath(exe_path, &size) != 0) {
        [NSApp terminate:nil];
        return;
    }
    char *dir = dirname(exe_path);
    NSString *scriptPath = [NSString stringWithFormat:@"%s/gecko-launcher.sh", dir];
    NSString *initialUrl = self.pendingURL ? [self.pendingURL copy] : @"";

    if (!initialUrl || initialUrl.length == 0) {
        NSString *rtDir = [self runtimeDir];
        [[NSFileManager defaultManager] createDirectoryAtPath:rtDir withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *jsPath = [rtDir stringByAppendingPathComponent:@"deeplink.js"];
        [@"window.__OFT_DEEPLINK__ = null;\\n" writeToFile:jsPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSTask *task = [[NSTask alloc] init];
        [task setLaunchPath:@"/bin/bash"];
        NSString *urlArg = (self.pendingURL && self.pendingURL.length > 0) ? self.pendingURL : initialUrl;
        [task setArguments:@[scriptPath, urlArg ?: @"", @"--managed-by-cocoa"]];
        @try {
            [task launch];
            [task waitUntilExit];
        } @catch (NSException *e) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [NSApp terminate:nil];
            });
            return;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.pendingURL && self.pendingURL.length > 0) {
                [self writeDeepLinkBridgeFiles:self.pendingURL];
            }
            self.trackedPid = [self readRunningFirefoxPid];
            if (self.trackedPid <= 0) {
                [NSApp terminate:nil];
                return;
            }
            [self activateFirefoxPid:self.trackedPid];
            [NSTimer scheduledTimerWithTimeInterval:0.15
                                             target:self
                                           selector:@selector(tickWatchdog:)
                                           userInfo:nil
                                            repeats:YES];
        });
    });
}

- (void)tickWatchdog:(NSTimer *)timer {
    if (self.trackedPid <= 0 || kill(self.trackedPid, 0) != 0) {
        [[NSFileManager defaultManager] removeItemAtPath:[self pidFilePath] error:nil];
        [timer invalidate];
        [NSApp terminate:nil];
        return;
    }
    int winCount = count_normal_windows_for_pid(self.trackedPid);
    if (winCount > 0) {
        self.seenWindow = YES;
        self.zeroStreak = 0;
    } else if (self.seenWindow) {
        self.zeroStreak++;
        if (self.zeroStreak >= 3) {
            kill(self.trackedPid, SIGTERM);
            [[NSFileManager defaultManager] removeItemAtPath:[self pidFilePath] error:nil];
            [timer invalidate];
            [NSApp terminate:nil];
        }
    }
}

@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        if (argc > 1 && argv[1][0] != '-') {
            delegate.pendingURL = [NSString stringWithUTF8String:argv[1]];
        }
        [app setDelegate:delegate];
        [app run];
    }
    return 0;
}
`;
  const objcFilePath = path.join(OUT_DIR, 'main.m');
  const binPath = path.join(macosDir, 'fishtools-studio');
  fs.writeFileSync(objcFilePath, objcSource, 'utf8');
  execSync(`clang -O2 -fobjc-arc -mmacosx-version-min=10.15 -arch x86_64 -arch arm64 -framework Cocoa -framework ApplicationServices -framework CoreFoundation "${objcFilePath}" -o "${binPath}"`);
  fs.unlinkSync(objcFilePath);
  fs.chmodSync(binPath, 0o755);

  const entitlementsPath = path.join(OUT_DIR, 'entitlements.plist');
  const entitlementsXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.automation.apple-events</key>
  <true/>
</dict>
</plist>`;
  fs.writeFileSync(entitlementsPath, entitlementsXml, 'utf8');
  execSync(`xattr -cr "${APP_PATH}" 2>/dev/null || true`);
  execSync(`/usr/bin/codesign --force --sign - "${launcherShPath}"`);
  execSync(`/usr/bin/codesign --force --sign - --entitlements "${entitlementsPath}" "${watchdogBinPath}"`);
  execSync(`/usr/bin/codesign --force --sign - --entitlements "${entitlementsPath}" "${APP_PATH}"`);
  fs.unlinkSync(entitlementsPath);

  const dmgStageDir = path.join(OUT_DIR, '.dmg-stage');
  fs.rmSync(dmgStageDir, { recursive: true, force: true });
  fs.mkdirSync(dmgStageDir, { recursive: true });
  execSync(`ditto "${APP_PATH}" "${path.join(dmgStageDir, APP_NAME)}"`);
  fs.symlinkSync('/Applications', path.join(dmgStageDir, 'Applications'));

  execSync(
    `hdiutil create -volname "FishTools Studio" -srcfolder "${dmgStageDir}" -ov -format UDZO "${dmgPath}"`,
    { stdio: 'ignore' }
  );
  fs.rmSync(dmgStageDir, { recursive: true, force: true });
  execSync(`xattr -cr "${dmgPath}" 2>/dev/null || true`);
  execSync(`/usr/bin/codesign --force --sign - "${dmgPath}"`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[macOS Build] Completed in ${elapsed}s -> ${dmgPath}`);
}

if (require.main === module) {
  buildMacApp();
}

module.exports = { buildMacApp };
