use crate::crypto::SecureStream;
use crate::discovery::DiscoveryService;
use crate::transfer::TransferEngine;
use crate::types::{
    ChatMessage, Conversation, Device, DeviceStatus, DeviceType, TransferStatus, TypingEvent,
};
use log::{error, info, warn};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use tokio::time::{interval, timeout, Duration};

const PING_INTERVAL: Duration = Duration::from_secs(20);
/// Reader gives up if nothing (not even a ping) arrives for this long.
const READ_TIMEOUT: Duration = Duration::from_secs(75);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TEXT_LEN: usize = 16 * 1024;

// ─── Wire protocol (JSON inside encrypted frames) ───────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatWire {
    Hello {
        device_id: String,
        device_name: String,
        #[serde(default)]
        protocol: u32,
        /// The peer's transfer listener port, so manually-added devices can
        /// receive files without broadcast discovery.
        #[serde(default)]
        transfer_port: u16,
    },
    Message {
        id: String,
        text: Option<String>,
        attachment_kind: Option<String>,
        attachment_name: Option<String>,
        attachment_size: Option<u64>,
        attachment_transfer_id: Option<String>,
        reply_to: Option<String>,
        sent_at: i64,
    },
    Delivered {
        id: String,
    },
    Read {
        ids: Vec<String>,
    },
    Typing {
        typing: bool,
    },
    Ping,
    Pong,
    /// Reserved for audio call signaling (SDP/ICE payloads).
    CallSignal {
        payload: serde_json::Value,
    },
}

/// Events surfaced to the frontend via Tauri events.
#[derive(Debug, Clone)]
pub enum ChatEvent {
    /// New or updated message — frontend upserts by id.
    Message(ChatMessage),
    /// A message just arrived from a peer (triggers a notification).
    Incoming {
        message: ChatMessage,
        peer_name: String,
    },
    Typing(TypingEvent),
    /// Conversation list changed (new message, unread counts, presence).
    ConversationsChanged,
    /// Incoming call signaling payload (used in the calls phase).
    CallSignal { device_id: String, payload: serde_json::Value },
}

// ─── Message store (SQLite) ─────────────────────────────────────

fn out_rank(status: &str) -> i32 {
    match status {
        "sending" => 0,
        "sent" => 1,
        "delivered" => 2,
        "read" => 3,
        _ => 9, // failed & co are terminal
    }
}

pub struct ChatStore {
    conn: Mutex<Connection>,
}

