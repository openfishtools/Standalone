use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppConfig {
    storage_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageConfigInfo {
    pub configured: bool,
    pub storage_dir: String,
    pub default_dir: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageStats {
    pub storage_dir: String,
    pub used_bytes: u64,
    pub disk_free_bytes: u64,
    pub disk_total_bytes: u64,
    pub project_count: usize,
    pub media_count: usize,
}

fn config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed resolving app_data_dir: {}", e))?;
    Ok(dir.join("config.json"))
}

pub fn default_storage_dir(app: &AppHandle) -> PathBuf {
    #[cfg(desktop)]
    {
        if let Ok(doc) = app.path().document_dir() {
            return doc.join("OpenFishTools Studio");
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("OpenFishTools Studio")
}

pub fn get_active_storage_dir(app: &AppHandle) -> PathBuf {
    if let Ok(cfg_path) = config_file_path(app) {
        if let Ok(raw) = fs::read_to_string(&cfg_path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&raw) {
                if !cfg.storage_dir.trim().is_empty() {
                    return PathBuf::from(cfg.storage_dir);
                }
            }
        }
    }
    default_storage_dir(app)
}

fn ensure_storage_layout(root: &Path) -> Result<(), String> {
    for sub in &["projects", "media", "settings"] {
        fs::create_dir_all(root.join(sub))
            .map_err(|e| format!("Failed creating {}: {}", sub, e))?;
    }
    Ok(())
}

fn sanitize_id(raw: &str) -> Result<String, String> {
    let clean: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    if clean.is_empty() || clean.contains("..") {
        return Err("Invalid storage item id".to_string());
    }
    Ok(clean)
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total = total.saturating_add(dir_size_bytes(&p));
            } else if let Ok(m) = entry.metadata() {
                total = total.saturating_add(m.len());
            }
        }
    }
    total
}

#[cfg(windows)]
fn query_disk_space(path: &Path) -> (u64, u64) {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    let mut target = path.to_path_buf();
    while !target.exists() {
        if !target.pop() {
            break;
        }
    }
    let wide: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut avail as *mut u64,
            &mut total as *mut u64,
            &mut free as *mut u64,
        )
    };
    if ok != 0 {
        (avail, total)
    } else {
        (0, 0)
    }
}

#[cfg(not(windows))]
fn query_disk_space(_path: &Path) -> (u64, u64) {
    (0, 0)
}

#[tauri::command]
pub fn get_storage_config(app: AppHandle) -> StorageConfigInfo {
    let default_dir = default_storage_dir(&app);
    let mut configured = false;
    let mut active = default_dir.clone();

    if let Ok(cfg_path) = config_file_path(&app) {
        if let Ok(raw) = fs::read_to_string(&cfg_path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&raw) {
                if !cfg.storage_dir.trim().is_empty() {
                    configured = true;
                    active = PathBuf::from(cfg.storage_dir);
                }
            }
        }
    }

    #[cfg(not(desktop))]
    {
        if !configured {
            let _ = ensure_storage_layout(&active);
            if let Ok(cfg_path) = config_file_path(&app) {
                if let Some(parent) = cfg_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let cfg = AppConfig {
                    storage_dir: active.to_string_lossy().into_owned(),
                };
                if let Ok(json) = serde_json::to_string_pretty(&cfg) {
                    let _ = fs::write(&cfg_path, json);
                }
            }
            configured = true;
        }
    }

    StorageConfigInfo {
        configured,
        storage_dir: active.to_string_lossy().into_owned(),
        default_dir: default_dir.to_string_lossy().into_owned(),
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
pub async fn pick_storage_folder(
    app: AppHandle,
    initial_dir: Option<String>,
) -> Option<String> {
    #[cfg(desktop)]
    {
        let mut builder = app.dialog().file().set_title("Pilih Folder Storage OpenFishTools");
        if let Some(dir) = initial_dir {
            let p = PathBuf::from(dir);
            if p.exists() {
                builder = builder.set_directory(p);
            } else if let Some(parent) = p.parent() {
                if parent.exists() {
                    builder = builder.set_directory(parent);
                }
            }
        }
        builder
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, initial_dir);
        None
    }
}

#[tauri::command]
pub fn set_storage_dir(app: AppHandle, path: String) -> Result<StorageConfigInfo, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Storage directory cannot be empty".to_string());
    }
    let dir = PathBuf::from(trimmed);
    ensure_storage_layout(&dir)?;

    let cfg_path = config_file_path(&app)?;
    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed creating config dir: {}", e))?;
    }
    let cfg = AppConfig {
        storage_dir: dir.to_string_lossy().into_owned(),
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&cfg_path, json).map_err(|e| format!("Failed writing config.json: {}", e))?;

    Ok(get_storage_config(app))
}

