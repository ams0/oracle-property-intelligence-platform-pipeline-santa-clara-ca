import { ipnsValidator } from "ipns/validator";
import { multihashToIPNSRoutingKey, unmarshalIPNSRecord } from "ipns";
import { base36 } from "multiformats/bases/base36";
import { CID } from "multiformats/cid";

export interface IpnsResolution {
  name: string;
  value: string;
  cid: string;
  sequence: string;
  validity: string;
  source: string;
  signatureVerified: true;
}

/** Public delegated-routing endpoints (IPFS HTTP Routing V1). Neither is operated by this project. */
const ROUTERS = (process.env.ORACLE_IPNS_ROUTERS ?? "https://delegated-ipfs.dev,https://cid.contact").split(",");

/**
 * Resolve an IPNS name by fetching its signed record from public delegated routing and verifying
 * the signature against the name's public key, so no gateway cache or vendor is trusted for the
 * pointer. Picks the highest sequence number across routers.
 */
export async function resolveIpns(name: string): Promise<IpnsResolution> {
  const routingKey = multihashToIPNSRoutingKey(CID.parse(name, base36).multihash as Parameters<typeof multihashToIPNSRoutingKey>[0]);
  const results = await Promise.allSettled(
    ROUTERS.map(async (router) => {
      const res = await fetch(`${router}/routing/v1/ipns/${name}`, {
        headers: { accept: "application/vnd.ipfs.ipns-record" },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`${router}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await ipnsValidator(routingKey, bytes);
      return { router, record: unmarshalIPNSRecord(bytes) };
    }),
  );
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ok.length) {
    throw new Error(`IPNS ${name} unresolved: ${results.map((r) => (r.status === "rejected" ? String(r.reason?.message ?? r.reason) : "")).join("; ")}`);
  }
  const best = ok.sort((a, b) => Number(BigInt(b.record.sequence) - BigInt(a.record.sequence)))[0]!;
  const value = best.record.value;
  return {
    name,
    value,
    cid: value.replace(/^\/ipfs\//, "").split("/")[0]!,
    sequence: String(best.record.sequence),
    validity: best.record.validity,
    source: best.router,
    signatureVerified: true,
  };
}
