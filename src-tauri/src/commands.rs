use crate::chat::ChatService;
use crate::discovery::DiscoveryService;
use crate::history::HistoryStore;
use crate::transfer::TransferEngine;
use crate::types::{
    AppSettings, ChatMessage, Conversation, Device, DeviceStatus, DeviceType, HistoryEntry,
    ManualDevice, PersistedConfig, TransferItem,
};
use log::{info, warn};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub discovery: Arc<Mutex<DiscoveryService>>,
    pub transfer: Arc<TransferEngine>,
    pub chat: Arc<ChatService>,
    pub history: Option<Arc<HistoryStore>>,
    pub settings: Arc<Mutex<AppSettings>>,
    pub manual_devices: Arc<Mutex<Vec<ManualDevice>>>,
    pub device_id: String,
    pub config_path: PathBuf,
    pub thumb_cache_dir: PathBuf,
    pub transfer_port: u16,
    pub chat_port: u16,
}

impl AppState {
    async fn persist_config(&self) -> Result<(), String> {
        let cfg = PersistedConfig {
            device_id: self.device_id.clone(),
            settings: self.settings.lock().await.clone(),
            manual_devices: self.manual_devices.lock().await.clone(),
        };
        crate::config::save(&self.config_path, &cfg)
    }
}

/// Offline placeholder for a persisted manual device that didn't answer.
pub fn offline_manual_device(m: &ManualDevice) -> Option<Device> {
    let id = m.device_id.clone()?;
    Some(Device {
        id,
        name: m.name.clone().unwrap_or_else(|| m.host.clone()),
        ip: m.host.clone(),
        port: 0,
        chat_port: m.port,
        device_type: DeviceType::Unknown,
        status: DeviceStatus::Offline,
        os: None,
        last_seen: 0,
        manual: true,
        compatible: true,
    })
}

/// Try to reach every saved manual device and refresh its entry.
pub fn spawn_manual_probes(
    chat: Arc<ChatService>,
    discovery: Arc<Mutex<DiscoveryService>>,
    devices: Vec<ManualDevice>,
) {
    tokio::spawn(async move {
        for m in devices {
            match chat.probe_remote(&m.host, m.port).await {
                Ok(device) => {
                    discovery.lock().await.upsert_manual(device);
                }
                Err(e) => {
                    warn!("Manual device {}:{} unreachable: {}", m.host, m.port, e);
                    if let Some(device) = offline_manual_device(&m) {
                        discovery.lock().await.upsert_manual(device);
                    }
                }
            }
        }
    });
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
    {
        let mut discovery = state.discovery.lock().await;
        let mut rx = discovery.start_browsing()?;

        let app_handle = app.clone();
        tokio::spawn(async move {
            while let Ok(devices) = rx.recv().await {
                let _ = app_handle.emit("devices-updated", &devices);
            }
        });
    }

    // Re-probe saved remote devices alongside the broadcast scan
    let manual = state.manual_devices.lock().await.clone();
    if !manual.is_empty() {
        spawn_manual_probes(state.chat.clone(), state.discovery.clone(), manual);
    }

    info!("Discovery started");
    Ok(())
}

// ─── Remote (manual) Devices ────────────────────────────────────

#[tauri::command]
pub async fn add_manual_device(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> Result<Device, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("Enter a host or IP address".to_string());
    }

    let device = state.chat.probe_remote(&host, port).await?;
    state.discovery.lock().await.upsert_manual(device.clone());

    {
        let mut list = state.manual_devices.lock().await;
        list.retain(|m| {
            !(m.host == host && m.port == port)
                && m.device_id.as_deref() != Some(device.id.as_str())
        });
        list.push(ManualDevice {
            host,
            port,
            device_id: Some(device.id.clone()),
            name: Some(device.name.clone()),
        });
    }
    state.persist_config().await?;

    info!("Added remote device {} ({})", device.name, device.ip);
    Ok(device)
}

#[tauri::command]
pub async fn remove_manual_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    state.discovery.lock().await.remove_device(&device_id);
    {
        let mut list = state.manual_devices.lock().await;
        list.retain(|m| m.device_id.as_deref() != Some(device_id.as_str()));
    }
    state.persist_config().await?;
    Ok(())
}

/// This device's reachable address info, shown in Settings for sharing
/// with remote peers.
#[tauri::command]
pub async fn get_network_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // UDP "connect" doesn't send packets — it just resolves the local
    // address the OS would route through.
    let ip = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(serde_json::json!({
        "ip": ip,
        "chatPort": state.chat_port,
        "transferPort": state.transfer_port,
    }))
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

// ─── Chat Commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn get_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    state.chat.get_conversations().await
}

#[tauri::command]
pub async fn get_chat_messages(
    state: State<'_, AppState>,
    device_id: String,
    limit: u32,
) -> Result<Vec<ChatMessage>, String> {
    state.chat.get_messages(&device_id, limit).await
}

#[tauri::command]
pub async fn send_chat_message(
    state: State<'_, AppState>,
    device_id: String,
    text: String,
    reply_to: Option<String>,
) -> Result<ChatMessage, String> {
    state.chat.send_text(&device_id, text, reply_to).await
}

#[tauri::command]
pub async fn send_chat_attachment(
    state: State<'_, AppState>,
    device_id: String,
    file_path: String,
    reply_to: Option<String>,
) -> Result<ChatMessage, String> {
    state
        .chat
        .send_attachment(&device_id, &file_path, None, reply_to)
        .await
}

#[tauri::command]
pub async fn send_voice_note(
    state: State<'_, AppState>,
    device_id: String,
    data: String,
) -> Result<ChatMessage, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid audio data: {}", e))?;
    state.chat.send_voice_note(&device_id, bytes).await
}

#[tauri::command]
pub async fn mark_conversation_read(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    state.chat.mark_read(&device_id).await
}

#[tauri::command]
pub async fn set_typing(
    state: State<'_, AppState>,
    device_id: String,
    typing: bool,
) -> Result<(), String> {
    state.chat.set_typing(&device_id, typing).await;
    Ok(())
}

#[tauri::command]
pub async fn send_call_signal(
    state: State<'_, AppState>,
    device_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.chat.send_call_signal(&device_id, payload).await
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
        manual_devices: state.manual_devices.lock().await.clone(),
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
