"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/app/lib/store";
import * as api from "@/app/lib/tauri-api";

/**
 * Global chat event subscriber, mounted in the root layout — keeps the
 * conversation list, messages, and typing indicators in sync everywhere
 * (so the sidebar unread badge works on any page).
 */
export default function ChatListener() {
  const setConversations = useAppStore((s) => s.setConversations);
  const upsertChatMessage = useAppStore((s) => s.upsertChatMessage);
  const setPeerTyping = useAppStore((s) => s.setPeerTyping);
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__)
      return;

    let disposed = false;
    const unlisteners: (() => void)[] = [];

    const refreshConversations = async () => {
      const conversations = await api.getConversations();
      if (!disposed) setConversations(conversations);
    };

    const init = async () => {
      await refreshConversations();

      unlisteners.push(
        await api.onChatMessage((message) => {
          upsertChatMessage(message);
        })
      );

      unlisteners.push(
        await api.onChatConversations(() => {
          refreshConversations();
        })
      );

      unlisteners.push(
        await api.onChatTyping(({ deviceId, typing }) => {
          setPeerTyping(deviceId, typing);
          // Auto-expire stale typing indicators
          clearTimeout(typingTimers.current[deviceId]);
          if (typing) {
            typingTimers.current[deviceId] = setTimeout(
              () => setPeerTyping(deviceId, false),
              5000
            );
          }
        })
      );
    };
    init();

    const timers = typingTimers.current;
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      Object.values(timers).forEach(clearTimeout);
    };
  }, [setConversations, upsertChatMessage, setPeerTyping]);

  return null;
}
