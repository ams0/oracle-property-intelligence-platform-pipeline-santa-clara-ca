import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { dumpArcgisLayer } from "../lib/arcgis.js";
import { fetchJson, fetchText, mapLimit } from "../lib/http.js";
import { withDuck } from "../lib/duck.js";
import type { SourceDescriptor } from "./types.js";

const SOCRATA_PARCELS = "https://data.sccgov.org/resource/ubcd-cewv.csv";
const PLANNING_PARCELS =
  "https://services2.arcgis.com/tcv2cMrq63AgvbHF/arcgis/rest/services/Parcels_Public_View/FeatureServer/0";
const LOS_GATOS_ROLL = "https://services3.arcgis.com/JAU7IM34hqT9y9ew/arcgis/rest/services/Parcels/FeatureServer/0";
const CAMPBELL_ACTIVE =
  "https://services7.arcgis.com/RDyUffIeciKdYmX2/arcgis/rest/services/CampbellPermits_ActiveBuilding/FeatureServer/0";
const CAMPBELL_INACTIVE =
  "https://services7.arcgis.com/RDyUffIeciKdYmX2/arcgis/rest/services/CampbellPermits_Inactive_Building/FeatureServer/0";
const GILROY_PERMITS = "https://services8.arcgis.com/n7NW5ijV4dJUmrID/arcgis/rest/services/Permit_Activity/FeatureServer/1";
const SJ_CKAN = "https://data.sanjoseca.gov/api/3/action";
const SJ_RESOURCES = {
  active: "761b7ae8-3be1-4ad6-923d-c7af6404a904",
  expired: "df4b8461-0c7a-4d16-b85d-ff7f71c5fed5",
  last30: "045b3678-e923-4002-b696-300955bc6d06",
} as const;
const CSLB_MASTER = "https://www.cslb.ca.gov/OnlineServices/DataPortal/DownLoadFile.ashx?fName=MasterLicenseData&type=C";
export const OVERTURE_RELEASE = process.env.OVERTURE_RELEASE ?? "2026-09-23.1";
const BBB_SEARCH = "https://www.bbb.org/api/search";

/** Cities whose BBB roofing results we sample (San Jose gets more pages: ~half of all parcels). */
const BBB_QUERIES: { city: string; pages: number }[] = [
  { city: "San Jose", pages: 10 },
  ...["Santa Clara", "Sunnyvale", "Campbell", "Gilroy", "Morgan Hill", "Mountain View", "Palo Alto", "Los Gatos", "Milpitas", "Cupertino"].map(
    (city) => ({ city, pages: 2 }),
  ),
];

const arcgisDate = (iso: string) => `TIMESTAMP '${iso.slice(0, 10)} 00:00:00'`;

