import { useEffect, useState } from "react";
import type { Mode } from "@/lib/types";

type Props = {
  mode: Mode | null;
  online: boolean;
  shipCount: number;
  msgCount: number;
  lastUpdate: number | null;
  onSetMode: (m: Mode | null) => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
  aisKey: string;
  onAisKeyChange: (s: string) => void;
};

export default function TopBar({
  mode, online, shipCount, msgCount, lastUpdate,
  onSetMode, onTogglePanel, panelOpen, aisKey, onAisKeyChange,
}: Props) {
  const [now, setNow] = useState(Date.now());
  const [showKey, setShowKey] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ago = lastUpdate ? Math.max(0, Math.floor((now - lastUpdate) / 1000)) : null;
  const stamp = lastUpdate ? new Date(lastUpdate).toLocaleTimeString("id-ID") : "—";

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[1000] max-w-[calc(100vw-1rem)]">
      <div className="glass rounded-full px-2 py-1.5 flex items-center gap-2 overflow-x-auto no-scrollbar">
        <PillBtn active={mode === "ais"} onClick={() => onSetMode(mode === "ais" ? null : "ais")} color="ais">
          <span className="dot" style={{ background: "var(--primary)" }} /> AISStream Live
        </PillBtn>
        <PillBtn active={mode === "gfw"} onClick={() => onSetMode(mode === "gfw" ? null : "gfw")} color="gfw">
          <span className="dot" style={{ background: "var(--ais-fast)" }} /> GFW Events
        </PillBtn>
        <PillBtn active={panelOpen} onClick={onTogglePanel} color="neutral">
          Query &amp; Track
        </PillBtn>

        <div className="w-px h-5 bg-border mx-1" />

        <div className="flex items-center gap-1.5 px-2 text-xs whitespace-nowrap">
          <span
            className={`inline-block w-2 h-2 rounded-full ${online ? "dot-blink" : ""}`}
            style={{ background: online ? "var(--ais-fast)" : "var(--ais-stop)" }}
          />
          <span className="text-muted-foreground">{online ? "Online" : "Offline"}</span>
        </div>
        <div className="text-xs whitespace-nowrap px-1">🚢 <span className="text-foreground">{shipCount}</span></div>
        <div className="text-xs whitespace-nowrap px-1">📡 <span className="text-foreground">{msgCount}</span></div>
        <div className="text-xs whitespace-nowrap px-1 text-muted-foreground">
          {stamp}{ago != null ? ` · ${ago}s` : ""}
        </div>

        <button
          onClick={() => setShowKey(v => !v)}
          className="text-[11px] px-2 py-1 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition"
          title="Set AIS API key"
        >
          🔑
        </button>
      </div>

      {showKey && (
        <div className="glass mt-2 rounded-xl p-3 text-xs">
          <label className="block text-muted-foreground mb-1">AISStream API Key</label>
          <input
            type="password"
            value={aisKey}
            onChange={(e) => onAisKeyChange(e.target.value)}
            placeholder="Tempel API key dari aisstream.io"
            className="w-full bg-input border border-border rounded-md px-2 py-1.5 text-foreground outline-none focus:border-primary"
          />
          <p className="mt-1 text-muted-foreground">Disimpan di browser (localStorage).</p>
        </div>
      )}

      <style>{`
        .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
      `}</style>
    </div>
  );
}

function PillBtn({
  active, onClick, children, color,
}: { active: boolean; onClick: () => void; children: React.ReactNode; color: "ais" | "gfw" | "neutral" }) {
  const ring =
    color === "ais" ? "var(--primary)" :
    color === "gfw" ? "var(--ais-fast)" :
    "var(--muted-foreground)";
  return (
    <button
      onClick={onClick}
      className="text-xs whitespace-nowrap px-3 py-1.5 rounded-full transition border"
      style={{
        background: active ? `color-mix(in oklab, ${ring} 18%, transparent)` : "transparent",
        borderColor: active ? ring : "var(--border)",
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
      }}
    >
      {children}
    </button>
  );
}