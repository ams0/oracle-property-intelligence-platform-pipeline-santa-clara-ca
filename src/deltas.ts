import { join } from "node:path";
import { queryRows, withDuck } from "./lib/duck.js";
import { QUERY_TABLES } from "./build.js";

/** Natural key per published table. */
const KEYS: Record<keyof typeof QUERY_TABLES, string> = {
  property: "apn",
  permit: "permit_key",
  contractor: "contractor_id",
  business: "business_id",
};

/** Columns that change every run without the source changing (run metadata, ages vs today). */
const VOLATILE = ["run_id", "fetched_at", "days_open", "roof_age_years", "years_since_transfer"];

export type Deltas = Record<string, { added: number; changed: number; removed: number; unchanged: number }>;

/**
 * Compare this run's published tables with the previous run's, by natural key and a content hash
 * of the non-volatile columns. `previousBase` is a local directory or an IPFS gateway URL of the
 * previous run root (DuckDB reads Parquet over HTTP), so CI runners need no local state.
 */
export async function computeDeltas(publishDir: string, previousBase: string | null): Promise<Deltas> {
  return withDuck(async (db) => {
    await db.run("INSTALL httpfs; LOAD httpfs;");
    const out: Deltas = {};
    for (const [name, key] of Object.entries(KEYS)) {
      const cur = join(publishDir, "tables", `${name}.parquet`);
      if (!previousBase) {
        const [r] = await queryRows<{ n: number }>(db, `SELECT count(*)::INT n FROM '${cur}'`);
        out[name] = { added: Number(r?.n ?? 0), changed: 0, removed: 0, unchanged: 0 };
        continue;
      }
      const prev = `${previousBase.replace(/\/$/, "")}/tables/${name}.parquet`;
      const hashOf = (src: string) =>
        `SELECT ${key} AS k, md5(to_json(t)::VARCHAR) AS h FROM (SELECT * EXCLUDE (${VOLATILE.map((c) => `COLUMNS('^${c}$')`).join(", ")}) FROM '${src}') t`;
      const [r] = await queryRows<Record<string, number>>(
        db,
        `WITH c AS (${hashOf(cur)}), p AS (${hashOf(prev)})
         SELECT count(*) FILTER (WHERE p.k IS NULL)::INT AS added,
                count(*) FILTER (WHERE c.k IS NULL)::INT AS removed,
                count(*) FILTER (WHERE c.k IS NOT NULL AND p.k IS NOT NULL AND c.h <> p.h)::INT AS changed,
                count(*) FILTER (WHERE c.h = p.h)::INT AS unchanged
         FROM c FULL OUTER JOIN p ON c.k = p.k`,
      );
      out[name] = {
        added: Number(r?.added ?? 0),
        changed: Number(r?.changed ?? 0),
        removed: Number(r?.removed ?? 0),
        unchanged: Number(r?.unchanged ?? 0),
      };
    }
    return out;
  });
}
