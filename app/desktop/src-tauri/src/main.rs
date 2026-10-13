//! Btrace desktop: the web UI in a native window, plus the two things a
//! browser page can't do well: a native "Save as" dialog, and auto-updates
//! from GitHub Releases (driven from the UI via the updater plugin).

// No console window behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_dialog::DialogExt;

/// Ask where to save `contents` (suggesting `name`) and write it there.
/// Returns the chosen path, or `None` if the user cancelled.
#[tauri::command]
async fn save_svg(app: tauri::AppHandle, name: String, contents: String) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter("SVG image", &["svg"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![save_svg])
        .run(tauri::generate_context!())
        .expect("error while running Btrace");
}
