use crate::crypto::SecureStream;
use crate::types::{
    TransferCode, TransferDirection, TransferItem, TransferProgress, TransferRequest,
    TransferStatus,
};
use log::{error, info, warn};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, oneshot, RwLock};
use tokio::time::{timeout, Duration};

const CHUNK_SIZE: usize = 1024 * 1024; // 1 MB default
const MAX_HEADER_LEN: usize = 256 * 1024; // leaves room for an embedded thumbnail
const MAX_BATCH_FILES: usize = 10_000;
/// Cap for the thumbnail embedded in the transfer header (binary JPEG size).
const MAX_EMBED_THUMB: usize = 64 * 1024;
const EMBED_THUMB_PX: u32 = 96;
const EMBED_THUMB_QUALITY: u8 = 55;

// Protocol response bytes (sent inside encrypted frames)
const RESP_DECLINE: u8 = 0;
const RESP_ACCEPT: u8 = 1;

/// How long the receiving user gets to accept an incoming file.
const ACCEPT_DECISION_TIMEOUT: Duration = Duration::from_secs(60);
/// Senders wait slightly longer than the receiver's decision window.
const SENDER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(75);
/// Wait for the receiver's hash verification after the last byte.
const VERIFY_ACK_TIMEOUT: Duration = Duration::from_secs(60);
/// Batch accept/decline decisions expire after this long.
const BATCH_DECISION_TTL_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Clone)]
pub enum TransferCommand {
    Pause(String),
    Resume(String),
    Cancel(String),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TransferHeader {
    pub id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub chunk_size: u64,
    pub total_chunks: u64,
    pub hash: String,
    pub sender_id: String,
    pub sender_name: String,
    /// Path relative to the receiver's download dir (folder transfers).
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub batch_name: Option<String>,
    #[serde(default)]
    pub batch_total_files: Option<u32>,
    #[serde(default)]
    pub batch_total_bytes: Option<u64>,
    /// Small JPEG preview as a data URL so the receiver can see what's
    /// coming before accepting.
    #[serde(default)]
    pub thumbnail: Option<String>,
}

/// Batch metadata shared by every file in a multi-file send.
#[derive(Debug, Clone)]
struct BatchMeta {
    id: String,
    /// Folder name for folder sends; None for loose-file batches.
    name: Option<String>,
    total_files: u32,
    total_bytes: u64,
}

/// The receiver's remembered accept/decline decision for a batch.
struct BatchDecision {
    accepted: bool,
    remaining: u32,
    decided_at: i64,
}

struct SendJob {
    path: PathBuf,
    target: String,
    device_id: String,
    device_name: String,
    sender_id: String,
    sender_name: String,
    relative_path: Option<String>,
    batch: Option<BatchMeta>,
}

/// A registered transfer ready to run: the item is already in the active
/// map and the header (including hash) is computed.
pub struct PreparedSend {
    transfer_id: String,
    path: PathBuf,
    target: String,
    header: TransferHeader,
    chunk_size: usize,
}

pub struct TransferEngine {
    active_transfers: Arc<RwLock<HashMap<String, TransferItem>>>,
    command_tx: broadcast::Sender<TransferCommand>,
    progress_tx: broadcast::Sender<TransferProgress>,
    request_tx: broadcast::Sender<TransferRequest>,
    code_tx: broadcast::Sender<TransferCode>,
    download_path: Arc<RwLock<PathBuf>>,
    chunk_size: Arc<RwLock<usize>>,
    auto_accept: Arc<RwLock<bool>>,
    require_pin: Arc<RwLock<bool>>,
    pending_requests: Arc<RwLock<HashMap<String, oneshot::Sender<bool>>>>,
    batch_decisions: Arc<RwLock<HashMap<String, BatchDecision>>>,
}

/// Everything an incoming connection handler needs, cloned per connection.
#[derive(Clone)]
struct ReceiverCtx {
    active: Arc<RwLock<HashMap<String, TransferItem>>>,
    command_tx: broadcast::Sender<TransferCommand>,
    progress_tx: broadcast::Sender<TransferProgress>,
    request_tx: broadcast::Sender<TransferRequest>,
    download_path: Arc<RwLock<PathBuf>>,
    auto_accept: Arc<RwLock<bool>>,
    require_pin: Arc<RwLock<bool>>,
    pending: Arc<RwLock<HashMap<String, oneshot::Sender<bool>>>>,
    batches: Arc<RwLock<HashMap<String, BatchDecision>>>,
}

impl TransferEngine {
    pub fn new() -> Self {
        let (command_tx, _) = broadcast::channel(64);
        let (progress_tx, _) = broadcast::channel(256);
        let (request_tx, _) = broadcast::channel(32);
        let (code_tx, _) = broadcast::channel(32);

        let download_path = dirs_next::download_dir()
            .unwrap_or_else(|| PathBuf::from("."));

        Self {
            active_transfers: Arc::new(RwLock::new(HashMap::new())),
            command_tx,
            progress_tx,
            request_tx,
            code_tx,
            download_path: Arc::new(RwLock::new(download_path)),
            chunk_size: Arc::new(RwLock::new(CHUNK_SIZE)),
            auto_accept: Arc::new(RwLock::new(false)),
            require_pin: Arc::new(RwLock::new(false)),
            pending_requests: Arc::new(RwLock::new(HashMap::new())),
            batch_decisions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn progress_receiver(&self) -> broadcast::Receiver<TransferProgress> {
        self.progress_tx.subscribe()
    }

    pub fn request_receiver(&self) -> broadcast::Receiver<TransferRequest> {
        self.request_tx.subscribe()
    }

    pub fn code_receiver(&self) -> broadcast::Receiver<TransferCode> {
        self.code_tx.subscribe()
    }

    pub fn set_download_path(&self, path: PathBuf) {
        let dp = self.download_path.clone();
        tokio::spawn(async move {
            *dp.write().await = path;
        });
    }

    pub fn set_chunk_size(&self, size: usize) {
        let cs = self.chunk_size.clone();
        tokio::spawn(async move {
            *cs.write().await = size;
        });
    }

    pub fn set_auto_accept(&self, value: bool) {
        let aa = self.auto_accept.clone();
        tokio::spawn(async move {
            *aa.write().await = value;
        });
    }

    pub fn set_require_pin(&self, value: bool) {
        let rp = self.require_pin.clone();
        tokio::spawn(async move {
            *rp.write().await = value;
        });
    }

    /// Resolve a pending accept/decline prompt for an incoming transfer.
    pub async fn respond_to_request(&self, id: &str, accept: bool) {
        if let Some(tx) = self.pending_requests.write().await.remove(id) {
            let _ = tx.send(accept);
        }
    }

    pub async fn start_with_listener(&self, listener: TcpListener) -> Result<(), String> {
        let local_addr = listener.local_addr()
            .map_err(|e| format!("Failed to get local address: {}", e))?;
        info!("Transfer listener started on {}", local_addr);

        let ctx = ReceiverCtx {
            active: self.active_transfers.clone(),
            command_tx: self.command_tx.clone(),
            progress_tx: self.progress_tx.clone(),
            request_tx: self.request_tx.clone(),
            download_path: self.download_path.clone(),
            auto_accept: self.auto_accept.clone(),
            require_pin: self.require_pin.clone(),
            pending: self.pending_requests.clone(),
            batches: self.batch_decisions.clone(),
        };

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        info!("Incoming transfer from {}", addr);
                        let ctx = ctx.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_incoming(stream, ctx).await {
                                error!("Transfer receive error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("Accept error: {}", e);
                    }
                }
            }
        });

