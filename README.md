# Bliink

Fast, encrypted file sharing for your local network. No cloud, no accounts — devices discover each other automatically and transfer files directly, end to end.

Built with [Tauri 2](https://tauri.app) (Rust) and [Next.js](https://nextjs.org).

## Features

- **Automatic device discovery** on your LAN (UDP broadcast)
- **Encrypted transfers** — X25519 key exchange + AES-256-GCM on every connection
- **Verification codes** — compare a 6-digit code on both screens to rule out interception
- **Consent prompts** — nothing lands on your disk without you accepting it (auto-accept optional)
- **Verified delivery** — SHA-256 checked on the receiver before the sender sees "completed"
- **Folder transfers** — send whole directory trees as one batch with a single prompt
- **Pause / resume / cancel** from either side
- **Transfer history** stored locally in SQLite
- **Desktop notifications** for incoming files and finished transfers

## Development

Prerequisites: [Rust](https://rustup.rs), [Node.js](https://nodejs.org), [pnpm](https://pnpm.io), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
pnpm install
pnpm tauri dev      # run the desktop app in dev mode
pnpm tauri build    # produce a release bundle
```

The frontend lives in `app/` (Next.js App Router, static export) and the backend in `src-tauri/src/`:

| Module | Purpose |
| --- | --- |
| `discovery.rs` | UDP broadcast device discovery |
| `transfer.rs` | Transfer engine: send/receive, batching, consent, pause/cancel |
| `crypto.rs` | Encrypted stream (X25519 + AES-256-GCM) and verification codes |
| `history.rs` | SQLite transfer history |
| `config.rs` | Persisted settings and device identity |

Both devices must run the same protocol version to talk to each other.

## Security notes

Transfers are encrypted with ephemeral keys negotiated per connection. The key exchange is unauthenticated, so for sensitive transfers compare the on-screen verification codes (enable **Require Code Check** in settings to make this mandatory). Received filenames are sanitized against path traversal, and incoming files require explicit acceptance by default.

## License

[MIT](LICENSE)
