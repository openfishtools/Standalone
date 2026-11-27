# FishTools Studio (Standalone)

Aplikasi native standalone untuk **FishTools Studio** (Windows & Android) berbasis **Tauri v2** + **Rust**.

## Fitur Utama

- **100% GitHub-fetched Studio (Release)**: Build release tidak menanamkan file web Studio di dalam binary/APK. Saat pertama kali dibuka, aplikasi mengunduh `openfishtools/Studio` (`main`) ke cache lokal dan menayangkannya lewat protokol lokal `ofts://` (offline-ready + auto-update).
- **Debug Build dengan Studio Lokal + Perf HUD**: Build debug otomatis menyertakan folder `../Studio` lokal serta overlay FPS/frame-time/VRAM-disk cache.
- **Native Local Disk Storage**: Project dan media disimpan langsung di penyimpanan disk lokal (bebas batas kuota IndexedDB WebView), plus 2-tier preview cache (Hot VRAM + Cold disk cache di `app_cache_dir/preview-cache/`).
- **Native Streaming Export & Native FFmpeg**: Streaming export langsung ke disk dan dukungan FFmpeg native (Windows `ffmpeg.exe` & Android `ffmpeg-kit-min-gpl` JNI).
- **Integrasi OS**: Deep-link (`ofts://`, `fishtools://`, `openfishtools://`), asosiasi file `.ofts`, `Ctrl+S` direct overwrite, dan `Ctrl+Shift+U` untuk pengelola cache/storage/GPU.

## Prasyarat Build

- **Node.js** >= 18
- **Rust** (`rustup` dengan target `x86_64-pc-windows-msvc` dan `aarch64-linux-android`)
- **Windows**: Visual Studio Build Tools 2022 (C++ / MSVC) & WebView2 Runtime
- **Android**: JDK 17 (`JAVA_HOME`), Android SDK (`ANDROID_HOME`), NDK 27 (`NDK_HOME`)

## Perintah Build

```bash
npm install

# Windows
npm run build:win:debug
npm run build:win

# Android (APK)
npm run build:android:debug
npm run build:android
```

Semua hasil build otomatis ditempatkan di `src-tauri/build/{debug,release}/{win,android}/`.

## Android Release Signing

Jalankan script interaktif untuk membuat keystore lokal (di luar repo Git):

```powershell
.\scripts\create-keystore.ps1
```

Script ini membuat `fishtools-release.jks` dan `src-tauri/gen/android/keystore.properties` (keduanya di-gitignore). Untuk CI/GitHub Actions, `build.gradle.kts` juga membaca environment variables `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, dan `KEY_PASSWORD`.

## Code Signing Policy

Free code signing on Windows (when enabled for public releases) is provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). Release binaries are built reproducibly from this public repository without telemetry or third-party trackers.
