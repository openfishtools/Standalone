use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager};

pub const STUDIO_REPO: &str = "openfishtools/Studio";
pub const STUDIO_BRANCH: &str = "main";
const COMMIT_API_URL: &str = "https://api.github.com/repos/openfishtools/Studio/commits/main";
const VERSION_RAW_URL: &str = "https://raw.githubusercontent.com/openfishtools/Studio/main/version.json";
const ZIPBALL_URL: &str = "https://codeload.github.com/openfishtools/Studio/zip/refs/heads/main";
const NATIVE_BRIDGE_JS: &str = include_str!("../../bridge/ofts-native.js");

#[cfg(debug_assertions)]
const DEBUG_STUDIO_ZIP: &[u8] = include_bytes!("../debug-studio.zip");
#[cfg(debug_assertions)]
const DEBUG_HUD_JS: &str = include_str!("../../bridge/ofts-debug-hud.js");

#[cfg(debug_assertions)]
fn debug_local_studio_dir() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.parent()?.parent()?.join("Studio");
    if candidate.join("index.html").is_file() {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(debug_assertions)]
fn debug_zip_tag(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("debug-bundle:{:016x}:{}", hash, bytes.len())
}

const ALLOWED_DIRS: &[&str] = &[
    "assets/",
    "css/",
    "effects/",
    "Extension/",
    "extension-builder/",
    "fticons/",
    "js/",
    "vendor/",
];

const ALLOWED_ROOT_FILES: &[&str] = &["manifest.webmanifest", "version.json", "sw.js"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheMeta {
    pub repo: String,
    pub branch: String,
    pub commit: String,
    pub version: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CacheInfo {
    pub ready: bool,
    pub repo: String,
    pub branch: String,
    pub commit: Option<String>,
    pub version: Option<String>,
    pub updated_at: Option<u64>,
    pub cache_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrepareResult {
    pub entry_url: String,
    pub status: String,
    pub version: String,
    pub commit: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncProgress {
    pub stage: String,
    pub message: String,
    pub detail: String,
    pub percent: Option<f64>,
    pub has_cache: bool,
}

pub fn studio_entry_url() -> &'static str {
    #[cfg(any(windows, target_os = "android"))]
    {
        "http://ofts.localhost/index.html"
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        "ofts://localhost/index.html"
    }
}

pub fn updater_entry_url() -> &'static str {
    #[cfg(any(windows, target_os = "android"))]
    {
        "http://tauri.localhost/index.html?manage=1"
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        "tauri://localhost/index.html?manage=1"
    }
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app_data_dir: {}", e))?;
    Ok(dir.join("studio-cache"))
}

pub fn is_allowed_studio_path(rel: &str) -> bool {
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.contains("..")
        || rel.contains('\0')
    {
        return false;
    }

    for prefix in ALLOWED_DIRS {
        if rel.starts_with(prefix) && rel.len() > prefix.len() {
            return true;
        }
    }

    if !rel.contains('/') {
        if rel.ends_with(".html") || ALLOWED_ROOT_FILES.contains(&rel) {
            return true;
        }
    }

    false
}

pub fn inject_bridge_into_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(head_start) = lower.find("<head") {
        if let Some(rel_end) = lower[head_start..].find('>') {
            let insert_at = head_start + rel_end + 1;
            let mut out = String::with_capacity(html.len() + 48);
            out.push_str(&html[..insert_at]);
            out.push_str("\n  <script src=\"native/ofts-native.js\"></script>");
            out.push_str(&html[insert_at..]);
            return out;
        }
    }
    html.to_string()
}

pub fn patch_effects_loader(src: &str) -> String {
    let pattern = "host === '127.0.0.1';";
    if src.contains(pattern) && !src.contains("ofts.localhost") {
        return src.replace(
            pattern,
            "host === '127.0.0.1' ||\n      host === 'ofts.localhost' ||\n      host === 'tauri.localhost';",
        );
    }
    src.to_string()
}

fn mime_for_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".wasm") {
        "application/wasm"
    } else if lower.ends_with(".json") || lower.ends_with(".webmanifest") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".ttf") {
        "font/ttf"
    } else if lower.ends_with(".otf") {
        "font/otf"
    } else if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else if lower.ends_with(".glb") {
        "model/gltf-binary"
    } else if lower.ends_with(".gltf") {
        "model/gltf+json"
    } else {
        "application/octet-stream"
    }
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    message: &str,
    detail: &str,
    percent: Option<f64>,
    has_cache: bool,
) {
    let _ = app.emit(
        "studio-sync-progress",
        SyncProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            detail: detail.to_string(),
            percent,
            has_cache,
        },
    );
}

