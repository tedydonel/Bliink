"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  User,
  FolderOpen,
  Shield,
  Bell,
  Layers,
  Monitor,
  Cpu,
  Globe,
  Copy,
  Check,
} from "lucide-react";
import { useAppStore, type AppSettings } from "@/app/lib/store";
import { cn } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

export default function SettingsPage() {
  const { settings, updateSettings } = useAppStore();
  const [deviceInfo, setDeviceInfo] = useState<{ os: string; arch: string } | null>(null);
  const [networkInfo, setNetworkInfo] = useState<api.NetworkInfo | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const load = async () => {
      const s = await api.getSettings();
      if (s) updateSettings(s);

      const info = await api.getDeviceInfo();
      setDeviceInfo(info);

      setNetworkInfo(await api.getNetworkInfo());
      setAppVersion(await api.getAppVersion());
    };
    load();
  }, [updateSettings]);

  const handleCopyAddress = useCallback(async () => {
    if (!networkInfo) return;
    try {
      await navigator.clipboard.writeText(`${networkInfo.ip}:${networkInfo.chatPort}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Clipboard error:", e);
    }
  }, [networkInfo]);

  const [copiedId, setCopiedId] = useState(false);
  const handleCopyBliinkId = useCallback(async () => {
    if (!networkInfo?.bliinkId) return;
    try {
      await navigator.clipboard.writeText(networkInfo.bliinkId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch (e) {
      console.error("Clipboard error:", e);
    }
  }, [networkInfo]);

  const persistSettings = useCallback((merged: AppSettings) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      await api.updateSettings(merged);
    }, 400);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleSettingChange = useCallback(
    (updates: Partial<AppSettings>) => {
      updateSettings(updates);
      const merged = { ...settings, ...updates };
      persistSettings(merged);
    },
    [settings, updateSettings, persistSettings]
  );

  const handleChangeDownloadPath = useCallback(async () => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__)
      return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === "string") {
        handleSettingChange({ downloadPath: dir });
      }
    } catch (e) {
      console.error("Folder dialog error:", e);
    }
  }, [handleSettingChange]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-7 pb-5 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Profile & Settings</h1>
          <p className="text-[13px] text-muted mt-1">
            Manage your identity and preferences
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-5 space-y-8">
        {/* Profile Section */}
        <section className="animate-fade-in">
          <div className="flex items-start gap-6 p-6 rounded-2xl bg-gradient-to-br from-surface to-surface-active border border-border shadow-sm">
            {/* Avatar */}
            <div className="relative shrink-0">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-accent/20 to-sky/20 border-2 border-surface shadow-[0_0_0_4px_rgba(255,255,255,0.02)] flex items-center justify-center">
                 <User className="w-8 h-8 text-accent" />
              </div>
              <div className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-surface border-2 border-surface flex items-center justify-center">
                <div className="w-full h-full rounded-full bg-success border-2 border-surface" />
              </div>
            </div>

            {/* User Info & Edit */}
            <div className="flex-1 min-w-0 pt-1">
               <div className="mb-4">
                 <label className="text-[11px] font-bold text-muted uppercase tracking-wider block mb-1.5">
                   Display Name
                 </label>
                 <input
                    type="text"
                    value={settings.deviceName}
                    onChange={(e) => handleSettingChange({ deviceName: e.target.value })}
                    className="w-full max-w-md h-10 px-0 bg-transparent text-xl font-bold text-foreground focus:outline-none focus:border-b-2 focus:border-accent border-b border-transparent transition-all placeholder:text-muted/30"
                    placeholder="Enter device name"
                  />
               </div>

               <div className="flex items-center gap-4 text-[12px] text-muted font-medium">
                  <div className="flex items-center gap-1.5">
                    <Monitor className="w-3.5 h-3.5" />
                    <span>{deviceInfo?.os || "Unknown OS"}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5" />
                    <span>{deviceInfo?.arch || "Unknown Arch"}</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                    <span>Online</span>
                  </div>
               </div>
            </div>
          </div>
        </section>

        {/* Settings Sections */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Transfers */}
            <section className="animate-fade-in space-y-3" style={{ animationDelay: "50ms" }}>
              <h2 className="flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wider">
                <FolderOpen className="w-3.5 h-3.5" />
                Transfers
              </h2>
              
              <div className="flex flex-col gap-3">
                <div className="p-4 rounded-xl bg-surface border border-border">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-foreground">Download Location</p>
                    <button
                      onClick={handleChangeDownloadPath}
                      className="text-[11px] font-semibold text-accent hover:underline"
                    >
                      Change
                    </button>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-active/50 border border-border text-[12px] text-muted-light break-all">
                     <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                     {settings.downloadPath || "Downloads folder"}
                  </div>
                </div>

                <div className="flex items-center justify-between p-4 rounded-xl bg-surface border border-border">
                  <div>
                    <p className="text-sm font-medium text-foreground">Max Concurrent</p>
                    <p className="text-xs text-muted mt-0.5">Parallel transfers</p>
                  </div>
                  <select
                    value={settings.maxConcurrentTransfers}
                    onChange={(e) => handleSettingChange({ maxConcurrentTransfers: Number(e.target.value) })}
                    className="h-8 px-2 rounded-lg bg-surface-active border border-border text-sm text-foreground focus:outline-none focus:border-accent/40"
                  >
                    {[1, 2, 3, 5, 10].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center justify-between p-4 rounded-xl bg-surface border border-border">
                  <div>
                    <p className="text-sm font-medium text-foreground">Chunk Size</p>
                    <p className="text-xs text-muted mt-0.5">Data block size</p>
                  </div>
                  <select
                    value={settings.chunkSize}
                    onChange={(e) => handleSettingChange({ chunkSize: Number(e.target.value) })}
                    className="h-8 px-2 rounded-lg bg-surface-active border border-border text-sm text-foreground focus:outline-none focus:border-accent/40"
                  >
                    <option value={256 * 1024}>256 KB</option>
                    <option value={512 * 1024}>512 KB</option>
                    <option value={1024 * 1024}>1 MB</option>
                    <option value={4 * 1024 * 1024}>4 MB</option>
                    <option value={8 * 1024 * 1024}>8 MB</option>
                  </select>
                </div>
              </div>
            </section>

            {/* Security & Notifications */}
            <div className="space-y-6">
                <section className="animate-fade-in space-y-3" style={{ animationDelay: "100ms" }}>
                  <h2 className="flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wider">
                    <Shield className="w-3.5 h-3.5" />
                    Security
                  </h2>
                  <div className="flex flex-col gap-3">
                    <ToggleSetting
                      title="Require Code Check"
                      description="Must confirm codes match before accepting"
                      enabled={settings.requirePin}
                      onChange={(v) => handleSettingChange({ requirePin: v })}
                    />
                    <ToggleSetting
                      title="Auto-accept Files"
                      description="Receive without a confirmation prompt"
                      enabled={settings.autoAcceptFromPaired}
                      onChange={(v) => handleSettingChange({ autoAcceptFromPaired: v })}
                    />
                  </div>
                </section>

                <section className="animate-fade-in space-y-3" style={{ animationDelay: "150ms" }}>
                  <h2 className="flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wider">
                    <Bell className="w-3.5 h-3.5" />
                    Notifications
                  </h2>
                  <ToggleSetting
                    title="Enable Notifications"
                    description="System alerts for transfers"
                    enabled={settings.showNotifications}
                    onChange={(v) => handleSettingChange({ showNotifications: v })}
                  />
                </section>
            </div>
        </div>

        {/* Remote Access */}
        <section className="animate-fade-in space-y-3" style={{ animationDelay: "175ms" }}>
          <h2 className="flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wider">
            <Globe className="w-3.5 h-3.5" />
            Remote Access
          </h2>
          <div className="p-4 rounded-xl bg-surface border border-border">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Bliink ID</p>
                <p className="text-xs text-muted mt-0.5">
                  Share this to connect from anywhere over the internet — no setup needed
                </p>
              </div>
              <button
                onClick={handleCopyBliinkId}
                disabled={!networkInfo?.bliinkId}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-active border border-border text-[12px] font-mono text-foreground hover:border-accent/40 transition-colors shrink-0 max-w-[280px]"
                title="Copy Bliink ID"
              >
                <span className="truncate">
                  {networkInfo?.bliinkId ?? "Starting…"}
                </span>
                {copiedId ? (
                  <Check className="w-3.5 h-3.5 text-success shrink-0" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-muted shrink-0" />
                )}
              </button>
            </div>
            <div className="flex items-center justify-between gap-4 mt-3 pt-3 border-t border-border">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Local address</p>
                <p className="text-xs text-muted mt-0.5">
                  For devices on this network or a VPN like Tailscale
                </p>
              </div>
              <button
                onClick={handleCopyAddress}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-active border border-border text-[13px] font-mono text-foreground hover:border-accent/40 transition-colors shrink-0"
                title="Copy address"
              >
                {networkInfo ? `${networkInfo.ip}:${networkInfo.chatPort}` : "…"}
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-muted" />
                )}
              </button>
            </div>
            <p className="text-[11px] text-muted mt-3 pt-3 border-t border-border">
              Internet connections punch through routers directly when possible and fall
              back to an encrypted relay. Everything stays end-to-end encrypted either
              way — enable <span className="font-semibold">Require Code Check</span> for
              extra assurance with new devices.
            </p>
          </div>
        </section>

        {/* About */}
        <section className="animate-fade-in pt-4 border-t border-border" style={{ animationDelay: "200ms" }}>
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-surface border border-border">
                  <Layers className="w-5 h-5 text-accent" />
                </div>
                <div>
                  <p className="text-sm font-bold text-foreground">Bliink</p>
                  <p className="text-[11px] text-muted">
                    {appVersion ? `v${appVersion}` : "dev"} • Tauri v2 + Next.js
                  </p>
                </div>
             </div>
             <button className="text-[12px] font-medium text-muted hover:text-foreground transition-colors">
               Check for Updates
             </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function ToggleSetting({
  title,
  description,
  enabled,
  onChange,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-4 rounded-xl bg-surface border border-border">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={cn(
          "relative w-10 h-5.5 rounded-full transition-colors duration-200 shrink-0",
          enabled ? "bg-accent" : "bg-surface-active border border-border"
        )}
        style={{ height: "22px" }}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform duration-200 shadow-sm",
            enabled
              ? "translate-x-[18px] bg-background"
              : "translate-x-0 bg-muted"
          )}
        />
      </button>
    </div>
  );
}
