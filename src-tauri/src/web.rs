use crate::chat::ChatService;
use axum::{
    body::Body,
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use rand::Rng;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};

const WEB_CLIENT_HTML: &str = include_str!("../assets/web/index.html");
const MAX_AUTH_FAILURES: u32 = 15;
const MAX_UPLOAD_BYTES: usize = 4 * 1024 * 1024 * 1024; // 4 GB

// ─── Session broker (shared with ChatService) ───────────────────

struct WebSession {
    name: String,
    token: String,
    /// Present while a WebSocket is attached.
    tx: Option<mpsc::Sender<String>>,
}

/// Tracks browser sessions; ChatService routes messages for "web-" peers
/// through here instead of TCP channels.
#[derive(Default)]
pub struct WebBroker {
    sessions: RwLock<HashMap<String, WebSession>>,
}

impl WebBroker {
    pub async fn create_session(&self, name: &str) -> (String, String) {
        let session_id = format!("web-{}", uuid::Uuid::new_v4());
        let token: String = {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill(&mut bytes);
            hex::encode(bytes)
        };
        self.sessions.write().await.insert(
            session_id.clone(),
            WebSession {
                name: name.to_string(),
                token: token.clone(),
                tx: None,
            },
        );
        (session_id, token)
    }

    pub async fn find_by_token(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        self.sessions
            .read()
            .await
            .iter()
            .find(|(_, s)| s.token == token)
            .map(|(id, _)| id.clone())
    }

    async fn attach_ws(&self, session_id: &str) -> Option<mpsc::Receiver<String>> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(session_id)?;
        let (tx, rx) = mpsc::channel(64);
        session.tx = Some(tx);
        Some(rx)
    }

    async fn detach_ws(&self, session_id: &str) {
        if let Some(session) = self.sessions.write().await.get_mut(session_id) {
            session.tx = None;
        }
    }

    /// Push a JSON frame to a session's browser. False if not connected.
    pub async fn push(&self, session_id: &str, json: String) -> bool {
        let sessions = self.sessions.read().await;
        let Some(tx) = sessions.get(session_id).and_then(|s| s.tx.clone()) else {
            return false;
        };
        drop(sessions);
        tx.send(json).await.is_ok()
    }

    pub async fn online_ids(&self) -> Vec<String> {
        self.sessions
            .read()
            .await
            .iter()
            .filter(|(_, s)| s.tx.is_some())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub async fn session_name(&self, session_id: &str) -> Option<String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|s| s.name.clone())
    }

    pub async fn list(&self) -> Vec<(String, bool)> {
        self.sessions
            .read()
            .await
            .values()
            .map(|s| (s.name.clone(), s.tx.is_some()))
            .collect()
    }

    pub async fn clear(&self) {
        self.sessions.write().await.clear();
    }
}

// ─── Server ─────────────────────────────────────────────────────

struct WebState {
    chat: Arc<ChatService>,
    broker: Arc<WebBroker>,
    code: String,
    auth_failures: AtomicU32,
}

pub struct WebServerHandle {
    pub port: u16,
    pub code: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl WebServerHandle {
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

pub async fn start_server(
    chat: Arc<ChatService>,
    broker: Arc<WebBroker>,
    port: u16,
) -> Result<WebServerHandle, String> {
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));

    let state = Arc::new(WebState {
        chat,
        broker,
        code: code.clone(),
        auth_failures: AtomicU32::new(0),
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/api/auth", post(auth))
        .route("/api/ws", get(ws_upgrade))
        .route("/api/messages", get(list_messages).post(post_message))
        .route("/api/attachments", post(upload_attachment))
        .route("/api/attachments/:message_id", get(download_attachment))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("Could not bind port {}: {}", port, e))?;
    // Report the real port (matters when asked for port 0 in tests)
    let port = listener
        .local_addr()
        .map_err(|e| format!("Listener error: {}", e))?
        .port();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(e) = result {
            warn!("Web server error: {}", e);
        }
        info!("Web server stopped");
    });

    info!("Web access server started on port {}", port);
    Ok(WebServerHandle {
        port,
        code,
        shutdown: Some(shutdown_tx),
    })
}

// ─── Handlers ───────────────────────────────────────────────────

async fn index() -> Html<&'static str> {
    Html(WEB_CLIENT_HTML)
}

#[derive(Deserialize)]
struct AuthRequest {
    code: String,
    name: String,
}

