#import "AppDelegate.h"
#import <WebKit/WebKit.h>

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)aNotification {
  NSRect frame = NSMakeRect(100, 100, 1380, 880);
  NSWindowStyleMask styleMask = NSWindowStyleMaskTitled |
                                NSWindowStyleMaskClosable |
                                NSWindowStyleMaskMiniaturizable |
                                NSWindowStyleMaskResizable |
                                NSWindowStyleMaskFullSizeContentView;

  self.window = [[NSWindow alloc] initWithContentRect:frame
                                            styleMask:styleMask
                                              backing:NSBackingStoreBuffered
                                                defer:NO];

  [self.window setTitle:@"FishTools Studio"];
  [self.window setTitleVisibility:NSWindowTitleHidden];
  [self.window setTitlebarAppearsTransparent:YES];
  [self.window setMinSize:NSMakeSize(960, 640)];
  [self.window center];

  // Configure WebKit with Full Metal GPU Hardware Acceleration
  WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
  WKPreferences *prefs = config.preferences;

  // Enable WebGL 2.0, WebGPU, and Hardware Canvas Compositing
  @try {
    [prefs setValue:@YES forKey:@"webGLEnabled"];
    [prefs setValue:@YES forKey:@"acceleratedDrawingEnabled"];
    [prefs setValue:@YES forKey:@"canvasUsesAcceleratedDrawing"];
    [prefs setValue:@YES forKey:@"webGPUEnabled"];
    [prefs setValue:@YES forKey:@"developerExtrasEnabled"];
  } @catch (NSException *exception) {
    NSLog(@"[FishTools Native macOS] WebKit preference warning: %@", exception);
  }

  // Allow unrestricted local file access for offline Studio bundle
  [config.preferences setValue:@YES forKey:@"allowFileAccessFromFileURLs"];
  [config setValue:@YES forKey:@"allowUniversalAccessFromFileURLs"];

  [self.window makeKeyAndOrderFront:nil];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return YES;
}

@end
