use serde::{Deserialize, Serialize};

/// Bumped whenever the wire protocol changes incompatibly. Devices with a
/// different protocol see a clear "update Bliink" message instead of
/// cryptic failures.
pub const PROTOCOL_VERSION: u32 = 1;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceType {
    Desktop,
    Laptop,
    Phone,
    Tablet,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    Online,
    Connected,
    Transferring,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    /// Port for the persistent chat channel listener.
    #[serde(default)]
    pub chat_port: u16,
    pub device_type: DeviceType,
    pub status: DeviceStatus,
    pub os: Option<String>,
    pub last_seen: i64,
    /// Added by address rather than discovered — survives pruning.
    #[serde(default)]
    pub manual: bool,
    /// False when the peer runs a different protocol version.
    #[serde(default = "default_true")]
    pub compatible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Pending,
    Transferring,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItem {
    pub id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub progress: f64,
    pub speed: f64,
    pub status: TransferStatus,
    pub direction: TransferDirection,
    pub device_id: String,
    pub device_name: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
    /// Short code derived from the encrypted session key; matching codes on
    /// both screens rule out a man-in-the-middle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_code: Option<String>,
    /// Small JPEG preview as a data URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// Set when this transfer is part of a multi-file batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// Folder name for folder batches; None for loose-file batches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_total_files: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_total_bytes: Option<u64>,
    /// Set when this transfer carries a chat attachment — hidden from the
    /// Transfer page and history; the chat UI tracks it instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_message_id: Option<String>,
}

/// Emitted to the frontend when a remote device offers a file and
/// auto-accept is off — the user must accept or decline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub sender_id: String,
    pub sender_name: String,
    pub verification_code: String,
    /// When true (the receiver's require_pin setting), the UI must make the
    /// user confirm the code matches before it allows accepting.
    pub require_code_confirm: bool,
    /// Set when this file is part of a folder transfer — accepting covers
    /// the whole batch.
    pub batch_name: Option<String>,
    pub batch_total_files: Option<u32>,
    pub batch_total_bytes: Option<u64>,
    /// Small JPEG preview of the offered file, if the sender provided one.
    pub thumbnail: Option<String>,
}

/// Emitted to the sender's frontend once the session is established so the
/// user can compare the code with the receiver's screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCode {
    pub id: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub direction: TransferDirection,
    pub device_id: String,
    pub device_name: String,
    pub status: String,
    pub started_at: i64,
    pub completed_at: i64,
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_name: Option<String>,
}

fn default_transfer_port() -> u16 {
    9100
}
fn default_chat_port() -> u16 {
    9101
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub download_path: String,
    pub auto_accept_from_paired: bool,
    pub require_pin: bool,
    pub show_notifications: bool,
    pub max_concurrent_transfers: u32,
    pub chunk_size: u64,
    pub device_name: String,
    /// Fixed listener ports so remote peers can dial in (0 = random).
    /// Applied on next launch.
    #[serde(default = "default_transfer_port")]
    pub transfer_port: u16,
    #[serde(default = "default_chat_port")]
    pub chat_port: u16,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            download_path: String::new(),
            auto_accept_from_paired: false,
            require_pin: false,
            show_notifications: true,
            max_concurrent_transfers: 3,
            chunk_size: 1024 * 1024,
            device_name: hostname::get()
                .ok()
                .and_then(|h| h.into_string().ok())
                .unwrap_or_else(|| "My PC".to_string()),
            transfer_port: default_transfer_port(),
            chat_port: default_chat_port(),
        }
    }
}

/// A peer added by address (VPN/port-forward scenarios) rather than
/// discovered via broadcast. Persisted in settings.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualDevice {
    pub host: String,
    /// The peer's chat port — its transfer port is learned via the hello.
    pub port: u16,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Settings and device identity persisted to settings.json in the app data dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedConfig {
    pub device_id: String,
    pub settings: AppSettings,
    #[serde(default)]
    pub manual_devices: Vec<ManualDevice>,
}

// ─── Chat ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    /// Peer device id this message belongs to.
    pub conversation_id: String,
    /// "in" | "out"
    pub direction: String,
    pub text: Option<String>,
    /// "image" | "voice" | "file"
    pub attachment_kind: Option<String>,
    pub attachment_name: Option<String>,
    pub attachment_path: Option<String>,
    pub attachment_size: Option<u64>,
    pub attachment_transfer_id: Option<String>,
    /// Id of the message this one replies to.
    pub reply_to: Option<String>,
    /// out: sending | sent | delivered | read | failed
    /// in:  receiving | unread | read
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub device_id: String,
    pub device_name: String,
    pub last_preview: Option<String>,
    pub last_message_at: Option<i64>,
    pub unread_count: u32,
    /// Whether the peer is currently reachable (discovered or channel up).
    pub online: bool,
}

/// Typing indicator event payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingEvent {
    pub device_id: String,
    pub typing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub id: String,
    pub progress: f64,
    pub speed: f64,
    pub status: TransferStatus,
    pub error: Option<String>,
}
