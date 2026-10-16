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

  // 1. Copy FishTools Studio icon & localized InfoPlist.strings so macOS never shows "Firefox"
  const icnsSrc = path.join(ROOT_DIR, 'icons/icon.icns');
  if (fs.existsSync(icnsSrc)) {
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'icon.icns'));
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'firefox.icns'));
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'document.icns'));
  }

  for (const lang of ['en.lproj', 'id.lproj']) {
    const lprojDir = path.join(resourcesDir, lang);
    fs.mkdirSync(lprojDir, { recursive: true });
    fs.writeFileSync(
      path.join(lprojDir, 'InfoPlist.strings'),
      'CFBundleName = "FishTools Studio";\nCFBundleDisplayName = "FishTools Studio";\n',
      'utf8'
    );
  }

  // 2. Stage FishTools Studio shell
  fs.cpSync(path.join(ROOT_DIR, 'shell'), path.join(appRuntimeDir, 'shell'), { recursive: true });

  // 3. Enterprise policies & MPL 2.0 notice
  const distDir = path.join(resourcesDir, 'distribution');
  fs.mkdirSync(distDir, { recursive: true });
  const policiesJson = {
    policies: {
      AppAutoUpdate: false,
      BackgroundAppUpdate: false,
      DisableAppUpdate: true,
      DisableTelemetry: true,
      DisableFirefoxStudies: true,
      DisablePocket: true,
      DisableFirefoxAccounts: true,
      DisableFirefoxScreenshots: true,
      DisableSetDesktopBackground: true,
      DontCheckDefaultBrowser: true,
      NoDefaultBookmarks: true,
      OverrideFirstRunPage: '',
      OverridePostUpdatePage: '',
      PasswordManagerEnabled: false,
      PromptForDownloadLocation: false,
      UserMessaging: {
        WhatsNew: false,
        ExtensionRecommendations: false,
        FeatureRecommendations: false,
        UrlbarInterventions: false,
        SkipOnboarding: true,
        MoreFromMozilla: false
      }
    }
  };
  fs.writeFileSync(path.join(distDir, 'policies.json'), JSON.stringify(policiesJson, null, 2), 'utf8');

  const mplNotice = `FishTools Studio — Runtime Notice
=================================
FishTools Studio utilizes the Gecko rendering engine under the Mozilla Public License v2.0 (MPL 2.0).
FishTools Studio is an independent product by OpenFishTools and is not affiliated with the Mozilla Foundation.
`;
  fs.writeFileSync(path.join(resourcesDir, 'MOZILLA_MPL_NOTICE.txt'), mplNotice, 'utf8');

  // 4. Write Contents/Info.plist
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>English</string>
  <key>CFBundleExecutable</key>
  <string>fishtools-studio</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.cutefishaep.ofts</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
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
  <string>10.15.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>NSRequiresAquaSystemAppearance</key>
  <false/>
  <key>NSPrincipalClass</key>
  <string>GeckoNSApplication</string>
  <key>LSEnvironment</key>
  <dict>
    <key>MallocNanoZone</key>
    <string>0</string>
    <key>SYSTEM_VERSION_COMPAT</key>
    <string>0</string>
  </dict>
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

  // 5. Write entitlements.plist & Gecko AutoConfig (defaults/pref/autoconfig.js + fishtools.cfg)
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
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.automation.apple-events</key>
  <true/>
</dict>
</plist>`;
  const bundledEntitlementsPath = path.join(resourcesDir, 'entitlements.plist');
  fs.writeFileSync(bundledEntitlementsPath, entitlementsXml, 'utf8');

  const defaultsPrefDir = path.join(resourcesDir, 'defaults/pref');
  fs.mkdirSync(defaultsPrefDir, { recursive: true });
  fs.writeFileSync(
    path.join(defaultsPrefDir, 'autoconfig.js'),
    'pref("general.config.filename", "fishtools.cfg");\npref("general.config.obscure_value", 0);\npref("general.config.sandbox_enabled", false);\n',
    'utf8'
  );

  const fishtoolsCfg = `// FishTools Studio Gecko AutoConfig
