import { create } from "zustand";

// ─── Device Types ───────────────────────────────────────────────
export type DeviceStatus = "online" | "connected" | "transferring" | "offline";
export type DeviceType = "desktop" | "laptop" | "phone" | "tablet" | "unknown";

export interface Device {
  id: string;
  name: string;
  ip: string;
  port: number;
  chatPort?: number;
  deviceType: DeviceType;
  status: DeviceStatus;
  os?: string;
  lastSeen: number;
  // Added by address rather than discovered
  manual?: boolean;
  // False when the peer runs an incompatible protocol version
  compatible?: boolean;
  // Bliink ID for internet peers (connected through P2P)
  nodeId?: string | null;
}

// ─── Transfer Types ─────────────────────────────────────────────
export type TransferStatus =
  | "pending"
  | "transferring"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TransferDirection = "upload" | "download";

export interface TransferItem {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  progress: number;
  speed: number;
  status: TransferStatus;
  direction: TransferDirection;
  deviceId: string;
  deviceName: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  // Short code derived from the session key — matches on both screens
  // unless someone is intercepting the connection
  verificationCode?: string | null;
  // Small JPEG preview as a data URL
  thumbnail?: string | null;
  // Set when this transfer is part of a multi-file batch
  batchId?: string | null;
  // Folder name for folder batches; null for loose-file batches
  batchName?: string | null;
  batchTotalFiles?: number | null;
  batchTotalBytes?: number | null;
  // Set when this transfer is a chat attachment (hidden from Transfer page)
  chatMessageId?: string | null;
}

// An incoming file offer awaiting the user's accept/decline decision
export interface TransferRequest {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  senderId: string;
  senderName: string;
  verificationCode: string;
  requireCodeConfirm: boolean;
  // Present when this is a folder transfer — accepting covers the batch
  batchName?: string | null;
  batchTotalFiles?: number | null;
  batchTotalBytes?: number | null;
  thumbnail?: string | null;
}

// ─── History Types ──────────────────────────────────────────────
export interface HistoryEntry {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  direction: TransferDirection;
  deviceId: string;
  deviceName: string;
  status: "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number;
  hash?: string;
  thumbnail?: string | null;
  batchId?: string | null;
  batchName?: string | null;
}

// ─── Chat Types ─────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  text?: string | null;
  attachmentKind?: string | null;
  attachmentName?: string | null;
  attachmentPath?: string | null;
  attachmentSize?: number | null;
  attachmentTransferId?: string | null;
  replyTo?: string | null;
  status: string;
  createdAt: number;
}

export interface Conversation {
  deviceId: string;
  deviceName: string;
  lastPreview?: string | null;
  lastMessageAt?: number | null;
  unreadCount: number;
  online: boolean;
}

// ─── Call Types ─────────────────────────────────────────────────
export interface CallState {
  status: "idle" | "incoming" | "outgoing" | "connecting" | "active" | "ended";
  peerId: string | null;
  peerName: string | null;
  // Set when the call connects; drives the duration timer
  startedAt: number | null;
  muted: boolean;
  // Outgoing: the remote device confirmed it's ringing
  ringing: boolean;
  endedReason: string | null;
}

export const IDLE_CALL: CallState = {
  status: "idle",
  peerId: null,
  peerName: null,
  startedAt: null,
  muted: false,
  ringing: false,
  endedReason: null,
};

// ─── Settings Types ─────────────────────────────────────────────
export interface AppSettings {
  downloadPath: string;
  autoAcceptFromPaired: boolean;
  requirePin: boolean;
  showNotifications: boolean;
  maxConcurrentTransfers: number;
  chunkSize: number;
  deviceName: string;
}

// ─── UI Types ───────────────────────────────────────────────────
// Which network the Network view is showing: the local LAN (radar) or
// internet peers reached over P2P (world map). Drives the titlebar toggle
// and the teal → blue accent shift.
export type NetworkScope = "lan" | "internet";

// ─── Store ──────────────────────────────────────────────────────
interface AppState {
  // Connection
  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;

  // UI shell
  scope: NetworkScope;
  setScope: (scope: NetworkScope) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // Devices
  devices: Device[];
  selectedDeviceIds: string[];
  isScanning: boolean;
  setDevices: (devices: Device[]) => void;
  addDevice: (device: Device) => void;
  removeDevice: (id: string) => void;
  updateDevice: (id: string, updates: Partial<Device>) => void;
  toggleDeviceSelection: (id: string) => void;
  clearDeviceSelection: () => void;
  setIsScanning: (scanning: boolean) => void;

  // Transfers
  transfers: TransferItem[];
  upsertTransfer: (transfer: TransferItem) => void;
  updateTransfer: (id: string, updates: Partial<TransferItem>) => void;
  removeTransfer: (id: string) => void;

  // Incoming transfer requests (accept/decline prompts)
  incomingRequests: TransferRequest[];
  addIncomingRequest: (request: TransferRequest) => void;
  removeIncomingRequest: (id: string) => void;

