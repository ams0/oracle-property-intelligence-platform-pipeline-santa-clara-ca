-- Derived lead signals, businesses and the reconciliation report.
-- Runs after transform.sql and after windowed permit sources were merged with the previous run.
INSTALL spatial; LOAD spatial;

-- ---------------------------------------------------------------- roof age + lead signals per property
CREATE OR REPLACE TABLE property_roof AS
WITH roof_permits AS (
    SELECT apn,
           max(finaled_date) FILTER (WHERE status = 'closed') AS last_roof_finaled,
           max(issued_date) FILTER (WHERE status IN ('closed', 'closed_inferred')) AS last_roof_closed_issued,
           count(*) AS roofing_permits,
           count(*) FILTER (WHERE status = 'open') AS open_roofing_permits,
           count(*) FILTER (WHERE status = 'expired_not_finaled') AS expired_unfinaled_roofing_permits,
           max(days_open) FILTER (WHERE status = 'open') AS oldest_open_roofing_days
    FROM permit WHERE is_roofing AND apn IS NOT NULL GROUP BY apn
)
SELECT
    p.*,
    coalesce(r.roofing_permits, 0) AS roofing_permits,
    coalesce(r.open_roofing_permits, 0) AS open_roofing_permits,
    coalesce(r.expired_unfinaled_roofing_permits, 0) AS expired_unfinaled_roofing_permits,
    r.oldest_open_roofing_days,
    coalesce(r.last_roof_finaled, r.last_roof_closed_issued) AS last_roof_completed,
    CASE WHEN coalesce(r.last_roof_finaled, r.last_roof_closed_issued) IS NOT NULL
              THEN year(DATE '{{AS_OF}}') - year(coalesce(r.last_roof_finaled, r.last_roof_closed_issued))
         WHEN p.year_built IS NOT NULL THEN year(DATE '{{AS_OF}}') - p.year_built
    END AS roof_age_years,
    CASE WHEN r.last_roof_finaled IS NOT NULL THEN 'roofing_permit_finaled'
         WHEN r.last_roof_closed_issued IS NOT NULL THEN 'roofing_permit_closed'
         WHEN p.year_built IS NOT NULL THEN 'year_built'
    END AS roof_age_basis,
    CASE WHEN r.last_roof_finaled IS NOT NULL THEN 'high'
         WHEN r.last_roof_closed_issued IS NOT NULL THEN 'medium'
         WHEN p.year_built IS NOT NULL AND p.jurisdiction IN ('SAN JOSE', 'CAMPBELL', 'GILROY') THEN 'medium'
         WHEN p.year_built IS NOT NULL THEN 'low'
    END AS roof_age_confidence,
    year(DATE '{{AS_OF}}') - p.last_transfer_year AS years_since_transfer
FROM property p
LEFT JOIN roof_permits r USING (apn);

-- ---------------------------------------------------------------- businesses (Overture places inside the county)
CREATE OR REPLACE TABLE business AS
SELECT
    'overture:' || o.id AS business_id,
    o.name, o.basic_category, o.category, o.operating_status, o.confidence,
    o.website, o.phone, o.email, o.address, upper(o.locality) AS city, left(o.postcode, 5) AS zip,
    o.lat, o.lon,
    (o.category = 'roofing' OR o.basic_category ILIKE '%roof%' OR o.name ILIKE '%roof%') AS is_roofing_business,
    pm.license_number AS cslb_license_number,
    'overture_places' AS source_id,
    'https://explore.overturemaps.org/#16/' || o.lat || '/' || o.lon AS source_url,
    o.source_datasets,
    '{{FETCHED.overture_places}}' AS fetched_at,
    '{{RUN_ID}}' AS run_id
FROM raw_overture o
LEFT JOIN (SELECT place_id, min(license_number) AS license_number FROM place_match GROUP BY place_id) pm ON pm.place_id = o.id
WHERE left(o.postcode, 5) IN (SELECT zip FROM county_zips)
   OR upper(o.locality) IN (SELECT DISTINCT city FROM property_base WHERE city IS NOT NULL);

-- ---------------------------------------------------------------- reconciliation report
CREATE TABLE IF NOT EXISTS permit_carried AS SELECT * FROM permit LIMIT 0;

CREATE OR REPLACE TABLE reconciliation AS
SELECT * FROM (VALUES
    ('property', 'parcel polygon rows merged into one property per APN',
        (SELECT count(*) FROM parcel_geom) - (SELECT count(*) FROM property_base)),
    ('property', 'parcel rows dropped: missing APN or geometry',
        (SELECT count(*) FROM raw_parcels) - (SELECT count(*) FROM parcel_geom)),
    ('permit', 'San Jose duplicate rows across Active/Last-30/Expired extracts collapsed',
        (SELECT count(*) FROM raw_sj) - (SELECT count(*) FROM permit_sj)),
    ('permit', 'Campbell duplicate rows across Active/Inactive layers collapsed',
        (SELECT count(*) FROM raw_campbell) - (SELECT count(*) FROM permit_campbell)),
    ('permit', 'permits linked to parcel by source APN', (SELECT count(*) FROM permit WHERE apn_basis = 'source_apn')),
    ('permit', 'permits linked to parcel by point-in-polygon', (SELECT count(*) FROM permit WHERE apn_basis = 'point_in_parcel')),
    ('permit', 'permits linked to parcel by unique address match', (SELECT count(*) FROM permit WHERE apn_basis = 'unique_address_match')),
    ('permit', 'permits with no parcel link', (SELECT count(*) FROM permit WHERE apn IS NULL)),
    ('contractor', 'permit contractor strings matched to a CSLB license', (SELECT count(*) FROM permit_contractor_match)),
    ('contractor', 'permit contractor strings with no CSLB match', (SELECT count(*) FROM permit WHERE contractor_raw IS NOT NULL AND contractor_license_number IS NULL)),
    ('contractor', 'CSLB contractors matched to a BBB profile', (SELECT count(*) FROM contractor WHERE bbb_rating IS NOT NULL)),
    ('contractor', 'CSLB contractors matched to an Overture place', (SELECT count(*) FROM contractor WHERE overture_place_id IS NOT NULL)),
    ('permit', 'permits carried forward from the previous run (windowed sources)', (SELECT count(*) FROM permit_carried)),
    ('permit', 'San Jose permits that left the Active list since the previous run (closed_inferred)', (SELECT count(*) FROM permit_carried WHERE status = 'closed_inferred')),
    ('ownership', 'properties with owner name (Los Gatos roll)', (SELECT count(*) FROM property WHERE owner_name IS NOT NULL))
) t(entity, check_name, count);
