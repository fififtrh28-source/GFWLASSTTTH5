import { useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import type { AisShip, GfwEvent, TrackPoint } from "@/lib/types";
import { speedColor, eventColor } from "@/lib/aisstream";

type Props = {
  mode: "ais" | "gfw";
  ships: AisShip[];
  events: GfwEvent[];
  selectedKey: string | null;
  onSelectShip: (s: AisShip) => void;
  onSelectEvent: (e: GfwEvent) => void;
  trajectory: TrackPoint[] | null;
  trailShip: AisShip | null;
  zoomTarget: { lat: number; lon: number; key: number } | null;
};

function shipIcon(ship: AisShip): L.DivIcon {
  const color = speedColor(ship.speed);
  const angle = ship.heading ?? ship.course ?? 0;
  const html = `
    <div style="
      width:18px;height:18px;
      transform: rotate(${angle}deg);
      transform-origin:center;
      filter: drop-shadow(0 0 4px ${color});
    ">
      <svg viewBox="0 0 20 20" width="18" height="18">
        <path d="M10 1 L17 17 L10 13 L3 17 Z" fill="${color}" stroke="#0d1117" stroke-width="1" stroke-linejoin="round"/>
      </svg>
    </div>`;
  return L.divIcon({
    html,
    className: "ais-ship-icon",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function eventIcon(ev: GfwEvent): L.DivIcon {
  const color = eventColor(ev.type);
  const html = `<div style="
    width:12px;height:12px;border-radius:50%;
    background:${color};
    border:1.5px solid #0d1117;
    box-shadow:0 0 6px ${color};
  "></div>`;
  return L.divIcon({
    html,
    className: "gfw-event-icon",
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

function FlyTo({ target }: { target: Props["zoomTarget"] }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lon], Math.max(map.getZoom(), 11), { duration: 1.2 });
  }, [target?.key]);
  return null;
}

function FitBounds({ track }: { track: TrackPoint[] | null }) {
  const map = useMap();
  useEffect(() => {
    if (!track || track.length < 2) return;
    const b = L.latLngBounds(track.map(p => [p.lat, p.lon]));
    map.fitBounds(b, { padding: [80, 80] });
  }, [track]);
  return null;
}

export default function MapView(props: Props) {
  const { mode, ships, events, onSelectShip, onSelectEvent, trajectory, trailShip, zoomTarget } = props;

  const trailLine = useMemo(() => {
    if (!trailShip) return null;
    return trailShip.trail.map(p => [p.lat, p.lon] as [number, number]);
  }, [trailShip]);

  return (
    <MapContainer
      center={[-2.5, 117.0]}
      zoom={5}
      zoomControl={false}
      style={{ width: "100%", height: "100%" }}
      worldCopyJump
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://carto.com">CARTO</a> &copy; OpenStreetMap'
        subdomains="abcd"
        maxZoom={19}
      />
      <ZoomControlBR />
      <FlyTo target={zoomTarget} />
      <FitBounds track={trajectory} />

      {mode === "ais" && ships.map((s) => (
        Number.isFinite(s.lat) && Number.isFinite(s.lon) ? (
          <Marker
            key={s.mmsi}
            position={[s.lat, s.lon]}
            icon={shipIcon(s)}
            eventHandlers={{ click: () => onSelectShip(s) }}
          />
        ) : null
      ))}

      {mode === "gfw" && events.map((e) => (
        <Marker
          key={e.id}
          position={[e.lat, e.lon]}
          icon={eventIcon(e)}
          eventHandlers={{ click: () => onSelectEvent(e) }}
        />
      ))}

      {/* AIS trail polyline */}
      {trailLine && trailLine.length > 1 && (
        <Polyline positions={trailLine} pathOptions={{ color: "#f85149", weight: 2.5, opacity: 0.85 }} />
      )}

      {/* Trajectory from GFW track API */}
      {trajectory && trajectory.length > 1 && (
        <>
          <Polyline
            positions={trajectory.map(p => [p.lat, p.lon] as [number, number])}
            pathOptions={{ color: "#f85149", weight: 2.5, opacity: 0.9 }}
          />
          <CircleMarker
            center={[trajectory[0].lat, trajectory[0].lon]}
            radius={6}
            pathOptions={{ color: "#3fb950", fillColor: "#3fb950", fillOpacity: 1 }}
          >
            <Popup>Start{trajectory[0].timestamp ? ` — ${trajectory[0].timestamp}` : ""}</Popup>
          </CircleMarker>
          <CircleMarker
            center={[trajectory[trajectory.length-1].lat, trajectory[trajectory.length-1].lon]}
            radius={6}
            pathOptions={{ color: "#f85149", fillColor: "#f85149", fillOpacity: 1 }}
          >
            <Popup>End{trajectory[trajectory.length-1].timestamp ? ` — ${trajectory[trajectory.length-1].timestamp}` : ""}</Popup>
          </CircleMarker>
          {sampleWaypoints(trajectory).map((p, i) => (
            <CircleMarker
              key={i}
              center={[p.lat, p.lon]}
              radius={3}
              pathOptions={{ color: "#f8e12d", fillColor: "#f8e12d", fillOpacity: 1, weight: 1 }}
            >
              <Popup>
                <div style={{ fontSize: 12 }}>
                  {p.timestamp && <div>🕒 {p.timestamp}</div>}
                  {p.speed != null && <div>⚡ {p.speed.toFixed(1)} kn</div>}
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </>
      )}
    </MapContainer>
  );
}

function ZoomControlBR() {
  const map = useMap();
  useEffect(() => {
    const ctrl = L.control.zoom({ position: "bottomright" });
    ctrl.addTo(map);
    return () => { ctrl.remove(); };
  }, [map]);
  return null;
}

function sampleWaypoints(track: TrackPoint[]) {
  if (track.length <= 12) return track.slice(1, -1);
  const step = Math.ceil(track.length / 12);
  const out: TrackPoint[] = [];
  for (let i = step; i < track.length - 1; i += step) out.push(track[i]);
  return out;
}