use crate::discovery::DiscoveryService;
use crate::history::HistoryStore;
use crate::transfer::TransferEngine;
use crate::types::{AppSettings, Device, HistoryEntry, PersistedConfig, TransferItem};
use log::info;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub discovery: Arc<Mutex<DiscoveryService>>,
    pub transfer: Arc<TransferEngine>,
    pub history: Option<Arc<HistoryStore>>,
    pub settings: Arc<Mutex<AppSettings>>,
    pub device_id: String,
    pub config_path: PathBuf,
    pub thumb_cache_dir: PathBuf,
}

impl AppState {
    fn history(&self) -> Option<&HistoryStore> {
        self.history.as_deref()
    }
}

// ─── Discovery Commands ─────────────────────────────────────────

#[tauri::command]
pub async fn start_discovery(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut discovery = state.discovery.lock().await;
    let mut rx = discovery.start_browsing()?;

    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Ok(devices) = rx.recv().await {
            let _ = app_handle.emit("devices-updated", &devices);
        }
    });

    info!("Discovery started");
    Ok(())
}

#[tauri::command]
pub async fn stop_discovery(state: State<'_, AppState>) -> Result<(), String> {
    let mut discovery = state.discovery.lock().await;
    discovery.stop();
    Ok(())
}

#[tauri::command]
pub async fn get_devices(state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    let discovery = state.discovery.lock().await;
    Ok(discovery.get_devices())
}

// ─── Transfer Commands ──────────────────────────────────────────

#[tauri::command]
pub async fn send_file(
    state: State<'_, AppState>,
    _app: AppHandle,
    file_path: String,
    device_ip: String,
    device_port: u16,
    device_id: String,
    device_name: String,
) -> Result<String, String> {
    let settings = state.settings.lock().await;
    let sender_name = settings.device_name.clone();
    drop(settings);

    let transfer_id = state
        .transfer
        .send_file(
            &file_path,
            &device_ip,
            device_port,
            &device_id,
            &device_name,
            &state.device_id,
            &sender_name,
        )
        .await?;

    Ok(transfer_id)
}

/// Send multiple files as one batch — the receiver is prompted once.
/// Returns the number of files queued.
#[tauri::command]
pub async fn send_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
    device_ip: String,
    device_port: u16,
    device_id: String,
    device_name: String,
) -> Result<u32, String> {
    let settings = state.settings.lock().await;
    let sender_name = settings.device_name.clone();
    drop(settings);

    state
        .transfer
        .send_files(
            paths,
            &device_ip,
            device_port,
            &device_id,
            &device_name,
            &state.device_id,
            &sender_name,
        )
        .await
}

/// Send every file in a folder as one batch — the receiver is prompted once.
/// Returns the number of files queued.
#[tauri::command]
pub async fn send_folder(
    state: State<'_, AppState>,
    folder_path: String,
    device_ip: String,
    device_port: u16,
    device_id: String,
    device_name: String,
) -> Result<u32, String> {
    let settings = state.settings.lock().await;
    let sender_name = settings.device_name.clone();
    drop(settings);

    state
        .transfer
        .send_folder(
            &folder_path,
            &device_ip,
            device_port,
            &device_id,
            &device_name,
            &state.device_id,
            &sender_name,
        )
        .await
}

#[tauri::command]
pub async fn pause_transfer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.transfer.pause_transfer(&id);
    Ok(())
}

#[tauri::command]
pub async fn resume_transfer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.transfer.resume_transfer(&id);
    Ok(())
}

#[tauri::command]
pub async fn cancel_transfer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.transfer.cancel_transfer(&id);
    Ok(())
}

#[tauri::command]
pub async fn get_active_transfers(
    state: State<'_, AppState>,
) -> Result<Vec<TransferItem>, String> {
    Ok(state.transfer.get_active_transfers().await)
}

#[tauri::command]
pub async fn respond_to_transfer(
    state: State<'_, AppState>,
    id: String,
    accept: bool,
) -> Result<(), String> {
    state.transfer.respond_to_request(&id, accept).await;
    Ok(())
}

// ─── History Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
    search: Option<String>,
    direction: Option<String>,
    status: Option<String>,
) -> Result<Vec<HistoryEntry>, String> {
    let Some(history) = state.history() else {
        return Ok(vec![]);
    };
    history
        .get_entries(
            limit,
            offset,
            search.as_deref(),
            direction.as_deref(),
            status.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn get_history_count(state: State<'_, AppState>) -> Result<u32, String> {
    let Some(history) = state.history() else {
        return Ok(0);
    };
    history.get_entry_count().await
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    let Some(history) = state.history() else {
        return Ok(());
    };
    history.clear().await
}

// ─── Settings Commands ──────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().await;
    Ok(settings.clone())
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    updates: AppSettings,
) -> Result<(), String> {
    let mut settings = state.settings.lock().await;
    *settings = updates;

    // Apply relevant settings to transfer engine
    if !settings.download_path.is_empty() {
        state
            .transfer
            .set_download_path(std::path::PathBuf::from(&settings.download_path));
    }
    state
        .transfer
        .set_chunk_size(settings.chunk_size as usize);
    state
        .transfer
        .set_auto_accept(settings.auto_accept_from_paired);
    state.transfer.set_require_pin(settings.require_pin);

    // Persist to disk so settings survive restarts
    let cfg = PersistedConfig {
        device_id: state.device_id.clone(),
        settings: settings.clone(),
    };
    crate::config::save(&state.config_path, &cfg)?;

    Ok(())
}

// ─── Utility Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn get_device_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let settings = state.settings.lock().await;
    Ok(serde_json::json!({
        "id": state.device_id,
        "name": settings.device_name,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    }))
}

/// Thumbnail for a local file as a JPEG data URL (disk-cached), or null if
/// the file type has no preview.
#[tauri::command]
pub async fn get_thumbnail(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<String>, String> {
    Ok(crate::thumbs::cached_thumbnail_data_url(
        &state.thumb_cache_dir,
        std::path::Path::new(&path),
        256,
        70,
    )
    .await)
}

#[tauri::command]
pub async fn get_file_metadata(path: String) -> Result<serde_json::Value, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "size": metadata.len(),
        "is_dir": metadata.is_dir(),
        "is_file": metadata.is_file(),
    }))
}

/// Start event emitters — stream transfer progress and incoming file
/// requests to the frontend.
pub fn start_progress_emitter(app: AppHandle, transfer: Arc<TransferEngine>) {
    let mut progress_rx = transfer.progress_receiver();
    let progress_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(progress) = progress_rx.recv().await {
            let _ = progress_app.emit("transfer-progress", &progress);
        }
    });

    let mut request_rx = transfer.request_receiver();
    let request_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(request) = request_rx.recv().await {
            let _ = request_app.emit("transfer-request", &request);
        }
    });

    let mut code_rx = transfer.code_receiver();
    tauri::async_runtime::spawn(async move {
        while let Ok(code) = code_rx.recv().await {
            let _ = app.emit("transfer-code", &code);
        }
    });
}
