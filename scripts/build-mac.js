/**
 * FishTools Studio — macOS Universal Builder (arm64 + x86_64)
 *
 * Compiles a native Universal binary macOS Application with Metal-accelerated
 * WebKit runtime, embeds the synchronized Studio assets with offline fallback,
 * and packages a DMG installer with an /Applications symlink.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { syncStudio } = require('./sync-studio');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'dist-mac');
const APP_NAME = 'FishTools Studio.app';
const APP_PATH = path.join(OUT_DIR, APP_NAME);

function buildMacUniversal() {
  const t0 = Date.now();
  console.log('====================================================');
  console.log('🐟 Building FishTools Studio for macOS Universal');
  console.log('====================================================');

  // 1. Ensure latest Studio assets are synchronized
  const manifest = syncStudio();
  const version = manifest.version || '0.6.5';
  const dmgName = `FishTools_Studio_${version}_macOS_Universal.dmg`;
  const dmgPath = path.join(OUT_DIR, dmgName);

  // 2. Prepare directory structure
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const contentsDir = path.join(APP_PATH, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const appRuntimeDir = path.join(resourcesDir, 'app');

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(appRuntimeDir, { recursive: true });

  // 3. Copy Application Icons
  const icnsSrc = path.join(ROOT_DIR, 'icons/icon.icns');
  if (fs.existsSync(icnsSrc)) {
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'icon.icns'));
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'app.icns'));
  }

  // 4. Create Localized Strings
  for (const lang of ['en.lproj', 'id.lproj']) {
    const lprojDir = path.join(resourcesDir, lang);
    fs.mkdirSync(lprojDir, { recursive: true });
    fs.writeFileSync(
      path.join(lprojDir, 'InfoPlist.strings'),
      `CFBundleDisplayName = "FishTools Studio";\nCFBundleName = "FishTools Studio";\n`,
      'utf8'
    );
  }

  // 5. Create Info.plist with Full Metal GPU Priority and Permissions
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>FishTools Studio</string>
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
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <!-- Force High-Performance Dedicated GPU & Metal Hardware Pipeline -->
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <false/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>com.cutefishaep.ofts</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>fishtools</string>
        <string>openfishtools</string>
      </array>
    </dict>
  </array>
</dict>
</plist>`;
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist, 'utf8');

  // 6. Copy Studio web bundle into Resources/app
  const stagingDir = path.join(ROOT_DIR, 'src/assets/studio');
  if (fs.existsSync(stagingDir)) {
    fs.cpSync(stagingDir, appRuntimeDir, { recursive: true });
    console.log('[macOS] Bundled Studio production assets into Contents/Resources/app');
  }

  // 7. Compile Native Universal Binary (arm64 + x86_64) with Metal WebKit host
  const nativeLauncherSrc = path.join(ROOT_DIR, 'macos/FishToolsStudio/main.mm');
  const nativeLauncherCode = `
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface FishStudioWindowDelegate : NSObject <NSWindowDelegate>
@end
@implementation FishStudioWindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender {
  [NSApp terminate:nil];
  return YES;
}
@end

@interface FishStudioApp : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property (strong) NSWindow *window;
@property (strong) WKWebView *webView;
@property (strong) FishStudioWindowDelegate *winDelegate;
@end

@implementation FishStudioApp

- (void)applicationDidFinishLaunching:(NSNotification *)aNotification {
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

  NSRect screenRect = [[NSScreen mainScreen] visibleFrame];
  CGFloat width = MIN(1440.0, screenRect.size.width * 0.9);
  CGFloat height = MIN(920.0, screenRect.size.height * 0.9);
  NSRect winRect = NSMakeRect((screenRect.size.width - width) / 2.0,
                              (screenRect.size.height - height) / 2.0,
                              width, height);

  NSWindowStyleMask style = NSWindowStyleMaskTitled |
                            NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable |
                            NSWindowStyleMaskFullSizeContentView;

  self.window = [[NSWindow alloc] initWithContentRect:winRect
                                            styleMask:style
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.winDelegate = [[FishStudioWindowDelegate alloc] init];
  self.window.delegate = self.winDelegate;
  [self.window setTitle:@"FishTools Studio"];
  self.window.titleVisibility = NSWindowTitleHidden;
  self.window.titlebarAppearsTransparent = YES;
  self.window.backgroundColor = [NSColor colorWithCalibratedRed:0.04 green:0.06 blue:0.09 alpha:1.0];
  [self.window setMinSize:NSMakeSize(960, 600)];

  // Configure WebKit with Full Metal GPU Acceleration
  WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
  WKUserContentController *userContent = [[WKUserContentController alloc] init];
  [userContent addScriptMessageHandler:self name:@"fishNative"];
  config.userContentController = userContent;

  WKPreferences *prefs = config.preferences;
  @try {
    [prefs setValue:@YES forKey:@"webGLEnabled"];
    [prefs setValue:@YES forKey:@"acceleratedDrawingEnabled"];
    [prefs setValue:@YES forKey:@"canvasUsesAcceleratedDrawing"];
    [prefs setValue:@YES forKey:@"webGPUEnabled"];
    [prefs setValue:@YES forKey:@"developerExtrasEnabled"];
  } @catch (NSException *e) {}

  [config setValue:@YES forKey:@"allowUniversalAccessFromFileURLs"];
  [config.preferences setValue:@YES forKey:@"allowFileAccessFromFileURLs"];

  self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
  self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.webView.navigationDelegate = self;
  self.webView.UIDelegate = self;
  [self.window.contentView addSubview:self.webView];

  // Resolve target URL: official cloud endpoint with fallback to bundled local Studio
  NSString *resourcePath = [[NSBundle mainBundle] resourcePath];
  NSString *localIndexPath = [resourcePath stringByAppendingPathComponent:@"app/index.html"];

  NSURL *cloudUrl = [NSURL URLWithString:@"https://studio.cutefish.my.id"];
  NSURLRequest *cloudRequest = [NSURLRequest requestWithURL:cloudUrl cachePolicy:NSURLRequestUseProtocolCachePolicy timeoutInterval:5.0];

  NSLog(@"[FishTools Studio] Attempting to connect to official cloud or local bundle...");
  [self.webView loadRequest:cloudRequest];

  // Setup Menu
  NSMenu *menubar = [[NSMenu alloc] init];
  NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
  [menubar addItem:appMenuItem];
  [NSApp setMainMenu:menubar];

  NSMenu *appMenu = [[NSMenu alloc] init];
  NSString *quitTitle = @"Quit FishTools Studio";
  NSMenuItem *quitMenuItem = [[NSMenuItem alloc] initWithTitle:quitTitle action:@selector(terminate:) keyEquivalent:@"q"];
  [appMenu addItem:quitMenuItem];
  [appMenuItem setSubmenu:appMenu];

  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  NSLog(@"[FishTools Studio] Cloud endpoint unreachable (%@), falling back to embedded local Studio bundle...", error.localizedDescription);
  NSString *resourcePath = [[NSBundle mainBundle] resourcePath];
  NSString *localIndexPath = [resourcePath stringByAppendingPathComponent:@"app/index.html"];
  NSURL *fileUrl = [NSURL fileURLWithPath:localIndexPath];
  NSURL *readAccessUrl = [NSURL fileURLWithPath:[resourcePath stringByAppendingPathComponent:@"app"]];
  [self.webView loadFileURL:fileUrl allowingReadAccessToURL:readAccessUrl];
}

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
  NSLog(@"[FishTools Native Message] %@", message.body);
}

@end

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    FishStudioApp *delegate = [[FishStudioApp alloc] init];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
`;
  fs.mkdirSync(path.dirname(nativeLauncherSrc), { recursive: true });
  fs.writeFileSync(nativeLauncherSrc, nativeLauncherCode, 'utf8');

  // Compile universal binary: x86_64 + arm64
  const binDest = path.join(macosDir, 'FishTools Studio');
  const binArm64 = path.join(OUT_DIR, 'launcher-arm64');
  const binX86 = path.join(OUT_DIR, 'launcher-x86_64');

  console.log('[macOS] Compiling Universal binary with clang (Metal + Cocoa + WebKit)...');
  try {
    execSync(`clang -arch arm64 -O2 -fmodules -framework Cocoa -framework WebKit -mmacosx-version-min=11.0 "${nativeLauncherSrc}" -o "${binArm64}"`, { stdio: 'inherit' });
    execSync(`clang -arch x86_64 -O2 -fmodules -framework Cocoa -framework WebKit -mmacosx-version-min=11.0 "${nativeLauncherSrc}" -o "${binX86}"`, { stdio: 'inherit' });
    execSync(`lipo -create "${binArm64}" "${binX86}" -output "${binDest}"`, { stdio: 'inherit' });
    fs.unlinkSync(binArm64);
    fs.unlinkSync(binX86);
    fs.chmodSync(binDest, 0o755);
  } catch (err) {
    console.warn('[macOS] Universal compilation error, attempting host architecture compilation fallback:', err.message);
    execSync(`clang -O2 -fmodules -framework Cocoa -framework WebKit -mmacosx-version-min=11.0 "${nativeLauncherSrc}" -o "${binDest}"`, { stdio: 'inherit' });
    fs.chmodSync(binDest, 0o755);
  }

  // 8. Sign bundle (Ad-Hoc)
  try {
    execSync(`codesign --force --deep --sign - "${APP_PATH}"`, { stdio: 'ignore' });
    console.log('[macOS] Applied Ad-Hoc code signature to FishTools Studio.app');
  } catch (e) {}

  // 9. Build DMG Installer with /Applications symlink
  console.log('[macOS] Generating DMG installer: ' + dmgName);
  const dmgStaging = path.join(OUT_DIR, 'dmg-staging');
  fs.mkdirSync(dmgStaging, { recursive: true });
  execSync(`cp -R "${APP_PATH}" "${dmgStaging}/"`);
  execSync(`ln -s /Applications "${dmgStaging}/Applications"`);

  try {
    if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);
    execSync(`hdiutil create -volname "FishTools Studio" -srcfolder "${dmgStaging}" -ov -format UDZO "${dmgPath}"`, { stdio: 'ignore' });
    console.log(`[macOS] ✓ Successfully created Universal DMG: ${dmgPath}`);
  } catch (dmgErr) {
    console.warn('[macOS] Warning creating DMG:', dmgErr.message);
  } finally {
    fs.rmSync(dmgStaging, { recursive: true, force: true });
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[macOS] Build completed in ${dt}s. Output: ${APP_PATH}`);
}

if (require.main === module) {
  buildMacUniversal();
}

module.exports = { buildMacUniversal };
