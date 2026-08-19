# Internal Data Market Tracker

A CoStar-style market intelligence platform that runs entirely on **your own internal data**. No external listings, no subscriptions — the repo *is* the database. Push an updated Excel workbook and the live site rebuilds itself from it.

Built as a zero-backend static site (GitHub Pages). Currently configured for the **Minneapolis–St. Paul MSA**, but fully market-agnostic — point `config.json` at another market and reuse the whole platform.

## What it does

- **3D interactive map** (MapLibre GL) of the whole MSA with animated building extrusions, tilt/rotate, and layer toggles: 3D buildings, submarket boundaries + labels, property boundaries, property pins by type, satellite imagery.
- **Cinematic camera + animations** — fly-in intro, buildings that grow out of the ground as you zoom in ("Replay 3D build" to re-run), sweep-in arrivals when you select a property, a pulsing selection ring, and an **Orbit mode** (`o`) that slowly rotates the skyline.
- **Presentation mode** (`h`) — hides all UI chrome for clean full-bleed screen recordings and live demos.
- **Google-style search everywhere** — the map bar plus search bars on the Properties and Market Database tabs. Type-ahead suggestions across property names, addresses, IDs, submarkets, cities, counties, and states; picking a property flies the map to it, picking a geography filters every view to it. Remembers your recent searches and offers them when you focus an empty bar.
- **Market Database sub-tabs** — Overview, Capital Investment, Leasing, Development, Renovations, Sales, and Financing. Each module pulls its designated workbook columns (the property template carries boxes for all of them), shows KPI cards + a by-submarket chart + a property-level table, and respects every active filter. Modules are config-driven — add one in `config.json → modules`.
- **Property notes + editing** — a notes pad on every property, an ✎ Edit mode for manual field changes, and image upload. Edits save to your browser instantly; **⬇ Workbook** exports an .xlsx with all edits applied so you can commit it to `data/properties.xlsx` and make them permanent for everyone.
- **Per-asset-type submarkets** — give each asset class its own boundary set (`config.json → layers.submarkets.byType`); the map swaps to it when exactly one class is toggled on, and each property is assigned a submarket from its own class's boundaries. Multiple classes on → the default set.
- **Connected Excel workbook** — `data/properties.xlsx` is the master database. Every property, every column. Commit a new version and the platform updates automatically on the next page load.
- **Boundary ingestion** — submarket and property/parcel boundaries as `.kmz`, `.kml`, `.geojson`, or **zipped shapefiles** (`.zip` with `.shp/.dbf/.prj`). Properties without a `Submarket` value in the workbook are auto-assigned by point-in-polygon against your submarket shapes.
- **Schema-driven filtering** — ~19 universal criteria (class, size, vintage, occupancy, rent, cap rate, sale price, tenancy, owner type, zoning…) plus ~10 **asset-type-specific criteria per type** (clear height, dock doors and rail for industrial; units, unit mix and style for multifamily; traffic counts, frontage and anchors for retail; floor plates, skyway and LEED for office…). Type-specific filter sections appear only when that type is toggled on. One filter state drives the map pins, the market database, and the properties grid simultaneously.
- **Property detail drawer** — photo, headline stats, an asset-type detail section, plus *every other column* in your workbook rendered automatically.
- **Market / submarket database** — CoStar-style analytics computed **only from your uploaded data**: totals, type mix, SF / rent / occupancy by submarket, respecting every active filter, with a click-through submarket summary table.
- **Properties grid** — sortable on every column; when a single asset type is active, that type's specific columns are appended automatically.
- **Drag & drop preview** — drop an `.xlsx`, `.kmz`, or zipped shapefile onto the page to preview it locally before committing.

## Updating the data

1. Open `data/properties.xlsx`, edit rows (or add columns — new columns show up automatically in the property detail panel).
2. Required columns for mapping: `Latitude`, `Longitude`. Everything else is optional but powers features: `Property Name`, `Address`, `Property Type`, `Submarket`, `Building SF`, `Occupancy %`, `Asking Rent ($/SF)`, `Image URL`.
3. Commit and push (or upload via the GitHub web UI: *data → properties.xlsx → replace*). The live site reads the workbook fresh on every load.

Leave `Submarket` blank to let the platform assign it from your submarket KMZ polygons; fill it in to override.

