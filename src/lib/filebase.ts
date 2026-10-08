import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sameContent } from "./ipfs.js";

export const BUCKET = process.env.FILEBASE_BUCKET ?? "prism-oracle-santa-clara";

export const hasFilebaseCredentials = () => Boolean(process.env.FILEBASE_ACCESS_KEY && process.env.FILEBASE_SECRET_KEY);

export function filebase(): S3Client {
  const accessKeyId = process.env.FILEBASE_ACCESS_KEY;
  const secretAccessKey = process.env.FILEBASE_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("FILEBASE_ACCESS_KEY / FILEBASE_SECRET_KEY are required to publish");
  return new S3Client({ endpoint: "https://s3.filebase.com", region: "us-east-1", credentials: { accessKeyId, secretAccessKey } });
}

/** Upload a CAR through Filebase's import path and require the pinned CID to equal our root. */
export async function importCar(s3: S3Client, carPath: string, key: string, expectedRoot: string): Promise<void> {
  const size = (await stat(carPath)).size;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: createReadStream(carPath),
      ContentLength: size,
      Metadata: { import: "car" },
    }),
  );
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const pinned = head.Metadata?.cid;
  if (!pinned || !sameContent(pinned, expectedRoot)) {
    throw new Error(`Filebase pinned ${pinned ?? "nothing"} for ${key}, expected ${expectedRoot}`);
  }
}
