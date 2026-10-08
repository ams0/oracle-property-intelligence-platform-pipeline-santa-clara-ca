"use client";

import { useState } from "react";

const EXAMPLES: Record<string, string> = {
  "Roofs ≥ 15 yrs by city": `SELECT city, count(*) AS properties,
       count(*) FILTER (WHERE roof_age_years >= 15) AS roof_15_plus,
       count(*) FILTER (WHERE roof_age_basis LIKE 'roofing_permit%') AS dated_by_permit
FROM property GROUP BY city ORDER BY properties DESC`,
  "Longest-open roofing permits": `SELECT permit_key, address, issued_date, days_open, contractor_name, contractor_bbb_rating, source_url
FROM permit WHERE is_roofing AND status = 'open'
ORDER BY days_open DESC`,
  "Top roofing contractors by permits": `SELECT business_name, license_number, license_status, bbb_rating, roofing_permits, unfinaled_roofing_permits
FROM contractor WHERE roofing_permits > 0 ORDER BY roofing_permits DESC`,
  "Not sold 10+ yrs within 2 mi of Willow Glen": `SELECT apn, address, last_transfer_year, transfer_basis, roof_age_years
FROM property
WHERE miles(37.3015, -121.8979, lat, lon) <= 2 AND years_since_transfer > 10
ORDER BY years_since_transfer DESC`,
};

export function SqlPanel() {
  const [sql, setSql] = useState(Object.values(EXAMPLES)[0]!);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState(0);

  async function run() {
    setBusy(true);
    setErr(null);
    const t = Date.now();
    const res = await fetch("/api/tools/query_sql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, limit: 200 }) });
    const j = await res.json();
    setMs(Date.now() - t);
    setBusy(false);
    if (!res.ok) return setErr(typeof j.error === "string" ? j.error : JSON.stringify(j.error));
    setRows(j.rows);
  }

  const cols = rows?.[0] ? Object.keys(rows[0]) : [];
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        {Object.entries(EXAMPLES).map(([k, v]) => (
          <button key={k} className="ghost" onClick={() => setSql(v)}>{k}</button>
        ))}
      </div>
      <textarea rows={7} value={sql} onChange={(e) => setSql(e.target.value)} />
      <div className="row" style={{ margin: "8px 0" }}>
        <button className="act" onClick={run} disabled={busy}>{busy ? "Running…" : "Run (read-only)"}</button>
        <span className="muted">DuckDB over the run&apos;s Parquet tables · {rows ? `${rows.length} rows · ${ms} ms` : "max 200 rows"}</span>
      </div>
      {err && <div className="card"><span className="pill bad">error</span> {err}</div>}
      {rows && (
        <div className="card scroll">
          <table>
            <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => {
                    const v = r[c];
                    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
                    return <td key={c}>{s.startsWith("http") ? <a href={s} target="_blank" rel="noreferrer">source</a> : s}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
