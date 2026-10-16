import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "./api";

export type GeoIP = {
  latitude: number | null;
  longitude: number | null;
  accuracy_radius_km: number | null;
  city: string | null;
  region: string | null;
  country: string | null;
  database_type: string;
  database_build_epoch: number;
};
export type NetworkObservation = {
  observed_at: number;
  received_at: number;
  ip: string;
  source: string;
  geoip: GeoIP | null;
};
type Point = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  observed_at?: number;
};
type Geography = {
  maps: null | {
    min_zoom: number;
    max_zoom: number;
    name: string | null;
    dataset_attribution: string | null;
  };
  geoip: null | { database_type: string; build_epoch: number };
};
export const geoLabel = (g: GeoIP | null | undefined) =>
  g
    ? [g.city, g.region, g.country].filter(Boolean).join(", ") ||
      "Area unavailable"
    : "No estimate available";

export function PrivateMap({
  points,
  selected,
  network,
  label,
}: {
  points: Point[];
  selected?: Point | null;
  network?: NetworkObservation | null;
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    ipBounds = useRef<L.LatLngBounds | null>(null);
  const [status, setStatus] = useState<Geography | null>(null),
    [error, setError] = useState(""),
    [missing, setMissing] = useState(false);
  const signature = JSON.stringify({ points, selected, network });
  useEffect(() => {
    const abort = new AbortController();
    api<Geography>("/geography", { signal: abort.signal })
      .then(setStatus)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!container.current || !status) return;
    const m = L.map(container.current, {
      attributionControl: false,
      scrollWheelZoom: false,
      minZoom: status.maps?.min_zoom || 0,
      maxZoom: status.maps?.max_zoom ?? 18,
    });
    map.current = m;
    m.setView([20, 0], Math.max(status.maps?.min_zoom || 0, 1));
    if (status.maps) {
      L.tileLayer("/api/maps/{z}/{x}/{y}", {
        minZoom: status.maps.min_zoom,
        maxZoom: status.maps.max_zoom,
        noWrap: true,
      })
        .on("tileerror", () => setMissing(true))
        .on("loading", () => setMissing(false))
        .addTo(m);
    }
    const gps = points.map((p) => L.latLng(p.latitude, p.longitude));
    const trail = L.featureGroup().addTo(m);
    if (gps.length > 1)
      L.polyline(gps, { color: "#7862ad", weight: 3 }).addTo(trail);
    points.forEach((p) => {
      const isSelected = p.observed_at === selected?.observed_at;
      L.circleMarker([p.latitude, p.longitude], {
        color: "#544078",
        fillColor: "#9279c8",
        fillOpacity: 1,
        radius: isSelected ? 7 : 4,
        weight: 2,
      })
        .addTo(trail)
        .bindTooltip(
          p.observed_at
            ? new Date(p.observed_at * 1000).toLocaleString()
            : "GPS observation",
        );
    });
    if (selected?.accuracy)
      L.circle([selected.latitude, selected.longitude], {
        radius: selected.accuracy,
        color: "#7862ad",
        weight: 1,
        fillOpacity: 0.08,
      }).addTo(m);
    const g = network?.geoip;
    ipBounds.current = null;
    if (g?.latitude != null && g.longitude != null) {
      const center: L.LatLngTuple = [g.latitude, g.longitude];
      if (g.accuracy_radius_km) {
        const area = L.circle(center, {
          radius: g.accuracy_radius_km * 1000,
          color: "#b77925",
          dashArray: "6 5",
          weight: 2,
          fillOpacity: 0.08,
        }).addTo(m);
        ipBounds.current = area.getBounds();
      } else ipBounds.current = L.latLngBounds(center, center).pad(0.1);
      L.circleMarker(center, {
        radius: 7,
        color: "#a46818",
        fillColor: "#e8b76b",
        fillOpacity: 0.8,
        weight: 2,
      })
        .addTo(m)
        .bindTooltip("Approximate IP area — not a GPS fix");
    }
    if (gps.length)
      m.fitBounds(L.latLngBounds(gps), { padding: [40, 40], maxZoom: 15 });
    else if (ipBounds.current)
      m.fitBounds(ipBounds.current, { padding: [30, 30], maxZoom: 8 });
    else m.setView([20, 0], 1);
    const observer = new ResizeObserver(() => m.invalidateSize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
    };
    // Dataset or observation changes replace the map; unrelated dashboard polls do not reset the view.
  }, [status, signature]);
  return (
    <div className="private-map-wrap">
      <div
        className="private-map"
        ref={container}
        role="img"
        aria-label={label}
      />
      <div className="private-map-key">
        <span>● GPS</span>
        <span className="ip-key">◌ Approximate IP area</span>
        {network?.geoip?.latitude != null && (
          <button
            type="button"
            onClick={() => {
              if (ipBounds.current)
                map.current?.fitBounds(ipBounds.current, {
                  padding: [30, 30],
                  maxZoom: 8,
                });
            }}
          >
            Show IP estimate
          </button>
        )}
      </div>
      <div className="private-map-status" role="status">
        {error ||
          (!status
            ? "Loading local map…"
            : !status.maps
              ? "No local basemap installed · coordinates remain available"
              : missing
                ? "Some tiles are outside local coverage · no external fallback"
                : `Local basemap · ${status.maps.name || "OpenStreetMap"} · no provider requests`)}
      </div>
      <div className="map-attribution">
        ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          OpenStreetMap contributors
        </a>
        {status?.maps?.dataset_attribution && (
          <span> · {status.maps.dataset_attribution}</span>
        )}
      </div>
    </div>
  );
}

