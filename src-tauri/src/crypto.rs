use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use x25519_dalek::{EphemeralSecret, PublicKey};

/// Generous upper bound: the largest chunk setting (8 MB) + GCM tag overhead.
const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

/// Any bidirectional byte stream — TCP sockets and iroh QUIC streams alike.
pub trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}

/// A boxed transport so the transfer/chat protocols don't care whether the
/// bytes travel over the LAN (TCP) or the internet (iroh).
pub type DynStream = Box<dyn Duplex>;

/// An encrypted, length-framed wrapper around any byte stream.
///
/// Both sides exchange ephemeral X25519 public keys, derive a shared
/// AES-256-GCM session key (SHA-256 of the DH secret), and then exchange
/// frames of `[u32 BE ciphertext length][ciphertext + tag]`.
///
/// Nonces are never reused: each direction has its own prefix byte and a
/// monotonically increasing counter.
pub struct SecureStream {
    stream: DynStream,
    cipher: Aes256Gcm,
    send_prefix: u8,
    recv_prefix: u8,
    send_counter: u64,
    recv_counter: u64,
    verification_code: String,
}

impl SecureStream {
    /// Initiator (sender) side of the handshake.
    pub async fn connect(mut stream: DynStream) -> Result<Self, String> {
        let secret = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
        let public = PublicKey::from(&secret);
        stream
            .write_all(public.as_bytes())
            .await
            .map_err(|e| format!("Handshake write error: {}", e))?;

        let mut peer_bytes = [0u8; 32];
        stream
            .read_exact(&mut peer_bytes)
            .await
            .map_err(|e| format!("Handshake read error: {}", e))?;

        Ok(Self::new(stream, secret, peer_bytes.into(), 0x01, 0x02))
    }

    /// Responder (receiver) side of the handshake.
    pub async fn accept(mut stream: DynStream) -> Result<Self, String> {
        let mut peer_bytes = [0u8; 32];
        stream
            .read_exact(&mut peer_bytes)
            .await
            .map_err(|e| format!("Handshake read error: {}", e))?;

        let secret = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
        let public = PublicKey::from(&secret);
        stream
            .write_all(public.as_bytes())
            .await
            .map_err(|e| format!("Handshake write error: {}", e))?;

        Ok(Self::new(stream, secret, peer_bytes.into(), 0x02, 0x01))
    }

    fn new(
        stream: DynStream,
        secret: EphemeralSecret,
        peer: PublicKey,
        send_prefix: u8,
        recv_prefix: u8,
    ) -> Self {
        let shared = secret.diffie_hellman(&peer);
        let key = Sha256::digest(shared.as_bytes());
        let cipher = Aes256Gcm::new_from_slice(&key).expect("SHA-256 output is a valid key");

        // Short authentication string: both ends derive the same 6-digit
        // code from the session key. A man-in-the-middle ends up with two
        // different sessions, so the codes won't match.
        let digest = Sha256::digest([b"bliink-verify".as_slice(), &key].concat());
        let num = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
        let verification_code = format!("{:03} {:03}", num / 1000, num % 1000);

        Self {
            stream,
            cipher,
            send_prefix,
            recv_prefix,
            send_counter: 0,
            recv_counter: 0,
            verification_code,
        }
    }

    pub fn verification_code(&self) -> &str {
        &self.verification_code
    }

    /// Split into independent read/write halves so a long-lived channel can
    /// send and receive concurrently. Each half keeps its own nonce counter.
    pub fn into_split(self) -> (SecureReader, SecureWriter) {
        let (read_half, write_half) = tokio::io::split(self.stream);
        (
            SecureReader {
                stream: read_half,
                cipher: self.cipher.clone(),
                prefix: self.recv_prefix,
                counter: self.recv_counter,
            },
            SecureWriter {
                stream: write_half,
                cipher: self.cipher,
                prefix: self.send_prefix,
                counter: self.send_counter,
            },
        )
    }

    fn nonce(prefix: u8, counter: u64) -> [u8; 12] {
        let mut nonce = [0u8; 12];
        nonce[0] = prefix;
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        nonce
    }

    pub async fn send_frame(&mut self, plaintext: &[u8]) -> Result<(), String> {
        let nonce = Self::nonce(self.send_prefix, self.send_counter);
        self.send_counter += 1;

        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| "Encryption failed".to_string())?;

        let len = ciphertext.len() as u32;
        self.stream
            .write_all(&len.to_be_bytes())
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        self.stream
            .write_all(&ciphertext)
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }

    pub async fn recv_frame(&mut self) -> Result<Vec<u8>, String> {
        let mut len_buf = [0u8; 4];
        self.stream
            .read_exact(&mut len_buf)
            .await
            .map_err(|e| format!("Read error: {}", e))?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > MAX_FRAME_LEN {
            return Err(format!("Invalid frame length: {}", len));
        }

        let mut buf = vec![0u8; len];
        self.stream
            .read_exact(&mut buf)
            .await
            .map_err(|e| format!("Read error: {}", e))?;

        let nonce = Self::nonce(self.recv_prefix, self.recv_counter);
        self.recv_counter += 1;

        self.cipher
            .decrypt(Nonce::from_slice(&nonce), buf.as_slice())
            .map_err(|_| "Decryption failed — data corrupted or tampered with".to_string())
    }
}

/// Receiving half of a split SecureStream.
pub struct SecureReader {
    stream: tokio::io::ReadHalf<DynStream>,
    cipher: Aes256Gcm,
    prefix: u8,
    counter: u64,
}

impl SecureReader {
    pub async fn recv_frame(&mut self) -> Result<Vec<u8>, String> {
        let mut len_buf = [0u8; 4];
        self.stream
            .read_exact(&mut len_buf)
            .await
            .map_err(|e| format!("Read error: {}", e))?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > MAX_FRAME_LEN {
            return Err(format!("Invalid frame length: {}", len));
        }

        let mut buf = vec![0u8; len];
        self.stream
            .read_exact(&mut buf)
            .await
            .map_err(|e| format!("Read error: {}", e))?;

        let nonce = SecureStream::nonce(self.prefix, self.counter);
        self.counter += 1;

        self.cipher
            .decrypt(Nonce::from_slice(&nonce), buf.as_slice())
            .map_err(|_| "Decryption failed — data corrupted or tampered with".to_string())
    }
}

/// Sending half of a split SecureStream.
pub struct SecureWriter {
    stream: tokio::io::WriteHalf<DynStream>,
    cipher: Aes256Gcm,
    prefix: u8,
    counter: u64,
}

impl SecureWriter {
    pub async fn send_frame(&mut self, plaintext: &[u8]) -> Result<(), String> {
        let nonce = SecureStream::nonce(self.prefix, self.counter);
        self.counter += 1;

        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| "Encryption failed".to_string())?;

        let len = ciphertext.len() as u32;
        self.stream
            .write_all(&len.to_be_bytes())
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        self.stream
            .write_all(&ciphertext)
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }
}
