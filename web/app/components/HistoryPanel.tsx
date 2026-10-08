"use client";

import { useState } from "react";
import { fmt, short, type RunData } from "./types";

export function HistoryPanel({ data }: { data: RunData }) {
  const [checks, setChecks] = useState<Record<string, string>>({});

  async function stillResolves(rootCid: string) {
    setChecks((c) => ({ ...c, [rootCid]: "checking…" }));
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cid: rootCid, size: 0, sha256: "", codec: "directory", ipld_codec: "dag-pb" }),
    });
    const j = await res.json();
    setChecks((c) => ({
      ...c,
      [rootCid]: `${j.operators_ok} independent operators (${j.gateways_ok}/${j.gateways_checked} public gateways) serve the root block (${j.checks.map((x: { gateway: string; status: number }) => `${new URL(x.gateway).host} ${x.status}`).join(", ")})`,
    }));
  }

  const runs = [...data.history].reverse();
  return (
    <>
      <p className="muted">
        Every run publishes new immutable CIDs; earlier CIDs are never overwritten. The IPNS name moves to the newest manifest.
        Deltas compare each table with the previous run by natural key and a content hash of non-volatile columns.
      </p>
      <div className="card scroll" style={{ maxHeight: "none" }}>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Published</th>
              <th>Root CID</th>
              <th>Manifest CID</th>
              <th>Deltas vs previous run</th>
              <th>Prior CID still resolves?</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((h) => (
              <tr key={h.run_id}>
                <td>
                  <b>{h.run_id}</b>
                  {h.run_id === data.run_id && <div><span className="pill neutral">current (IPNS)</span></div>}
                  {h.mode && <div className="muted">{h.mode}</div>}
                </td>
                <td className="mono">{h.created_at.replace("T", " ").slice(0, 19)}</td>
                <td className="mono" title={h.root_cid}>{short(h.root_cid)}</td>
                <td className="mono" title={h.manifest_cid}>{short(h.manifest_cid)}</td>
                <td>
                  {h.deltas ? (
                    <table>
                      <tbody>
                        {Object.entries(h.deltas).map(([t, d]) => (
                          <tr key={t}>
                            <td className="muted">{t}</td>
                            <td>+{fmt(d.added)}</td>
                            <td>~{fmt(d.changed)}</td>
                            <td>−{fmt(d.removed)}</td>
                            <td className="muted">={fmt(d.unchanged)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td style={{ maxWidth: 320 }}>
                  {checks[h.root_cid] ? (
                    <span className="muted">{checks[h.root_cid]}</span>
                  ) : (
                    <button className="ghost" onClick={() => stillResolves(h.root_cid)}>Check on public gateways</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
