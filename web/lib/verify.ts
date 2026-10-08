import { createHash } from "node:crypto";
import { CarBlockIterator } from "@ipld/car";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/** Public gateways this project does not operate. Requests use trustless formats (raw / CAR). */
export const PUBLIC_GATEWAYS = ["https://ipfs.io", "https://dweb.link", "https://trustless-gateway.link"];

export interface GatewayCheck {
  gateway: string;
  url: string;
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
  gateway: string,
  obj: { cid: string; size: number; sha256: string; codec: string; ipld_codec: string },
  timeoutMs = 45_000,
): Promise<GatewayCheck> {
  const format = obj.ipld_codec === "raw" ? "raw" : "car";
  const url = `${gateway}/ipfs/${obj.cid}?format=${format}${obj.codec === "directory" ? "&dag-scope=block" : ""}`;
  const started = Date.now();
  const base = { gateway, url, bytesReceived: 0, blocksVerified: 0 };
  try {
    const res = await fetch(url, {
      headers: { accept: format === "raw" ? "application/vnd.ipld.raw" : "application/vnd.ipld.car" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
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
