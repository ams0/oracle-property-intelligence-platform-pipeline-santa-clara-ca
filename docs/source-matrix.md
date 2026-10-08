# Source Matrix — Santa Clara County, CA (FIPS 06085)

Phase 0 discovery, probed 2026-10-08. Every source below was hit directly; counts are observed, not estimated.

## Loadable today

| Domain | Source | Access | Records | Key fields | Join key | Observed speed |
|---|---|---|---|---|---|---|
| Parcels + coordinates | County Socrata `ubcd-cewv` (Parcels) | SODA paging, 50k/page, no auth | 504,717 rows / 494,841 APNs | APN, situs address, jurisdiction, polygon | `apn` | 167 s full pull (~18 s/page) |
| Year built + last deed | County Planning ArcGIS `Parcels_Public_View` | FeatureServer, 2k/page, no auth | 504,648 | `Year_Built` (94% valid), `Document_Number` (98%) | `APN` | ~0.9 s/page, ~253 pages |
| Owner / mailing / exact transfer (partial) | Los Gatos `ParcelsWeb` (+ Campbell assessor layer, unofficial, 2023) | FeatureServer | 18,984 (+12,638) | `ASSESSEE`, mailing addr, `LTST_TRANSFER_DT`, use code | `APN` | small |
| Permits — San Jose | CKAN `data.sanjoseca.gov` (Active, Expired, Under Inspection, Last 30d) | CSV / `datastore_search_sql` | 103,827; **7,537 reroof** (972 open) | contractor (85%), APN (98%), issue/final date, valuation | APN | seconds |
| Permits — Campbell | ArcGIS Active + Inactive Building | FeatureServer | 40,965; ~3,140 roofing | status, create/issue dates, lat/lon, work type | address / lat-lon | seconds |
| Permits — Gilroy | ArcGIS `Permit_Activity` | FeatureServer | 5,940; 681 roofing | applied/issued/finaled/expiration dates, APN, point | APN | seconds |
| Contractors | CSLB License Master | single GET `DownLoadFile.ashx?fName=MasterLicenseData&type=C` | 243,786 statewide; **231 C39 roofers in county** | license #, status, classifications, bonds, WC, address | `LicenseNo`; permits by normalized name | 124 s, 77.6 MB |
| Businesses | Overture Maps Places `2026-09-23.1` | DuckDB over S3 Parquet | 99,836 in county cities; 188–248 roofing | category, phone, website, email, point | name + phone | 13 s bbox extract |
| BBB ratings | BBB search JSON `/api/search` | unauthenticated JSON; site itself Cloudflare-gated | ~225 results per city query | rating, accredited, lat/lon, phone | name + phone | low volume only |

## Derived signals

- **Roof age** = years since latest completed roofing permit; else `Year_Built`. Basis + confidence stored per property.
- **Long-open roofing permit** = issued, not finaled, ordered by days since issue (San Jose Active, Campbell/Gilroy status).
- **Ownership tenure (proxy)** = last recorded deed year, from sequential `Document_Number` calibrated against Los Gatos real transfer dates (99% doc-number agreement, ~1% out-of-order). Includes non-sale transfers (e.g. trusts) — labeled as a proxy.
- **Out-of-area owner** = mailing ZIP/city ≠ situs — only where owner data exists (~6% of parcels).

## Source limitations (documented, not faked)

| Gap | Reason |
|---|---|
| Owner name / mailing address county-wide | No free county-wide source; Assessor site behind Cloudflare challenge (not bypassed). Secured roll is a paid Assessor product. |
| Permits: Santa Clara (city), Cupertino, Los Altos, Mountain View, Sunnyvale | Cloudflare 403 or portal-only search; no bulk export. |
| Permits: Saratoga, County unincorporated | No feed (County permits only in Accela search UI). |
| Permits: Palo Alto | Only stale 2017–2020 file; current data UI-only. |
| Permits: Los Gatos, Morgan Hill | Monthly PDFs — parseable, stretch goal. Los Gatos is the only current source with CSLB license #. |
| Contractor license # on permits | Not present in San Jose/Campbell/Gilroy feeds → name matching to CSLB (candidate match, flagged). |
| CSLB Personnel file | Server cuts download at 150 s. |
| Socrata bulk CSV export | Deprecated (HTTP 410) → paged SODA instead. |
| BBB | Website Cloudflare-gated; only low-volume search JSON used, with attribution. |
| Public IPFS gateways | ipfs.io / dweb.link / w3s.link stopped serving plain HTTP on 2026-09-21 (429); trustless `?format=raw` / CAR still served. Verification uses trustless responses + digest check. |

Coverage of loaded permit jurisdictions: San Jose + Campbell + Gilroy ≈ 54% of county parcels.