fn read_meta(meta_path: &Path) -> Option<CacheMeta> {
    let data = fs::read_to_string(meta_path).ok()?;
    serde_json::from_str(&data).ok()
}

fn read_studio_version(dir: &Path) -> String {
    let vpath = dir.join("version.json");
    if let Ok(raw) = fs::read_to_string(vpath) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(v) = val.get("version").and_then(|x| x.as_str()) {
                return v.to_string();
            }
        }
    }
    "0.7.0".to_string()
}

async fn fetch_remote_ref(client: &reqwest::Client) -> Result<String, String> {
    if let Ok(resp) = client
        .get(COMMIT_API_URL)
        .header("Accept", "application/vnd.github.sha")
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(text) = resp.text().await {
                let sha = text.trim().to_string();
                if sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Ok(sha);
                }
            }
        }
    }

    let resp = client
        .get(VERSION_RAW_URL)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    if let Some(etag) = resp.headers().get(reqwest::header::ETAG) {
        if let Ok(s) = etag.to_str() {
            let clean = s.trim_matches('"').trim().to_string();
            if !clean.is_empty() {
                return Ok(clean);
            }
        }
    }

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed reading version.json: {}", e))?;
    let val: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid version.json: {}", e))?;
    let ver = val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    Ok(format!("ver:{}", ver))
}

