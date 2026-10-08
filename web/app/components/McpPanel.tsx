"use client";

import { useEffect, useState } from "react";

const TOOL_NAMES = ["find_aged_roofs", "find_open_roofing_permits", "find_long_held_properties", "get_property", "get_contractor", "query_sql", "get_pipeline_run"];

export function McpPanel() {
  const [origin, setOrigin] = useState("");
  const [tools, setTools] = useState<{ name: string; title: string; description: string }[]>([]);
  useEffect(() => {
    setOrigin(window.location.origin);
    Promise.all(TOOL_NAMES.map((n) => fetch(`/api/tools/${n}`).then((r) => r.json()))).then(setTools);
  }, []);
  const url = `${origin}/api/mcp`;
  return (
    <>
      <div className="grid">
        <div className="card">
          <h3>MCP endpoint (Streamable HTTP, stateless)</h3>
          <div className="mono">{url}</div>
          <p className="muted">No auth: the data is public. Any MCP client (Claude, Cursor, the Roofing CRM agent) can connect.</p>
        </div>
        <div className="card">
          <h3>Claude Code / Desktop</h3>
          <pre>{`claude mcp add --transport http oracle-scc ${url}`}</pre>
          <pre>{JSON.stringify({ mcpServers: { "oracle-scc": { url } } }, null, 2)}</pre>
        </div>
        <div className="card">
          <h3>Plain HTTP mirror</h3>
          <pre>{`curl -s -X POST ${origin}/api/tools/find_open_roofing_permits \\
  -H 'content-type: application/json' \\
  -d '{"near":"Campbell","radius_miles":5,"min_years_open":2}'`}</pre>
        </div>
      </div>
      <div className="section card">
        <table>
          <thead><tr><th>Tool</th><th>What it answers</th></tr></thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}><td className="mono">{t.name}</td><td><b>{t.title}</b><div className="muted">{t.description}</div></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        The MCP tools and this explorer read the same published tables, so agents and the CRM use the same data model without changes. Every tool
        result includes the run id, manifest CID, root CID and the verified IPNS resolution it was answered from.
      </p>
    </>
  );
}
