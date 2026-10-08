import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows, withDuck } from "./lib/duck.js";
import type { SourceRunRecord } from "./capture.js";

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "sql");

/** Tables published as the query layer. Order matters for readers that pick the first file. */
export const QUERY_TABLES = {
  property: "property_roof",
  permit: "permit",
  contractor: "contractor",
  business: "business",
} as const;

export interface BuildResult {
  dbPath: string;
  outDir: string;
  counts: Record<string, number>;
}

/**
 * Build the canonical DuckDB model from a run's raw captures and export the publishable
 * artifact directory (Parquet query tables, indexes, coverage, samples, provenance).
 */
export async function buildRun(runDir: string, runId: string, sources: SourceRunRecord[], asOf: string): Promise<BuildResult> {
  const dbPath = join(runDir, "oracle.duckdb");
  const outDir = join(runDir, "publish");
  await rm(dbPath, { force: true });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "tables"), { recursive: true });
  await mkdir(join(outDir, "indexes"), { recursive: true });
  await mkdir(join(outDir, "samples"), { recursive: true });

  const fetched = Object.fromEntries(sources.map((s) => [s.id, s.fetchedAt]));
  const sql = (await readFile(join(SQL_DIR, "transform.sql"), "utf8"))
    .replaceAll("{{RAW}}", join(runDir, "raw"))
    .replaceAll("{{RUN_ID}}", runId)
    .replaceAll("{{AS_OF}}", asOf)
    .replace(/\{\{FETCHED\.([a-z_]+)\}\}/g, (_, id: string) => fetched[id] ?? "");

  return withDuck(async (db) => {
    await db.run(sql);
    const counts: Record<string, number> = {};
    for (const [name, table] of Object.entries(QUERY_TABLES)) {
      // Sort by location so DuckDB range reads over HTTP touch few row groups for radius queries.
      const order = name === "contractor" ? "contractor_id" : "lat, lon";
      await db.run(
        `COPY (SELECT * FROM ${table} ORDER BY ${order}) TO '${join(outDir, "tables", `${name}.parquet`)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000)`,
      );
      const [row] = await queryRows<{ n: number }>(db, `SELECT count(*)::INT AS n FROM ${table}`);
      counts[name] = Number(row?.n ?? 0);
    }

    // Geo index: compact (apn, lat, lon, cell) table for fast radius pre-filtering.
    await db.run(`COPY (
        SELECT apn, lat, lon, floor(lat * 100)::INT AS lat_cell, floor(lon * 100)::INT AS lon_cell,
               roof_age_years, open_roofing_permits
        FROM property_roof WHERE lat IS NOT NULL ORDER BY lat_cell, lon_cell
      ) TO '${join(outDir, "indexes", "property_geo.parquet")}' (FORMAT parquet, COMPRESSION zstd)`);
    await db.run(`COPY (SELECT * FROM doc_year_calibration ORDER BY year) TO '${join(outDir, "indexes", "doc_year_calibration.parquet")}' (FORMAT parquet)`);

    const coverage = await coverageReport(db, sources, counts);
    await writeFile(join(outDir, "coverage.json"), JSON.stringify(coverage, null, 2));
    await writeFile(join(outDir, "reconciliation.json"), JSON.stringify(await queryRows(db, "SELECT * FROM reconciliation"), null, 2));
    await writeFile(join(outDir, "sources.json"), JSON.stringify(sources.map(({ capture, ...rest }) => ({ ...rest, requestUrls: capture?.requestUrls, scope: capture?.scope })), null, 2));

    const samples: Record<string, string> = {
      "aged_roofs_top100.json": `SELECT apn, address, city, lat, lon, year_built, roof_age_years, roof_age_basis, roof_age_confidence, source_url
          FROM property_roof WHERE roof_age_years >= 15 ORDER BY roof_age_years DESC, apn LIMIT 100`,
      "open_roofing_permits_oldest100.json": `SELECT permit_key, apn, address, status, issued_date, days_open, contractor_raw, contractor_name,
          contractor_license_number, contractor_bbb_rating, source_url
          FROM permit WHERE is_roofing AND status = 'open' ORDER BY days_open DESC NULLS LAST LIMIT 100`,
      "roofing_contractors.json": `SELECT contractor_id, business_name, city, license_status, bbb_rating, bbb_accredited, roofing_permits,
          unfinaled_roofing_permits, source_url FROM contractor WHERE is_roofing_license ORDER BY roofing_permits DESC LIMIT 100`,
    };
    for (const [file, q] of Object.entries(samples)) {
      await writeFile(join(outDir, "samples", file), JSON.stringify(await queryRows(db, q), null, 2));
    }
    await db.run(`EXPORT DATABASE '${join(runDir, "db_export")}' (FORMAT parquet)`).catch(() => undefined);
    return { dbPath, outDir, counts };
  }, dbPath);
}

async function coverageReport(
  db: Parameters<Parameters<typeof withDuck>[0]>[0],
  sources: SourceRunRecord[],
  counts: Record<string, number>,
) {
  const [property] = await queryRows(db, `SELECT
      count(*) AS properties,
      count(lat) AS with_coordinates,
      count(year_built) AS with_year_built,
      count(roof_age_years) AS with_roof_age,
      count(*) FILTER (WHERE roof_age_years >= 15) AS roof_age_15_plus,
      count(*) FILTER (WHERE roof_age_basis LIKE 'roofing_permit%') AS roof_age_from_permit,
      count(last_transfer_year) AS with_transfer_year,
      count(*) FILTER (WHERE years_since_transfer > 10) AS no_transfer_10y_plus,
      count(owner_name) AS with_owner,
      count(*) FILTER (WHERE owner_locality IN ('out_of_county', 'out_of_state')) AS out_of_area_owners,
      count(*) FILTER (WHERE open_roofing_permits > 0) AS with_open_roofing_permit
    FROM property_roof`);
  const permits = await queryRows(db, `SELECT jurisdiction, count(*) AS permits,
      count(*) FILTER (WHERE is_roofing) AS roofing,
      count(*) FILTER (WHERE is_roofing AND status = 'open') AS roofing_open,
      count(*) FILTER (WHERE is_roofing AND status = 'open' AND days_open > 365 * 2) AS roofing_open_2y_plus,
      count(*) FILTER (WHERE is_roofing AND status = 'expired_not_finaled') AS roofing_expired_unfinaled,
      count(contractor_license_number) AS with_cslb_contractor,
      count(apn) AS with_apn,
      min(issued_date) AS earliest_issued, max(issued_date) AS latest_issued
    FROM permit GROUP BY jurisdiction ORDER BY permits DESC`);
  const byJurisdiction = await queryRows(db, `SELECT jurisdiction, count(*) AS properties, count(year_built) AS with_year_built,
      count(*) FILTER (WHERE roofing_permits > 0) AS with_roofing_permit_history
    FROM property_roof GROUP BY 1 ORDER BY 2 DESC`);
  const [contractor] = await queryRows(db, `SELECT count(*) AS contractors,
      count(*) FILTER (WHERE is_roofing_license) AS roofing_licensed,
      count(bbb_rating) AS with_bbb_rating, count(website) AS with_website
    FROM contractor`);
  return {
    county: { name: "Santa Clara County", state: "CA", fips: "06085" },
    tables: counts,
    property,
    permitsByJurisdiction: permits,
    propertiesByJurisdiction: byJurisdiction,
    contractor,
    sources: sources.map((s) => ({ id: s.id, status: s.status, rows: s.rows, fetchedAt: s.fetchedAt, durationMs: s.durationMs, limitations: s.limitations })),
  };
}
