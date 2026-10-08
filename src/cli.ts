import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureAll, type SourceRunRecord } from "./capture.js";
import { buildRun } from "./build.js";
import { computeDeltas } from "./deltas.js";
import { publishRun, readManifest, type RunHistoryEntry } from "./publish.js";
import { verifyManifest } from "./verify.js";
import { copyFile } from "node:fs/promises";

const ROOT = resolve(process.env.ORACLE_DATA_DIR ?? "data");
/** Committed, human-readable run history (manifests, coverage, verification) lives in the repo. */
const REPO_RUNS = resolve(process.env.ORACLE_RUNS_DIR ?? "runs");
const HISTORY = join(REPO_RUNS, "history.json");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "full" },
    since: { type: "string" },
    run: { type: "string" },
    only: { type: "string" },
  },
});

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const command = positionals[0] ?? "help";
const runId = values.run ?? new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
const runDir = join(ROOT, "runs", runId);

async function main() {
  switch (command) {
    case "capture": {
      await mkdir(runDir, { recursive: true });
      const records = await captureAll(
        {
          runId,
          rawDir: join(runDir, "raw"),
          mode: values.mode === "incremental" ? "incremental" : "full",
          since: values.since,
          log,
        },
        join(ROOT, "state"),
        values.only?.split(","),
      );
      // A partial re-capture (--only) replaces just those sources in the run record.
      const previous = await readRecords().catch(() => [] as SourceRunRecord[]);
      const merged = [...previous.filter((p) => !records.some((r) => r.id === p.id)), ...records];
      await writeFile(join(runDir, "sources.json"), JSON.stringify(merged, null, 2));
      printSummary(merged);
      log(`run ${runId} captured into ${runDir}`);
      break;
    }
    case "summary": {
      printSummary(await readRecords());
      break;
    }
    case "publish": {
      const history = (await readHistory()).filter((h) => h.run_id !== runId);
      const previous = history.at(-1) ?? null;
      const publishDir = join(runDir, "publish");
      // Change detection against the previous run's published tables (read straight from IPFS).
      const previousBase = previous ? `${process.env.ORACLE_READ_GATEWAY ?? "https://ipfs.filebase.io"}/ipfs/${previous.root_cid}` : null;
      const deltas = await computeDeltas(publishDir, previousBase);
      await writeFile(join(publishDir, "deltas.json"), JSON.stringify({ previous_run: previous?.run_id ?? null, previous_root_cid: previous?.root_cid ?? null, deltas }, null, 2));
      await writeFile(join(publishDir, "history.json"), JSON.stringify(history, null, 2));
      const records = await readRecords();
      const counts = JSON.parse(await readFile(join(publishDir, "coverage.json"), "utf8")).tables as Record<string, number>;
      const result = await publishRun({
        runDir,
        runId,
        mode: values.mode ?? "full",
        counts,
        previous,
        deltas,
        sources: records.map((r) => ({ id: r.id, status: r.status, rows: r.rows, fetchedAt: r.fetchedAt })),
        log,
      });
      const entry = { ...result.history, ipns: result.ipns };
      await writeHistory([...history.filter((h) => h.run_id !== runId), entry]);
      const repoRun = join(REPO_RUNS, runId);
      await mkdir(repoRun, { recursive: true });
      for (const f of ["manifest.json", "publish-result.json"]) await copyFile(join(runDir, f), join(repoRun, f));
      for (const f of ["coverage.json", "reconciliation.json", "sources.json", "deltas.json"]) await copyFile(join(publishDir, f), join(repoRun, f));
      log(`publish ${runId}: root ${result.history.root_cid} manifest ${result.manifestCid}`);
      console.table(Object.entries(deltas).map(([table, d]) => ({ table, ...d })));
      break;
    }
    case "verify": {
      const manifest = await readManifest(runDir);
      const report = await verifyManifest(manifest);
      const out = { run_id: runId, verified_at: new Date().toISOString(), all_ok: report.every((r) => r.ok), objects: report };
      await mkdir(join(REPO_RUNS, runId), { recursive: true });
      await writeFile(join(REPO_RUNS, runId, "verification.json"), JSON.stringify(out, null, 2));
      console.table(report.map((r) => ({ object: r.name, cid: r.cid.slice(0, 18) + "…", ok: r.ok, gateways_ok: r.independentGatewaysOk, ...Object.fromEntries(r.checks.map((c) => [new URL(c.gateway).host, `${c.status}${c.ok ? " ✓" : ""}`])) })));
      if (!out.all_ok) process.exitCode = 2;
      break;
    }
    case "build": {
      const asOf = runId.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date().toISOString().slice(0, 10);
      const started = Date.now();
      const previous = (await readHistory()).filter((h) => h.run_id !== runId).at(-1);
      const previousRoot = previous ? `${process.env.ORACLE_READ_GATEWAY ?? "https://ipfs.filebase.io"}/ipfs/${previous.root_cid}` : null;
      const result = await buildRun(runDir, runId, await readRecords(), asOf, previousRoot);
      log(`build ${runId}: ${JSON.stringify(result.counts)} in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${result.outDir}`);
      break;
    }
    default:
      console.log("usage: pipeline <capture|build|publish|verify|summary> [--mode full|incremental] [--since YYYY-MM-DD] [--run <id>] [--only a,b]");
  }
}

async function readHistory(): Promise<(RunHistoryEntry & { ipns?: unknown })[]> {
  try {
    return JSON.parse(await readFile(HISTORY, "utf8"));
  } catch {
    return [];
  }
}

async function writeHistory(history: unknown[]) {
  await mkdir(REPO_RUNS, { recursive: true });
  await writeFile(HISTORY, JSON.stringify(history, null, 2));
}

async function readRecords(): Promise<SourceRunRecord[]> {
  return JSON.parse(await readFile(join(runDir, "sources.json"), "utf8")) as SourceRunRecord[];
}

function printSummary(records: SourceRunRecord[]) {
  console.table(
    records.map((r) => ({
      source: r.id,
      status: r.status,
      rows: r.rows,
      seconds: +(r.durationMs / 1000).toFixed(1),
      requests: r.requests,
      retries: r.retries,
      MB: +(r.bytes / 1e6).toFixed(1),
      error: r.error?.slice(0, 60) ?? "",
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
