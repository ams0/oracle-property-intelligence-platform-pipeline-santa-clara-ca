import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BYTES = Buffer.from("LicenseNo,BusinessName\n1,ACME ROOFING\n");
let server: Server;
let fetchSnapshot: typeof import("../src/snapshots.js").fetchSnapshot;

beforeAll(async () => {
  server = createServer((req, res) => (req.url === "/ipfs/bafytest" ? res.end(BYTES) : res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, r));
  process.env.ORACLE_READ_GATEWAY = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ fetchSnapshot } = await import("../src/snapshots.js"));
});
afterAll(() => server.close());

async function registry(sha256: string) {
  const dir = await mkdtemp(join(tmpdir(), "oracle-snap-"));
  const path = join(dir, "last-good.json");
  const capture = { format: "csv", rows: 1, requestUrls: ["https://example.test"], scope: "full" };
  await writeFile(path, JSON.stringify({ cslb_master: { cid: "bafytest", sha256, size: BYTES.length, file: "cslb_master.csv", fetchedAt: "2026-10-08T00:00:00Z", runId: "r1", capture } }));
  return { dir, path };
}

describe("IPFS last-good snapshots", () => {
  it("restores a pinned capture by CID when its sha256 matches", async () => {
    const { dir, path } = await registry(createHash("sha256").update(BYTES).digest("hex"));
    const got = await fetchSnapshot("cslb_master", path, dir);
    expect(got?.cid).toBe("bafytest");
    expect(got?.capture.file).toBe(join(dir, "cslb_master.csv"));
    expect(await readFile(join(dir, "cslb_master.csv"))).toEqual(BYTES);
  });

  it("refuses bytes that don't match the registry digest", async () => {
    const { dir, path } = await registry("0".repeat(64));
    await expect(fetchSnapshot("cslb_master", path, dir)).rejects.toThrow(/does not match/);
  });

  it("returns undefined for a source with no pinned snapshot", async () => {
    const { dir, path } = await registry("0".repeat(64));
    expect(await fetchSnapshot("bbb_roofers", path, dir)).toBeUndefined();
  });
});
