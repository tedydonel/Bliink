mod chat;
mod commands;
mod config;
mod crypto;
mod discovery;
mod history;
mod p2p;
mod thumbs;
mod transfer;
mod types;

use chat::{ChatEvent, ChatService, ChatStore};
use commands::AppState;
use discovery::DiscoveryService;
use history::HistoryStore;
use transfer::TransferEngine;
use types::{HistoryEntry, TransferDirection, TransferStatus};

use log::{error, info};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

/// Bind a TCP listener on the preferred port, falling back to a random
/// one (remote dial-in won't work then, but LAN still does).
fn bind_listener(preferred_port: u16, label: &str) -> std::net::TcpListener {
    if preferred_port != 0 {
        match std::net::TcpListener::bind(("0.0.0.0", preferred_port)) {
            Ok(listener) => return listener,
            Err(e) => log::warn!(
                "{} port {} unavailable ({}); falling back to a random port — remote devices won't be able to dial in this session",
                label, preferred_port, e
            ),
        }
    }
    std::net::TcpListener::bind("0.0.0.0:0").expect("Failed to bind listener")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Load persisted settings + stable device identity
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let config_path = data_dir.join("settings.json");
            let persisted = config::load_or_create(&config_path);
            let settings = persisted.settings.clone();
            let device_id = persisted.device_id.clone();
            let device_name = settings.device_name.clone();

            // Bind listeners — fixed ports (settings) so remote peers can
            // dial in, falling back to random if taken
            let listener = bind_listener(settings.transfer_port, "transfer");
            listener
                .set_nonblocking(true)
                .expect("Failed to set nonblocking");
            let service_port = listener
                .local_addr()
                .expect("Failed to get local address")
                .port();

            let chat_listener = bind_listener(settings.chat_port, "chat");
            chat_listener
                .set_nonblocking(true)
                .expect("Failed to set nonblocking");
            let chat_port = chat_listener
                .local_addr()
                .expect("Failed to get local address")
                .port();

            info!(
                "Transfer listener on port {}, chat listener on port {}",
                service_port, chat_port
            );

            let discovery = Arc::new(Mutex::new(
                DiscoveryService::new(&device_name, service_port, chat_port, &device_id)
                    .expect("Failed to create discovery service"),
            ));

            let transfer = Arc::new(TransferEngine::new());

            // Chat media lands in the app data dir, not Downloads
            let chat_media_dir = data_dir.join("chat-media");
            let _ = std::fs::create_dir_all(&chat_media_dir);

            // Apply persisted transfer settings to the engine
            {
                let transfer = transfer.clone();
                let download_path = settings.download_path.clone();
                let chunk_size = settings.chunk_size as usize;
                let auto_accept = settings.auto_accept_from_paired;
                let require_pin = settings.require_pin;
                let media_dir = chat_media_dir.clone();
                tauri::async_runtime::spawn(async move {
                    if !download_path.is_empty() {
                        transfer.set_download_path(std::path::PathBuf::from(download_path));
                    }
                    transfer.set_chunk_size(chunk_size);
                    transfer.set_auto_accept(auto_accept);
                    transfer.set_require_pin(require_pin);
                    transfer.set_chat_media_dir(media_dir);
                });
            }

            let settings_state = Arc::new(Mutex::new(settings));

            // Desktop notifications for transfer events
            {
                let notif_app = app.handle().clone();
                let notif_settings = settings_state.clone();
                let engine = transfer.clone();
                let mut progress_rx = transfer.progress_receiver();
                tauri::async_runtime::spawn(async move {
                    while let Ok(progress) = progress_rx.recv().await {
                        let is_terminal = matches!(
                            progress.status,
                            TransferStatus::Completed | TransferStatus::Failed
                        );
                        if !is_terminal || !notif_settings.lock().await.show_notifications {
                            continue;
                        }
                        let Some(item) = engine.get_transfer(&progress.id).await else {
                            continue;
                        };
                        // Chat attachments notify through the chat flow instead
                        if item.chat_message_id.is_some() {
                            continue;
                        }
                        let (title, body) = match progress.status {
                            TransferStatus::Completed => match item.direction {
                                TransferDirection::Download => (
                                    "File received".to_string(),
                                    format!("{} from {}", item.file_name, item.device_name),
                                ),
                                TransferDirection::Upload => (
                                    "File sent".to_string(),
                                    format!("{} to {}", item.file_name, item.device_name),
                                ),
                            },
                            _ => (
                                "Transfer failed".to_string(),
                                format!(
                                    "{}: {}",
                                    item.file_name,
                                    item.error.unwrap_or_else(|| "Unknown error".to_string())
                                ),
                            ),
                        };
                        if let Err(e) = notif_app
                            .notification()
                            .builder()
                            .title(title)
                            .body(body)
                            .show()
                        {
                            error!("Failed to show notification: {}", e);
                        }
                    }
                });

                let notif_app = app.handle().clone();
                let notif_settings = settings_state.clone();
                let mut request_rx = transfer.request_receiver();
                tauri::async_runtime::spawn(async move {
                    while let Ok(request) = request_rx.recv().await {
                        if !notif_settings.lock().await.show_notifications {
                            continue;
                        }
                        let body = match (&request.batch_name, request.batch_total_files) {
                            (Some(folder), Some(count)) => format!(
                                "{} wants to send folder \"{}\" ({} files)",
                                request.sender_name, folder, count
                            ),
                            _ => format!(
                                "{} wants to send {}",
                                request.sender_name, request.file_name
                            ),
                        };
                        if let Err(e) = notif_app
                            .notification()
                            .builder()
                            .title("Incoming file")
                            .body(body)
                            .show()
                        {
                            error!("Failed to show notification: {}", e);
                        }
                    }
                });
            }

            // Embedded SQLite history store in the app data dir
            let history = match HistoryStore::new(&data_dir.join("history.db")) {
                Ok(store) => Some(Arc::new(store)),
                Err(e) => {
                    error!("History disabled: {}", e);
                    None
                }
            };

            // Record every finished transfer (sent or received) to history
            if let Some(store) = history.clone() {
                let engine = transfer.clone();
                let mut rx = transfer.progress_receiver();
                tauri::async_runtime::spawn(async move {
                    while let Ok(progress) = rx.recv().await {
                        let status = match progress.status {
                            TransferStatus::Completed => "completed",
                            TransferStatus::Failed => "failed",
                            TransferStatus::Cancelled => "cancelled",
                            _ => continue,
                        };
                        let Some(item) = engine.get_transfer(&progress.id).await else {
                            continue;
                        };
                        // Chat attachments live in chat history, not transfer history
                        if item.chat_message_id.is_some() {
                            continue;
                        }
                        let entry = HistoryEntry {
                            id: item.id,
                            file_name: item.file_name,
                            file_size: item.file_size,
                            file_type: item.file_type,
                            direction: item.direction,
                            device_id: item.device_id,
                            device_name: item.device_name,
                            status: status.to_string(),
                            started_at: item.started_at,
                            completed_at: item
                                .completed_at
                                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
                            hash: None,
                            thumbnail: item.thumbnail,
                            batch_id: item.batch_id,
                            batch_name: item.batch_name,
                        };
                        if let Err(e) = store.add_entry(&entry).await {
                            error!("Failed to record transfer in history: {}", e);
                        }
                    }
                });
            }

            // Chat service: persistent encrypted channels + message store
            let chat_store = Arc::new(
                ChatStore::new(&data_dir.join("history.db")).expect("Failed to open chat store"),
            );
            let chat_service = Arc::new(ChatService::new(
                device_id.clone(),
                device_name.clone(),
                service_port,
                chat_store,
                discovery.clone(),
                transfer.clone(),
                chat_media_dir.clone(),
            ));
            {
                let svc = chat_service.clone();
                tauri::async_runtime::spawn(async move {
                    match tokio::net::TcpListener::from_std(chat_listener) {
                        Ok(listener) => svc.start(listener),
                        Err(e) => error!("Failed to start chat listener: {}", e),
                    }
                });
            }

            // Forward chat events to the frontend + notify on new messages
            {
                let chat_app = app.handle().clone();
                let chat_notif_settings = settings_state.clone();
                let mut chat_rx = chat_service.events_receiver();
                tauri::async_runtime::spawn(async move {
                    while let Ok(event) = chat_rx.recv().await {
                        match event {
                            ChatEvent::Message(message) => {
                                let _ = chat_app.emit("chat-message", &message);
                            }
                            ChatEvent::Incoming { message, peer_name } => {
                                let _ = chat_app.emit("chat-message", &message);
                                let focused = chat_app
                                    .get_webview_window("main")
                                    .and_then(|w| w.is_focused().ok())
                                    .unwrap_or(false);
                                if !focused
                                    && chat_notif_settings.lock().await.show_notifications
                                {
                                    let body = chat::preview(&message);
                                    if let Err(e) = chat_app
                                        .notification()
                                        .builder()
                                        .title(format!("💬 {}", peer_name))
                                        .body(body)
                                        .show()
                                    {
                                        error!("Failed to show notification: {}", e);
                                    }
                                }
                            }
                            ChatEvent::Typing(typing) => {
                                let _ = chat_app.emit("chat-typing", &typing);
                            }
                            ChatEvent::ConversationsChanged => {
                                let _ = chat_app.emit("chat-conversations", ());
                            }
                            ChatEvent::CallSignal { device_id, payload } => {
                                let _ = chat_app.emit(
                                    "call-signal",
                                    serde_json::json!({
                                        "deviceId": device_id,
                                        "payload": payload,
                                    }),
                                );
                            }
                        }
                    }
                });
            }

            // Start transfer listener
            let transfer_clone = transfer.clone();
            tauri::async_runtime::spawn(async move {
                let tokio_listener = tokio::net::TcpListener::from_std(listener)
                    .expect("Failed to convert to tokio listener");
                if let Err(e) = transfer_clone.start_with_listener(tokio_listener).await {
                    error!("Failed to start transfer listener: {}", e);
                }
            });

            commands::start_progress_emitter(app.handle().clone(), transfer.clone());

            let thumb_cache_dir = data_dir.join("thumbnails");
            let _ = std::fs::create_dir_all(&thumb_cache_dir);

            // Internet P2P (iroh): stable secret key → stable Bliink ID
            let p2p_secret_hex = match persisted.p2p_secret.clone() {
                Some(secret) => secret,
                None => {
                    let mut bytes = [0u8; 32];
                    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
                    let secret = hex::encode(bytes);
                    let cfg = types::PersistedConfig {
                        device_id: device_id.clone(),
                        settings: persisted.settings.clone(),
                        manual_devices: persisted.manual_devices.clone(),
                        p2p_secret: Some(secret.clone()),
                    };
                    if let Err(e) = config::save(&config_path, &cfg) {
                        error!("Failed to persist P2P key: {}", e);
                    }
                    secret
                }
            };
            let p2p_secret_bytes: [u8; 32] = hex::decode(&p2p_secret_hex)
                .ok()
                .and_then(|v| v.try_into().ok())
                .unwrap_or_else(|| {
                    let mut bytes = [0u8; 32];
                    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
                    bytes
                });

            let p2p_state: Arc<Mutex<Option<Arc<p2p::P2pService>>>> =
                Arc::new(Mutex::new(None));
            {
                // Start the endpoint in the background, then reconnect saved
                // remote devices (both address- and Bliink-ID-based).
                let transfer = transfer.clone();
                let chat = chat_service.clone();
                let discovery_probe = discovery.clone();
                let manual = persisted.manual_devices.clone();
                let p2p_slot = p2p_state.clone();
                tauri::async_runtime::spawn(async move {
                    match p2p::P2pService::new(p2p_secret_bytes).await {
                        Ok(service) => {
                            let service = Arc::new(service);
                            transfer.set_p2p(service.clone());
                            chat.set_p2p(service.clone());
                            service.start(transfer, chat.clone());
                            *p2p_slot.lock().await = Some(service);
                        }
                        Err(e) => {
                            error!("Internet P2P unavailable: {}", e);
                        }
                    }
                    if !manual.is_empty() {
                        commands::spawn_manual_probes(chat, discovery_probe, manual);
                    }
                });
            }

            app.manage(AppState {
                discovery,
                transfer,
                chat: chat_service,
                history,
                settings: settings_state,
                manual_devices: Arc::new(Mutex::new(persisted.manual_devices.clone())),
                device_id,
                config_path,
                thumb_cache_dir,
                transfer_port: service_port,
                chat_port,
                p2p: p2p_state,
                p2p_secret: Some(p2p_secret_hex),
            });

            info!("Bliink backend initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_discovery,
            commands::stop_discovery,
            commands::get_devices,
            commands::send_file,
            commands::send_files,
            commands::send_folder,
            commands::pause_transfer,
            commands::resume_transfer,
            commands::cancel_transfer,
            commands::get_active_transfers,
            commands::respond_to_transfer,
            commands::get_history,
            commands::get_history_count,
            commands::clear_history,
            commands::get_settings,
            commands::update_settings,
            commands::get_device_info,
            commands::get_file_metadata,
            commands::get_thumbnail,
            commands::add_manual_device,
            commands::add_internet_device,
            commands::remove_manual_device,
            commands::get_network_info,
            commands::get_conversations,
            commands::get_chat_messages,
            commands::send_chat_message,
            commands::send_chat_attachment,
            commands::send_voice_note,
            commands::mark_conversation_read,
            commands::set_typing,
            commands::send_call_signal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
