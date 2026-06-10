"use client";

import { useState, useCallback, useEffect, useRef, type DragEvent } from "react";
import { Upload, FolderUp, FolderOpen } from "lucide-react";
import { cn } from "@/app/lib/utils";
import {
  openFileDialog,
  openFolderDialog,
  getFileMetadata,
} from "@/app/lib/tauri-api";

export interface SelectedFile {
  name: string;
  size: number;
  path: string;
  type?: string;
  isDir?: boolean;
}

interface FileDropZoneProps {
  onFilesSelected?: (files: SelectedFile[]) => void;
  className?: string;
}

export default function FileDropZone({
  onFilesSelected,
  className,
}: FileDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const isTauri = useRef(false);
  const tauriDropListening = useRef(false);
  const dragCounter = useRef(0);

  // Set up Tauri native drag-drop listener (provides real file paths)
  useEffect(() => {
    isTauri.current =
      typeof window !== "undefined" &&
      !!(window as any).__TAURI_INTERNALS__;

    if (!isTauri.current) return;

    let unlisten: (() => void) | undefined;
    let mounted = true;

    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const webview = getCurrentWebview();

        const unlistenDrag = await webview.onDragDropEvent(async (event) => {
          if (!mounted) return;
          if (event.payload.type === "enter") {
            setIsDragging(true);
          } else if (event.payload.type === "drop") {
            setIsDragging(false);
            const paths: string[] = event.payload.paths;
            if (paths.length > 0) {
              const files = await resolveFilePaths(paths);
              if (files.length > 0) {
                onFilesSelected?.(files);
              }
            }
          } else if (event.payload.type === "leave") {
            setIsDragging(false);
          }
        });

        unlisten = unlistenDrag;
        tauriDropListening.current = true;
      } catch (e) {
        console.warn("Tauri drag-drop listener not available, using browser fallback:", e);
        tauriDropListening.current = false;
      }
    })();

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [onFilesSelected]);

  // Browser drag-drop fallback (no real paths but still works for UX)
  const handleBrowserDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (tauriDropListening.current) return;
    dragCounter.current++;
    if (e.dataTransfer?.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleBrowserDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleBrowserDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (tauriDropListening.current) return;
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleBrowserDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragging(false);
      if (tauriDropListening.current) return;

      const droppedFiles = e.dataTransfer?.files;
      if (droppedFiles && droppedFiles.length > 0) {
        const mapped: SelectedFile[] = Array.from(droppedFiles).map((f) => ({
          name: f.name,
          size: f.size,
          path: (f as any).path || f.name,
          type: f.type,
        }));
        onFilesSelected?.(mapped);
      }
    },
    [onFilesSelected]
  );

  const handleClick = useCallback(async () => {
    if (isTauri.current) {
      try {
        const files = await openFileDialog();
        if (files.length > 0) {
          onFilesSelected?.(files);
        }
      } catch (e) {
        console.error("File dialog error:", e);
      }
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => {
      if (input.files && input.files.length > 0) {
        const mapped: SelectedFile[] = Array.from(input.files).map((f) => ({
          name: f.name,
          size: f.size,
          path: (f as any).path || f.name,
          type: f.type,
        }));
        onFilesSelected?.(mapped);
      }
    };
    input.click();
  }, [onFilesSelected]);

  const handleBrowseFolder = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isTauri.current) return;
      const folder = await openFolderDialog();
      if (folder) {
        const name = folder.split(/[\\/]/).pop() || folder;
        onFilesSelected?.([{ name, size: 0, path: folder, isDir: true }]);
      }
    },
    [onFilesSelected]
  );

  return (
    <div
      onDragEnter={handleBrowserDragEnter}
      onDragOver={handleBrowserDragOver}
      onDragLeave={handleBrowserDragLeave}
      onDrop={handleBrowserDrop}
      onClick={handleClick}
      className={cn(
        "flex flex-col items-center justify-center gap-3 w-full p-8 rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer text-center",
        isDragging
          ? "border-accent bg-accent-dim scale-[1.01]"
          : "border-border-bright bg-surface hover:border-muted hover:bg-surface-hover",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center w-12 h-12 rounded-xl transition-colors",
          isDragging ? "bg-accent/20" : "bg-surface-active"
        )}
      >
        {isDragging ? (
          <FolderUp className="w-6 h-6 text-accent" />
        ) : (
          <Upload className="w-6 h-6 text-muted" />
        )}
      </div>
      <div>
        <p
          className={cn(
            "text-sm font-medium",
            isDragging ? "text-accent" : "text-foreground"
          )}
        >
          {isDragging ? "Drop files here" : "Drag & drop files or click to browse"}
        </p>
        <p className="text-xs text-muted mt-1">
          files and folders both work
        </p>
      </div>
      <button
        onClick={handleBrowseFolder}
        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-muted-light rounded-lg border border-border hover:bg-surface-hover hover:text-foreground transition-colors"
      >
        <FolderOpen className="w-3.5 h-3.5" />
        Select a folder
      </button>
    </div>
  );
}

async function resolveFilePaths(paths: string[]): Promise<SelectedFile[]> {
  const results: SelectedFile[] = [];
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() || p;
    let size = 0;
    let isDir = false;
    try {
      const meta = await getFileMetadata(p);
      if (meta) {
        size = meta.size;
        isDir = meta.is_dir;
      }
    } catch {
      // continue with size 0
    }
    results.push({ name, size, path: p, isDir });
  }
  return results;
}
