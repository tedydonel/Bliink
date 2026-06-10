"use client";

import {
  Monitor,
  Laptop,
  Smartphone,
  Tablet,
  HelpCircle,
  Wifi,
  WifiOff,
  Check,
  ArrowUpDown,
} from "lucide-react";
import { cn } from "@/app/lib/utils";
import type { Device, DeviceStatus, DeviceType } from "@/app/lib/store";

const deviceIcons: Record<DeviceType, React.ElementType> = {
  desktop: Monitor,
  laptop: Laptop,
  phone: Smartphone,
  tablet: Tablet,
  unknown: HelpCircle,
};

const statusConfig: Record<
  DeviceStatus,
  { color: string; bg: string; label: string; icon: React.ElementType }
> = {
  online: { color: "text-success", bg: "bg-success", label: "Online", icon: Wifi },
  connected: { color: "text-accent", bg: "bg-accent", label: "Connected", icon: Check },
  transferring: {
    color: "text-sky",
    bg: "bg-sky",
    label: "Transferring",
    icon: ArrowUpDown,
  },
  offline: { color: "text-muted", bg: "bg-muted", label: "Offline", icon: WifiOff },
};

interface DeviceCardProps {
  device: Device;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onConnect?: (id: string) => void;
}

export default function DeviceCard({
  device,
  selected = false,
  onSelect,
  onConnect,
}: DeviceCardProps) {
  const DeviceIcon = deviceIcons[device.deviceType] || Monitor;
  const status = statusConfig[device.status];
  const StatusIcon = status.icon;

  return (
    <button
      onClick={() => onSelect?.(device.id)}
      onDoubleClick={() => onConnect?.(device.id)}
      className={cn(
        "flex items-center gap-4 w-full p-4 rounded-xl border transition-all duration-150 text-left group",
        selected
          ? "bg-accent-dim border-accent/30"
          : "bg-surface border-border hover:border-border-bright hover:bg-surface-hover"
      )}
    >
      {/* Device icon */}
      <div
        className={cn(
          "flex items-center justify-center w-11 h-11 rounded-lg shrink-0",
          selected ? "bg-accent/10" : "bg-surface-active"
        )}
      >
        <DeviceIcon
          className={cn(
            "w-5 h-5",
            selected ? "text-accent" : "text-muted-light"
          )}
        />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground truncate">
            {device.name}
          </span>
          {selected && (
            <Check className="w-3.5 h-3.5 text-accent shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted">{device.ip}</span>
          {device.os && (
            <>
              <span className="text-xs text-border-bright">•</span>
              <span className="text-xs text-muted">{device.os}</span>
            </>
          )}
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={cn("w-1.5 h-1.5 rounded-full", status.bg)} />
        <span className={cn("text-xs font-medium", status.color)}>
          {status.label}
        </span>
      </div>
    </button>
  );
}
