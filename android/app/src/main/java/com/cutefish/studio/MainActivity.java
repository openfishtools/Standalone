package com.cutefish.studio;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST_CODE = 2001;
    private ValueCallback<Uri[]> mFilePathCallback;
    private WebView mWebView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Hardware GPU Acceleration & Fullscreen Studio Viewport
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        mWebView = new WebView(this);
        mWebView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        mWebView.setBackgroundColor(0xFF070A13);

        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // Play-Protect Clean: Do NOT enable allowFileAccessFromFileURLs or allowUniversalAccessFromFileURLs
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setRenderPriority(WebSettings.RenderPriority.HIGH);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        mWebView.setWebViewClient(new WebViewClient());

        // High-Performance WebChromeClient with Full File Upload Support
        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (mFilePathCallback != null) {
                    mFilePathCallback.onReceiveValue(null);
                    mFilePathCallback = null;
                }
                mFilePathCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

                if (fileChooserParams != null && fileChooserParams.getAcceptTypes() != null && fileChooserParams.getAcceptTypes().length > 0) {
                    String[] acceptTypes = fileChooserParams.getAcceptTypes();
                    if (acceptTypes.length == 1 && acceptTypes[0].length() > 0) {
                        intent.setType(acceptTypes[0]);
                    } else if (acceptTypes.length > 1) {
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes);
                    }
                }

                try {
                    startActivityForResult(Intent.createChooser(intent, "Select Media or 3D Model"), FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception e) {
                    if (mFilePathCallback != null) {
                        mFilePathCallback.onReceiveValue(null);
                        mFilePathCallback = null;
                    }
                    return false;
                }
            }
        });

        setContentView(mWebView);

        // Load studio: use deep link intent data if present, otherwise default to official cloud
        String targetUrl = "https://studio.cutefish.my.id";
        Intent intent = getIntent();
        if (intent != null && intent.getDataString() != null) {
            targetUrl = intent.getDataString();
        }
        mWebView.loadUrl(targetUrl);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (mFilePathCallback == null) return;

            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                } else if (data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    int count = clip.getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                }
            }

            mFilePathCallback.onReceiveValue(results);
            mFilePathCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (mWebView != null && mWebView.canGoBack()) {
            mWebView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
