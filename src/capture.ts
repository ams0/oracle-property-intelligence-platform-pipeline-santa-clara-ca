import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { newStats } from "./lib/http.js";
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
  /** stale = this run's fetch failed and the last good snapshot was reused (see `error`). */
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
  capture?: CaptureResult;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Capture every source into the run's raw directory. Sources run concurrently (they hit
 * different publishers); a failing source is recorded, not fatal, so one slow publisher
 * cannot block the rest of the county.
 */
export async function captureAll(ctx: SourceContext, stateDir: string, only?: string[]): Promise<SourceRunRecord[]> {
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
          capture,
        };
      } catch (err) {
        const durationMs = Date.now() - started;
        const message = (err as Error).message.slice(0, 500);
        ctx.log(`capture ${source.id}: FAILED ${message}`);
        const fallback = await reuseLastGood(source.id, lastGoodDir, ctx.rawDir);
        if (fallback) {
          ctx.log(`capture ${source.id}: reusing last good snapshot from ${fallback.fetchedAt}`);
          const bytes = (await stat(fallback.capture.file)).size;
          return {
            ...base,
            fetchedAt: fallback.fetchedAt,
            status: "stale",
            error: `${message} — reused snapshot fetched ${fallback.fetchedAt} (run ${fallback.runId})`,
            durationMs,
            requests: stats.requests,
            retries: stats.retries,
            bytes,
            rows: fallback.capture.rows,
            rowsPerSecond: 0,
            sha256: await sha256File(fallback.capture.file),
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
