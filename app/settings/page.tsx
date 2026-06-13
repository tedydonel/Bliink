"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Monitor,
  Cpu,
  Globe,
  Copy,
  Check,
  Power,
  Users,
  ShieldAlert,
  Loader2,
} from "lucide-react";
import { useAppStore, type AppSettings } from "@/app/lib/store";
import { formatBliinkId } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

// Toggle styled to match the design system.
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        width: 38,
        height: 22,
        borderRadius: 99,
        border: "1px solid " + (on ? "transparent" : "var(--stroke2)"),
        background: on ? "var(--accent)" : "rgba(255,255,255,0.07)",
        position: "relative",
        cursor: "pointer",
        transition: "background 0.18s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2.5,
          left: on ? 18 : 3,
          width: 15,
          height: 15,
          borderRadius: "50%",
          background: on ? "var(--accent-ink)" : "var(--muted)",
          transition: "left 0.18s cubic-bezier(0.3,1.2,0.4,1)",
        }}
      />
    </button>
  );
}

export default function SettingsPage() {
  const { settings, updateSettings } = useAppStore();
  const [deviceInfo, setDeviceInfo] = useState<{ os: string; arch: string } | null>(null);
  const [networkInfo, setNetworkInfo] = useState<api.NetworkInfo | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Web Access state
  const [web, setWeb] = useState<api.WebServerStatus | null>(null);
  const [webBusy, setWebBusy] = useState(false);
  const [webError, setWebError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const webPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const load = async () => {
      const s = await api.getSettings();
      if (s) updateSettings(s);
      setDeviceInfo(await api.getDeviceInfo());
      setNetworkInfo(await api.getNetworkInfo());
      setAppVersion(await api.getAppVersion());
    };
    load();
  }, [updateSettings]);

  // Poll web-server status
  const refreshWeb = useCallback(async () => {
    const s = await api.getWebServerStatus();
    if (s) setWeb(s);
  }, []);
  useEffect(() => {
    refreshWeb();
    webPollRef.current = setInterval(refreshWeb, 3000);
    return () => {
      if (webPollRef.current) clearInterval(webPollRef.current);
    };
  }, [refreshWeb]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const copy = async (text: string, set: (b: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      set(true);
      setTimeout(() => set(false), 2000);
    } catch (e) {
      console.error("Clipboard error:", e);
    }
  };

  const persistSettings = useCallback((merged: AppSettings) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => api.updateSettings(merged), 400);
  }, []);

  const handleSettingChange = useCallback(
    (updates: Partial<AppSettings>) => {
      updateSettings(updates);
      persistSettings({ ...settings, ...updates });
    },
    [settings, updateSettings, persistSettings]
  );

  const handleChangeDownloadPath = useCallback(async () => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === "string") handleSettingChange({ downloadPath: dir });
    } catch (e) {
      console.error("Folder dialog error:", e);
    }
  }, [handleSettingChange]);

  const handleWebToggle = useCallback(async () => {
    setWebBusy(true);
    setWebError(null);
    try {
      const s = web?.running ? await api.stopWebServer() : await api.startWebServer();
      if (s) setWeb(s);
    } catch (e: any) {
      setWebError(String(e?.message ?? e));
    }
    setWebBusy(false);
  }, [web?.running]);

  const webRunning = web?.running ?? false;

  return (
    <div className="bk-view">
      <div className="bk-view-head">
        <div>
          <div className="bk-view-title">Settings</div>
          <div className="bk-view-sub">Identity, transfers, encryption and remote access</div>
        </div>
      </div>

      <div className="bk-scroll">
        <div className="bk-settings-grid">
          {/* This device */}
          <div className="bk-card">
            <h3>This device</h3>
            <div className="desc">How you appear to others on the network.</div>
            <div className="bk-field" style={{ borderTop: "none", paddingTop: 0 }}>
              <div>
                <div className="bk-field-label">Device name</div>
                <div className="bk-field-sub">Shown on the radar of nearby peers</div>
              </div>
              <div className="bk-input" style={{ width: 220 }}>
                <input
                  value={settings.deviceName}
                  onChange={(e) => handleSettingChange({ deviceName: e.target.value })}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                />
              </div>
            </div>
            <div className="bk-field">
              <div>
                <div className="bk-field-label">Platform</div>
                <div className="bk-field-sub">Detected automatically</div>
              </div>
              <span className="v" style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--muted)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <Monitor size={13} /> {deviceInfo?.os ?? "—"}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <Cpu size={13} /> {deviceInfo?.arch ?? "—"}
                </span>
              </span>
            </div>
            <div className="bk-field">
              <div>
                <div className="bk-field-label">Save received files to</div>
                <div className="bk-field-sub">Folder batches keep their structure</div>
              </div>
              <button
                className="bk-btn"
                style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 500, maxWidth: 260 }}
                onClick={handleChangeDownloadPath}
                title={settings.downloadPath || "Downloads folder"}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {settings.downloadPath || "Downloads folder"}
                </span>
              </button>
            </div>
          </div>

          {/* Transfers */}
          <div className="bk-card">
            <h3>Transfers</h3>
            <div className="desc">Defaults for incoming and outgoing transfers.</div>
            <div className="bk-field" style={{ borderTop: "none", paddingTop: 0 }}>
              <div>
                <div className="bk-field-label">Require code check</div>
                <div className="bk-field-sub">Confirm the 6-digit code matches before accepting</div>
              </div>
              <Toggle on={settings.requirePin} onChange={(v) => handleSettingChange({ requirePin: v })} />
            </div>
            <div className="bk-field">
              <div>
                <div className="bk-field-label">Auto-accept files</div>
                <div className="bk-field-sub">Receive without a confirmation prompt</div>
              </div>
              <Toggle on={settings.autoAcceptFromPaired} onChange={(v) => handleSettingChange({ autoAcceptFromPaired: v })} />
            </div>
            <div className="bk-field">
              <div>
                <div className="bk-field-label">Notifications</div>
                <div className="bk-field-sub">System alerts for incoming and finished transfers</div>
              </div>
              <Toggle on={settings.showNotifications} onChange={(v) => handleSettingChange({ showNotifications: v })} />
            </div>
            <div className="bk-field">
              <div>
                <div className="bk-field-label">Max concurrent transfers</div>
                <div className="bk-field-sub">How many run in parallel</div>
              </div>
              <select
                value={settings.maxConcurrentTransfers}
                onChange={(e) => handleSettingChange({ maxConcurrentTransfers: Number(e.target.value) })}
                className="bk-btn"
                style={{ padding: "0 10px" }}
              >
                {[1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Remote Access */}
          <div className="bk-card">
            <h3>Remote Access</h3>
            <div className="desc">Reach this device from anywhere over the internet — no setup needed.</div>
            <div className="bk-field" style={{ borderTop: "none", paddingTop: 0 }}>
              <div style={{ minWidth: 0 }}>
                <div className="bk-field-label">Bliink ID</div>
                <div className="bk-field-sub">Copies the full ID — share it to connect over the internet</div>
              </div>
              <button
                className="bk-btn"
                style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, letterSpacing: "0.04em", maxWidth: 260 }}
                disabled={!networkInfo?.bliinkId}
                onClick={() => networkInfo?.bliinkId && copy(networkInfo.bliinkId, setCopiedId)}
                title="Copy full Bliink ID"
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {networkInfo?.bliinkId ? formatBliinkId(networkInfo.bliinkId) : "Starting…"}
                </span>
                {copiedId ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <div className="bk-field">
              <div>
                <div className="bk-field-label">Local address</div>
                <div className="bk-field-sub">For this network or a VPN like Tailscale</div>
              </div>
              <button
                className="bk-btn"
                style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}
                onClick={() => networkInfo && copy(`${networkInfo.ip}:${networkInfo.chatPort}`, setCopied)}
                title="Copy address"
              >
                {networkInfo ? `${networkInfo.ip}:${networkInfo.chatPort}` : "…"}
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <p style={{ fontSize: 11, color: "var(--faint)", marginTop: 12, lineHeight: 1.55 }}>
              Internet connections punch through routers directly when possible and fall back
              to an encrypted relay — end-to-end encrypted either way.
            </p>
          </div>

          {/* Web Access */}
          <div className="bk-card">
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <h3>Web Access</h3>
                <div className="desc" style={{ marginBottom: 0 }}>
                  Let devices without Bliink chat and exchange files from a browser.
                </div>
              </div>
              <button
                className={webRunning ? "bk-btn danger" : "bk-btn primary"}
                onClick={handleWebToggle}
                disabled={webBusy}
              >
                {webBusy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                {webRunning ? "Stop server" : "Start server"}
              </button>
            </div>

            {webError && (
              <div className="bk-chip" style={{ height: "auto", padding: "9px 11px", marginTop: 12, color: "var(--danger)", borderColor: "rgba(255,107,122,0.3)", background: "rgba(255,107,122,0.08)", whiteSpace: "normal" }}>
                {webError}
              </div>
            )}

            {webRunning && web ? (
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="bk-field" style={{ borderTop: "none", paddingTop: 0 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="bk-field-label">Open in a browser</div>
                    <div className="bk-field-sub">Same network or VPN as this device</div>
                  </div>
                  <button
                    className="bk-btn"
                    style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", maxWidth: 240 }}
                    onClick={() => copy(web.url, setCopiedUrl)}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{web.url}</span>
                    {copiedUrl ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>

                <div className="bk-field">
                  <div>
                    <div className="bk-field-label">Access code</div>
                    <div className="bk-field-sub">Visitors enter this — treat it like a password</div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(web.code ?? "").split("").map((d, i) => (
                      <span key={i} className="bk-vcode-group" style={{ fontSize: 18, padding: "6px 10px", borderRadius: 8 }}>
                        {d}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="bk-section-label" style={{ margin: "4px 2px 8px" }}>
                    <Users size={12} /> Connected browsers — {web.clients.filter((c) => c.online).length}
                  </div>
                  {web.clients.length > 0 ? (
                    web.clients.map((c, i) => (
                      <div key={i} className="bk-kv-row" style={{ border: "1px solid var(--stroke)", borderRadius: 8, marginBottom: 6 }}>
                        <span className="k" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)" }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.online ? "var(--accent)" : "var(--faint)" }} />
                          {c.name}
                        </span>
                        <span className="v">{c.online ? "online" : "disconnected"}</span>
                      </div>
                    ))
                  ) : (
                    <p style={{ fontSize: 12, color: "var(--faint)" }}>
                      No one has connected yet. Their chats appear in Messages.
                    </p>
                  )}
                </div>

                <div className="bk-chip" style={{ height: "auto", padding: "10px 12px", color: "var(--warn)", borderColor: "rgba(255,200,97,0.25)", background: "rgba(255,200,97,0.06)", whiteSpace: "normal", lineHeight: 1.55, alignItems: "flex-start" }}>
                  <ShieldAlert size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                  Web access uses plain HTTP on your local network — unlike app-to-app transfers, browser traffic isn’t end-to-end encrypted. Use trusted networks and stop the server when done.
                </div>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: "var(--faint)", marginTop: 14, lineHeight: 1.55 }}>
                <Globe size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} />
                Start the server to get a link and a 6-digit code. Anyone on your network can open it in a browser.
              </p>
            )}
          </div>

          {/* About */}
          <div className="bk-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <h3 style={{ marginBottom: 2 }}>Bliink</h3>
                <div className="desc" style={{ marginBottom: 0, fontFamily: "var(--font-mono)" }}>
                  {appVersion ? `v${appVersion}` : "dev"} · Tauri 2 + Next.js
                </div>
              </div>
              <span className="bk-chip lock"><Check size={10} /> up to date</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