impl ChatStore {
    pub fn new(db_path: &Path) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open chat database: {}", e))?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "busy_timeout", 5000);

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                direction TEXT NOT NULL,
                text TEXT,
                attachment_kind TEXT,
                attachment_name TEXT,
                attachment_path TEXT,
                attachment_size INTEGER,
                attachment_transfer_id TEXT,
                reply_to TEXT,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_messages(conversation_id, created_at);
            CREATE TABLE IF NOT EXISTS conversations (
                device_id TEXT PRIMARY KEY,
                device_name TEXT NOT NULL,
                last_preview TEXT,
                last_message_at INTEGER,
                unread_count INTEGER NOT NULL DEFAULT 0
            );",
        )
        .map_err(|e| format!("Failed to create chat tables: {}", e))?;

        info!("Chat store initialized");
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub async fn insert_message(&self, m: &ChatMessage) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR IGNORE INTO chat_messages
                (id, conversation_id, direction, text, attachment_kind, attachment_name, attachment_path, attachment_size, attachment_transfer_id, reply_to, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                m.id,
                m.conversation_id,
                m.direction,
                m.text,
                m.attachment_kind,
                m.attachment_name,
                m.attachment_path,
                m.attachment_size.map(|s| s as i64),
                m.attachment_transfer_id,
                m.reply_to,
                m.status,
                m.created_at,
            ],
        )
        .map_err(|e| format!("Insert message error: {}", e))?;
        Ok(())
    }

    /// Update an outbound message's status, never downgrading
    /// (sent → delivered → read).
    pub async fn upgrade_status(&self, id: &str, status: &str) -> Result<Option<ChatMessage>, String> {
        {
            let conn = self.conn.lock().await;
            let current: Option<String> = conn
                .query_row(
                    "SELECT status FROM chat_messages WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .ok();
            let Some(current) = current else {
                return Ok(None);
            };
            if status != "failed" && out_rank(status) <= out_rank(&current) {
                return Ok(None);
            }
            conn.execute(
                "UPDATE chat_messages SET status = ?1 WHERE id = ?2",
                rusqlite::params![status, id],
            )
            .map_err(|e| format!("Update status error: {}", e))?;
        }
        self.get_message(id).await
    }

    pub async fn set_status(&self, id: &str, status: &str) -> Result<Option<ChatMessage>, String> {
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE chat_messages SET status = ?1 WHERE id = ?2",
                rusqlite::params![status, id],
            )
            .map_err(|e| format!("Update status error: {}", e))?;
        }
        self.get_message(id).await
    }

    pub async fn set_attachment_path(
        &self,
        id: &str,
        path: &str,
        status: &str,
    ) -> Result<Option<ChatMessage>, String> {
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE chat_messages SET attachment_path = ?1, status = ?2 WHERE id = ?3",
                rusqlite::params![path, status, id],
            )
            .map_err(|e| format!("Update attachment error: {}", e))?;
        }
        self.get_message(id).await
    }

    pub async fn get_message(&self, id: &str) -> Result<Option<ChatMessage>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT id, conversation_id, direction, text, attachment_kind, attachment_name, attachment_path, attachment_size, attachment_transfer_id, reply_to, status, created_at FROM chat_messages WHERE id = ?1")
            .map_err(|e| format!("Query error: {}", e))?;
        let msg = stmt
            .query_row([id], row_to_message)
            .ok();
        Ok(msg)
    }

    /// Latest `limit` messages of a conversation, oldest first.
    pub async fn get_messages(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, direction, text, attachment_kind, attachment_name, attachment_path, attachment_size, attachment_transfer_id, reply_to, status, created_at
                 FROM chat_messages WHERE conversation_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map(rusqlite::params![conversation_id, limit as i64], row_to_message)
            .map_err(|e| format!("Query error: {}", e))?;
        let mut messages: Vec<ChatMessage> = rows.filter_map(|r| r.ok()).collect();
        messages.reverse();
        Ok(messages)
    }

    pub async fn unread_inbound_ids(&self, conversation_id: &str) -> Vec<String> {
        let conn = self.conn.lock().await;
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM chat_messages WHERE conversation_id = ?1 AND direction = 'in' AND status = 'unread'",
        ) else {
            return vec![];
        };
        stmt.query_map([conversation_id], |row| row.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub async fn mark_inbound_read(&self, conversation_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE chat_messages SET status = 'read' WHERE conversation_id = ?1 AND direction = 'in' AND status = 'unread'",
            [conversation_id],
        )
        .map_err(|e| format!("Mark read error: {}", e))?;
        conn.execute(
            "UPDATE conversations SET unread_count = 0 WHERE device_id = ?1",
            [conversation_id],
        )
        .map_err(|e| format!("Reset unread error: {}", e))?;
        Ok(())
    }

    pub async fn bump_conversation(
        &self,
        device_id: &str,
        device_name: &str,
        preview: &str,
        at: i64,
        increment_unread: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO conversations (device_id, device_name, last_preview, last_message_at, unread_count)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(device_id) DO UPDATE SET
                device_name = excluded.device_name,
                last_preview = excluded.last_preview,
                last_message_at = excluded.last_message_at,
                unread_count = conversations.unread_count + ?5",
            rusqlite::params![device_id, device_name, preview, at, if increment_unread { 1 } else { 0 }],
        )
        .map_err(|e| format!("Conversation upsert error: {}", e))?;
        Ok(())
    }

    pub async fn get_conversations(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT device_id, device_name, last_preview, last_message_at, unread_count
                 FROM conversations ORDER BY last_message_at DESC",
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Conversation {
                    device_id: row.get(0)?,
                    device_name: row.get(1)?,
                    last_preview: row.get(2)?,
                    last_message_at: row.get(3)?,
                    unread_count: row.get::<_, i64>(4)? as u32,
                    online: false,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        direction: row.get(2)?,
        text: row.get(3)?,
        attachment_kind: row.get(4)?,
        attachment_name: row.get(5)?,
        attachment_path: row.get(6)?,
        attachment_size: row.get::<_, Option<i64>>(7)?.map(|s| s as u64),
        attachment_transfer_id: row.get(8)?,
        reply_to: row.get(9)?,
        status: row.get(10)?,
        created_at: row.get(11)?,
    })
}

