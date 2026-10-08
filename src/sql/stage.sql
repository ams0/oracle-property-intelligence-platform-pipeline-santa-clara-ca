-- Oracle staging: raw captures -> property backbone + unified permit list (permit_all).
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
-- Windowed captures can be empty, so permit layers are read with an explicit schema.
CREATE OR REPLACE TABLE raw_campbell AS SELECT * FROM read_json('{{RAW}}/campbell_permits.ndjson', format = 'newline_delimited', columns = {
    OBJECTID: 'BIGINT', ProjectNumber: 'VARCHAR', Status: 'VARCHAR', Address: 'VARCHAR', DesignationType: 'VARCHAR',
    WorkType: 'VARCHAR', ProjectDescription: 'VARCHAR', ProjectName: 'VARCHAR', Latitude: 'VARCHAR', Longitude: 'VARCHAR',
    CreateDate: 'BIGINT', IssuedDate: 'BIGINT', UpdateDate: 'BIGINT', _layer: 'VARCHAR'});
CREATE OR REPLACE TABLE raw_gilroy AS SELECT * FROM read_json('{{RAW}}/gilroy_permits.ndjson', format = 'newline_delimited', columns = {
    OBJECTID: 'BIGINT', PermitNum: 'VARCHAR', PermitStatus: 'VARCHAR', ParcelNum: 'VARCHAR', Address: 'VARCHAR',
    PermitType: 'VARCHAR', WorkClass: 'VARCHAR', PermitDesc: 'VARCHAR', ApplicationDate: 'BIGINT', IssueDate: 'BIGINT',
    FinaledDate: 'BIGINT', ExpirationDate: 'BIGINT', Last_Updated: 'BIGINT', _x: 'DOUBLE', _y: 'DOUBLE'});
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

