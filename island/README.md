# IslandResilience AI — Phase 1 (real geography edition)

ESG-driven decision support platform for resilient electricity and water
infrastructure, American Samoa. **Real public geography bundled in
`data-real/villages.json`:**

- **74 villages** — real names and 2020/2010 populations from **US Census 2020,
  PHC Table 2** (`american-samoa-phc-table02.xlsx`)
- **Real coordinates** from the **GeoNames** gazetteer (100% name-matched)
- **Real county boundaries** from **geoBoundaries** (`wmgeolab/geoBoundaries`,
  GitHub) drawn on the map as an overlay
- **Tropical Cyclone Gita** recorded as a real 2018 event (NOAA/NWS public record)

Per-village **resilience indicators, assets and statuses remain synthetic** and are
labeled as such on every screen. **DEMONSTRATION MODE — NOT AN OFFICIAL EMERGENCY
INFORMATION SERVICE.**

**Passwordless demo:** opens straight into the app (Engineer role); switch roles in
the top bar. Fallback accounts: password `Demo2026!`.

**Run locally:** `npm install && npm start` → http://localhost:8741 · `npm test`.

## Working in Phase 1

- Login-free demo access with server-side role enforcement (admin / executive /
  engineer / planner / resident) + audit logs
- **Village Disaster Intelligence Map**: real villages on Leaflet, 10 choropleth
  layers, real county boundary overlay, village profiles (real census population
  chip, indicators labeled synthetic)
- **Explainable vulnerability screening** — 6 weighted dimensions, adjustable
  weights, min-max normalization documented in-app, missing inputs flagged (never
  imputed), explicit "not a validated outage probability" disclaimer
- **Data import** (villages + indicators, CSV/XLSX with range checks) and exports
- **Governance console** — audit log, role matrix, data-completeness, data-sources
  table, 19-check validation suite
- **Community portal** — English/Gagana Samoa, explicit "no verified live data"
  statuses, feedback form

## Sources (also listed in-app under Governance → Data sources)

| Source | What it provides |
|---|---|
| US Census 2020 PHC Table 2 | Village names + populations (real) |
| GeoNames AS dump | Village coordinates (real) |
| geoBoundaries (GitHub) | County boundaries (real) |
| NOAA/NWS public records | TC Gita 2018 event facts (real) |
| Synthetic generator | Indicators, assets, statuses (demo) |

Every planned-module page now renders a **real-data preview** (Census village/population KPIs, emergency-resource inventory, module specs, 5-year roadmap table) via `/api/preview/overview`. Validation: **20 automated checks** (`npm test` or Governance → Validation).
