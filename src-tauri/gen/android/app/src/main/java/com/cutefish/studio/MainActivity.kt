package com.cutefish.studio

import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.ReturnCode
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : TauriActivity() {
  private var activeWebView: WebView? = null
  @Volatile
  internal var pendingDeepLink: String? = null

  private fun isSupportedDeepLink(uri: String?): Boolean {
    if (uri.isNullOrBlank()) return false
    val lower = uri.lowercase()
    return lower.startsWith("ofts://") ||
      lower.startsWith("fishtools://") ||
      lower.startsWith("openfishtools://")
  }

  private fun dispatchDeepLink(uri: String?) {
    if (!isSupportedDeepLink(uri)) return
    val safeUri = uri!!
    pendingDeepLink = safeUri
    val wv = activeWebView ?: return
    val escaped = safeUri.replace("\\", "\\\\").replace("'", "\\'")
    wv.post {
      val curUrl = wv.url ?: ""
      if (curUrl.contains("ofts.localhost", ignoreCase = true)) {
        pendingDeepLink = null
        wv.evaluateJavascript(
          "try { window.__OFT_DEEPLINK__ = '$escaped'; sessionStorage.setItem('oft_pending_import_id', '$escaped'); if (typeof window.onNativeDeepLinkReceived === 'function') { window.onNativeDeepLinkReceived('$escaped'); } else { window.location.href = 'index.html?deeplink=' + encodeURIComponent('$escaped'); } } catch(e) {}",
          null
        )
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    dispatchDeepLink(intent.dataString)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val bgDark = Color.parseColor("#151B10")
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(bgDark),
      navigationBarStyle = SystemBarStyle.dark(bgDark)
    )
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    requestHighRefreshRate()
    if (isSupportedDeepLink(intent?.dataString)) {
      pendingDeepLink = intent?.dataString
    }

    val contentView = findViewById<View>(android.R.id.content)
    contentView.setBackgroundColor(bgDark)
    ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(contentView)

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = activeWebView
        if (wv != null) {
          wv.post {
            wv.evaluateJavascript(
              "if (typeof window.__OFTS_HANDLE_BACK__ === 'function') { window.__OFTS_HANDLE_BACK__(); } else if (window.AndroidNative) { window.AndroidNative.exitApp(); }",
              null
            )
          }
        } else {
          finish()
        }
      }
    })
  }

  private fun requestHighRefreshRate() {
    try {
      val disp = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        display
      } else {
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay
      } ?: return
      val current = disp.mode
      val best = disp.supportedModes
        .filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
        .maxByOrNull { it.refreshRate }
      if (best != null && best.modeId != current.modeId) {
        val lp = window.attributes
        lp.preferredDisplayModeId = best.modeId
        lp.preferredRefreshRate = best.refreshRate
        window.attributes = lp
      }
    } catch (_: Exception) {}
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    activeWebView = webView
    webView.settings.apply {
      textZoom = 100
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      mediaPlaybackRequiresUserGesture = false
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    webView.addJavascriptInterface(AndroidNativeBridge(this), "AndroidNative")
  }

  private class AndroidNativeBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun publishToDownloads(cachePath: String, displayName: String, mimeType: String): Boolean {
      val srcFile = File(cachePath)
      if (!srcFile.exists()) return false
      return try {
        val resolver = activity.contentResolver
        val isVideo = mimeType.startsWith("video/", ignoreCase = true)
        val collection = if (isVideo) {
          MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        } else {
          MediaStore.Downloads.EXTERNAL_CONTENT_URI
        }
        val relPath = if (isVideo) {
          Environment.DIRECTORY_MOVIES + "/OpenFishTools"
        } else {
          Environment.DIRECTORY_DOWNLOADS + "/OpenFishTools"
        }

        val values = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
          put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
          }
        }

        val uri = resolver.insert(collection, values) ?: return false
        resolver.openOutputStream(uri)?.use { out ->
          srcFile.inputStream().use { input ->
            input.copyTo(out)
          }
        } ?: return false

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val done = ContentValues().apply {
            put(MediaStore.MediaColumns.IS_PENDING, 0)
          }
          resolver.update(uri, done, null, null)
        }

        srcFile.delete()
        activity.runOnUiThread {
          Toast.makeText(activity, "Tersimpan: $displayName", Toast.LENGTH_SHORT).show()
        }
        true
      } catch (e: Exception) {
        activity.runOnUiThread {
          Toast.makeText(activity, "Gagal menyimpan: ${e.message}", Toast.LENGTH_LONG).show()
        }
        false
      }
    }

    @JavascriptInterface
    fun keepScreenOn(enabled: Boolean) {
      activity.runOnUiThread {
        if (enabled) {
          activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }

    @JavascriptInterface
    fun getDiskSpaceJson(path: String): String {
      return try {
        val target = File(path)
        val existing = if (target.exists()) target else activity.filesDir
        val stat = StatFs(existing.absolutePath)
        val free = stat.availableBytes
        val total = stat.totalBytes
        "{\"free\":$free,\"total\":$total}"
      } catch (_: Exception) {
        "{\"free\":0,\"total\":0}"
      }
    }

    @JavascriptInterface
    fun runFFmpeg(workDir: String, argsJson: String): String {
      return try {
        val arr = JSONArray(argsJson)
        val resolved = ArrayList<String>(arr.length() + 1)
        resolved.add("-y")
        var expectInputPath = false
        for (i in 0 until arr.length()) {
          val arg = arr.getString(i)
          val isLastOutput = (i == arr.length() - 1) && !arg.startsWith("-")
          if ((expectInputPath || isLastOutput) && !arg.startsWith("/") && !arg.contains("://")) {
            resolved.add(File(workDir, arg).absolutePath)
            expectInputPath = false
          } else {
            resolved.add(arg)
            expectInputPath = (arg == "-i")
          }
        }
        val session = FFmpegKit.executeWithArguments(resolved.toTypedArray())
        val rc = session.returnCode
        val res = JSONObject()
        if (ReturnCode.isSuccess(rc)) {
          res.put("ok", true)
        } else {
          res.put("ok", false)
          val logs = session.allLogsAsString ?: ""
          res.put("error", "FFmpeg rc=${rc?.value}: ${logs.takeLast(500)}")
        }
        res.toString()
      } catch (e: Exception) {
        val res = JSONObject()
        res.put("ok", false)
        res.put("error", e.message ?: e.toString())
        res.toString()
      }
    }

    @JavascriptInterface
    fun takePendingDeepLink(): String {
      val uri = activity.pendingDeepLink ?: return ""
      activity.pendingDeepLink = null
      return uri
    }

    @JavascriptInterface
    fun exitApp() {
      activity.runOnUiThread {
        activity.finish()
      }
    }
  }
}
