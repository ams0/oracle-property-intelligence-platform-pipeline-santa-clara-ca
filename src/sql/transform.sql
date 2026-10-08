-- Oracle canonical model for Santa Clara County.
-- Placeholders: {{RAW}} raw capture dir, {{RUN_ID}}, {{AS_OF}} (YYYY-MM-DD), {{FETCHED.<source>}} capture timestamps.
-- Every canonical row carries source_id / source_record_id / source_url / fetched_at / run_id.

INSTALL spatial; LOAD spatial;

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE MACRO digits(s) AS nullif(regexp_replace(coalesce(s, ''), '[^0-9]', '', 'g'), '');
CREATE OR REPLACE MACRO norm_name(s) AS nullif(trim(regexp_replace(regexp_replace(regexp_replace(
    upper(replace(coalesce(s, ''), '&', ' AND ')),
    '[^A-Z0-9 ]', ' ', 'g'),
    '\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION|CO|COMPANY|LTD|THE|DBA|LP|LLP|PC)\b', ' ', 'g'),
    '\s+', ' ', 'g')), '');
-- Dates before 1901 are publisher placeholders (e.g. Campbell's 1900-01-01), not events.
CREATE OR REPLACE MACRO real_date(d) AS CASE WHEN d >= DATE '1901-01-01' THEN d END;
CREATE OR REPLACE MACRO ms_date(ms) AS real_date(CASE WHEN ms IS NULL THEN NULL ELSE CAST(to_timestamp(CAST(ms AS DOUBLE) / 1000) AS DATE) END);
CREATE OR REPLACE MACRO us_date(s) AS real_date(CAST(try_strptime(s, '%m/%d/%Y %I:%M:%S %p') AS DATE));
-- Address key: house number + first street-name word + (zip5 or city). Used only for unique matches.
CREATE OR REPLACE MACRO addr_key(house, street, place) AS
    CASE WHEN digits(house) IS NOT NULL AND nullif(trim(street), '') IS NOT NULL AND nullif(trim(place), '') IS NOT NULL
         THEN digits(house) || '|' || split_part(upper(trim(street)), ' ', 1) || '|' || upper(trim(place)) END;
-- Roofing work, excluding rooftop solar / equipment that merely mentions a roof.
CREATE OR REPLACE MACRO is_roof_text(s) AS
    regexp_matches(coalesce(s, ''), '(?i)(re-?\s?roof|roofing|roof\s*(replace|repair|over|tear|covering|install)|tear[- ]?off|new roof|comp(osition)? shingle)')
    AND NOT regexp_matches(coalesce(s, ''), '(?i)(solar|photovoltaic|\bPV\b|roof[- ]?mount)');

-- ---------------------------------------------------------------- raw staging
CREATE OR REPLACE TABLE raw_parcels AS SELECT * FROM read_csv('{{RAW}}/scc_parcels.csv', all_varchar = true, header = true);
CREATE OR REPLACE TABLE raw_planning AS SELECT * FROM read_json('{{RAW}}/scc_planning_parcels.ndjson', format = 'newline_delimited', columns = {APN: 'VARCHAR', Year_Built: 'VARCHAR', Document_Number: 'VARCHAR', Situs_Address_Full: 'VARCHAR'});
CREATE OR REPLACE TABLE raw_lg AS SELECT * FROM read_json('{{RAW}}/los_gatos_roll.ndjson', format = 'newline_delimited', union_by_name = true, sample_size = -1);
CREATE OR REPLACE TABLE raw_sj AS SELECT * FROM read_json('{{RAW}}/sj_permits.ndjson', format = 'newline_delimited', union_by_name = true, sample_size = -1);
CREATE OR REPLACE TABLE raw_campbell AS SELECT * FROM read_json('{{RAW}}/campbell_permits.ndjson', format = 'newline_delimited', union_by_name = true, sample_size = -1);
CREATE OR REPLACE TABLE raw_gilroy AS SELECT * FROM read_json('{{RAW}}/gilroy_permits.ndjson', format = 'newline_delimited', union_by_name = true, sample_size = -1);
CREATE OR REPLACE TABLE raw_cslb AS SELECT * FROM read_csv('{{RAW}}/cslb_master.csv', all_varchar = true, header = true);
CREATE OR REPLACE TABLE raw_overture AS SELECT * FROM read_parquet('{{RAW}}/overture_places.parquet');
CREATE OR REPLACE TABLE raw_bbb AS SELECT * FROM read_json('{{RAW}}/bbb_roofers.ndjson', format = 'newline_delimited', union_by_name = true, sample_size = -1);

-- ---------------------------------------------------------------- property (parcel backbone)
-- Parcels with several polygons (or several situs rows) share one APN: reconcile to one property.
CREATE OR REPLACE TABLE parcel_geom AS
SELECT digits(apn) AS apn, ST_GeomFromText(the_geom) AS geom, *
EXCLUDE (apn, the_geom)
FROM raw_parcels
WHERE digits(apn) IS NOT NULL AND the_geom IS NOT NULL;

CREATE OR REPLACE TABLE property_base AS
SELECT
    apn,
    count(*) AS source_rows,
    arg_max(trim(concat_ws(' ', situs_house_number, situs_house_number_suffix, situs_street_direction, situs_street_name, situs_street_type,
                           CASE WHEN situs_unit_number IS NOT NULL THEN '#' || situs_unit_number END)),
            TRY_CAST(shape_area AS DOUBLE)) AS address,
    arg_max(upper(situs_city_name), TRY_CAST(shape_area AS DOUBLE)) AS city,
    arg_max(left(situs_zip_code, 5), TRY_CAST(shape_area AS DOUBLE)) AS zip,
    arg_max(upper(jurisdiction), TRY_CAST(shape_area AS DOUBLE)) AS jurisdiction,
    arg_max(situs_house_number, TRY_CAST(shape_area AS DOUBLE)) AS house_number,
    arg_max(regexp_replace(upper(coalesce(situs_street_direction || ' ', '') || situs_street_name), '^[NSEW] ', ''), TRY_CAST(shape_area AS DOUBLE)) AS street_name,
    ST_Union_Agg(geom) AS geom
FROM parcel_geom
GROUP BY apn;

-- Calibrate recorder document number -> year using parcels that publish both (Los Gatos roll).
CREATE OR REPLACE TABLE doc_year_calibration AS
SELECT CAST(LTST_TRANSFER_DT / 10000 AS INT) AS year,
       count(*) AS samples,
       quantile_cont(TRY_CAST(LTST_DOCUMENT_NU AS BIGINT), 0.05) AS doc_p05,
       quantile_cont(TRY_CAST(LTST_DOCUMENT_NU AS BIGINT), 0.50) AS doc_p50
FROM raw_lg
WHERE TRY_CAST(LTST_DOCUMENT_NU AS BIGINT) >= 10000000 AND LTST_TRANSFER_DT >= 19870101
GROUP BY 1
HAVING count(*) >= 20;

CREATE OR REPLACE TABLE planning AS
SELECT digits(APN) AS apn,
       CASE WHEN TRY_CAST(Year_Built AS INT) BETWEEN 1800 AND year(DATE '{{AS_OF}}') THEN TRY_CAST(Year_Built AS INT) END AS year_built,
       TRY_CAST(digits(Document_Number) AS BIGINT) AS last_document_number
FROM raw_planning
WHERE digits(APN) IS NOT NULL
QUALIFY row_number() OVER (PARTITION BY digits(APN) ORDER BY Year_Built DESC NULLS LAST) = 1;

CREATE OR REPLACE TABLE ownership AS
SELECT digits(APN) AS apn,
       nullif(trim(ASSESSEE), '') AS owner_name,
       nullif(trim(concat_ws(', ', nullif(trim(MAILING_ADDRESS), ''), nullif(trim(MAILCITY), ''), nullif(trim(MAILSTATE), ''), nullif(trim(MAILZIP), ''))), '') AS owner_mailing_address,
       upper(trim(MAILCITY)) AS mail_city,
       upper(trim(MAILSTATE)) AS mail_state,
       left(trim(MAILZIP), 5) AS mail_zip,
       CASE WHEN LTST_TRANSFER_DT > 18000101 THEN strptime(CAST(LTST_TRANSFER_DT AS VARCHAR), '%Y%m%d')::DATE END AS last_transfer_date,
       'los_gatos_roll' AS source_id,
       '{{FETCHED.los_gatos_roll}}' AS fetched_at
FROM raw_lg
WHERE digits(APN) IS NOT NULL AND nullif(trim(ASSESSEE), '') IS NOT NULL
QUALIFY row_number() OVER (PARTITION BY digits(APN) ORDER BY AS_OF_DATE DESC) = 1;

CREATE OR REPLACE TABLE county_zips AS SELECT DISTINCT zip FROM property_base WHERE zip IS NOT NULL;

CREATE OR REPLACE TABLE property AS
WITH cal_mono AS (
    -- Monotone step function: a year applies from the smallest document number seen from it onward.
    SELECT year, min(doc_p05) OVER (ORDER BY year DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS doc_floor
    FROM doc_year_calibration
)
SELECT
    p.apn,
    p.address,
    p.city,
    p.zip,
    p.jurisdiction,
    ST_Y(ST_Centroid(p.geom)) AS lat,
    ST_X(ST_Centroid(p.geom)) AS lon,
    p.source_rows AS parcel_source_rows,
    pl.year_built,
    pl.last_document_number,
    -- Exact transfer date where a roll publishes it; otherwise estimate from the sequential recorder number.
    coalesce(year(o.last_transfer_date),
             CASE WHEN pl.last_document_number >= 10000000 THEN cal.year END) AS last_transfer_year,
    CASE WHEN o.last_transfer_date IS NOT NULL THEN 'recorded_transfer_date'
         WHEN pl.last_document_number >= 10000000 THEN 'estimated_from_recorder_document_number'
         WHEN pl.last_document_number IS NOT NULL THEN 'recorder_document_before_1987'
    END AS transfer_basis,
    o.owner_name,
    o.owner_mailing_address,
    CASE WHEN o.apn IS NULL THEN NULL
         WHEN o.mail_state IS NOT NULL AND o.mail_state <> 'CA' THEN 'out_of_state'
         WHEN o.mail_zip IS NOT NULL AND o.mail_zip NOT IN (SELECT zip FROM county_zips) THEN 'out_of_county'
         WHEN o.mail_zip IS NOT NULL AND o.mail_zip <> p.zip THEN 'in_county_other_zip'
         ELSE 'local'
    END AS owner_locality,
    'scc_parcels' AS source_id,
    'https://data.sccgov.org/resource/ubcd-cewv.json?apn=' || p.apn AS source_url,
    '{{FETCHED.scc_parcels}}' AS fetched_at,
    '{{RUN_ID}}' AS run_id
FROM property_base p
LEFT JOIN planning pl USING (apn)
LEFT JOIN ownership o USING (apn)
ASOF LEFT JOIN cal_mono cal ON pl.last_document_number >= cal.doc_floor;

-- ---------------------------------------------------------------- permits (unified across jurisdictions)
CREATE OR REPLACE TABLE permit_sj AS
SELECT
    'sj:' || FOLDERNUMBER AS permit_key,
    'sj_permits' AS source_id,
    'SAN JOSE' AS jurisdiction,
    FOLDERNUMBER AS permit_number,
    digits(ASSESSORS_PARCEL_NUMBER) AS apn,
    trim(regexp_replace(gx_location, '\s+', ' ', 'g')) AS address,
    concat_ws(' / ', FOLDERDESC, SUBTYPEDESCRIPTION, WORKDESCRIPTION) AS work_type,
    FOLDERNAME AS description,
    (coalesce(FOLDERDESC, '') NOT ILIKE 'Information Request%'
     AND (WORKDESCRIPTION ILIKE '%roof%' OR is_roof_text(FOLDERNAME))) AS is_roofing,
    CASE WHEN WORKDESCRIPTION ILIKE '%roof%' THEN 'work_type' WHEN is_roof_text(FOLDERNAME) THEN 'description' END AS roofing_basis,
    _dataset AS status_raw,
    CASE WHEN us_date(FINALDATE) IS NOT NULL THEN 'closed'
         WHEN _dataset IN ('active', 'last30') THEN 'open'
         WHEN _dataset = 'expired' THEN 'expired_not_finaled'
    END AS status,
    CAST(NULL AS DATE) AS applied_date,
    us_date(ISSUEDATE) AS issued_date,
    us_date(FINALDATE) AS finaled_date,
    CAST(NULL AS DATE) AS expired_date,
    TRY_CAST(PERMITVALUATION AS DOUBLE) AS valuation,
    nullif(trim(split_part(CONTRACTOR, '  ', 1)), '') AS contractor_raw,
    CAST(NULL AS VARCHAR) AS contractor_license_raw,
    CAST(NULL AS DOUBLE) AS lat,
    CAST(NULL AS DOUBLE) AS lon,
    'https://data.sanjoseca.gov/dataset/building-permits' AS source_url,
    '{{FETCHED.sj_permits}}' AS fetched_at
FROM raw_sj
WHERE FOLDERNUMBER IS NOT NULL
-- The same permit appears in Active, Last-30 and Expired extracts: keep the most current view.
QUALIFY row_number() OVER (PARTITION BY FOLDERNUMBER
                           ORDER BY (FINALDATE IS NOT NULL) DESC,
                                    CASE _dataset WHEN 'active' THEN 0 WHEN 'last30' THEN 1 ELSE 2 END) = 1;

CREATE OR REPLACE TABLE permit_campbell AS
SELECT
    'campbell:' || ProjectNumber AS permit_key,
    'campbell_permits' AS source_id,
    'CAMPBELL' AS jurisdiction,
    ProjectNumber AS permit_number,
    CAST(NULL AS VARCHAR) AS apn,
    upper(Address) || ', CAMPBELL CA' AS address,
    concat_ws(' / ', DesignationType, WorkType) AS work_type,
    ProjectDescription AS description,
    (WorkType ILIKE '%roof%' OR is_roof_text(ProjectDescription)) AS is_roofing,
    CASE WHEN WorkType ILIKE '%roof%' THEN 'work_type' WHEN is_roof_text(ProjectDescription) THEN 'description' END AS roofing_basis,
    Status AS status_raw,
    CASE WHEN Status ILIKE '%finaled%' OR Status ILIKE '%closed%' THEN 'closed'
         WHEN Status ILIKE '%expired%' THEN 'expired_not_finaled'
         WHEN Status IN ('Permit Issued', 'Stop Work') THEN 'open'
         ELSE 'pending'
    END AS status,
    ms_date(CreateDate) AS applied_date,
    ms_date(IssuedDate) AS issued_date,
    CAST(NULL AS DATE) AS finaled_date,
    CAST(NULL AS DATE) AS expired_date,
    CAST(NULL AS DOUBLE) AS valuation,
    nullif(trim(ProjectName), '') AS contractor_raw,
    CAST(NULL AS VARCHAR) AS contractor_license_raw,
    TRY_CAST(Latitude AS DOUBLE) AS lat,
    TRY_CAST(Longitude AS DOUBLE) AS lon,
    'https://services7.arcgis.com/RDyUffIeciKdYmX2/arcgis/rest/services/CampbellPermits_' || CASE _layer WHEN 'active' THEN 'ActiveBuilding' ELSE 'Inactive_Building' END || '/FeatureServer/0/query?where=OBJECTID=' || OBJECTID || '&outFields=*&f=json' AS source_url,
    '{{FETCHED.campbell_permits}}' AS fetched_at
FROM raw_campbell
WHERE ProjectNumber IS NOT NULL
QUALIFY row_number() OVER (PARTITION BY ProjectNumber ORDER BY UpdateDate DESC NULLS LAST) = 1;

CREATE OR REPLACE TABLE permit_gilroy AS
SELECT
    'gilroy:' || PermitNum AS permit_key,
    'gilroy_permits' AS source_id,
    'GILROY' AS jurisdiction,
    PermitNum AS permit_number,
    digits(ParcelNum) AS apn,
    upper(Address) || ', GILROY CA' AS address,
    concat_ws(' / ', PermitType, WorkClass) AS work_type,
    PermitDesc AS description,
    (WorkClass ILIKE '%roof%' OR is_roof_text(PermitDesc)) AS is_roofing,
    CASE WHEN WorkClass ILIKE '%roof%' THEN 'work_type' WHEN is_roof_text(PermitDesc) THEN 'description' END AS roofing_basis,
    PermitStatus AS status_raw,
    CASE WHEN ms_date(FinaledDate) IS NOT NULL OR PermitStatus IN ('Complete', 'Finaled', 'Closed') THEN 'closed'
         WHEN PermitStatus ILIKE '%expired%' THEN 'expired_not_finaled'
         WHEN PermitStatus ILIKE 'issued%' OR ms_date(IssueDate) IS NOT NULL THEN 'open'
         ELSE 'pending'
    END AS status,
    ms_date(ApplicationDate) AS applied_date,
    ms_date(IssueDate) AS issued_date,
    ms_date(FinaledDate) AS finaled_date,
    ms_date(ExpirationDate) AS expired_date,
    CAST(NULL AS DOUBLE) AS valuation,
    CAST(NULL AS VARCHAR) AS contractor_raw,
    CAST(NULL AS VARCHAR) AS contractor_license_raw,
    TRY_CAST(_y AS DOUBLE) AS lat,
    TRY_CAST(_x AS DOUBLE) AS lon,
    'https://services8.arcgis.com/n7NW5ijV4dJUmrID/arcgis/rest/services/Permit_Activity/FeatureServer/1/query?where=OBJECTID=' || OBJECTID || '&outFields=*&f=json' AS source_url,
    '{{FETCHED.gilroy_permits}}' AS fetched_at
FROM raw_gilroy
WHERE PermitNum IS NOT NULL
QUALIFY row_number() OVER (PARTITION BY PermitNum ORDER BY Last_Updated DESC NULLS LAST) = 1;

CREATE OR REPLACE TABLE permit_all AS
SELECT * FROM permit_sj UNION ALL BY NAME SELECT * FROM permit_campbell UNION ALL BY NAME SELECT * FROM permit_gilroy;

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

-- ---------------------------------------------------------------- roof age + lead signals per property
CREATE OR REPLACE TABLE property_roof AS
WITH roof_permits AS (
    SELECT apn,
           max(finaled_date) FILTER (WHERE status = 'closed') AS last_roof_finaled,
           max(issued_date) FILTER (WHERE status = 'closed') AS last_roof_closed_issued,
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
LEFT JOIN place_match pm ON pm.place_id = o.id
WHERE left(o.postcode, 5) IN (SELECT zip FROM county_zips)
   OR upper(o.locality) IN (SELECT DISTINCT city FROM property_base WHERE city IS NOT NULL);

-- ---------------------------------------------------------------- reconciliation report
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
    ('ownership', 'properties with owner name (Los Gatos roll)', (SELECT count(*) FROM property WHERE owner_name IS NOT NULL))
) t(entity, check_name, count);
