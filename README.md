# FishTools Studio — Standalone Builder

Build components for packaging **FishTools Studio** (`com.cutefishaep.ofts`) on macOS, Windows, and Android.

## Structure

- `shell/` — Offline loader (`loader.html`), deep link handler (`deeplink.js`), and auto-update bootstrap (`shell.js`).
- `scripts/`
  - `generate-manifest.js` — Stages the `Studio` web application and generates `shell/manifest.json`.
  - `build-mac.js` — Builds Universal (`x86_64` + `arm64`) `FishTools Studio.app` and `.dmg` installer with `/Applications` shortcut.
  - `build-win.js` — Builds Windows `x64` Setup installer (with Control Panel uninstaller registration), standalone uninstaller, and portable `.zip`.
  - `build-android.js` — Builds signed Android `.apk` (`v1 + v2 + v3` signatures) with App Links support for `studio.cutefish.my.id`.
- `icons/` — Application icons (`.icns`, `.ico`, `.png`).
- `certs/` — Signing certificates for Windows and Android packages.

## Build Commands

```bash
# Build all platforms
npm run build

# Build individual platform
npm run build:mac
npm run build:win
npm run build:android
```

## Outputs

- **macOS:** `dist-mac/FishTools_Studio_<version>_macOS_Universal.dmg`
- **Windows:** `dist-win/FishTools_Studio_<version>_Windows_x64_Setup.exe` & `dist-win/FishTools_Studio_<version>_Windows_x64_Portable.zip`
- **Android:** `dist-android/FishTools_Studio_<version>_Android.apk`
