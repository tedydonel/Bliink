use crate::types::{HistoryEntry, TransferDirection};
use log::{info, warn};
use rusqlite::Connection;
use std::path::Path;
use tokio::sync::Mutex;

pub struct HistoryStore {
    conn: Mutex<Connection>,
}

/// Delete a SQLite database and its WAL/SHM sidecars. Used to recover from a
/// corrupt file rather than crashing on every launch.
pub(crate) fn remove_db_files(db_path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let p = if suffix.is_empty() {
            db_path.to_path_buf()
        } else {
            let mut s = db_path.as_os_str().to_owned();
            s.push(suffix);
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&p);
    }
}

impl HistoryStore {
    /// Open the history store, recreating the database once if it turns out to
    /// be corrupt or otherwise unusable (a corrupt file would otherwise fail
    /// on every launch).
    pub fn new(db_path: &Path) -> Result<Self, String> {
        match Self::open(db_path) {
            Ok(store) => Ok(store),
            Err(e) => {
                warn!(
                    "History database at {:?} unusable ({}); recreating",
                    db_path, e
                );
                remove_db_files(db_path);
                Self::open(db_path)
            }
        }
    }

    fn open(db_path: &Path) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open history database: {}", e))?;

        // WAL + a busy timeout so this connection and the chat store (which
        // share the same file) don't trip over each other's locks.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "busy_timeout", 5000);

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_type TEXT NOT NULL,
                direction TEXT NOT NULL,
                device_id TEXT NOT NULL,
                device_name TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                hash TEXT,
                thumbnail TEXT,
                batch_id TEXT,
                batch_name TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_history_completed_at ON history(completed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_history_device_id ON history(device_id);
            CREATE INDEX IF NOT EXISTS idx_history_status ON history(status);",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // Migrate databases created before these columns existed; the
        // "duplicate column" error on re-runs is expected and ignored.
        for stmt in [
            "ALTER TABLE history ADD COLUMN thumbnail TEXT",
            "ALTER TABLE history ADD COLUMN batch_id TEXT",
            "ALTER TABLE history ADD COLUMN batch_name TEXT",
        ] {
            let _ = conn.execute(stmt, []);
        }

        // Force a read so a corrupt page surfaces here (and triggers a
        // recreate) instead of failing later at runtime.
        conn.query_row("SELECT COUNT(*) FROM history", [], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("History database integrity check failed: {}", e))?;

        info!("History database initialized at {:?}", db_path);
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub async fn add_entry(&self, entry: &HistoryEntry) -> Result<(), String> {
        let direction = match entry.direction {
            TransferDirection::Upload => "upload",
            TransferDirection::Download => "download",
        };

        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR REPLACE INTO history
                (id, file_name, file_size, file_type, direction, device_id, device_name, status, started_at, completed_at, hash, thumbnail, batch_id, batch_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                entry.id,
                entry.file_name,
                entry.file_size as i64,
                entry.file_type,
                direction,
                entry.device_id,
                entry.device_name,
                entry.status,
                entry.started_at,
                entry.completed_at,
                entry.hash,
                entry.thumbnail,
                entry.batch_id,
                entry.batch_name,
            ],
        )
        .map_err(|e| format!("Failed to insert history: {}", e))?;

        Ok(())
    }

    pub async fn get_entries(
        &self,
        limit: u32,
        offset: u32,
        search: Option<&str>,
        direction: Option<&str>,
        status: Option<&str>,
    ) -> Result<Vec<HistoryEntry>, String> {
        let mut sql = String::from(
            "SELECT id, file_name, file_size, file_type, direction, device_id, device_name, status, started_at, completed_at, hash, thumbnail, batch_id, batch_name FROM history WHERE 1=1",
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql + Send>> = Vec::new();

        if let Some(q) = search {
            if !q.is_empty() {
                let pattern = format!("%{}%", q);
                sql.push_str(" AND (file_name LIKE ? OR device_name LIKE ?)");
                params.push(Box::new(pattern.clone()));
                params.push(Box::new(pattern));
            }
        }

        if let Some(dir) = direction {
            if dir != "all" {
                sql.push_str(" AND direction = ?");
                params.push(Box::new(dir.to_string()));
            }
        }

        if let Some(st) = status {
            if st != "all" {
                sql.push_str(" AND status = ?");
                params.push(Box::new(st.to_string()));
            }
        }

        sql.push_str(" ORDER BY completed_at DESC LIMIT ? OFFSET ?");
        params.push(Box::new(limit as i64));
        params.push(Box::new(offset as i64));

        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Query error: {}", e))?;

        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
                |row| {
                    let file_size: i64 = row.get(2)?;
                    let direction_str: String = row.get(4)?;
                    Ok(HistoryEntry {
                        id: row.get(0)?,
                        file_name: row.get(1)?,
                        file_size: file_size as u64,
                        file_type: row.get(3)?,
                        direction: if direction_str == "upload" {
                            TransferDirection::Upload
                        } else {
                            TransferDirection::Download
                        },
                        device_id: row.get(5)?,
                        device_name: row.get(6)?,
                        status: row.get(7)?,
                        started_at: row.get(8)?,
                        completed_at: row.get(9)?,
                        hash: row.get(10)?,
                        thumbnail: row.get(11)?,
                        batch_id: row.get(12)?,
                        batch_name: row.get(13)?,
                    })
                },
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(entries)
    }

    pub async fn get_entry_count(&self) -> Result<u32, String> {
        let conn = self.conn.lock().await;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM history", [], |row| row.get(0))
            .map_err(|e| format!("Count error: {}", e))?;
        Ok(count as u32)
    }

    pub async fn clear(&self) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM history", [])
            .map_err(|e| format!("Clear error: {}", e))?;
        Ok(())
    }
}
