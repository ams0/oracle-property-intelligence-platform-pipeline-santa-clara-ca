import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packDirectory, packFile, sameContent, type PackedFile } from "./lib/ipfs.js";
import { sha256File } from "./lib/hash.js";
import { BUCKET, filebase, importCar } from "./lib/filebase.js";

/**
 * Public gateways this project does not operate, with who runs them. ipfs.io, dweb.link and
 * trustless-gateway.link share one operator (and the first two now redirect to the third), so
 * "independent" is counted by operator, not hostname. Requests use trustless formats (raw / CAR).
 */
export const PUBLIC_GATEWAYS = [
  { url: "https://ipfs.io", operator: "IPFS Foundation" },
  { url: "https://dweb.link", operator: "IPFS Foundation" },
  { url: "https://trustless-gateway.link", operator: "IPFS Foundation" },
  { url: "https://gateway.pinata.cloud", operator: "Pinata" },
  { url: "https://ipfs.orbitor.dev", operator: "orbitor.dev" },
] as const;
export type PublicGateway = { url: string; operator: string };
/** Distinct operators that must independently serve matching bytes. */
export const MIN_INDEPENDENT_OPERATORS = 2;
export const IPNS_LABEL = process.env.ORACLE_IPNS_LABEL ?? "oracle-scc-latest";

export interface ManifestObject {
  name: string;
  path: string;
  cid: string;
  size: number;
  sha256: string;
  codec: "file" | "directory" | "car";
  ipld_codec: "raw" | "dag-pb";
  /** Path from the run root; resolvable as /ipfs/<root>/<path> on any gateway. */
  root_path?: string;
  gateway_urls: string[];
}

export interface Manifest {
  schema: "oracle-scc-artifact-manifest/v1";
  run_id: string;
  created_at: string;
  county: { name: string; state: string; fips: string };
  root: { cid: string; codec: "directory"; car: ManifestObject };
  objects: ManifestObject[];
  ipns: { name: string; label: string; resolves_to: "this manifest (see run history for its CID)" } | null;
  previous_run: { run_id: string; manifest_cid: string; root_cid: string } | null;
  pinning: { provider: string; bucket: string; origins: string[] }[];
  verification_hint: string;
}

export interface RunHistoryEntry {
  run_id: string;
  created_at: string;
  mode: string;
  root_cid: string;
  manifest_cid: string;
  car_cid: string;
  counts: Record<string, number>;
  deltas?: Record<string, { added: number; changed: number; removed: number; unchanged: number }>;
  sources: { id: string; status: string; rows: number; fetchedAt: string }[];
}

const gatewayUrls = (cid: string, codec: "raw" | "dag-pb") =>
  PUBLIC_GATEWAYS.map((g) => `${g.url}/ipfs/${cid}?format=${codec === "raw" ? "raw" : "car"}`);

async function filebaseToken(): Promise<string> {
  return Buffer.from(`${process.env.FILEBASE_ACCESS_KEY}:${process.env.FILEBASE_SECRET_KEY}`).toString("base64");
}

