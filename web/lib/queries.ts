import type { DuckDBValue } from "@duckdb/node-api";
import { getDataset } from "./data";

export type Row = Record<string, unknown>;

async function rows(sql: string, params: Record<string, DuckDBValue> = {}): Promise<Row[]> {
  const { db } = await getDataset();
  // DuckDB rejects named parameters a statement does not reference, so bind only those used.
  const used = Object.fromEntries(Object.entries(params).filter(([k]) => new RegExp(`\\$${k}\\b`).test(sql)));
  const reader = await db.runAndReadAll(sql, used);
  return reader.getRowObjectsJson() as Row[];
}

export interface Center {
  lat: number;
  lon: number;
  label: string;
  basis: string;
}

/**
 * Resolve "near <place>" to a point: a city or ZIP in the county (centroid of its parcels),
 * or explicit coordinates. Returning the basis keeps the assumption visible to the agent.
 */
export async function locate(place: string): Promise<Center | null> {
  const q = place.trim().toUpperCase().replace(/,?\s*(CA|CALIFORNIA)$/, "").trim();
  const coords = q.match(/^(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)$/);
  if (coords) return { lat: Number(coords[1]), lon: Number(coords[3]), label: place, basis: "explicit coordinates" };
  const [hit] = await rows(
    `SELECT avg(lat) AS lat, avg(lon) AS lon, count(*) AS n FROM property
     WHERE (city = $q OR jurisdiction = $q OR zip = $q) AND lat IS NOT NULL`,
    { q },
  );
  if (!hit || !Number(hit.n)) return null;
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    label: place,
    basis: `centroid of ${Number(hit.n).toLocaleString()} parcels whose city/jurisdiction/ZIP is ${q}`,
  };
}

const bbox = (c: Center, miles: number) => ({
  lat0: c.lat - miles / 69,
  lat1: c.lat + miles / 69,
  lon0: c.lon - miles / (69 * Math.cos((c.lat * Math.PI) / 180)),
  lon1: c.lon + miles / (69 * Math.cos((c.lat * Math.PI) / 180)),
});

export interface PropertySearch {
  center: Center;
  radiusMiles: number;
  minRoofAge?: number;
  openRoofingPermitOnly?: boolean;
  minYearsSinceTransfer?: number;
  ownerLocality?: ("local" | "in_county_other_zip" | "out_of_county" | "out_of_state")[];
  sort?: "roof_age" | "open_permits" | "distance";
  limit?: number;
}

const PROPERTY_ORDER = {
  roof_age: "roof_age_years DESC NULLS LAST, open_roofing_permits DESC, distance_miles",
  open_permits: "open_roofing_permits DESC, roof_age_years DESC NULLS LAST, distance_miles",
  distance: "distance_miles, roof_age_years DESC NULLS LAST",
} as const;

export async function searchProperties(s: PropertySearch) {
  const b = bbox(s.center, s.radiusMiles);
  const where = [
    "lat BETWEEN $lat0 AND $lat1",
    "lon BETWEEN $lon0 AND $lon1",
    "miles($clat, $clon, lat, lon) <= $r",
  ];
  const params: Record<string, DuckDBValue> = { ...b, clat: s.center.lat, clon: s.center.lon, r: s.radiusMiles, lim: Math.min(s.limit ?? 50, 500) };
  if (s.minRoofAge != null) {
    where.push("roof_age_years >= $age");
    params.age = s.minRoofAge;
  }
  if (s.openRoofingPermitOnly) where.push("open_roofing_permits > 0");
  if (s.minYearsSinceTransfer != null) {
    where.push("years_since_transfer > $yst");
    params.yst = s.minYearsSinceTransfer;
  }
  if (s.ownerLocality?.length) where.push(`owner_locality IN (${s.ownerLocality.map((l) => `'${l.replace(/[^a-z_]/g, "")}'`).join(", ")})`);
  const filter = where.join(" AND ");
  const [summary] = await rows(
    `SELECT count(*) AS matches,
            count(*) FILTER (WHERE roof_age_basis LIKE 'roofing_permit%') AS roof_age_from_permit,
            count(*) FILTER (WHERE roof_age_basis = 'year_built') AS roof_age_from_year_built,
            round(avg(roof_age_years), 1) AS avg_roof_age
     FROM property WHERE ${filter}`,
    params,
  );
  const results = await rows(
    `SELECT apn, address, city, zip, jurisdiction, round(lat, 6) AS lat, round(lon, 6) AS lon,
            round(miles($clat, $clon, lat, lon), 2) AS distance_miles,
            year_built, roof_age_years, roof_age_basis, roof_age_confidence, last_roof_completed,
            roofing_permits, open_roofing_permits, oldest_open_roofing_days, expired_unfinaled_roofing_permits,
            last_transfer_year, transfer_basis, years_since_transfer, owner_name, owner_mailing_address, owner_locality,
            source_id, source_url, fetched_at, run_id
     FROM property WHERE ${filter}
     ORDER BY ${PROPERTY_ORDER[s.sort ?? "roof_age"]}
     LIMIT $lim`,
    params,
  );
  return { center: s.center, radiusMiles: s.radiusMiles, sort: s.sort ?? "roof_age", summary, results };
}

export interface PermitSearch {
  center?: Center;
  radiusMiles?: number;
  minDaysOpen?: number;
  includeExpiredUnfinaled?: boolean;
  limit?: number;
}

