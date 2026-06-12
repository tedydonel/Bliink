import type {
  Device,
  HistoryEntry,
  TransferItem,
  TransferRequest,
  ChatMessage,
  Conversation,
  AppSettings,
} from "./store";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type ListenFn = (
  event: string,
  handler: (event: { payload: unknown }) => void
) => Promise<() => void>;

let invoke: InvokeFn | null = null;
let listen: ListenFn | null = null;
let convertSrc: ((path: string) => string) | null = null;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

async function ensureTauri(): Promise<boolean> {
  if (invoke && listen) return true;
  if (!isTauriEnv()) return false;

  try {
    const core = await import("@tauri-apps/api/core");
    const { listen: lis } = await import("@tauri-apps/api/event");
    invoke = core.invoke as InvokeFn;
    convertSrc = core.convertFileSrc;
    listen = lis as ListenFn;
    return true;
  } catch {
    return false;
  }
}

// Warm up eagerly so sync helpers (assetUrl) work as early as possible
if (typeof window !== "undefined") {
  void ensureTauri();
}

/** Local file path → URL the webview is allowed to load (asset protocol). */
export function assetUrl(path?: string | null): string | null {
  if (!path || !convertSrc) return null;
  return convertSrc(path);
}

// ─── Discovery ──────────────────────────────────────────────────

export async function startDiscovery(): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("start_discovery");
}

export async function stopDiscovery(): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("stop_discovery");
}

export async function getDevices(): Promise<Device[]> {
  if (!(await ensureTauri())) return [];
  return (await invoke!("get_devices")) as Device[];
}

export async function addManualDevice(
  host: string,
  port: number
): Promise<Device> {
  if (!(await ensureTauri())) throw new Error("Not available in browser");
  return (await invoke!("add_manual_device", { host, port })) as Device;
}

export async function addInternetDevice(nodeId: string): Promise<Device> {
  if (!(await ensureTauri())) throw new Error("Not available in browser");
  return (await invoke!("add_internet_device", { nodeId })) as Device;
}

export async function removeManualDevice(deviceId: string): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("remove_manual_device", { deviceId });
}

export interface NetworkInfo {
  ip: string;
  chatPort: number;
  transferPort: number;
  bliinkId?: string | null;
}

export async function getNetworkInfo(): Promise<NetworkInfo | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("get_network_info")) as NetworkInfo;
}

export async function getAppVersion(): Promise<string> {
  if (!(await ensureTauri())) return "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function onDevicesUpdated(
  handler: (devices: Device[]) => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("devices-updated", (event) => {
    handler(event.payload as Device[]);
  });
}

// ─── Transfer ───────────────────────────────────────────────────

export async function sendFile(
  filePath: string,
  deviceIp: string,
  devicePort: number,
  deviceId: string,
  deviceName: string
): Promise<string> {
  if (!(await ensureTauri())) {
    console.log("Mock send file:", filePath, "to", deviceIp);
    return "mock-transfer-id";
  }

  return (await invoke!("send_file", {
    filePath,
    deviceIp,
    devicePort,
    deviceId,
    deviceName,
  })) as string;
}

export async function pauseTransfer(id: string): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("pause_transfer", { id });
}

export async function resumeTransfer(id: string): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("resume_transfer", { id });
}

export async function cancelTransfer(id: string): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("cancel_transfer", { id });
}

export async function getActiveTransfers(): Promise<TransferItem[]> {
  if (!(await ensureTauri())) return [];
  return (await invoke!("get_active_transfers")) as TransferItem[];
}

export interface TransferProgress {
  id: string;
  progress: number;
  speed: number;
  status: string;
  error: string | null;
}

export async function onTransferProgress(
  handler: (progress: TransferProgress) => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("transfer-progress", (event) => {
    handler(event.payload as TransferProgress);
  });
}

export async function onTransferRequest(
  handler: (request: TransferRequest) => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("transfer-request", (event) => {
    handler(event.payload as TransferRequest);
  });
}

export async function respondToTransfer(
  id: string,
  accept: boolean
): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("respond_to_transfer", { id, accept });
}

export interface TransferCodeEvent {
  id: string;
  code: string;
}

export async function onTransferCode(
  handler: (event: TransferCodeEvent) => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("transfer-code", (event) => {
    handler(event.payload as TransferCodeEvent);
  });
}

export async function sendFiles(
  paths: string[],
  deviceIp: string,
  devicePort: number,
  deviceId: string,
  deviceName: string
): Promise<number> {
  if (!(await ensureTauri())) return 0;
  return (await invoke!("send_files", {
    paths,
    deviceIp,
    devicePort,
    deviceId,
    deviceName,
  })) as number;
}

export async function sendFolder(
  folderPath: string,
  deviceIp: string,
  devicePort: number,
  deviceId: string,
  deviceName: string
): Promise<number> {
  if (!(await ensureTauri())) return 0;
  return (await invoke!("send_folder", {
    folderPath,
    deviceIp,
    devicePort,
    deviceId,
    deviceName,
  })) as number;
}

export async function openFolderDialog(): Promise<string | null> {
  if (!(await ensureTauri())) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  } catch (e) {
    console.error("Failed to open folder dialog:", e);
    return null;
  }
}

// ─── History ────────────────────────────────────────────────────

export async function getHistory(
  limit: number,
  offset: number,
  search?: string,
  direction?: string,
  status?: string
): Promise<HistoryEntry[]> {
  if (!(await ensureTauri())) return [];
  return (await invoke!("get_history", {
    limit,
    offset,
    search: search || null,
    direction: direction || null,
    status: status || null,
  })) as HistoryEntry[];
}

