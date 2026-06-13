"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  ArrowUp,
  ArrowDown,
  File,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  Folder,
  Files,
  Check,
  X as XIcon,
  ChevronDown,
  Search,
  Trash2,
} from "lucide-react";
import { useAppStore, type HistoryEntry } from "@/app/lib/store";
import { formatBytes, formatRelativeTime, cn } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

type FilterDirection = "all" | "upload" | "download";
type FilterStatus = "all" | "completed" | "failed" | "cancelled";

type HistoryRow =
  | { kind: "single"; key: string; entry: HistoryEntry }
  | { kind: "batch"; key: string; entries: HistoryEntry[] };

function fileIcon(fileType: string) {
  if (fileType.startsWith("image/")) return ImageIcon;
  if (fileType.startsWith("video/")) return Film;
  if (fileType.startsWith("audio/")) return Music;
  if (fileType.includes("pdf") || fileType.startsWith("text/")) return FileText;
  if (fileType.includes("zip") || fileType.includes("rar") || fileType.includes("tar") || fileType.includes("gzip"))
    return Archive;
  if (fileType.includes("folder")) return Folder;
  return File;
}

function statusInfo(status: HistoryEntry["status"]) {
  if (status === "completed") return { cls: "ok", label: "completed", Icon: Check };
  if (status === "failed") return { cls: "fail", label: "failed", Icon: XIcon };
  return { cls: "warn", label: "cancelled", Icon: XIcon };
}

function clusterBatches(entries: HistoryEntry[]): HistoryRow[] {
  const groups = new Map<string, HistoryEntry[]>();
  const rows: HistoryRow[] = [];
  for (const entry of entries) {
    if (entry.batchId) {
      let group = groups.get(entry.batchId);
      if (!group) {
        group = [];
        groups.set(entry.batchId, group);
        rows.push({ kind: "batch", key: entry.batchId, entries: group });
      }
      group.push(entry);
    } else {
      rows.push({ kind: "single", key: entry.id, entry });
    }
  }
  return rows.map((row) =>
    row.kind === "batch" && row.entries.length === 1
      ? { kind: "single", key: row.entries[0].id, entry: row.entries[0] }
      : row
  );
}

