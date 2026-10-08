"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { RunData } from "./components/types";
import { RunPanel } from "./components/RunPanel";
import { ManifestPanel } from "./components/ManifestPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { SqlPanel } from "./components/SqlPanel";
import { McpPanel } from "./components/McpPanel";

const ExplorePanel = dynamic(() => import("./components/ExplorePanel").then((m) => m.ExplorePanel), { ssr: false });

const TABS = ["Run summary", "Artifact manifest", "Run history", "Explore leads", "SQL", "MCP"] as const;
type Tab = (typeof TABS)[number];

export default function Home() {
  const [tab, setTab] = useState<Tab>("Run summary");
  const [data, setData] = useState<RunData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/runs")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setData(j);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <header className="top">
        <h1>Oracle · Santa Clara County, CA</h1>
        <span className="sub">
          Property, permit, contractor and business intelligence for roofing leads — DuckDB over IPFS, MCP-ready
        </span>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <main>
        {error && <div className="card"><span className="pill bad">error</span> {error}</div>}
        {!data && !error && (
          <div className="card muted">
            Resolving the IPNS pointer, downloading the current run&apos;s Parquet tables by CID and verifying their SHA-256…
          </div>
        )}
        {data && tab === "Run summary" && <RunPanel data={data} />}
        {data && tab === "Artifact manifest" && <ManifestPanel data={data} />}
        {data && tab === "Run history" && <HistoryPanel data={data} />}
        {data && tab === "Explore leads" && <ExplorePanel />}
        {data && tab === "SQL" && <SqlPanel />}
        {data && tab === "MCP" && <McpPanel />}
      </main>
    </>
  );
}
