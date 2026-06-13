"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Monitor,
  Laptop,
  Smartphone,
  Tablet,
  Search,
  Plus,
  X,
  Lock,
  Check,
  Send,
  MessageCircle,
  Eye,
  EyeOff,
  Globe,
  AlertCircle,
} from "lucide-react";
import { useAppStore, type Device, type DeviceType } from "@/app/lib/store";
import { cn, formatBliinkId } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";
import WorldMap, { type MapPeer, type MapHome } from "@/app/components/WorldMap";
import PairCircle from "@/app/components/PairCircle";
import { geoSelf, geoForIp, type Geo } from "@/app/lib/geoip";

// A device belongs to the Internet scope if it's reached over P2P (nodeId) or
// was added by address (manual / VPN); everything else is local LAN.
const isInternetPeer = (d: Device) => !!d.nodeId || !!d.manual;

// ── helpers ────────────────────────────────────────────────────

function deviceIcon(type: DeviceType | undefined, size: number) {
  const props = { size };
  switch (type) {
    case "laptop":
      return <Laptop {...props} />;
    case "phone":
      return <Smartphone {...props} />;
    case "tablet":
      return <Tablet {...props} />;
    default:
      return <Monitor {...props} />;
  }
}

// Stable pseudo-position on the radar derived from the device id, so a peer
// keeps its spot between renders without the backend supplying coordinates.
function radarPos(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const angle = h % 360;
  const dist = 0.45 + ((h >> 9) % 100) / 100 / 2.2; // 0.45 – 0.90
  return { angle, dist };
}

function maskIp(ip: string) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? "•••.•••.•.••" : ip;
}

// ── peer side panel ────────────────────────────────────────────

function PeerPanel({
  peer,
  scope,
  onClose,
  onSend,
  onMessage,
}: {
  peer: Device;
  scope: "lan" | "internet";
  onClose: () => void;
  onSend: (d: Device) => void;
  onMessage: (d: Device) => void;
}) {
  const [revealIp, setRevealIp] = useState(false);
  const isLan = scope === "lan";
  const incompatible = peer.compatible === false;

  return (
    <aside className={cn("bk-peer-panel", !isLan && "overlay")}>
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "-8px -8px -14px 0" }}>
        <button className="bk-iconbtn" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="bk-peer-hero">
        <div className="bk-peer-hero-avatar">{deviceIcon(peer.deviceType, 28)}</div>
        <div>
          <div className="bk-peer-hero-name">{peer.name}</div>
          <div className="bk-peer-hero-device">{peer.os || (isLan ? "Local device" : "Internet peer")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span className="bk-chip lock"><Lock size={11} /> AES-256-GCM</span>
          {peer.manual ? (
            <span className="bk-chip">added manually</span>
          ) : (
            <span className="bk-chip"><Check size={11} /> discovered</span>
          )}
        </div>
      </div>

      {incompatible ? (
        <div className="bk-chip" style={{ height: "auto", padding: "9px 11px", color: "var(--warn)", borderColor: "rgba(255,200,97,0.3)", background: "rgba(255,200,97,0.08)", whiteSpace: "normal", lineHeight: 1.5 }}>
          This device runs an incompatible Bliink version. Update both to connect.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button className="bk-btn primary" style={{ flex: 1 }} onClick={() => onSend(peer)}>
            <Send size={14} /> Send files
          </button>
          <button className="bk-btn" style={{ flex: 1 }} onClick={() => onMessage(peer)}>
            <MessageCircle size={14} /> Message
          </button>
        </div>
      )}

      <div className="bk-kv">
        <div className="bk-kv-row">
          <span className="k">{isLan ? "Address" : "Bliink ID"}</span>
          <span className="v" style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isLan
              ? revealIp
                ? `${peer.ip}:${peer.port}`
                : maskIp(peer.ip)
              : formatBliinkId(peer.nodeId)}
            {isLan ? (
              <button className="bk-eye" title={revealIp ? "Hide" : "Reveal"} onClick={() => setRevealIp(!revealIp)}>
                {revealIp ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            ) : null}
          </span>
        </div>
        <div className="bk-kv-row">
          <span className="k">Status</span>
          <span className={cn("v", peer.status !== "offline" && "good")}>{peer.status}</span>
        </div>
        <div className="bk-kv-row">
          <span className="k">Transport</span>
          <span className="v">{isLan ? "Direct · LAN" : "P2P · relay fallback"}</span>
        </div>
        {peer.os ? (
          <div className="bk-kv-row">
            <span className="k">Platform</span>
            <span className="v">{peer.os}</span>
          </div>
        ) : null}
      </div>

      <p style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.55 }}>
        Transfers to {peer.name} are encrypted end-to-end.{" "}
        {isLan
          ? "Data never leaves your local network."
          : "Data is relayed encrypted — the relay can't read it."}
      </p>
    </aside>
  );
}

// ── LAN radar ──────────────────────────────────────────────────