try {
  const { Services } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs");
  const _Cc = Components.classes;
  const _Ci = Components.interfaces;
  const _exeFile = Services.dirsvc.get("XREExeF", _Ci.nsIFile);
  const _isFishTools = _exeFile && /fishtools/i.test(_exeFile.leafName || "");

  if (_isFishTools) {
    // Inject native app flags into studio.cutefish.my.id before page scripts run
    Services.obs.addObserver((doc) => {
      try {
        if (!doc || !doc.defaultView || !doc.location) return;
        const host = doc.location.hostname || "";
        if (host === "studio.cutefish.my.id" || host.endsWith(".cutefish.my.id")) {
          const w = doc.defaultView.wrappedJSObject || doc.defaultView;
          w.__OFT_NATIVE_APP__ = true;
          w.__OFT_PACKAGE_NAME__ = "com.cutefishaep.ofts";
        }
      } catch (_) {}
    }, "document-element-inserted");

    const stripBrowserChrome = (win) => {
      try {
        if (!win || !win.document) return;
        const doc = win.document;
        const root = doc.documentElement;
        if (root) {
          root.setAttribute("data-title-default", "FishTools Studio");
          root.setAttribute("data-content-title-default", "FishTools Studio");
          root.setAttribute("data-title-private", "FishTools Studio");
          root.setAttribute("title", "FishTools Studio");
        }
        doc.title = "FishTools Studio";

        const removeIds = [
          "main-menubar",
          "toolbar-menubar",
          "key_newNavigator",
          "key_newNavigatorTab",
          "key_privatebrowsing",
          "key_openFile",
          "key_savePage",
          "printKb",
          "key_close",
          "key_closeWindow",
          "key_preferencesCmdMac",
          "viewBookmarksSidebarKb",
          "key_gotoHistory",
          "key_search",
          "key_search2",
          "focusURLBar",
          "focusURLBar2",
          "key_viewSource",
          "key_openDownloads",
          "key_openAddons",
          "addBookmarkAsKb",
          "bookmarkAllTabsKb",
          "manBookmarkKb",
          "viewBookmarksToolbarKb",
          "key_restoreLastClosedTabOrWindowOrSession"
        ];
        for (const id of removeIds) {
          const el = doc.getElementById(id);
          if (el) el.remove();
        }

        const studioHome = "https://studio.cutefish.my.id/";
        let lastHandledId = "";
        let lastHandledTime = 0;

        const extractPresetId = (raw) => {
          return String(raw || "")
            .trim()
            .replace(/^.*(?:ofts|fishtools):\\/\\/(?:import\\/|project\\/|p\\/)?/i, "")
            .replace(/^https?:\\/\\/studio\\.cutefish\\.my\\.id\\/(?:import\\/|project\\/|p\\/)?/i, "")
            .replace(/[/?#].*$/, "")
            .replace(/[^a-zA-Z0-9_-]/g, "");
        };

        if (win.gBrowser) {
          const checkTabs = () => {
            try {
              if (!win.gBrowser.tabs || win.gBrowser.tabs.length === 0) {
                win.gBrowser.addTrustedTab(studioHome);
                return;
              }

              // 1. Check one-shot deeplink.once file written when user clicks a preset link
              try {
                const onceFile = Services.dirsvc.get("Home", _Ci.nsIFile);
                onceFile.append("Library");
                onceFile.append("Caches");
                onceFile.append("com.cutefishaep.ofts");
                onceFile.append("deeplink.once");
                if (onceFile.exists()) {
                  let raw = "";
                  try {
                    const fstream = _Cc["@mozilla.org/network/file-input-stream;1"].createInstance(_Ci.nsIFileInputStream);
                    const cstream = _Cc["@mozilla.org/scriptableinputstream;1"].createInstance(_Ci.nsIScriptableInputStream);
                    fstream.init(onceFile, -1, 0, 0);
                    cstream.init(fstream);
                    raw = cstream.read(cstream.available());
                    cstream.close();
                    fstream.close();
                  } catch (_) {}
                  try { onceFile.remove(false); } catch (_) {}
                  const id = extractPresetId(raw);
                  const now = Date.now();
                  if (id && !(id === lastHandledId && (now - lastHandledTime) < 3000)) {
                    lastHandledId = id;
                    lastHandledTime = now;
                    win.gBrowser.selectedBrowser.fixupAndLoadURIString(studioHome + "?import=" + id, {
                      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
                    });
                    return;
                  }
                }
              } catch (_) {}

              // 2. Intercept only raw custom protocol URIs (ofts:// or fishtools://), NEVER https://studio.cutefish.my.id/...
              const spec = (win.gBrowser.currentURI && win.gBrowser.currentURI.spec) || "";
              if (spec.startsWith("ofts:") || spec.startsWith("fishtools:")) {
                const id = extractPresetId(spec);
                const now = Date.now();
                lastHandledId = id;
                lastHandledTime = now;
                const target = id ? (studioHome + "?import=" + id) : studioHome;
                win.gBrowser.selectedBrowser.fixupAndLoadURIString(target, {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
                });
                return;
              }

              if (
                spec.startsWith("about:newtab") ||
                spec.startsWith("about:home") ||
                spec.startsWith("about:welcome") ||
                spec.startsWith("about:preferences") ||
                spec.startsWith("about:addons")
              ) {
                win.gBrowser.selectedBrowser.fixupAndLoadURIString(studioHome, {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
                });
              }
            } catch (_) {}
          };
          win.setTimeout(checkTabs, 150);
          win.setInterval(checkTabs, 600);
        }
      } catch (_) {}
    };

    Services.obs.addObserver((subject) => {
      stripBrowserChrome(subject);
    }, "browser-delayed-startup-finished");
  }
} catch (_) {}
`;
  fs.writeFileSync(path.join(resourcesDir, 'fishtools.cfg'), fishtoolsCfg, 'utf8');

  // 6. Write gecko-launcher.sh
  // Uses Zero-Copy Symlink Skinning: keeps DMG at ~15 MB while running Gecko inside FishTools Studio.app
  // so macOS Dock & Top-Left Menu Bar are 100% "FishTools Studio" (never Firefox).
  const launcherSh = `#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_CONTENTS="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_RES="$BUNDLE_CONTENTS/Resources"
APP_DATA_DIR="$HOME/Library/Caches/com.cutefishaep.ofts"
PROFILE_DIR="$APP_DATA_DIR/gecko-profile"
mkdir -p "$PROFILE_DIR/chrome"

# Remove any legacy local file:// runtime directory so Studio runs directly on https://studio.cutefish.my.id
rm -rf "$APP_DATA_DIR/runtime"

# Locate host Gecko engine
FF_APP=""
for candidate in \\
  "/Applications/Firefox.app" \\
  "/Applications/Firefox Developer Edition.app" \\
  "$HOME/Applications/Firefox.app" \\
  "/Applications/Waterfox.app" \\
  "/Applications/Zen Browser.app"; do
  if [ -f "$candidate/Contents/MacOS/XUL" ]; then
    FF_APP="$candidate"
    break
  fi
done

if [ -z "$FF_APP" ]; then
  osascript -e 'display alert "Gecko Runtime Required" message "Please install Firefox in /Applications to provide the Gecko WebRender engine for FishTools Studio."'
  exit 1
fi

FF_MACOS="$FF_APP/Contents/MacOS"
FF_RES="$FF_APP/Contents/Resources"

# Ensure AutoConfig (guarded by _isFishTools) is also present in FF_RES where symlinked XUL resolves GreD
if [ -w "$FF_RES" ]; then
  mkdir -p "$FF_RES/defaults/pref" 2>/dev/null || true
  cp -f "$BUNDLE_RES/defaults/pref/autoconfig.js" "$FF_RES/defaults/pref/autoconfig.js" 2>/dev/null || true
  cp -f "$BUNDLE_RES/fishtools.cfg" "$FF_RES/fishtools.cfg" 2>/dev/null || true
fi

# Determine target bundle for Zero-Copy Symlink Skinning
TARGET_APP="$(cd "$BUNDLE_CONTENTS/.." && pwd)"
if [ ! -w "$SCRIPT_DIR" ]; then
  TARGET_APP="$APP_DATA_DIR/FishTools Studio.app"
  mkdir -p "$TARGET_APP/Contents/MacOS" "$TARGET_APP/Contents/Resources"
  cp -f "$BUNDLE_CONTENTS/Info.plist" "$TARGET_APP/Contents/Info.plist"
  cp -f "$BUNDLE_RES/icon.icns" "$TARGET_APP/Contents/Resources/icon.icns" 2>/dev/null || true
  cp -f "$BUNDLE_RES/icon.icns" "$TARGET_APP/Contents/Resources/firefox.icns" 2>/dev/null || true
  cp -f "$BUNDLE_RES/icon.icns" "$TARGET_APP/Contents/Resources/document.icns" 2>/dev/null || true
  cp -Rf "$BUNDLE_RES/en.lproj" "$BUNDLE_RES/id.lproj" "$BUNDLE_RES/distribution" "$BUNDLE_RES/defaults" "$TARGET_APP/Contents/Resources/" 2>/dev/null || true
  cp -f "$BUNDLE_RES/fishtools.cfg" "$TARGET_APP/Contents/Resources/fishtools.cfg" 2>/dev/null || true
  cp -f "$SCRIPT_DIR/libfishtools_bridge.dylib" "$TARGET_APP/Contents/MacOS/libfishtools_bridge.dylib"
fi

T_MACOS="$TARGET_APP/Contents/MacOS"
T_RES="$TARGET_APP/Contents/Resources"

if [ -d "$FF_APP/Contents/Frameworks" ]; then
  ln -sfn "$FF_APP/Contents/Frameworks" "$TARGET_APP/Contents/Frameworks"
fi

# Symlink Gecko dylibs, XUL, and helpers (excluding updater/crashreporter)
for item in "$FF_MACOS"/*; do
  base="\$(basename "\$item")"
  case "\$base" in
    firefox|fishtools-studio|fishtools-gecko|libfishtools_bridge.dylib|window-watchdog|gecko-launcher.sh|updater.app|crashreporter.app|crashhelper|pingsender|nmhproxy)
      continue
      ;;
  esac
  ln -sfn "\$item" "\$T_MACOS/\$base"
done

# Symlink Gecko Resources (excluding Assets.car, firefox.icns, *.lproj, defaults, fishtools.cfg so Firefox branding never leaks)
for item in "$FF_RES"/*; do
  base="\$(basename "\$item")"
  case "\$base" in
    Assets.car|firefox.icns|document.icns|icon.icns|updater.ini|*.lproj|*.sig|distribution|defaults|fishtools.cfg|app|entitlements.plist|MOZILLA_MPL_NOTICE.txt)
      continue
      ;;
  esac
  ln -sfn "\$item" "\$T_RES/\$base"
done

# Copy & sign the 174KB Gecko stub binary as fishtools-gecko if missing or updated
FF_MAIN_BIN="$FF_MACOS/firefox"
if [ ! -f "\$FF_MAIN_BIN" ]; then
  for b in "$FF_MACOS/waterfox" "$FF_MACOS/zen"; do
    if [ -f "\$b" ]; then FF_MAIN_BIN="\$b"; break; fi
  done
fi

GECKO_BIN="\$T_MACOS/fishtools-gecko"
if [ ! -f "\$GECKO_BIN" ] || ! cmp -s "\$FF_MAIN_BIN" "\$GECKO_BIN.orig" 2>/dev/null; then
  cp -f "\$FF_MAIN_BIN" "\$GECKO_BIN.orig"
  cp -f "\$FF_MAIN_BIN" "\$GECKO_BIN"
  chmod 755 "\$GECKO_BIN"
  /usr/bin/codesign --force --sign - --entitlements "$BUNDLE_RES/entitlements.plist" "\$GECKO_BIN" 2>/dev/null || true
fi
printf '%s' "\$GECKO_BIN" > "$APP_DATA_DIR/gecko_bin.path"
printf '%s' "\$T_MACOS/libfishtools_bridge.dylib" > "$APP_DATA_DIR/bridge_dylib.path"

INCOMING_LINK="\$1"
MODE_FLAG="\$2"
IMPORT_ID=""
if [ -n "\$INCOMING_LINK" ]; then
  IMPORT_ID=\$(printf '%s' "\$INCOMING_LINK" | sed -E 's#^.*(ofts|fishtools)://(import/|project/|p/)?##; s#^https?://studio\\.cutefish\\.my\\.id/(import/|project/|p/)?##; s#[/?#].*\$##; s/[^a-zA-Z0-9_-]//g')
fi

# Always purge stale SessionStore and external handler caches so Gecko never restores a 0-tab blank window
rm -rf "$PROFILE_DIR/startupCache" "$PROFILE_DIR/sessionstore-backups"
rm -f "$PROFILE_DIR/sessionstore.jsonlz4" "$PROFILE_DIR/sessionCheckpoints.json" "$PROFILE_DIR/handlers.json" "$APP_DATA_DIR/deeplink.once"
if [ -f "$PROFILE_DIR/prefs.js" ]; then
  sed -i '' '/browser\\.tabs\\.inTitlebar/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.homepage/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.page/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.blankWindow/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.preXulSkeletonUI/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.startup\\.couldRestoreSession/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.sessionstore/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.cache\\.disk/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/general\\.useragent\\.override/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
  sed -i '' '/browser\\.link\\.open_newwindow/d' "$PROFILE_DIR/prefs.js" 2>/dev/null || true
fi

HOME_URL="https://studio.cutefish.my.id/"
if [ -n "\$IMPORT_ID" ]; then
  LOADER_URL="https://studio.cutefish.my.id/?import=\$IMPORT_ID"
else
  LOADER_URL="\$HOME_URL"
fi
printf '%s' "\$LOADER_URL" > "$APP_DATA_DIR/loader.url"

cat > "$PROFILE_DIR/chrome/userChrome.css" << 'EOF'
@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");

:root,
window,
#main-window,
#browser,
#appcontent,
#tabbrowser-tabbox,
#tabbrowser-tabpanels,
tabpanels {
  background-color: #12170e !important;
}

#main-menubar,
#toolbar-menubar,
#navigator-toolbox,
#TabsToolbar,
#titlebar,
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
user_pref("browser.startup.homepage", "https://studio.cutefish.my.id/");
user_pref("general.useragent.override", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0 FishToolsStudio/${version}");
user_pref("browser.link.open_newwindow", 1);
user_pref("browser.link.open_newwindow.override.external", 1);
user_pref("browser.link.open_newwindow.restriction", 0);
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
user_pref("browser.macAppMenu.setAsDefaultShown", true);
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
user_pref("browser.cache.disk.enable", true);
user_pref("browser.cache.disk_cache_ssl", true);
user_pref("browser.cache.disk.capacity", 1048576);
user_pref("browser.cache.offline.enable", true);
user_pref("dom.serviceWorkers.enabled", true);
user_pref("dom.caches.enabled", true);
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
user_pref("browser.sessionstore.restore_on_demand", false);
user_pref("browser.sessionstore.restore_pinned_tabs_on_demand", false);
user_pref("browser.sessionstore.max_tabs_undo", 0);
user_pref("browser.sessionstore.max_windows_undo", 0);
user_pref("toolkit.startup.max_resumed_crashes", -1);
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

if [ "\$MODE_FLAG" = "--prepare-only" ]; then
  exit 0
fi

ulimit -n 65536 2>/dev/null || true

export MOZ_WEBRENDER=1
export MOZ_ACCELERATED=1
export MOZ_DISABLE_CONTENT_SANDBOX=1
export MOZ_DISABLE_GMP_SANDBOX=1
export MOZ_DISABLE_GPU_SANDBOX=1
export MOZ_DISABLE_RDD_SANDBOX=1
export MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1
export JSGC_DISABLE_POISONING=1
export DYLD_INSERT_LIBRARIES="\$T_MACOS/libfishtools_bridge.dylib"

"\$GECKO_BIN" --no-remote -profile "$PROFILE_DIR" "\$LOADER_URL" &
FF_PID=\$!
echo "\$FF_PID" > "$APP_DATA_DIR/ff.pid"

if [ "\$MODE_FLAG" != "--managed-by-cocoa" ]; then
  "$SCRIPT_DIR/window-watchdog" "\$FF_PID"
fi
`;

  const launcherShPath = path.join(macosDir, 'gecko-launcher.sh');
  fs.writeFileSync(launcherShPath, launcherSh, { mode: 0o755 });

  // 7. Compile Native Cocoa Bridge Dylib (libfishtools_bridge.dylib)
  const bridgeObjcSource = `
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdlib.h>
#include <string.h>

@interface FishToolsCocoaBridge : NSObject
+ (instancetype)sharedInstance;
- (void)handleGetURLEvent:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)replyEvent;
- (NSMenu *)buildCleanMainMenu;
@end

static void (*gOrigSetEventHandler)(id, SEL, id, SEL, AEEventClass, AEEventID) = NULL;
static id gGeckoURLHandler = nil;
static SEL gGeckoURLSelector = NULL;

static void swizzled_setEventHandler(id self, SEL _cmd, id handler, SEL selector, AEEventClass eventClass, AEEventID eventID) {
    if (eventClass == kInternetEventClass && eventID == kAEGetURL) {
        FishToolsCocoaBridge *bridge = [FishToolsCocoaBridge sharedInstance];
        if (handler && handler != bridge) {
            gGeckoURLHandler = handler;
            gGeckoURLSelector = selector;
        }
        if (gOrigSetEventHandler) {
            gOrigSetEventHandler(self, _cmd, bridge, @selector(handleGetURLEvent:withReplyEvent:), eventClass, eventID);
        }
        return;
    }
    if (gOrigSetEventHandler) {
        gOrigSetEventHandler(self, _cmd, handler, selector, eventClass, eventID);
    }
}

@implementation FishToolsCocoaBridge

+ (void)load {
    unsetenv("DYLD_INSERT_LIBRARIES");

    NSString *procName = [[NSProcessInfo processInfo] processName];
    if (procName && ([procName rangeOfString:@"plugin" options:NSCaseInsensitiveSearch].location != NSNotFound ||
                     [procName rangeOfString:@"helper" options:NSCaseInsensitiveSearch].location != NSNotFound)) {
        return;
    }

    // Swizzle NSAppleEventManager so we rewrite ofts:// deep links to https://studio.cutefish.my.id/?import=
    Method m = class_getInstanceMethod([NSAppleEventManager class], @selector(setEventHandler:andSelector:forEventClass:andEventID:));
    if (m) {
        gOrigSetEventHandler = (void (*)(id, SEL, id, SEL, AEEventClass, AEEventID))method_getImplementation(m);
        method_setImplementation(m, (IMP)swizzled_setEventHandler);
    }

    FishToolsCocoaBridge *bridge = [FishToolsCocoaBridge sharedInstance];
    [[NSAppleEventManager sharedAppleEventManager]
        setEventHandler:bridge
        andSelector:@selector(handleGetURLEvent:withReplyEvent:)
        forEventClass:kInternetEventClass
        andEventID:kAEGetURL];

    dispatch_async(dispatch_get_main_queue(), ^{
        [bridge installHooks];
    });
}

+ (instancetype)sharedInstance {
    static FishToolsCocoaBridge *inst = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        inst = [[FishToolsCocoaBridge alloc] init];
    });
    return inst;
}

- (void)installHooks {
    [[NSAppleEventManager sharedAppleEventManager]
        setEventHandler:self
        andSelector:@selector(handleGetURLEvent:withReplyEvent:)
        forEventClass:kInternetEventClass
        andEventID:kAEGetURL];

    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self selector:@selector(onAppUpdate:) name:NSApplicationDidFinishLaunchingNotification object:nil];
    [nc addObserver:self selector:@selector(onAppUpdate:) name:NSApplicationDidBecomeActiveNotification object:nil];
    [nc addObserver:self selector:@selector(onAppUpdate:) name:NSWindowDidBecomeKeyNotification object:nil];

    // Block all Firefox browser keyboard shortcuts (Cmd+T, Cmd+N, Cmd+O, Cmd+P, Cmd+,, Cmd+U, Cmd+L, Cmd+J, Cmd+B, Cmd+I)
    // and make Cmd+W terminate the app cleanly instead of closing the internal tab
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        NSEventModifierFlags flags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
        if (flags & NSEventModifierFlagCommand) {
            NSString *chars = [[event charactersIgnoringModifiers] lowercaseString];
            if (chars.length > 0) {
                unichar c = [chars characterAtIndex:0];
                if (c == 'w' || c == 'q') {
                    [NSApp terminate:nil];
                    return nil;
                }
                if (c == 't' || c == 'n' || c == 'o' || c == 'p' || c == ',' ||
                    c == 'u' || c == 'l' || c == 'j' || c == 'b' || c == 'i' ||
                    c == 'r' || c == 's' || c == 'f' || c == '[' || c == ']') {
                    return nil;
                }
            }
        }
        return event;
    }];

    [NSTimer scheduledTimerWithTimeInterval:0.20
                                     target:self
                                   selector:@selector(sanitizeMenuAndWindows)
                                   userInfo:nil
                                    repeats:YES];
}

- (void)onAppUpdate:(NSNotification *)note {
    [self sanitizeMenuAndWindows];
}

- (NSString *)extractPresetIdFromUrl:(NSString *)rawUrl {
    if (!rawUrl || rawUrl.length == 0) return @"";
    NSString *s = [rawUrl stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSRegularExpression *rePrefix = [NSRegularExpression regularExpressionWithPattern:@"^.*(?:ofts|fishtools)://(?:import/|project/|p/)?" options:NSRegularExpressionCaseInsensitive error:nil];
    s = [rePrefix stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@""];
    NSRegularExpression *reHttp = [NSRegularExpression regularExpressionWithPattern:@"^https?://studio\\\\.cutefish\\\\.my\\\\.id/(?:import/|project/|p/)?" options:NSRegularExpressionCaseInsensitive error:nil];
    s = [reHttp stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@""];
    NSRegularExpression *reSuffix = [NSRegularExpression regularExpressionWithPattern:@"[/?#].*$" options:0 error:nil];
    s = [reSuffix stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@""];
    NSRegularExpression *reClean = [NSRegularExpression regularExpressionWithPattern:@"[^a-zA-Z0-9_-]" options:0 error:nil];
    s = [reClean stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@""];
    return s ?: @"";
}

- (void)writeDeepLinkOnceFile:(NSString *)rawUrl {
    if (!rawUrl || rawUrl.length == 0) return;
    NSString *appDataDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches/com.cutefishaep.ofts"];
    [[NSFileManager defaultManager] createDirectoryAtPath:appDataDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *oncePath = [appDataDir stringByAppendingPathComponent:@"deeplink.once"];
    [rawUrl writeToFile:oncePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

- (void)handleGetURLEvent:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)replyEvent {
    NSString *urlStr = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
    if (!urlStr || urlStr.length == 0) return;
    [self writeDeepLinkOnceFile:urlStr];

    NSString *presetId = [self extractPresetIdFromUrl:urlStr];
    NSString *targetUrl = presetId.length > 0
        ? [NSString stringWithFormat:@"https://studio.cutefish.my.id/?import=%@", presetId]
        : @"https://studio.cutefish.my.id/";

    if (gGeckoURLHandler && gGeckoURLSelector && [gGeckoURLHandler respondsToSelector:gGeckoURLSelector]) {
        @try {
            [event setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:targetUrl] forKeyword:keyDirectObject];
            typedef void (*AppleEventIMP)(id, SEL, NSAppleEventDescriptor *, NSAppleEventDescriptor *);
            AppleEventIMP imp = (AppleEventIMP)[gGeckoURLHandler methodForSelector:gGeckoURLSelector];
            if (imp) {
                imp(gGeckoURLHandler, gGeckoURLSelector, event, replyEvent);
            }
        } @catch (NSException * _) {}
    }

    [NSApp activateIgnoringOtherApps:YES];
    for (NSWindow *win in [NSApp windows]) {
        if ([win canBecomeKeyWindow] || [win isVisible]) {
            [win makeKeyAndOrderFront:nil];
            [win orderFrontRegardless];
        }
    }
}

- (void)showNativeAboutPanel:(id)sender {
    NSDictionary *opts = @{
        NSAboutPanelOptionApplicationName: @"FishTools Studio",
        NSAboutPanelOptionApplicationVersion: @"${version}",
        NSAboutPanelOptionVersion: @"${version}",
        @"Copyright": @"© 2026 Cutefish AEP / OpenFishTools"
    };
    [NSApp orderFrontStandardAboutPanelWithOptions:opts];
}

- (NSMenu *)buildCleanMainMenu {
    NSMenu *bar = [[NSMenu alloc] initWithTitle:@"MainMenu"];

    // 1. FishTools Studio (App Menu)
    NSMenuItem *appBarItem = [[NSMenuItem alloc] initWithTitle:@"FishTools Studio" action:nil keyEquivalent:@""];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"FishTools Studio"];

    NSMenuItem *aboutItem = [[NSMenuItem alloc] initWithTitle:@"About FishTools Studio"
                                                       action:@selector(showNativeAboutPanel:)
                                                keyEquivalent:@""];
    aboutItem.target = self;
    [appMenu addItem:aboutItem];
    [appMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *hideItem = [[NSMenuItem alloc] initWithTitle:@"Hide FishTools Studio"
                                                      action:@selector(hide:)
                                               keyEquivalent:@"h"];
    hideItem.target = NSApp;
    [appMenu addItem:hideItem];

    NSMenuItem *hideOthersItem = [[NSMenuItem alloc] initWithTitle:@"Hide Others"
                                                            action:@selector(hideOtherApplications:)
                                                     keyEquivalent:@"h"];
    hideOthersItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
    hideOthersItem.target = NSApp;
    [appMenu addItem:hideOthersItem];

    NSMenuItem *showAllItem = [[NSMenuItem alloc] initWithTitle:@"Show All"
                                                         action:@selector(unhideAllApplications:)
                                                  keyEquivalent:@""];
    showAllItem.target = NSApp;
    [appMenu addItem:showAllItem];
    [appMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit FishTools Studio"
                                                      action:@selector(terminate:)
                                               keyEquivalent:@"q"];
    quitItem.target = NSApp;
    [appMenu addItem:quitItem];

    appBarItem.submenu = appMenu;
    [bar addItem:appBarItem];

    // 2. Edit Menu (so Cmd+Z/X/C/V/A work inside inputs and Studio canvas)
    NSMenuItem *editBarItem = [[NSMenuItem alloc] initWithTitle:@"Edit" action:nil keyEquivalent:@""];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    NSMenuItem *redoItem = [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
    redoItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    editBarItem.submenu = editMenu;
    [bar addItem:editBarItem];

    // 3. Window Menu
    NSMenuItem *winBarItem = [[NSMenuItem alloc] initWithTitle:@"Window" action:nil keyEquivalent:@""];
    NSMenu *winMenu = [[NSMenu alloc] initWithTitle:@"Window"];
    [winMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [winMenu addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
    NSMenuItem *fsItem = [winMenu addItemWithTitle:@"Toggle Full Screen" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];
    fsItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
    [winMenu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *closeItem = [[NSMenuItem alloc] initWithTitle:@"Close Window" action:@selector(terminate:) keyEquivalent:@"w"];
    closeItem.target = NSApp;
    [winMenu addItem:closeItem];
    winBarItem.submenu = winMenu;
    [bar addItem:winBarItem];

    return bar;
}

- (void)sanitizeMenuAndWindows {
    static BOOL inSanitize = NO;
    if (inSanitize) return;
    inSanitize = YES;
    @try {
        static BOOL iconSet = NO;
        if (!iconSet && NSApp) {
            NSString *icnsPath = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"icon.icns"];
            if ([[NSFileManager defaultManager] fileExistsAtPath:icnsPath]) {
                NSImage *img = [[NSImage alloc] initWithContentsOfFile:icnsPath];
                if (img) {
                    [NSApp setApplicationIconImage:img];
                    iconSet = YES;
                }
            }
        }

        NSMenu *mainMenu = [NSApp mainMenu];
        BOOL needsCleanMenu = (!mainMenu || mainMenu.numberOfItems != 3);
        if (!needsCleanMenu && mainMenu.numberOfItems == 3) {
            NSMenuItem *first = [mainMenu itemAtIndex:0];
            NSMenuItem *second = [mainMenu itemAtIndex:1];
            NSMenuItem *third = [mainMenu itemAtIndex:2];
            if (![first.title isEqualToString:@"FishTools Studio"] ||
                ![second.title isEqualToString:@"Edit"] ||
                ![third.title isEqualToString:@"Window"] ||
                (first.submenu && first.submenu.numberOfItems != 7)) {
                needsCleanMenu = YES;
            }
        }
        if (needsCleanMenu && NSApp) {
            [NSApp setMainMenu:[self buildCleanMainMenu]];
        }

        for (NSWindow *win in [NSApp windows]) {
            NSString *wTitle = win.title;
            if (!wTitle || wTitle.length == 0 || [wTitle rangeOfString:@"Firefox"].location != NSNotFound || [wTitle rangeOfString:@"Mozilla"].location != NSNotFound) {
                win.title = @"FishTools Studio";
            }
        }
    } @finally {
        inSanitize = NO;
    }
}

@end
`;
  const bridgeMPath = path.join(OUT_DIR, 'bridge.m');
  const bridgeDylibPath = path.join(macosDir, 'libfishtools_bridge.dylib');
  fs.writeFileSync(bridgeMPath, bridgeObjcSource, 'utf8');
  execSync(`clang -dynamiclib -O2 -fobjc-arc -mmacosx-version-min=10.15 -arch x86_64 -arch arm64 -framework Cocoa -framework CoreFoundation "${bridgeMPath}" -o "${bridgeDylibPath}"`);
  fs.unlinkSync(bridgeMPath);
  fs.chmodSync(bridgeDylibPath, 0o755);

  // 8. Compile Window Watchdog
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

  // 9. Compile Main Executable (Contents/MacOS/fishtools-studio)
  const objcSource = `
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <mach-o/dyld.h>
#include <libgen.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>

static void write_deeplink_once(NSString *rawUrl, NSString *appDataDir) {
    if (!rawUrl || rawUrl.length == 0) return;
    [[NSFileManager defaultManager] createDirectoryAtPath:appDataDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *oncePath = [appDataDir stringByAppendingPathComponent:@"deeplink.once"];
    [rawUrl writeToFile:oncePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

int main(int argc, char *argv[]) {
    @autoreleasepool {
        NSString *appDataDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches/com.cutefishaep.ofts"];
        NSString *profileDir = [appDataDir stringByAppendingPathComponent:@"gecko-profile"];
        NSString *pidFile = [appDataDir stringByAppendingPathComponent:@"ff.pid"];

        NSString *incomingUrl = @"";
        for (int i = 1; i < argc; i++) {
            if (argv[i] && argv[i][0] != '-') {
                incomingUrl = [NSString stringWithUTF8String:argv[i]];
                break;
            }
        }

        NSString *pidStr = [NSString stringWithContentsOfFile:pidFile encoding:NSUTF8StringEncoding error:nil];
        if (pidStr) {
            pid_t existingPid = (pid_t)[pidStr intValue];
            if (existingPid > 0 && existingPid != getpid() && kill(existingPid, 0) == 0) {
                if (incomingUrl.length > 0) {
                    write_deeplink_once(incomingUrl, appDataDir);
                }
                NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:existingPid];
                if (running) {
                    [running activateWithOptions:(NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps)];
                    return 0;
                }
            }
        }

        char exe_path[4096];
        uint32_t size = sizeof(exe_path);
        if (_NSGetExecutablePath(exe_path, &size) != 0) {
            return 1;
        }
        NSString *macosDir = [[NSString stringWithUTF8String:exe_path] stringByDeletingLastPathComponent];
        NSString *scriptPath = [macosDir stringByAppendingPathComponent:@"gecko-launcher.sh"];
        NSString *watchdogBin = [macosDir stringByAppendingPathComponent:@"window-watchdog"];

        NSTask *prepTask = [[NSTask alloc] init];
        [prepTask setLaunchPath:@"/bin/bash"];
        [prepTask setArguments:@[scriptPath, incomingUrl, @"--prepare-only"]];
        @try {
            [prepTask launch];
            [prepTask waitUntilExit];
            if ([prepTask terminationStatus] != 0) {
                return 1;
            }
        } @catch (NSException *e) {
            return 1;
        }

        NSString *geckoBin = [NSString stringWithContentsOfFile:[appDataDir stringByAppendingPathComponent:@"gecko_bin.path"] encoding:NSUTF8StringEncoding error:nil];
        NSString *bridgeDylib = [NSString stringWithContentsOfFile:[appDataDir stringByAppendingPathComponent:@"bridge_dylib.path"] encoding:NSUTF8StringEncoding error:nil];
        if (!geckoBin || geckoBin.length == 0) {
            geckoBin = [macosDir stringByAppendingPathComponent:@"fishtools-gecko"];
        }
        if (!bridgeDylib || bridgeDylib.length == 0) {
            bridgeDylib = [macosDir stringByAppendingPathComponent:@"libfishtools_bridge.dylib"];
        }

        NSString *loaderUrlFile = [appDataDir stringByAppendingPathComponent:@"loader.url"];
        NSString *loaderUrl = [NSString stringWithContentsOfFile:loaderUrlFile encoding:NSUTF8StringEncoding error:nil];
        if (!loaderUrl || loaderUrl.length == 0) {
            loaderUrl = @"https://studio.cutefish.my.id/";
        }

        pid_t selfPid = getpid();
        [[NSString stringWithFormat:@"%d\\n", selfPid] writeToFile:pidFile atomically:YES encoding:NSUTF8StringEncoding error:nil];

        pid_t child = fork();
        if (child == 0) {
            setsid();
            NSString *pidArg = [NSString stringWithFormat:@"%d", selfPid];
            execl([watchdogBin UTF8String], "window-watchdog", [pidArg UTF8String], (char *)NULL);
            _exit(0);
        }

        setenv("MOZ_WEBRENDER", "1", 1);
        setenv("MOZ_ACCELERATED", "1", 1);
        setenv("MOZ_DISABLE_CONTENT_SANDBOX", "1", 1);
        setenv("MOZ_DISABLE_GMP_SANDBOX", "1", 1);
        setenv("MOZ_DISABLE_GPU_SANDBOX", "1", 1);
        setenv("MOZ_DISABLE_RDD_SANDBOX", "1", 1);
        setenv("MOZ_DISABLE_SOCKET_PROCESS_SANDBOX", "1", 1);
        setenv("JSGC_DISABLE_POISONING", "1", 1);
        setenv("DYLD_INSERT_LIBRARIES", [bridgeDylib UTF8String], 1);

        const char *geckoCPath = [geckoBin UTF8String];
        const char *profCPath = [profileDir UTF8String];
        const char *urlCStr = [loaderUrl UTF8String];

        char *const geckoArgs[] = {
            (char *)geckoCPath,
            (char *)"--no-remote",
            (char *)"-profile",
            (char *)profCPath,
            (char *)urlCStr,
            NULL
        };

        execv(geckoCPath, geckoArgs);
        return 1;
    }
}
`;
  const objcFilePath = path.join(OUT_DIR, 'main.m');
  const binPath = path.join(macosDir, 'fishtools-studio');
  fs.writeFileSync(objcFilePath, objcSource, 'utf8');
  execSync(`clang -O2 -fobjc-arc -mmacosx-version-min=10.15 -arch x86_64 -arch arm64 -framework Cocoa -framework CoreFoundation "${objcFilePath}" -o "${binPath}"`);
  fs.unlinkSync(objcFilePath);
  fs.chmodSync(binPath, 0o755);

  // 10. Ad-Hoc Code Signing
  const entitlementsPath = path.join(OUT_DIR, 'entitlements.plist');
  fs.writeFileSync(entitlementsPath, entitlementsXml, 'utf8');
  execSync(`xattr -cr "${APP_PATH}" 2>/dev/null || true`);
  execSync(`/usr/bin/codesign --force --sign - "${launcherShPath}"`);
  execSync(`/usr/bin/codesign --force --sign - "${bridgeDylibPath}"`);
  execSync(`/usr/bin/codesign --force --sign - --entitlements "${entitlementsPath}" "${watchdogBinPath}"`);
  execSync(`/usr/bin/codesign --force --sign - --entitlements "${entitlementsPath}" "${binPath}"`);
  execSync(`/usr/bin/codesign --force --sign - --entitlements "${entitlementsPath}" "${APP_PATH}"`);
  fs.unlinkSync(entitlementsPath);

  // 11. Package into compressed UDZO .dmg (~15 MB)
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
