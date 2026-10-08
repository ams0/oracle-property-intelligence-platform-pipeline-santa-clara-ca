import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { filebase, importCar } from "./lib/filebase.js";
import { sha256File } from "./lib/hash.js";
import { packFile } from "./lib/ipfs.js";
import type { CaptureResult } from "./sources/types.js";

/**
 * Last-good raw captures of flaky sources, pinned on IPFS and indexed by CID in a committed
 * registry (runs/last-good.json). A fresh CI runner has no local state, so when a publisher
 * throttles or truncates it can still fall back to the last complete capture, fetched by CID
 * and checked against its sha256, instead of failing the run.
 */
export interface SnapshotEntry {
  cid: string;
  sha256: string;
  size: number;
  /** File name in the run's raw directory, e.g. cslb_master.csv. */
  file: string;
  fetchedAt: string;
  runId: string;
  capture: Omit<CaptureResult, "file">;
}

export type SnapshotRegistry = Record<string, SnapshotEntry>;

const READ_GATEWAY = process.env.ORACLE_READ_GATEWAY ?? "https://ipfs.filebase.io";

export async function readRegistry(path: string): Promise<SnapshotRegistry> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SnapshotRegistry;
  } catch {
    return {};
  }
}

/** Pin a complete capture unless the registry already holds identical bytes. Returns the entry. */
export async function pinSnapshot(
  sourceId: string,
  capture: CaptureResult,
  meta: { fetchedAt: string; runId: string },
  registryPath: string,
  log: (msg: string) => void,
): Promise<SnapshotEntry> {
  const registry = await readRegistry(registryPath);
  const sha256 = await sha256File(capture.file);
  const current = registry[sourceId];
  if (current?.sha256 === sha256) return current;
  const carPath = `${capture.file}.car`;
  const cid = (await packFile(capture.file, carPath)).toString();
  await importCar(filebase(), carPath, `snapshots/${sourceId}/${sha256}.car`, cid);
  const { file: _file, ...rest } = capture;
  const entry: SnapshotEntry = { cid, sha256, size: (await stat(capture.file)).size, file: basename(capture.file), ...meta, capture: rest };
  // Re-read so concurrent sources don't overwrite each other's entries.
  const latest = await readRegistry(registryPath);
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify({ ...latest, [sourceId]: entry }, null, 2) + "\n");
  log(`snapshot ${sourceId}: pinned ${cid} (${(entry.size / 1e6).toFixed(1)} MB)`);
  return entry;
}

/** Fetch a pinned snapshot by CID into rawDir and verify it byte-for-byte. */
export async function fetchSnapshot(
  sourceId: string,
  registryPath: string,
  rawDir: string,
): Promise<{ fetchedAt: string; runId: string; capture: CaptureResult; cid: string } | undefined> {
  const entry = (await readRegistry(registryPath))[sourceId];
  if (!entry) return undefined;
  const file = join(rawDir, `${sourceId}${extname(entry.file)}`);
  const tmp = `${file}.part`;
  const res = await fetch(`${READ_GATEWAY}/ipfs/${entry.cid}`, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`snapshot ${entry.cid}: HTTP ${res.status} from ${READ_GATEWAY}`);
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(tmp));
  const sha256 = await sha256File(tmp);
  if (sha256 !== entry.sha256) throw new Error(`snapshot ${entry.cid}: sha256 ${sha256} does not match registry ${entry.sha256}`);
  await rename(tmp, file);
  return { fetchedAt: entry.fetchedAt, runId: entry.runId, cid: entry.cid, capture: { ...entry.capture, file } };
}
