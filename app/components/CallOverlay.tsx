"use client";

import { useEffect, useState } from "react";
import { Mic, MicOff, Monitor, Phone, PhoneOff } from "lucide-react";
import { useAppStore } from "@/app/lib/store";
import { callManager } from "@/app/lib/call-manager";
import * as api from "@/app/lib/tauri-api";
import { cn } from "@/app/lib/utils";

/**
 * Global call UI, mounted in the root layout. Incoming calls show a
 * centered modal; outgoing/active calls a floating card so the rest of
 * the app stays usable. Also wires the signaling events to the manager.
 */
export default function CallOverlay() {
  const callState = useAppStore((s) => s.callState);

  // Route signaling to the manager
  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__)
      return;
    let unlisten: (() => void) | undefined;
    api
      .onCallSignal(({ deviceId, payload }) => {
        callManager.handleSignal(deviceId, payload);
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  if (callState.status === "idle") return null;

  if (callState.status === "incoming") {
    return (
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
        <div className="w-[340px] p-8 rounded-2xl bg-surface border border-border shadow-2xl text-center">
          <div className="relative mx-auto w-20 h-20 mb-4">
            <div className="flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-accent/20 to-sky/20 border border-accent/20">
              <Monitor className="w-8 h-8 text-accent" />
            </div>
            <span className="absolute inset-0 rounded-full border-2 border-accent/40 animate-ping" />
          </div>
          <p className="text-[16px] font-bold text-foreground">{callState.peerName}</p>
          <p className="text-[12px] text-muted mt-1 mb-7">Incoming audio call…</p>

          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => callManager.declineCall()}
              className="flex items-center justify-center w-14 h-14 rounded-full bg-danger text-white hover:opacity-90 transition-opacity shadow-lg"
              aria-label="Decline"
            >
              <PhoneOff className="w-6 h-6" />
            </button>
            <button
              onClick={() => callManager.acceptCall()}
              className="flex items-center justify-center w-14 h-14 rounded-full bg-success text-white hover:opacity-90 transition-opacity shadow-lg"
              aria-label="Accept"
            >
              <Phone className="w-6 h-6" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Outgoing / connecting / active / ended — floating card
  return (
    <div className="fixed bottom-5 right-5 z-[110] animate-fade-in">
      <div className="flex items-center gap-3 pl-4 pr-3 py-3 rounded-2xl bg-surface border border-border shadow-2xl min-w-[280px]">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-gradient-to-br from-accent/20 to-sky/20 border border-accent/20 shrink-0">
          <Monitor className="w-4 h-4 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold text-foreground truncate">
            {callState.peerName}
          </p>
          <CallStatusLine />
        </div>

        {callState.status === "active" && (
          <button
            onClick={() => callManager.toggleMute()}
            className={cn(
              "flex items-center justify-center w-9 h-9 rounded-full transition-colors shrink-0",
              callState.muted
                ? "bg-warning/20 text-warning"
                : "bg-surface-active text-muted-light hover:text-foreground"
            )}
            aria-label={callState.muted ? "Unmute" : "Mute"}
          >
            {callState.muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
        )}

        {callState.status !== "ended" && (
          <button
            onClick={() => callManager.hangup()}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-danger text-white hover:opacity-90 transition-opacity shrink-0"
            aria-label="End call"
          >
            <PhoneOff className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function CallStatusLine() {
  const callState = useAppStore((s) => s.callState);
  const [, forceTick] = useState(0);

  // Tick every second while active so the duration updates
  useEffect(() => {
    if (callState.status !== "active") return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [callState.status]);

  let text: string;
  switch (callState.status) {
    case "outgoing":
      text = callState.ringing ? "Ringing…" : "Calling…";
      break;
    case "connecting":
      text = "Connecting…";
      break;
    case "active": {
      const seconds = callState.startedAt
        ? Math.floor((Date.now() - callState.startedAt) / 1000)
        : 0;
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      text = `${m}:${String(s).padStart(2, "0")}`;
      break;
    }
    case "ended":
      text = callState.endedReason ?? "Call ended";
      break;
    default:
      text = "";
  }

  return (
    <p
      className={cn(
        "text-[11px] mt-0.5",
        callState.status === "active"
          ? "text-success font-mono"
          : callState.status === "ended"
          ? "text-muted"
          : "text-accent"
      )}
    >
      {text}
    </p>
  );
}
