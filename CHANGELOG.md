# Changelog

## v0.7.5

- Sinkronisasi versi dengan FishTools Studio v0.7.5.

## v0.7.4

- **Binary 3D Model Storage (`OF3D`) di `bridge/ofts-native.js`**: Memisahkan `modelData` 3D (`.zip`/`.fbx`/`.obj`) dari `.meta.json` ke file biner kompak `{id}.bin` (`packModelDataBin` / `unpackModelDataBin`) sehingga tidak lagi memicu blank hitam/hang WebView akibat `JSON.stringify`/`JSON.parse` jutaan angka geometri.
- **Standalone App Update Checker (`bridge/ofts-native.js`)**: Menambahkan `window.OFTSNative.checkAppUpdate()` & auto-check ringan ke GitHub Releases saat Dashboard dibuka, dengan banner flat bertema aplikasi dan tombol download otomatis sesuai platform (`setup.exe` untuk Windows / `.apk` untuk Android).

## v0.7.2

- Fix performa Windows WebView2 yang sempat fallback ke software rendering (menghapus flag `--enable-zero-copy`, `--force_high_performance_gpu`, dan `--ignore-gpu-blocklist` di `tauri.conf.json`).
- Sinkronisasi versi otomatis dengan `openfishtools/Studio` (`v0.7.2`).

## v0.7.1

- Rebuild Standalone app dengan **Tauri v2** (Windows x64 & Android arm64-v8a).
- Studio diambil langsung dari `openfishtools/Studio` (`main`) dan di-cache secara lokal (offline-ready + auto-update).
- Penyimpanan project & media langsung ke disk lokal (bukan IndexedDB WebView).
- 2-tier preview cache (Hot VRAM + Cold disk cache lokal) dengan auto-clear saat keluar project atau cache dimatikan.
- Dukungan native FFmpeg (Windows `ffmpeg.exe` & Android `ffmpeg-kit-min-gpl`) dan streaming export langsung ke disk.
- Fix deep-link preset saat cold start, fix binary IPC di Android, dan penandatanganan APK release dengan Release Keystore.
