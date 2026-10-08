export interface ManifestObject {
  name: string;
  path: string;
  cid: string;
  size: number;
  sha256: string;
  codec: "file" | "directory" | "car";
  ipld_codec: "raw" | "dag-pb";
  root_path?: string;
  gateway_urls: string[];
}

export interface SourceRecord {
  id: string;
  name: string;
  domain: string;
  publisher: string;
  landingUrl: string;
  jurisdictions: string[];
  limitations: string[];
  status: "ok" | "stale" | "failed";
  error?: string;
  fetchedAt: string;
  durationMs: number;
  requests: number;
  retries: number;
  bytes: number;
  rows: number;
  rowsPerSecond: number;
  sha256?: string;
  requestUrls?: string[];
  scope?: string;
}

export type Delta = { added: number; changed: number; removed: number; unchanged: number };

export interface HistoryEntry {
  run_id: string;
  created_at: string;
  mode?: string;
  root_cid: string;
  manifest_cid: string;
  car_cid: string;
  deltas?: Record<string, Delta>;
  ipns?: { name: string; cid: string } | null;
}

export interface RunData {
  run_id: string;
  created_at: string;
  manifest_cid: string;
  resolved_via: string;
  ipns: { name: string; cid: string; sequence: string; source: string; validity: string } | null;
  manifest: {
    run_id: string;
    root: { cid: string; car: ManifestObject };
    objects: ManifestObject[];
    previous_run: { run_id: string; manifest_cid: string; root_cid: string } | null;
    pinning: { provider: string; bucket: string; origins: string[] }[];
  };
  verified_on_load: { path: string; cid: string; ok: boolean; size: number }[];
  coverage: {
    tables: Record<string, number>;
    property: Record<string, string | number>;
    permitsByJurisdiction: Record<string, string | number>[];
    propertiesByJurisdiction: Record<string, string | number>[];
    contractor: Record<string, string | number>;
  };
  sources: SourceRecord[];
  deltas: { previous_run: string | null; previous_root_cid: string | null; deltas: Record<string, Delta> };
  reconciliation: { entity: string; check_name: string; count: number | string }[];
  counts: { t: string; n: number | string }[];
  history: HistoryEntry[];
}

export const fmt = (n: unknown) => (n == null || n === "" ? "—" : Number(n).toLocaleString());
export const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`);
export const short = (cid: string) => `${cid.slice(0, 12)}…${cid.slice(-6)}`;
