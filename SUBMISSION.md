# Oracle pipeline — Santa Clara County, CA: submission

| | |
|---|---|
| **Explorer UI (live)** | https://oracle-santa-clara.vercel.app |
| **MCP endpoint (live, Streamable HTTP, no auth)** | `https://oracle-santa-clara.vercel.app/api/mcp` |
| **IPNS name (latest run)** | `k51qzi5uqu5djx0ycpstlrvrpvem0ueb9f3hn9oqfifoth37h307ncxxxx2f8l` |
| **Run history (CIDs, deltas, verification)** | [`runs/history.json`](runs/history.json), one folder per run under [`runs/`](runs) |
| **Scheduled ingestion** | [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml), daily 09:17 UTC + on demand |
| **Source matrix + limitations** | [`docs/source-matrix.md`](docs/source-matrix.md) |
| **Consumer** | [Roofing CRM](https://roofing-crm-santa-clara.vercel.app), which reads only this MCP endpoint |

Everything below is real Santa Clara County data, captured from public sources on 2026-10-07/08.

## What was loaded

| Table | Rows | What it holds | Sources |
|---|---:|---|---|
| `property` | 494,841 | Every county APN: situs address, city/ZIP, parcel centroid lat/lon, year built, **roof age + basis + confidence**, roofing-permit counts, oldest open roofing permit, last transfer year (+ basis), owner name/mailing/locality where published | County Parcels (Socrata), County Planning `Parcels_Public_View` (ArcGIS), Los Gatos assessor roll, permits below |
| `permit` | 139,902 (~12.7k roofing) | Status (`open` / `finaled` / `expired_not_finaled` / `closed_inferred`), issue/final/expiry dates, **days open**, description, valuation, contractor raw name + CSLB match + BBB rating, APN + how it was linked | San Jose (CKAN), Campbell (ArcGIS), Gilroy (ArcGIS) |
| `contractor` | 4,958 (556 C-39 roofers, 77 with BBB) | CSLB license, status, classifications, bonds/workers' comp, BBB rating + accreditation, permit counts | CSLB License Master (243,786 statewide), BBB search JSON |
| `business` | 107,695 | Overture Places in the county, with category, phone and website, linked to CSLB/BBB | Overture Maps `2026-09-23.1` |

Every row carries `source_id`, `source_url`, `fetched_at` and `run_id`. The full field list and join keys are in [`docs/source-matrix.md`](docs/source-matrix.md).

**Roofing signals:**
- **Roof age:** the last *completed* roofing permit when one exists, otherwise year built. Each row stores its basis and confidence (`roofing_permit` = high, `year_built` = medium).
- **Long-open permits:** issued but not finaled, ordered by days open. "Stalled" permits (expired without a final inspection) are kept as a separate status.
- **Contractor identity:** the permit name is matched to the CSLB license by normalised name. The match method is stored, and BBB ratings are attached by name + phone.
- **Ownership tenure:** the last deed year, derived from the recorder `Document_Number` sequence. It is calibrated against Los Gatos's real transfer dates with an ASOF join and labelled as a proxy.
- **Out-of-area owners:** mailing locality compared with the situs, where an owner is published.

**Reconciliation:**
- Parcels are deduplicated to one row per APN.
- Each permit is linked to a parcel by source APN, then point-in-polygon, then a unique address match. Each link records which method was used.
- Contractors are deduplicated per CSLB license.
- Places are deduplicated per place, then matched to CSLB/BBB.
- The counts are published as `reconciliation.json` in every run.

## Continuous / incremental

`pnpm run pipeline capture|build|publish|verify --run <id> --mode full|incremental --since <date>`

1. **Capture.** Each source has a descriptor (`src/sources/registry.ts`).
   - Incremental mode pulls only windowed changes from the permit feeds: San Jose *last 30 days + active*, and Campbell/Gilroy `UpdateDate >= since`.
   - Reference tables are re-pulled in full.
   - Every capture records its row count, bytes, retries and duration.
   - If a publisher throttles or truncates (CSLB cuts downloads at about 150 s), the pipeline falls back to the **last good snapshot** and the source is marked `stale`. The run doesn't fail and data is never silently dropped.
   - For flaky sources, that last good raw capture is itself **pinned on IPFS**. Its CID and sha256 are in the committed [`runs/last-good.json`](runs/last-good.json), so a fresh CI runner with no local state can still fall back: it fetches the snapshot by CID and verifies it byte-for-byte. The run record names the snapshot CID it used.
2. **Build.** DuckDB SQL (`src/sql/*.sql`) stages, models and derives the tables.
   - In incremental runs, permits not in the window are **carried forward from the previous run's `permit.parquet`, read by CID**.
   - Permits that left San Jose's Active list become `closed_inferred`.
3. **Publish.**
   - Deltas are computed per table against the previous run's published tables (natural key + hash of stable columns → added/changed/removed/unchanged).
   - The run is then packed as **CIDv1 UnixFS**, imported to IPFS as a CAR, the manifest is written, and IPNS is moved to the new manifest.
4. **Verify.** Every manifest object is fetched from three public gateways this project doesn't operate. The bytes are hash-checked and the result is committed as `runs/<id>/verification.json`.

The [GitHub Actions workflow](.github/workflows/ingest.yml) runs all four steps daily on a free public runner and commits `runs/` back. Its run log is part of the evidence: [Actions runs](https://github.com/ams0/oracle-property-intelligence-platform-pipeline-santa-clara-ca/actions/workflows/ingest.yml).

| Run | Mode | Root CID | Manifest CID | Deltas vs previous |
|---|---|---|---|---|
| run-001 | full | `bafybeifo27botggjufgmbw76zgah3vqc65ihnl7kuzbiw2xizodh4eylx4` | `bafkreie5gr6twt5zvxvxuajy7qv324s3qiatalq4gydmg2r5rwwtwa2xiy` | — |
| run-002 | incremental (since 2026-10-07) | `bafybeidjlegqutw72gtoqpbiw7ij4xgvov232vykjhd37va7cknknsfh5e` | `bafkreigtk53zdxngkc7ef477touqd5sd5txdzverxtn5htsrrawhopk5uu` | permit 6,634 changed · property 10 changed · business 42 changed |
<!-- RUN-003 -->

Prior CIDs are never mutated. Each manifest names its `previous_run`, and the explorer's **History** tab re-fetches every earlier CID live to show it still resolves.

## IPFS publication

Each run's manifest (example: [`runs/run-002/manifest.json`](runs/run-002/manifest.json)) lists 18 objects:
- **Files:** each Parquet table, the coverage, deltas, history, sources and reconciliation JSON, the indexes, and sample extracts.
- **Directories:** `tables/`, `indexes/` and `samples/`.
- **Root and CAR:** the root directory, plus a **CAR of the root DAG**, which has its own CID.

Each object entry has these fields:
- `cid` (CIDv1 base32)
- `name` / `path`
- `size`
- `codec` (`file` / `directory` / `car`)
- `sha256`
- `gateway_urls`, derived from the CID
- `origins`, the Filebase multiaddr

**Retrieve and check it yourself** (no account needed):

```bash
CID=bafkreifhry4yowz2vu5hg5cv7dj37yi3o67nqcyp6ls2f2p5f4czkkxex4   # run-002 coverage.json
for gw in https://ipfs.io https://dweb.link; do
  curl -s "$gw/ipfs/$CID?format=raw" | shasum -a 256          # compare with manifest sha256
done
# whole snapshot, importable into any IPFS node without re-encoding:
curl -s "https://trustless-gateway.link/ipfs/bafybeidjlegqutw72gtoqpbiw7ij4xgvov232vykjhd37va7cknknsfh5e?format=car" > run-002.car
ipfs dag import run-002.car
```

Since 2026-09-21, public gateways (ipfs.io, dweb.link) answer only **trustless** requests (`?format=raw` / `?format=car`). Verification therefore fetches trustless responses and checks every block hash against its CID before comparing size and sha256. The explorer's **Manifest** tab runs this check live, per object, from Vercel.

**IPNS:**
- The name above is published through Filebase.
- The explorer doesn't trust a gateway's cached IPNS answer. It fetches the **signed record** from delegated routing (`delegated-ipfs.dev`, `cid.contact`), validates the signature and picks the highest sequence. The resolved manifest CID is shown alongside the name.
- Each run's `publish-result.json` records the sequence and the resolved CID.

## Zero ongoing Oracle infrastructure

| Piece | Where | Cost |
|---|---|---|
| Durable data | IPFS CIDs: pinned on Filebase (free tier, 3 regions); CARs retrievable by anyone and re-pinnable anywhere | $0 |
| Ingestion compute | GitHub Actions cron on a public repo | $0 |
| Database | DuckDB **in-process**: the CLI, the explorer and the MCP route each load the Parquet tables by CID into memory. No database server. | $0 |
| UI + MCP | One stateless Vercel function that resolves IPNS → manifest → tables, verifies sha256 and caches in `/tmp` | $0 (Hobby) |

The function holds no state. Delete it and redeploy it anywhere, or skip it entirely:

```bash
duckdb -c "SELECT city, count(*) FROM read_parquet('https://ipfs.filebase.io/ipfs/bafybeidjlegqutw72gtoqpbiw7ij4xgvov232vykjhd37va7cknknsfh5e/tables/property.parquet') WHERE roof_age_years >= 15 GROUP BY 1 ORDER BY 2 DESC"
```

## MCP / agent access

**Tools** (Zod-validated, with schema text written for agents):

| Tool | Answers |
|---|---|
| `find_aged_roofs` | Roof age ≥ N years within a radius of a city/ZIP/point |
| `find_open_roofing_permits` | Long-open (optionally stalled) roofing permits, with contractor, CSLB and BBB |
| `find_long_held_properties` | No transfer in more than N years, optionally filtered by owner locality |
| `get_property` | One property with all its permits |
| `get_contractor` | One contractor with permits and rating |
| `query_sql` | Read-only SQL |
| `get_pipeline_run` | Run status, counts, coverage and CIDs |

Every result carries **provenance**: `run_id`, `manifest_cid`, `root_cid` and how IPNS was resolved.

**Connect a client:**

```bash
claude mcp add --transport http santa-clara-oracle https://oracle-santa-clara.vercel.app/api/mcp
```

`GET /api/tools/<name>?…` mirrors the same tools over plain HTTP. The Roofing CRM's RAG agent uses this MCP server unchanged (Vercel AI SDK `createMCPClient`).

## Explorer UI (demo-script order)

1. **Run:** run summary, sources with status, rows, seconds, retries and stale flags, county coverage, counts and limitations.
2. **Manifest:** every object with CID, size, codec and sha256. A **Verify** button fetches it from public gateways and compares the digest.
3. **History:** all runs, CIDs and deltas; earlier CIDs are re-fetched live.
4. **Explore:** a Leaflet map with pin and radius → aged roofs / long-open roofing permits with contractor and BBB, each with basis and source link.
5. **SQL:** read-only DuckDB over the published tables.
6. **MCP:** endpoint, client config, and a live `tools/list` and tool call.

## Source limitations and speed

These are in [`docs/source-matrix.md`](docs/source-matrix.md); the main ones:
- **Permits** are published as bulk feeds only by San Jose, Campbell and Gilroy, which together cover about 54% of parcels. Other cities are Cloudflare-gated, search-only or PDF.
- **Owner names** are public only for Los Gatos (about 18k parcels); the county roll is a paid product. Ownership *tenure* is still available county-wide through the deed-number proxy.
- **Permits carry no license numbers**, so contractors are name-matched and flagged as candidates.
- **BBB** is limited to low-volume search JSON.

**Speed:**
- A full capture takes about 3–4 minutes, dominated by Socrata paging and the 78 MB CSLB file.
- The build takes about 20 s, after replacing OR-joins with key unions and the spatial join with a grid prefilter.
- Publish takes about 1 minute.

## Tests and reproducibility

- **Tests and typecheck:** `pnpm install && pnpm typecheck && pnpm test` (Vitest: CID/CAR packing round-trip).
- **Full local run:** `pnpm run pipeline capture --run demo` (no credentials needed). Publishing needs `FILEBASE_ACCESS_KEY`/`FILEBASE_SECRET_KEY`.
- **Explorer locally:** `cd web && pnpm dev`. It reads the latest run through IPNS, so it doesn't need local data.

## Stack

TypeScript (strict, NodeNext), Zod, Vitest, GitHub Actions and DuckDB with Parquet. IPFS uses `ipfs-car`, `@ipld/car` and `ipfs-unixfs-exporter`. The apps are Next.js 16 on Vercel and `mcp-handler`, using the MCP TypeScript SDK.

AWS/CDK from the kit's golden path was deliberately not used: the brief asks for zero ongoing Oracle infrastructure, and here the data plane is IPFS plus in-process DuckDB.

## License

Copyright (c) 2026 Alessandro Vozza. All rights reserved. This work is provided under an [evaluation-only license](LICENSE): you may run and review it to evaluate this candidate submission. Any other use, including production use, requires the author's written agreement.
