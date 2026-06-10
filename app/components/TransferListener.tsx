"use client";

import { useEffect } from "react";
import { useAppStore, type TransferStatus } from "@/app/lib/store";
import * as api from "@/app/lib/tauri-api";

/**
 * Global listener that keeps the transfer store in sync with the backend.
 * Mounted once in the root layout so incoming downloads show up regardless
 * of which page is open.
 */
export default function TransferListener() {
  const upsertTransfer = useAppStore((s) => s.upsertTransfer);
  const updateTransfer = useAppStore((s) => s.updateTransfer);
  const addIncomingRequest = useAppStore((s) => s.addIncomingRequest);
  const removeIncomingRequest = useAppStore((s) => s.removeIncomingRequest);

  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__)
      return;

    let unlistenProgress: (() => void) | undefined;
    let unlistenRequest: (() => void) | undefined;
    let unlistenCode: (() => void) | undefined;
    let disposed = false;

    const syncActive = async () => {
      const active = await api.getActiveTransfers();
      if (!disposed) active.forEach(upsertTransfer);
    };

    const init = async () => {
      await syncActive();

      unlistenRequest = await api.onTransferRequest((request) => {
        addIncomingRequest(request);
      });

      unlistenCode = await api.onTransferCode((event) => {
        updateTransfer(event.id, { verificationCode: event.code });
      });

      unlistenProgress = await api.onTransferProgress(async (progress) => {
        // An unknown id means a transfer started on the backend (incoming
        // download) — pull the full item so it appears in the UI.
        const known = useAppStore
          .getState()
          .transfers.some((t) => t.id === progress.id);
        if (!known) await syncActive();

        // A terminal status resolves any pending prompt for this transfer
        // (e.g. the backend declined it after the decision timeout).
        if (
          progress.status === "completed" ||
          progress.status === "failed" ||
          progress.status === "cancelled"
        ) {
          removeIncomingRequest(progress.id);
        }

        updateTransfer(progress.id, {
          progress: progress.progress,
          speed: progress.speed,
          status: progress.status as TransferStatus,
          error: progress.error ?? undefined,
        });
      });
    };
    init();

    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenRequest?.();
      unlistenCode?.();
    };
  }, [upsertTransfer, updateTransfer, addIncomingRequest, removeIncomingRequest]);

  return null;
}
