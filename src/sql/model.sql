-- Oracle model: parcel linking, contractor identity, final permit table.
-- Runs after stage.sql and after windowed permit sources were merged into permit_all.
INSTALL spatial; LOAD spatial;

-- Permits without an APN but with coordinates: resolve the parcel by point-in-polygon.
CREATE OR REPLACE TABLE parcel_cells AS
SELECT apn, geom, unnest(generate_series(floor(ST_YMin(geom) * 100)::INT, floor(ST_YMax(geom) * 100)::INT)) AS lat_cell,
       floor(ST_XMin(geom) * 100)::INT AS lon_min, floor(ST_XMax(geom) * 100)::INT AS lon_max
FROM property_base;

CREATE OR REPLACE TABLE permit_apn_spatial AS
SELECT pa.permit_key, any_value(pc.apn) AS apn
FROM permit_all pa
JOIN parcel_cells pc
  ON pc.lat_cell = floor(pa.lat * 100)::INT
 AND floor(pa.lon * 100)::INT BETWEEN pc.lon_min AND pc.lon_max
 AND ST_Contains(pc.geom, ST_Point(pa.lon, pa.lat))
WHERE pa.apn IS NULL AND pa.lat IS NOT NULL
GROUP BY pa.permit_key;

-- Remaining unlinked permits: unique address match against parcel situs (zip5 or city key).
CREATE OR REPLACE TABLE parcel_addr AS
SELECT k, any_value(apn) AS apn FROM (
    SELECT apn, addr_key(house_number, street_name, zip) AS k FROM property_base
    UNION ALL SELECT apn, addr_key(house_number, street_name, city) FROM property_base
) WHERE k IS NOT NULL GROUP BY k HAVING count(DISTINCT apn) = 1;

CREATE OR REPLACE TABLE permit_apn_address AS
SELECT pa.permit_key, coalesce(z.apn, c.apn) AS apn
FROM permit_all pa
LEFT JOIN parcel_addr z ON z.k = addr_key(regexp_extract(pa.address, '^\s*(\d+)', 1),
                                         regexp_replace(regexp_extract(pa.address, '^\s*\d+\s+([^,]+)', 1), '^[NSEW] ', ''),
                                         regexp_extract(pa.address, '(\d{5})(-\d{4})?\s*$', 1))
LEFT JOIN parcel_addr c ON c.k = addr_key(regexp_extract(pa.address, '^\s*(\d+)', 1),
                                         regexp_replace(regexp_extract(pa.address, '^\s*\d+\s+([^,]+)', 1), '^[NSEW] ', ''),
                                         pa.jurisdiction)
WHERE pa.apn IS NULL AND pa.permit_key NOT IN (SELECT permit_key FROM permit_apn_spatial)
  AND coalesce(z.apn, c.apn) IS NOT NULL;

-- ---------------------------------------------------------------- contractors (CSLB is the identity authority)
CREATE OR REPLACE TABLE cslb AS
SELECT
    LicenseNo AS license_number,
    trim(BusinessName) AS business_name,
    trim(FullBusinessName) AS full_business_name,
    norm_name(BusinessName) AS name_norm,
    norm_name(FullBusinessName) AS full_name_norm,
    trim(MailingAddress) AS address,
    upper(trim(City)) AS city,
    trim(ZIPCode) AS zip,
    trim(County) AS county,
    digits(BusinessPhone) AS phone,
    trim(BusinessType) AS business_type,
    trim(PrimaryStatus) AS primary_status,
    trim(SecondaryStatus) AS secondary_status,
    list_transform(string_split("Classifications(s)", '|'), x -> trim(x)) AS classifications,
    list_contains(list_transform(string_split("Classifications(s)", '|'), x -> trim(x)), 'C39') AS is_roofing_license,
    try_strptime(IssueDate, '%m/%d/%Y')::DATE AS issue_date,
    try_strptime(ExpirationDate, '%m/%d/%Y')::DATE AS expiration_date,
    trim(WCInsuranceCompany) AS workers_comp_carrier
FROM raw_cslb;

CREATE OR REPLACE TABLE cslb_names AS
SELECT license_number, name_norm AS n FROM cslb WHERE name_norm IS NOT NULL
UNION
SELECT license_number, full_name_norm FROM cslb WHERE full_name_norm IS NOT NULL;

