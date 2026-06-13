"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import { useAppStore } from "@/app/lib/store";
import { cn } from "@/app/lib/utils";
import { WifiIcon, GlobeIcon } from "./Icons";

export default function TitleBar() {
  const [appWindow, setAppWindow] = useState<any>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const scope = useAppStore((s) => s.scope);
  const setScope = useAppStore((s) => s.setScope);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const initTauri = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        setAppWindow(win);
        setIsMaximized(await win.isMaximized());
        // Keep the maximize/restore icon in sync with the real window state.
        unlisten = await win.onResized(async () => {
          setIsMaximized(await win.isMaximized());
        });
      } catch (e) {
        console.warn("Tauri window API unavailable (running in a browser?)", e);
      }
    };
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      initTauri();
    }
    return () => unlisten?.();
  }, []);

  const handleMinimize = useCallback(() => appWindow?.minimize(), [appWindow]);
  const handleToggleMaximize = useCallback(async () => {
    if (!appWindow) return;
    await appWindow.toggleMaximize();
    setIsMaximized(await appWindow.isMaximized());
  }, [appWindow]);
  const handleClose = useCallback(() => appWindow?.close(), [appWindow]);

  return (
    <div className="bk-titlebar" data-tauri-drag-region>
      <Image
        className="bk-titlebar-logo"
        src="/Logo.ico"
        alt="Bliink"
        width={18}
        height={18}
      />
      <div className="bk-wordmark">
        bl
        <span className="ii">
          <i>i</i>
          <i>i</i>
        </span>
        nk
      </div>

      <div className="bk-titlebar-drag" data-tauri-drag-region />

      <div className="bk-seg bk-titlebar-seg">
        <button
          className={cn("bk-seg-btn", scope === "lan" && "active")}
          onClick={() => setScope("lan")}
        >
          <WifiIcon size={13} /> LAN
        </button>
        <button
          className={cn("bk-seg-btn", scope === "internet" && "active")}
          onClick={() => setScope("internet")}
        >
          <GlobeIcon size={13} /> Internet
        </button>
      </div>

      {appWindow && (
        <div className="bk-wincontrols">
          <button
            className="bk-winbtn"
            onClick={handleMinimize}
            aria-label="Minimize"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1">
              <path d="M0.5 5.5h10" />
            </svg>
          </button>
          <button
            className="bk-winbtn"
            onClick={handleToggleMaximize}
            aria-label={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? (
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1">
                <rect x="0.5" y="2.5" width="8" height="8" rx="1" />
                <path d="M2.8 2.5V1.2A.7.7 0 0 1 3.5.5h6.3a.7.7 0 0 1 .7.7v6.3a.7.7 0 0 1-.7.7H8.5" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
                <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
              </svg>
            )}
          </button>
          <button
            className="bk-winbtn close"
            onClick={handleClose}
            aria-label="Close"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1">
              <path d="m0.8 0.8 9.4 9.4M10.2 0.8 0.8 10.2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
