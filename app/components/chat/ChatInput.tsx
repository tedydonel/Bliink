"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CornerUpLeft,
  Mic,
  Paperclip,
  Send,
  Smile,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { type ChatMessage } from "@/app/lib/store";
import * as api from "@/app/lib/tauri-api";
import { cn } from "@/app/lib/utils";

const EMOJIS = [
  "😀", "😂", "😅", "😊", "😍", "😘", "😎", "🤔",
  "😢", "😭", "😡", "🥳", "🤝", "👍", "👎", "👏",
  "🙏", "💪", "🔥", "✨", "❤️", "💯", "🎉", "🎁",
  "✅", "❌", "⚡", "🎯", "📌", "📷", "🎵", "🚀",
];

export default function ChatInput({
  deviceId,
  replyingTo,
  onCancelReply,
  onSent,
}: {
  deviceId: string;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
  onSent: (message: ChatMessage) => void;
}) {
  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingRef = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRef = useRef(false);

  const stopTyping = useCallback(() => {
    if (typingRef.current) {
      typingRef.current = false;
      api.setTyping(deviceId, false);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, [deviceId]);

  const handleTextChange = useCallback(
    (value: string) => {
      setText(value);
      // Signal typing, auto-clearing after a pause
      if (!typingRef.current && value.length > 0) {
        typingRef.current = true;
        api.setTyping(deviceId, true);
      }
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        typingRef.current = false;
        api.setTyping(deviceId, false);
      }, 3000);
    },
    [deviceId]
  );

  useEffect(() => stopTyping, [stopTyping]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    stopTyping();
    const message = await api.sendChatMessage(
      deviceId,
      trimmed,
      replyingTo?.id ?? null
    );
    onCancelReply();
    if (message) onSent(message);
    textareaRef.current?.focus();
  }, [text, deviceId, replyingTo, onCancelReply, onSent, stopTyping]);

  const handleAttach = useCallback(async () => {
    const files = await api.openFileDialog();
    for (const file of files) {
      const message = await api.sendChatAttachment(
        deviceId,
        file.path,
        replyingTo?.id ?? null
      );
      if (message) onSent(message);
    }
    onCancelReply();
  }, [deviceId, replyingTo, onCancelReply, onSent]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimer.current) clearInterval(recordTimer.current);
        setRecording(false);
        setRecordSeconds(0);
        if (discardRef.current || chunksRef.current.length === 0) return;

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const message = await api.sendVoiceNote(deviceId, btoa(binary));
        if (message) onSent(message);
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setRecordSeconds(0);
      recordTimer.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );
    } catch (e) {
      console.error("Microphone access failed:", e);
    }
  }, [deviceId, onSent]);

  const finishRecording = useCallback((discard: boolean) => {
    discardRef.current = discard;
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const insertEmoji = useCallback((emoji: string) => {
    setText((t) => t + emoji);
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="border-t border-border bg-surface/60 backdrop-blur-sm px-4 py-3 relative">
      {replyingTo && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-surface-active/60 border-l-2 border-accent">
          <CornerUpLeft className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="text-[12px] text-muted-light truncate flex-1">
            {replyingTo.text ??
              replyingTo.attachmentName ??
              "Attachment"}
          </span>
          <button onClick={onCancelReply} className="text-muted hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {showEmoji && (
        <div className="absolute bottom-full left-4 mb-1 p-2 rounded-xl bg-surface border border-border shadow-2xl grid grid-cols-8 gap-0.5 z-20">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => insertEmoji(emoji)}
              className="w-8 h-8 flex items-center justify-center text-lg rounded-lg hover:bg-surface-hover"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {recording ? (
        <div className="flex items-center gap-3 h-10">
          <span className="w-2.5 h-2.5 rounded-full bg-danger animate-pulse" />
          <span className="text-[13px] font-mono text-foreground">
            {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, "0")}
          </span>
          <span className="text-[12px] text-muted flex-1">Recording voice message…</span>
          <button
            onClick={() => finishRecording(true)}
            className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger-dim transition-colors"
            aria-label="Discard"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => finishRecording(false)}
            className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold rounded-lg bg-accent text-background hover:bg-accent-hover"
          >
            <Square className="w-3.5 h-3.5" />
            Send
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-1.5">
          <button
            onClick={() => setShowEmoji((v) => !v)}
            className={cn(
              "p-2 rounded-lg transition-colors shrink-0",
              showEmoji ? "text-accent bg-accent/10" : "text-muted hover:text-foreground hover:bg-surface-hover"
            )}
            aria-label="Emoji"
          >
            <Smile className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={handleAttach}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
            aria-label="Attach file"
          >
            <Paperclip className="w-[18px] h-[18px]" />
          </button>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            onFocus={() => setShowEmoji(false)}
            placeholder="Type a message…"
            rows={1}
            className="flex-1 max-h-32 px-3.5 py-2 rounded-xl bg-surface-active/60 border border-border text-[13px] text-foreground placeholder:text-muted resize-none focus:outline-none focus:border-accent/40"
            style={{ minHeight: "38px" }}
          />

          {text.trim() ? (
            <button
              onClick={handleSend}
              className="p-2.5 rounded-xl bg-accent text-background hover:bg-accent-hover transition-all shrink-0"
              aria-label="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={startRecording}
              className="p-2.5 rounded-xl text-muted hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
              aria-label="Record voice message"
            >
              <Mic className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