async fn auth(
    State(state): State<Arc<WebState>>,
    Json(req): Json<AuthRequest>,
) -> Response {
    if state.auth_failures.load(Ordering::SeqCst) >= MAX_AUTH_FAILURES {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many failed attempts — restart web access in Bliink"})),
        )
            .into_response();
    }
    if req.code.trim() != state.code {
        state.auth_failures.fetch_add(1, Ordering::SeqCst);
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong code"})),
        )
            .into_response();
    }

    let name: String = req.name.trim().chars().take(40).collect();
    let name = if name.is_empty() { "Web user".to_string() } else { name };

    let (session_id, token) = state.broker.create_session(&name).await;
    state.chat.web_session_started(&session_id, &name).await;
    info!("Web client connected: {} ({})", name, session_id);

    Json(serde_json::json!({
        "token": token,
        "sessionId": session_id,
        "hostName": state.chat.host_name(),
    }))
    .into_response()
}

/// Resolve the session from a `token` query param or x-auth-token header.
async fn authed(
    state: &WebState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> Result<String, Response> {
    let token = query
        .get("token")
        .cloned()
        .or_else(|| {
            headers
                .get("x-auth-token")
                .and_then(|v| v.to_str().ok())
                .map(String::from)
        })
        .unwrap_or_default();
    state
        .broker
        .find_by_token(&token)
        .await
        .ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<WebState>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let session_id = match authed(&state, &headers, &query).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let Some(rx) = state.broker.attach_ws(&session_id).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    state.chat.web_presence_changed().await;
    ws.on_upgrade(move |socket| handle_socket(socket, session_id, rx, state))
}

async fn handle_socket(
    socket: WebSocket,
    session_id: String,
    mut rx: mpsc::Receiver<String>,
    state: Arc<WebState>,
) {
    let (mut sender, mut receiver) = socket.split();

    // Server → browser pushes
    let push_task = tokio::spawn(async move {
        while let Some(json) = rx.recv().await {
            if sender.send(WsMessage::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // Browser → server: typing + read receipts
    while let Some(Ok(msg)) = receiver.next().await {
        let WsMessage::Text(text) = msg else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("typing") => {
                let typing = value.get("typing").and_then(|t| t.as_bool()).unwrap_or(false);
                state.chat.web_typing(&session_id, typing).await;
            }
            Some("read") => {
                let ids: Vec<String> = value
                    .get("ids")
                    .and_then(|i| i.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                if !ids.is_empty() {
                    state.chat.web_read_receipts(&session_id, ids).await;
                }
            }
            _ => {}
        }
    }

    push_task.abort();
    state.broker.detach_ws(&session_id).await;
    state.chat.web_presence_changed().await;
    info!("Web client disconnected: {}", session_id);
}

async fn list_messages(
    State(state): State<Arc<WebState>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let session_id = match authed(&state, &headers, &query).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match state.chat.get_messages(&session_id, 200).await {
        Ok(messages) => Json(messages).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct PostMessageRequest {
    text: String,
    #[serde(default)]
    reply_to: Option<String>,
}

async fn post_message(
    State(state): State<Arc<WebState>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(req): Json<PostMessageRequest>,
) -> Response {
    let session_id = match authed(&state, &headers, &query).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match state
        .chat
        .web_message_in(&session_id, req.text, req.reply_to)
        .await
    {
        Ok(message) => Json(message).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn upload_attachment(
    State(state): State<Arc<WebState>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let session_id = match authed(&state, &headers, &query).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    while let Ok(Some(mut field)) = multipart.next_field().await {
        if field.name() != Some("file") {
            continue;
        }
        let raw_name = field.file_name().unwrap_or("file").to_string();
        let safe_name = crate::transfer::sanitize_file_name(&raw_name);
        let media_dir = state.chat.media_dir().clone();
        if tokio::fs::create_dir_all(&media_dir).await.is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Storage error").into_response();
        }
        let dest = crate::transfer::unique_file_path(&media_dir, &safe_name);

        // Stream the upload to disk
        let mut file = match tokio::fs::File::create(&dest).await {
            Ok(f) => f,
            Err(e) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, format!("Storage error: {}", e))
                    .into_response()
            }
        };
        let mut size: u64 = 0;
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    size += chunk.len() as u64;
                    if tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                        .await
                        .is_err()
                    {
                        let _ = tokio::fs::remove_file(&dest).await;
                        return (StatusCode::INTERNAL_SERVER_ERROR, "Write error").into_response();
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&dest).await;
                    return (StatusCode::BAD_REQUEST, format!("Upload error: {}", e))
                        .into_response();
                }
            }
        }
        drop(file);

        match state
            .chat
            .web_attachment_in(&session_id, &dest, size)
            .await
        {
            Ok(message) => return Json(message).into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        }
    }

    (StatusCode::BAD_REQUEST, "No file in upload").into_response()
}

async fn download_attachment(
    State(state): State<Arc<WebState>>,
    Path(message_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let session_id = match authed(&state, &headers, &query).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    let Some((path, name, kind)) = state
        .chat
        .web_attachment_file(&session_id, &message_id)
        .await
    else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let Ok(file) = tokio::fs::File::open(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let content_type = guess_content_type(&name);
    // Images and audio render inline in the chat; everything else downloads
    let disposition = if kind == "image" || kind == "voice" {
        format!("inline; filename=\"{}\"", name.replace('"', ""))
    } else {
        format!("attachment; filename=\"{}\"", name.replace('"', ""))
    };

    (
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn http_request(port: u16, raw: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect to test server");
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn json_field(body: &str, field: &str) -> Option<String> {
        let key = format!("\"{}\":\"", field);
        let start = body.find(&key)? + key.len();
        let end = body[start..].find('"')? + start;
        Some(body[start..end].to_string())
    }

    async fn test_service() -> (Arc<ChatService>, Arc<WebBroker>) {
        let dir = std::env::temp_dir().join(format!("bliink-web-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(crate::chat::ChatStore::new(&dir.join("test.db")).unwrap());
        let discovery = Arc::new(tokio::sync::Mutex::new(
            crate::discovery::DiscoveryService::new("Test Host", 0, 0, "test-device").unwrap(),
        ));
        let transfer = Arc::new(crate::transfer::TransferEngine::new());
        let broker = Arc::new(WebBroker::default());
        let chat = Arc::new(ChatService::new(
            "test-device".to_string(),
            "Test Host".to_string(),
            0,
            store,
            discovery,
            transfer,
            dir,
            broker.clone(),
        ));
        (chat, broker)
    }

    #[tokio::test]
    async fn serves_page_and_handles_auth_and_messages() {
        let (chat, broker) = test_service().await;
        let handle = start_server(chat.clone(), broker, 0).await.unwrap();
        let port = handle.port;
        assert_ne!(port, 0, "server should report its real port");

        // The client page is served at /
        let resp = http_request(port, "GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n").await;
        assert!(resp.starts_with("HTTP/1.1 200"), "GET / failed: {}", &resp[..resp.len().min(80)]);
        assert!(resp.contains("Bliink"));

        // Wrong code is rejected
        let wrong_code = if handle.code == "000000" { "000001" } else { "000000" };
        let body = format!(r#"{{"code":"{}","name":"Tester"}}"#, wrong_code);
        let req = format!(
            "POST /api/auth HTTP/1.1\r\nHost: t\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        );
        let resp = http_request(port, &req).await;
        assert!(resp.starts_with("HTTP/1.1 401"), "wrong code should 401: {}", &resp[..resp.len().min(80)]);

        // Right code authenticates and returns a token
        let body = format!(r#"{{"code":"{}","name":"Tester"}}"#, handle.code);
        let req = format!(
            "POST /api/auth HTTP/1.1\r\nHost: t\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        );
        let resp = http_request(port, &req).await;
        assert!(resp.starts_with("HTTP/1.1 200"), "auth failed: {}", &resp[..resp.len().min(120)]);
        let token = json_field(&resp, "token").expect("token in auth response");
        let session_id = json_field(&resp, "sessionId").expect("sessionId in auth response");

        // Sending a message stores it in the host's chat
        let body = r#"{"text":"hello from the browser"}"#;
        let req = format!(
            "POST /api/messages?token={} HTTP/1.1\r\nHost: t\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            token, body.len(), body
        );
        let resp = http_request(port, &req).await;
        assert!(resp.starts_with("HTTP/1.1 200"), "post message failed: {}", &resp[..resp.len().min(120)]);

        let messages = chat.get_messages(&session_id, 10).await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text.as_deref(), Some("hello from the browser"));
        assert_eq!(messages[0].direction, "in");

        // A bogus token is rejected
        let req = "GET /api/messages?token=bogus HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n";
        let resp = http_request(port, req).await;
        assert!(resp.starts_with("HTTP/1.1 401"), "bogus token should 401");
    }
}

fn guess_content_type(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "webm" => "audio/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
