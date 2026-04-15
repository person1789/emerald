use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tempfile::tempdir;
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{ZipArchive, ZipWriter};

#[derive(Serialize, Deserialize)]
struct FileNode {
    name: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StickyNote {
    id: String,
    title: String,
    content: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: String,
    collapsed: bool,
    image_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    from_id: String,
    from_side: String,
    to_id: String,
    to_side: String,
    r#type: String,
    style: String,
    is_double_headed: bool,
    color: String,
    label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CameraState {
    x: f64,
    y: f64,
    zoom: f64,
}

impl Default for CameraState {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PageCanvasData {
    version: u32,
    notes: Vec<StickyNote>,
    connections: Vec<Connection>,
    camera: CameraState,
}

impl Default for PageCanvasData {
    fn default() -> Self {
        Self {
            version: 1,
            notes: Vec::new(),
            connections: Vec::new(),
            camera: CameraState::default(),
        }
    }
}

fn vault_root() -> PathBuf {
    PathBuf::from("../emerald_notes")
}

fn ensure_vault_root() -> Result<PathBuf, String> {
    let root = vault_root();
    if !root.exists() {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    }
    Ok(root)
}

fn page_path(path: &str) -> PathBuf {
    vault_root().join(path)
}

fn sidecar_path_for(page_file: &Path) -> Result<PathBuf, String> {
    let stem = page_file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| "Invalid page file name".to_string())?;
    Ok(page_file.with_file_name(format!("{stem}.emerald.json")))
}

fn page_sidecar_path(path: &str) -> Result<PathBuf, String> {
    sidecar_path_for(&page_path(path))
}

#[tauri::command]
fn get_directory_tree() -> Result<Vec<FileNode>, String> {
    let root = ensure_vault_root()?;
    scan_dir(&root)
}

fn scan_dir(path: &Path) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();
    if let Ok(entries) = fs::read_dir(path) {
        let mut entries_vec: Vec<_> = entries.flatten().collect();
        entries_vec.sort_by_key(|a| !a.path().is_dir());
        for entry in entries_vec {
            let name = entry.file_name().into_string().unwrap_or_default();
            let is_dir = entry.path().is_dir();
            if is_dir {
                nodes.push(FileNode {
                    name,
                    is_dir: true,
                    children: Some(scan_dir(&entry.path())?),
                });
            } else if name.ends_with(".md") {
                nodes.push(FileNode {
                    name,
                    is_dir: false,
                    children: None,
                });
            }
        }
    }
    Ok(nodes)
}

#[tauri::command]
fn save_note(path: String, content: String) -> Result<(), String> {
    let full_path = page_path(&path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(full_path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_note(path: String) -> Result<String, String> {
    let full_path = page_path(&path);
    fs::read_to_string(full_path).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_page_state(path: String) -> Result<PageCanvasData, String> {
    let full_path = page_sidecar_path(&path)?;
    if !full_path.exists() {
        return Ok(PageCanvasData::default());
    }

    let raw = fs::read_to_string(&full_path).map_err(|err| err.to_string())?;
    serde_json::from_str::<PageCanvasData>(&raw).map_err(|err| {
        format!(
            "Failed to parse page state for {}: {}",
            full_path.display(),
            err
        )
    })
}

#[tauri::command]
fn save_page_state(path: String, data: PageCanvasData) -> Result<(), String> {
    let full_path = page_sidecar_path(&path)?;
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(&data).map_err(|err| err.to_string())?;
    fs::write(full_path, serialized).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    let full_path = vault_root().join(path);
    fs::create_dir_all(full_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_item(path: String) -> Result<(), String> {
    let full_path = vault_root().join(&path);
    if full_path.is_dir() {
        fs::remove_dir_all(full_path).map_err(|e| e.to_string())
    } else {
        if full_path.exists() {
            fs::remove_file(&full_path).map_err(|e| e.to_string())?;
        }
        if path.ends_with(".md") {
            let sidecar = page_sidecar_path(&path)?;
            if sidecar.exists() {
                fs::remove_file(sidecar).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

#[tauri::command]
fn rename_item(old_path: String, new_path: String) -> Result<(), String> {
    let old = vault_root().join(&old_path);
    let new = vault_root().join(&new_path);
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::rename(&old, &new).map_err(|e| e.to_string())?;

    if old_path.ends_with(".md") {
        let old_sidecar = page_sidecar_path(&old_path)?;
        let new_sidecar = page_sidecar_path(&new_path)?;
        if old_sidecar.exists() {
            if let Some(parent) = new_sidecar.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::rename(old_sidecar, new_sidecar).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
fn export_vault(file_path: String) -> Result<(), String> {
    let root = ensure_vault_root()?;
    let file = fs::File::create(&file_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut has_entries = false;
    for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if path == root {
            continue;
        }

        let relative = path
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if entry.file_type().is_dir() {
            zip.add_directory(format!("{relative}/"), options)
                .map_err(|e| e.to_string())?;
        } else {
            has_entries = true;
            zip.start_file(relative, options).map_err(|e| e.to_string())?;
            let mut source = fs::File::open(path).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            source.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            zip.write_all(&buf).map_err(|e| e.to_string())?;
        }
    }

    if !has_entries {
        zip.add_directory("vault/", options)
            .map_err(|e| e.to_string())?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn import_vault(file_path: String) -> Result<(), String> {
    let archive_file = fs::File::open(&file_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(archive_file).map_err(|e| e.to_string())?;
    let extraction_dir = tempdir().map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("Archive entry has invalid path: {}", entry.name()))?;
        let out_path = extraction_dir.path().join(enclosed);

        if entry.name().ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let mut out_file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
    }

    let extracted_root = fs::read_dir(extraction_dir.path())
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .find(|entry| entry.path().is_dir() || entry.path().is_file())
        .map(|entry| entry.path());

    let staged_root = extraction_dir.path().join("emerald_notes");
    let import_root = match extracted_root {
        Some(path) if path.file_name().and_then(|s| s.to_str()) == Some("emerald_notes") => path,
        Some(_) => {
            fs::create_dir_all(&staged_root).map_err(|e| e.to_string())?;
            for entry in fs::read_dir(extraction_dir.path()).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path == staged_root {
                    continue;
                }
                let target = staged_root.join(entry.file_name());
                fs::rename(path, target).map_err(|e| e.to_string())?;
            }
            staged_root
        }
        None => staged_root,
    };

    let root = ensure_vault_root()?;
    let backup_parent = tempdir().map_err(|e| e.to_string())?;
    let backup_root = backup_parent.path().join("emerald_notes_backup");

    if root.exists() {
        fs::rename(&root, &backup_root).map_err(|e| e.to_string())?;
    }

    let restore_backup = |backup_root: &Path, root: &Path| -> Result<(), String> {
        if backup_root.exists() && !root.exists() {
            fs::rename(backup_root, root).map_err(|e| e.to_string())?;
        }
        Ok(())
    };

    match fs::rename(&import_root, &root) {
        Ok(_) => {
            if backup_root.exists() {
                fs::remove_dir_all(&backup_root).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Err(err) => {
            restore_backup(&backup_root, &root)?;
            Err(err.to_string())
        }
    }
}

#[cfg(windows)]
pub fn simulate_media_key(scan_code: u16) {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    };

    unsafe {
        let mut inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: scan_code,
                        dwFlags: KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: scan_code,
                        dwFlags: KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];

        SendInput(
            inputs.len() as u32,
            inputs.as_mut_ptr(),
            size_of::<INPUT>() as i32,
        );
    }
}

#[cfg(not(windows))]
pub fn simulate_media_key(_scan_code: u16) {
    println!("Media keys are only supported on Windows.");
}

#[tauri::command]
fn media_play_pause() {
    simulate_media_key(0x22); // VK_MEDIA_PLAY_PAUSE
}

#[tauri::command]
fn media_next() {
    simulate_media_key(0x19); // VK_MEDIA_NEXT_TRACK
}

#[tauri::command]
fn media_previous() {
    simulate_media_key(0x10); // VK_MEDIA_PREV_TRACK
}

#[tauri::command]
async fn start_oauth_server() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use std::net::TcpListener;
        use std::io::{Read, Write};
        use std::time::Duration;
        
        let listener = TcpListener::bind("127.0.0.1:14214").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).unwrap();
        
        let start = std::time::Instant::now();
        // Wait up to 3 minutes for the user to complete login in the browser
        while start.elapsed() < Duration::from_secs(180) {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0; 2048];
                if stream.read(&mut buffer).is_ok() {
                    let request = String::from_utf8_lossy(&buffer[..]);
                    if let Some(line) = request.lines().next() {
                        if line.starts_with("GET ") {
                            let parts: Vec<&str> = line.split_whitespace().collect();
                            if parts.len() > 1 {
                                let url = parts[1];
                                if let Some(code_idx) = url.find("code=") {
                                    let code_end = url[code_idx..].find('&').map(|i| code_idx + i).unwrap_or(url.len());
                                    let code = &url[code_idx + 5 .. code_end];
                                    
                                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<!DOCTYPE html><html><body style='background:#111;color:#1db954;font-family:sans-serif;text-align:center;padding-top:100px;'><h1>Authorization Successful!</h1><p>You can close this tab and return to Emerald.</p><script>window.close()</script></body></html>";
                                    let _ = stream.write_all(response.as_bytes());
                                    
                                    return Ok(code.to_string());
                                }
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err("Authorization timeout".into())
    }).await.map_err(|e| e.to_string())?
}
#[derive(Serialize)]
struct MediaInfo {
    title: String,
    artist: String,
    album_art: Option<String>,
    is_playing: bool,
}

#[cfg(windows)]
fn to_base64(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[cfg(windows)]
fn get_thumbnail_base64(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    use windows::Storage::Streams::{Buffer, DataReader, InputStreamOptions};

    let thumbnail = props.Thumbnail().ok()?;
    let stream = thumbnail.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 {
        return None;
    }
    let buf = Buffer::Create(size).ok()?;
    let buf = stream
        .ReadAsync(&buf, size, InputStreamOptions::None)
        .ok()?
        .get()
        .ok()?;
    let reader = DataReader::FromBuffer(&buf).ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let content_type = stream
        .ContentType()
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "image/jpeg".into());
    Some(format!("data:{};base64,{}", content_type, to_base64(&bytes)))
}

#[tauri::command]
async fn get_media_info() -> Result<Option<MediaInfo>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            use windows::Media::Control::{
                GlobalSystemMediaTransportControlsSessionManager,
                GlobalSystemMediaTransportControlsSessionPlaybackStatus,
            };

            let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| e.to_string())?;

            let session = match manager.GetCurrentSession() {
                Ok(s) => s,
                Err(_) => return Ok(None),
            };

            let props = session
                .TryGetMediaPropertiesAsync()
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| e.to_string())?;

            let playback_info = session.GetPlaybackInfo().map_err(|e| e.to_string())?;

            let is_playing = playback_info
                .PlaybackStatus()
                .map(|s| {
                    s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
                })
                .unwrap_or(false);

            let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
            let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
            let album_art = get_thumbnail_base64(&props);

            Ok(Some(MediaInfo {
                title,
                artist,
                album_art,
                is_playing,
            }))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_note,
            read_note,
            read_page_state,
            save_page_state,
            get_directory_tree,
            create_folder,
            delete_item,
            rename_item,
            export_vault,
            import_vault,
            media_play_pause,
            media_next,
            media_previous,
            start_oauth_server,
            get_media_info
        ])
        .run(tauri::generate_context!())
        .expect("error");
}
