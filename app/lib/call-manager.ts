import * as api from "./tauri-api";
import { useAppStore, IDLE_CALL } from "./store";

/**
 * Audio call manager: WebRTC inside the webview, signaling over the
 * encrypted chat channel (CallSignal frames). LAN-only — host ICE
 * candidates, no STUN/TURN.
 */

interface SignalPayload {
  kind: "offer" | "answer" | "ice" | "ringing" | "reject" | "hangup";
  callId: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  reason?: string;
}

const RING_TIMEOUT_MS = 45_000;
const ENDED_BANNER_MS = 2_500;

function newCallId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function peerNameFor(deviceId: string): string {
  const s = useAppStore.getState();
  return (
    s.conversations.find((c) => c.deviceId === deviceId)?.deviceName ??
    s.devices.find((d) => d.id === deviceId)?.name ??
    "Unknown device"
  );
}

class CallManager {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private callId: string | null = null;
  private peerId: string | null = null;
  private pendingOffer: SignalPayload | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private endedTimer: ReturnType<typeof setTimeout> | null = null;

  private set(updates: Parameters<ReturnType<typeof useAppStore.getState>["setCallState"]>[0]) {
    useAppStore.getState().setCallState(updates);
  }

  private get status() {
    return useAppStore.getState().callState.status;
  }

  // ── Outgoing ──

  async startCall(peerId: string, peerName: string): Promise<void> {
    if (this.status !== "idle") return;
    if (this.endedTimer) clearTimeout(this.endedTimer);

    this.callId = newCallId();
    this.peerId = peerId;
    this.pendingCandidates = [];
    this.set({
      ...IDLE_CALL,
      status: "outgoing",
      peerId,
      peerName,
    });

    try {
      await this.setupPeerConnection(peerId);
      const offer = await this.pc!.createOffer();
      await this.pc!.setLocalDescription(offer);
      await api.sendCallSignal(peerId, {
        kind: "offer",
        callId: this.callId,
        sdp: offer.sdp,
      });
      this.ringTimer = setTimeout(() => this.endCall("No answer", true), RING_TIMEOUT_MS);
    } catch (e) {
      console.error("Failed to start call:", e);
      this.endCall(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access denied"
          : "Could not start the call",
        false
      );
    }
  }

  // ── Incoming ──

  async acceptCall(): Promise<void> {
    const offer = this.pendingOffer;
    if (!offer || !this.peerId || this.status !== "incoming") return;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.set({ status: "connecting" });

    try {
      await this.setupPeerConnection(this.peerId);
      await this.pc!.setRemoteDescription({ type: "offer", sdp: offer.sdp! });
      await this.flushPendingCandidates();
      const answer = await this.pc!.createAnswer();
      await this.pc!.setLocalDescription(answer);
      await api.sendCallSignal(this.peerId, {
        kind: "answer",
        callId: this.callId!,
        sdp: answer.sdp,
      });
      this.pendingOffer = null;
    } catch (e) {
      console.error("Failed to accept call:", e);
      this.endCall(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access denied"
          : "Could not join the call",
        true
      );
    }
  }

  declineCall(): void {
    if (this.peerId && this.callId) {
      api.sendCallSignal(this.peerId, {
        kind: "reject",
        callId: this.callId,
      });
    }
    this.cleanup();
    useAppStore.getState().resetCallState();
  }

  hangup(): void {
    this.endCall(null, true);
  }

  toggleMute(): void {
    const muted = !useAppStore.getState().callState.muted;
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
  }

  // ── Signaling ──

