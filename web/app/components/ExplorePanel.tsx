"use client";

import { useEffect, useState } from "react";
import { Circle, CircleMarker, MapContainer, Popup, TileLayer, useMapEvents } from "react-leaflet";
import { fmt } from "./types";

type Mode = "aged" | "permits";
type Row = Record<string, string | number | boolean | null>;

const SANTA_CLARA_COUNTY: [number, number] = [37.3, -121.93];

function PinDrop({ onPin }: { onPin: (lat: number, lon: number) => void }) {
  useMapEvents({ click: (e) => onPin(e.latlng.lat, e.latlng.lng) });
  return null;
}

export function ExplorePanel() {
  const [pin, setPin] = useState<[number, number]>([37.2872, -121.9500]);
  const [radius, setRadius] = useState(2);
  const [minAge, setMinAge] = useState(15);
  const [minYearsOpen, setMinYearsOpen] = useState(0);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [mode, setMode] = useState<Mode>("permits");
  const [result, setResult] = useState<{ summary: Row; results: Row[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setBusy(true);
    const [lat, lon] = pin;
    const body =
      mode === "aged"
        ? { lat, lon, radius_miles: radius, min_roof_age_years: minAge, limit: 200 }
        : { lat, lon, radius_miles: radius, min_years_open: minYearsOpen, include_expired_unfinaled: includeExpired, limit: 200 };
    fetch(`/api/tools/${mode === "aged" ? "find_aged_roofs" : "find_open_roofing_permits"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
      .then((r) => r.json())
      .then((j) => setResult(j))
      .catch(() => undefined)
      .finally(() => setBusy(false));
    return () => ctl.abort();
  }, [pin, radius, minAge, minYearsOpen, includeExpired, mode]);

  function useGps() {
    navigator.geolocation?.getCurrentPosition((p) => setPin([p.coords.latitude, p.coords.longitude]));
  }

  return (
    <>
      <div className="row card" style={{ marginBottom: 12 }}>
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="permits">Open roofing permits (longest open first)</option>
          <option value="aged">Aged roofs</option>
        </select>
        <label>Radius {radius} mi <input type="range" min={0.25} max={10} step={0.25} value={radius} onChange={(e) => setRadius(Number(e.target.value))} /></label>
        {mode === "aged" ? (
          <label>Roof age ≥ <input type="number" min={0} max={100} value={minAge} onChange={(e) => setMinAge(Number(e.target.value))} style={{ width: 64 }} /> yrs</label>
        ) : (
          <>
            <label>Open ≥ <input type="number" min={0} max={40} step={0.5} value={minYearsOpen} onChange={(e) => setMinYearsOpen(Number(e.target.value))} style={{ width: 64 }} /> yrs</label>
            <label><input type="checkbox" checked={includeExpired} onChange={(e) => setIncludeExpired(e.target.checked)} /> include expired without final inspection</label>
          </>
        )}
        <button className="ghost" onClick={useGps}>Use my GPS</button>
        <span className="muted">Click the map to drop a pin · {pin[0].toFixed(4)}, {pin[1].toFixed(4)}</span>
      </div>
      <div className="split">
        <div className="map">
          <MapContainer center={SANTA_CLARA_COUNTY} zoom={11} style={{ height: "100%", width: "100%" }}>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <PinDrop onPin={(lat, lon) => setPin([lat, lon])} />
            <Circle center={pin} radius={radius * 1609.34} pathOptions={{ color: "#b4441b", weight: 1, fillOpacity: 0.05 }} />
            <CircleMarker center={pin} radius={6} pathOptions={{ color: "#b4441b", fillOpacity: 1 }} />
            {result?.results?.map((r, i) =>
              r.lat != null && r.lon != null ? (
                <CircleMarker key={i} center={[Number(r.lat), Number(r.lon)]} radius={4} pathOptions={{ color: mode === "aged" ? "#2f6db3" : "#a3271f", weight: 1, fillOpacity: 0.8 }}>
                  <Popup>
                    <b>{String(r.address)}</b>
                    <br />
                    {mode === "aged"
                      ? `Roof ~${r.roof_age_years} yrs (${r.roof_age_basis}, ${r.roof_age_confidence})`
                      : `${r.status} · ${r.years_open} yrs open · ${r.contractor_name ?? r.contractor_raw ?? "no contractor listed"}${r.contractor_bbb_rating ? ` · BBB ${r.contractor_bbb_rating}` : ""}`}
                  </Popup>
                </CircleMarker>
              ) : null,
            )}
          </MapContainer>
        </div>
        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            {busy ? (
              <span className="muted">Querying…</span>
            ) : (
              <span>
                <b>{fmt(result?.summary?.matches)}</b> matches within {radius} mi
                {mode === "aged"
                  ? ` · ${fmt(result?.summary?.roof_age_from_permit)} dated by a roofing permit, ${fmt(result?.summary?.roof_age_from_year_built)} by year built`
                  : ` · ${fmt(result?.summary?.with_cslb_contractor)} with CSLB contractor · ${fmt(result?.summary?.with_bbb_rating)} with BBB rating`}
                <span className="muted"> (showing up to 200)</span>
              </span>
            )}
          </div>
          <div className="card scroll" style={{ maxHeight: 500 }}>
            <table>
              <thead>
                {mode === "aged" ? (
                  <tr><th>Address</th><th>Roof age</th><th>Basis</th><th>Open roof permits</th><th>mi</th><th>Source</th></tr>
                ) : (
                  <tr><th>Permit</th><th>Address</th><th>Status</th><th>Open</th><th>Contractor</th><th>BBB</th><th>Source</th></tr>
                )}
              </thead>
              <tbody>
                {result?.results?.map((r, i) =>
                  mode === "aged" ? (
                    <tr key={i}>
                      <td>{String(r.address)}<div className="muted mono">APN {String(r.apn)}</div></td>
                      <td>{fmt(r.roof_age_years)} yrs</td>
                      <td className="muted">{String(r.roof_age_basis)}<br />{String(r.roof_age_confidence)} confidence</td>
                      <td>{fmt(r.open_roofing_permits)}</td>
                      <td>{String(r.distance_miles)}</td>
                      <td><a href={String(r.source_url)} target="_blank" rel="noreferrer">{String(r.source_id)}</a></td>
                    </tr>
                  ) : (
                    <tr key={i}>
                      <td className="mono">{String(r.permit_number)}<div className="muted">{String(r.jurisdiction)}</div></td>
                      <td>{String(r.address)}<div className="muted">{String(r.description ?? "").slice(0, 80)}</div></td>
                      <td>{String(r.status)}<div className="muted">issued {String(r.issued_date)}</div></td>
                      <td><b>{String(r.years_open)}</b> yrs</td>
                      <td>
                        {r.contractor_name ? String(r.contractor_name) : r.contractor_raw ? String(r.contractor_raw) : <span className="muted">not listed</span>}
                        {r.contractor_license_number && <div className="muted">CSLB #{String(r.contractor_license_number)} ({String(r.contractor_match_method)})</div>}
                      </td>
                      <td>{r.contractor_bbb_rating ? <a href={String(r.bbb_url)} target="_blank" rel="noreferrer">{String(r.contractor_bbb_rating)}</a> : <span className="muted">—</span>}</td>
                      <td><a href={String(r.source_url)} target="_blank" rel="noreferrer">{String(r.source_id)}</a></td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
