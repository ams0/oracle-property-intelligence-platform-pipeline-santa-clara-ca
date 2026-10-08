import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOnGateway, MIN_INDEPENDENT_OPERATORS, PUBLIC_GATEWAYS } from "@/lib/verify";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  cid: z.string().min(10),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  codec: z.enum(["file", "directory", "car"]),
  ipld_codec: z.enum(["raw", "dag-pb"]),
});

/** Live check: fetch one manifest object from independent public gateways and verify the bytes. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  const checks = await Promise.all(PUBLIC_GATEWAYS.map((g) => checkOnGateway(g, parsed.data)));
  const operatorsOk = new Set(checks.filter((c) => c.ok).map((c) => c.operator)).size;
  return NextResponse.json({
    cid: parsed.data.cid,
    checked_at: new Date().toISOString(),
    gateways_ok: checks.filter((c) => c.ok).length,
    gateways_checked: checks.length,
    operators_ok: operatorsOk,
    ok: operatorsOk >= MIN_INDEPENDENT_OPERATORS,
    checks,
  });
}
