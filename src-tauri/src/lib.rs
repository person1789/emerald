use std::fs;
use std::path::{Path};
use serde::{Serialize, Deserialize};

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
                nodes.push(FileNode { name, is_dir: false, children: None });
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_note, read_note, get_directory_tree, create_folder, delete_item, rename_item
        ])
        .run(tauri::generate_context!())
        .expect("error");
}