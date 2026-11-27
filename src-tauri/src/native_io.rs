use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

struct ActiveStream {
    file: File,
    path: PathBuf,
}

pub struct StreamHandles {
    next_id: AtomicU64,
    streams: Mutex<HashMap<u64, ActiveStream>>,
}

impl Default for StreamHandles {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            streams: Mutex::new(HashMap::new()),
        }
    }
}

impl StreamHandles {
    pub fn open_path(&self, path: PathBuf) -> Result<u64, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed creating parent dir for {:?}: {}", path, e))?;
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| format!("Failed opening {:?}: {}", path, e))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut guard = self
            .streams
            .lock()
            .map_err(|_| "StreamHandles lock poisoned".to_string())?;
        guard.insert(id, ActiveStream { file, path });
        Ok(id)
    }

    pub fn write_chunk(&self, handle: u64, offset: Option<u64>, data: &[u8]) -> Result<(), String> {
        let mut guard = self
            .streams
            .lock()
            .map_err(|_| "StreamHandles lock poisoned".to_string())?;
        let active = guard
            .get_mut(&handle)
            .ok_or_else(|| format!("Unknown stream handle: {}", handle))?;

        if let Some(pos) = offset {
            active
                .file
                .seek(SeekFrom::Start(pos))
                .map_err(|e| format!("Seek failed on handle {}: {}", handle, e))?;
        }
        active
            .file
            .write_all(data)
            .map_err(|e| format!("Write failed on handle {}: {}", handle, e))
    }

    pub fn close(&self, handle: u64) -> Result<String, String> {
        let mut active = {
            let mut guard = self
                .streams
                .lock()
                .map_err(|_| "StreamHandles lock poisoned".to_string())?;
            guard
                .remove(&handle)
                .ok_or_else(|| format!("Unknown stream handle: {}", handle))?
        };
        active
            .file
            .flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        let _ = active.file.sync_all();
        Ok(active.path.to_string_lossy().into_owned())
    }

    pub fn abort(&self, handle: u64) -> Result<(), String> {
        let active = {
            let mut guard = self
                .streams
                .lock()
                .map_err(|_| "StreamHandles lock poisoned".to_string())?;
            guard.remove(&handle)
        };
        if let Some(a) = active {
            drop(a.file);
            let _ = fs::remove_file(&a.path);
        }
        Ok(())
    }
}

fn resolve_stream_path(app: &AppHandle, raw_path: &str) -> Result<PathBuf, String> {
    if let Some(name) = raw_path.strip_prefix("cache:") {
        let clean = name
            .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
            .trim()
            .to_string();
        let filename = if clean.is_empty() {
            "export.bin".to_string()
        } else {
            clean
        };
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Failed resolving app_cache_dir: {}", e))?
            .join("exports");
        return Ok(cache_dir.join(filename));
    }

    let p = PathBuf::from(raw_path);
    if p.is_relative() {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Failed resolving app_cache_dir: {}", e))?
            .join("exports");
        return Ok(cache_dir.join(p));
    }
    Ok(p)
}

#[tauri::command]
pub fn open_write_stream(
    app: AppHandle,
    state: tauri::State<'_, StreamHandles>,
    path: String,
) -> Result<u64, String> {
    let resolved = resolve_stream_path(&app, &path)?;
    state.open_path(resolved)
}

pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity((input.len() / 4) * 3);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for b in input.bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err(format!("Invalid base64 byte: {}", b)),
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

pub fn extract_request_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        tauri::ipc::InvokeBody::Raw(data) => Ok(data.to_vec()),
        tauri::ipc::InvokeBody::Json(val) => match val {
            serde_json::Value::String(s) => decode_base64(s),
            serde_json::Value::Array(arr) => {
                let mut out = Vec::with_capacity(arr.len());
                for item in arr {
                    let n = item
                        .as_u64()
                        .ok_or_else(|| "Invalid byte in JSON array body".to_string())?;
                    out.push(n as u8);
                }
                Ok(out)
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(b64)) = map.get("b64") {
                    return decode_base64(b64);
                }
                if let Some(serde_json::Value::Array(arr)) = map.get("bytes") {
                    let mut out = Vec::with_capacity(arr.len());
                    for item in arr {
                        let n = item
                            .as_u64()
                            .ok_or_else(|| "Invalid byte in bytes array".to_string())?;
                        out.push(n as u8);
                    }
                    return Ok(out);
                }
                let mut out = Vec::with_capacity(map.len());
                for i in 0..map.len() {
                    let key = i.to_string();
                    let n = map
                        .get(&key)
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| "Expected raw binary or base64 body".to_string())?;
                    out.push(n as u8);
                }
                Ok(out)
            }
            _ => Err("Expected raw binary body".to_string()),
        },
    }
}

#[tauri::command]
pub async fn write_stream_chunk(
    state: tauri::State<'_, StreamHandles>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let handle_str = request
        .headers()
        .get("x-handle")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing x-handle header".to_string())?;
    let handle: u64 = handle_str
        .parse()
        .map_err(|_| format!("Invalid x-handle: {}", handle_str))?;

    let offset: Option<u64> = match request.headers().get("x-offset").and_then(|v| v.to_str().ok()) {
        Some(s) if !s.is_empty() => {
            Some(s.parse().map_err(|_| format!("Invalid x-offset: {}", s))?)
        }
        _ => None,
    };

    let bytes = extract_request_bytes(request.body())?;
    state.write_chunk(handle, offset, &bytes)
}

#[tauri::command]
pub fn close_write_stream(
    state: tauri::State<'_, StreamHandles>,
    handle: u64,
) -> Result<String, String> {
    state.close(handle)
}

#[tauri::command]
pub fn abort_write_stream(
    state: tauri::State<'_, StreamHandles>,
    handle: u64,
) -> Result<(), String> {
    state.abort(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_file(name: &str) -> PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ofts_test_{}_{}", ts, name))
    }

    #[test]
    fn test_sequential_and_offset_write() {
        let handles = StreamHandles::default();
        let path = temp_file("seq.bin");
        let id = handles.open_path(path.clone()).unwrap();
        handles.write_chunk(id, None, b"HELLO_WORLD").unwrap();
        handles.write_chunk(id, Some(6), b"RUST!").unwrap();
        let closed_path = handles.close(id).unwrap();
        assert_eq!(PathBuf::from(&closed_path), path);

        let content = fs::read(&path).unwrap();
        assert_eq!(&content, b"HELLO_RUST!");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_unknown_handle_errors() {
        let handles = StreamHandles::default();
        assert!(handles.write_chunk(999, None, b"x").is_err());
        assert!(handles.close(999).is_err());
    }

    #[test]
    fn test_abort_deletes_file() {
        let handles = StreamHandles::default();
        let path = temp_file("abort.bin");
        let id = handles.open_path(path.clone()).unwrap();
        handles.write_chunk(id, None, b"partial").unwrap();
        assert!(path.exists());
        handles.abort(id).unwrap();
        assert!(!path.exists());
    }
}
