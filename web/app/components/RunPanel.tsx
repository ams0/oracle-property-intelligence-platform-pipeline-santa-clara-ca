import { bytes, fmt, type RunData } from "./types";

const STATUS: Record<string, string> = { ok: "ok", stale: "warn", failed: "bad" };

export function RunPanel({ data }: { data: RunData }) {
  const p = data.coverage.property;
  const sum = (k: string) => data.coverage.permitsByJurisdiction.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  return (
    <>
      <div className="grid">
        <div className="card">
          <h3>Current run</h3>
          <div className="big">{data.run_id}</div>
          <div className="muted">published {new Date(data.created_at).toLocaleString()}</div>
          <div className="muted">
            loaded via {data.resolved_via === "ipns_record" ? "signed IPNS record (verified)" : data.resolved_via}
            {data.ipns ? ` · sequence ${data.ipns.sequence}` : ""}
          </div>
        </div>
        <div className="card">
          <h3>Properties (parcels)</h3>
          <div className="big">{fmt(p.properties)}</div>
          <div className="muted">{fmt(p.with_coordinates)} with coordinates · {fmt(p.with_year_built)} with year built</div>
        </div>
        <div className="card">
          <h3>Permits</h3>
          <div className="big">{fmt(data.coverage.tables.permit)}</div>
          <div className="muted">{fmt(sum("roofing"))} roofing · {fmt(sum("roofing_open"))} roofing open · {fmt(sum("roofing_expired_unfinaled"))} expired un-finaled</div>
        </div>
        <div className="card">
          <h3>Contractors · businesses</h3>
          <div className="big">{fmt(data.coverage.tables.contractor)} · {fmt(data.coverage.tables.business)}</div>
          <div className="muted">{fmt(data.coverage.contractor.roofing_licensed)} C-39 roofers · {fmt(data.coverage.contractor.with_bbb_rating)} with BBB rating</div>
        </div>
        <div className="card">
          <h3>Roofing lead signals</h3>
          <div className="big">{fmt(p.roof_age_15_plus)}</div>
          <div className="muted">roofs ≥ 15 yrs ({fmt(p.roof_age_from_permit)} dated by a roofing permit) · {fmt(p.with_open_roofing_permit)} with an open roofing permit</div>
        </div>
        <div className="card">
          <h3>Ownership signals</h3>
          <div className="big">{fmt(p.no_transfer_10y_plus)}</div>
          <div className="muted">no transfer in 10+ yrs · {fmt(p.with_owner)} with owner name · {fmt(p.out_of_area_owners)} out-of-area owners</div>
        </div>
      </div>

      <div className="section">
        <h2>Sources ({data.sources.length}) — records by source with collection timestamps and provenance</h2>
        <div className="card scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Domain</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Collected (UTC)</th>
                <th>Fetch</th>
                <th>Scope</th>
                <th>Limitations</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={s.landingUrl} target="_blank" rel="noreferrer">{s.name}</a>
                    <div className="muted">{s.publisher}</div>
                  </td>
                  <td>{s.domain}</td>
                  <td>
                    <span className={`pill ${STATUS[s.status]}`}>{s.status}</span>
                    {s.error && <div className="muted" style={{ maxWidth: 240 }}>{s.error}</div>}
                  </td>
                  <td>{fmt(s.rows)}</td>
                  <td className="mono">{s.fetchedAt.replace("T", " ").slice(0, 19)}</td>
                  <td className="muted">
                    {(s.durationMs / 1000).toFixed(1)} s · {s.requests} req · {bytes(s.bytes)}
                  </td>
                  <td>{s.scope ?? "full"}</td>
                  <td className="muted" style={{ minWidth: 260 }}>
                    <ul style={{ margin: 0, paddingLeft: 16 }}>{s.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section split">
        <div>
          <h2>Coverage by jurisdiction (permits)</h2>
          <div className="card scroll">
            <table>
              <thead>
                <tr><th>Jurisdiction</th><th>Permits</th><th>Roofing</th><th>Open</th><th>Open 2y+</th><th>Expired, not finaled</th><th>CSLB-linked</th><th>Issued range</th></tr>
              </thead>
              <tbody>
                {data.coverage.permitsByJurisdiction.map((r) => (
                  <tr key={String(r.jurisdiction)}>
                    <td>{r.jurisdiction}</td><td>{fmt(r.permits)}</td><td>{fmt(r.roofing)}</td><td>{fmt(r.roofing_open)}</td>
                    <td>{fmt(r.roofing_open_2y_plus)}</td><td>{fmt(r.roofing_expired_unfinaled)}</td><td>{fmt(r.with_cslb_contractor)}</td>
                    <td className="mono">{String(r.earliest_issued ?? "")} → {String(r.latest_issued ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Permit feeds exist for San Jose, Campbell and Gilroy (~54% of county parcels). Other cities publish no bulk feed or block
              automated access — see <a href="https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-santa-clara-ca/blob/main/docs/source-matrix.md">source matrix</a>.
            </p>
          </div>
        </div>
        <div>
          <h2>Reconciliation</h2>
          <div className="card scroll">
            <table>
              <tbody>
                {data.reconciliation.map((r) => (
                  <tr key={r.check_name}><td className="muted">{r.entity}</td><td>{r.check_name}</td><td style={{ textAlign: "right" }}>{fmt(r.count)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="section card">
        <h3>No Oracle-hosted infrastructure</h3>
        <p style={{ margin: 0 }}>
          This page and the MCP endpoint are a stateless serverless function. On cold start it resolves the signed IPNS record, downloads the
          run&apos;s Parquet tables by CID, checks every byte against the manifest&apos;s SHA-256 ({data.verified_on_load.filter((v) => v.ok).length}/
          {data.verified_on_load.length} verified this load) and queries them in an in-process DuckDB. There is no database server; ingestion runs
          as a scheduled GitHub Actions job; storage is content-addressed on IPFS. Idle cost: $0.
        </p>
      </div>
    </>
  );
}
