import type { FetchStats } from "../lib/http.js";

export type Domain = "property" | "ownership" | "permit" | "contractor" | "rating" | "business";

export interface SourceContext {
  runId: string;
  /** Directory for this run's raw captures (one file per source). */
  rawDir: string;
  /** Incremental runs fetch only a bounded window where the source supports it. */
  mode: "full" | "incremental";
  /** Lower bound for windowed fetches (ISO date); from the previous run's watermark. */
  since?: string;
  log: (msg: string) => void;
}

export interface SourceDescriptor {
  id: string;
  name: string;
  domain: Domain;
  publisher: string;
  /** Human-browsable landing page, recorded as provenance on every row. */
  landingUrl: string;
  jurisdictions: string[];
  /** Known constraints, carried into the run summary verbatim. */
  limitations: string[];
  /**
   * Pin each complete capture to IPFS (registry: runs/last-good.json) so a run on a fresh
   * machine can fall back to it by CID. Set for publishers that throttle or truncate.
   */
  snapshot?: "ipfs";
  fetch(ctx: SourceContext, stats: FetchStats): Promise<CaptureResult>;
}

export interface CaptureResult {
  file: string;
  format: "csv" | "ndjson" | "parquet";
  rows: number;
  /** Request URLs (or URL templates) actually used. */
  requestUrls: string[];
  /** "full" snapshot, or "window" when only records changed since `since` were fetched. */
  scope: "full" | "window";
  windowSince?: string;
  notes?: string[];
}
