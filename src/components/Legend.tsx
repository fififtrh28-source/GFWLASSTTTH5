import type { Mode } from "@/lib/types";

export default function Legend({ mode }: { mode: Mode | null }) {
  if (!mode) return null;
  const items = mode === "ais" ? [
    { c: "var(--ais-stop)",   l: "Berhenti (<1 kn)" },
    { c: "var(--ais-slow)",   l: "Lambat (1–5 kn)" },
    { c: "var(--ais-normal)", l: "Normal (5–12 kn)" },
    { c: "var(--ais-fast)",   l: "Cepat (>12 kn)" },
    { c: "var(--ais-unknown)",l: "Tidak diketahui" },
  ] : [
    { c: "var(--gfw-fishing)",   l: "Fishing" },
    { c: "var(--gfw-encounter)", l: "Encounter" },
    { c: "var(--gfw-loitering)", l: "Loitering" },
    { c: "var(--gfw-other)",     l: "Lainnya" },
  ];
  return (
    <div className="fixed bottom-4 left-3 z-[1000] glass rounded-xl px-3 py-2.5 text-xs space-y-1.5 min-w-[170px]">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {mode === "ais" ? "Kecepatan" : "Tipe Event"}
      </div>
      {items.map((it) => (
        <div key={it.l} className="flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: it.c, boxShadow: `0 0 6px ${it.c}` }} />
          <span className="text-foreground/90">{it.l}</span>
        </div>
      ))}
    </div>
  );
}