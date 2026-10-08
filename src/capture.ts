import { copyFile, mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { hasFilebaseCredentials } from "./lib/filebase.js";
import { sha256File } from "./lib/hash.js";
import { newStats } from "./lib/http.js";
import { fetchSnapshot, pinSnapshot } from "./snapshots.js";
import { SOURCES } from "./sources/registry.js";
import type { CaptureResult, SourceContext, SourceDescriptor } from "./sources/types.js";

export interface SourceRunRecord {
  id: string;
  name: string;
  domain: SourceDescriptor["domain"];
  publisher: string;
  landingUrl: string;
  jurisdictions: string[];
  limitations: string[];
  /** stale = this run's fetch failed and the last good snapshot was reused (see `error`, `snapshotCid`). */
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
  /** CID of the pinned raw capture (sources with `snapshot: "ipfs"`), fresh or reused. */
  snapshotCid?: string;
  capture?: CaptureResult;
}

export { sha256File };

/**
 * Capture every source into the run's raw directory. Sources run concurrently (they hit
 * different publishers); a failing source is recorded, not fatal, so one slow publisher
 * cannot block the rest of the county.
 */
export async function captureAll(ctx: SourceContext, stateDir: string, registryPath: string, only?: string[]): Promise<SourceRunRecord[]> {
  const lastGoodDir = join(stateDir, "last_good");
  await mkdir(lastGoodDir, { recursive: true });
  await mkdir(ctx.rawDir, { recursive: true });
  const selected = SOURCES.filter((s) => !only?.length || only.includes(s.id));
  return Promise.all(
    selected.map(async (source): Promise<SourceRunRecord> => {
      const stats = newStats();
      const started = Date.now();
      const base = {
        id: source.id,
        name: source.name,
        domain: source.domain,
        publisher: source.publisher,
        landingUrl: source.landingUrl,
        jurisdictions: source.jurisdictions,
        limitations: source.limitations,
        fetchedAt: new Date().toISOString(),
      };
      try {
        ctx.log(`capture ${source.id}: start`);
        const capture = await source.fetch(ctx, stats);
        const durationMs = Date.now() - started;
        const bytes = (await stat(capture.file)).size;
        ctx.log(`capture ${source.id}: ${capture.rows} rows in ${(durationMs / 1000).toFixed(1)}s`);
        // Keep the newest complete capture so a later outage can fall back to it.
        const keep = join(lastGoodDir, basename(capture.file));
        await copyFile(capture.file, keep);
        await writeFile(`${keep}.json`, JSON.stringify({ fetchedAt: base.fetchedAt, runId: ctx.runId, capture }));
        let snapshotCid: string | undefined;
        if (source.snapshot === "ipfs" && hasFilebaseCredentials()) {
          // Best effort: a pinning hiccup must not discard a good capture.
          snapshotCid = await pinSnapshot(source.id, capture, { fetchedAt: base.fetchedAt, runId: ctx.runId }, registryPath, ctx.log)
            .then((e) => e.cid)
            .catch((err: Error) => (ctx.log(`snapshot ${source.id}: pin failed ${err.message}`), undefined));
        }
        return {
          ...base,
          status: "ok",
          durationMs,
          requests: stats.requests,
          retries: stats.retries,
          bytes,
          rows: capture.rows,
          rowsPerSecond: Math.round(capture.rows / Math.max(durationMs / 1000, 0.001)),
          sha256: await sha256File(capture.file),
          snapshotCid,
          capture,
        };
      } catch (err) {
        const durationMs = Date.now() - started;
        const message = (err as Error).message.slice(0, 500);
        ctx.log(`capture ${source.id}: FAILED ${message}`);
        // Local copy first (same machine), then the IPFS-pinned copy by CID (fresh CI runner).
        const fallback =
          (await reuseLastGood(source.id, lastGoodDir, ctx.rawDir)) ??
          (await fetchSnapshot(source.id, registryPath, ctx.rawDir).catch((e: Error) => (ctx.log(`capture ${source.id}: snapshot fetch failed ${e.message}`), undefined)));
        if (fallback) {
          const fallbackCid = "cid" in fallback ? (fallback.cid as string) : undefined;
          const from = fallbackCid ? `IPFS ${fallbackCid}` : "local state";
          ctx.log(`capture ${source.id}: reusing last good snapshot from ${fallback.fetchedAt} (${from})`);
          const bytes = (await stat(fallback.capture.file)).size;
          return {
            ...base,
            fetchedAt: fallback.fetchedAt,
            status: "stale",
            error: `${message} — reused snapshot fetched ${fallback.fetchedAt} (run ${fallback.runId}, ${from})`,
            durationMs,
            requests: stats.requests,
            retries: stats.retries,
            bytes,
            rows: fallback.capture.rows,
            rowsPerSecond: 0,
            sha256: await sha256File(fallback.capture.file),
            snapshotCid: fallbackCid,
            capture: fallback.capture,
          };
        }
        return {
          ...base,
          status: "failed",
          error: message,
          durationMs,
          requests: stats.requests,
          retries: stats.retries,
          bytes: 0,
          rows: 0,
          rowsPerSecond: 0,
        };
      }
    }),
  );
}

async function reuseLastGood(
  sourceId: string,
  lastGoodDir: string,
  rawDir: string,
): Promise<{ fetchedAt: string; runId: string; capture: CaptureResult } | undefined> {
  for (const ext of [".csv", ".ndjson", ".parquet"]) {
    const kept = join(lastGoodDir, `${sourceId}${ext}`);
    try {
      const meta = JSON.parse(await readFile(`${kept}.json`, "utf8")) as { fetchedAt: string; runId: string; capture: CaptureResult };
      const file = join(rawDir, `${sourceId}${extname(kept)}`);
      await copyFile(kept, file);
      return { ...meta, capture: { ...meta.capture, file } };
    } catch {
      // try next extension
    }
  }
  return undefined;
}
