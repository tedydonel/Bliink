"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { ZapIcon } from "./Icons";
import * as api from "@/app/lib/tauri-api";

/**
 * The Internet map's "reach anyone" control: a small circle that expands inline
 * into a Bliink-ID field (no modal). Pasting an ID dials the peer over P2P.
 *
 * Note: the input takes the *full* Bliink ID (what Settings → Remote Access
 * copies). The short `BLNK-…` label shown around the app is display-only.
 */
export default function PairCircle({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 240);
  }, [open]);

  const close = () => {
    setOpen(false);
    setCode("");
    setError(null);
  };

  const pair = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addInternetDevice(code.trim());
      onAdded();
      close();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
    setBusy(false);
  };

  return (
    <div className={"bk-pair" + (open ? " open" : "")}>
      {!open ? (
        <button
          className="bk-pair-trigger"
          title="Reach anyone, anywhere"
          onClick={() => setOpen(true)}
        >
          <Plus size={16} />
        </button>
      ) : (
        <div className="bk-pair-body">
          <span className="bk-pair-icon">
            <ZapIcon size={14} />
          </span>
          <div className="bk-pair-text">
            <span className="bk-pair-title" style={error ? { color: "var(--danger)" } : undefined}>
              {error ?? "Reach anyone, anywhere"}
            </span>
            <input
              ref={inputRef}
              placeholder="paste Bliink ID"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") pair();
                if (e.key === "Escape") close();
              }}
            />
          </div>
          <button
            className="bk-btn primary"
            style={{ height: 30, fontSize: 12 }}
            disabled={!code.trim() || busy}
            onClick={pair}
          >
            {busy ? "Pairing…" : "Pair"}
          </button>
          <button className="bk-iconbtn" onClick={close} title="Close">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
