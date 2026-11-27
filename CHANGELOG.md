# Changelog

## v0.7.1

- Rebuild Standalone app dengan **Tauri v2** (Windows x64 & Android arm64-v8a).
- Studio diambil langsung dari `openfishtools/Studio` (`main`) dan di-cache secara lokal (offline-ready + auto-update).
- Penyimpanan project & media langsung ke disk lokal (bukan IndexedDB WebView).
- 2-tier preview cache (Hot VRAM + Cold disk cache lokal) dengan auto-clear saat keluar project atau cache dimatikan.
- Dukungan native FFmpeg (Windows `ffmpeg.exe` & Android `ffmpeg-kit-min-gpl`) dan streaming export langsung ke disk.
- Fix deep-link preset saat cold start, fix binary IPC di Android, dan penandatanganan APK release dengan Release Keystore.