pub async fn prepare_studio(app: AppHandle, force: bool) -> Result<PrepareResult, String> {
    let root = cache_root(&app)?;
    fs::create_dir_all(&root).map_err(|e| format!("Failed creating cache dir: {}", e))?;

    let current_dir = root.join("current");
    let staging_dir = root.join("staging");
    let backup_dir = root.join("backup");
    let meta_path = root.join("meta.json");
    let zip_path = root.join("download.zip");

    #[cfg(debug_assertions)]
    {
        // 1. On desktop dev machine: serve live directly from sibling ../Studio folder
        if let Some(local_dir) = debug_local_studio_dir() {
            let ver = read_studio_version(&local_dir);
            emit_progress(
                &app,
                "ready",
                "Mode debug — memuat Studio lokal",
                &ver,
                Some(100.0),
                true,
            );
            return Ok(PrepareResult {
                entry_url: studio_entry_url().to_string(),
                status: "debug-local".to_string(),
                version: ver,
                commit: "local-dev".to_string(),
            });
        }

        // 2. On Android debug APK (or standalone debug binary): extract embedded debug-studio.zip
        if !DEBUG_STUDIO_ZIP.is_empty() {
            let tag = debug_zip_tag(DEBUG_STUDIO_ZIP);
            let existing_meta = read_meta(&meta_path);
            let already_extracted = !force
                && current_dir.join("index.html").is_file()
                && existing_meta.as_ref().map(|m| m.commit == tag).unwrap_or(false);

            if already_extracted {
                let ver = existing_meta
                    .map(|m| m.version)
                    .unwrap_or_else(|| read_studio_version(&current_dir));
                emit_progress(
                    &app,
                    "ready",
                    "Mode debug — Studio siap",
                    &ver,
                    Some(100.0),
                    true,
                );
                return Ok(PrepareResult {
                    entry_url: studio_entry_url().to_string(),
                    status: "debug-bundle".to_string(),
                    version: ver,
                    commit: tag,
                });
            }

            emit_progress(
                &app,
                "extracting",
                "Menyiapkan Studio debug...",
                "Mengekstrak bundle lokal",
                Some(50.0),
                current_dir.join("index.html").is_file(),
            );

            let staging_clone = staging_dir.clone();
            let version = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
                if staging_clone.exists() {
                    fs::remove_dir_all(&staging_clone)
                        .map_err(|e| format!("Gagal membersihkan staging: {}", e))?;
                }
                fs::create_dir_all(&staging_clone)
                    .map_err(|e| format!("Gagal membuat staging: {}", e))?;

                let cursor = std::io::Cursor::new(DEBUG_STUDIO_ZIP);
                let mut archive = zip::ZipArchive::new(cursor)
                    .map_err(|e| format!("Debug Studio zip tidak valid: {}", e))?;

                for i in 0..archive.len() {
                    let mut entry = archive
                        .by_index(i)
                        .map_err(|e| format!("Gagal membaca entry debug zip: {}", e))?;
                    if entry.is_dir() {
                        continue;
                    }
                    let name = entry.name().replace('\\', "/");
                    let rel = match name.find('/') {
                        Some(idx) => &name[idx + 1..],
                        None => name.as_str(),
                    };
                    if !is_allowed_studio_path(rel) {
                        continue;
                    }
                    let out_path = staging_clone.join(rel);
                    if let Some(parent) = out_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("Gagal membuat folder {}: {}", rel, e))?;
                    }
                    let mut out_file = File::create(&out_path)
                        .map_err(|e| format!("Gagal menulis {}: {}", rel, e))?;
                    std::io::copy(&mut entry, &mut out_file)
                        .map_err(|e| format!("Gagal ekstrak {}: {}", rel, e))?;
                }

                if !staging_clone.join("index.html").is_file() {
                    return Err("Bundle debug Studio tidak mengandung index.html".to_string());
                }
                Ok(read_studio_version(&staging_clone))
            })
            .await
            .map_err(|e| format!("Ekstraksi debug dibatalkan: {}", e))??;

            if backup_dir.exists() {
                let _ = fs::remove_dir_all(&backup_dir);
            }
            if current_dir.exists() {
                fs::rename(&current_dir, &backup_dir)
                    .map_err(|e| format!("Gagal backup cache lama: {}", e))?;
            }
            if let Err(e) = fs::rename(&staging_dir, &current_dir) {
                if backup_dir.exists() {
                    let _ = fs::rename(&backup_dir, &current_dir);
                }
                return Err(format!("Gagal mengaktifkan bundle debug: {}", e));
            }
            let _ = fs::remove_dir_all(&backup_dir);

            let updated_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let meta = CacheMeta {
                repo: "local-debug".to_string(),
                branch: "debug".to_string(),
                commit: tag.clone(),
                version: version.clone(),
                updated_at,
            };
            if let Ok(raw) = serde_json::to_string_pretty(&meta) {
                let _ = fs::write(&meta_path, raw);
            }

            emit_progress(
                &app,
                "ready",
                "Studio debug siap",
                &version,
                Some(100.0),
                true,
            );
            return Ok(PrepareResult {
                entry_url: studio_entry_url().to_string(),
                status: "debug-bundle".to_string(),
                version,
                commit: tag,
            });
        }
    }

    let has_cache = current_dir.join("index.html").is_file();
    let existing_meta = read_meta(&meta_path);

    emit_progress(
        &app,
        "checking",
        "Memeriksa pembaruan dari GitHub...",
        STUDIO_REPO,
        None,
        has_cache,
    );

    let check_client = reqwest::Client::builder()
        .user_agent("OpenFishTools-Standalone")
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let remote_ref = match fetch_remote_ref(&check_client).await {
        Ok(r) => r,
        Err(e) => {
            if has_cache {
                let meta = existing_meta.unwrap_or(CacheMeta {
                    repo: STUDIO_REPO.to_string(),
                    branch: STUDIO_BRANCH.to_string(),
                    commit: "offline".to_string(),
                    version: read_studio_version(&current_dir),
                    updated_at: 0,
                });
                emit_progress(
                    &app,
                    "ready",
                    "Mode offline — memuat cache lokal",
                    &meta.version,
                    Some(100.0),
                    true,
                );
                return Ok(PrepareResult {
                    entry_url: studio_entry_url().to_string(),
                    status: "offline-cache".to_string(),
                    version: meta.version,
                    commit: meta.commit,
                });
            }
            return Err(format!(
                "Gagal terhubung ke GitHub ({}) dan cache lokal belum tersedia.",
                e
            ));
        }
    };

    if !force && has_cache {
        if let Some(ref meta) = existing_meta {
            if meta.commit == remote_ref {
                emit_progress(
                    &app,
                    "ready",
                    "Studio sudah versi terbaru",
                    &meta.version,
                    Some(100.0),
                    true,
                );
                return Ok(PrepareResult {
                    entry_url: studio_entry_url().to_string(),
                    status: "up-to-date".to_string(),
                    version: meta.version.clone(),
                    commit: meta.commit.clone(),
                });
            }
        }
    }

    // Download zipball from GitHub
    emit_progress(
        &app,
        "downloading",
        "Mengunduh Studio dari GitHub...",
        "Menghubungi codeload.github.com...",
        None,
        has_cache,
    );

    let dl_client = reqwest::Client::builder()
        .user_agent("OpenFishTools-Standalone")
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut resp = dl_client
        .get(ZIPBALL_URL)
        .send()
        .await
        .map_err(|e| format!("Gagal mengunduh Studio: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub mengembalikan HTTP {}", resp.status()));
    }

    let total_bytes = resp.content_length();
    let mut file = File::create(&zip_path).map_err(|e| format!("Gagal membuat file zip: {}", e))?;
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Gagal membaca stream unduhan: {}", e))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("Gagal menulis file zip: {}", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(100) {
            let mb = downloaded as f64 / (1024.0 * 1024.0);
            let (pct, detail) = match total_bytes {
                Some(total) if total > 0 => {
                    let total_mb = total as f64 / (1024.0 * 1024.0);
                    (
                        Some((downloaded as f64 / total as f64) * 100.0),
                        format!("{:.1} MB / {:.1} MB", mb, total_mb),
                    )
                }
                _ => (None, format!("{:.1} MB terunduh", mb)),
            };
            emit_progress(
                &app,
                "downloading",
                "Mengunduh Studio dari GitHub...",
                &detail,
                pct,
                has_cache,
            );
            last_emit = Instant::now();
        }
    }
    drop(file);

    emit_progress(
        &app,
        "extracting",
        "Mengekstrak & menyiapkan cache...",
        "Memverifikasi file Studio",
        None,
        has_cache,
    );

    let staging_clone = staging_dir.clone();
    let zip_clone = zip_path.clone();

    let version = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        if staging_clone.exists() {
            fs::remove_dir_all(&staging_clone)
                .map_err(|e| format!("Gagal membersihkan staging: {}", e))?;
        }
        fs::create_dir_all(&staging_clone)
            .map_err(|e| format!("Gagal membuat staging: {}", e))?;

        let zfile = File::open(&zip_clone).map_err(|e| format!("Gagal membuka zip: {}", e))?;
        let mut archive =
            zip::ZipArchive::new(zfile).map_err(|e| format!("Zip tidak valid: {}", e))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Gagal membaca entry zip: {}", e))?;
            if entry.is_dir() {
                continue;
            }
            let raw_name = entry.name().to_string();
            let Some(slash_idx) = raw_name.find('/') else {
                continue;
            };
            let rel = &raw_name[slash_idx + 1..];
            if !is_allowed_studio_path(rel) {
                continue;
            }

            let out_path = staging_clone.join(rel);
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Gagal membuat direktori {:?}: {}", parent, e))?;
            }
            let mut out_file = File::create(&out_path)
                .map_err(|e| format!("Gagal membuat file {:?}: {}", out_path, e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Gagal mengekstrak {}: {}", rel, e))?;
        }

        if !staging_clone.join("index.html").is_file() {
            return Err("index.html tidak ditemukan di arsip Studio".to_string());
        }

        Ok(read_studio_version(&staging_clone))
    })
    .await
    .map_err(|e| format!("Task ekstraksi gagal: {}", e))??;

    // Atomic swap: current -> backup -> staging -> current
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    if current_dir.exists() {
        fs::rename(&current_dir, &backup_dir)
            .map_err(|e| format!("Gagal membackup cache lama: {}", e))?;
    }
    if let Err(e) = fs::rename(&staging_dir, &current_dir) {
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, &current_dir);
        }
        return Err(format!("Gagal mengaktifkan cache baru: {}", e));
    }
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    let _ = fs::remove_file(&zip_path);

    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let meta = CacheMeta {
        repo: STUDIO_REPO.to_string(),
        branch: STUDIO_BRANCH.to_string(),
        commit: remote_ref.clone(),
        version: version.clone(),
        updated_at,
    };
    if let Ok(json) = serde_json::to_string_pretty(&meta) {
        let _ = fs::write(&meta_path, json);
    }

    emit_progress(
        &app,
        "ready",
        "Studio siap digunakan",
        &version,
        Some(100.0),
        true,
    );

    Ok(PrepareResult {
        entry_url: studio_entry_url().to_string(),
        status: "updated".to_string(),
        version,
        commit: remote_ref,
    })
}

