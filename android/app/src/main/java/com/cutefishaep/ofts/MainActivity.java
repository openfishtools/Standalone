package com.cutefishaep.ofts;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import com.facebook.react.ReactActivity;
import com.facebook.react.ReactActivityDelegate;
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint;
import com.facebook.react.defaults.DefaultReactActivityDelegate;

public class MainActivity extends ReactActivity {

  @Override
  protected String getMainComponentName() {
    return "FishToolsStudio";
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Force Hardware Acceleration & High-Performance GPU rendering
    getWindow().setFlags(
        WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
    );

    // Keep screen on during active studio editing session if desired
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    // Enable Chromium WebView debugging in development
    WebView.setWebContentsDebuggingEnabled(true);
  }

  @Override
  protected ReactActivityDelegate createReactActivityDelegate() {
    return new DefaultReactActivityDelegate(
        this,
        getMainComponentName(),
        DefaultNewArchitectureEntryPoint.getFabricEnabled());
  }
}
