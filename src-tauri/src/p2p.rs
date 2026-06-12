use crate::chat::ChatService;
use crate::crypto::DynStream;
use crate::transfer::TransferEngine;
use iroh::discovery::dns::DnsDiscovery;
use iroh::discovery::pkarr::PkarrPublisher;
use iroh::discovery::ConcurrentDiscovery;
use iroh::key::SecretKey;
use iroh::{Endpoint, NodeId};
use log::{error, info, warn};
use std::sync::Arc;

/// ALPN identifying Bliink traffic on the iroh network.
const BLIINK_ALPN: &[u8] = b"bliink/1";

/// First byte on every stream says what protocol follows.
pub const STREAM_TRANSFER: u8 = 1;
pub const STREAM_CHAT: u8 = 2;

/// Internet P2P connectivity via iroh: QUIC with NAT hole punching and
/// public relay fallback. Devices are addressed by a stable NodeId (the
/// "Bliink ID") published through n0's discovery service — no servers for
/// the user to run.
///
/// Bliink's own X25519 + AES-256-GCM handshake still runs on top of every
/// stream, so verification codes and the wire protocol are identical to
/// the LAN path.
pub struct P2pService {
    endpoint: Endpoint,
}

impl P2pService {
    pub async fn new(secret_bytes: [u8; 32]) -> Result<Self, String> {
        let secret_key = SecretKey::from_bytes(&secret_bytes);

        let discovery = ConcurrentDiscovery::from_services(vec![
            // Resolve other devices' Bliink IDs
            Box::new(DnsDiscovery::n0_dns()),
            // Publish our own reachability
            Box::new(PkarrPublisher::n0_dns(secret_key.clone())),
        ]);

        let endpoint = Endpoint::builder()
            .secret_key(secret_key)
            .alpns(vec![BLIINK_ALPN.to_vec()])
            .discovery(Box::new(discovery))
            .bind()
            .await
            .map_err(|e| format!("Failed to start P2P endpoint: {}", e))?;

        info!("P2P endpoint up, Bliink ID: {}", endpoint.node_id());
        Ok(Self { endpoint })
    }

    /// This device's shareable internet identity.
    pub fn node_id(&self) -> String {
        self.endpoint.node_id().to_string()
    }

    /// Open a stream to a peer by Bliink ID. The kind byte tells the other
    /// side which protocol follows (transfer or chat).
    pub async fn open_stream(&self, node: &str, kind: u8) -> Result<DynStream, String> {
        let node_id: NodeId = node
            .trim()
            .parse()
            .map_err(|_| "Invalid Bliink ID".to_string())?;

        let conn = self
            .endpoint
            .connect(node_id, BLIINK_ALPN)
            .await
            .map_err(|e| format!("P2P connection failed: {}", e))?;

        let (mut send, recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("P2P stream failed: {}", e))?;
        send.write_all(&[kind])
            .await
            .map_err(|e| format!("P2P write failed: {}", e))?;

        Ok(Box::new(tokio::io::join(recv, send)))
    }

    /// Accept incoming P2P connections and dispatch their streams to the
    /// transfer engine or chat service based on the kind byte.
    pub fn start(self: &Arc<Self>, engine: Arc<TransferEngine>, chat: Arc<ChatService>) {
        let endpoint = self.endpoint.clone();
        tokio::spawn(async move {
            while let Some(incoming) = endpoint.accept().await {
                let engine = engine.clone();
                let chat = chat.clone();
                tokio::spawn(async move {
                    let conn = match incoming.await {
                        Ok(conn) => conn,
                        Err(e) => {
                            warn!("P2P handshake failed: {}", e);
                            return;
                        }
                    };
                    let peer = iroh::endpoint::get_remote_node_id(&conn)
                        .map(|n| n.to_string())
                        .unwrap_or_else(|_| "unknown".to_string());
                    info!("P2P connection from {}", peer);

                    // A connection multiplexes many streams (each transfer
                    // and the chat channel are separate streams)
                    loop {
                        let (send, mut recv) = match conn.accept_bi().await {
                            Ok(pair) => pair,
                            Err(_) => break, // connection closed
                        };
                        let engine = engine.clone();
                        let chat = chat.clone();
                        tokio::spawn(async move {
                            let mut kind = [0u8; 1];
                            if recv.read_exact(&mut kind).await.is_err() {
                                return;
                            }
                            let stream: DynStream = Box::new(tokio::io::join(recv, send));
                            match kind[0] {
                                STREAM_TRANSFER => engine.handle_incoming_stream(stream),
                                STREAM_CHAT => chat.handle_incoming_stream(stream),
                                other => {
                                    error!("Unknown P2P stream kind: {}", other);
                                }
                            }
                        });
                    }
                });
            }
            info!("P2P accept loop ended");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two endpoints in one process connect directly (no external
    /// discovery) and exchange a stream with a kind byte.
    #[tokio::test]
    async fn endpoints_connect_and_exchange_stream() {
        let server_key = SecretKey::generate();
        let server = Endpoint::builder()
            .secret_key(server_key)
            .alpns(vec![BLIINK_ALPN.to_vec()])
            .bind()
            .await
            .expect("bind server endpoint");
        let server_addr = server.node_addr().await.expect("server node addr");

        let accept_task = tokio::spawn(async move {
            let incoming = server.accept().await.expect("incoming connection");
            let conn = incoming.await.expect("accept connection");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept stream");
            let mut kind = [0u8; 1];
            recv.read_exact(&mut kind).await.expect("read kind");
            assert_eq!(kind[0], STREAM_CHAT);
            let mut buf = [0u8; 5];
            recv.read_exact(&mut buf).await.expect("read payload");
            assert_eq!(&buf, b"hello");
            send.write_all(b"world").await.expect("write reply");
            send.finish().expect("finish");
            // Give the reply time to flush before the connection drops
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        });

        let client = Endpoint::builder()
            .secret_key(SecretKey::generate())
            .bind()
            .await
            .expect("bind client endpoint");
        let conn = client
            .connect(server_addr, BLIINK_ALPN)
            .await
            .expect("connect");
        let (mut send, mut recv) = conn.open_bi().await.expect("open stream");
        send.write_all(&[STREAM_CHAT]).await.expect("write kind");
        send.write_all(b"hello").await.expect("write payload");

        let mut reply = [0u8; 5];
        recv.read_exact(&mut reply).await.expect("read reply");
        assert_eq!(&reply, b"world");

        accept_task.await.expect("server task");
    }
}