pub fn get_cache_info(app: &AppHandle) -> CacheInfo {
    let root = match cache_root(app) {
        Ok(r) => r,
        Err(e) => {
            return CacheInfo {
                ready: false,
                repo: STUDIO_REPO.to_string(),
                branch: STUDIO_BRANCH.to_string(),
                commit: None,
                version: None,
                updated_at: None,
                cache_dir: e,
            }
        }
    };
    let current_dir = root.join("current");
    let ready = current_dir.join("index.html").is_file();
    let meta = read_meta(&root.join("meta.json"));

    CacheInfo {
        ready,
        repo: STUDIO_REPO.to_string(),
        branch: STUDIO_BRANCH.to_string(),
        commit: meta.as_ref().map(|m| m.commit.clone()),
        version: meta.as_ref().map(|m| m.version.clone()),
        updated_at: meta.as_ref().map(|m| m.updated_at),
        cache_dir: root.to_string_lossy().into_owned(),
    }
}

pub fn clear_cache(app: &AppHandle) -> Result<(), String> {
    let root = cache_root(app)?;
    for name in &["current", "staging", "backup"] {
        let p = root.join(name);
        if p.exists() {
            fs::remove_dir_all(&p).map_err(|e| format!("Gagal menghapus {}: {}", name, e))?;
        }
    }
    for name in &["download.zip", "meta.json"] {
        let p = root.join(name);
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("Gagal menghapus {}: {}", name, e))?;
        }
    }
    Ok(())
}

