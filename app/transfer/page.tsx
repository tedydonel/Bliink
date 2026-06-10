"use client";

import { useState, useCallback } from "react";
import { Inbox, Upload, X, Monitor, CheckCircle2, AlertCircle } from "lucide-react";
import { useAppStore } from "@/app/lib/store";
import TransferItemCard from "@/app/components/TransferItem";
import FileDropZone, { type SelectedFile } from "@/app/components/FileDropZone";
import { formatBytes } from "@/app/lib/utils";
import { cn } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

export default function TransferPage() {
  const {
    transfers,
    updateTransfer,
    upsertTransfer,
    devices,
    selectedDeviceIds,
    toggleDeviceSelection,
  } = useAppStore();

  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);

  const onlineDevices = devices.filter((d) => d.status !== "offline");

  const active = transfers.filter(
    (t) =>
      t.status === "transferring" ||
      t.status === "pending" ||
      t.status === "paused"
  );
  const completed = transfers.filter(
    (t) =>
      t.status === "completed" ||
      t.status === "failed" ||
      t.status === "cancelled"
  );

  const handleFilesSelected = useCallback((files: SelectedFile[]) => {
    setSelectedFiles((prev) => [...prev, ...files]);
    setSendError(null);
  }, []);

  const handlePause = useCallback(
    async (id: string) => {
      await api.pauseTransfer(id);
      updateTransfer(id, { status: "paused", speed: 0 });
    },
    [updateTransfer]
  );

  const handleResume = useCallback(
    async (id: string) => {
      await api.resumeTransfer(id);
      updateTransfer(id, { status: "transferring" });
    },
    [updateTransfer]
  );

  const handleCancel = useCallback(
    async (id: string) => {
      await api.cancelTransfer(id);
      updateTransfer(id, { status: "cancelled", speed: 0 });
    },
    [updateTransfer]
  );

  const handleStartTransfer = useCallback(async () => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__)
      return;

    setSendError(null);

    const targetDevices = devices.filter((d) =>
      selectedDeviceIds.includes(d.id)
    );

    if (selectedFiles.length === 0) {
      setSendError("No files selected. Drop files or click to browse.");
      return;
    }
    if (targetDevices.length === 0) {
      setSendError("No target device selected. Pick a device below.");
      return;
    }

    for (const file of selectedFiles) {
      if (!file.path) continue;
      for (const device of targetDevices) {
        try {
          if (file.isDir) {
            // Folder batch — individual transfers appear via the global
            // listener as each file starts
            await api.sendFolder(
              file.path,
              device.ip,
              device.port,
              device.id,
              device.name
            );
          } else {
            const transferId = await api.sendFile(
              file.path,
              device.ip,
              device.port,
              device.id,
              device.name
            );
            upsertTransfer({
              id: transferId,
              fileName: file.name,
              fileSize: file.size,
              fileType: file.type || "application/octet-stream",
              progress: 0,
              speed: 0,
              status: "pending",
              direction: "upload",
              deviceId: device.id,
              deviceName: device.name,
              startedAt: Date.now(),
            });
          }
        } catch (e: any) {
          console.error("Send error:", e);
          setSendError(`Failed to send ${file.name}: ${e?.message || e}`);
        }
      }
    }
    setSelectedFiles([]);
  }, [devices, selectedDeviceIds, selectedFiles, upsertTransfer]);

  const totalSelectedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-7 pb-5 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Transfer</h1>
          <p className="text-[13px] text-muted mt-1">
            Send and receive files securely across your devices
          </p>
        </div>
        {selectedFiles.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-muted-light font-medium">
              {selectedFiles.length} file{selectedFiles.length > 1 ? "s" : ""} · {formatBytes(totalSelectedSize)}
            </span>
            <button
              onClick={handleStartTransfer}
              className="flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-semibold rounded-lg bg-accent text-background hover:bg-accent-hover transition-all shadow-[0_0_20px_rgba(56,189,248,0.15)]"
            >
              <Upload className="w-4 h-4" />
              Start Transfer
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-8 py-4 space-y-6">
        {/* Error feedback */}
        {sendError && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[13px] animate-fade-in">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} className="ml-auto hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Drop zone */}
        <FileDropZone onFilesSelected={handleFilesSelected} />

        {/* Selected files */}
        {selectedFiles.length > 0 && (
          <div className="animate-fade-in">
            <h2 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">
              Queued Files — {selectedFiles.length}
            </h2>
            <div className="flex flex-wrap gap-2">
              {selectedFiles.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface border border-border text-[12px] group"
                >
                  <span className="text-foreground font-medium truncate max-w-[200px]">
                    {file.name}
                  </span>
                  <span className="text-muted text-[10px]">
                    {file.isDir ? "Folder" : formatBytes(file.size)}
                  </span>
                  <button
                    onClick={() => setSelectedFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted hover:text-danger transition-colors ml-1"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Inline device selector */}
        {selectedFiles.length > 0 && (
          <div className="animate-fade-in">
            <h2 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">
              Send To
            </h2>
            {onlineDevices.length === 0 ? (
              <p className="text-[13px] text-muted">
                No devices found. Go to{" "}
                <span className="text-accent font-semibold">Devices</span> and scan your
                network first.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {onlineDevices.map((device) => {
                  const selected = selectedDeviceIds.includes(device.id);
                  return (
                    <button
                      key={device.id}
                      onClick={() => toggleDeviceSelection(device.id)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] transition-all",
                        selected
                          ? "bg-accent/10 border-accent/40 text-accent"
                          : "bg-surface border-border text-muted hover:border-muted hover:text-foreground"
                      )}
                    >
                      {selected ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <Monitor className="w-3.5 h-3.5" />
                      )}
                      <span className="font-medium">{device.name}</span>
                      <span className="text-[10px] opacity-60">{device.ip}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Active transfers */}
        {active.length > 0 && (
          <div className="animate-fade-in">
            <h2 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">
              Active — {active.length}
            </h2>
            <div className="flex flex-col gap-2">
              {active.map((transfer, i) => (
                <div key={transfer.id} className="animate-fade-in" style={{ animationDelay: `${i * 40}ms` }}>
                  <TransferItemCard
                    transfer={transfer}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completed */}
        {completed.length > 0 && (
          <div className="animate-fade-in">
            <h2 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">
              Completed — {completed.length}
            </h2>
            <div className="flex flex-col gap-2">
              {completed.map((transfer) => (
                <TransferItemCard key={transfer.id} transfer={transfer} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {transfers.length === 0 && selectedFiles.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-surface border border-border mb-4">
              <Inbox className="w-7 h-7 text-muted" />
            </div>
            <p className="text-[15px] font-semibold text-foreground">No active transfers</p>
            <p className="text-[13px] text-muted mt-1.5 max-w-[280px]">
              Drop files above or click to browse, then pick a target device.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