        Ok(())
    }

    /// Register a transfer and compute its header. The returned value can be
    /// run in the background (spawn_send) or awaited inline (run_send).
    async fn prepare_send(&self, job: SendJob) -> Result<PreparedSend, String> {
        if !job.path.exists() {
            return Err("File does not exist".to_string());
        }

        let metadata = fs::metadata(&job.path)
            .await
            .map_err(|e| format!("Failed to read file metadata: {}", e))?;

        let file_name = job
            .path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let display_name = job.relative_path.clone().unwrap_or_else(|| file_name.clone());
        let file_size = metadata.len();
        let file_type = mime_guess_from_ext(&job.path);

        let chunk_size = *self.chunk_size.read().await;
        let total_chunks = (file_size + chunk_size as u64 - 1) / chunk_size as u64;

        let transfer_id = uuid::Uuid::new_v4().to_string();

        info!("Computing hash for {}", display_name);
        let hash = compute_file_hash(&job.path).await?;

        // Embed a small preview so the receiver sees it before accepting
        let thumbnail = crate::thumbs::thumbnail_jpeg(
            job.path.clone(),
            EMBED_THUMB_PX,
            EMBED_THUMB_QUALITY,
        )
        .await
        .filter(|jpeg| jpeg.len() <= MAX_EMBED_THUMB)
        .map(|jpeg| crate::thumbs::to_data_url(&jpeg));

        let header = TransferHeader {
            id: transfer_id.clone(),
            file_name,
            file_size,
            file_type: file_type.clone(),
            chunk_size: chunk_size as u64,
            total_chunks,
            hash,
            sender_id: job.sender_id,
            sender_name: job.sender_name,
            relative_path: job.relative_path,
            batch_id: job.batch.as_ref().map(|b| b.id.clone()),
            batch_name: job.batch.as_ref().and_then(|b| b.name.clone()),
            batch_total_files: job.batch.as_ref().map(|b| b.total_files),
            batch_total_bytes: job.batch.as_ref().map(|b| b.total_bytes),
            thumbnail: thumbnail.clone(),
        };

        let transfer = TransferItem {
            id: transfer_id.clone(),
            file_name: display_name,
            file_size,
            file_type,
            progress: 0.0,
            speed: 0.0,
            status: TransferStatus::Pending,
            direction: TransferDirection::Upload,
            device_id: job.device_id,
            device_name: job.device_name,
            started_at: chrono::Utc::now().timestamp_millis(),
            completed_at: None,
            error: None,
            verification_code: None,
            thumbnail,
            batch_id: job.batch.as_ref().map(|b| b.id.clone()),
            batch_name: job.batch.as_ref().and_then(|b| b.name.clone()),
            batch_total_files: job.batch.as_ref().map(|b| b.total_files),
            batch_total_bytes: job.batch.as_ref().map(|b| b.total_bytes),
        };

        self.active_transfers
            .write()
            .await
            .insert(transfer_id.clone(), transfer);

        Ok(PreparedSend {
            transfer_id,
            path: job.path,
            target: job.target,
            header,
            chunk_size,
        })
    }