fn simple_response(status: StatusCode, body: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn handle_ofts_request(app: &AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw_path = req.uri().path();
    let decoded = percent_decode_str(raw_path).decode_utf8_lossy().into_owned();
    let trimmed = decoded.trim_start_matches('/');

    if trimmed.contains("..") || trimmed.contains('\\') || trimmed.contains('\0') {
        return simple_response(StatusCode::FORBIDDEN, b"Forbidden".to_vec(), "text/plain");
    }

    if trimmed == "native/ofts-native.js" {
        #[cfg(debug_assertions)]
        let body = {
            let mut combined = String::with_capacity(NATIVE_BRIDGE_JS.len() + DEBUG_HUD_JS.len() + 2);
            combined.push_str(NATIVE_BRIDGE_JS);
            combined.push('\n');
            combined.push_str(DEBUG_HUD_JS);
            combined.into_bytes()
        };
        #[cfg(not(debug_assertions))]
        let body = NATIVE_BRIDGE_JS.as_bytes().to_vec();

        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/javascript; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    if let Some(media_id) = trimmed.strip_prefix("local-media/") {
        return crate::native_storage::handle_local_media_request(app, media_id, &req);
    }

    if let Some(cache_key) = trimmed.strip_prefix("preview-cache/") {
        return crate::native_storage::handle_preview_cache_request(app, cache_key);
    }

    #[cfg(debug_assertions)]
    let (current_dir, is_live_debug) = if let Some(local_dir) = debug_local_studio_dir() {
        (local_dir, true)
    } else {
        let root = match cache_root(app) {
            Ok(r) => r,
            Err(_) => return simple_response(StatusCode::INTERNAL_SERVER_ERROR, b"Cache error".to_vec(), "text/plain"),
        };
        (root.join("current"), false)
    };

    #[cfg(not(debug_assertions))]
    let (current_dir, is_live_debug) = {
        let root = match cache_root(app) {
            Ok(r) => r,
            Err(_) => return simple_response(StatusCode::INTERNAL_SERVER_ERROR, b"Cache error".to_vec(), "text/plain"),
        };
        (root.join("current"), false)
    };

    let mut rel = if trimmed.is_empty() {
        "index.html".to_string()
    } else {
        trimmed.to_string()
    };

    let mut file_path = current_dir.join(&rel);
    if !file_path.is_file() && !rel.contains('.') {
        let html_candidate = format!("{}.html", rel);
        let candidate_path = current_dir.join(&html_candidate);
        if candidate_path.is_file() {
            rel = html_candidate;
            file_path = candidate_path;
        }
    }

    if !file_path.is_file() {
        return simple_response(StatusCode::NOT_FOUND, b"Not Found".to_vec(), "text/plain");
    }

    let mime = mime_for_path(&rel);
    let is_root_html = !rel.contains('/') && rel.ends_with(".html");
    let is_effects_loader = rel == "effects/loader.js";
    let cache_ctrl = if is_live_debug || is_root_html || rel == "version.json" {
        "no-store"
    } else {
        "public, max-age=3600"
    };

    if is_root_html || is_effects_loader {
        let Ok(text) = fs::read_to_string(&file_path) else {
            return simple_response(StatusCode::INTERNAL_SERVER_ERROR, b"Read error".to_vec(), "text/plain");
        };
        let patched = if is_root_html {
            inject_bridge_into_html(&text)
        } else {
            patch_effects_loader(&text)
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, cache_ctrl)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(patched.into_bytes())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    if let Some(range_hdr) = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(spec) = range_hdr.strip_prefix("bytes=") {
            if let Ok(mut f) = File::open(&file_path) {
                if let Ok(meta) = f.metadata() {
                    let len = meta.len();
                    if len > 0 {
                        let mut parts = spec.split('-');
                        let start_str = parts.next().unwrap_or("");
                        let end_str = parts.next().unwrap_or("");
                        if let Ok(start) = start_str.parse::<u64>() {
                            let end = if end_str.is_empty() {
                                len - 1
                            } else {
                                end_str.parse::<u64>().unwrap_or(len - 1).min(len - 1)
                            };
                            if start <= end && start < len {
                                let chunk_len = (end - start + 1) as usize;
                                let mut buf = vec![0u8; chunk_len];
                                if f.seek(SeekFrom::Start(start)).is_ok() && f.read_exact(&mut buf).is_ok() {
                                    return Response::builder()
                                        .status(StatusCode::PARTIAL_CONTENT)
                                        .header(header::CONTENT_TYPE, mime)
                                        .header(header::ACCEPT_RANGES, "bytes")
                                        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, len))
                                        .header(header::CONTENT_LENGTH, chunk_len.to_string())
                                        .header(header::CACHE_CONTROL, cache_ctrl)
                                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                        .body(buf)
                                        .unwrap_or_else(|_| Response::new(Vec::new()));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    match fs::read(&file_path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, cache_ctrl)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap_or_else(|_| Response::new(Vec::new())),
        Err(_) => simple_response(StatusCode::INTERNAL_SERVER_ERROR, b"Read error".to_vec(), "text/plain"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allowed_studio_path() {
        assert!(is_allowed_studio_path("index.html"));
        assert!(is_allowed_studio_path("desktop.html"));
        assert!(is_allowed_studio_path("version.json"));
        assert!(is_allowed_studio_path("js/app/main.js"));
        assert!(is_allowed_studio_path("effects/effects.wasm"));
        assert!(!is_allowed_studio_path("../secret.txt"));
        assert!(!is_allowed_studio_path("js\\app.js"));
        assert!(!is_allowed_studio_path(".git/config"));
        assert!(!is_allowed_studio_path("storage/user.db"));
        assert!(!is_allowed_studio_path("server.js"));
    }

    #[test]
    fn test_inject_bridge_into_html() {
        let html = "<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>";
        let out = inject_bridge_into_html(html);
        assert!(out.contains("<head>\n  <script src=\"native/ofts-native.js\"></script><title>Test</title>"));
    }

    #[test]
    fn test_patch_effects_loader() {
        let src = "var isDev = host === 'localhost' ||\n      host === '127.0.0.1';";
        let out = patch_effects_loader(src);
        assert!(out.contains("ofts.localhost"));
        assert!(out.contains("tauri.localhost"));
    }
}
