import { createWriteStream } from "node:fs";
import { fetchJson, mapLimit, type FetchStats } from "./http.js";

interface LayerInfo {
  maxRecordCount?: number;
  objectIdField?: string;
  fields?: { name: string; type: string }[];
}
interface QueryResponse {
  features?: { attributes: Record<string, unknown>; geometry?: { x?: number; y?: number } }[];
  count?: number;
  error?: { message: string };
}

/**
 * Page an ArcGIS FeatureServer layer into NDJSON. Pages are fetched by offset with bounded
 * concurrency; ordering by object id keeps pages stable and the fetch idempotent.
 */
export async function dumpArcgisLayer(
  layerUrl: string,
  out: string,
  stats: FetchStats,
  { where = "1=1", outFields = "*", geometry = false, concurrency = 4 } = {},
): Promise<{ rows: number; requestUrl: string }> {
  const info = await fetchJson<LayerInfo>(`${layerUrl}?f=json`, stats);
  const oid =
    info.objectIdField ?? info.fields?.find((f) => f.type === "esriFieldTypeOID")?.name ?? "OBJECTID";
  const pageSize = Math.min(info.maxRecordCount ?? 1000, 2000);
  const countRes = await fetchJson<QueryResponse>(
    `${layerUrl}/query?${new URLSearchParams({ where, returnCountOnly: "true", f: "json" })}`,
    stats,
  );
  if (countRes.error) throw new Error(`${layerUrl}: ${countRes.error.message}`);
  const total = countRes.count ?? 0;
  const offsets = Array.from({ length: Math.ceil(total / pageSize) }, (_, i) => i * pageSize);
  const base = {
    where,
    outFields,
    orderByFields: oid,
    returnGeometry: String(geometry),
    outSR: "4326",
    resultRecordCount: String(pageSize),
    f: "json",
  };
  const sink = createWriteStream(out);
  let rows = 0;
  // Fetch in batches so memory stays bounded while writes stay in order.
  for (let b = 0; b < offsets.length; b += concurrency * 4) {
    const batch = offsets.slice(b, b + concurrency * 4);
    const pages = await mapLimit(batch, concurrency, (offset) =>
      fetchJson<QueryResponse>(
        `${layerUrl}/query?${new URLSearchParams({ ...base, resultOffset: String(offset) })}`,
        stats,
      ),
    );
    for (const page of pages) {
      if (page.error) throw new Error(`${layerUrl}: ${page.error.message}`);
      for (const f of page.features ?? []) {
        const row = { ...f.attributes, _x: f.geometry?.x ?? null, _y: f.geometry?.y ?? null };
        sink.write(JSON.stringify(row) + "\n");
        rows++;
      }
    }
  }
  await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve())));
  if (rows !== total) throw new Error(`${layerUrl}: expected ${total} rows, got ${rows}`);
  return { rows, requestUrl: `${layerUrl}/query?where=${encodeURIComponent(where)}` };
}
