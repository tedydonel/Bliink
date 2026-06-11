<div align="center">

<img src="public/app-icon.png" width="96" height="96" alt="Bliink logo" />

# Bliink

**Fast, encrypted file sharing for your local network.**

No cloud. No accounts. No size limits. Devices find each other automatically and transfer files directly — encrypted end to end.

[![License: MIT](https://img.shields.io/badge/License-MIT-38bdf8.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/tedydonel/Bliink?color=38bdf8)](https://github.com/tedydonel/Bliink/releases/latest)
[![Built with Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Rust](https://img.shields.io/badge/Rust-backend-orange?logo=rust)](https://www.rust-lang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

**[⬇ Download the latest release](https://github.com/tedydonel/Bliink/releases/latest)** — Windows installer, macOS dmg, Linux AppImage/deb/rpm

<!-- 📷 HERO SCREENSHOT — replace this comment with your main app screenshot, e.g.:
<img src="docs/screenshots/hero.png" width="800" alt="Bliink devices page" />
-->

</div>

---

## ✨ Features

| | |
|---|---|
| 🔍 **Zero-config discovery** | Devices running Bliink find each other automatically on your LAN — no IP addresses, no pairing codes to type |
| 🔐 **Encrypted by default** | Every transfer negotiates a fresh X25519 key exchange and streams over AES-256-GCM |
| 🛡️ **Verification codes** | Both screens show a 6-digit code derived from the session key — if they match, nobody is intercepting |
| ✋ **Consent first** | Incoming files prompt before a single byte lands on disk (auto-accept is opt-in) |
| ✅ **Verified delivery** | SHA-256 checked on the receiver before the sender ever sees "completed" |
| 📁 **Folder & batch transfers** | Send whole directory trees or multi-file selections as one batch with a single prompt |
| 🖼️ **Live previews** | Thumbnails for images, videos and documents — receivers see what's coming *before* accepting |
| 🗂️ **Collapsible groups** | Batches roll up into expandable group cards with aggregate progress on both ends |
| ⏯️ **Full transfer control** | Pause, resume and cancel from either side |
| 🕓 **Transfer history** | Searchable, filterable history stored locally in SQLite |
| 🔔 **Native notifications** | Toasts for incoming requests and finished transfers |
| 💬 **Built-in chat** | WhatsApp-style messaging with attachments, voice notes, replies, read receipts and typing indicators — all over the same encryption |
| 📞 **Audio calls** | Call any device on your network — WebRTC, no servers involved |
| 🌍 **Remote devices** | Add devices by address — works across the internet through a VPN like Tailscale |

## 📸 Screenshots

<!-- 📷 Add your screenshots here. Suggested layout (drop images into docs/screenshots/):

| Devices | Transfer | History |
|---|---|---|
| <img src="docs/screenshots/devices.png" width="260" /> | <img src="docs/screenshots/transfer.png" width="260" /> | <img src="docs/screenshots/history.png" width="260" /> |

| Incoming file prompt | Batch groups |
|---|---|
| <img src="docs/screenshots/prompt.png" width="400" /> | <img src="docs/screenshots/groups.png" width="400" /> |
-->

*Screenshots coming soon.*

## 🚀 Getting Started

### Install

Grab an installer from the **[releases page](https://github.com/tedydonel/Bliink/releases/latest)**. Windows is the primary platform; macOS and Linux builds are experimental (macOS builds are unsigned — right-click → *Open* the first time).

### Connect over the internet

Bliink discovers devices on your LAN automatically. For devices elsewhere, install a mesh VPN like [Tailscale](https://tailscale.com) on both machines, then use **Devices → Add Device** with the other machine's Tailscale IP and the port it shows under **Settings → Remote Access**. Everything — transfers, chat, calls — works over it.

### Prerequisites (building from source)

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io)
- Platform setup from the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)

### Run from source

```bash
git clone https://github.com/tedydonel/Bliink.git
cd Bliink
pnpm install
pnpm tauri dev
```

### Build a release bundle

```bash
pnpm tauri build
```

Installers land in `src-tauri/target/release/bundle/`.

> **Note:** Bliink talks over UDP port 9001 (discovery) and a dynamic TCP port (transfers). If Windows Firewall prompts you, allow access on private networks — or run `setup-firewall.ps1` as administrator.

## 🛡️ Security Model

Bliink is designed so that using it casually is safe, and using it carefully is verifiably safe:

1. **Ephemeral encryption** — every connection performs an X25519 Diffie-Hellman exchange; data flows in AES-256-GCM frames with per-direction nonces. Keys live only as long as the transfer.
2. **Man-in-the-middle detection** — both sides derive a 6-digit code from the session key. An interceptor ends up with two different sessions, so the codes won't match. Enable **Require Code Check** in settings to make confirming this mandatory before accepting.
3. **Consent gate** — incoming transfers are declined automatically unless you accept within 60 seconds. Folder batches prompt once for the whole batch.
4. **Tamper-proof delivery** — receivers hash incrementally and only acknowledge after verification; partial/failed downloads are cleaned up (`.part` files), never left masquerading as the real thing.
5. **Path traversal protection** — sender-supplied names are sanitized component-by-component; a malicious peer can't write outside your download folder.

Known limitation: the key exchange itself is unauthenticated (that's what the verification codes mitigate). PIN-bound pairing is on the roadmap.

## 🏗️ Architecture

```
┌────────────────────────┐        UDP broadcast (:9001)        ┌────────────────────────┐
│  Bliink (Device A)     │ ◄─────────  discovery  ───────────► │  Bliink (Device B)     │
│                        │                                     │                        │
│  Next.js UI (WebView)  │        TCP, dynamic port            │  Next.js UI (WebView)  │
│  Rust core (Tauri 2)   │ ◄═══ X25519 + AES-256-GCM ════════► │  Rust core (Tauri 2)   │
└────────────────────────┘         encrypted frames            └────────────────────────┘
```

| Layer | Tech | Source |
|---|---|---|
| UI | Next.js 16 (static export), Tailwind 4, Zustand | `app/` |
| Device discovery | UDP broadcast + presence pruning | `src-tauri/src/discovery.rs` |
| Transfer engine | Batching, consent, pause/cancel, acks | `src-tauri/src/transfer.rs` |
| Encryption | X25519 handshake, AES-256-GCM framing, SAS codes | `src-tauri/src/crypto.rs` |
| Previews | Windows Shell thumbnails + pure-Rust fallback | `src-tauri/src/thumbs.rs` |
| History | Embedded SQLite | `src-tauri/src/history.rs` |
| Settings | JSON in app data dir, stable device identity | `src-tauri/src/config.rs` |

The wire protocol is versioned by release — both devices should run the same version.

## 🗺️ Roadmap

- [x] Encrypted transfers with verification codes
- [x] Consent prompts & auto-accept setting
- [x] Folder / multi-file batches with single prompt
- [x] File previews (sender *and* receiver, before accepting)
- [x] Collapsible batch groups
- [x] Transfer history (SQLite) & desktop notifications
- [x] 💬 Built-in chat (text, attachments, voice notes, receipts, typing)
- [x] 📞 Audio calls over the LAN
- [x] 🌍 Remote devices by address (VPN / port-forward friendly)
- [ ] 🌐 Web access — share with devices that don't have the app, from your browser
- [ ] 🔗 PIN-bound device pairing
- [ ] 📡 mDNS discovery

## 🤝 Contributing

Issues and pull requests are welcome! For larger changes, please open an issue first to discuss the direction.

```bash
pnpm exec tsc --noEmit   # type-check the frontend
cargo check              # check the backend (run in src-tauri/)
cargo test               # run backend tests
```

## 📄 License

This project is licensed under the [MIT License](LICENSE).