export function NetworkCard({
  network,
}: {
  network?: NetworkObservation | null;
}) {
  const [status, setStatus] = useState<Geography | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    api<Geography>("/geography", { signal: abort.signal })
      .then(setStatus)
      .catch(() => {});
    return () => abort.abort();
  }, []);
  return (
    <div className="network-card">
      <div>
        <span className="eyebrow">CONNECTION ADDRESS</span>
        <strong>{network?.ip || "Waiting for a tunnel observation"}</strong>
        <small>
          {network
            ? `Authenticated WireGuard peer · observed ${new Date(network.observed_at * 1000).toLocaleString()}`
            : "Captured at home, even without GPS. No public-IP lookup service."}
        </small>
      </div>
      <div>
        <span className="eyebrow">APPROXIMATE IP LOCATION</span>
        <strong>{geoLabel(network?.geoip)}</strong>
        <small>
          {network?.geoip
            ? `${network.geoip.accuracy_radius_km ? `Database radius: ${network.geoip.accuracy_radius_km} km · ` : "Radius unknown · "}${network.geoip.database_type} · built ${new Date(network.geoip.database_build_epoch * 1000).toLocaleDateString()}`
            : status?.geoip
              ? "No matching public-address location in the local database."
              : "Install a local City MMDB dataset to enable GeoIP."}
        </small>
      </div>
      {(network?.geoip?.database_type || status?.geoip?.database_type)
        ?.toLowerCase()
        .includes("dbip") && (
        <p>
          IP geolocation by{" "}
          <a href="https://db-ip.com/" target="_blank" rel="noreferrer">
            DB-IP
          </a>{" "}
          · Lite data under{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC BY 4.0
          </a>
          .
        </p>
      )}
      {/geolite|geoip/i.test(
        network?.geoip?.database_type || status?.geoip?.database_type || "",
      ) && (
        <p>
          Includes GeoLite2/GeoIP data created by{" "}
          <a href="https://www.maxmind.com/" target="_blank" rel="noreferrer">
            MaxMind
          </a>
          .
        </p>
      )}
      <p>
        IP location describes a network exit. Mobile carriers, NAT, VPNs and
        proxies can place it far from the phone. It never replaces GPS.
      </p>
    </div>
  );
}
