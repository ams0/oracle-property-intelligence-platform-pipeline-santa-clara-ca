"use client";

import { useState } from "react";
import { bytes, short, type ManifestObject, type RunData } from "./types";

interface Check {
  gateway: string;
  operator: string;
  servedBy?: string;
  url: string;
  status: number | string;
  ms: number;
  size?: number;
  sha256?: string;
  ok: boolean;
  error?: string;
}

export function ManifestPanel({ data }: { data: RunData }) {
  const [results, setResults] = useState<Record<string, { ok: boolean; gateways_ok: number; gateways_checked: number; operators_ok: number; checks: Check[]; checked_at: string } | "pending">>({});
  const m = data.manifest;
  const objects: ManifestObject[] = [
    { ...m.root.car, name: "(run root directory)", path: "/", cid: m.root.cid, codec: "directory", ipld_codec: "dag-pb", sha256: "", size: 0, gateway_urls: [] },
    ...m.objects,
  ];

  async function verify(o: ManifestObject) {
    setResults((r) => ({ ...r, [o.cid]: "pending" }));
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cid: o.cid, size: o.size, sha256: o.sha256, codec: o.codec, ipld_codec: o.ipld_codec }),
    });
    const j = await res.json();
    setResults((r) => ({ ...r, [o.cid]: j }));
  }

  return (
    <>
      <div className="grid">
        <div className="card">
          <h3>Manifest CID (this run)</h3>
          <div className="mono">{data.manifest_cid}</div>
          <div className="muted">
            JSON manifest, CIDv1 raw · <a href={`https://ipfs.io/ipfs/${data.manifest_cid}?format=raw`} target="_blank" rel="noreferrer">raw bytes on ipfs.io</a>
          </div>
        </div>
        <div className="card">
          <h3>IPNS pointer</h3>
          <div className="mono">{data.ipns?.name ?? "—"}</div>
          <div className="muted">
            resolves to <span className="mono">{data.ipns ? short(data.ipns.cid) : "—"}</span> (sequence {data.ipns?.sequence ?? "—"}, signature verified
            via {data.ipns?.source ?? "—"})
          </div>
        </div>
        <div className="card">
          <h3>Run root (directory) + CAR</h3>
          <div className="mono">{m.root.cid}</div>
          <div className="muted">
            CAR of the DAG: <span className="mono">{short(m.root.car.cid)}</span> ({bytes(m.root.car.size)})
          </div>
        </div>
      </div>

      <div className="section card scroll" style={{ maxHeight: "none" }}>
        <table>
          <thead>
            <tr>
              <th>Logical name</th>
              <th>CID (v1)</th>
              <th>Codec</th>
              <th>Size</th>
              <th>SHA-256</th>
              <th>Public-gateway check</th>
            </tr>
          </thead>
          <tbody>
            {objects.map((o) => {
              const r = results[o.cid];
              return (
                <tr key={o.cid + o.path}>
                  <td>{o.path}</td>
                  <td className="mono" title={o.cid}>{short(o.cid)}</td>
                  <td>{o.codec}{o.codec !== "directory" ? ` · ${o.ipld_codec}` : ""}</td>
                  <td>{o.size ? bytes(o.size) : "—"}</td>
                  <td className="mono" title={o.sha256}>{o.sha256 ? `${o.sha256.slice(0, 12)}…` : "—"}</td>
                  <td>
                    {!r && <button className="ghost" onClick={() => verify(o)}>Fetch from 5 public gateways (3 operators)</button>}
                    {r === "pending" && <span className="muted">fetching by CID and hashing…</span>}
                    {r && r !== "pending" && (
                      <div>
                        <span className={`pill ${r.ok ? "ok" : "bad"}`}>{r.operators_ok} independent operators · {r.gateways_ok}/{r.gateways_checked} gateways match</span>
                        {r.checks.map((c) => (
                          <div key={c.gateway} className="muted mono">
                            {new URL(c.gateway).host}{c.servedBy && c.servedBy !== new URL(c.gateway).host ? ` → ${c.servedBy}` : ""} ({c.operator}): {String(c.status)} · {c.ms} ms
                            {c.size != null ? ` · ${bytes(c.size)} · sha256 ${c.sha256?.slice(0, 10)}… ${c.ok ? "✓" : "✗"}` : c.ok ? " · root block ✓" : ` ✗ ${c.error ?? ""}`}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Gateways are queried with trustless requests (<code>?format=raw</code> / <code>?format=car</code>): every block is hashed against its CID and the
        rebuilt file is compared with the manifest size and SHA-256. ipfs.io and dweb.link stopped serving plain (non-trustless) HTTP responses on
        2026-09-21, so links without <code>?format=</code> return 429 there. Pinned by: {m.pinning.map((p) => p.provider).join(", ")}.
      </p>
    </>
  );
}