  // History
  history: HistoryEntry[];
  setHistory: (entries: HistoryEntry[]) => void;
  addHistoryEntry: (entry: HistoryEntry) => void;

  // Chat
  conversations: Conversation[];
  setConversations: (conversations: Conversation[]) => void;
  chatMessages: Record<string, ChatMessage[]>;
  setChatMessages: (conversationId: string, messages: ChatMessage[]) => void;
  upsertChatMessage: (message: ChatMessage) => void;
  typingPeers: Record<string, boolean>;
  setPeerTyping: (deviceId: string, typing: boolean) => void;

  // Calls
  callState: CallState;
  setCallState: (updates: Partial<CallState>) => void;
  resetCallState: () => void;

  // Settings
  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // ── Connection ──
  isConnected: false,
  setIsConnected: (isConnected) => set({ isConnected }),

  // ── UI shell ──
  scope: "lan",
  setScope: (scope) => set({ scope }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),

  // ── Devices ──
  devices: [],
  selectedDeviceIds: [],
  isScanning: false,
  setDevices: (devices) => {
    const hasOnline = devices.some((d) => d.status !== "offline");
    set({ devices, isConnected: hasOnline });
  },
  addDevice: (device) =>
    set((s) => {
      const updated = s.devices.some((d) => d.id === device.id)
        ? s.devices.map((d) => (d.id === device.id ? { ...d, ...device } : d))
        : [...s.devices, device];
      return { devices: updated, isConnected: updated.some((d) => d.status !== "offline") };
    }),
  removeDevice: (id) =>
    set((s) => {
      const updated = s.devices.filter((d) => d.id !== id);
      return { devices: updated, isConnected: updated.some((d) => d.status !== "offline") };
    }),
  updateDevice: (id, updates) =>
    set((s) => {
      const updated = s.devices.map((d) => (d.id === id ? { ...d, ...updates } : d));
      return { devices: updated, isConnected: updated.some((d) => d.status !== "offline") };
    }),
  toggleDeviceSelection: (id) =>
    set((s) => ({
      selectedDeviceIds: s.selectedDeviceIds.includes(id)
        ? s.selectedDeviceIds.filter((sid) => sid !== id)
        : [...s.selectedDeviceIds, id],
    })),
  clearDeviceSelection: () => set({ selectedDeviceIds: [] }),
  setIsScanning: (isScanning) => set({ isScanning }),

  // ── Transfers ──
  transfers: [],
  upsertTransfer: (transfer) =>
    set((s) => ({
      transfers: s.transfers.some((t) => t.id === transfer.id)
        ? s.transfers.map((t) =>
            t.id === transfer.id ? { ...t, ...transfer } : t
          )
        : [...s.transfers, transfer],
    })),
  updateTransfer: (id, updates) =>
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),
  removeTransfer: (id) =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),

  // ── Incoming Requests ──
  incomingRequests: [],
  addIncomingRequest: (request) =>
    set((s) =>
      s.incomingRequests.some((r) => r.id === request.id)
        ? {}
        : { incomingRequests: [...s.incomingRequests, request] }
    ),
  removeIncomingRequest: (id) =>
    set((s) => ({
      incomingRequests: s.incomingRequests.filter((r) => r.id !== id),
    })),

  // ── History ──
  history: [],
  setHistory: (history) => set({ history }),
  addHistoryEntry: (entry) =>
    set((s) => ({ history: [entry, ...s.history] })),

  // ── Chat ──
  conversations: [],
  setConversations: (conversations) => set({ conversations }),
  chatMessages: {},
  setChatMessages: (conversationId, messages) =>
    set((s) => ({
      chatMessages: { ...s.chatMessages, [conversationId]: messages },
    })),
  upsertChatMessage: (message) =>
    set((s) => {
      const existing = s.chatMessages[message.conversationId] ?? [];
      const next = existing.some((m) => m.id === message.id)
        ? existing.map((m) => (m.id === message.id ? { ...m, ...message } : m))
        : [...existing, message].sort((a, b) => a.createdAt - b.createdAt);
      return {
        chatMessages: { ...s.chatMessages, [message.conversationId]: next },
      };
    }),
  typingPeers: {},
  setPeerTyping: (deviceId, typing) =>
    set((s) => ({ typingPeers: { ...s.typingPeers, [deviceId]: typing } })),

  // ── Calls ──
  callState: IDLE_CALL,
  setCallState: (updates) =>
    set((s) => ({ callState: { ...s.callState, ...updates } })),
  resetCallState: () => set({ callState: IDLE_CALL }),

  // ── Settings ──
  settings: {
    downloadPath: "",
    autoAcceptFromPaired: false,
    requirePin: false,
    showNotifications: true,
    maxConcurrentTransfers: 3,
    chunkSize: 1024 * 1024,
    deviceName: "My PC",
  },
  updateSettings: (updates) =>
    set((s) => ({ settings: { ...s.settings, ...updates } })),
}));
