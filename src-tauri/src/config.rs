use crate::types::{AppSettings, PersistedConfig};
use log::{error, warn};
use std::path::Path;

/// Load settings.json from the app data dir, creating it with defaults
/// (and a freshly generated device id) on first run or if unreadable.
pub fn load_or_create(path: &Path) -> PersistedConfig {
    if let Ok(raw) = std::fs::read_to_string(path) {
        match serde_json::from_str::<PersistedConfig>(&raw) {
            Ok(cfg) => return cfg,
            Err(e) => warn!("Invalid settings file at {:?}, recreating: {}", path, e),
        }
    }

    let cfg = PersistedConfig {
        device_id: uuid::Uuid::new_v4().to_string(),
        settings: AppSettings::default(),
    };
    if let Err(e) = save(path, &cfg) {
        error!("Failed to write settings file: {}", e);
    }
    cfg
}

pub fn save(path: &Path, cfg: &PersistedConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write settings: {}", e))
}