// ─── Chat service: persistent channels + message flow ───────────

struct Channel {
    tx: mpsc::Sender<ChatWire>,
    epoch: u64,
}

pub struct ChatService {
    device_id: String,
    device_name: String,
    /// Our transfer listener port, shared in the hello.
    transfer_port: u16,
    store: Arc<ChatStore>,
    discovery: Arc<Mutex<DiscoveryService>>,
    transfer: Arc<TransferEngine>,
    media_dir: PathBuf,
    channels: Arc<RwLock<HashMap<String, Channel>>>,
    /// transfer_id → (message_id, inbound)
    pending_attachments: Arc<RwLock<HashMap<String, (String, bool)>>>,
    events_tx: broadcast::Sender<ChatEvent>,
    epoch: AtomicU64,
}

impl ChatService {
    pub fn new(
        device_id: String,
        device_name: String,
        transfer_port: u16,
        store: Arc<ChatStore>,
        discovery: Arc<Mutex<DiscoveryService>>,
        transfer: Arc<TransferEngine>,
        media_dir: PathBuf,
    ) -> Self {
        let (events_tx, _) = broadcast::channel(256);
        Self {
            device_id,
            device_name,
            transfer_port,
            store,
            discovery,
            transfer,
            media_dir,
            channels: Arc::new(RwLock::new(HashMap::new())),
            pending_attachments: Arc::new(RwLock::new(HashMap::new())),
            events_tx,
            epoch: AtomicU64::new(0),
        }
    }

    fn my_hello(&self) -> ChatWire {
        ChatWire::Hello {
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            protocol: crate::types::PROTOCOL_VERSION,
            transfer_port: self.transfer_port,
        }
    }

    pub fn events_receiver(&self) -> broadcast::Receiver<ChatEvent> {
        self.events_tx.subscribe()
    }

    fn emit(&self, event: ChatEvent) {
        let _ = self.events_tx.send(event);
    }

