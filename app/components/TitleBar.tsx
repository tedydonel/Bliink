"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import { useAppStore } from "@/app/lib/store";
import { cn } from "@/app/lib/utils";

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [appWindow, setAppWindow] = useState<any>(null);
  const isConnected = useAppStore((s) => s.isConnected);

  useEffect(() => {
    // Dynamically import Tauri API to avoid issues in non-Tauri environments (e.g., browser)
    const initTauri = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        setAppWindow(win);
        
        // Check initial state
        const maximized = await win.isMaximized();
        setIsMaximized(maximized);
        
        // Listen for resize events to update the maximize icon state
        const unlisten = await win.onResized(async () => {
             const maximized = await win.isMaximized();
             setIsMaximized(maximized);
        });

        return () => unlisten();
      } catch (e) {
        console.warn("Tauri API not detected or failed to load. You might be running in a browser.", e);
      }
    };

    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      initTauri();
    }
  }, []);

  const handleMinimize = useCallback(() => {
    appWindow?.minimize();
  }, [appWindow]);

  const handleToggleMaximize = useCallback(async () => {
    if (!appWindow) return;
    await appWindow.toggleMaximize();
    const maximized = await appWindow.isMaximized();
    setIsMaximized(maximized);
  }, [appWindow]);

  const handleClose = useCallback(() => {
    appWindow?.close();
  }, [appWindow]);

  if (!appWindow) {
    return null;
  }

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between h-10 bg-sidebar border-b border-border select-none shrink-0"
    >
      {/* App Icon & Title */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 pl-4 pointer-events-none"
      >
        <div className="relative w-5 h-5">
            <Image 
                src="/Logo.ico" 
                alt="Bliink" 
                fill
                className="object-contain"
            />
        </div>
        <span className="text-xs font-bold text-foreground tracking-wide">Bliink</span>
      </div>

      {/* Window controls & Status */}
      <div className="flex items-center h-full">
        {/* Connection Status Indicator */}
        <div
          className={cn(
            "w-2.5 h-2.5 rounded-full shadow-[0_0_8px_currentColor] mr-4",
            isConnected ? "bg-success text-success" : "bg-danger text-danger"
          )}
          title={isConnected ? "Connected" : "Offline"}
        />

        {/* Minimize */}
        <button
          onClick={handleMinimize}
          className="inline-flex items-center justify-center w-12 h-full hover:bg-surface-hover transition-colors text-muted hover:text-foreground"
          aria-label="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" className="fill-current">
            <rect width="10" height="1" />
          </svg>
        </button>

        {/* Maximize / Restore */}
        <button
          onClick={handleToggleMaximize}
          className="inline-flex items-center justify-center w-12 h-full hover:bg-surface-hover transition-colors text-muted hover:text-foreground"
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" className="fill-none stroke-current" strokeWidth="1">
              <path d="M3 0.5h6.5v6.5" />
              <rect x="0.5" y="2.5" width="7" height="7" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" className="fill-none stroke-current" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>

        {/* Close */}
        <button
          onClick={handleClose}
          className="inline-flex items-center justify-center w-12 h-full hover:bg-danger hover:text-white transition-colors text-muted group"
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="fill-none stroke-current" strokeWidth="1.2">
            <path d="M1 1l8 8M9 1l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}
