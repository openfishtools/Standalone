use percent_encoding::percent_decode_str;
use std::fs;
#[cfg(desktop)]
use std::fs::File;
#[cfg(desktop)]
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
const WIN_FFMPEG_ZIP_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

fn sanitize_filename(raw: &str) -> Result<String, String> {
    let decoded = percent_decode_str(raw).decode_utf8_lossy().into_owned();
    let name = decoded.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
    {
        return Err(format!("Invalid ffmpeg filename: {}", name));
    }
    Ok(name.to_string())
}

fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed resolving app_cache_dir: {}", e))?
        .join("ffmpeg-work");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed creating ffmpeg-work: {}", e))?;
    Ok(dir)
}

#[tauri::command]
pub fn ffmpeg_get_work_dir(app: AppHandle) -> Result<String, String> {
    let dir = work_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn ffmpeg_write_file(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let raw_name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing x-name header".to_string())?;
    let name = sanitize_filename(raw_name)?;
    let bytes = crate::native_io::extract_request_bytes(request.body())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = work_dir(&app)?;
        fs::write(dir.join(name), bytes).map_err(|e| format!("Failed writing ffmpeg file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn ffmpeg_read_file(
    app: AppHandle,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let clean = sanitize_filename(&name)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let dir = work_dir(&app)?;
        fs::read(dir.join(&clean)).map_err(|e| format!("Failed reading {}: {}", clean, e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn ffmpeg_unlink(app: AppHandle, name: String) -> Result<(), String> {
    let clean = sanitize_filename(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = work_dir(&app)?;
        let p = dir.join(clean);
        if p.exists() {
            let _ = fs::remove_file(p);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(desktop)]
fn find_system_ffmpeg() -> Option<PathBuf> {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if cmd
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some(PathBuf::from("ffmpeg"));
    }
    None
}

#[cfg(desktop)]
async fn ensure_desktop_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed resolving app_data_dir: {}", e))?
        .join("bin");
    let local_bin = if cfg!(windows) {
        bin_dir.join("ffmpeg.exe")
    } else {
        bin_dir.join("ffmpeg")
    };
    if local_bin.is_file() {
        return Ok(local_bin);
    }
    if let Some(sys) = find_system_ffmpeg() {
        return Ok(sys);
    }

    #[cfg(not(windows))]
    {
        return Err("FFmpeg not found in PATH".to_string());
    }

    #[cfg(windows)]
    {
        fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed creating bin dir: {}", e))?;
        let zip_path = bin_dir.join("ffmpeg-download.zip");

        let client = reqwest::Client::builder()
            .user_agent("OpenFishTools-Standalone")
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let mut resp = client
            .get(WIN_FFMPEG_ZIP_URL)
            .send()
            .await
            .map_err(|e| format!("Failed downloading FFmpeg: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("FFmpeg download HTTP {}", resp.status()));
        }

        let mut out =
            File::create(&zip_path).map_err(|e| format!("Failed creating zip file: {}", e))?;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Failed reading FFmpeg download stream: {}", e))?
        {
            out.write_all(&chunk)
                .map_err(|e| format!("Failed writing FFmpeg zip: {}", e))?;
        }
        drop(out);

        let zip_clone = zip_path.clone();
        let bin_clone = local_bin.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let zfile =
                File::open(&zip_clone).map_err(|e| format!("Failed opening FFmpeg zip: {}", e))?;
            let mut archive =
                zip::ZipArchive::new(zfile).map_err(|e| format!("Invalid FFmpeg zip: {}", e))?;
            for i in 0..archive.len() {
                let mut entry = archive
                    .by_index(i)
                    .map_err(|e| format!("Failed reading zip entry: {}", e))?;
                let name = entry.name().to_string();
                if name.ends_with("/bin/ffmpeg.exe") || name.eq_ignore_ascii_case("ffmpeg.exe") {
                    let mut exe_file = File::create(&bin_clone)
                        .map_err(|e| format!("Failed creating ffmpeg.exe: {}", e))?;
                    std::io::copy(&mut entry, &mut exe_file)
                        .map_err(|e| format!("Failed extracting ffmpeg.exe: {}", e))?;
                    return Ok(());
                }
            }
            Err("ffmpeg.exe not found inside downloaded archive".to_string())
        })
        .await
        .map_err(|e| format!("Extract task failed: {}", e))??;

        let _ = fs::remove_file(&zip_path);
        Ok(local_bin)
    }
}

#[tauri::command]
pub async fn ffmpeg_run_desktop(
    app: AppHandle,
    args: Vec<String>,
) -> Result<String, String> {
    #[cfg(desktop)]
    {
        let bin = ensure_desktop_ffmpeg(&app).await?;
        let dir = work_dir(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = std::process::Command::new(&bin);
            cmd.arg("-y").args(&args).current_dir(&dir);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let output = cmd
                .output()
                .map_err(|e| format!("Failed executing ffmpeg: {}", e))?;
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            if output.status.success() {
                Ok(stderr)
            } else {
                Err(format!(
                    "FFmpeg exited with {}: {}",
                    output.status,
                    stderr.chars().take(600).collect::<String>()
                ))
            }
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, args);
        Err("Use AndroidNative.runFFmpeg on Android".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_ffmpeg_filename() {
        assert_eq!(sanitize_filename("frame_00001.jpg").unwrap(), "frame_00001.jpg");
        assert!(sanitize_filename("../evil.mp4").is_err());
        assert!(sanitize_filename("sub/file.mp4").is_err());
    }
}
