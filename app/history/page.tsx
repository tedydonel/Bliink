"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Clock,
  ArrowUp,
  ArrowDown,
  File,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  Folder,
  CheckCircle2,
  XCircle,
  Filter,
  Trash2,
} from "lucide-react";
import SearchBar from "@/app/components/SearchBar";
import { useAppStore, type HistoryEntry } from "@/app/lib/store";
import { formatBytes, formatRelativeTime, cn } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

type FilterDirection = "all" | "upload" | "download";
type FilterStatus = "all" | "completed" | "failed" | "cancelled";

function getFileIconComponent(fileType: string) {
  if (fileType.startsWith("image/")) return ImageIcon;
  if (fileType.startsWith("video/")) return Film;
  if (fileType.startsWith("audio/")) return Music;
  if (fileType.includes("pdf") || fileType.startsWith("text/")) return FileText;
  if (fileType.includes("zip") || fileType.includes("rar") || fileType.includes("tar") || fileType.includes("gzip"))
    return Archive;
  if (fileType.includes("folder")) return Folder;
  return File;
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

  const filtered = useMemo(() => {
    return history.filter((entry) => {
      const matchesSearch =
        entry.fileName.toLowerCase().includes(search.toLowerCase()) ||
        entry.deviceName.toLowerCase().includes(search.toLowerCase());
      const matchesDir = dirFilter === "all" || entry.direction === dirFilter;
      const matchesStatus = statusFilter === "all" || entry.status === statusFilter;
      return matchesSearch && matchesDir && matchesStatus;
    });
  }, [history, search, dirFilter, statusFilter]);

  const grouped = useMemo(() => {
    const groups: Record<string, HistoryEntry[]> = {};
    for (const entry of filtered) {
      const date = new Date(entry.completedAt);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      let key: string;
      if (date.toDateString() === today.toDateString()) key = "Today";
      else if (date.toDateString() === yesterday.toDateString()) key = "Yesterday";
      else key = date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

      if (!groups[key]) groups[key] = [];
      groups[key].push(entry);
    }
    return groups;
  }, [filtered]);

  const handleClear = useCallback(async () => {
    await api.clearHistory();
    setHistory([]);
  }, [setHistory]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-7 pb-5 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">History</h1>
          <p className="text-[13px] text-muted mt-1">
            {history.length > 0
              ? `${filtered.length} of ${history.length} transfer${history.length !== 1 ? "s" : ""}`
              : "No transfer history yet"}
          </p>
        </div>
        {history.length > 0 && (
          <button
            onClick={handleClear}
            className="flex items-center gap-2 px-3.5 py-2 text-[12px] font-semibold text-muted-light rounded-lg border border-border hover:bg-danger-dim hover:text-danger hover:border-danger/20 transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear All
          </button>
        )}
      </div>

      {/* Search + Filters */}
      <div className="px-8 pb-4 space-y-3 shrink-0">
        <SearchBar value={search} onChange={setSearch} placeholder="Search files or devices..." />
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-muted mr-1" />
          {(["all", "upload", "download"] as FilterDirection[]).map((f) => (
            <button
              key={f}
              onClick={() => setDirFilter(f)}
              className={cn(
                "px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all",
                dirFilter === f
                  ? "bg-accent/10 text-accent border border-accent/15"
                  : "text-muted hover:text-foreground hover:bg-surface-hover border border-transparent"
              )}
            >
              {f === "all" ? "All" : f === "upload" ? "Sent" : "Received"}
            </button>
          ))}
          <span className="w-px h-4 bg-border mx-1.5" />
          {(["all", "completed", "failed", "cancelled"] as FilterStatus[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={cn(
                "px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all capitalize",
                statusFilter === f
                  ? "bg-accent/10 text-accent border border-accent/15"
                  : "text-muted hover:text-foreground hover:bg-surface-hover border border-transparent"
              )}
            >
              {f === "all" ? "All Status" : f}
            </button>
          ))}
        </div>
      </div>

      {/* History list */}
      <div className="flex-1 overflow-auto px-8 pb-6">
        {Object.entries(grouped).map(([date, entries]) => (
          <div key={date} className="mb-6 animate-fade-in">
            <h3 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">
              {date}
            </h3>
            <div className="flex flex-col gap-1.5">
              {entries.map((entry) => {
                const FileIcon = getFileIconComponent(entry.fileType);
                return (
                  <div
                    key={entry.id}
                    className="flex items-center gap-4 px-4 py-3 rounded-xl border border-border bg-surface hover:bg-surface-hover transition-all"
                  >
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-active shrink-0">
                      <FileIcon className="w-[18px] h-[18px] text-muted-light" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {entry.direction === "upload" ? (
                          <ArrowUp className="w-3.5 h-3.5 text-accent shrink-0" />
                        ) : (
                          <ArrowDown className="w-3.5 h-3.5 text-sky shrink-0" />
                        )}
                        <span className="text-[13px] font-semibold text-foreground truncate">
                          {entry.fileName}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-muted">{formatBytes(entry.fileSize)}</span>
                        <span className="text-[11px] text-border-bright">→</span>
                        <span className="text-[11px] text-muted">{entry.deviceName}</span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <div className="flex items-center gap-1.5">
                        {entry.status === "completed" && <CheckCircle2 className="w-3.5 h-3.5 text-success" />}
                        {entry.status === "failed" && <XCircle className="w-3.5 h-3.5 text-danger" />}
                        {entry.status === "cancelled" && <XCircle className="w-3.5 h-3.5 text-warning" />}
                        <span
                          className={cn(
                            "text-[11px] font-semibold capitalize",
                            entry.status === "completed" ? "text-success" : entry.status === "failed" ? "text-danger" : "text-warning"
                          )}
                        >
                          {entry.status}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted">{formatRelativeTime(entry.completedAt)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {history.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full py-16 text-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-surface border border-border mb-4">
              <Clock className="w-7 h-7 text-muted" />
            </div>
            <p className="text-[15px] font-semibold text-foreground">No transfer history</p>
            <p className="text-[13px] text-muted mt-1.5">
              Completed transfers will be recorded here
            </p>
          </div>
        )}

        {history.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Clock className="w-8 h-8 text-muted mb-3" />
            <p className="text-[13px] font-medium text-muted-light">No results match your filters</p>
          </div>
        )}
      </div>
    </div>
  );
}
