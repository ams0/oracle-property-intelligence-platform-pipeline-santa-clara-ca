import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileCid, packDirectory, sameContent } from "../src/lib/ipfs.js";

describe("IPFS packing", () => {
  it("produces CIDv1 raw-leaf CIDs that are stable and match inside a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oracle-"));
    await writeFile(join(dir, "a.json"), JSON.stringify({ hello: "world" }));
    const standalone = await fileCid(join(dir, "a.json"));
    expect(standalone.version).toBe(1);
    expect(standalone.toString()).toMatch(/^bafkrei/);
    const { root, files } = await packDirectory(dir, join(dir, "..", "out.car"));
    expect(root.toString()).toMatch(/^bafybei/);
    expect(files[0]?.cid).toBe(standalone.toString());
    expect((await packDirectory(dir, join(dir, "..", "out2.car"))).root.toString()).toBe(root.toString());
  });

  it("compares CIDs by content across v0/v1 encodings", () => {
    expect(sameContent("QmT374VweLG4BpmSkcous4VkpQBZYFYCqudV26rgbrdhdY", "bafybeicfzpdkga455uuxxb23m3o4c7apcjevx3msrx7e7xyo7olmjzfic4")).toBe(true);
  });
});
