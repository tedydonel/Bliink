"use client";

import {
  File,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  Folder,
  Pause,
  Play,
  X,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import ProgressBar from "./ProgressBar";
import { cn, formatBytes, formatSpeed } from "@/app/lib/utils";
import type { TransferItem as TransferItemType } from "@/app/lib/store";

const fileIcons: Record<string, React.ElementType> = {
  image: ImageIcon,
  video: Film,
  music: Music,
  "file-text": FileText,
  archive: Archive,
  folder: Folder,
  file: File,
};

function getFileIconComponent(fileType: string): React.ElementType {
  if (fileType.startsWith("image/")) return ImageIcon;
  if (fileType.startsWith("video/")) return Film;
  if (fileType.startsWith("audio/")) return Music;
  if (fileType.includes("pdf") || fileType.startsWith("text/")) return FileText;
  if (fileType.includes("zip") || fileType.includes("rar") || fileType.includes("tar"))
    return Archive;
  if (fileType.includes("folder")) return Folder;
  return File;
}

interface TransferItemProps {
  transfer: TransferItemType;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onCancel?: (id: string) => void;
}

export default function TransferItemCard({
  transfer,
  onPause,
  onResume,
  onCancel,
}: TransferItemProps) {
  const FileIcon = getFileIconComponent(transfer.fileType);
  const isActive =
    transfer.status === "transferring" || transfer.status === "pending";
  const isPaused = transfer.status === "paused";
  const isDone = transfer.status === "completed";
  const isFailed = transfer.status === "failed";

  return (
    <div
      className={cn(
        "flex items-center gap-4 p-4 rounded-xl border transition-all duration-150",
        isDone
          ? "bg-success-dim border-success/20"
          : isFailed
          ? "bg-danger-dim border-danger/20"
          : "bg-surface border-border"
      )}
    >
      {/* File icon */}
      <div
        className={cn(
          "flex items-center justify-center w-10 h-10 rounded-lg shrink-0",
          isDone
            ? "bg-success/10"
            : isFailed
            ? "bg-danger/10"
            : "bg-surface-active"
        )}
      >
        <FileIcon
          className={cn(
            "w-5 h-5",
            isDone
              ? "text-success"
              : isFailed
              ? "text-danger"
              : "text-muted-light"
          )}
        />
      </div>

      {/* Info + progress */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {transfer.direction === "upload" ? (
            <ArrowUp className="w-3 h-3 text-accent shrink-0" />
          ) : (
            <ArrowDown className="w-3 h-3 text-sky shrink-0" />
          )}
          <span className="text-sm font-medium text-foreground truncate">
            {transfer.fileName}
          </span>
        </div>

        <div className="flex items-center gap-3 mt-1">
          <span className="text-xs text-muted">{formatBytes(transfer.fileSize)}</span>
          <span className="text-xs text-border-bright">→</span>
          <span className="text-xs text-muted">{transfer.deviceName}</span>
          {isActive && transfer.speed > 0 && (
            <>
              <span className="text-xs text-border-bright">•</span>
              <span className="text-xs text-sky font-mono">
                {formatSpeed(transfer.speed)}
              </span>
            </>
          )}
        </div>

        {(isActive || isPaused) && (
          <div className="mt-2">
            <ProgressBar
              progress={transfer.progress}
              variant={isPaused ? "sky" : transfer.direction === "upload" ? "accent" : "sky"}
              showLabel
            />
          </div>
        )}

        {transfer.status === "pending" && transfer.verificationCode && (
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[11px] text-muted">
              Verification code (waiting for receiver)
            </span>
            <span className="text-[12px] font-mono font-bold tracking-widest text-accent">
              {transfer.verificationCode}
            </span>
          </div>
        )}
      </div>

      {/* Status / Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {isDone && <CheckCircle2 className="w-5 h-5 text-success" />}
        {isFailed && <AlertCircle className="w-5 h-5 text-danger" />}

        {(isActive || isPaused) && (
          <>
            {isActive ? (
              <button
                onClick={() => onPause?.(transfer.id)}
                className="p-1.5 rounded-lg hover:bg-surface-active transition-colors"
                aria-label="Pause"
              >
                <Pause className="w-4 h-4 text-muted-light" />
              </button>
            ) : (
              <button
                onClick={() => onResume?.(transfer.id)}
                className="p-1.5 rounded-lg hover:bg-surface-active transition-colors"
                aria-label="Resume"
              >
                <Play className="w-4 h-4 text-accent" />
              </button>
            )}
            <button
              onClick={() => onCancel?.(transfer.id)}
              className="p-1.5 rounded-lg hover:bg-danger-dim transition-colors"
              aria-label="Cancel"
            >
              <X className="w-4 h-4 text-muted-light hover:text-danger" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
