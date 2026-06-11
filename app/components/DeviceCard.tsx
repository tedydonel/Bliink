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
  Globe,
  AlertTriangle,
  X,
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
  onRemove?: (id: string) => void;
}

export default function DeviceCard({
  device,
  selected = false,
  onSelect,
  onConnect,
  onRemove,
}: DeviceCardProps) {
  const DeviceIcon = deviceIcons[device.deviceType] || Monitor;
  const status = statusConfig[device.status];
  const StatusIcon = status.icon;
  const incompatible = device.compatible === false;

  return (
    <button
      onClick={() => !incompatible && onSelect?.(device.id)}
      onDoubleClick={() => !incompatible && onConnect?.(device.id)}
      className={cn(
        "flex items-center gap-4 w-full p-4 rounded-xl border transition-all duration-150 text-left group",
        incompatible
          ? "bg-surface border-border opacity-60 cursor-not-allowed"
          : selected
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
          {device.manual && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sky/10 border border-sky/20 text-sky text-[10px] font-semibold shrink-0"
              title="Added by address"
            >
              <Globe className="w-2.5 h-2.5" />
              Remote
            </span>
          )}
          {selected && !incompatible && (
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
      {incompatible ? (
        <div className="flex items-center gap-1.5 shrink-0" title="This device runs a different Bliink version — update both devices">
          <AlertTriangle className="w-3.5 h-3.5 text-warning" />
          <span className="text-xs font-medium text-warning">Update required</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={cn("w-1.5 h-1.5 rounded-full", status.bg)} />
          <span className={cn("text-xs font-medium", status.color)}>
            {status.label}
          </span>
        </div>
      )}

      {/* Remove (manual devices only) */}
      {device.manual && onRemove && (
        <span
          role="button"
          aria-label="Remove device"
          title="Remove this device"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(device.id);
          }}
          className="p-1.5 rounded-lg text-muted opacity-0 group-hover:opacity-100 hover:bg-danger-dim hover:text-danger transition-all shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </span>
      )}
    </button>
  );
}
