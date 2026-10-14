//! PixPath desktop: the web UI in a native window, plus the two things a
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

/// One file for [`save_all`].
#[derive(serde::Deserialize)]
struct NamedSvg {
    name: String,
    contents: String,
}

/// Where [`save_all`] put the files.
#[derive(serde::Serialize)]
struct Saved {
    folder: String,
    count: usize,
}

/// Ask for a folder and write every SVG into it. Never overwrites: a name
/// already taken gets " (2)", " (3)"… Returns `None` if the user cancelled.
#[tauri::command]
async fn save_all(app: tauri::AppHandle, files: Vec<NamedSvg>) -> Result<Option<Saved>, String> {
    let Some(folder) = app.dialog().file().set_title("Save all SVGs to…").blocking_pick_folder() else {
        return Ok(None);
    };
    let folder = folder.into_path().map_err(|e| e.to_string())?;
    for f in &files {
        let path = free_path(&folder, &f.name);
        std::fs::write(&path, &f.contents).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    }
    Ok(Some(Saved {
        folder: folder.display().to_string(),
        count: files.len(),
    }))
}

/// `folder/name`, or `folder/stem (k).ext` for the first k that is free. Only
/// the file name part of `name` is used, so it can't escape `folder`.
fn free_path(folder: &std::path::Path, name: &str) -> std::path::PathBuf {
    let name = std::path::Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "trace.svg".into());
    let first = folder.join(&name);
    if !first.exists() {
        return first;
    }
    let p = std::path::Path::new(&name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|k| folder.join(format!("{stem} ({k}){ext}")))
        .find(|p| !p.exists())
        .expect("some name is free")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![save_svg, save_all])
        .run(tauri::generate_context!())
        .expect("error while running PixPath");
}

#[cfg(test)]
mod tests {
    use super::free_path;

    #[test]
    fn free_path_never_overwrites_and_stays_in_folder() {
        let dir = std::env::temp_dir().join(format!("pixpath-free-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_path(&dir, "logo.svg"), dir.join("logo.svg"));
        std::fs::write(dir.join("logo.svg"), "x").unwrap();
        assert_eq!(free_path(&dir, "logo.svg"), dir.join("logo (2).svg"));
        std::fs::write(dir.join("logo (2).svg"), "x").unwrap();
        assert_eq!(free_path(&dir, "logo.svg"), dir.join("logo (3).svg"));
        // Path parts in a name are ignored: files can't land outside `dir`.
        assert_eq!(free_path(&dir, "../../evil.svg"), dir.join("evil.svg"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