-- Permit contractor strings -> CSLB license. Name evidence is a candidate, so the method is kept.
CREATE OR REPLACE TABLE permit_contractor_match AS
WITH cand AS (
    SELECT pa.permit_key, c.license_number,
           count(*) OVER (PARTITION BY pa.permit_key) AS candidates,
           row_number() OVER (PARTITION BY pa.permit_key
                              ORDER BY (c.county = 'Santa Clara') DESC, c.is_roofing_license DESC,
                                       (c.primary_status = 'CLEAR') DESC, c.issue_date DESC) AS rk
    FROM permit_all pa
    JOIN cslb_names cn ON cn.n = norm_name(pa.contractor_raw)
    JOIN cslb c ON c.license_number = cn.license_number
    WHERE pa.contractor_raw IS NOT NULL
)
SELECT permit_key, license_number,
       CASE WHEN candidates = 1 THEN 'cslb_unique_name' ELSE 'cslb_name_ranked_local_roofer' END AS match_method,
       candidates
FROM cand WHERE rk = 1;

-- BBB search results (roofing only) -> CSLB by phone, then by name.
CREATE OR REPLACE TABLE bbb AS
SELECT
    id AS bbb_id,
    regexp_replace(businessName, '</?em>', '', 'g') AS business_name,
    norm_name(regexp_replace(businessName, '</?em>', '', 'g')) AS name_norm,
    digits(CAST(phone[1] AS VARCHAR)) AS phone,
    address, city, postalcode,
    rating AS bbb_rating,
    TRY_CAST(ratingScore AS DOUBLE) AS bbb_rating_score,
    coalesce(bbbMember, false) AS bbb_accredited,
    'https://www.bbb.org' || reportUrl AS bbb_url,
    tobText AS bbb_category,
    '{{FETCHED.bbb_roofers}}' AS fetched_at
FROM raw_bbb
WHERE coalesce(tobText, '') ILIKE '%roof%' OR CAST(categories AS VARCHAR) ILIKE '%roof%';

CREATE OR REPLACE TABLE bbb_match AS
WITH keys AS (
    SELECT license_number, right(phone, 10) AS k, 'bbb_phone' AS match_method, 1 AS priority FROM cslb WHERE length(phone) >= 10
    UNION ALL SELECT license_number, name_norm, 'bbb_name', 2 FROM cslb WHERE name_norm IS NOT NULL
    UNION ALL SELECT license_number, full_name_norm, 'bbb_name', 2 FROM cslb WHERE full_name_norm IS NOT NULL
), bkeys AS (
    SELECT bbb_id, right(phone, 10) AS k, 1 AS priority FROM bbb WHERE length(phone) >= 10
    UNION ALL SELECT bbb_id, name_norm, 2 FROM bbb WHERE name_norm IS NOT NULL
)
SELECT license_number, bbb_id, match_method FROM (
    SELECT k.license_number, b.bbb_id, k.match_method,
           row_number() OVER (PARTITION BY k.license_number ORDER BY k.priority, bb.bbb_accredited DESC) AS rk
    FROM keys k
    JOIN bkeys b ON b.k = k.k AND b.priority = k.priority
    JOIN bbb bb ON bb.bbb_id = b.bbb_id
) WHERE rk = 1;

-- Overture roofing businesses -> CSLB by phone/name (website, email).
CREATE OR REPLACE TABLE place_match AS
WITH wanted AS (
    SELECT * FROM cslb
    WHERE (is_roofing_license AND county = 'Santa Clara') OR license_number IN (SELECT license_number FROM permit_contractor_match)
), keys AS (
    SELECT license_number, right(phone, 10) AS k FROM wanted WHERE length(phone) >= 10
    UNION SELECT license_number, name_norm FROM wanted WHERE name_norm IS NOT NULL
    UNION SELECT license_number, full_name_norm FROM wanted WHERE full_name_norm IS NOT NULL
), pkeys AS (
    SELECT id, confidence, right(digits(phone), 10) AS k FROM raw_overture WHERE length(digits(phone)) >= 10
    UNION ALL SELECT id, confidence, norm_name(name) FROM raw_overture WHERE norm_name(name) IS NOT NULL
)
SELECT license_number, place_id FROM (
    SELECT k.license_number, p.id AS place_id,
           row_number() OVER (PARTITION BY k.license_number ORDER BY p.confidence DESC) AS rk
    FROM keys k JOIN pkeys p ON p.k = k.k
) WHERE rk = 1;