    /// Run a prepared transfer to completion, recording failures.
    pub async fn run_send(&self, prepared: PreparedSend) {
        let mut command_rx = self.command_tx.subscribe();
        let tid = prepared.transfer_id.clone();
        match send_file_impl(
            &prepared.path,
            &prepared.target,
            prepared.header,
            prepared.chunk_size,
            self.active_transfers.clone(),
            self.progress_tx.clone(),
            self.code_tx.clone(),
            &mut command_rx,
            &tid,
        )
        .await
        {
            Ok(_) => {
                info!("Send task for {} finished", tid);
            }
            Err(e) => {
                error!("Transfer {} failed: {}", tid, e);
                set_status(&self.active_transfers, &tid, TransferStatus::Failed, Some(e.clone()))
                    .await;
                let _ = self.progress_tx.send(TransferProgress {
                    id: tid,
                    progress: 0.0,
                    speed: 0.0,
                    status: TransferStatus::Failed,
                    error: Some(e),
                });
            }
        }
    }

    pub fn spawn_send(self: &Arc<Self>, prepared: PreparedSend) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.run_send(prepared).await;
        });
    }

    pub async fn send_file(
        self: &Arc<Self>,
        file_path: &str,
        device_ip: &str,
        device_port: u16,
        device_id: &str,
        device_name: &str,
        sender_id: &str,
        sender_name: &str,
    ) -> Result<String, String> {
        info!("Initiating send_file: path={}, target={}:{}", file_path, device_ip, device_port);
        let job = SendJob {
            path: PathBuf::from(file_path),
            target: format!("{}:{}", device_ip, device_port),
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            sender_id: sender_id.to_string(),
            sender_name: sender_name.to_string(),
            relative_path: None,
            batch: None,
        };
        let prepared = self.prepare_send(job).await?;
        let transfer_id = prepared.transfer_id.clone();
        self.spawn_send(prepared);
        Ok(transfer_id)
    }

    /// Send a set of (path, optional relative path) files sequentially as
    /// one batch. Stops early if the receiver declines the batch.
    fn spawn_batch(
        self: &Arc<Self>,
        files: Vec<(PathBuf, Option<String>)>,
        batch: Option<BatchMeta>,
        target: String,
        device_id: String,
        device_name: String,
        sender_id: String,
        sender_name: String,
    ) {
        let engine = self.clone();
        tokio::spawn(async move {
            for (path, relative_path) in files {
                let label = relative_path
                    .clone()
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                let job = SendJob {
                    path,
                    target: target.clone(),
                    device_id: device_id.clone(),
                    device_name: device_name.clone(),
                    sender_id: sender_id.clone(),
                    sender_name: sender_name.clone(),
                    relative_path,
                    batch: batch.clone(),
                };
                let transfer_id = match engine.prepare_send(job).await {
                    Ok(prepared) => {
                        let id = prepared.transfer_id.clone();
                        engine.run_send(prepared).await;
                        id
                    }
                    Err(e) => {
                        error!("Failed to send {}: {}", label, e);
                        continue;
                    }
                };

                // If the receiver declined the batch, stop sending the rest
                if batch.is_some() {
                    if let Some(item) = engine.get_transfer(&transfer_id).await {
                        if item.status == TransferStatus::Cancelled
                            && item.error.as_deref() == Some("Declined by receiver")
                        {
                            info!("Batch declined by receiver, stopping");
                            break;
                        }
                    }
                }
            }
        });
    }

    /// Send multiple loose files as one batch — the receiver is prompted
    /// once. Returns the number of files queued.
    pub async fn send_files(
        self: &Arc<Self>,
        paths: Vec<String>,
        device_ip: &str,
        device_port: u16,
        device_id: &str,
        device_name: &str,
        sender_id: &str,
        sender_name: &str,
    ) -> Result<u32, String> {
        if paths.is_empty() {
            return Err("No files to send".to_string());
        }
        if paths.len() > MAX_BATCH_FILES {
            return Err(format!("Too many files (> {})", MAX_BATCH_FILES));
        }

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;
        for p in &paths {
            let path = PathBuf::from(p);
            let meta = fs::metadata(&path)
                .await
                .map_err(|e| format!("Cannot read {}: {}", p, e))?;
            if !meta.is_file() {
                return Err(format!("Not a file: {}", p));
            }
            total_bytes += meta.len();
            files.push((path, None));
        }

        let total_files = files.len() as u32;
        let batch = (total_files > 1).then(|| BatchMeta {
            id: uuid::Uuid::new_v4().to_string(),
            name: None,
            total_files,
            total_bytes,
        });

        self.spawn_batch(
            files,
            batch,
            format!("{}:{}", device_ip, device_port),
            device_id.to_string(),
            device_name.to_string(),
            sender_id.to_string(),
            sender_name.to_string(),
        );

        Ok(total_files)
    }

    /// Walk a folder and send every file inside it as one batch. Files are
    /// sent sequentially; the receiver is prompted once for the whole batch.
    /// Returns the number of files queued.
    pub async fn send_folder(
        self: &Arc<Self>,
        folder_path: &str,
        device_ip: &str,
        device_port: u16,
        device_id: &str,
        device_name: &str,
        sender_id: &str,
        sender_name: &str,
    ) -> Result<u32, String> {
        let root = PathBuf::from(folder_path);
        if !root.is_dir() {
            return Err("Not a folder".to_string());
        }
        let folder_name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "Invalid folder path".to_string())?;

        let files = collect_files(&root).await?;
        if files.is_empty() {
            return Err("Folder contains no files".to_string());
        }
        if files.len() > MAX_BATCH_FILES {
            return Err(format!(
                "Folder has too many files ({} > {})",
                files.len(),
                MAX_BATCH_FILES
            ));
        }

        let total_files = files.len() as u32;
        let total_bytes: u64 = files.iter().map(|(_, _, size)| size).sum();
        let batch = BatchMeta {
            id: uuid::Uuid::new_v4().to_string(),
            name: Some(folder_name.clone()),
            total_files,
            total_bytes,
        };

        info!(
            "Sending folder '{}': {} files, {} bytes",
            folder_name, total_files, total_bytes
        );

        let files = files
            .into_iter()
            .map(|(path, rel, _)| (path, Some(format!("{}/{}", folder_name, rel))))
            .collect();

        self.spawn_batch(
            files,
            Some(batch),
            format!("{}:{}", device_ip, device_port),
            device_id.to_string(),
            device_name.to_string(),
            sender_id.to_string(),
            sender_name.to_string(),
        );

        Ok(total_files)
    }

    pub fn pause_transfer(&self, id: &str) {
        let _ = self.command_tx.send(TransferCommand::Pause(id.to_string()));
    }

    pub fn resume_transfer(&self, id: &str) {
        let _ = self.command_tx.send(TransferCommand::Resume(id.to_string()));
    }

    pub fn cancel_transfer(&self, id: &str) {
        let _ = self.command_tx.send(TransferCommand::Cancel(id.to_string()));
    }

    pub async fn get_active_transfers(&self) -> Vec<TransferItem> {
        self.active_transfers
            .read()
            .await
            .values()
            .cloned()
            .collect()
    }

    pub async fn get_transfer(&self, id: &str) -> Option<TransferItem> {
        self.active_transfers.read().await.get(id).cloned()
    }
}

