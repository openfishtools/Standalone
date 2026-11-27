mod native_ffmpeg;
mod native_io;
mod native_storage;
mod studio_cache;

use percent_encoding::percent_decode_str;
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

struct LaunchFile(Mutex<Option<String>>);
struct LaunchDeepLink(Mutex<Option<String>>);

fn find_ofts(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| a.to_ascii_lowercase().ends_with(".ofts"))
        .cloned()
}

fn find_deeplink(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| {
            let lower = a.to_ascii_lowercase();
            lower.starts_with("ofts://")
                || lower.starts_with("fishtools://")
                || lower.starts_with("openfishtools://")
        })
        .cloned()
}

#[tauri::command]
fn take_launch_file(state: tauri::State<'_, LaunchFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

#[tauri::command]
fn take_launch_deeplink(state: tauri::State<'_, LaunchDeepLink>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
    })
}

#[tauri::command]
fn set_window_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if let Some(win) = app.get_webview_window("main") {
            win.set_title(&title)
                .map_err(|e| format!("Failed setting window title: {}", e))?;
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, title);
    }
    Ok(())
}

#[tauri::command]
async fn prepare_studio(
    app: tauri::AppHandle,
    force: bool,
) -> Result<studio_cache::PrepareResult, String> {
    studio_cache::prepare_studio(app, force).await
}

#[tauri::command]
fn get_cache_info(app: tauri::AppHandle) -> studio_cache::CacheInfo {
    studio_cache::get_cache_info(&app)
}

#[tauri::command]
fn clear_studio_cache(app: tauri::AppHandle) -> Result<(), String> {
    studio_cache::clear_cache(&app)
}

#[tauri::command]
fn get_studio_entry_url() -> &'static str {
    studio_cache::studio_entry_url()
}

#[tauri::command]
fn open_updater_ui(app: tauri::AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let url = studio_cache::updater_entry_url()
        .parse()
        .map_err(|e| format!("Invalid updater URL: {}", e))?;
    win.navigate(url)
        .map_err(|e| format!("Failed navigating to updater: {}", e))
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn write_file_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let raw_header = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing x-path header".to_string())?;

    let path = percent_decode_str(raw_header)
        .decode_utf8()
        .map_err(|e| format!("Invalid x-path encoding: {}", e))?
        .into_owned();

    let bytes = native_io::extract_request_bytes(request.body())?;

    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, bytes).map_err(|e| format!("Failed to write {}: {}", path, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn pick_save_path(
    app: tauri::AppHandle,
    suggested_name: String,
    ext: Option<String>,
) -> Option<String> {
    let mut builder = app.dialog().file().set_file_name(&suggested_name);
    if let Some(ref e) = ext {
        let clean = e.trim_start_matches('.');
        if !clean.is_empty() {
            builder = builder.add_filter(clean.to_uppercase(), &[clean]);
        }
    }
    builder
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_open_path(app: tauri::AppHandle, ext: Option<String>) -> Option<String> {
    let mut builder = app.dialog().file();
    if let Some(ref e) = ext {
        let clean = e.trim_start_matches('.');
        if !clean.is_empty() {
            builder = builder.add_filter(clean.to_uppercase(), &[clean]);
        }
    }
    builder
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let launch_file = LaunchFile(Mutex::new(find_ofts(&args)));
    let launch_deeplink = LaunchDeepLink(Mutex::new(find_deeplink(&args)));

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let mut on_splash = false;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
                if let Ok(url) = win.url() {
                    if url.host_str() == Some("tauri.localhost") {
                        on_splash = true;
                    }
                }
            }
            if let Some(p) = find_ofts(&argv) {
                if on_splash {
                    if let Some(state) = app.try_state::<LaunchFile>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(p);
                        }
                    }
                } else {
                    let _ = app.emit("ofts-open-file", p);
                }
            }
            if let Some(uri) = find_deeplink(&argv) {
                if on_splash {
                    if let Some(state) = app.try_state::<LaunchDeepLink>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(uri);
                        }
                    }
                } else {
                    let _ = app.emit("ofts-open-deeplink", uri);
                }
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            native_storage::clear_preview_cache_on_startup(app.handle());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("ofts", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let resp = studio_cache::handle_ofts_request(&app, req);
                responder.respond(resp);
            });
        })
        .manage(launch_file)
        .manage(launch_deeplink)
        .manage(native_io::StreamHandles::default())
        .invoke_handler(tauri::generate_handler![
            take_launch_file,
            take_launch_deeplink,
            app_info,
            set_window_title,
            prepare_studio,
            get_cache_info,
            clear_studio_cache,
            get_studio_entry_url,
            open_updater_ui,
            read_file_bytes,
            write_file_bytes,
            pick_save_path,
            pick_open_path,
            native_io::open_write_stream,
            native_io::write_stream_chunk,
            native_io::close_write_stream,
            native_io::abort_write_stream,
            native_storage::get_storage_config,
            native_storage::pick_storage_folder,
            native_storage::set_storage_dir,
            native_storage::storage_get_stats,
            native_storage::storage_get_settings,
            native_storage::storage_save_settings,
            native_storage::storage_list_projects,
            native_storage::storage_get_project,
            native_storage::storage_save_project,
            native_storage::storage_delete_project,
            native_storage::storage_clear_projects,
            native_storage::storage_save_media_meta,
            native_storage::storage_write_media_bin,
            native_storage::storage_read_media_bin,
            native_storage::storage_list_media_meta,
            native_storage::storage_get_media_meta,
            native_storage::storage_delete_media,
            native_storage::storage_delete_project_media,
            native_storage::storage_clear_all_media,
            native_storage::preview_cache_write,
            native_storage::preview_cache_delete,
            native_storage::preview_cache_clear,
            native_ffmpeg::ffmpeg_get_work_dir,
            native_ffmpeg::ffmpeg_write_file,
            native_ffmpeg::ffmpeg_read_file,
            native_ffmpeg::ffmpeg_unlink,
            native_ffmpeg::ffmpeg_run_desktop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