CREATE OR REPLACE TABLE contractor AS
WITH permit_counts AS (
    SELECT m.license_number,
           count(*) AS permits_total,
           count(*) FILTER (WHERE pa.is_roofing) AS roofing_permits,
           count(*) FILTER (WHERE pa.is_roofing AND pa.status IN ('open', 'expired_not_finaled')) AS unfinaled_roofing_permits,
           max(pa.issued_date) AS last_permit_issued
    FROM permit_contractor_match m JOIN permit_all pa USING (permit_key)
    GROUP BY 1
)
SELECT
    'cslb:' || c.license_number AS contractor_id,
    c.license_number, c.business_name, c.full_business_name, c.business_type,
    c.address, c.city, c.zip, c.county, c.phone,
    c.primary_status AS license_status, c.secondary_status, c.classifications, c.is_roofing_license,
    c.issue_date AS license_issue_date, c.expiration_date AS license_expiration_date, c.workers_comp_carrier,
    b.bbb_rating, b.bbb_rating_score, b.bbb_accredited, b.bbb_url, bm.match_method AS bbb_match_method,
    o.website, o.email, o.id AS overture_place_id,
    coalesce(pc.permits_total, 0) AS permits_total,
    coalesce(pc.roofing_permits, 0) AS roofing_permits,
    coalesce(pc.unfinaled_roofing_permits, 0) AS unfinaled_roofing_permits,
    pc.last_permit_issued,
    'cslb_master' AS source_id,
    'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=' || c.license_number AS source_url,
    '{{FETCHED.cslb_master}}' AS fetched_at,
    '{{RUN_ID}}' AS run_id
FROM cslb c
LEFT JOIN permit_counts pc USING (license_number)
LEFT JOIN bbb_match bm USING (license_number)
LEFT JOIN bbb b ON b.bbb_id = bm.bbb_id
LEFT JOIN place_match pm USING (license_number)
LEFT JOIN raw_overture o ON o.id = pm.place_id
WHERE (c.is_roofing_license AND c.county = 'Santa Clara')
   OR pc.license_number IS NOT NULL;

-- ---------------------------------------------------------------- permit (final)
CREATE OR REPLACE TABLE permit AS
SELECT
    pa.permit_key, pa.source_id, pa.jurisdiction, pa.permit_number,
    coalesce(pa.apn, s.apn, a.apn) AS apn,
    CASE WHEN pa.apn IS NOT NULL THEN 'source_apn' WHEN s.apn IS NOT NULL THEN 'point_in_parcel'
         WHEN a.apn IS NOT NULL THEN 'unique_address_match' END AS apn_basis,
    pa.address, pa.work_type, pa.description, pa.is_roofing, pa.roofing_basis,
    pa.status_raw, pa.status,
    pa.applied_date, pa.issued_date, pa.finaled_date, pa.expired_date,
    CASE WHEN pa.status IN ('open', 'expired_not_finaled') AND pa.issued_date IS NOT NULL
         THEN date_diff('day', pa.issued_date, DATE '{{AS_OF}}') END AS days_open,
    pa.valuation,
    pa.contractor_raw,
    m.license_number AS contractor_license_number,
    m.match_method AS contractor_match_method,
    c.business_name AS contractor_name,
    c.bbb_rating AS contractor_bbb_rating,
    c.bbb_accredited AS contractor_bbb_accredited,
    coalesce(pa.lat, pr.lat) AS lat,
    coalesce(pa.lon, pr.lon) AS lon,
    pa.source_url, pa.fetched_at,
    '{{RUN_ID}}' AS run_id
FROM permit_all pa
LEFT JOIN permit_apn_spatial s USING (permit_key)
LEFT JOIN permit_apn_address a USING (permit_key)
LEFT JOIN property pr ON pr.apn = coalesce(pa.apn, s.apn, a.apn)
LEFT JOIN permit_contractor_match m USING (permit_key)
LEFT JOIN contractor c ON c.license_number = m.license_number;

