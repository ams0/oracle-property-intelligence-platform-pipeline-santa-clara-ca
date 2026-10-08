import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { CAREncoderStream, createDirectoryEncoderStream, createFileEncoderStream, type Block, type FileLike } from "ipfs-car";
import { CID } from "multiformats/cid";
import { sha256File } from "../capture.js";

export interface PackedFile {
  path: string;
  cid: string;
  size: number;
  sha256: string;
  /** UnixFS files <= 1 MiB encode as a single raw block (codec raw); larger ones as dag-pb. */
  codec: "raw" | "dag-pb";
}

const toWeb = (path: string) => () => Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;

export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

async function lastBlock(stream: ReadableStream<Block>): Promise<Block> {
  let last: Block | undefined;
  await stream.pipeTo(new WritableStream({ write: (b) => void (last = b) }));
  if (!last) throw new Error("encoder produced no blocks");
  return last;
}

/** CIDv1 of one file, using the same UnixFS settings as directory packing (so CIDs agree). */
export async function fileCid(path: string): Promise<CID> {
  const block = await lastBlock(createFileEncoderStream({ stream: toWeb(path) }));
  return block.cid as CID;
}

function dirEntries(dir: string, files: string[]): FileLike[] {
  return files.map((f) => ({ name: relative(dir, f).split(sep).join("/"), stream: toWeb(f) }));
}

async function writeCar(makeBlocks: () => ReadableStream<Block>, carPath: string): Promise<CID> {
  // Pass 1 finds the root (the encoder emits it last); pass 2 writes a CAR whose header names it.
  const root = (await lastBlock(makeBlocks())).cid as CID;
  await makeBlocks()
    .pipeThrough(new CAREncoderStream([root]))
    .pipeTo(Writable.toWeb(createWriteStream(carPath)) as unknown as WritableStream<Uint8Array>);
  return root;
}

/** Pack a directory into a CARv1 rooted at its UnixFS directory CID, and describe each file. */
export async function packDirectory(dir: string, carPath: string): Promise<{ root: CID; files: PackedFile[]; subdirs: { path: string; cid: string }[] }> {
  const all = await listFiles(dir);
  const root = await writeCar(() => createDirectoryEncoderStream(dirEntries(dir, all)), carPath);
  const files: PackedFile[] = [];
  for (const f of all) {
    const cid = await fileCid(f);
    files.push({
      path: relative(dir, f).split(sep).join("/"),
      cid: cid.toString(),
      size: (await stat(f)).size,
      sha256: await sha256File(f),
      codec: cid.code === 0x55 ? "raw" : "dag-pb",
    });
  }
  // Sub-directory roots: a UnixFS directory node is deterministic, so packing the sub-tree alone
  // yields the same CID it has inside the run root.
  const subdirs: { path: string; cid: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    const block = await lastBlock(createDirectoryEncoderStream(dirEntries(sub, await listFiles(sub))));
    subdirs.push({ path: entry.name, cid: block.cid.toString() });
  }
  return { root, files, subdirs };
}

/** Pack a single file into a CAR rooted at the file's CID. */
export async function packFile(path: string, carPath: string): Promise<CID> {
  return writeCar(() => createFileEncoderStream({ stream: toWeb(path) }), carPath);
}

/** CIDs are equal when their multihashes are (CIDv0 vs v1 strings differ for the same bytes). */
export function sameContent(a: string, b: string): boolean {
  const x = CID.parse(a);
  const y = CID.parse(b);
  return x.code === y.code && Buffer.from(x.multihash.bytes).equals(Buffer.from(y.multihash.bytes));
}
