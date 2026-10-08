import { NextResponse } from "next/server";
import { getDataset, readRunJson } from "@/lib/data";
import { tableCounts } from "@/lib/queries";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Everything the explorer's run, manifest and history panels need, from the current IPNS target. */
export async function GET() {
  try {
    const d = await getDataset();
    const [coverage, sources, deltas, history, reconciliation, counts] = await Promise.all([
      readRunJson("coverage.json"),
      readRunJson("sources.json"),
      readRunJson("deltas.json"),
      readRunJson<unknown[]>("history.json"),
      readRunJson("reconciliation.json"),
      tableCounts(),
    ]);
    return NextResponse.json({
      run_id: d.manifest.run_id,
      created_at: d.manifest.created_at,
      manifest_cid: d.manifestCid,
      resolved_via: d.resolvedVia,
      ipns: d.ipns,
      manifest: d.manifest,
      verified_on_load: d.verified,
      loaded_at: d.loadedAt,
      coverage,
      sources,
      deltas,
      reconciliation,
      counts,
      // history.json inside a run lists the runs before it; append the current one.
      history: [
        ...history,
        { run_id: d.manifest.run_id, created_at: d.manifest.created_at, root_cid: d.manifest.root.cid, manifest_cid: d.manifestCid, car_cid: d.manifest.root.car.cid, deltas: (deltas as { deltas?: unknown }).deltas },
      ],
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }
}