  async handleSignal(deviceId: string, raw: unknown): Promise<void> {
    const payload = raw as SignalPayload;
    if (!payload?.kind || !payload.callId) return;

    switch (payload.kind) {
      case "offer": {
        if (this.status !== "idle") {
          // Already on a call — tell the caller we're busy
          if (payload.callId !== this.callId) {
            api.sendCallSignal(deviceId, {
              kind: "reject",
              callId: payload.callId,
              reason: "busy",
            });
          }
          return;
        }
        if (this.endedTimer) clearTimeout(this.endedTimer);
        this.callId = payload.callId;
        this.peerId = deviceId;
        this.pendingOffer = payload;
        this.pendingCandidates = [];
        this.set({
          ...IDLE_CALL,
          status: "incoming",
          peerId: deviceId,
          peerName: peerNameFor(deviceId),
        });
        api.sendCallSignal(deviceId, {
          kind: "ringing",
          callId: payload.callId,
        });
        this.ringTimer = setTimeout(() => this.declineCall(), RING_TIMEOUT_MS);
        break;
      }
      case "ringing": {
        if (payload.callId === this.callId) this.set({ ringing: true });
        break;
      }
      case "answer": {
        if (payload.callId !== this.callId || !this.pc) return;
        if (this.ringTimer) clearTimeout(this.ringTimer);
        this.set({ status: "connecting" });
        try {
          await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp! });
          await this.flushPendingCandidates();
        } catch (e) {
          console.error("Failed to apply answer:", e);
          this.endCall("Connection failed", true);
        }
        break;
      }
      case "ice": {
        if (payload.callId !== this.callId || !payload.candidate) return;
        if (this.pc?.remoteDescription) {
          try {
            await this.pc.addIceCandidate(payload.candidate);
          } catch (e) {
            console.warn("Failed to add ICE candidate:", e);
          }
        } else {
          // Candidates can arrive before the offer is accepted
          this.pendingCandidates.push(payload.candidate);
        }
        break;
      }
      case "reject": {
        if (payload.callId !== this.callId) return;
        this.endCall(payload.reason === "busy" ? "Busy" : "Call declined", false);
        break;
      }
      case "hangup": {
        if (payload.callId !== this.callId) return;
        this.endCall("Call ended", false);
        break;
      }
    }
  }

  // ── Internals ──

  private async setupPeerConnection(peerId: string): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // STUN lets calls traverse NATs for internet peers; on the LAN the
    // host candidates win anyway.
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      ],
    });
    this.pc = pc;
    this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream!));

    pc.onicecandidate = (e) => {
      if (e.candidate && this.callId) {
        api.sendCallSignal(peerId, {
          kind: "ice",
          callId: this.callId,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (e) => {
      if (!this.remoteAudio) {
        this.remoteAudio = new Audio();
        this.remoteAudio.autoplay = true;
      }
      this.remoteAudio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };

    pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      switch (this.pc.connectionState) {
        case "connected":
          if (this.ringTimer) clearTimeout(this.ringTimer);
          this.set({ status: "active", startedAt: Date.now() });
          break;
        case "failed":
          this.endCall("Connection lost", true);
          break;
        default:
          break;
      }
    };
  }

  private async flushPendingCandidates(): Promise<void> {
    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of candidates) {
      try {
        await this.pc?.addIceCandidate(candidate);
      } catch (e) {
        console.warn("Failed to add buffered ICE candidate:", e);
      }
    }
  }

  private endCall(reason: string | null, notifyPeer: boolean): void {
    if (notifyPeer && this.peerId && this.callId) {
      api.sendCallSignal(this.peerId, { kind: "hangup", callId: this.callId });
    }
    this.cleanup();
    if (reason) {
      this.set({ status: "ended", endedReason: reason, startedAt: null, ringing: false });
      this.endedTimer = setTimeout(() => {
        if (useAppStore.getState().callState.status === "ended") {
          useAppStore.getState().resetCallState();
        }
      }, ENDED_BANNER_MS);
    } else {
      useAppStore.getState().resetCallState();
    }
  }

  private cleanup(): void {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
    }
    this.callId = null;
    this.peerId = null;
    this.pendingOffer = null;
    this.pendingCandidates = [];
  }
}

export const callManager = new CallManager();
