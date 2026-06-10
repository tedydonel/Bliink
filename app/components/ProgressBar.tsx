"use client";

import { cn } from "@/app/lib/utils";

interface ProgressBarProps {
  progress: number;
  variant?: "accent" | "sky" | "danger" | "success";
  size?: "sm" | "md";
  showLabel?: boolean;
}

export default function ProgressBar({
  progress,
  variant = "accent",
  size = "sm",
  showLabel = false,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, progress));

  const colorMap = {
    accent: "bg-accent",
    sky: "bg-sky",
    danger: "bg-danger",
    success: "bg-success",
  };

  return (
    <div className="flex items-center gap-2 w-full">
      <div
        className={cn(
          "flex-1 rounded-full bg-surface-active overflow-hidden",
          size === "sm" ? "h-1.5" : "h-2.5"
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300 ease-out",
            colorMap[variant]
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs font-mono text-muted-light tabular-nums shrink-0">
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  );
}