export default function HistoryPage() {
  const { history, setHistory } = useAppStore();
  const [search, setSearch] = useState("");
  const [dirFilter, setDirFilter] = useState<FilterDirection>("all");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");

  useEffect(() => {
    const load = async () => {
      if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
      const entries = await api.getHistory(200, 0);
      setHistory(entries);
    };
    load();
  }, [setHistory]);

  const filtered = useMemo(
    () =>
      history.filter((entry) => {
        const q = search.toLowerCase();
        const matchesSearch =
          entry.fileName.toLowerCase().includes(q) ||
          entry.deviceName.toLowerCase().includes(q);
        const matchesDir = dirFilter === "all" || entry.direction === dirFilter;
        const matchesStatus = statusFilter === "all" || entry.status === statusFilter;
        return matchesSearch && matchesDir && matchesStatus;
      }),
    [history, search, dirFilter, statusFilter]
  );

  const grouped = useMemo(() => {
    const groups: Record<string, HistoryEntry[]> = {};
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    for (const entry of filtered) {
      const date = new Date(entry.completedAt);
      let key: string;
      if (date.toDateString() === today.toDateString()) key = "Today";
      else if (date.toDateString() === yesterday.toDateString()) key = "Yesterday";
      else key = date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      (groups[key] ??= []).push(entry);
    }
    return groups;
  }, [filtered]);

  const handleClear = useCallback(async () => {
    await api.clearHistory();
    setHistory([]);
  }, [setHistory]);

  const dirFilters: [FilterDirection, string][] = [
    ["all", "All"],
    ["upload", "Sent"],
    ["download", "Received"],
  ];
  const statusFilters: [FilterStatus, string][] = [
    ["all", "Any status"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ];

  return (
    <div className="bk-view">
      <div className="bk-view-head">
        <div>
          <div className="bk-view-title">History</div>
          <div className="bk-view-sub">
            {history.length > 0
              ? `${filtered.length} of ${history.length} transfer${history.length === 1 ? "" : "s"} · stored locally`
              : "No transfers recorded yet"}
          </div>
        </div>
        <div className="bk-head-spacer" />
        {history.length > 0 && (
          <button className="bk-btn danger" onClick={handleClear}>
            <Trash2 size={14} /> Clear all
          </button>
        )}
      </div>

      <div className="bk-filterbar">
        <div className="bk-input" style={{ flex: 1, minWidth: 180, maxWidth: 320 }}>
          <Search size={15} />
          <input
            placeholder="Search files or devices…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="bk-filter-group">
          {dirFilters.map(([f, label]) => (
            <button
              key={f}
              className={cn("bk-filter-btn", dirFilter === f && "active")}
              onClick={() => setDirFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="bk-filter-group">
          {statusFilters.map(([f, label]) => (
            <button
              key={f}
              className={cn("bk-filter-btn", statusFilter === f && "active")}
              onClick={() => setStatusFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="bk-scroll" style={{ paddingTop: 0 }}>
        {history.length === 0 ? (
          <div className="bk-empty" style={{ padding: "60px 20px" }}>
            <Files size={34} />
            <h3>No transfer history</h3>
            <p>Completed transfers are recorded here — searchable and grouped by day.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bk-empty" style={{ padding: "60px 20px" }}>
            <Search size={30} />
            <h3>No matches</h3>
            <p>No transfers match your search and filters.</p>
          </div>
        ) : (
          Object.entries(grouped).map(([date, entries]) => (
            <div key={date} className="bk-hist-group">
              <div className="bk-section-label">{date}</div>
              <div className="bk-hist-list">
                {clusterBatches(entries).map((row) =>
                  row.kind === "single" ? (
                    <HistoryRowItem key={row.key} entry={row.entry} />
                  ) : (
                    <HistoryBatchItem key={row.key} entries={row.entries} />
                  )
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Thumb({ entry, fallback }: { entry: HistoryEntry; fallback?: React.ReactNode }) {
  const Icon = fileIcon(entry.fileType);
  return (
    <div className="bk-hist-thumb">
      {entry.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.thumbnail} alt="" />
      ) : (
        fallback ?? <Icon size={18} />
      )}
    </div>
  );
}

function StatusTag({ status }: { status: HistoryEntry["status"] }) {
  const { cls, label, Icon } = statusInfo(status);
  return (
    <span className={cn("bk-hist-status", cls)}>
      <Icon size={12} /> {label}
    </span>
  );
}

function HistoryRowItem({ entry }: { entry: HistoryEntry }) {
  return (
    <div className="bk-hist-row">
      <Thumb entry={entry} />
      <div className="bk-hist-main">
        <div className="bk-hist-name">
          <span className={cn("bk-hist-dir", entry.direction === "upload" && "up")}>
            {entry.direction === "upload" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
          </span>
          <span className="nm">{entry.fileName}</span>
        </div>
        <div className="bk-hist-sub">
          <span>{formatBytes(entry.fileSize)}</span>
          <span className="dot">·</span>
          <span>{entry.direction === "upload" ? "to" : "from"} {entry.deviceName}</span>
        </div>
      </div>
      <div className="bk-hist-right">
        <StatusTag status={entry.status} />
        <span className="bk-hist-when">{formatRelativeTime(entry.completedAt)}</span>
      </div>
    </div>
  );
}

function HistoryBatchItem({ entries }: { entries: HistoryEntry[] }) {
  const [open, setOpen] = useState(false);
  const first = entries[0];
  const totalBytes = entries.reduce((acc, e) => acc + e.fileSize, 0);
  const failed = entries.filter((e) => e.status !== "completed").length;
  const overall: HistoryEntry["status"] = failed === entries.length ? "failed" : "completed";
  const name = first.batchName ?? `${entries.length} files`;
  const isFolder = !!first.batchName;
  const thumbEntry = entries.find((e) => e.thumbnail);

  return (
    <div>
      <div className="bk-hist-row" style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <Thumb
          entry={thumbEntry ?? first}
          fallback={isFolder ? <Folder size={18} /> : <Files size={18} />}
        />
        <div className="bk-hist-main">
          <div className="bk-hist-name">
            <span className={cn("bk-hist-dir", first.direction === "upload" && "up")}>
              {first.direction === "upload" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
            </span>
            <span className="nm">{name}</span>
          </div>
          <div className="bk-hist-sub">
            <span>{entries.length} files</span>
            <span className="dot">·</span>
            <span>{formatBytes(totalBytes)}</span>
            <span className="dot">·</span>
            <span>{first.direction === "upload" ? "to" : "from"} {first.deviceName}</span>
            {failed > 0 && failed < entries.length && (
              <span style={{ color: "var(--danger)" }}>· {failed} failed</span>
            )}
          </div>
        </div>
        <div className="bk-hist-right">
          <StatusTag status={overall} />
          <span className="bk-hist-when">{formatRelativeTime(first.completedAt)}</span>
        </div>
        <span className={cn("bk-hist-chevron", open && "open")}>
          <ChevronDown size={16} />
        </span>
      </div>

      {open && (
        <div className="bk-hist-children">
          {entries.map((entry) => (
            <HistoryRowItem key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
