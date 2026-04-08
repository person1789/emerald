use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct FileNode {
    name: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
}

#[tauri::command]
fn get_directory_tree() -> Result<Vec<FileNode>, String> {
    let root_path = "../emerald_notes";
    if !Path::new(root_path).exists() {
        fs::create_dir(root_path).map_err(|e| e.to_string())?;
    }
    scan_dir(Path::new(root_path))
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
    let full_path = Path::new("../emerald_notes").join(path);
    fs::write(full_path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_note(path: String) -> Result<String, String> {
    let full_path = Path::new("../emerald_notes").join(path);
    fs::read_to_string(full_path).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    let full_path = Path::new("../emerald_notes").join(path);
    fs::create_dir_all(full_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_item(path: String) -> Result<(), String> {
    let full_path = Path::new("../emerald_notes").join(path);
    if full_path.is_dir() {
        fs::remove_dir_all(full_path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(full_path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_item(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new("../emerald_notes").join(&old_path);
    let new = Path::new("../emerald_notes").join(&new_path);
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::rename(old, new).map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_note,
            read_note,
            get_directory_tree,
            create_folder,
            delete_item,
            rename_item,
            media_play_pause,
            media_next,
            media_previous,
            start_oauth_server,
            get_media_info
        ])
        .run(tauri::generate_context!())
        .expect("error");
}
