"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Monitor, Phone, Search } from "lucide-react";
import MessageBubble from "@/app/components/chat/MessageBubble";
import ChatInput from "@/app/components/chat/ChatInput";
import { useAppStore, type ChatMessage, type Conversation } from "@/app/lib/store";
import { callManager } from "@/app/lib/call-manager";
import { cn, formatRelativeTime } from "@/app/lib/utils";
import * as api from "@/app/lib/tauri-api";

export default function ChatsPage() {
  const {
    conversations,
    setConversations,
    chatMessages,
    setChatMessages,
    upsertChatMessage,
    typingPeers,
    devices,
    callState,
  } = useAppStore();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => (activeId ? chatMessages[activeId] ?? [] : []),
    [chatMessages, activeId]
  );

  // Initial conversations load
  useEffect(() => {
    const load = async () => {
      if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
      setConversations(await api.getConversations());
    };
    load();
  }, [setConversations]);

  // Open a conversation: load history + clear unread
  const openConversation = useCallback(
    async (deviceId: string) => {
      setActiveId(deviceId);
      setReplyingTo(null);
      const history = await api.getChatMessages(deviceId, 200);
      setChatMessages(deviceId, history);
      await api.markConversationRead(deviceId);
    },
    [setChatMessages]
  );

  // Mark incoming messages read while this conversation is on screen
  const unreadInActive = activeId
    ? messages.filter((m) => m.direction === "in" && m.status === "unread").length
    : 0;
  useEffect(() => {
    if (activeId && unreadInActive > 0) {
      api.markConversationRead(activeId);
    }
  }, [activeId, unreadInActive]);

  // Stick to the bottom as messages arrive
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, activeId, typingPeers]);

  // Devices you can start a new chat with (no conversation yet)
  const newChatDevices = useMemo(() => {
    const known = new Set(conversations.map((c) => c.deviceId));
    return devices.filter(
      (d) => !known.has(d.id) && d.status !== "offline" && (d.chatPort ?? 0) > 0
    );
  }, [devices, conversations]);

  const filteredConversations = useMemo(
    () =>
      conversations.filter((c) =>
        c.deviceName.toLowerCase().includes(search.toLowerCase())
      ),
    [conversations, search]
  );

  const activeConversation: Conversation | undefined = conversations.find(
    (c) => c.deviceId === activeId
  );
  const activeName =
    activeConversation?.deviceName ??
    devices.find((d) => d.id === activeId)?.name ??
    "Device";
  const activeOnline =
    activeConversation?.online ??
    devices.some((d) => d.id === activeId && d.status !== "offline");

  const handleSent = useCallback(
    (message: ChatMessage) => upsertChatMessage(message),
    [upsertChatMessage]
  );

  return (
    <div className="flex h-full">
      {/* Conversation list */}
      <div className="flex flex-col w-[300px] shrink-0 border-r border-border">
        <div className="px-5 pt-7 pb-3 shrink-0">
          <h1 className="text-xl font-bold text-foreground tracking-tight">Chats</h1>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats..."
              className="w-full h-9 pl-9 pr-3 rounded-lg bg-surface border border-border text-[12px] text-foreground placeholder:text-muted focus:outline-none focus:border-accent/40"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {filteredConversations.map((conv) => (
            <button
              key={conv.deviceId}
              onClick={() => openConversation(conv.deviceId)}
              className={cn(
                "flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-left transition-colors",
                activeId === conv.deviceId
                  ? "bg-accent/10 border border-accent/15"
                  : "hover:bg-surface-hover border border-transparent"
              )}
            >
              <div className="relative shrink-0">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-gradient-to-br from-accent/20 to-sky/20 border border-accent/20">
                  <Monitor className="w-4 h-4 text-accent" />
                </div>
                {conv.online && (
                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-success border-2 border-background" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-foreground truncate">
                    {conv.deviceName}
                  </span>
                  {conv.lastMessageAt && (
                    <span className="text-[10px] text-muted shrink-0">
                      {formatRelativeTime(conv.lastMessageAt)}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-[11px] text-muted truncate">
                    {typingPeers[conv.deviceId] ? (
                      <span className="text-accent">typing…</span>
                    ) : (
                      conv.lastPreview ?? ""
                    )}
                  </span>
                  {conv.unreadCount > 0 && (
                    <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-background text-[10px] font-bold shrink-0">
                      {conv.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}

          {newChatDevices.length > 0 && (
            <>
              <p className="px-3 pt-4 pb-2 text-[10px] font-bold text-muted uppercase tracking-widest">
                Start a chat
              </p>
              {newChatDevices.map((device) => (
                <button
                  key={device.id}
                  onClick={() => openConversation(device.id)}
                  className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-left hover:bg-surface-hover transition-colors"
                >
                  <div className="flex items-center justify-center w-10 h-10 rounded-full bg-surface-active border border-border shrink-0">
                    <Monitor className="w-4 h-4 text-muted-light" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-foreground truncate">
                      {device.name}
                    </p>
                    <p className="text-[11px] text-muted">{device.ip}</p>
                  </div>
                </button>
              ))}
            </>
          )}

          {conversations.length === 0 && newChatDevices.length === 0 && (
            <div className="px-3 py-10 text-center">
              <MessageCircle className="w-8 h-8 text-muted mx-auto mb-3" />
              <p className="text-[12px] text-muted">
                No chats yet. Devices running Bliink will appear here.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Thread */}
      {activeId ? (
        <div className="flex flex-col flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border bg-surface/40 shrink-0">
            <div className="relative">
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-accent/20 to-sky/20 border border-accent/20">
                <Monitor className="w-4 h-4 text-accent" />
              </div>
              {activeOnline && (
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-success border-2 border-background" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-bold text-foreground truncate">{activeName}</p>
              <p className="text-[11px] text-muted">
                {typingPeers[activeId] ? (
                  <span className="text-accent">typing…</span>
                ) : activeOnline ? (
                  "Online"
                ) : (
                  "Offline"
                )}
              </p>
            </div>
            {!activeId.startsWith("web-") && (
            <button
              onClick={() => callManager.startCall(activeId, activeName)}
              disabled={!activeOnline || callState.status !== "idle"}
              className={cn(
                "flex items-center justify-center w-9 h-9 rounded-lg transition-colors shrink-0",
                activeOnline && callState.status === "idle"
                  ? "text-accent hover:bg-accent/10 border border-accent/20"
                  : "text-muted/40 border border-border cursor-not-allowed"
              )}
              aria-label="Start audio call"
              title={
                !activeOnline
                  ? "Device is offline"
                  : callState.status !== "idle"
                  ? "Already in a call"
                  : "Start audio call"
              }
            >
              <Phone className="w-4 h-4" />
            </button>
            )}
          </div>

          {/* Messages */}
          <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4">
            <div className="flex flex-col gap-1.5">
              {messages.map((message, i) => {
                const prev = messages[i - 1];
                const showDay =
                  !prev ||
                  new Date(prev.createdAt).toDateString() !==
                    new Date(message.createdAt).toDateString();
                return (
                  <div key={message.id}>
                    {showDay && (
                      <div className="flex justify-center my-3">
                        <span className="px-3 py-1 rounded-full bg-surface border border-border text-[10px] text-muted">
                          {formatDay(message.createdAt)}
                        </span>
                      </div>
                    )}
                    <MessageBubble
                      message={message}
                      repliedTo={
                        message.replyTo
                          ? messages.find((m) => m.id === message.replyTo)
                          : undefined
                      }
                      onReply={setReplyingTo}
                    />
                  </div>
                );
              })}

              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <MessageCircle className="w-8 h-8 text-muted mb-3" />
                  <p className="text-[13px] text-muted">
                    Say hi — messages are encrypted end to end.
                  </p>
                </div>
              )}
            </div>
          </div>

          <ChatInput
            deviceId={activeId}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            onSent={handleSent}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center flex-1 text-center px-8">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-surface border border-border mb-4">
            <MessageCircle className="w-7 h-7 text-muted" />
          </div>
          <p className="text-[15px] font-semibold text-foreground">Your messages</p>
          <p className="text-[13px] text-muted mt-1.5 max-w-[300px]">
            Pick a conversation or start a new one with a device on your network.
            Messages travel encrypted, directly between devices.
          </p>
        </div>
      )}
    </div>
  );
}

function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}