export const SOURCES: SourceDescriptor[] = [
  {
    id: "scc_parcels",
    name: "Santa Clara County Parcels (tabular + geometry)",
    domain: "property",
    publisher: "County of Santa Clara Open Data (Socrata ubcd-cewv)",
    landingUrl: "https://data.sccgov.org/d/ubcd-cewv",
    jurisdictions: ["Santa Clara County (all)"],
    limitations: [
      "Bulk CSV export endpoint is deprecated (HTTP 410); paged SODA API used instead (~18 s per 50k rows).",
      "No owner, year built, transfer date or use code in this dataset.",
    ],
    async fetch(ctx, stats) {
      const pageSize = 50_000;
      const countRows = await fetchJson<{ count: string }[]>(
        `${SOCRATA_PARCELS.replace(".csv", ".json")}?$select=count(*)`,
        stats,
      );
      const total = Number(countRows[0]?.count ?? 0);
      const offsets = Array.from({ length: Math.ceil(total / pageSize) }, (_, i) => i * pageSize);
      const pages = await mapLimit(offsets, 3, (offset) =>
        fetchText(`${SOCRATA_PARCELS}?$limit=${pageSize}&$offset=${offset}&$order=objectid`, stats),
      );
      const file = join(ctx.rawDir, "scc_parcels.csv");
      const sink = createWriteStream(file);
      let rows = 0;
      pages.forEach((page, i) => {
        const lines = page.trimEnd().split("\n");
        // CSV fields may embed newlines inside quotes, so count rows by object id order below via DuckDB.
        sink.write((i === 0 ? lines : lines.slice(1)).join("\n") + "\n");
        rows += lines.length - 1;
      });
      await new Promise<void>((r) => sink.end(r));
      return { file, format: "csv", rows, requestUrls: [`${SOCRATA_PARCELS}?$limit=${pageSize}&$offset=<n>&$order=objectid`], scope: "full" };
    },
  },
  {
    id: "scc_planning_parcels",
    name: "County Planning Parcels Public View (year built, last recorded document)",
    domain: "property",
    publisher: "County of Santa Clara Planning Office (ArcGIS Online)",
    landingUrl: "https://www.arcgis.com/home/item.html?id=beb8b2e587d1450792e66cf07d831616",
    jurisdictions: ["Santa Clara County (all)"],
    limitations: [
      "Year_Built missing/zero on ~6% of parcels.",
      "Document_Number is the latest recorded document (may be a non-sale transfer such as a trust deed); transfer year is estimated from it.",
      "ArcGIS page size capped at 2,000 rows (~253 requests for a full pull).",
    ],
    async fetch(ctx, stats) {
      const file = join(ctx.rawDir, "scc_planning_parcels.ndjson");
      const { rows, requestUrl } = await dumpArcgisLayer(PLANNING_PARCELS, file, stats, {
        outFields: "APN,Year_Built,Document_Number,Situs_Address_Full",
        concurrency: 6,
      });
      return { file, format: "ndjson", rows, requestUrls: [requestUrl], scope: "full" };
    },
  },
  {
    id: "los_gatos_roll",
    name: "Town of Los Gatos parcel roll (assessee, mailing address, transfer date)",
    domain: "ownership",
    publisher: "Town of Los Gatos GIS (ArcGIS Online)",
    landingUrl: LOS_GATOS_ROLL,
    jurisdictions: ["Los Gatos", "Monte Sereno", "adjacent San Jose / Campbell / Saratoga parcels"],
    limitations: [
      "Covers ~19k parcels (~3.8% of county). No free county-wide owner/mailing source exists; the Assessor site is behind a bot challenge (not bypassed).",
    ],
    async fetch(ctx, stats) {
      const file = join(ctx.rawDir, "los_gatos_roll.ndjson");
      const { rows, requestUrl } = await dumpArcgisLayer(LOS_GATOS_ROLL, file, stats, { concurrency: 4 });
      return { file, format: "ndjson", rows, requestUrls: [requestUrl], scope: "full" };
    },
  },
  {
    id: "sj_permits",
    name: "City of San Jose building permits (Active, Expired, Last 30 days)",
    domain: "permit",
    publisher: "City of San Jose Open Data (CKAN)",
    landingUrl: "https://data.sanjoseca.gov/dataset/building-permits",
    jurisdictions: ["San Jose"],
    limitations: [
      "No permit status column beyond the dataset it came from; no application or expiration date.",
      "Contractor is a free-text 'COMPANY  Person' string with no CSLB license number; matched to CSLB by normalized name.",
      "No finaled-permit dataset; a permit leaving Active without appearing in Expired is treated as closed.",
    ],
    async fetch(ctx, stats) {
      const wanted = ctx.mode === "incremental" ? (["last30", "active"] as const) : (["active", "expired", "last30"] as const);
      const file = join(ctx.rawDir, "sj_permits.ndjson");
      const sink = createWriteStream(file);
      const urls: string[] = [];
      let rows = 0;
      for (const key of wanted) {
        const meta = await fetchJson<{ result: { url: string } }>(`${SJ_CKAN}/resource_show?id=${SJ_RESOURCES[key]}`, stats);
        urls.push(meta.result.url);
        const csv = await fetchText(meta.result.url, stats);
        await withDuck(async (db) => {
          const tmp = join(ctx.rawDir, `sj_${key}.csv`);
          await writeFile(tmp, csv);
          const reader = await db.runAndReadAll(
            `SELECT *, '${key}' AS _dataset FROM read_csv('${tmp}', all_varchar=true, header=true)`,
          );
          for (const r of reader.getRowObjectsJson()) {
            sink.write(JSON.stringify(r) + "\n");
            rows++;
          }
        });
      }
      await new Promise<void>((r) => sink.end(r));
      return {
        file,
        format: "ndjson",
        rows,
        requestUrls: urls,
        scope: ctx.mode === "incremental" ? "window" : "full",
        windowSince: ctx.mode === "incremental" ? "last 30 days (publisher window) + current Active set" : undefined,
      };
    },
  },
  {
    id: "campbell_permits",
    name: "City of Campbell building permits (Active + Inactive)",
    domain: "permit",
    publisher: "City of Campbell (ArcGIS Online)",
    landingUrl: "https://www.campbellca.gov/",
    jurisdictions: ["Campbell"],
    limitations: ["No APN, valuation or final date (finaled only as a status). ProjectName usually, not always, holds the contractor."],
    async fetch(ctx, stats) {
      const file = join(ctx.rawDir, "campbell_permits.ndjson");
      const where = ctx.mode === "incremental" && ctx.since ? `UpdateDate >= ${arcgisDate(ctx.since)}` : "1=1";
      const tmpA = `${file}.active`;
      const tmpI = `${file}.inactive`;
      const a = await dumpArcgisLayer(CAMPBELL_ACTIVE, tmpA, stats, { where });
      const i = await dumpArcgisLayer(CAMPBELL_INACTIVE, tmpI, stats, { where });
      const { readFile } = await import("node:fs/promises");
      const tag = (s: string, layer: string) =>
        s
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.stringify({ ...JSON.parse(l), _layer: layer }))
          .join("\n");
      await writeFile(file, [tag(await readFile(tmpA, "utf8"), "active"), tag(await readFile(tmpI, "utf8"), "inactive")].filter(Boolean).join("\n") + "\n");
      return {
        file,
        format: "ndjson",
        rows: a.rows + i.rows,
        requestUrls: [a.requestUrl, i.requestUrl],
        scope: where === "1=1" ? "full" : "window",
        windowSince: where === "1=1" ? undefined : ctx.since,
      };
    },
  },
  {
    id: "gilroy_permits",
    name: "City of Gilroy permit activity",
    domain: "permit",
    publisher: "City of Gilroy (ArcGIS Online, Tyler EPL export)",
    landingUrl: GILROY_PERMITS,
    jurisdictions: ["Gilroy"],
    limitations: ["Publisher labels it a proof of concept; covers applications since 2023-06. No contractor field."],
    async fetch(ctx, stats) {
      const file = join(ctx.rawDir, "gilroy_permits.ndjson");
      const where = ctx.mode === "incremental" && ctx.since ? `Last_Updated >= ${arcgisDate(ctx.since)}` : "1=1";
      const { rows, requestUrl } = await dumpArcgisLayer(GILROY_PERMITS, file, stats, { where, geometry: true });
      return { file, format: "ndjson", rows, requestUrls: [requestUrl], scope: where === "1=1" ? "full" : "window", windowSince: where === "1=1" ? undefined : ctx.since };
    },
  },
  {
    id: "cslb_master",
    name: "CSLB License Master (all renewable California contractor licenses)",
    domain: "contractor",
    publisher: "California Contractors State License Board",
    landingUrl: "https://www.cslb.ca.gov/OnlineServices/DataPortal/ContractorList",
    jurisdictions: ["California (statewide)"],
    limitations: [
      "Excludes cancelled/revoked/non-renewable licenses.",
      "~78 MB single download with no Range/compression support; the server cuts responses at ~150 s when throttled, so a run may reuse the last complete snapshot (status 'stale').",
      "County field is the self-reported mailing county.",
    ],
    snapshot: "ipfs",
    async fetch(ctx, stats) {
      const file = join(ctx.rawDir, "cslb_master.csv");
      await writeFile(file, await fetchText(CSLB_MASTER, stats));
      // The CSLB server cuts responses off at ~150 s when it throttles; a strict parse plus a
      // floor on row count detects a truncated file instead of loading half the state.
      const rows = await withDuck(async (db) => {
        const r = await db.runAndReadAll(`SELECT count(*)::INT n FROM read_csv('${file}', all_varchar=true, header=true, strict_mode=true)`);
        return Number(r.getRowObjects()[0]?.n ?? 0);
      }).catch((err: Error) => {
        throw new Error(`CSLB download truncated or malformed (${(err.message.split("\n")[0] ?? "").slice(0, 120)})`);
      });
      if (rows < 200_000) throw new Error(`CSLB download truncated: only ${rows} rows`);
      return { file, format: "csv", rows, requestUrls: [CSLB_MASTER], scope: "full" };
    },
  },
  {
    id: "overture_places",
    name: `Overture Maps Places (${OVERTURE_RELEASE})`,
    domain: "business",
    publisher: "Overture Maps Foundation",
    landingUrl: "https://docs.overturemaps.org/guides/places/",
    jurisdictions: ["Santa Clara County bbox, clipped to county parcels later"],
    limitations: ["Aggregated from multiple providers (CDLA-Permissive-2.0 / Apache-2.0 / CC0); business identity is a candidate, not legal identity."],
    async fetch(ctx, stats) {
      const file = join(ctx.rawDir, "overture_places.parquet");
      const started = Date.now();
      await withDuck(async (db) => {
        await db.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");
        await db.run(`COPY (
          SELECT id, names.primary AS name, basic_category, taxonomy.primary AS category,
                 operating_status, confidence, websites[1] AS website, phones[1] AS phone, emails[1] AS email,
                 addresses[1].freeform AS address, addresses[1].locality AS locality, addresses[1].postcode AS postcode,
                 (bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat,
                 list_transform(sources, s -> s.dataset) AS source_datasets
          FROM read_parquet('s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=places/type=place/*', hive_partitioning=1)
          WHERE bbox.xmin BETWEEN -122.21 AND -121.20 AND bbox.ymin BETWEEN 36.89 AND 37.49
        ) TO '${file}' (FORMAT parquet)`);
      });
      stats.requests++;
      stats.ms += Date.now() - started;
      const rows = await withDuck(async (db) => {
        const r = await db.runAndReadAll(`SELECT count(*)::INT n FROM '${file}'`);
        return Number(r.getRowObjects()[0]?.n ?? 0);
      });
      return { file, format: "parquet", rows, requestUrls: [`s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=places/type=place/*`], scope: "full" };
    },
  },
  {
    id: "bbb_roofers",
    name: "BBB roofing contractor search results",
    domain: "rating",
    publisher: "Better Business Bureau (bbb.org search)",
    landingUrl: "https://www.bbb.org/us/ca/san-jose/category/roofing-contractors",
    jurisdictions: ["San Jose", "Santa Clara", "Sunnyvale", "Campbell", "Gilroy", "Morgan Hill", "Mountain View", "Palo Alto", "Los Gatos", "Milpitas", "Cupertino"],
    limitations: [
      "bbb.org pages are behind a bot challenge (not bypassed); only the public search JSON is read, ~30 requests at 2 s spacing.",
      "Search results include off-category businesses; only results whose category mentions roofing are kept.",
      "Ratings are a reputation signal, not legal identity; matched to CSLB contractors by normalized name/phone.",
    ],
    async fetch(ctx, stats) {
      const file = join(ctx.rawDir, "bbb_roofers.ndjson");
      const sink = createWriteStream(file);
      const seen = new Set<string>();
      let rows = 0;
      const urls: string[] = [];
      for (const { city, pages } of BBB_QUERIES) {
        for (let page = 1; page <= pages; page++) {
          const url = `${BBB_SEARCH}?${new URLSearchParams({ find_text: "roofing", find_loc: `${city}, CA`, page: String(page) })}`;
          urls.push(url);
          const res = await fetchJson<{ totalPages?: number; results?: Record<string, unknown>[] }>(url, stats, {
            headers: { accept: "application/json" },
          });
          for (const r of res.results ?? []) {
            const id = String(r.id ?? "");
            if (!id || seen.has(id)) continue;
            seen.add(id);
            sink.write(JSON.stringify({ ...r, _query_city: city }) + "\n");
            rows++;
          }
          await sleep(2000);
          if ((res.totalPages ?? 0) <= page) break;
        }
      }
      await new Promise<void>((r) => sink.end(r));
      ctx.log(`bbb: ${urls.length} requests, ${rows} unique results`);
      return { file, format: "ndjson", rows, requestUrls: [`${BBB_SEARCH}?find_text=roofing&find_loc=<city>, CA&page=<n>`], scope: "full" };
    },
  },
];
