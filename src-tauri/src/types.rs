use serde::{Deserialize, Serialize};

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
    pub device_type: DeviceType,
    pub status: DeviceStatus,
    pub os: Option<String>,
    pub last_seen: i64,
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
        }
    }
}

/// Settings and device identity persisted to settings.json in the app data dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedConfig {
    pub device_id: String,
    pub settings: AppSettings,
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
