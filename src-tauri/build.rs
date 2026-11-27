use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=debug-studio.zip");
    let debug_zip = Path::new("debug-studio.zip");
    if !debug_zip.exists() {
        let _ = fs::write(debug_zip, b"");
    }
    tauri_build::build()
}
