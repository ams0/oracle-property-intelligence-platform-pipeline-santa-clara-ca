import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

/** IPNS name the pipeline re-points at each run's manifest. */
export const IPNS_NAME = process.env.ORACLE_IPNS ?? "k51qzi5uqu5djx0ycpstlrvrpvem0ueb9f3hn9oqfifoth37h307ncxxxx2f8l";
/** Convenience HTTP locator for reads. The CID is the identity; bytes are re-verified below. */
export const READ_GATEWAY = process.env.ORACLE_READ_GATEWAY ?? "https://ipfs.filebase.io";
const CACHE_DIR = process.env.ORACLE_CACHE_DIR ?? "/tmp/oracle-cache";

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
export interface Manifest {
  schema: string;
  run_id: string;
  created_at: string;
  county: { name: string; state: string; fips: string };
  root: { cid: string; codec: "directory"; car: ManifestObject };
  objects: ManifestObject[];
  ipns: { name: string; label: string } | null;
  previous_run: { run_id: string; manifest_cid: string; root_cid: string } | null;
  pinning: { provider: string; bucket: string; origins: string[] }[];
}

export interface Dataset {
  manifest: Manifest;
  manifestCid: string;
  /** How the manifest was found: IPNS resolution, or a pinned CID override. */
  resolvedVia: "ipns" | "pinned_cid";
  loadedAt: string;
  verified: { path: string; cid: string; sha256: string; size: number; ok: boolean }[];
  db: DuckDBConnection;
}

let loading: Promise<Dataset> | null = null;
let current: Dataset | null = null;
const TTL_MS = Number(process.env.ORACLE_MANIFEST_TTL_MS ?? 10 * 60_000);

async function manifestCidOf(bytes: Uint8Array): Promise<string> {
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

async function fetchBytes(url: string, timeoutMs = 60_000): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Resolve the current manifest: pinned CID if configured, else the IPNS pointer. */
export async function resolveManifest(): Promise<{ manifest: Manifest; manifestCid: string; resolvedVia: Dataset["resolvedVia"] }> {
  const pinned = process.env.ORACLE_MANIFEST_CID;
  const bytes = pinned
    ? await fetchBytes(`${READ_GATEWAY}/ipfs/${pinned}`)
    : await fetchBytes(`${READ_GATEWAY}/ipns/${IPNS_NAME}`);
  const manifestCid = await manifestCidOf(bytes);
  if (pinned && manifestCid !== CID.parse(pinned).toV1().toString()) throw new Error(`manifest bytes do not match ${pinned}`);
  return { manifest: JSON.parse(new TextDecoder().decode(bytes)) as Manifest, manifestCid, resolvedVia: pinned ? "pinned_cid" : "ipns" };
}

/** Download an artifact by CID into the local cache, verifying size + SHA-256 against the manifest. */
async function materialize(obj: ManifestObject): Promise<{ file: string; ok: boolean }> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${obj.cid}-${obj.name}`);
  const cached = await stat(file).catch(() => null);
  if (cached?.size === obj.size) return { file, ok: true };
  const bytes = await fetchBytes(`${READ_GATEWAY}/ipfs/${obj.cid}`, 120_000);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== obj.sha256 || bytes.length !== obj.size) {
    throw new Error(`${obj.path}: downloaded bytes do not match manifest (sha256 ${digest.slice(0, 12)}…, ${bytes.length} B)`);
  }
  await writeFile(file, bytes);
  return { file, ok: true };
}

const TABLES = ["property", "permit", "contractor", "business"] as const;

async function load(): Promise<Dataset> {
  const { manifest, manifestCid, resolvedVia } = await resolveManifest();
  const wanted = manifest.objects.filter((o) => o.codec === "file" && (o.path.startsWith("tables/") || o.path === "indexes/property_geo.parquet"));
  const verified: Dataset["verified"] = [];
  const files: Record<string, string> = {};
  await Promise.all(
    wanted.map(async (o) => {
      const { file, ok } = await materialize(o);
      files[o.path] = file;
      verified.push({ path: o.path, cid: o.cid, sha256: o.sha256, size: o.size, ok });
    }),
  );
  const instance = await DuckDBInstance.create(":memory:", { threads: "4" });
  const db = await instance.connect();
  for (const t of TABLES) {
    const f = files[`tables/${t}.parquet`];
    if (!f) throw new Error(`manifest ${manifestCid} has no tables/${t}.parquet`);
    // Materialize into memory: the tables are small (tens of MB) and every query is then local.
    await db.run(`CREATE TABLE ${t} AS SELECT * FROM read_parquet('${f}')`);
  }
  await db.run(`
    CREATE MACRO miles(lat1, lon1, lat2, lon2) AS
      3958.8 * 2 * asin(sqrt(pow(sin(radians(lat2 - lat1) / 2), 2)
        + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)));
  `);
  return { manifest, manifestCid, resolvedVia, loadedAt: new Date().toISOString(), verified, db };
}

/** Shared dataset handle; reloads when the IPNS pointer moves to a new manifest (checked every TTL). */
export async function getDataset(): Promise<Dataset> {
  if (current && Date.now() - Date.parse(current.loadedAt) < TTL_MS) return current;
  if (current) {
    const latest = await resolveManifest().catch(() => null);
    if (!latest || latest.manifestCid === current.manifestCid) {
      current = { ...current, loadedAt: new Date().toISOString() };
      return current;
    }
  }
  loading ??= load()
    .then((d) => (current = d))
    .finally(() => (loading = null));
  return loading;
}

/** Read a small JSON artifact of the current run by its manifest path (coverage, sources, ...). */
export async function readRunJson<T>(path: string): Promise<T> {
  const { manifest } = await getDataset();
  const obj = manifest.objects.find((o) => o.path === path);
  if (!obj) throw new Error(`no ${path} in manifest ${manifest.run_id}`);
  const local = join(CACHE_DIR, `${obj.cid}-${obj.name}`);
  const cached = await readFile(local, "utf8").catch(() => null);
  if (cached) return JSON.parse(cached) as T;
  const bytes = await fetchBytes(`${READ_GATEWAY}/ipfs/${obj.cid}`);
  if (createHash("sha256").update(bytes).digest("hex") !== obj.sha256) throw new Error(`${path}: digest mismatch`);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(local, bytes);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
