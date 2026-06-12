use crate::types::{Device, DeviceStatus, DeviceType};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::net::UdpSocket;
use tokio::sync::broadcast;
use tokio::time::{self, Duration};

const DISCOVERY_PORT: u16 = 9001;
const BROADCAST_INTERVAL: Duration = Duration::from_secs(2);
const OFFLINE_THRESHOLD: i64 = 15000; // 15 seconds

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DiscoveryMessage {
    id: String,
    name: String,
    port: u16,
    #[serde(default)]
    chat_port: u16,
    device_type: String,
    os: String,
    /// Absent (0) on builds older than protocol versioning.
    #[serde(default)]
    protocol: u32,
}

pub struct DiscoveryService {
    devices: Arc<Mutex<HashMap<String, Device>>>,
    device_id: String,
    device_name: String,
    service_port: u16,
    chat_port: u16,
    shutdown_tx: Option<broadcast::Sender<()>>,
    is_running: bool,
}

impl DiscoveryService {
    pub fn new(
        device_name: &str,
        service_port: u16,
        chat_port: u16,
        device_id: &str,
    ) -> Result<Self, String> {
        Ok(Self {
            devices: Arc::new(Mutex::new(HashMap::new())),
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            service_port,
            chat_port,
            shutdown_tx: None,
            is_running: false,
        })
    }

    /// Snapshot of a single discovered device.
    pub fn get_device(&self, id: &str) -> Option<Device> {
        self.devices.lock().unwrap().get(id).cloned()
    }

    /// Insert or update a manually-added device (survives pruning).
    pub fn upsert_manual(&self, device: Device) {
        self.devices.lock().unwrap().insert(device.id.clone(), device);
    }

