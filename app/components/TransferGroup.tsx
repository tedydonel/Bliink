"use client";

import { useState } from "react";
import { ChevronDown, Files, Folder, X } from "lucide-react";
import ProgressBar from "./ProgressBar";
import TransferItemCard from "./TransferItem";
import { cn, formatBytes } from "@/app/lib/utils";
import type { TransferItem } from "@/app/lib/store";

const ACTIVE_STATUSES = ["pending", "transferring", "paused"];

/**
 * Collapsible card for a batch of transfers (folder send or multi-file
 * selection). Click the header to expand into the individual files.
 */
export default function TransferGroupCard({
  items,
  onPause,
  onResume,
  onCancel,
}: {
  items: TransferItem[];
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onCancel?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const first = items[0];
  const totalFiles = first.batchTotalFiles ?? items.length;
  const totalBytes =
    first.batchTotalBytes ?? items.reduce((acc, t) => acc + t.fileSize, 0);
  const doneCount = items.filter((t) => t.status === "completed").length;
  const failedCount = items.filter(
    (t) => t.status === "failed" || t.status === "cancelled"
  ).length;
  const anyActive = items.some((t) => ACTIVE_STATUSES.includes(t.status));
  const allDone = !anyActive && doneCount + failedCount >= totalFiles;

  // Bytes-weighted progress against the whole batch; files not yet started
  // count as zero.
  const progressedBytes = items.reduce(
    (acc, t) => acc + (t.progress / 100) * t.fileSize,
    0
  );
  const progress = totalBytes > 0 ? (progressedBytes / totalBytes) * 100 : 0;

  const name = first.batchName ?? `${totalFiles} files`;
  const thumb = items.find((t) => t.thumbnail)?.thumbnail;
  const isFolder = !!first.batchName;

  const cancelAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    items
      .filter((t) => ACTIVE_STATUSES.includes(t.status))
      .forEach((t) => onCancel?.(t.id));
  };

  return (
    <div
      className={cn(
        "rounded-xl border transition-all duration-150",
        allDone && failedCount === 0
          ? "bg-success-dim border-success/20"
          : "bg-surface border-border"
      )}
    >
      {/* Group header — click to expand/collapse */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-4 p-4 w-full text-left"
      >
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-active shrink-0 overflow-hidden">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="w-10 h-10 object-cover" />
          ) : isFolder ? (
            <Folder className="w-5 h-5 text-muted-light" />
          ) : (
            <Files className="w-5 h-5 text-muted-light" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {name}
            </span>
            <span className="text-[11px] text-muted shrink-0">
              {doneCount}/{totalFiles} files
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-muted">{formatBytes(totalBytes)}</span>
            <span className="text-xs text-border-bright">→</span>
            <span className="text-xs text-muted">{first.deviceName}</span>
            {failedCount > 0 && (
              <span className="text-xs text-danger">
                {failedCount} failed
              </span>
            )}
          </div>
          {anyActive && (
            <div className="mt-2">
              <ProgressBar progress={progress} variant="accent" showLabel />
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {anyActive && onCancel && (
            <span
              onClick={cancelAll}
              role="button"
              aria-label="Cancel all"
              className="p-1.5 rounded-lg hover:bg-danger-dim transition-colors cursor-pointer"
            >
              <X className="w-4 h-4 text-muted-light hover:text-danger" />
            </span>
          )}
          <ChevronDown
            className={cn(
              "w-4 h-4 text-muted transition-transform duration-200",
              expanded ? "rotate-180" : ""
            )}
          />
        </div>
      </button>

      {/* Expanded file list */}
      {expanded && (
        <div className="flex flex-col gap-1.5 px-4 pb-4 pl-9 animate-fade-in">
          {items.map((item) => (
            <TransferItemCard
              key={item.id}
              transfer={item}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
