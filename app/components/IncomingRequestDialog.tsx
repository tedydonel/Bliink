"use client";

import { useState } from "react";
import { Download, FolderDown, ShieldCheck } from "lucide-react";
import { useAppStore, type TransferRequest } from "@/app/lib/store";
import { formatBytes, cn } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

/**
 * Modal shown when a remote device offers a file (or folder batch) and
 * auto-accept is off. Requests queue up; the oldest is shown first. The
 * backend declines automatically if the user doesn't respond in time.
 */
export default function IncomingRequestDialog() {
  const incomingRequests = useAppStore((s) => s.incomingRequests);
  const removeIncomingRequest = useAppStore((s) => s.removeIncomingRequest);

  const request = incomingRequests[0];
  if (!request) return null;

  const respond = async (accept: boolean) => {
    try {
      await api.respondToTransfer(request.id, accept);
    } catch (e) {
      console.error("Failed to respond to transfer request:", e);
    }
    removeIncomingRequest(request.id);
  };

  // Key by request id so the confirm checkbox resets for each new request
  return (
    <RequestCard
      key={request.id}
      request={request}
      pendingCount={incomingRequests.length - 1}
      onRespond={respond}
    />
  );
}

function RequestCard({
  request,
  pendingCount,
  onRespond,
}: {
  request: TransferRequest;
  pendingCount: number;
  onRespond: (accept: boolean) => void;
}) {
  const [codeConfirmed, setCodeConfirmed] = useState(false);
  const canAccept = !request.requireCodeConfirm || codeConfirmed;
  const isBatch = !!request.batchName;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-[400px] p-6 rounded-2xl bg-surface border border-border shadow-2xl">
        <div className="flex items-center gap-4 mb-5">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-accent/10 border border-accent/20 shrink-0">
            {isBatch ? (
              <FolderDown className="w-6 h-6 text-accent" />
            ) : (
              <Download className="w-6 h-6 text-accent" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-foreground">
              {isBatch ? "Incoming folder" : "Incoming file"}
            </p>
            <p className="text-[12px] text-muted mt-0.5">
              <span className="font-semibold text-muted-light">
                {request.senderName}
              </span>{" "}
              wants to send you {isBatch ? "a folder" : "a file"}
            </p>
          </div>
        </div>

        <div className="px-4 py-3 rounded-xl bg-surface-active/50 border border-border mb-4">
          {isBatch ? (
            <>
              <p className="text-[13px] font-semibold text-foreground truncate">
                {request.batchName}
              </p>
              <p className="text-[11px] text-muted mt-0.5">
                {request.batchTotalFiles ?? "?"} files
                {request.batchTotalBytes
                  ? ` · ${formatBytes(request.batchTotalBytes)}`
                  : ""}
              </p>
            </>
          ) : (
            <>
              <p className="text-[13px] font-semibold text-foreground truncate">
                {request.fileName}
              </p>
              <p className="text-[11px] text-muted mt-0.5">
                {formatBytes(request.fileSize)}
              </p>
            </>
          )}
        </div>

        {/* Verification code — matches the sender's screen unless someone
            is intercepting the connection */}
        <div className="px-4 py-3 rounded-xl bg-surface-active/30 border border-border mb-4 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <ShieldCheck className="w-3.5 h-3.5 text-muted" />
            <p className="text-[11px] text-muted">
              Code should match the sender&apos;s screen
            </p>
          </div>
          <p className="text-xl font-mono font-bold tracking-[0.25em] text-accent">
            {request.verificationCode}
          </p>
        </div>

        {request.requireCodeConfirm && (
          <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={codeConfirmed}
              onChange={(e) => setCodeConfirmed(e.target.checked)}
              className="w-4 h-4 accent-[var(--accent,#38bdf8)]"
            />
            <span className="text-[12px] text-muted-light">
              I checked — the code matches the sender&apos;s screen
            </span>
          </label>
        )}

        {pendingCount > 0 && (
          <p className="text-[11px] text-muted mb-3">
            +{pendingCount} more pending request{pendingCount > 1 ? "s" : ""}
          </p>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => onRespond(false)}
            className="flex-1 px-4 py-2.5 text-[13px] font-semibold rounded-lg border border-border text-muted-light hover:bg-surface-hover hover:text-foreground transition-colors"
          >
            Decline
          </button>
          <button
            onClick={() => onRespond(true)}
            disabled={!canAccept}
            className={cn(
              "flex-1 px-4 py-2.5 text-[13px] font-semibold rounded-lg transition-all",
              canAccept
                ? "bg-accent text-background hover:bg-accent-hover"
                : "bg-surface-active text-muted cursor-not-allowed"
            )}
          >
            Accept{isBatch ? " All" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
