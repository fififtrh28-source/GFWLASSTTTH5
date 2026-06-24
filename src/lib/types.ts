export type AisShip = {
  mmsi: string;
  name?: string;
  destination?: string;
  navStatus?: string;
  lat: number;
  lon: number;
  speed?: number; // knots
  course?: number;
  heading?: number;
  updatedAt: number;
  trail: Array<{ lat: number; lon: number; t: number }>;
};

export type GfwEvent = {
  id: string;
  type: "FISHING" | "ENCOUNTER" | "LOITERING" | string;
  start: string;
  end: string;
  durationHours?: number;
  lat: number;
  lon: number;
  vesselId?: string;
  mmsi?: string;
  flag?: string;
  shipName?: string;
};

export type TrackPoint = {
  lat: number;
  lon: number;
  timestamp?: string;
  speed?: number;
  course?: number;
};

export type TrackResponse = {
  vessel_id: string;
  start_date: string;
  end_date: string;
  source: string;
  count: number;
  bounds?: [[number, number], [number, number]] | null;
  track: TrackPoint[];
};

export type VesselSearchResult = {
  vessel_id: string;
  ship_name?: string;
  mmsi?: string;
  imo?: string;
  flag?: string;
  callsign?: string;
};

export type GfwrQuery = {
  id: string;
  name: string;
  category: string;
  endpoint: string;
  datasets: string[];
  params: Record<string, string>;
  description?: string;
};

export type Mode = "ais" | "gfw";

export type Selection =
  | { kind: "ais"; ship: AisShip }
  | { kind: "gfw"; event: GfwEvent }
  | null;