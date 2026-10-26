
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
