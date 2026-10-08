import { z } from "zod";
import { getDataset, readRunJson } from "./data";
import { getContractor, getProperty, locate, openRoofingPermits, runSql, SCHEMA_DOC, searchProperties } from "./queries";

/**
 * Oracle query tools. One definition serves both the MCP endpoint and the HTTP API, so agents
 * and the CRM see the same contract. Every result carries run/manifest identity for provenance.
 */
const where = z
  .object({
    near: z.string().optional().describe("City, ZIP or 'lat,lon' in Santa Clara County, e.g. 'Campbell' or '95008'"),
    lat: z.number().optional(),
    lon: z.number().optional(),
    radius_miles: z.number().positive().max(50).default(5),
  })
  .describe("Search center: either `near` or `lat`+`lon`");

async function center(w: z.infer<typeof where>) {
  if (w.lat != null && w.lon != null) return { lat: w.lat, lon: w.lon, label: `${w.lat},${w.lon}`, basis: "explicit coordinates" };
  if (!w.near) throw new Error("Provide `near` (city/ZIP) or `lat` and `lon`.");
  const c = await locate(w.near);
  if (!c) throw new Error(`Could not locate '${w.near}' in Santa Clara County (try a city name or ZIP).`);
  return c;
}

async function provenance() {
  const d = await getDataset();
  return {
    run_id: d.manifest.run_id,
    manifest_cid: d.manifestCid,
    root_cid: d.manifest.root.cid,
    resolved_via: d.resolvedVia,
    ipns: d.ipns ? { name: d.ipns.name, resolved_cid: d.ipns.cid, sequence: d.ipns.sequence, signature_verified: true, via: d.ipns.source } : null,
  };
}

export const TOOLS = {
  find_aged_roofs: {
    title: "Find properties with aged roofs near a place",
    description:
      "Properties within a radius whose estimated roof age is at least `min_roof_age_years` (default 15). Roof age comes from the last completed roofing permit when one exists, otherwise from year built — each result states its basis and confidence.",
    input: z.object({
      ...where.shape,
      min_roof_age_years: z.number().int().min(0).default(15),
      limit: z.number().int().min(1).max(200).default(25),
    }),
    run: async (a: { near?: string; lat?: number; lon?: number; radius_miles: number; min_roof_age_years: number; limit: number }) => {
      const c = await center(a);
      return { ...(await searchProperties({ center: c, radiusMiles: a.radius_miles, minRoofAge: a.min_roof_age_years, limit: a.limit })), provenance: await provenance() };
    },
  },
  find_open_roofing_permits: {
    title: "Find open roofing permits, longest-open first",
    description:
      "Roofing permits that are issued but not finaled (status=open), optionally also those that expired without a final inspection, ordered by days open. Includes contractor name, CSLB license (name-matched; method given) and BBB rating when available.",
    input: z.object({
      near: z.string().optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      radius_miles: z.number().positive().max(50).optional(),
      min_years_open: z.number().min(0).default(0),
      include_expired_unfinaled: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(25),
    }),
    run: async (a: { near?: string; lat?: number; lon?: number; radius_miles?: number; min_years_open: number; include_expired_unfinaled: boolean; limit: number }) => {
      const hasCenter = a.near || (a.lat != null && a.lon != null);
      const c = hasCenter ? await center({ ...a, radius_miles: a.radius_miles ?? 5 }) : undefined;
      return {
        ...(await openRoofingPermits({
          center: c,
          radiusMiles: c ? (a.radius_miles ?? 5) : undefined,
          minDaysOpen: Math.round(a.min_years_open * 365.25),
          includeExpiredUnfinaled: a.include_expired_unfinaled,
          limit: a.limit,
        })),
        provenance: await provenance(),
      };
    },
  },
  find_long_held_properties: {
    title: "Find properties not transferred in N years, optionally with out-of-area owners",
    description:
      "Properties within a radius whose last recorded transfer is more than `min_years_since_transfer` years ago. Transfer year is exact where a roll publishes it, otherwise estimated from the county recorder document number (basis given). Owner name/mailing locality is only available where a public roll exists (~4% of parcels).",
    input: z.object({
      ...where.shape,
      min_years_since_transfer: z.number().int().min(0).default(10),
      owner_locality: z.array(z.enum(["local", "in_county_other_zip", "out_of_county", "out_of_state"])).optional(),
      min_roof_age_years: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).default(25),
    }),
    run: async (a: {
      near?: string;
      lat?: number;
      lon?: number;
      radius_miles: number;
      min_years_since_transfer: number;
      owner_locality?: ("local" | "in_county_other_zip" | "out_of_county" | "out_of_state")[];
      min_roof_age_years?: number;
      limit: number;
    }) => {
      const c = await center(a);
      return {
        ...(await searchProperties({
          center: c,
          radiusMiles: a.radius_miles,
          minYearsSinceTransfer: a.min_years_since_transfer,
          ownerLocality: a.owner_locality,
          minRoofAge: a.min_roof_age_years,
          limit: a.limit,
        })),
        provenance: await provenance(),
      };
    },
  },
  get_property: {
    title: "Property detail with permit history",
    description: "One property by APN (8 digits, dashes optional) with every linked permit and its provenance.",
    input: z.object({ apn: z.string() }),
    run: async (a: { apn: string }) => ({ ...((await getProperty(a.apn)) ?? { error: "APN not found" }), provenance: await provenance() }),
  },
  get_contractor: {
    title: "Contractor lookup",
    description: "CSLB contractor by license number or (partial) business name, with BBB rating, website and permit activity.",
    input: z.object({ query: z.string() }),
    run: async (a: { query: string }) => ({ results: await getContractor(a.query), provenance: await provenance() }),
  },
  query_sql: {
    title: "Read-only SQL over the Oracle tables",
    description: `Run one read-only SELECT (DuckDB dialect). ${SCHEMA_DOC}`,
    input: z.object({ sql: z.string(), limit: z.number().int().min(1).max(1000).default(200) }),
    run: async (a: { sql: string; limit: number }) => ({ rows: await runSql(a.sql, a.limit), provenance: await provenance() }),
  },
  get_pipeline_run: {
    title: "Current pipeline run: sources, coverage, deltas, artifact manifest",
    description: "The run the data was loaded from: manifest (CIDs, sizes, digests), IPNS name, source list with timestamps/limitations, coverage counts, deltas vs the previous run and run history.",
    input: z.object({ include_manifest_objects: z.boolean().default(false) }),
    run: async (a: { include_manifest_objects: boolean }) => {
      const d = await getDataset();
      const [coverage, sources, deltas, history, reconciliation] = await Promise.all([
        readRunJson("coverage.json"),
        readRunJson("sources.json"),
        readRunJson("deltas.json"),
        readRunJson("history.json"),
        readRunJson("reconciliation.json"),
      ]);
      return {
        provenance: await provenance(),
        manifest: a.include_manifest_objects ? d.manifest : { ...d.manifest, objects: `${d.manifest.objects.length} objects (set include_manifest_objects)` },
        verified_on_load: d.verified,
        coverage,
        sources,
        deltas,
        reconciliation,
        history,
      };
    },
  },
} as const;

export type ToolName = keyof typeof TOOLS;