function RadarView({
  peers,
  selected,
  onSelect,
}: {
  peers: Device[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="bk-radar-wrap">
      <div className="bk-radar">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="bk-ripple" />
        ))}
        <div className="bk-glow-pulse" />
        <div className="bk-radar-center">
          <div className="bk-radar-core">
            <Monitor size={22} />
          </div>
          <div className="bk-radar-center-label">this PC</div>
        </div>
        {peers.map((p, i) => {
          const { angle, dist } = radarPos(p.id);
          const rad = (angle * Math.PI) / 180;
          const r = dist * 49;
          const x = 50 + Math.cos(rad) * r;
          const y = 50 + Math.sin(rad) * r * 0.92;
          return (
            <button
              key={p.id}
              className={cn("bk-peer-node", selected === p.id && "selected")}
              style={{ left: `${x}%`, top: `${y}%` }}
              onClick={() => onSelect(p.id)}
            >
              <div className="bk-peer-dot">
                {deviceIcon(p.deviceType, 18)}
                <span className="bk-peer-ping" style={{ animationDelay: `${i * 0.8}s` }} />
              </div>
              <span className="bk-peer-label">{p.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Internet: world map + peer list ────────────────────────────

function mapStatus(d: Device): MapPeer["status"] {
  if (d.status === "transferring") return "transfer";
  if (d.status === "offline") return "idle";
  return "connected";
}

function InternetView({
  peers,
  selected,
  onSelect,
  onAdded,
  query,
}: {
  peers: Device[];
  selected: string | null;
  onSelect: (id: string) => void;
  onAdded: () => void;
  query: string;
}) {
  const [home, setHome] = useState<MapHome | null>(null);
  const [geo, setGeo] = useState<Record<string, Geo>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  // This device's location anchors the arcs.
  useEffect(() => {
    let alive = true;
    geoSelf().then((g) => {
      if (alive && g) setHome({ lon: g.lon, lat: g.lat, label: `you · ${g.city ?? "here"}` });
    });
    return () => {
      alive = false;
    };
  }, []);

  // Locate any peer that exposes a public IP. Pure-relay P2P peers (no IP yet)
  // stay in the list below until the backend surfaces their direct address.
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const p of peers) {
        if (geo[p.id] || !p.ip) continue;
        const g = await geoForIp(p.ip);
        if (alive && g) setGeo((prev) => ({ ...prev, [p.id]: g }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [peers, geo]);

  const mapPeers: MapPeer[] = useMemo(
    () =>
      peers
        .filter((p) => geo[p.id])
        .map((p) => ({
          id: p.id,
          name: p.name,
          lon: geo[p.id].lon,
          lat: geo[p.id].lat,
          status: mapStatus(p),
        })),
    [peers, geo]
  );

  const q = query.toLowerCase();
  const listed = peers.filter((p) => p.name.toLowerCase().includes(q));

  return (
    <div className="bk-internet" ref={scrollRef}>
      {/* full-page map; the peer table sits below it on scroll (like the prototype) */}
      <div style={{ position: "relative", minHeight: "100%", flexShrink: 0, display: "flex" }}>
        <WorldMap
          peers={mapPeers}
          home={home}
          selected={selected}
          onSelect={onSelect}
          query={query}
        />
        <PairCircle onAdded={onAdded} />
      </div>

      <div className="bk-table-wrap">
        <div className="bk-table-row head">
          <span>Peer</span>
          <span>Route</span>
          <span>Status</span>
          <span />
        </div>
        <div className="bk-table-scroll">
          {listed.map((p) => {
            const st = p.status === "transferring" ? "tx" : p.status === "offline" ? "off" : "on";
            return (
              <div
                key={p.id}
                className={cn("bk-table-row", selected === p.id && "selected")}
                style={{ gridTemplateColumns: "minmax(170px,1.6fr) 1.2fr 1fr auto" }}
                onClick={() => onSelect(p.id)}
              >
                <span className="bk-table-peer">
                  <span className="bk-row-avatar sm">{deviceIcon(p.deviceType, 15)}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="nm">{p.name}</span>
                    <span className="dv">{geo[p.id]?.city ?? (p.nodeId ? "P2P" : "remote")}</span>
                  </span>
                </span>
                <span className="mono">{p.nodeId ? formatBliinkId(p.nodeId) : `${p.ip}:${p.port}`}</span>
                <span className={cn("bk-status", st)}>
                  <i />
                  {p.status}
                </span>
                <span className="bk-table-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="bk-iconbtn" title="Select" onClick={() => onSelect(p.id)}>
                    <Globe size={14} />
                  </button>
                </span>
              </div>
            );
          })}
          {listed.length === 0 ? (
            <div className="bk-empty" style={{ padding: 26 }}>
              <h3>No internet peers yet</h3>
              <p>Use the <b style={{ color: "var(--accent)" }}>+</b> on the map above to pair by Bliink ID — direct P2P with encrypted relay fallback.</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Network view ───────────────────────────────────────────────

export default function NetworkPage() {
  const router = useRouter();
  const { devices, setDevices, scope } = useAppStore();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const isTauri = useRef(false);

  useEffect(() => {
    isTauri.current =
      typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri.current) {
      setScanning(false);
      return;
    }

    let unlisten: (() => void) | undefined;
    const init = async () => {
      try {
        await api.startDiscovery();
      } catch (e) {
        console.warn("Auto-discovery start failed:", e);
      }
      const devs = await api.getDevices();
      if (devs.length > 0) setDevices(devs);
      unlisten = await api.onDevicesUpdated(setDevices);
    };
    init();

    const t = setTimeout(() => setScanning(false), 2800);
    return () => {
      clearTimeout(t);
      unlisten?.();
    };
  }, [setDevices]);

  // Selecting away from a scope clears the highlight.
  useEffect(() => setSelected(null), [scope]);

  const isLan = scope === "lan";
  const scopedPeers = devices.filter((d) => (isLan ? !isInternetPeer(d) : isInternetPeer(d)));
  const filtered = scopedPeers.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase())
  );
  const sel = scopedPeers.find((p) => p.id === selected) || null;

  const handleSend = useCallback(
    async (d: Device) => {
      const files = await api.openFileDialog();
      if (files.length === 0) return;
      await api.sendFiles(
        files.map((f) => f.path),
        d.ip,
        d.port,
        d.id,
        d.name
      );
      router.push("/transfer");
    },
    [router]
  );

  const handleMessage = useCallback(
    (d: Device) => router.push(`/chats?peer=${encodeURIComponent(d.id)}`),
    [router]
  );

  const refreshDevices = useCallback(async () => {
    setShowAdd(false);
    const devs = await api.getDevices();
    setDevices(devs);
  }, [setDevices]);

  const sub = isLan
    ? scanning
      ? "Scanning your local network…"
      : `${filtered.filter((d) => d.status !== "offline").length} device${filtered.length === 1 ? "" : "s"} discovered · UDP discovery`
    : `${scopedPeers.length} paired · encrypted P2P`;

  return (
    <div className="bk-view">
      <div className="bk-view-head bk-net-head">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <div className="bk-view-title">Network</div>
          <div
            className="bk-view-sub"
            style={{ marginTop: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {sub}
          </div>
        </div>
        <div className="bk-head-spacer" />
        {isLan && (
          <button className="bk-iconbtn" title="Add a device by IP / VPN" onClick={() => setShowAdd(true)}>
            <Plus size={16} />
          </button>
        )}
        <div className="bk-input" style={{ width: 220 }}>
          <Search size={15} />
          <input
            placeholder="Search active users…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="bk-net-body">
        {isLan ? (
          <RadarView peers={filtered} selected={selected} onSelect={(id) => setSelected(id === selected ? null : id)} />
        ) : (
          <InternetView
            peers={filtered}
            selected={selected}
            onSelect={(id) => setSelected(id === selected ? null : id)}
            onAdded={refreshDevices}
            query={query}
          />
        )}
        {sel ? (
          <PeerPanel
            peer={sel}
            scope={scope}
            onClose={() => setSelected(null)}
            onSend={handleSend}
            onMessage={handleMessage}
          />
        ) : null}
      </div>

      {showAdd && <AddRemoteDialog onAdded={refreshDevices} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// ── Add device dialog (re-skinned to the design system) ─────────

function AddRemoteDialog({
  onAdded,
  onClose,
}: {
  onAdded: () => void;
  onClose: () => void;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9101");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async () => {
    setError(null);
    const portNum = Number(port);
    if (!host.trim()) {
      setError("Enter the device's IP address or hostname");
      return;
    }
    if (!portNum || portNum < 1 || portNum > 65535) {
      setError("Enter a valid port (shown on the other device's Settings)");
      return;
    }
    setBusy(true);
    try {
      await api.addManualDevice(host.trim(), portNum);
      onAdded();
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="bk-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bk-modal">
        <h2>Add a device by address</h2>
        <p className="sub">Reach a device on your LAN or a VPN like Tailscale by its address. To connect over the internet, switch to the Internet tab and pair by Bliink ID.</p>

        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="bk-section-label" style={{ margin: "0 2px 8px" }}>Host or IP address</div>
            <div className="bk-input">
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="e.g. 100.84.12.7 or my-pc.tailnet.ts.net"
                autoFocus
              />
            </div>
          </div>
          <div>
            <div className="bk-section-label" style={{ margin: "0 2px 8px" }}>Port</div>
            <div className="bk-input" style={{ width: 140 }}>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </div>
          </div>

          {error && (
            <div className="bk-chip" style={{ height: "auto", padding: "9px 11px", color: "var(--danger)", borderColor: "rgba(255,107,122,0.3)", background: "rgba(255,107,122,0.08)", whiteSpace: "normal" }}>
              <AlertCircle size={13} /> {error}
            </div>
          )}
        </div>

        <div className="bk-modal-actions">
          <button className="bk-btn ghost" onClick={onClose}>Cancel</button>
          <button className="bk-btn primary" disabled={busy} onClick={handleAdd}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