    /// Accept incoming chat channels and watch attachment transfers.
    pub fn start(self: &Arc<Self>, listener: TcpListener) {
        // Inbound channel acceptor
        let svc = self.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        info!("Incoming chat connection from {}", addr);
                        let svc = svc.clone();
                        tokio::spawn(async move {
                            if let Err(e) = svc.accept_channel(stream).await {
                                warn!("Chat handshake failed: {}", e);
                            }
                        });
                    }
                    Err(e) => error!("Chat accept error: {}", e),
                }
            }
        });

        // Attachment transfer completion watcher
        let svc = self.clone();
        let mut progress_rx = self.transfer.progress_receiver();
        tokio::spawn(async move {
            while let Ok(progress) = progress_rx.recv().await {
                let terminal = matches!(
                    progress.status,
                    TransferStatus::Completed | TransferStatus::Failed | TransferStatus::Cancelled
                );
                if !terminal {
                    continue;
                }
                let entry = svc.pending_attachments.write().await.remove(&progress.id);
                let Some((message_id, inbound)) = entry else {
                    continue;
                };
                svc.finish_attachment(&progress.id, &message_id, inbound, &progress.status)
                    .await;
            }
        });
    }

    async fn finish_attachment(
        &self,
        transfer_id: &str,
        message_id: &str,
        inbound: bool,
        status: &TransferStatus,
    ) {
        let completed = *status == TransferStatus::Completed;
        let updated = if inbound {
            if completed {
                // Receiver path: file landed in the chat media dir under the
                // transfer item's (possibly uniquified) display name.
                let file_name = self
                    .transfer
                    .get_transfer(transfer_id)
                    .await
                    .map(|t| t.file_name)
                    .unwrap_or_default();
                let path = self.media_dir.join(&file_name);
                self.store
                    .set_attachment_path(message_id, &path.to_string_lossy(), "unread")
                    .await
            } else {
                self.store.set_status(message_id, "failed").await
            }
        } else if completed {
            self.store.upgrade_status(message_id, "sent").await
        } else {
            self.store.set_status(message_id, "failed").await
        };

        if let Ok(Some(msg)) = updated {
            self.emit(ChatEvent::Message(msg));
        }
    }

    // ── Channel management ──

    async fn accept_channel(self: &Arc<Self>, stream: TcpStream) -> Result<(), String> {
        let mut secure = SecureStream::accept(stream).await?;
        let frame = timeout(HELLO_TIMEOUT, secure.recv_frame())
            .await
            .map_err(|_| "Hello timeout".to_string())??;
        let hello: ChatWire =
            serde_json::from_slice(&frame).map_err(|e| format!("Bad hello: {}", e))?;
        let ChatWire::Hello {
            device_id: peer_id,
            device_name: peer_name,
            protocol,
            ..
        } = hello
        else {
            return Err("Expected hello".to_string());
        };
        if protocol != crate::types::PROTOCOL_VERSION {
            return Err(format!(
                "Rejected chat from {}: incompatible protocol {}",
                peer_name, protocol
            ));
        }

        secure
            .send_frame(&serde_json::to_vec(&self.my_hello()).map_err(|e| e.to_string())?)
            .await?;

        self.register_channel(peer_id, peer_name, secure).await;
        Ok(())
    }

    /// Dial a peer's chat port, exchange hellos, and register the channel.
    /// Returns (peer_id, peer_name, peer_transfer_port, sender).
    async fn connect_to(
        self: &Arc<Self>,
        host: &str,
        port: u16,
    ) -> Result<(String, String, u16, mpsc::Sender<ChatWire>), String> {
        let stream = TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("Chat connection failed: {}", e))?;
        let mut secure = SecureStream::connect(stream).await?;

        secure
            .send_frame(&serde_json::to_vec(&self.my_hello()).map_err(|e| e.to_string())?)
            .await?;
        let frame = timeout(HELLO_TIMEOUT, secure.recv_frame())
            .await
            .map_err(|_| "Hello timeout".to_string())??;
        let ChatWire::Hello {
            device_id: peer_id,
            device_name: peer_name,
            protocol,
            transfer_port,
        } = serde_json::from_slice(&frame).map_err(|e| format!("Bad hello: {}", e))?
        else {
            return Err("Expected hello".to_string());
        };
        if protocol != crate::types::PROTOCOL_VERSION {
            return Err(
                "This device runs an incompatible Bliink version — update both devices"
                    .to_string(),
            );
        }

        let tx = self
            .register_channel(peer_id.clone(), peer_name.clone(), secure)
            .await;
        Ok((peer_id, peer_name, transfer_port, tx))
    }

    /// Get the channel to a peer, connecting if needed.
    async fn ensure_channel(
        self: &Arc<Self>,
        device_id: &str,
    ) -> Result<mpsc::Sender<ChatWire>, String> {
        if let Some(ch) = self.channels.read().await.get(device_id) {
            return Ok(ch.tx.clone());
        }

        let device = {
            let discovery = self.discovery.lock().await;
            discovery.get_device(device_id)
        }
        .ok_or_else(|| "Device is not reachable on the network".to_string())?;
        if device.chat_port == 0 {
            return Err("This device is running an older Bliink without chat".to_string());
        }

        let (_, _, _, tx) = self.connect_to(&device.ip, device.chat_port).await?;
        Ok(tx)
    }

    /// Probe an address (manual / remote device): connect, exchange hellos,
    /// keep the channel, and return a Device entry for the discovery list.
    pub async fn probe_remote(self: &Arc<Self>, host: &str, port: u16) -> Result<Device, String> {
        let (peer_id, peer_name, peer_transfer_port, _) = self.connect_to(host, port).await?;
        if peer_id == self.device_id {
            return Err("That address is this device".to_string());
        }
        Ok(Device {
            id: peer_id,
            name: peer_name,
            ip: host.to_string(),
            port: peer_transfer_port,
            chat_port: port,
            device_type: DeviceType::Unknown,
            status: DeviceStatus::Online,
            os: None,
            last_seen: chrono::Utc::now().timestamp_millis(),
            manual: true,
            compatible: true,
        })
    }

    async fn register_channel(
        self: &Arc<Self>,
        peer_id: String,
        peer_name: String,
        secure: SecureStream,
    ) -> mpsc::Sender<ChatWire> {
        let (mut reader, mut writer) = secure.into_split();
        let (tx, mut rx) = mpsc::channel::<ChatWire>(64);
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst);

        self.channels.write().await.insert(
            peer_id.clone(),
            Channel {
                tx: tx.clone(),
                epoch,
            },
        );
        info!("Chat channel up with {} ({})", peer_name, peer_id);
        self.emit(ChatEvent::ConversationsChanged);

        // Writer: outbound frames + keepalive pings
        tokio::spawn(async move {
            let mut ping = interval(PING_INTERVAL);
            ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    msg = rx.recv() => {
                        let Some(msg) = msg else { break };
                        let Ok(bytes) = serde_json::to_vec(&msg) else { continue };
                        if writer.send_frame(&bytes).await.is_err() {
                            break;
                        }
                    }
                    _ = ping.tick() => {
                        let Ok(bytes) = serde_json::to_vec(&ChatWire::Ping) else { continue };
                        if writer.send_frame(&bytes).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // Reader: inbound frames
        let svc = self.clone();
        let reply_tx = tx.clone();
        let reader_peer = peer_id.clone();
        let reader_name = peer_name.clone();
        tokio::spawn(async move {
            loop {
                let frame = match timeout(READ_TIMEOUT, reader.recv_frame()).await {
                    Ok(Ok(frame)) => frame,
                    _ => break,
                };
                match serde_json::from_slice::<ChatWire>(&frame) {
                    Ok(wire) => {
                        svc.handle_wire(&reader_peer, &reader_name, wire, &reply_tx)
                            .await;
                    }
                    Err(e) => warn!("Bad chat frame from {}: {}", reader_peer, e),
                }
            }
            // Tear down (only if we're still the current channel)
            let mut channels = svc.channels.write().await;
            if channels.get(&reader_peer).map(|c| c.epoch) == Some(epoch) {
                channels.remove(&reader_peer);
                info!("Chat channel closed with {}", reader_peer);
            }
            drop(channels);
            svc.emit(ChatEvent::ConversationsChanged);
        });

        tx
    }

    async fn handle_wire(
        &self,
        peer_id: &str,
        peer_name: &str,
        wire: ChatWire,
        reply_tx: &mpsc::Sender<ChatWire>,
    ) {
        match wire {
            ChatWire::Message {
                id,
                text,
                attachment_kind,
                attachment_name,
                attachment_size,
                attachment_transfer_id,
                reply_to,
                sent_at: _,
            } => {
                let has_attachment = attachment_transfer_id.is_some();
                let msg = ChatMessage {
                    id: id.clone(),
                    conversation_id: peer_id.to_string(),
                    direction: "in".to_string(),
                    text: text.map(|t| t.chars().take(MAX_TEXT_LEN).collect()),
                    attachment_kind,
                    attachment_name,
                    attachment_path: None,
                    attachment_size,
                    attachment_transfer_id: attachment_transfer_id.clone(),
                    reply_to,
                    status: if has_attachment {
                        "receiving".to_string()
                    } else {
                        "unread".to_string()
                    },
                    created_at: chrono::Utc::now().timestamp_millis(),
                };
                if let Err(e) = self.store.insert_message(&msg).await {
                    error!("Failed to store message: {}", e);
                    return;
                }
                if let Some(tid) = attachment_transfer_id {
                    self.pending_attachments
                        .write()
                        .await
                        .insert(tid, (id.clone(), true));
                }
                let _ = self
                    .store
                    .bump_conversation(peer_id, peer_name, &preview(&msg), msg.created_at, true)
                    .await;
                self.emit(ChatEvent::Incoming {
                    message: msg,
                    peer_name: peer_name.to_string(),
                });
                self.emit(ChatEvent::ConversationsChanged);
                let _ = reply_tx.send(ChatWire::Delivered { id }).await;
            }
            ChatWire::Delivered { id } => {
                if let Ok(Some(msg)) = self.store.upgrade_status(&id, "delivered").await {
                    self.emit(ChatEvent::Message(msg));
                }
            }
            ChatWire::Read { ids } => {
                for id in ids {
                    if let Ok(Some(msg)) = self.store.upgrade_status(&id, "read").await {
                        self.emit(ChatEvent::Message(msg));
                    }
                }
            }
            ChatWire::Typing { typing } => {
                self.emit(ChatEvent::Typing(TypingEvent {
                    device_id: peer_id.to_string(),
                    typing,
                }));
            }
            ChatWire::Ping => {
                let _ = reply_tx.send(ChatWire::Pong).await;
            }
            ChatWire::Pong => {}
            // Hello is only valid during the handshake
            ChatWire::Hello { .. } => {}
            ChatWire::CallSignal { payload } => {
                self.emit(ChatEvent::CallSignal {
                    device_id: peer_id.to_string(),
                    payload,
                });
            }
        }
    }

    // ── Public API (called from Tauri commands) ──

    pub async fn send_text(
        self: &Arc<Self>,
        device_id: &str,
        text: String,
        reply_to: Option<String>,
    ) -> Result<ChatMessage, String> {
        let text: String = text.chars().take(MAX_TEXT_LEN).collect();
        if text.trim().is_empty() {
            return Err("Message is empty".to_string());
        }

        let mut msg = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: device_id.to_string(),
            direction: "out".to_string(),
            text: Some(text),
            attachment_kind: None,
            attachment_name: None,
            attachment_path: None,
            attachment_size: None,
            attachment_transfer_id: None,
            reply_to,
            status: "sending".to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        self.store.insert_message(&msg).await?;
        let peer_name = self.peer_name(device_id).await;
        let _ = self
            .store
            .bump_conversation(device_id, &peer_name, &preview(&msg), msg.created_at, false)
            .await;
        self.emit(ChatEvent::ConversationsChanged);

        msg.status = match self.deliver(device_id, &msg).await {
            Ok(_) => "sent".to_string(),
            Err(e) => {
                warn!("Failed to send message to {}: {}", device_id, e);
                "failed".to_string()
            }
        };
        let _ = self.store.set_status(&msg.id, &msg.status).await;
        self.emit(ChatEvent::Message(msg.clone()));
        Ok(msg)
    }

    pub async fn send_attachment(
        self: &Arc<Self>,
        device_id: &str,
        file_path: &str,
        kind_hint: Option<String>,
        reply_to: Option<String>,
    ) -> Result<ChatMessage, String> {
        let path = PathBuf::from(file_path);
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|e| format!("Cannot read file: {}", e))?;
        if !meta.is_file() {
            return Err("Not a file".to_string());
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_string());
        let kind = kind_hint.unwrap_or_else(|| infer_kind(&name));

        let device = {
            let discovery = self.discovery.lock().await;
            discovery.get_device(device_id)
        }
        .ok_or_else(|| "Device is not reachable on the network".to_string())?;

        let msg_id = uuid::Uuid::new_v4().to_string();
        let transfer_id = self
            .transfer
            .send_chat_attachment(
                file_path,
                &device.ip,
                device.port,
                device_id,
                &device.name,
                &self.device_id,
                &self.device_name,
                &msg_id,
            )
            .await?;

        let mut msg = ChatMessage {
            id: msg_id,
            conversation_id: device_id.to_string(),
            direction: "out".to_string(),
            text: None,
            attachment_kind: Some(kind),
            attachment_name: Some(name),
            attachment_path: Some(file_path.to_string()),
            attachment_size: Some(meta.len()),
            attachment_transfer_id: Some(transfer_id.clone()),
            reply_to,
            status: "sending".to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        self.store.insert_message(&msg).await?;
        self.pending_attachments
            .write()
            .await
            .insert(transfer_id, (msg.id.clone(), false));
        let _ = self
            .store
            .bump_conversation(device_id, &device.name, &preview(&msg), msg.created_at, false)
            .await;
        self.emit(ChatEvent::ConversationsChanged);

        if let Err(e) = self.deliver(device_id, &msg).await {
            warn!("Failed to announce attachment to {}: {}", device_id, e);
            msg.status = "failed".to_string();
            let _ = self.store.set_status(&msg.id, "failed").await;
        }
        self.emit(ChatEvent::Message(msg.clone()));
        Ok(msg)
    }

    /// Persist a recorded voice note (webm/opus bytes) and send it.
    pub async fn send_voice_note(
        self: &Arc<Self>,
        device_id: &str,
        data: Vec<u8>,
    ) -> Result<ChatMessage, String> {
        if data.is_empty() {
            return Err("Empty recording".to_string());
        }
        tokio::fs::create_dir_all(&self.media_dir)
            .await
            .map_err(|e| format!("Media dir error: {}", e))?;
        let file_name = format!("voice-{}.webm", uuid::Uuid::new_v4());
        let path = self.media_dir.join(&file_name);
        tokio::fs::write(&path, &data)
            .await
            .map_err(|e| format!("Failed to save recording: {}", e))?;
        self.send_attachment(
            device_id,
            &path.to_string_lossy(),
            Some("voice".to_string()),
            None,
        )
        .await
    }

    async fn deliver(self: &Arc<Self>, device_id: &str, msg: &ChatMessage) -> Result<(), String> {
        let tx = self.ensure_channel(device_id).await?;
        tx.send(ChatWire::Message {
            id: msg.id.clone(),
            text: msg.text.clone(),
            attachment_kind: msg.attachment_kind.clone(),
            attachment_name: msg.attachment_name.clone(),
            attachment_size: msg.attachment_size,
            attachment_transfer_id: msg.attachment_transfer_id.clone(),
            reply_to: msg.reply_to.clone(),
            sent_at: msg.created_at,
        })
        .await
        .map_err(|_| "Channel closed".to_string())
    }

    pub async fn mark_read(self: &Arc<Self>, device_id: &str) -> Result<(), String> {
        let ids = self.store.unread_inbound_ids(device_id).await;
        self.store.mark_inbound_read(device_id).await?;
        if !ids.is_empty() {
            // Read receipts only ride an existing channel — don't dial out
            if let Some(ch) = self.channels.read().await.get(device_id) {
                let _ = ch.tx.send(ChatWire::Read { ids }).await;
            }
        }
        self.emit(ChatEvent::ConversationsChanged);
        Ok(())
    }

    pub async fn set_typing(&self, device_id: &str, typing: bool) {
        if let Some(ch) = self.channels.read().await.get(device_id) {
            let _ = ch.tx.send(ChatWire::Typing { typing }).await;
        }
    }

    /// Send a call-signaling payload (used by the calls phase).
    pub async fn send_call_signal(
        self: &Arc<Self>,
        device_id: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let tx = self.ensure_channel(device_id).await?;
        tx.send(ChatWire::CallSignal { payload })
            .await
            .map_err(|_| "Channel closed".to_string())
    }

    pub async fn get_conversations(&self) -> Result<Vec<Conversation>, String> {
        let mut conversations = self.store.get_conversations().await?;
        let online_channels: Vec<String> = self.channels.read().await.keys().cloned().collect();
        let discovered: Vec<String> = {
            let discovery = self.discovery.lock().await;
            discovery.get_devices().into_iter().map(|d| d.id).collect()
        };
        for conv in &mut conversations {
            conv.online = online_channels.contains(&conv.device_id)
                || discovered.contains(&conv.device_id);
        }
        Ok(conversations)
    }

    pub async fn get_messages(
        &self,
        device_id: &str,
        limit: u32,
    ) -> Result<Vec<ChatMessage>, String> {
        self.store.get_messages(device_id, limit).await
    }

    async fn peer_name(&self, device_id: &str) -> String {
        if let Some(device) = self.discovery.lock().await.get_device(device_id) {
            return device.name;
        }
        self.store
            .get_conversations()
            .await
            .ok()
            .and_then(|convs| {
                convs
                    .into_iter()
                    .find(|c| c.device_id == device_id)
                    .map(|c| c.device_name)
            })
            .unwrap_or_else(|| "Unknown device".to_string())
    }
}

pub(crate) fn preview(msg: &ChatMessage) -> String {
    if let Some(text) = &msg.text {
        return text.chars().take(80).collect();
    }
    match msg.attachment_kind.as_deref() {
        Some("image") => "📷 Photo".to_string(),
        Some("voice") => "🎤 Voice message".to_string(),
        _ => format!(
            "📎 {}",
            msg.attachment_name.clone().unwrap_or_else(|| "File".to_string())
        ),
    }
}

fn infer_kind(file_name: &str) -> String {
    let ext = file_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" => "image".to_string(),
        _ => "file".to_string(),
    }
}