/// Recursively list all regular files under `root` as
/// (absolute path, path relative to root with forward slashes, size).
async fn collect_files(root: &Path) -> Result<Vec<(PathBuf, String, u64)>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| format!("Failed to read folder {:?}: {}", dir, e))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read folder entry: {}", e))?
        {
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| format!("Failed to read entry type: {}", e))?;
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| format!("Path error: {}", e))?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((path, rel, size));
            }
            // Symlinks are skipped to avoid cycles
            if out.len() > MAX_BATCH_FILES {
                return Err(format!("Folder has too many files (> {})", MAX_BATCH_FILES));
            }
        }
    }

    out.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(out)
}

/// Update a transfer's status in the active map; terminal states also stamp
/// completed_at and zero the speed.
async fn set_status(
    active: &Arc<RwLock<HashMap<String, TransferItem>>>,
    id: &str,
    status: TransferStatus,
    error: Option<String>,
) {
    let mut transfers = active.write().await;
    if let Some(t) = transfers.get_mut(id) {
        if matches!(
            status,
            TransferStatus::Completed | TransferStatus::Failed | TransferStatus::Cancelled
        ) {
            t.completed_at = Some(chrono::Utc::now().timestamp_millis());
            t.speed = 0.0;
        }
        if status == TransferStatus::Completed {
            t.progress = 100.0;
        }
        t.status = status;
        t.error = error;
    }
}