#[tauri::command]
pub async fn storage_get_stats(app: AppHandle) -> Result<StorageStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_active_storage_dir(&app);
        let _ = ensure_storage_layout(&root);
        let used_bytes = dir_size_bytes(&root);
        let (disk_free_bytes, disk_total_bytes) = query_disk_space(&root);

        let project_count = fs::read_dir(root.join("projects"))
            .map(|rd| {
                rd.flatten()
                    .filter(|e| {
                        e.path()
                            .extension()
                            .and_then(|x| x.to_str())
                            .map(|x| x.eq_ignore_ascii_case("json"))
                            .unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0);

        let media_count = fs::read_dir(root.join("media"))
            .map(|rd| {
                rd.flatten()
                    .filter(|e| {
                        e.file_name()
                            .to_str()
                            .map(|n| n.ends_with(".meta.json"))
                            .unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0);

        Ok(StorageStats {
            storage_dir: root.to_string_lossy().into_owned(),
            used_bytes,
            disk_free_bytes,
            disk_total_bytes,
            project_count,
            media_count,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_get_settings(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = get_active_storage_dir(&app)
            .join("settings")
            .join("settings.json");
        if !path.is_file() {
            return Ok(None);
        }
        fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("Failed reading settings: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_save_settings(app: AppHandle, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_active_storage_dir(&app);
        ensure_storage_layout(&root)?;
        let path = root.join("settings").join("settings.json");
        fs::write(&path, json).map_err(|e| format!("Failed writing settings: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_list_projects(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_active_storage_dir(&app);
        ensure_storage_layout(&root)?;
        let mut out = Vec::new();
        let entries = fs::read_dir(root.join("projects"))
            .map_err(|e| format!("Failed listing projects: {}", e))?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
            {
                if let Ok(raw) = fs::read_to_string(&p) {
                    out.push(raw);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_get_project(app: AppHandle, id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = sanitize_id(&id)?;
        let path = get_active_storage_dir(&app)
            .join("projects")
            .join(format!("{}.json", clean));
        if !path.is_file() {
            return Ok(None);
        }
        fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("Failed reading project {}: {}", clean, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_save_project(app: AppHandle, id: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = sanitize_id(&id)?;
        let root = get_active_storage_dir(&app);
        ensure_storage_layout(&root)?;
        let path = root.join("projects").join(format!("{}.json", clean));
        fs::write(&path, json).map_err(|e| format!("Failed writing project {}: {}", clean, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_delete_project(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = sanitize_id(&id)?;
        let path = get_active_storage_dir(&app)
            .join("projects")
            .join(format!("{}.json", clean));
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed deleting project {}: {}", clean, e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_clear_projects(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = get_active_storage_dir(&app).join("projects");
        if dir.exists() {
            for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_save_media_meta(app: AppHandle, id: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = sanitize_id(&id)?;
        let root = get_active_storage_dir(&app);
        ensure_storage_layout(&root)?;
        let path = root.join("media").join(format!("{}.meta.json", clean));
        fs::write(&path, json).map_err(|e| format!("Failed writing media meta {}: {}", clean, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_write_media_bin(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let raw_id = request
        .headers()
        .get("x-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing x-id header".to_string())?;
    let clean = sanitize_id(raw_id)?;
    let kind = request
        .headers()
        .get("x-kind")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("bin");
    let suffix = if kind == "thumb" { "thumb.bin" } else { "bin" };

    let bytes = crate::native_io::extract_request_bytes(request.body())?;
    let suffix = suffix.to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let root = get_active_storage_dir(&app);
        ensure_storage_layout(&root)?;
        let path = root.join("media").join(format!("{}.{}", clean, suffix));
        fs::write(&path, bytes).map_err(|e| format!("Failed writing media bin {}: {}", clean, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_read_media_bin(
    app: AppHandle,
    id: String,
    kind: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let clean = sanitize_id(&id)?;
    let suffix = if kind.as_deref() == Some("thumb") {
        "thumb.bin"
    } else {
        "bin"
    };
    let path = get_active_storage_dir(&app)
        .join("media")
        .join(format!("{}.{}", clean, suffix));
    let bytes = fs::read(&path).map_err(|e| format!("Failed reading media {}: {}", clean, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn storage_list_media_meta(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_active_storage_dir(&app);
        ensure_storage_layout(&root)?;
        let mut out = Vec::new();
        let entries = fs::read_dir(root.join("media"))
            .map_err(|e| format!("Failed listing media: {}", e))?;
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let Some(name_str) = fname.to_str() else {
                continue;
            };
            if !name_str.ends_with(".meta.json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(entry.path()) {
                if let Some(ref pid) = project_id {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if val.get("projectId").and_then(|v| v.as_str()) != Some(pid.as_str()) {
                            continue;
                        }
                    }
                }
                out.push(raw);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_get_media_meta(app: AppHandle, id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = sanitize_id(&id)?;
        let path = get_active_storage_dir(&app)
            .join("media")
            .join(format!("{}.meta.json", clean));
        if !path.is_file() {
            return Ok(None);
        }
        fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("Failed reading media meta {}: {}", clean, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_delete_media(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = sanitize_id(&id)?;
        let dir = get_active_storage_dir(&app).join("media");
        for suffix in &["meta.json", "bin", "thumb.bin"] {
            let p = dir.join(format!("{}.{}", clean, suffix));
            if p.exists() {
                let _ = fs::remove_file(&p);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn storage_delete_project_media(
    app: AppHandle,
    project_id: String,
) -> Result<(), String> {
    let metas = storage_list_media_meta(app.clone(), Some(project_id)).await?;
    for raw in metas {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                let _ = storage_delete_media(app.clone(), id.to_string()).await;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn storage_clear_all_media(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = get_active_storage_dir(&app).join("media");
        if dir.exists() {
            for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub fn handle_local_media_request(
    app: &AppHandle,
    rel_id: &str,
    req: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let decoded = percent_decode_str(rel_id).decode_utf8_lossy().into_owned();
    let Ok(clean) = sanitize_id(&decoded) else {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(b"Forbidden".to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    };

    let media_dir = get_active_storage_dir(app).join("media");
    let bin_path = media_dir.join(format!("{}.bin", clean));
    if !bin_path.is_file() {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(b"Not Found".to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    let mut mime = "application/octet-stream".to_string();
    let meta_path = media_dir.join(format!("{}.meta.json", clean));
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(m) = val.get("mimeType").and_then(|v| v.as_str()) {
                if !m.is_empty() {
                    mime = m.to_string();
                }
            }
        }
    }

    if let Some(range_hdr) = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(spec) = range_hdr.strip_prefix("bytes=") {
            if let Ok(mut f) = File::open(&bin_path) {
                if let Ok(meta) = f.metadata() {
                    let len = meta.len();
                    if len > 0 {
                        let mut parts = spec.split('-');
                        let start_str = parts.next().unwrap_or("");
                        let end_str = parts.next().unwrap_or("");
                        if let Ok(start) = start_str.parse::<u64>() {
                            let max_chunk: u64 = 4 * 1024 * 1024;
                            let end = if end_str.is_empty() {
                                (start + max_chunk - 1).min(len - 1)
                            } else {
                                end_str.parse::<u64>().unwrap_or(len - 1).min(len - 1)
                            };
                            if start <= end && start < len {
                                let chunk_len = (end - start + 1) as usize;
                                let mut buf = vec![0u8; chunk_len];
                                if f.seek(SeekFrom::Start(start)).is_ok()
                                    && f.read_exact(&mut buf).is_ok()
                                {
                                    return Response::builder()
                                        .status(StatusCode::PARTIAL_CONTENT)
                                        .header(header::CONTENT_TYPE, &mime)
                                        .header(header::ACCEPT_RANGES, "bytes")
                                        .header(
                                            header::CONTENT_RANGE,
                                            format!("bytes {}-{}/{}", start, end, len),
                                        )
                                        .header(header::CONTENT_LENGTH, chunk_len.to_string())
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

    match fs::read(&bin_path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, &mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap_or_else(|_| Response::new(Vec::new())),
        Err(_) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(b"Read error".to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new())),
    }
}

fn preview_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed resolving app_cache_dir: {}", e))?
        .join("preview-cache");
    Ok(dir)
}

pub fn clear_preview_cache_on_startup(app: &AppHandle) {
    if let Ok(dir) = preview_cache_dir(app) {
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

#[tauri::command]
pub async fn preview_cache_write(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let raw_key = request
        .headers()
        .get("x-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing x-key header".to_string())?;
    let clean = sanitize_id(raw_key)?;
    let bytes = crate::native_io::extract_request_bytes(request.body())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = preview_cache_dir(&app)?;
        fs::create_dir_all(&dir).map_err(|e| format!("Failed creating preview-cache dir: {}", e))?;
        fs::write(dir.join(format!("{}.webp", clean)), bytes)
            .map_err(|e| format!("Failed writing preview cache frame: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn preview_cache_delete(app: AppHandle, key: String) -> Result<(), String> {
    let clean = sanitize_id(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = preview_cache_dir(&app)?;
        let p = dir.join(format!("{}.webp", clean));
        if p.exists() {
            let _ = fs::remove_file(&p);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn preview_cache_clear(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = preview_cache_dir(&app)?;
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub fn handle_preview_cache_request(app: &AppHandle, raw_key: &str) -> Response<Vec<u8>> {
    let decoded = percent_decode_str(raw_key).decode_utf8_lossy().into_owned();
    let clean = match sanitize_id(decoded.trim_end_matches(".webp")) {
        Ok(c) => c,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(b"Invalid key".to_vec())
                .unwrap_or_else(|_| Response::new(Vec::new()));
        }
    };
    let Ok(dir) = preview_cache_dir(app) else {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(b"Cache error".to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    };
    let path = dir.join(format!("{}.webp", clean));
    match fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/webp")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap_or_else(|_| Response::new(Vec::new())),
        Err(_) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(b"Not Found".to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_id() {
        assert_eq!(sanitize_id("prj_123-abc").unwrap(), "prj_123-abc");
        assert!(sanitize_id("../etc/passwd").is_err());
        assert!(sanitize_id("").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn test_query_disk_space_windows() {
        let (free, total) = query_disk_space(Path::new("C:\\"));
        assert!(total > 0);
        assert!(free <= total);
    }
}
