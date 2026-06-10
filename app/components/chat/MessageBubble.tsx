"use client";

import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  File,
  Mic,
} from "lucide-react";
import ProgressBar from "@/app/components/ProgressBar";
import { useAppStore, type ChatMessage } from "@/app/lib/store";
import { assetUrl } from "@/app/lib/tauri-api";
import { cn, formatBytes } from "@/app/lib/utils";

function StatusTicks({ status }: { status: string }) {
  switch (status) {
    case "sending":
      return <Clock className="w-3 h-3 text-muted" />;
    case "sent":
      return <Check className="w-3 h-3 text-muted" />;
    case "delivered":
      return <CheckCheck className="w-3 h-3 text-muted" />;
    case "read":
      return <CheckCheck className="w-3 h-3 text-accent" />;
    case "failed":
      return <AlertCircle className="w-3 h-3 text-danger" />;
    default:
      return null;
  }
}

function previewText(message: ChatMessage): string {
  if (message.text) return message.text;
  switch (message.attachmentKind) {
    case "image":
      return "📷 Photo";
    case "voice":
      return "🎤 Voice message";
    default:
      return `📎 ${message.attachmentName ?? "File"}`;
  }
}

export default function MessageBubble({
  message,
  repliedTo,
  onReply,
}: {
  message: ChatMessage;
  repliedTo?: ChatMessage;
  onReply: (message: ChatMessage) => void;
}) {
  const isOwn = message.direction === "out";
  const transfers = useAppStore((s) => s.transfers);
  const transfer = message.attachmentTransferId
    ? transfers.find((t) => t.id === message.attachmentTransferId)
    : undefined;
  const inFlight =
    message.status === "sending" || message.status === "receiving";
  const src = assetUrl(message.attachmentPath);

  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className={cn(
        "group flex items-end gap-1.5",
        isOwn ? "justify-end" : "justify-start"
      )}
    >
      {isOwn && (
        <button
          onClick={() => onReply(message)}
          className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted hover:text-foreground transition-opacity shrink-0"
          aria-label="Reply"
        >
          <CornerUpLeft className="w-3.5 h-3.5" />
        </button>
      )}

      <div
        className={cn(
          "max-w-[440px] rounded-2xl px-3.5 py-2 border",
          isOwn
            ? "bg-accent/10 border-accent/20 rounded-br-md"
            : "bg-surface border-border rounded-bl-md",
          message.status === "failed" && "border-danger/40"
        )}
      >
        {repliedTo && (
          <div className="mb-1.5 px-2.5 py-1.5 rounded-lg bg-surface-active/60 border-l-2 border-accent text-[11px] text-muted-light truncate">
            {previewText(repliedTo)}
          </div>
        )}

        {/* Attachment body */}
        {message.attachmentKind === "image" &&
          (src && !inFlight ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={message.attachmentName ?? ""}
              className="max-w-[280px] max-h-[280px] rounded-lg mb-1 object-contain"
            />
          ) : (
            <AttachmentPending
              label={message.attachmentName ?? "Photo"}
              progress={transfer?.progress}
              failed={message.status === "failed"}
            />
          ))}

        {message.attachmentKind === "voice" &&
          (src && !inFlight ? (
            <audio controls src={src} className="h-10 w-[260px]" preload="metadata" />
          ) : (
            <AttachmentPending
              label="Voice message"
              icon={<Mic className="w-4 h-4 text-muted-light shrink-0" />}
              progress={transfer?.progress}
              failed={message.status === "failed"}
            />
          ))}

        {message.attachmentKind === "file" && (
          <div className="flex items-center gap-2.5 min-w-[180px]">
            <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-surface-active shrink-0">
              <File className="w-4 h-4 text-muted-light" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-foreground truncate">
                {message.attachmentName}
              </p>
              <p className="text-[10px] text-muted">
                {message.attachmentSize ? formatBytes(message.attachmentSize) : ""}
              </p>
              {inFlight && transfer && (
                <div className="mt-1">
                  <ProgressBar progress={transfer.progress} size="sm" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Text body */}
        {message.text && (
          <p className="text-[13px] text-foreground whitespace-pre-wrap break-words">
            {message.text}
          </p>
        )}

        <div
          className={cn(
            "flex items-center gap-1 mt-0.5",
            isOwn ? "justify-end" : "justify-start"
          )}
        >
          <span className="text-[10px] text-muted">{time}</span>
          {isOwn && <StatusTicks status={message.status} />}
          {message.status === "failed" && (
            <span className="text-[10px] text-danger">failed</span>
          )}
        </div>
      </div>

      {!isOwn && (
        <button
          onClick={() => onReply(message)}
          className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted hover:text-foreground transition-opacity shrink-0"
          aria-label="Reply"
        >
          <CornerUpLeft className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function AttachmentPending({
  label,
  icon,
  progress,
  failed,
}: {
  label: string;
  icon?: React.ReactNode;
  progress?: number;
  failed?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 min-w-[200px] py-1">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-muted-light truncate">{label}</p>
        {failed ? (
          <p className="text-[10px] text-danger mt-0.5">Transfer failed</p>
        ) : (
          <div className="mt-1">
            <ProgressBar progress={progress ?? 0} size="sm" />
          </div>
        )}
      </div>
    </div>
  );
}