export async function getHistoryCount(): Promise<number> {
  if (!(await ensureTauri())) return 0;
  return (await invoke!("get_history_count")) as number;
}

export async function clearHistory(): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("clear_history");
}

// ─── Settings ───────────────────────────────────────────────────

export async function getSettings(): Promise<AppSettings | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("get_settings")) as AppSettings;
}

export async function updateSettings(settings: AppSettings): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("update_settings", { updates: settings });
}

// ─── File Utilities ─────────────────────────────────────────────

export interface FileMetadata {
  size: number;
  is_dir: boolean;
  is_file: boolean;
}

export async function getFileMetadata(path: string): Promise<FileMetadata | null> {
  if (!(await ensureTauri())) return null;
  try {
    return (await invoke!("get_file_metadata", { path })) as FileMetadata;
  } catch {
    return null;
  }
}

export async function openFileDialog(): Promise<{ name: string; path: string; size: number }[]> {
  if (!(await ensureTauri())) return [];

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      directory: false,
    });

    if (!selected) return [];

    const files = Array.isArray(selected) ? selected : [selected];
    const results: { name: string; path: string; size: number }[] = [];

    for (const filePath of files) {
      const name = filePath.split(/[\\/]/).pop() || filePath;
      let size = 0;

      const metadata = await getFileMetadata(filePath);
      if (metadata) {
        size = metadata.size;
      }

      results.push({ name, path: filePath, size });
    }

    return results;
  } catch (e) {
    console.error("Failed to open file dialog:", e);
    return [];
  }
}

// ─── Chat ───────────────────────────────────────────────────────

export async function getConversations(): Promise<Conversation[]> {
  if (!(await ensureTauri())) return [];
  return (await invoke!("get_conversations")) as Conversation[];
}

export async function getChatMessages(
  deviceId: string,
  limit = 200
): Promise<ChatMessage[]> {
  if (!(await ensureTauri())) return [];
  return (await invoke!("get_chat_messages", { deviceId, limit })) as ChatMessage[];
}

export async function sendChatMessage(
  deviceId: string,
  text: string,
  replyTo?: string | null
): Promise<ChatMessage | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("send_chat_message", {
    deviceId,
    text,
    replyTo: replyTo ?? null,
  })) as ChatMessage;
}

export async function sendChatAttachment(
  deviceId: string,
  filePath: string,
  replyTo?: string | null
): Promise<ChatMessage | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("send_chat_attachment", {
    deviceId,
    filePath,
    replyTo: replyTo ?? null,
  })) as ChatMessage;
}

export async function sendVoiceNote(
  deviceId: string,
  base64Data: string
): Promise<ChatMessage | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("send_voice_note", {
    deviceId,
    data: base64Data,
  })) as ChatMessage;
}

export async function markConversationRead(deviceId: string): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("mark_conversation_read", { deviceId });
}

export async function setTyping(deviceId: string, typing: boolean): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("set_typing", { deviceId, typing });
}

export async function onChatMessage(
  handler: (message: ChatMessage) => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("chat-message", (event) => {
    handler(event.payload as ChatMessage);
  });
}

export async function onChatTyping(
  handler: (event: { deviceId: string; typing: boolean }) => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("chat-typing", (event) => {
    handler(event.payload as { deviceId: string; typing: boolean });
  });
}

export async function onChatConversations(
  handler: () => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("chat-conversations", () => handler());
}

// ─── Web Access ─────────────────────────────────────────────────

export interface WebServerStatus {
  running: boolean;
  url: string;
  code: string;
  port: number;
  clients: { name: string; online: boolean }[];
}

export async function startWebServer(): Promise<WebServerStatus | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("start_web_server")) as WebServerStatus;
}

export async function stopWebServer(): Promise<WebServerStatus | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("stop_web_server")) as WebServerStatus;
}

export async function getWebServerStatus(): Promise<WebServerStatus | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("get_web_server_status")) as WebServerStatus;
}

// ─── Calls (signaling rides the chat channel) ───────────────────

export async function sendCallSignal(
  deviceId: string,
  payload: unknown
): Promise<void> {
  if (!(await ensureTauri())) return;
  await invoke!("send_call_signal", { deviceId, payload });
}

export async function onCallSignal(
  handler: (event: { deviceId: string; payload: unknown }) => void
): Promise<() => void> {
  if (!(await ensureTauri())) return () => {};
  return listen!("call-signal", (event) => {
    handler(event.payload as { deviceId: string; payload: unknown });
  });
}

// ─── Thumbnails ─────────────────────────────────────────────────

const thumbCache = new Map<string, string | null>();

/** Thumbnail data URL for a local file, cached per path. Null = no preview. */
export async function getThumbnail(path: string): Promise<string | null> {
  if (thumbCache.has(path)) return thumbCache.get(path)!;
  if (!(await ensureTauri())) return null;
  try {
    const result = (await invoke!("get_thumbnail", { path })) as string | null;
    thumbCache.set(path, result);
    return result;
  } catch {
    thumbCache.set(path, null);
    return null;
  }
}

// ─── Device Info ────────────────────────────────────────────────

export async function getDeviceInfo(): Promise<{
  id: string;
  name: string;
  os: string;
  arch: string;
} | null> {
  if (!(await ensureTauri())) return null;
  return (await invoke!("get_device_info")) as {
    id: string;
    name: string;
    os: string;
    arch: string;
  };
}
