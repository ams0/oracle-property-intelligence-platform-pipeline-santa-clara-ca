import { createHash } from "node:crypto";
import { CarBlockIterator } from "@ipld/car";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { Manifest, ManifestObject } from "./publish.js";
import { PUBLIC_GATEWAYS } from "./publish.js";

export interface GatewayCheck {
  gateway: string;
  url: string;
  status: number | "error";
  ms: number;
  bytesReceived: number;
  blocksVerified: number;
  size?: number;
  sha256?: string;
  sizeMatches?: boolean;
  digestMatches?: boolean;
  ok: boolean;
  error?: string;
}

export interface ObjectVerification {
  name: string;
  cid: string;
  codec: ManifestObject["codec"];
  expected: { size: number; sha256: string };
  checks: GatewayCheck[];
  independentGatewaysOk: number;
  ok: boolean;
}

/**
 * Fetch an object by CID from one public gateway using the trustless response formats
 * (raw block or CAR), verify every block hashes to its CID, then rebuild the UnixFS file and
 * compare size + SHA-256 with the manifest. Nothing here trusts the gateway's word.
 */
export async function checkOnGateway(gateway: string, obj: ManifestObject, timeoutMs = 120_000): Promise<GatewayCheck> {
  const format = obj.ipld_codec === "raw" ? "raw" : "car";
  const scope = obj.codec === "directory" ? "&dag-scope=block" : "";
  const url = `${gateway}/ipfs/${obj.cid}?format=${format}${scope}`;
  const started = Date.now();
  const base = { gateway, url, bytesReceived: 0, blocksVerified: 0 };
  try {
    const res = await fetch(url, {
      headers: { accept: format === "raw" ? "application/vnd.ipld.raw" : "application/vnd.ipld.car" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ...base, status: res.status, ms: Date.now() - started, ok: false, error: (await res.text()).slice(0, 160) };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ms = Date.now() - started;
    const root = CID.parse(obj.cid);
    const blocks = new Map<string, Uint8Array>();
    if (format === "raw") {
      blocks.set(root.toString(), bytes);
    } else {
      for await (const block of await CarBlockIterator.fromBytes(bytes)) blocks.set(block.cid.toString(), block.bytes);
    }
    for (const [cidStr, blockBytes] of blocks) {
      const cid = CID.parse(cidStr);
      const digest = await sha256.digest(blockBytes);
      if (!Buffer.from(digest.bytes).equals(Buffer.from(cid.multihash.bytes))) {
        return { ...base, status: res.status, ms, bytesReceived: bytes.length, blocksVerified: 0, ok: false, error: `block ${cidStr} does not hash to its CID` };
      }
    }
    if (obj.codec === "directory") {
      // A directory is verified by its root block hashing to the CID (dag-scope=block).
      const ok = blocks.has(root.toString());
      return { ...base, status: res.status, ms, bytesReceived: bytes.length, blocksVerified: blocks.size, ok };
    }
    // ipfs-unixfs-exporter >= 16 reads blocks as async iterables of chunks.
    const store = {
      get: async function* (cid: CID) {
        const b = blocks.get(cid.toString());
        if (!b) throw new Error(`missing block ${cid}`);
        yield b;
      },
    };
    const entry = await exporter(root, store as never);
    if (entry.type !== "file" && entry.type !== "raw") throw new Error(`expected a file, got ${entry.type}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of entry.content()) {
      const c = chunk as Uint8Array;
      hash.update(c);
      size += c.length;
    }
    const digest = hash.digest("hex");
    const sizeMatches = size === obj.size;
    const digestMatches = digest === obj.sha256;
    return {
      ...base,
      status: res.status,
      ms,
      bytesReceived: bytes.length,
      blocksVerified: blocks.size,
      size,
      sha256: digest,
      sizeMatches,
      digestMatches,
      ok: sizeMatches && digestMatches,
    };
  } catch (err) {
    return { ...base, status: "error", ms: Date.now() - started, ok: false, error: (err as Error).message.slice(0, 160) };
  }
}

export async function verifyManifest(
  manifest: Manifest,
  { gateways = [...PUBLIC_GATEWAYS], only }: { gateways?: string[]; only?: (o: ManifestObject) => boolean } = {},
): Promise<ObjectVerification[]> {
  const targets = [manifest.root.car, ...manifest.objects.filter((o) => o.codec !== "car")].filter((o) => !only || only(o));
  const out: ObjectVerification[] = [];
  for (const obj of targets) {
    const checks = await Promise.all(gateways.map((g) => checkOnGateway(g, obj)));
    const okCount = checks.filter((c) => c.ok).length;
    out.push({
      name: obj.path,
      cid: obj.cid,
      codec: obj.codec,
      expected: { size: obj.size, sha256: obj.sha256 },
      checks,
      independentGatewaysOk: okCount,
      ok: okCount >= 2,
    });
  }
  return out;
}