### Metro-wide parcel fabric (PMTiles)

`data/parcels/msp_parcels.pmtiles` holds **every parcel in the 7-county Twin Cities metro** (~1.09M polygons from the open MetroGIS Regional Parcel Dataset) as vector tiles the map streams by viewport — zoom past ~z13 and the full parcel fabric appears; click any parcel for owner, PIN, use class, EMV, acreage, and last sale. Toggle: *All parcels (metro)*. To retarget another market: convert any parcel GPKG/shapefile with tippecanoe to a PMTiles under GitHub's 100 MB file limit and point `config.json → layers.parcelTiles` at it.

### Boundaries (KMZ / shapefile / GeoJSON)

- **Submarkets:** drop files into `data/submarkets/` and list them in `config.json → layers.submarkets`. Polygon `name` becomes the submarket name.
- **Property/parcel boundaries:** same, in `data/parcels/` and `config.json → layers.parcels`.
- Accepted formats: `.kmz`, `.kml`, `.geojson`, and **zipped shapefiles** (a `.zip` containing `.shp` + `.dbf` + `.prj`).

**Recommended workflow:**

1. **Hand-drawn submarkets** — draw polygons in [Google Earth Pro](https://www.google.com/earth/about/versions/) (free desktop app), name each polygon, `File → Save Place As → .kmz`, commit. Fastest way to author custom submarket lines.
2. **Parcel-true property boundaries** — don't draw these by hand. County GIS portals publish parcel shapefiles/GeoJSON free (for MSP: Hennepin and Ramsey County open-data portals). Filter to your parcels, export, zip, commit.
3. **Cleanup / conversion / simplification** — [mapshaper.org](https://mapshaper.org) (free, in-browser): converts between shapefile/KML/GeoJSON, merges layers, renames attributes, and simplifies heavy county files so the site stays fast. Aim for < 1–2 MB per boundary file.

If your shapefile's name attribute isn't `name`, either rename it in mapshaper (`rename-fields name=YOURFIELD`) or export as KML/GeoJSON with the name set.

### Property images

Put a URL in the `Image URL` column (or commit images to `assets/` and reference them as `assets/whatever.jpg`).

## Reusing this for another market

Everything market-specific lives in `config.json`:

```jsonc
{
  "market":  { "name": "…", "center": [lng, lat], "zoom": 10, "pitch": 50 },
  "data":    { "workbook": "data/properties.xlsx", "sheet": "Properties" },
  "layers":  { "submarkets": ["data/submarkets/*.kmz"], "parcels": [] },
  "fields":  { "lat": "Latitude", "lng": "Longitude", … }  // map your column headers here
}
```

Fork/copy the repo, swap the workbook + KMZ files, edit `config.json` — done. The `fields` block means your new workbook doesn't even need the same column names.

## Running locally

Any static file server works:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly from disk won't work — the app fetches the workbook, which browsers block on `file://`.)

## Stack

Zero build step, zero backend. MapLibre GL JS (map + 3D), OpenFreeMap tiles (no API key), SheetJS (xlsx parsing in-browser), JSZip + togeojson (KMZ → GeoJSON), Chart.js (analytics). All from CDNs.

## Data provenance — what's real vs. sample

| Layer / data | Source | Status |
|---|---|---|
| Metro parcel fabric (owner, PIN, EMV, acres, sales) | MetroGIS Regional Parcel Dataset — county records | **REAL** (open data, Apr 2026 vintage) |
| Per-property parcel outlines | Hennepin/Ramsey county GIS lookups | **REAL polygons**, matched to sample properties |
| Submarket boundaries | User-drawn KMZs | **REAL** (interim, user-maintained) |
| MSA / county / city boundaries | Census (user-supplied pack) | **REAL** |
| Basemap + 3D buildings | CARTO / OpenStreetMap | **REAL** |
| **Property workbook (all 123 columns)** | Generated demo data | **SAMPLE — fictional; replace `data/properties.xlsx`** |

Property pages carry a "Sample data" badge while `config.json → data.sample` is `true` — set it to `false` when the real workbook lands.

## Sample data disclaimer

The workbook and boundaries shipped in this repo are **fictional sample data** on real Minneapolis-area coordinates, included so the platform demos out of the box. Replace them with your internal data.
