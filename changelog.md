# Changelog

## [1.0.2] - 2026-10-16
- Implemented Zero-Copy Skinned Gecko Runtime on macOS (`fishtools-gecko` + `libfishtools_bridge.dylib`) and Windows (`gecko-engine\FishTools Studio.exe` hardlink skinning + `WM_SETICON` & `SetWindowTextW` override) while keeping installers ultra-lightweight (~15 MB macOS, ~13 MB Windows).
- Stripped Firefox branding (`Assets.car`, `*.lproj`, titlebar suffixes, menu bar items, updater, telemetry, and crashreporter) and injected Enterprise Policies (`distribution/policies.json`).
- Included `MOZILLA_MPL_NOTICE.txt` for Mozilla Public License 2.0 & Trademark compliance.
- Moved Local Storage Durability to Settings and added Factory Reset ("Reset") action in Studio.

## [1.0.1] - 2026-10-16
- Set macOS minimum deployment target to macOS 10.15 Catalina (`-mmacosx-version-min=10.15`).
- Standardized macOS `.icns` app icon proportions to Apple HIG grid (`824x824` within `1024x1024`).

## [1.0.0] - 2026-10-16
- Initial standalone release for macOS, Windows, and Android (`com.cutefishaep.ofts`).
- Added Windows Setup installer with Control Panel uninstall support.
- Added macOS DMG installer with `/Applications` shortcut.
- Added deep link support for `studio.cutefish.my.id` (`ofts://`).
- Enabled automatic background updates from `openfishtools/Studio`.
