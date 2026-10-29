# Construction Bid Management System — v1.2 (real public data)

Bid-desk web application for a U.S. general contractor, now built on **real public
bid data**: project names, locations (county / TxDOT district / highway / limits),
letting dates, engineer's estimates, bid item details, contractor names and bid
amounts come from **TxDOT Bid Tabulation records** (Texas Open Data Portal, Socrata
resource `de7b-7dna`, retrieved into `data-real/txdot.json`).

**Data provenance shown in-app:** contacts, ratings and bid-desk workflow statuses
(invitation / accepted / declined / in preparation / follow-ups) are synthetic demo
values layered on top of the real records — labeled as such on every screen and in
the Data sources table (Data & Tests page).

**Run locally:** `npm install && npm start` → http://localhost:8734 (Node 18+, no
login required; DB self-seeds from the bundled real dataset).

## Pages

1. **Executive Dashboard** — KPIs, pipeline donut, due-date outlook, trades breakdown,
   8-week trend, overdue snapshot, audit-trail feed.
2. **Bid Analytics** — participation funnel, submitted value by project, average bid by
   trade, decline reasons, response-time distribution, on-time vs late, top contractors
   by value (computed live from the register).
3. **Subcontractor Management** — 61 real contractor names (public record) with demo
   trade mapping, ratings, contacts; add/edit/search/filter; audit-trailed history.
4. **Bid Register** — guard-railed lifecycle, deadline extensions with reasons,
   follow-up logging, full audit trail.
5. **Risk Analytics** — overdue aging, due-soon watch, unanswered invitations, flagged
   contractors with rule explanations.
6. **Decision Support** — deadline adjustment with impact preview + cascade, 4-scenario
   participation comparison, ranked follow-up priorities with visible scoring.
7. **Data & Tests** — CSV/Excel import, exports (CSV/XLSX), data-sources table,
   17-scenario validation suite, demo reset.

## Data honesty

- REAL (public record): project facts, letting dates, estimates, contractor names, bid
  amounts, bid items (`observed`).
- SYNTHETIC (demo): workflow statuses, contacts, ratings, supplemental invitations
  (`synthetic` — labeled in-app).
- Sources & retrieval dates are listed in the app and in `data-real/txdot.json`.
