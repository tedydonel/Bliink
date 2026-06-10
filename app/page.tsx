"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { RefreshCw, Send, Radar, Monitor, Wifi } from "lucide-react";
import { useAppStore } from "@/app/lib/store";
import DeviceCard from "@/app/components/DeviceCard";
import SearchBar from "@/app/components/SearchBar";
import { cn } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

export default function DevicesPage() {
  const {
    devices,
    selectedDeviceIds,
    isScanning,
    toggleDeviceSelection,
    clearDeviceSelection,
    setDevices,
    setIsScanning,
  } = useAppStore();
  const [search, setSearch] = useState("");
  const isTauri = useRef(false);

  useEffect(() => {
    isTauri.current =
      typeof window !== "undefined" &&
      !!(window as any).__TAURI_INTERNALS__;

    if (!isTauri.current) return;

    let unlistenDevices: (() => void) | undefined;

    const init = async () => {
      // Auto-start discovery on mount
      try {
        await api.startDiscovery();
      } catch (e) {
        console.warn("Auto-discovery start failed:", e);
      }

      const devs = await api.getDevices();
      if (devs.length > 0) setDevices(devs);

      unlistenDevices = await api.onDevicesUpdated((updatedDevices) => {
        setDevices(updatedDevices);
      });
    };
    init();

    return () => {
      unlistenDevices?.();
    };
  }, [setDevices]);

  const handleScan = useCallback(async () => {
    setIsScanning(true);
    if (isTauri.current) {
      try {
        await api.startDiscovery();
        // Keep scanning state for a few seconds to allow discovery packets
        setTimeout(async () => {
          const devs = await api.getDevices();
          setDevices(devs);
          setIsScanning(false);
        }, 4000);
      } catch (e) {
        console.error("Discovery error:", e);
        setIsScanning(false);
      }
    } else {
      setTimeout(() => setIsScanning(false), 2000);
    }
  }, [setDevices, setIsScanning]);

  const filtered = devices.filter(
    (d) =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.ip.includes(search)
  );

  const online = filtered.filter((d) => d.status !== "offline");
  const offline = filtered.filter((d) => d.status === "offline");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-7 pb-5 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Devices</h1>
          <p className="text-[13px] text-muted mt-1">
            Discover and connect to nearby Bliink devices on your network
          </p>
        </div>
        <div className="flex items-center gap-3">
          {selectedDeviceIds.length > 0 && (
            <button
              onClick={clearDeviceSelection}
              className="px-3.5 py-2 text-[12px] font-semibold text-muted-light rounded-lg border border-border hover:bg-surface-hover transition-colors"
            >
              Clear ({selectedDeviceIds.length})
            </button>
          )}
          <button
            onClick={handleScan}
            disabled={isScanning}
            className={cn(
              "flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-all",
              isScanning
                ? "bg-accent/10 text-accent border border-accent/20"
                : "bg-accent text-background hover:bg-accent-hover shadow-[0_0_20px_rgba(56,189,248,0.15)]"
            )}
          >
            {isScanning ? (
              <span className="relative">
                <Radar className="w-4 h-4 animate-spin" />
              </span>
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {isScanning ? "Scanning..." : "Scan Network"}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-8 pb-4 shrink-0">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Filter devices by name or IP address..."
        />
      </div>

      {/* Device list */}
      <div className="flex-1 overflow-auto px-8 pb-6">
        {devices.length === 0 && !isScanning ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-16">
            <div className="relative mb-5">
              <div className="flex items-center justify-center w-20 h-20 rounded-2xl bg-surface border border-border">
                <Monitor className="w-8 h-8 text-muted" />
              </div>
              <div className="absolute -bottom-1 -right-1 flex items-center justify-center w-7 h-7 rounded-full bg-sky/15 border border-sky/20">
                <Wifi className="w-3.5 h-3.5 text-sky" />
              </div>
            </div>
            <p className="text-[15px] font-semibold text-foreground">
              No devices discovered yet
            </p>
            <p className="text-[13px] text-muted mt-1.5 max-w-[300px]">
              Click <span className="text-accent font-semibold">Scan Network</span> to find other devices running Bliink on your local network.
            </p>
          </div>
        ) : (
          <>
            {online.length > 0 && (
              <div className="animate-fade-in">
                <h2 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">
                  Available — {online.length}
                </h2>
                <div className="flex flex-col gap-2">
                  {online.map((device, i) => (
                    <div
                      key={device.id}
                      className="animate-fade-in"
                      style={{ animationDelay: `${i * 40}ms` }}
                    >
                      <DeviceCard
                        device={device}
                        selected={selectedDeviceIds.includes(device.id)}
                        onSelect={toggleDeviceSelection}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {offline.length > 0 && (
              <div className="mt-6 animate-fade-in">
                <h2 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">
                  Offline — {offline.length}
                </h2>
                <div className="flex flex-col gap-2 opacity-50">
                  {offline.map((device) => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      selected={selectedDeviceIds.includes(device.id)}
                      onSelect={toggleDeviceSelection}
                    />
                  ))}
                </div>
              </div>
            )}

            {filtered.length === 0 && devices.length > 0 && (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Radar className="w-8 h-8 text-muted mb-3" />
                <p className="text-[13px] font-medium text-muted-light">
                  No devices match your search
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom action bar */}
      {selectedDeviceIds.length > 0 && (
        <div className="flex items-center justify-between px-8 py-4 border-t border-border bg-surface/80 backdrop-blur-sm shrink-0 animate-fade-in">
          <span className="text-[13px] text-muted-light">
            <span className="font-bold text-accent">
              {selectedDeviceIds.length}
            </span>{" "}
            device{selectedDeviceIds.length > 1 ? "s" : ""} selected
          </span>
          <Link
            href="/transfer"
            className="flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-semibold rounded-lg bg-accent text-background hover:bg-accent-hover transition-all shadow-[0_0_20px_rgba(56,189,248,0.15)]"
          >
            <Send className="w-4 h-4" />
            Send Files
          </Link>
        </div>
      )}
    </div>
  );
}
