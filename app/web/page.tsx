"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Globe,
  Power,
  Copy,
  Check,
  Users,
  ShieldAlert,
  Loader2,
} from "lucide-react";
import { cn } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

export default function WebAccessPage() {
  const [status, setStatus] = useState<api.WebServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const s = await api.getWebServerStatus();
    if (s) setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const handleToggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = status?.running
        ? await api.stopWebServer()
        : await api.startWebServer();
      if (s) setStatus(s);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
    setBusy(false);
  }, [status?.running]);

  const handleCopy = useCallback(async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Clipboard error:", e);
    }
  }, [status]);

  const running = status?.running ?? false;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-7 pb-5 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Web Access</h1>
          <p className="text-[13px] text-muted mt-1">
            Let devices without Bliink chat and exchange files with you from a browser
          </p>
        </div>
        <button
          onClick={handleToggle}
          disabled={busy}
          className={cn(
            "flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-all",
            running
              ? "bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20"
              : "bg-accent text-background hover:bg-accent-hover shadow-[0_0_20px_rgba(56,189,248,0.15)]"
          )}
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Power className="w-4 h-4" />
          )}
          {running ? "Stop Server" : "Start Server"}
        </button>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-6 space-y-6">
        {error && (
          <div className="px-4 py-3 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[13px]">
            {error}
          </div>
        )}

        {!running ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-surface border border-border mb-4">
              <Globe className="w-7 h-7 text-muted" />
            </div>
            <p className="text-[15px] font-semibold text-foreground">Web access is off</p>
            <p className="text-[13px] text-muted mt-1.5 max-w-[340px]">
              Start the server to get a link and a 6-digit code. Anyone on your network
              (or your VPN) can open the link in a browser and connect.
            </p>
          </div>
        ) : (
          <>
            {/* Connection info */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-fade-in">
              <div className="p-5 rounded-2xl bg-surface border border-border">
                <p className="text-[11px] font-bold text-muted uppercase tracking-wider mb-3">
                  Open in a browser
                </p>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-2.5 w-full px-4 py-3 rounded-xl bg-surface-active border border-border hover:border-accent/40 transition-colors"
                  title="Copy link"
                >
                  <span className="text-[15px] font-mono text-accent truncate">
                    {status?.url}
                  </span>
                  {copied ? (
                    <Check className="w-4 h-4 text-success shrink-0 ml-auto" />
                  ) : (
                    <Copy className="w-4 h-4 text-muted shrink-0 ml-auto" />
                  )}
                </button>
                <p className="text-[11px] text-muted mt-2.5">
                  The other device must be on the same network (or connected via VPN)
                </p>
              </div>

              <div className="p-5 rounded-2xl bg-surface border border-border">
                <p className="text-[11px] font-bold text-muted uppercase tracking-wider mb-3">
                  Access code
                </p>
                <div className="flex items-center justify-center gap-2">
                  {(status?.code ?? "").split("").map((digit, i) => (
                    <span
                      key={i}
                      className="flex items-center justify-center w-11 h-13 py-3 rounded-xl bg-surface-active border border-accent/20 text-[22px] font-bold text-accent font-mono"
                    >
                      {digit}
                    </span>
                  ))}
                </div>
                <p className="text-[11px] text-muted mt-2.5 text-center">
                  Visitors enter this code to connect — treat it like a password
                </p>
              </div>
            </div>

            {/* Connected clients */}
            <div className="p-5 rounded-2xl bg-surface border border-border animate-fade-in">
              <p className="flex items-center gap-2 text-[11px] font-bold text-muted uppercase tracking-wider mb-3">
                <Users className="w-3.5 h-3.5" />
                Connected browsers — {status?.clients.filter((c) => c.online).length ?? 0}
              </p>
              {status && status.clients.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {status.clients.map((client, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 px-3.5 py-2.5 rounded-lg bg-surface-active/50 border border-border"
                    >
                      <span
                        className={cn(
                          "w-2 h-2 rounded-full",
                          client.online ? "bg-success" : "bg-muted"
                        )}
                      />
                      <span className="text-[13px] font-medium text-foreground">
                        {client.name}
                      </span>
                      <span className="text-[11px] text-muted ml-auto">
                        {client.online ? "Online" : "Disconnected"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted">
                  No one has connected yet. Their chats will appear in your{" "}
                  <span className="text-accent font-semibold">Chats</span> page.
                </p>
              )}
            </div>

            {/* Security note */}
            <div className="flex items-start gap-3 p-4 rounded-xl bg-warning/5 border border-warning/15 animate-fade-in">
              <ShieldAlert className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <p className="text-[12px] text-muted-light leading-relaxed">
                Web access uses plain HTTP on your local network — unlike app-to-app
                transfers, browser traffic isn't end-to-end encrypted. Use it on networks
                you trust, and stop the server when you're done. The server stops
                automatically when you quit Bliink.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
