import type { AisShip } from "./types";

const BBOXES: number[][][] = [
  [[-8.0, 105.0], [-4.0, 116.0]],
  [[1.0, 99.0], [6.0, 104.0]],
  [[-8.0, 112.0], [-6.5, 113.5]],
];

export type AisCallbacks = {
  onShip: (ship: AisShip) => void;
  onMessage: () => void;
  onStatus: (online: boolean) => void;
};

export class AisStreamClient {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private cbs: AisCallbacks;
  private ships = new Map<string, AisShip>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(apiKey: string, cbs: AisCallbacks) {
    this.apiKey = apiKey;
    this.cbs = cbs;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.ws?.close();
    this.ws = null;
    this.ships.clear();
    this.cbs.onStatus(false);
  }

  getShips() {
    return Array.from(this.ships.values());
  }

  private connect() {
    try {
      this.ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.cbs.onStatus(true);
      this.ws?.send(JSON.stringify({
        APIKey: this.apiKey,
        BoundingBoxes: BBOXES,
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      }));
    };
    this.ws.onmessage = (ev) => {
      this.cbs.onMessage();
      try {
        const msg = JSON.parse(ev.data);
        this.handle(msg);
      } catch {}
    };
    this.ws.onclose = () => {
      this.cbs.onStatus(false);
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      this.cbs.onStatus(false);
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 4000);
  }

  private handle(msg: any) {
    const meta = msg?.MetaData;
    if (!meta) return;
    const mmsi = String(meta.MMSI ?? meta.MMSI_String ?? "");
    if (!mmsi) return;
    const lat = Number(meta.latitude ?? meta.Latitude);
    const lon = Number(meta.longitude ?? meta.Longitude);
    const now = Date.now();
    const existing = this.ships.get(mmsi) ?? {
      mmsi,
      lat: 0,
      lon: 0,
      updatedAt: now,
      trail: [],
    } as AisShip;

    const type = msg.MessageType;
    if (type === "PositionReport" && Number.isFinite(lat) && Number.isFinite(lon)) {
      const pr = msg.Message?.PositionReport ?? {};
      existing.lat = lat;
      existing.lon = lon;
      existing.speed = pr.Sog;
      existing.course = pr.Cog;
      existing.heading = pr.TrueHeading === 511 ? undefined : pr.TrueHeading;
      existing.navStatus = navStatusLabel(pr.NavigationalStatus);
      existing.updatedAt = now;
      existing.trail.push({ lat, lon, t: now });
      if (existing.trail.length > 120) existing.trail.shift();
    } else if (type === "ShipStaticData") {
      const sd = msg.Message?.ShipStaticData ?? {};
      existing.name = (sd.Name || meta.ShipName || "").trim() || existing.name;
      existing.destination = (sd.Destination || "").trim() || existing.destination;
      existing.updatedAt = now;
      if (Number.isFinite(lat) && Number.isFinite(lon) && !existing.lat) {
        existing.lat = lat; existing.lon = lon;
      }
    }
    if (!existing.name && meta.ShipName) existing.name = String(meta.ShipName).trim();

    this.ships.set(mmsi, existing);
    this.cbs.onShip(existing);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.ships) {
      if (v.updatedAt < cutoff) this.ships.delete(k);
    }
  }
}

function navStatusLabel(code?: number): string | undefined {
  if (code == null) return undefined;
  const map: Record<number, string> = {
    0: "Under way using engine",
    1: "At anchor",
    2: "Not under command",
    3: "Restricted manoeuverability",
    4: "Constrained by draught",
    5: "Moored",
    6: "Aground",
    7: "Engaged in fishing",
    8: "Under way sailing",
    15: "Undefined",
  };
  return map[code] ?? `Status ${code}`;
}

export function speedColor(speed?: number): string {
  if (speed == null || !Number.isFinite(speed)) return "var(--ais-unknown)";
  if (speed < 1) return "var(--ais-stop)";
  if (speed < 5) return "var(--ais-slow)";
  if (speed < 12) return "var(--ais-normal)";
  return "var(--ais-fast)";
}

export function speedLabel(speed?: number): string {
  if (speed == null || !Number.isFinite(speed)) return "Tidak diketahui";
  if (speed < 1) return "Berhenti";
  if (speed < 5) return "Lambat";
  if (speed < 12) return "Normal";
  return "Cepat";
}

export function eventColor(type?: string): string {
  switch ((type || "").toUpperCase()) {
    case "FISHING": return "var(--gfw-fishing)";
    case "ENCOUNTER": return "var(--gfw-encounter)";
    case "LOITERING": return "var(--gfw-loitering)";
    default: return "var(--gfw-other)";
  }
}