    pub fn remove_device(&self, id: &str) {
        self.devices.lock().unwrap().remove(id);
    }

    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        self.is_running
    }

    pub fn start_browsing(&mut self) -> Result<broadcast::Receiver<Vec<Device>>, String> {
        // Stop any previous session before starting a new one
        if self.is_running {
            self.stop();
        }

        let (tx, rx) = broadcast::channel::<Vec<Device>>(32);
        let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(1);
        self.shutdown_tx = Some(shutdown_tx.clone());
        self.is_running = true;

        let devices = self.devices.clone();
        let my_id = self.device_id.clone();
        let my_name = self.device_name.clone();
        let my_port = self.service_port;
        let my_chat_port = self.chat_port;

        let os_name = std::env::consts::OS.to_string();
        let device_type_str = if cfg!(target_os = "android") || cfg!(target_os = "ios") {
            "phone"
        } else {
            "desktop"
        }
        .to_string();

        tokio::spawn(async move {
            // Create UDP socket with broadcast capability
            let socket = match Self::create_udp_socket().await {
                Ok(s) => Arc::new(s),
                Err(e) => {
                    error!("Failed to create discovery socket: {}", e);
                    return;
                }
            };

            let msg = DiscoveryMessage {
                id: my_id.clone(),
                name: my_name,
                port: my_port,
                chat_port: my_chat_port,
                device_type: device_type_str,
                os: os_name,
                protocol: crate::types::PROTOCOL_VERSION,
            };

            let msg_bytes = match serde_json::to_vec(&msg) {
                Ok(b) => b,
                Err(e) => {
                    error!("Failed to serialize discovery message: {}", e);
                    return;
                }
            };

            info!("Discovery broadcasting started on port {}", DISCOVERY_PORT);

            // Broadcast task
            let broadcast_socket = socket.clone();
            let mut shutdown_rx_broadcast = shutdown_tx.subscribe();
            tokio::spawn(async move {
                let mut interval = time::interval(BROADCAST_INTERVAL);
                loop {
                    tokio::select! {
                        _ = shutdown_rx_broadcast.recv() => break,
                        _ = interval.tick() => {
                            let target = format!("255.255.255.255:{}", DISCOVERY_PORT);
                            if let Err(e) = broadcast_socket.send_to(&msg_bytes, &target).await {
                                warn!("Broadcast send error: {}", e);
                            }
                        }
                    }
                }
                info!("Broadcast task stopped");
            });

            // Listen task
            let mut buf = [0u8; 2048];
            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => {
                        info!("Discovery listener stopped");
                        break;
                    }
                    res = socket.recv_from(&mut buf) => {
                        match res {
                            Ok((len, addr)) => {
                                match serde_json::from_slice::<DiscoveryMessage>(&buf[..len]) {
                                    Ok(received_msg) => {
                                        if received_msg.id == my_id {
                                            continue;
                                        }

                                        let ip = addr.ip().to_string();
                                        info!("Discovered device: {} at {}:{}", received_msg.name, ip, received_msg.port);

                                        let device_type = match received_msg.device_type.as_str() {
                                            "desktop" => DeviceType::Desktop,
                                            "laptop" => DeviceType::Laptop,
                                            "phone" => DeviceType::Phone,
                                            "tablet" => DeviceType::Tablet,
                                            _ => DeviceType::Unknown,
                                        };

                                        let device = Device {
                                            id: received_msg.id.clone(),
                                            name: received_msg.name,
                                            ip,
                                            port: received_msg.port,
                                            chat_port: received_msg.chat_port,
                                            device_type,
                                            status: DeviceStatus::Online,
                                            os: Some(received_msg.os),
                                            last_seen: chrono::Utc::now().timestamp_millis(),
                                            manual: false,
                                            compatible: received_msg.protocol
                                                == crate::types::PROTOCOL_VERSION,
                                            node_id: None,
                                        };

                                        {
                                            let mut devs = devices.lock().unwrap();
                                            // Keep the manual flag if this peer was also
                                            // added by address
                                            let manual = devs
                                                .get(&received_msg.id)
                                                .map(|d| d.manual)
                                                .unwrap_or(false);
                                            let mut device = device;
                                            device.manual = manual;
                                            devs.insert(received_msg.id, device);

                                            // Prune stale devices (manual ones stay)
                                            let now = chrono::Utc::now().timestamp_millis();
                                            devs.retain(|_, d| {
                                                d.manual || now - d.last_seen < OFFLINE_THRESHOLD
                                            });
                                        }

                                        let devs_list: Vec<Device> =
                                            devices.lock().unwrap().values().cloned().collect();
                                        let _ = tx.send(devs_list);
                                    }
                                    Err(e) => {
                                        warn!("Failed to parse discovery message from {}: {}", addr, e);
                                    }
                                }
                            }
                            Err(e) => {
                                error!("UDP receive error: {}", e);
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        }
                    }
                }
            }
        });

        Ok(rx)
    }

    async fn create_udp_socket() -> Result<UdpSocket, String> {
        use socket2::{Domain, Protocol, Socket, Type};

        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
            .map_err(|e| format!("Failed to create socket: {}", e))?;

        socket
            .set_reuse_address(true)
            .map_err(|e| format!("Failed to set reuse address: {}", e))?;

        socket
            .set_broadcast(true)
            .map_err(|e| format!("Failed to set broadcast: {}", e))?;

        // Set receive buffer larger for reliability
        let _ = socket.set_recv_buffer_size(65536);

        let addr: std::net::SocketAddr = format!("0.0.0.0:{}", DISCOVERY_PORT).parse().unwrap();
        socket
            .bind(&addr.into())
            .map_err(|e| format!("Failed to bind UDP socket on port {}: {}", DISCOVERY_PORT, e))?;

        socket
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set nonblocking: {}", e))?;

        let std_socket: std::net::UdpSocket = socket.into();
        UdpSocket::from_std(std_socket)
            .map_err(|e| format!("Failed to convert to tokio socket: {}", e))
    }

    pub fn get_devices(&self) -> Vec<Device> {
        self.devices.lock().unwrap().values().cloned().collect()
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.is_running = false;
        info!("Discovery service stopped");
    }
}