#[allow(clippy::too_many_arguments)]
async fn send_file_impl(
    path: &Path,
    target: &str,
    header: TransferHeader,
    chunk_size: usize,
    active: Arc<RwLock<HashMap<String, TransferItem>>>,
    progress_tx: broadcast::Sender<TransferProgress>,
    code_tx: broadcast::Sender<TransferCode>,
    command_rx: &mut broadcast::Receiver<TransferCommand>,
    transfer_id: &str,
) -> Result<(), String> {
    info!("Connecting to target {}", target);
    let stream = TcpStream::connect(target)
        .await
        .map_err(|e| {
            error!("Failed to connect to {}: {}", target, e);
            format!("Connection failed: {}", e)
        })?;
    info!("Connected to {}, negotiating encryption", target);

    let mut secure = SecureStream::connect(stream).await?;

    // Surface the session verification code so the user can compare screens
    let code = secure.verification_code().to_string();
    {
        let mut transfers = active.write().await;
        if let Some(t) = transfers.get_mut(transfer_id) {
            t.verification_code = Some(code.clone());
        }
    }
    let _ = code_tx.send(TransferCode {
        id: transfer_id.to_string(),
        code,
    });

    // Send header and wait for the receiver to accept (they may be prompted)
    let header_bytes = serde_json::to_vec(&header).map_err(|e| format!("Serialize error: {}", e))?;
    secure.send_frame(&header_bytes).await?;

    let response = timeout(SENDER_RESPONSE_TIMEOUT, secure.recv_frame())
        .await
        .map_err(|_| "Timed out waiting for the receiver to accept".to_string())??;

    if response.first() != Some(&RESP_ACCEPT) {
        info!("Transfer {} declined by receiver", transfer_id);
        set_status(
            &active,
            transfer_id,
            TransferStatus::Cancelled,
            Some("Declined by receiver".to_string()),
        )
        .await;
        let _ = progress_tx.send(TransferProgress {
            id: transfer_id.to_string(),
            progress: 0.0,
            speed: 0.0,
            status: TransferStatus::Cancelled,
            error: Some("Declined by receiver".to_string()),
        });
        return Ok(());
    }

    info!("Receiver accepted, starting file transmission");

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Open error: {}", e))?;

    let mut buf = vec![0u8; chunk_size];
    let mut sent: u64 = 0;
    let total = header.file_size;
    let start = std::time::Instant::now();
    let mut paused = false;

    set_status(&active, transfer_id, TransferStatus::Transferring, None).await;

    loop {
        // Check commands
        while let Ok(cmd) = command_rx.try_recv() {
            match cmd {
                TransferCommand::Pause(id) if id == transfer_id => {
                    paused = true;
                    set_status(&active, transfer_id, TransferStatus::Paused, None).await;
                    let _ = progress_tx.send(TransferProgress {
                        id: transfer_id.to_string(),
                        progress: (sent as f64 / total as f64) * 100.0,
                        speed: 0.0,
                        status: TransferStatus::Paused,
                        error: None,
                    });
                }
                TransferCommand::Resume(id) if id == transfer_id => {
                    paused = false;
                    set_status(&active, transfer_id, TransferStatus::Transferring, None).await;
                }
                TransferCommand::Cancel(id) if id == transfer_id => {
                    info!("Transfer {} cancelled", transfer_id);
                    set_status(&active, transfer_id, TransferStatus::Cancelled, None).await;
                    let _ = progress_tx.send(TransferProgress {
                        id: transfer_id.to_string(),
                        progress: (sent as f64 / total as f64) * 100.0,
                        speed: 0.0,
                        status: TransferStatus::Cancelled,
                        error: None,
                    });
                    return Ok(());
                }
                _ => {}
            }
        }

        if paused {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }

        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read error: {}", e))?;

        if n == 0 {
            break;
        }

        secure.send_frame(&buf[..n]).await?;

        sent += n as u64;
        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 { sent as f64 / elapsed } else { 0.0 };
        let progress = (sent as f64 / total as f64) * 100.0;

        {
            let mut transfers = active.write().await;
            if let Some(t) = transfers.get_mut(transfer_id) {
                t.progress = progress;
                t.speed = speed;
            }
        }

        let _ = progress_tx.send(TransferProgress {
            id: transfer_id.to_string(),
            progress,
            speed,
            status: TransferStatus::Transferring,
            error: None,
        });
    }

    info!("File data sent for {}, waiting for receiver verification", transfer_id);

    // The receiver verifies the hash before acknowledging — only then is
    // this transfer really complete.
    let ack = timeout(VERIFY_ACK_TIMEOUT, secure.recv_frame())
        .await
        .map_err(|_| "Timed out waiting for receiver verification".to_string())??;

    if ack.first() != Some(&RESP_ACCEPT) {
        return Err("Receiver reported hash verification failure".to_string());
    }

    set_status(&active, transfer_id, TransferStatus::Completed, None).await;
    let _ = progress_tx.send(TransferProgress {
        id: transfer_id.to_string(),
        progress: 100.0,
        speed: 0.0,
        status: TransferStatus::Completed,
        error: None,
    });

    info!("Transfer {} completed and verified by receiver", transfer_id);
    Ok(())
}

