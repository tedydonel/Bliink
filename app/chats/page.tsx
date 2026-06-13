"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Monitor, Phone, Search, Lock, Shield } from "lucide-react";
import MessageBubble from "@/app/components/chat/MessageBubble";
import ChatInput from "@/app/components/chat/ChatInput";
import { useAppStore, type ChatMessage, type Conversation } from "@/app/lib/store";
import { callManager } from "@/app/lib/call-manager";
import { cn } from "@/app/lib/utils";
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

  // Initial conversations load + honor ?peer=<id> deep-link (from Network view)
  useEffect(() => {
    const load = async () => {
      if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
      setConversations(await api.getConversations());
      const peer = new URLSearchParams(window.location.search).get("peer");
      if (peer) openConversation(peer);
    };
    load();
  }, [setConversations, openConversation]);

  // Mark incoming messages read while this conversation is on screen
  const unreadInActive = activeId
    ? messages.filter((m) => m.direction === "in" && m.status === "unread").length
    : 0;
  useEffect(() => {
    if (activeId && unreadInActive > 0) api.markConversationRead(activeId);
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

  const fmtTime = (ts?: number | null) =>
    ts
      ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

  return (
    <div className="bk-view">
      <div className="bk-msg-body" style={{ borderTop: "1px solid var(--stroke)" }}>
        {/* Conversation list */}
        <div className="bk-convo-list">
          <div className="bk-input" style={{ height: 34, margin: "4px 4px 8px" }}>
            <Search size={14} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats…"
            />
          </div>

          <div className="bk-section-label" style={{ margin: "4px 4px 8px" }}>
            Conversations
          </div>

          {filteredConversations.map((conv) => (
            <button
              key={conv.deviceId}
              className={cn("bk-convo", activeId === conv.deviceId && "active")}
              onClick={() => openConversation(conv.deviceId)}
            >
              <div className="bk-convo-avatar">
                <Monitor size={16} />
                {conv.online && <span className="bk-online-dot" />}
              </div>
              <div className="bk-convo-meta">
                <div className="bk-convo-name">
                  {conv.deviceName}
                  <time>{fmtTime(conv.lastMessageAt)}</time>
                </div>
                <div className={cn("bk-convo-last", conv.unreadCount > 0 && "unread")}>
                  {typingPeers[conv.deviceId] ? (
                    <span style={{ color: "var(--accent)" }}>typing…</span>
                  ) : (
                    conv.lastPreview ?? ""
                  )}
                </div>
              </div>
              {conv.unreadCount > 0 && (
                <span className="bk-nav-badge">{conv.unreadCount}</span>
              )}
            </button>
          ))}

          {newChatDevices.length > 0 && (
            <>
              <div className="bk-section-label" style={{ margin: "12px 4px 8px" }}>
                Start a chat
              </div>
              {newChatDevices.map((device) => (
                <button
                  key={device.id}
                  className="bk-convo"
                  onClick={() => openConversation(device.id)}
                >
                  <div className="bk-convo-avatar">
                    <Monitor size={16} />
                  </div>
                  <div className="bk-convo-meta">
                    <div className="bk-convo-name">{device.name}</div>
                    <div className="bk-convo-last">{device.ip || "internet peer"}</div>
                  </div>
                </button>
              ))}
            </>
          )}

          {conversations.length === 0 && newChatDevices.length === 0 && (
            <div className="bk-empty" style={{ padding: "30px 16px" }}>
              <MessageCircle size={28} />
              <p>No chats yet. Devices running Bliink will appear here.</p>
            </div>
          )}
        </div>

        {/* Thread */}
        {activeId ? (
          <div className="bk-chat">
            <div className="bk-chat-head">
              <div className="bk-convo-avatar">
                <Monitor size={16} />
                {activeOnline && <span className="bk-online-dot" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{activeName}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: typingPeers[activeId] ? "var(--accent)" : "var(--faint)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {typingPeers[activeId]
                    ? "typing…"
                    : activeOnline
                    ? "online · direct link"
                    : "offline · messages queue"}
                </div>
              </div>
              {!activeId.startsWith("web-") && (
                <button
                  className="bk-iconbtn"
                  onClick={() => callManager.startCall(activeId, activeName)}
                  disabled={!activeOnline || callState.status !== "idle"}
                  style={{
                    color:
                      activeOnline && callState.status === "idle"
                        ? "var(--accent)"
                        : "var(--faint)",
                    cursor:
                      activeOnline && callState.status === "idle"
                        ? "pointer"
                        : "not-allowed",
                  }}
                  title={
                    !activeOnline
                      ? "Device is offline"
                      : callState.status !== "idle"
                      ? "Already in a call"
                      : "Start audio call"
                  }
                  aria-label="Start audio call"
                >
                  <Phone size={16} />
                </button>
              )}
              <span className="bk-chip lock">
                <Lock size={10} /> end-to-end
              </span>
            </div>

            <div className="bk-chat-scroll" ref={threadRef}>
              <div className="bk-e2e-banner">
                <Shield size={12} /> Messages with {activeName} are end-to-end
                encrypted. No server ever sees them.
              </div>
              {messages.map((message, i) => {
                const prev = messages[i - 1];
                const showDay =
                  !prev ||
                  new Date(prev.createdAt).toDateString() !==
                    new Date(message.createdAt).toDateString();
                return (
                  <div key={message.id}>
                    {showDay && (
                      <div className="bk-e2e-banner" style={{ background: "transparent", border: "none" }}>
                        {formatDay(message.createdAt)}
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
                <div className="bk-empty" style={{ paddingTop: 60 }}>
                  <MessageCircle size={28} />
                  <p>Say hi — messages are encrypted end to end.</p>
                </div>
              )}
            </div>

            <ChatInput
              deviceId={activeId}
              replyingTo={replyingTo}
              onCancelReply={() => setReplyingTo(null)}
              onSent={handleSent}
            />
          </div>
        ) : (
          <div className="bk-empty" style={{ flex: 1 }}>
            <MessageCircle size={34} />
            <h3>Your messages</h3>
            <p>
              Pick a conversation or start a new one with a device on your network.
              Messages travel encrypted, directly between devices.
            </p>
          </div>
        )}
      </div>
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