export async function openRoofingPermits(s: PermitSearch) {
  const statuses = s.includeExpiredUnfinaled ? "('open', 'expired_not_finaled')" : "('open')";
  const where = ["p.is_roofing", `p.status IN ${statuses}`];
  const params: Record<string, DuckDBValue> = { lim: Math.min(s.limit ?? 50, 500) };
  let distance = "CAST(NULL AS DOUBLE)";
  if (s.center && s.radiusMiles) {
    Object.assign(params, bbox(s.center, s.radiusMiles), { clat: s.center.lat, clon: s.center.lon, r: s.radiusMiles });
    where.push("p.lat BETWEEN $lat0 AND $lat1", "p.lon BETWEEN $lon0 AND $lon1", "miles($clat, $clon, p.lat, p.lon) <= $r");
    distance = "round(miles($clat, $clon, p.lat, p.lon), 2)";
  }
  if (s.minDaysOpen != null) {
    where.push("p.days_open >= $days");
    params.days = s.minDaysOpen;
  }
  const filter = where.join(" AND ");
  const [summary] = await rows(
    `SELECT count(*) AS matches, count(p.contractor_license_number) AS with_cslb_contractor,
            count(p.contractor_bbb_rating) AS with_bbb_rating, max(p.days_open) AS max_days_open
     FROM permit p WHERE ${filter}`,
    params,
  );
  const results = await rows(
    `SELECT p.permit_key, p.permit_number, p.jurisdiction, p.apn, p.address, round(p.lat, 6) AS lat, round(p.lon, 6) AS lon,
            ${distance} AS distance_miles,
            p.status, p.status_raw, p.issued_date, p.days_open, round(p.days_open / 365.25, 1) AS years_open,
            p.work_type, p.description, p.roofing_basis, p.valuation,
            p.contractor_raw, p.contractor_name, p.contractor_license_number, p.contractor_match_method,
            p.contractor_bbb_rating, p.contractor_bbb_accredited, c.bbb_url, c.license_status, c.phone AS contractor_phone,
            p.source_id, p.source_url, p.fetched_at
     FROM permit p LEFT JOIN contractor c ON c.license_number = p.contractor_license_number
     WHERE ${filter}
     ORDER BY p.days_open DESC NULLS LAST
     LIMIT $lim`,
    params,
  );
  return { center: s.center ?? null, radiusMiles: s.radiusMiles ?? null, summary, results };
}

export async function getProperty(apn: string) {
  const id = apn.replace(/\D/g, "");
  const [property] = await rows(`SELECT * FROM property WHERE apn = $id`, { id });
  if (!property) return null;
  const permits = await rows(
    `SELECT permit_key, permit_number, jurisdiction, work_type, description, is_roofing, roofing_basis, status, status_raw,
            issued_date, finaled_date, days_open, valuation, contractor_raw, contractor_name, contractor_license_number,
            contractor_match_method, contractor_bbb_rating, apn_basis, source_url, fetched_at
     FROM permit WHERE apn = $id ORDER BY issued_date DESC NULLS LAST`,
    { id },
  );
  return { property, permits };
}

export async function getContractor(query: string) {
  const lic = query.replace(/\D/g, "");
  const q = query.trim().toUpperCase();
  return rows(
    `SELECT * FROM contractor
     WHERE license_number = $lic OR upper(business_name) LIKE '%' || $q || '%' OR upper(full_business_name) LIKE '%' || $q || '%'
     ORDER BY is_roofing_license DESC, roofing_permits DESC LIMIT 20`,
    { lic, q },
  );
}

const FORBIDDEN = /\b(insert|update|delete|create|drop|alter|attach|detach|copy|export|import|install|load|pragma|set|call|checkpoint|vacuum)\b|read_|glob\(|http/i;

/** Read-only SQL over the published tables for agents (single SELECT/WITH statement, capped rows). */
export async function runSql(sql: string, limit = 200) {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s) || s.includes(";") || FORBIDDEN.test(s)) {
    throw new Error("Only a single read-only SELECT over property, permit, contractor, business is allowed.");
  }
  return rows(`SELECT * FROM (${s}) LIMIT ${Math.min(limit, 1000)}`);
}

export async function tableCounts() {
  return rows(`SELECT 'property' AS t, count(*) AS n FROM property UNION ALL SELECT 'permit', count(*) FROM permit
               UNION ALL SELECT 'contractor', count(*) FROM contractor UNION ALL SELECT 'business', count(*) FROM business`);
}

export const SCHEMA_DOC = `Tables (DuckDB, one row per entity; every row has source_id, source_url, fetched_at, run_id):
- property(apn PK, address, city, zip, jurisdiction, lat, lon, year_built, last_document_number, last_transfer_year, transfer_basis,
  owner_name, owner_mailing_address, owner_locality[local|in_county_other_zip|out_of_county|out_of_state], roofing_permits,
  open_roofing_permits, expired_unfinaled_roofing_permits, oldest_open_roofing_days, last_roof_completed, roof_age_years,
  roof_age_basis[roofing_permit_finaled|roofing_permit_closed|year_built], roof_age_confidence, years_since_transfer)
- permit(permit_key PK, source_id, jurisdiction, permit_number, apn, apn_basis, address, work_type, description, is_roofing,
  roofing_basis, status[open|expired_not_finaled|closed|closed_inferred|pending], status_raw, applied_date, issued_date,
  finaled_date, expired_date, days_open, valuation, contractor_raw, contractor_license_number, contractor_match_method,
  contractor_name, contractor_bbb_rating, contractor_bbb_accredited, lat, lon)
- contractor(contractor_id PK = cslb:<license>, license_number, business_name, full_business_name, address, city, county, phone,
  license_status, classifications, is_roofing_license (C39), bbb_rating, bbb_accredited, bbb_url, website, email,
  permits_total, roofing_permits, unfinaled_roofing_permits, last_permit_issued)
- business(business_id PK, name, category, basic_category, website, phone, email, address, city, zip, lat, lon,
  is_roofing_business, cslb_license_number)
Macro: miles(lat1, lon1, lat2, lon2) -> great-circle distance in miles.`;
