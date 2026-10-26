package com.cutefish.studio;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.LayerDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {
    private static final String TAG = "FishToolsStudio";
    private static final int FILE_CHOOSER_REQUEST_CODE = 2001;
    private static final String PREFS_NAME = "CuteFishStudioPrefs";
    private static final String KEY_INSTALLED_VERSION = "installed_version";
    private static final String BUNDLED_VERSION = "1.2.0";
    private static final String STUDIO_ORIGIN = "studio.cutefish.my.id";
    private static final String BASE_URL = "https://studio.cutefish.my.id/";

    private ValueCallback<Uri[]> mFilePathCallback;
    private WebView mWebView;
    private FrameLayout mRootLayout;
    private LinearLayout mSplashLayout;
    private ProgressBar mProgressBar;
    private TextView mStatusText;
    private TextView mVersionText;
    private Handler mMainHandler;

    private File mUpdateDir;
    private boolean mIsPageLoaded = false;
    private String mPendingDeepLink = null;
    private String mPendingFileContent = null;
    private String mPendingFileName = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        mMainHandler = new Handler(Looper.getMainLooper());
        mUpdateDir = new File(getFilesDir(), "studio_update");

        // 1. Force Pure Black Window Background to prevent any white flash
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setBackgroundDrawable(new ColorDrawable(0xFF000000));
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 2. Build Root Layout
        mRootLayout = new FrameLayout(this);
        mRootLayout.setBackgroundColor(0xFF000000);

        // 3. Initialize WebView with Full GPU Acceleration
        initWebView();
        mRootLayout.addView(mWebView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // 4. Build Simple Dark Minimalist Splash Screen Overlay (#000000)
        buildMinimalistSplash();
        mRootLayout.addView(mSplashLayout, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        setContentView(mRootLayout);

        // 5. Handle Incoming Deep Link / File Intent
        handleIncomingIntent(getIntent());

        // 6. Start In-App OTA Updater in Background Thread (3s fast fallback)
        startBackgroundUpdateCheck();
    }

    private void initWebView() {
        mWebView = new WebView(this);
        mWebView.setBackgroundColor(0xFF000000);
        mWebView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // Security: NO setAllowFileAccessFromFileURLs to keep Google Play Protect clean
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        mWebView.addJavascriptInterface(new AndroidNativeBridge(), "AndroidBridge");

        // WebChromeClient: Enables File & Media Upload
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

        // WebViewClient: Intercepts requests for 100% Offline Support & Persistent Sandbox Storage
        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && STUDIO_ORIGIN.equalsIgnoreCase(uri.getHost())) {
                    String path = uri.getPath();
                    if (path == null || path.isEmpty() || path.equals("/")) {
                        path = "/index.html";
                    }

                    // Deep link presets e.g. /sbMFqQ -> serve index.html (SPA routing)
                    if (!path.contains(".") && !path.startsWith("/api/")) {
                        path = "/index.html";
                    }

                    // Do not intercept cloud API calls
                    if (!path.startsWith("/api/")) {
                        // 1. Check downloaded OTA update files
                        File updatedFile = new File(mUpdateDir, path.startsWith("/") ? path.substring(1) : path);
                        if (updatedFile.exists() && updatedFile.isFile()) {
                            try {
                                String mime = getMimeType(path);
                                return new WebResourceResponse(mime, "UTF-8", new FileInputStream(updatedFile));
                            } catch (Exception ignored) {}
                        }

                        // 2. Fallback to bundled assets in APK (assets/studio/...)
                        String assetPath = "studio" + (path.startsWith("/") ? path : "/" + path);
                        try {
                            InputStream is = getAssets().open(assetPath);
                            String mime = getMimeType(path);
                            return new WebResourceResponse(mime, "UTF-8", is);
                        } catch (Exception ignored) {}
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                mIsPageLoaded = true;

                // Dispatch any pending deep link or file import
                dispatchPendingIntents();

                // Fade out splash screen smoothly
                mMainHandler.postDelayed(() -> {
                    if (mSplashLayout != null && mSplashLayout.getVisibility() == View.VISIBLE) {
                        mSplashLayout.animate()
                            .alpha(0f)
                            .setDuration(250)
                            .withEndAction(() -> mSplashLayout.setVisibility(View.GONE))
                            .start();
                    }
                }, 300);
            }
        });
    }

    private void buildMinimalistSplash() {
        mSplashLayout = new LinearLayout(this);
        mSplashLayout.setOrientation(LinearLayout.VERTICAL);
        mSplashLayout.setGravity(Gravity.CENTER);
        mSplashLayout.setBackgroundColor(0xFF000000);
        mSplashLayout.setClickable(true); // Intercept touches while updating

        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        mSplashLayout.setPadding(pad, pad, pad, pad);

        // App Name Label
        TextView titleText = new TextView(this);
        titleText.setText("FishTools Studio");
        titleText.setTextColor(0xFFFFFFFF);
        titleText.setTextSize(18f);
        titleText.setGravity(Gravity.CENTER);
        titleText.setLetterSpacing(0.05f);

        // Minimalist Progress Bar (#222222 Track, #FFFFFF Fill)
        mProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        mProgressBar.setIndeterminate(false);
        mProgressBar.setMax(100);
        mProgressBar.setProgress(10);

        ColorDrawable bgTrack = new ColorDrawable(0xFF222222);
        ClipDrawable fillTrack = new ClipDrawable(new ColorDrawable(0xFFFFFFFF), Gravity.LEFT, ClipDrawable.HORIZONTAL);
        LayerDrawable progressDraw = new LayerDrawable(new android.graphics.drawable.Drawable[]{ bgTrack, fillTrack });
        progressDraw.setId(0, android.R.id.background);
        progressDraw.setId(1, android.R.id.progress);
        mProgressBar.setProgressDrawable(progressDraw);

        int barWidth = (int) (220 * getResources().getDisplayMetrics().density);
        int barHeight = (int) (3 * getResources().getDisplayMetrics().density);
        LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(barWidth, barHeight);
        barParams.topMargin = (int) (20 * getResources().getDisplayMetrics().density);
        barParams.bottomMargin = (int) (12 * getResources().getDisplayMetrics().density);

        // Status description text
        mStatusText = new TextView(this);
        mStatusText.setText("Checking updates...");
        mStatusText.setTextColor(0xFF888888);
        mStatusText.setTextSize(12f);
        mStatusText.setGravity(Gravity.CENTER);

        // Version badge text
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String currentVer = prefs.getString(KEY_INSTALLED_VERSION, BUNDLED_VERSION);
        mVersionText = new TextView(this);
        mVersionText.setText("v" + currentVer);
        mVersionText.setTextColor(0xFF444444);
        mVersionText.setTextSize(10f);
        mVersionText.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams verParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        verParams.topMargin = (int) (8 * getResources().getDisplayMetrics().density);

        mSplashLayout.addView(titleText);
        mSplashLayout.addView(mProgressBar, barParams);
        mSplashLayout.addView(mStatusText);
        mSplashLayout.addView(mVersionText, verParams);
    }

    private void updateSplashProgress(int pct, String msg) {
        mMainHandler.post(() -> {
            if (mProgressBar != null) mProgressBar.setProgress(pct);
            if (mStatusText != null && msg != null) mStatusText.setText(msg);
        });
    }

    private void startBackgroundUpdateCheck() {
        new Thread(() -> {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String localVersion = prefs.getString(KEY_INSTALLED_VERSION, BUNDLED_VERSION);

            try {
                updateSplashProgress(25, "Checking for updates...");

                // Fast 3-second timeout for online check
                URL url = new URL("https://studio.cutefish.my.id/version.json");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "FishToolsStudio-Android");

                int code = conn.getResponseCode();
                if (code == 200) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) sb.append(line);
                    reader.close();

                    JSONObject json = new JSONObject(sb.toString());
                    String remoteVersion = json.optString("version", json.optString("studioVersion", ""));

                    if (!remoteVersion.isEmpty() && !remoteVersion.equals(localVersion)) {
                        updateSplashProgress(45, "Downloading update v" + remoteVersion + "...");
                        String otaUrl = json.optString("downloadUrl", "https://studio.cutefish.my.id/updates/FishTools_Studio_OTA_v" + remoteVersion + ".zip");
                        boolean ok = downloadAndExtractOta(otaUrl);
                        if (ok) {
                            prefs.edit().putString(KEY_INSTALLED_VERSION, remoteVersion).apply();
                            mMainHandler.post(() -> {
                                if (mVersionText != null) mVersionText.setText("v" + remoteVersion);
                            });
                            updateSplashProgress(100, "Update complete! Loading Studio...");
                        }
                    } else {
                        updateSplashProgress(100, "Ready! Loading Studio...");
                    }
                } else {
                    updateSplashProgress(100, "Offline mode. Loading Studio...");
                }
            } catch (Exception e) {
                Log.d(TAG, "Offline or update check timeout: " + e.getMessage());
                updateSplashProgress(100, "Opening FishTools Studio...");
            }

            // Launch Studio in WebView
            mMainHandler.post(this::loadStudioInWebView);
        }).start();
    }

    private boolean downloadAndExtractOta(String otaUrl) {
        try {
            URL url = new URL(otaUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(30000);
            int totalBytes = conn.getContentLength();
            InputStream in = conn.getInputStream();

            File tmpZip = new File(getFilesDir(), "temp_ota.zip");
            FileOutputStream fos = new FileOutputStream(tmpZip);
            byte[] buf = new byte[8192];
            int read;
            int current = 0;

            while ((read = in.read(buf)) != -1) {
                fos.write(buf, 0, read);
                current += read;
                if (totalBytes > 0) {
                    int pct = 45 + (int) (((float) current / totalBytes) * 45);
                    updateSplashProgress(pct, "Downloading update... (" + (current / 1024) + " KB)");
                }
            }
            fos.close();
            in.close();

            updateSplashProgress(92, "Installing resources...");

            // Safe cleanup: ONLY cleanup studio_update directory, NEVER touch user databases/IndexedDB!
            if (mUpdateDir.exists()) {
                deleteDir(mUpdateDir);
            }
            mUpdateDir.mkdirs();

            // Extract zip
            ZipInputStream zis = new ZipInputStream(new FileInputStream(tmpZip));
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName();
                if (name.contains("..")) continue; // Path traversal protection
                File dest = new File(mUpdateDir, name);
                if (entry.isDirectory()) {
                    dest.mkdirs();
                } else {
                    dest.getParentFile().mkdirs();
                    FileOutputStream out = new FileOutputStream(dest);
                    byte[] b = new byte[8192];
                    int len;
                    while ((len = zis.read(b)) != -1) {
                        out.write(b, 0, len);
                    }
                    out.close();
                }
                zis.closeEntry();
            }
            zis.close();
            tmpZip.delete();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to download/extract OTA update: " + e.getMessage(), e);
            return false;
        }
    }

    private void deleteDir(File dir) {
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.isDirectory()) deleteDir(f);
                else f.delete();
            }
        }
        dir.delete();
    }

    private void loadStudioInWebView() {
        String targetUrl = BASE_URL;
        if (mPendingDeepLink != null) {
            targetUrl = mPendingDeepLink;
        }
        mWebView.loadUrl(targetUrl);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
        if (mIsPageLoaded) {
            dispatchPendingIntents();
        }
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri dataUri = intent.getData();

        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_SEND.equals(action)) {
            if (Intent.ACTION_SEND.equals(action)) {
                dataUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            }
            if (dataUri != null) {
                String uriStr = dataUri.toString();
                if (uriStr.startsWith("http://") || uriStr.startsWith("https://") || uriStr.startsWith("ofts://") || uriStr.startsWith("fishtools://")) {
                    mPendingDeepLink = uriStr;
                } else {
                    // File import (.ofts / .fishpreset / .json)
                    readIncomingFile(dataUri);
                }
            }
        }
    }

    private void readIncomingFile(Uri uri) {
        try {
            InputStream is = getContentResolver().openInputStream(uri);
            if (is == null) return;

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int len;
            while ((len = is.read(buf)) != -1) {
                baos.write(buf, 0, len);
            }
            is.close();

            byte[] bytes = baos.toByteArray();
            mPendingFileContent = Base64.encodeToString(bytes, Base64.NO_WRAP);
            mPendingFileName = "preset_" + System.currentTimeMillis() + ".ofts";

            // Extract real filename if present
            String path = uri.getPath();
            if (path != null && path.contains("/")) {
                String last = path.substring(path.lastIndexOf('/') + 1);
                if (last.toLowerCase().endsWith(".ofts") || last.toLowerCase().endsWith(".fishpreset") || last.toLowerCase().endsWith(".json")) {
                    mPendingFileName = last;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error reading incoming preset file: " + e.getMessage(), e);
        }
    }

    private void dispatchPendingIntents() {
        if (!mIsPageLoaded) return;

        // 1. Dispatch Deep Link URL
        if (mPendingDeepLink != null) {
            final String url = mPendingDeepLink;
            mPendingDeepLink = null;
            mMainHandler.post(() -> {
                String script = "if (typeof window.onNativeDeepLinkReceived === 'function') { window.onNativeDeepLinkReceived('" + url + "'); }";
                mWebView.evaluateJavascript(script, null);
            });
        }

        // 2. Dispatch Native File Import
        if (mPendingFileContent != null) {
            final String name = mPendingFileName != null ? mPendingFileName : "imported.ofts";
            final String b64 = mPendingFileContent;
            mPendingFileContent = null;
            mPendingFileName = null;
            mMainHandler.post(() -> {
                String script = "if (typeof window.importNativeOftsFile === 'function') { " +
                    "window.importNativeOftsFile('" + name + "', '" + b64 + "'); " +
                    "} else { window.__PENDING_NATIVE_FILE__ = { name: '" + name + "', data: '" + b64 + "' }; }";
                mWebView.evaluateJavascript(script, null);
            });
        }
    }

    public class AndroidNativeBridge {
        @JavascriptInterface
        public String getInstalledVersion() {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            return prefs.getString(KEY_INSTALLED_VERSION, BUNDLED_VERSION);
        }

        @JavascriptInterface
        public void checkUpdateNow() {
            startBackgroundUpdateCheck();
        }
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

    private String getMimeType(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".mp4")) return "video/mp4";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".wav")) return "audio/wav";
        if (p.endsWith(".ogg")) return "audio/ogg";
        if (p.endsWith(".glb") || p.endsWith(".gltf")) return "model/gltf-binary";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        return "application/octet-stream";
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
