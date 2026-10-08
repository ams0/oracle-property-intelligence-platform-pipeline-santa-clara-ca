import { createHash } from "node:crypto";
import { CarBlockIterator } from "@ipld/car";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

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

export interface GatewayCheck {
  gateway: string;
  operator: string;
  url: string;
  /** Host that actually answered, after redirects. */
  servedBy?: string;
  status: number | "error";
  ms: number;
  bytesReceived: number;
  blocksVerified: number;
  size?: number;
  sha256?: string;
  ok: boolean;
  error?: string;
}

/**
 * Fetch `cid` from one public gateway, check every block hashes to its CID, rebuild the UnixFS
 * file and compare size + SHA-256 with what the manifest promises. Directories are checked at the
 * root-block level (dag-scope=block).
 */
export async function checkOnGateway(
  { url: gateway, operator }: PublicGateway,
  obj: { cid: string; size: number; sha256: string; codec: string; ipld_codec: string },
  timeoutMs = 45_000,
): Promise<GatewayCheck> {
  const format = obj.ipld_codec === "raw" ? "raw" : "car";
  const url = `${gateway}/ipfs/${obj.cid}?format=${format}${obj.codec === "directory" ? "&dag-scope=block" : ""}`;
  const started = Date.now();
  const base: Pick<GatewayCheck, "gateway" | "operator" | "url" | "servedBy" | "bytesReceived" | "blocksVerified"> = { gateway, operator, url, bytesReceived: 0, blocksVerified: 0 };
  try {
    const res = await fetch(url, {
      headers: { accept: format === "raw" ? "application/vnd.ipld.raw" : "application/vnd.ipld.car" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    base.servedBy = new URL(res.url || url).host;
    if (!res.ok) return { ...base, status: res.status, ms: Date.now() - started, ok: false, error: (await res.text()).slice(0, 160) };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ms = Date.now() - started;
    const root = CID.parse(obj.cid);
    const blocks = new Map<string, Uint8Array>();
    if (format === "raw") blocks.set(root.toString(), bytes);
    else for await (const b of await CarBlockIterator.fromBytes(bytes)) blocks.set(b.cid.toString(), b.bytes);
    for (const [c, b] of blocks) {
      const digest = await sha256.digest(b);
      if (!Buffer.from(digest.bytes).equals(Buffer.from(CID.parse(c).multihash.bytes))) {
        return { ...base, status: res.status, ms, bytesReceived: bytes.length, ok: false, error: `block ${c} does not hash to its CID` };
      }
    }
    if (obj.codec === "directory") return { ...base, status: res.status, ms, bytesReceived: bytes.length, blocksVerified: blocks.size, ok: blocks.has(root.toString()) };
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
      hash.update(chunk as Uint8Array);
      size += (chunk as Uint8Array).length;
    }
    const digest = hash.digest("hex");
    return {
      ...base,
      status: res.status,
      ms,
      bytesReceived: bytes.length,
      blocksVerified: blocks.size,
      size,
      sha256: digest,
      ok: size === obj.size && digest === obj.sha256,
    };
  } catch (err) {
    return { ...base, status: "error", ms: Date.now() - started, ok: false, error: (err as Error).message.slice(0, 160) };
  }
}