async fn handle_incoming(stream: TcpStream, ctx: ReceiverCtx) -> Result<(), String> {
    info!("Handling incoming connection, negotiating encryption");
    let mut secure = SecureStream::accept(stream).await?;
    let verification_code = secure.verification_code().to_string();

    let header_buf = secure.recv_frame().await?;
    if header_buf.len() > MAX_HEADER_LEN {
        return Err(format!("Header too large: {} bytes", header_buf.len()));
    }
    let header: TransferHeader =
        serde_json::from_slice(&header_buf).map_err(|e| format!("Deserialize error: {}", e))?;

    info!(
        "Incoming file offer: {} ({} bytes) from {}",
        header.file_name, header.file_size, header.sender_name
    );

    // Resolve destination: sanitize sender-supplied names (they could
    // contain path traversal) and avoid clobbering existing files.
    let dl_path = ctx.download_path.read().await.clone();
    let (dest_dir, base_name) = match header.relative_path.as_deref() {
        Some(rel) => {
            let parts: Vec<String> = rel
                .split(['/', '\\'])
                .filter_map(sanitize_component)
                .collect();
            match parts.split_last() {
                Some((file, dirs)) => {
                    let mut dir = dl_path.clone();
                    for d in dirs {
                        dir.push(d);
                    }
                    (dir, file.clone())
                }
                None => (dl_path.clone(), sanitize_file_name(&header.file_name)),
            }
        }
        None => (dl_path.clone(), sanitize_file_name(&header.file_name)),
    };
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| format!("Create download dir error: {}", e))?;
    let file_path = unique_file_path(&dest_dir, &base_name);
    let display_name = file_path
        .strip_prefix(&dl_path)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| base_name.clone());

    // Sender-supplied preview — drop anything oversized or malformed
    let thumbnail = header
        .thumbnail
        .clone()
        .filter(|t| t.len() <= MAX_EMBED_THUMB * 2 && t.starts_with("data:image/"));

    let transfer = TransferItem {
        id: header.id.clone(),
        file_name: display_name.clone(),
        file_size: header.file_size,
        file_type: header.file_type.clone(),
        progress: 0.0,
        speed: 0.0,
        status: TransferStatus::Pending,
        direction: TransferDirection::Download,
        device_id: header.sender_id.clone(),
        device_name: header.sender_name.clone(),
        started_at: chrono::Utc::now().timestamp_millis(),
        completed_at: None,
        error: None,
        verification_code: Some(verification_code.clone()),
        thumbnail: thumbnail.clone(),
        batch_id: header.batch_id.clone(),
        batch_name: header.batch_name.clone(),
        batch_total_files: header.batch_total_files,
        batch_total_bytes: header.batch_total_bytes,
    };

    {
        ctx.active
            .write()
            .await
            .insert(header.id.clone(), transfer);
    }

    // Consent gate: batch decisions are remembered so a folder transfer
    // prompts once; otherwise prompt unless auto-accept is enabled.
    let now = chrono::Utc::now().timestamp_millis();
    let mut batch_consent: Option<bool> = None;
    if let Some(batch_id) = &header.batch_id {
        let mut batches = ctx.batches.write().await;
        batches.retain(|_, d| now - d.decided_at < BATCH_DECISION_TTL_MS);
        if let Some(decision) = batches.get_mut(batch_id) {
            batch_consent = Some(decision.accepted);
            if decision.remaining > 1 {
                decision.remaining -= 1;
            } else {
                batches.remove(batch_id);
            }
        }
    }

    let auto = *ctx.auto_accept.read().await;
    let accepted = if let Some(consent) = batch_consent {
        consent
    } else if auto {
        true
    } else {
        let (tx, rx) = oneshot::channel();
        ctx.pending.write().await.insert(header.id.clone(), tx);
        let _ = ctx.request_tx.send(TransferRequest {
            id: header.id.clone(),
            file_name: display_name.clone(),
            file_size: header.file_size,
            file_type: header.file_type.clone(),
            sender_id: header.sender_id.clone(),
            sender_name: header.sender_name.clone(),
            verification_code: verification_code.clone(),
            require_code_confirm: *ctx.require_pin.read().await,
            batch_name: header.batch_name.clone(),
            batch_total_files: header.batch_total_files,
            batch_total_bytes: header.batch_total_bytes,
            thumbnail: thumbnail.clone(),
        });
        let decision = match timeout(ACCEPT_DECISION_TIMEOUT, rx).await {
            Ok(Ok(choice)) => choice,
            _ => false, // timed out or channel dropped — treat as declined
        };
        ctx.pending.write().await.remove(&header.id);

        // Remember the decision for the rest of the batch
        if let (Some(batch_id), Some(total)) = (&header.batch_id, header.batch_total_files) {
            if total > 1 {
                ctx.batches.write().await.insert(
                    batch_id.clone(),
                    BatchDecision {
                        accepted: decision,
                        remaining: total - 1,
                        decided_at: now,
                    },
                );
            }
        }
        decision
    };

    if !accepted {
        info!("Incoming transfer {} declined", header.id);
        let _ = secure.send_frame(&[RESP_DECLINE]).await;
        set_status(
            &ctx.active,
            &header.id,
            TransferStatus::Cancelled,
            Some("Declined".to_string()),
        )
        .await;
        let _ = ctx.progress_tx.send(TransferProgress {
            id: header.id.clone(),
            progress: 0.0,
            speed: 0.0,
            status: TransferStatus::Cancelled,
            error: Some("Declined".to_string()),
        });
        return Ok(());
    }

    secure.send_frame(&[RESP_ACCEPT]).await?;
    set_status(&ctx.active, &header.id, TransferStatus::Transferring, None).await;

    // Receive into a .part file; clean up on any failure
    let part_path = file_path.with_file_name(format!("{}.part", base_name));
    info!("Receiving to {:?}", part_path);

    let mut command_rx = ctx.command_tx.subscribe();
    let outcome = match receive_file_data(&mut secure, &header, &part_path, &ctx, &mut command_rx).await
    {
        Ok(o) => o,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            set_status(&ctx.active, &header.id, TransferStatus::Failed, Some(e.clone())).await;
            let _ = ctx.progress_tx.send(TransferProgress {
                id: header.id.clone(),
                progress: 0.0,
                speed: 0.0,
                status: TransferStatus::Failed,
                error: Some(e.clone()),
            });
            return Err(e);
        }
    };

    match outcome {
        ReceiveOutcome::Cancelled => {
            info!("Incoming transfer {} cancelled by receiver", header.id);
            let _ = tokio::fs::remove_file(&part_path).await;
            set_status(&ctx.active, &header.id, TransferStatus::Cancelled, None).await;
            let _ = ctx.progress_tx.send(TransferProgress {
                id: header.id.clone(),
                progress: 0.0,
                speed: 0.0,
                status: TransferStatus::Cancelled,
                error: None,
            });
        }
        ReceiveOutcome::Verified => {
            tokio::fs::rename(&part_path, &file_path)
                .await
                .map_err(|e| format!("Rename error: {}", e))?;
            let _ = secure.send_frame(&[RESP_ACCEPT]).await;
            set_status(&ctx.active, &header.id, TransferStatus::Completed, None).await;
            let _ = ctx.progress_tx.send(TransferProgress {
                id: header.id.clone(),
                progress: 100.0,
                speed: 0.0,
                status: TransferStatus::Completed,
                error: None,
            });
            info!("Received and verified: {}", display_name);
        }
        ReceiveOutcome::HashMismatch => {
            warn!("Hash mismatch for {}", display_name);
            let _ = tokio::fs::remove_file(&part_path).await;
            let _ = secure.send_frame(&[RESP_DECLINE]).await;
            set_status(
                &ctx.active,
                &header.id,
                TransferStatus::Failed,
                Some("Hash verification failed".to_string()),
            )
            .await;
            let _ = ctx.progress_tx.send(TransferProgress {
                id: header.id.clone(),
                progress: 100.0,
                speed: 0.0,
                status: TransferStatus::Failed,
                error: Some("Hash verification failed".to_string()),
            });
        }
    }

    Ok(())
}

