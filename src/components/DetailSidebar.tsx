import type { Selection } from "@/lib/types";
import { speedColor, speedLabel, eventColor } from "@/lib/aisstream";

type Props = {
  selection: Selection;
  onClose: () => void;
  onActivateTrajectory: () => void;
  onZoom: () => void;
  trajectoryActive: boolean;
};

export default function DetailSidebar({ selection, onClose, onActivateTrajectory, onZoom, trajectoryActive }: Props) {
  const open = !!selection;
  return (
    <aside
      className="fixed top-0 right-0 z-[1100] h-full transition-transform duration-300"
      style={{
        width: "min(340px, 92vw)",
        transform: open ? "translateX(0)" : "translateX(110%)",
      }}
    >
      <div className="glass h-full flex flex-col rounded-l-2xl border-r-0">
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-border">
          <div className="text-sm font-medium">
            {selection?.kind === "ais" ? "🚢 Kapal AIS" : selection?.kind === "gfw" ? "🎯 GFW Event" : "Detail"}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto thin-scroll p-4 space-y-4 text-sm">
          {selection?.kind === "ais" && <AisDetail s={selection.ship} />}
          {selection?.kind === "gfw" && <GfwDetail e={selection.event} />}
        </div>

        {selection && (
          <div className="p-3 border-t border-border flex gap-2">
            <button
              onClick={onActivateTrajectory}
              className="flex-1 px-3 py-2 rounded-md text-xs font-medium border transition"
              style={{
                background: trajectoryActive ? "color-mix(in oklab, var(--ais-stop) 18%, transparent)" : "transparent",
                borderColor: trajectoryActive ? "var(--ais-stop)" : "var(--border)",
                color: "var(--foreground)",
              }}
            >
              🛤 {trajectoryActive ? "Trajectory Aktif" : "Aktifkan Trajectory"}
            </button>
            <button
              onClick={onZoom}
              className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium"
            >
              🎯 Zoom
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <div className="text-muted-foreground">{k}</div>
      <div className="text-foreground text-right break-all">{v ?? "—"}</div>
    </div>
  );
}

function AisDetail({ s }: { s: import("@/lib/types").AisShip }) {
  const sc = speedColor(s.speed);
  return (
    <>
      <div>
        <div className="text-base font-semibold">{s.name || `MMSI ${s.mmsi}`}</div>
        <div className="text-xs text-muted-foreground">MMSI {s.mmsi}</div>
      </div>
      <Section title="Identitas">
        <Row k="MMSI" v={s.mmsi} />
        <Row k="Tujuan" v={s.destination || "—"} />
        <Row k="Status Nav" v={s.navStatus || "—"} />
      </Section>
      <Section title="Posisi & Gerak">
        <Row k="Lat / Lon" v={`${s.lat.toFixed(4)} / ${s.lon.toFixed(4)}`} />
        <Row k="Kecepatan" v={
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: sc, boxShadow: `0 0 6px ${sc}` }} />
            <span style={{ color: sc }}>{s.speed != null ? `${s.speed.toFixed(1)} kn` : "—"}</span>
            <span className="text-muted-foreground">({speedLabel(s.speed)})</span>
          </span>
        } />
        <Row k="Course" v={s.course != null ? `${s.course.toFixed(0)}°` : "—"} />
        <Row k="Heading" v={s.heading != null ? `${s.heading}°` : "—"} />
        <Row k="Update" v={new Date(s.updatedAt).toLocaleTimeString("id-ID")} />
      </Section>
      <Section title="Trail AIS tersimpan">
        <Row k="Posisi terkumpul" v={`${s.trail.length} titik`} />
      </Section>
    </>
  );
}

function GfwDetail({ e }: { e: import("@/lib/types").GfwEvent }) {
  const ec = eventColor(e.type);
  return (
    <>
      <div>
        <div className="text-base font-semibold">{e.shipName || `Vessel ${e.vesselId || ""}`}</div>
        <div className="text-xs text-muted-foreground">{e.id}</div>
      </div>
      <Section title="Identitas">
        <Row k="MMSI" v={e.mmsi} />
        <Row k="Flag" v={e.flag} />
        <Row k="Vessel ID" v={e.vesselId} />
      </Section>
      <Section title="Event">
        <Row k="Tipe" v={
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: ec, boxShadow: `0 0 6px ${ec}` }} />
            <span style={{ color: ec }}>{e.type}</span>
          </span>
        } />
        <Row k="Durasi" v={e.durationHours != null ? `${e.durationHours.toFixed(1)} jam` : "—"} />
        <Row k="Mulai" v={e.start ? new Date(e.start).toLocaleString("id-ID") : "—"} />
        <Row k="Selesai" v={e.end ? new Date(e.end).toLocaleString("id-ID") : "—"} />
      </Section>
      <Section title="Posisi">
        <Row k="Koordinat" v={`${e.lat.toFixed(4)} / ${e.lon.toFixed(4)}`} />
        <Row k="Event ID" v={e.id} />
      </Section>
    </>
  );
}