/** Point the run's IPNS name at the new manifest, creating the name on first publish. */
export async function updateIpns(cid: string): Promise<{ name: string; label: string; cid: string }> {
  const headers = { authorization: `Bearer ${await filebaseToken()}`, "content-type": "application/json" };
  const list = (await (await fetch("https://api.filebase.io/v1/names", { headers })).json()) as { label: string; network_key: string }[];
  const existing = list.find((n) => n.label === IPNS_LABEL);
  const res = existing
    ? await fetch(`https://api.filebase.io/v1/names/${IPNS_LABEL}`, { method: "PUT", headers, body: JSON.stringify({ cid }) })
    : await fetch("https://api.filebase.io/v1/names", { method: "POST", headers, body: JSON.stringify({ label: IPNS_LABEL, cid }) });
  if (!res.ok) throw new Error(`IPNS update failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json().catch(() => ({}))) as { network_key?: string };
  const name = body.network_key ?? existing?.network_key;
  if (!name) throw new Error("IPNS response had no network_key");
  return { name, label: IPNS_LABEL, cid };
}

/**
 * Publish a built run: pack `publish/` as a CIDv1 UnixFS DAG, import the CAR into Filebase,
 * publish the CAR itself and the manifest as their own CIDs, then move IPNS to the manifest.
 * Previous CIDs are never touched: every run writes new keys and new content.
 */
export async function publishRun(opts: {
  runDir: string;
  runId: string;
  mode: string;
  counts: Record<string, number>;
  previous: RunHistoryEntry | null;
  sources: RunHistoryEntry["sources"];
  deltas?: RunHistoryEntry["deltas"];
  log: (m: string) => void;
}): Promise<{ manifest: Manifest; manifestCid: string; history: RunHistoryEntry; ipns: { name: string; cid: string } | null }> {
  const { runDir, runId, log } = opts;
  const s3 = filebase();
  const publishDir = join(runDir, "publish");
  const carPath = join(runDir, `oracle-scc-${runId}.car`);

  log("publish: packing run directory");
  const { root, files, subdirs } = await packDirectory(publishDir, carPath);
  log(`publish: root ${root} (${files.length} files)`);
  await importCar(s3, carPath, `runs/${runId}/oracle-scc-${runId}.car`, root.toString());

  // The CAR is an artifact too, so a third party can import the snapshot without re-encoding.
  const carCarPath = `${carPath}.car`;
  const carCid = await packFile(carPath, carCarPath);
  await importCar(s3, carCarPath, `runs/${runId}/oracle-scc-${runId}.car.car`, carCid.toString());
  const carObject: ManifestObject = {
    name: `oracle-scc-${runId}.car`,
    path: `oracle-scc-${runId}.car`,
    cid: carCid.toString(),
    size: (await stat(carPath)).size,
    sha256: await sha256File(carPath),
    codec: "car",
    ipld_codec: carCid.code === 0x55 ? "raw" : "dag-pb",
    gateway_urls: gatewayUrls(carCid.toString(), carCid.code === 0x55 ? "raw" : "dag-pb"),
  };

  const objects: ManifestObject[] = [
    ...subdirs.map((d) => ({
      name: d.path,
      path: `${d.path}/`,
      cid: d.cid,
      size: files.filter((f) => f.path.startsWith(`${d.path}/`)).reduce((a, f) => a + f.size, 0),
      sha256: "",
      codec: "directory" as const,
      ipld_codec: "dag-pb" as const,
      root_path: d.path,
      gateway_urls: gatewayUrls(d.cid, "dag-pb"),
    })),
    ...files.map((f: PackedFile) => ({
      name: f.path.split("/").pop() ?? f.path,
      path: f.path,
      cid: f.cid,
      size: f.size,
      sha256: f.sha256,
      codec: "file" as const,
      ipld_codec: f.codec,
      root_path: f.path,
      gateway_urls: gatewayUrls(f.cid, f.codec),
    })),
    carObject,
  ];

  const manifest: Manifest = {
    schema: "oracle-scc-artifact-manifest/v1",
    run_id: runId,
    created_at: new Date().toISOString(),
    county: { name: "Santa Clara County", state: "CA", fips: "06085" },
    root: { cid: root.toString(), codec: "directory", car: carObject },
    objects,
    ipns: null,
    previous_run: opts.previous
      ? { run_id: opts.previous.run_id, manifest_cid: opts.previous.manifest_cid, root_cid: opts.previous.root_cid }
      : null,
    pinning: [{ provider: "Filebase (IPFS pinning, 3 regions)", bucket: BUCKET, origins: ["/dnsaddr/bitswap.filebase.io"] }],
    verification_hint:
      "Fetch any object with GET <public gateway>/ipfs/<cid>?format=raw (single-block files) or ?format=car (DAGs); verify the CID against the bytes and sha256 against `sha256`. Files are also reachable as /ipfs/<root.cid>/<root_path>.",
  };
  // IPNS name is stable across runs; record it in the manifest before hashing the manifest.
  const knownIpns = await existingIpnsName().catch(() => null);
  if (knownIpns) manifest.ipns = { name: knownIpns, label: IPNS_LABEL, resolves_to: "this manifest (see run history for its CID)" };

  const manifestPath = join(runDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const manifestCarPath = join(runDir, "manifest.car");
  const manifestCid = (await packFile(manifestPath, manifestCarPath)).toString();
  await importCar(s3, manifestCarPath, `runs/${runId}/manifest.json.car`, manifestCid);
  log(`publish: manifest ${manifestCid}`);

  let ipns: { name: string; cid: string } | null = null;
  try {
    ipns = await updateIpns(manifestCid);
    log(`publish: IPNS ${ipns.name} -> ${manifestCid}`);
  } catch (err) {
    log(`publish: IPNS update failed (${(err as Error).message}); CIDs remain authoritative`);
  }

  const history: RunHistoryEntry = {
    run_id: runId,
    created_at: manifest.created_at,
    mode: opts.mode,
    root_cid: root.toString(),
    manifest_cid: manifestCid,
    car_cid: carCid.toString(),
    counts: opts.counts,
    deltas: opts.deltas,
    sources: opts.sources,
  };
  await writeFile(join(runDir, "publish-result.json"), JSON.stringify({ manifestCid, ipns, history }, null, 2));
  return { manifest, manifestCid, history, ipns };
}

async function existingIpnsName(): Promise<string | null> {
  const headers = { authorization: `Bearer ${await filebaseToken()}` };
  const list = (await (await fetch("https://api.filebase.io/v1/names", { headers })).json()) as { label: string; network_key: string }[];
  return list.find((n) => n.label === IPNS_LABEL)?.network_key ?? null;
}

export async function readManifest(runDir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Manifest;
}