enum ReceiveOutcome {
    Verified,
    HashMismatch,
    Cancelled,
}

/// Receive the file body into `part_path`, hashing incrementally and
/// honoring pause/resume/cancel commands from the local user.
async fn receive_file_data(
    secure: &mut SecureStream,
    header: &TransferHeader,
    part_path: &Path,
    ctx: &ReceiverCtx,
    command_rx: &mut broadcast::Receiver<TransferCommand>,
) -> Result<ReceiveOutcome, String> {
    let mut file = tokio::fs::File::create(part_path)
        .await
        .map_err(|e| format!("Create file error: {}", e))?;

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let start = std::time::Instant::now();
    let mut paused = false;

    while received < header.file_size {
        // Check local pause/resume/cancel. While paused we simply stop
        // reading — TCP backpressure stalls the sender.
        while let Ok(cmd) = command_rx.try_recv() {
            match cmd {
                TransferCommand::Pause(id) if id == header.id => {
                    paused = true;
                    set_status(&ctx.active, &header.id, TransferStatus::Paused, None).await;
                    let _ = ctx.progress_tx.send(TransferProgress {
                        id: header.id.clone(),
                        progress: (received as f64 / header.file_size as f64) * 100.0,
                        speed: 0.0,
                        status: TransferStatus::Paused,
                        error: None,
                    });
                }
                TransferCommand::Resume(id) if id == header.id => {
                    paused = false;
                    set_status(&ctx.active, &header.id, TransferStatus::Transferring, None).await;
                }
                TransferCommand::Cancel(id) if id == header.id => {
                    return Ok(ReceiveOutcome::Cancelled);
                }
                _ => {}
            }
        }

        if paused {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }

        let chunk = secure.recv_frame().await?;
        if chunk.is_empty() {
            return Err("Connection closed before transfer finished".to_string());
        }
        received += chunk.len() as u64;
        if received > header.file_size {
            return Err("Sender sent more data than declared".to_string());
        }

        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {}", e))?;

        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 { received as f64 / elapsed } else { 0.0 };
        let progress = (received as f64 / header.file_size as f64) * 100.0;

        {
            let mut transfers = ctx.active.write().await;
            if let Some(t) = transfers.get_mut(&header.id) {
                t.progress = progress;
                t.speed = speed;
            }
        }

        let _ = ctx.progress_tx.send(TransferProgress {
            id: header.id.clone(),
            progress,
            speed,
            status: TransferStatus::Transferring,
            error: None,
        });
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    let received_hash = hex::encode(hasher.finalize());
    if received_hash == header.hash {
        Ok(ReceiveOutcome::Verified)
    } else {
        Ok(ReceiveOutcome::HashMismatch)
    }
}

async fn compute_file_hash(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Hash open error: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Hash read error: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Clean a single path component of unsafe characters; None if nothing
/// safe remains (empty, "." or "..").
fn sanitize_component(part: &str) -> Option<String> {
    let cleaned: String = part
        .chars()
        .filter(|c| {
            !matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') && !c.is_control()
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        None
    } else {
        Some(trimmed)
    }
}

/// Strip directory components and unsafe characters from a sender-supplied
/// file name so it cannot escape the download directory.
fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|n| sanitize_component(&n.to_string_lossy()))
        .unwrap_or_else(|| format!("received-{}", chrono::Utc::now().timestamp_millis()))
}

/// Pick a path in `dir` that doesn't overwrite an existing file, appending
/// " (1)", " (2)", ... before the extension as needed.
fn unique_file_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{}", ext)),
        _ => (file_name.to_string(), String::new()),
    };
    for i in 1u32.. {
        let path = dir.join(format!("{} ({}){}", stem, i, ext));
        if !path.exists() {
            return path;
        }
    }
    unreachable!()
}

fn mime_guess_from_ext(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()) {
        Some("txt") => "text/plain",
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("mp4") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        Some("zip") => "application/zip",
        Some("tar") => "application/x-tar",
        Some("gz") => "application/gzip",
        Some("doc") | Some("docx") => "application/msword",
        Some("xls") | Some("xlsx") => "application/vnd.ms-excel",
        Some("ppt") | Some("pptx") => "application/vnd.ms-powerpoint",
        _ => "application/octet-stream",
    }
    .to_string()
}
