'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// DB_PATH 환경변수로 DB 파일 위치 지정 가능 (Render 영구 디스크 등)
const DB_FILE = process.env.DB_PATH || path.join(DATA_DIR, 'island.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureSchema() {
  db.exec(`
    -- ---------- identity & access ----------
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL,
      active        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      expires_at  TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      role        TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]'
    );

    -- ---------- geography & indicators ----------
    CREATE TABLE IF NOT EXISTS villages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      village_code  TEXT NOT NULL UNIQUE,
      village_name  TEXT NOT NULL,
      island        TEXT DEFAULT 'Tutuila',
      district_label TEXT DEFAULT '',
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      population    INTEGER,
      geometry_json TEXT NOT NULL,
      data_status   TEXT NOT NULL DEFAULT 'synthetic',
      notes         TEXT DEFAULT '',
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS village_indicators (
      village_id           INTEGER PRIMARY KEY REFERENCES villages(id),
      gita2018_min_ratio   REAL,
      gita2018_rec_days    REAL,
      flood2025_min_ratio  REAL,
      log_median_hh_income REAL,
      share_lt_hs          REAL,
      unemp_rate           REAL,
      share_65plus         REAL,
      dist_power_node_km   REAL,
      SIAI                 REAL,
      EXP_flood            REAL,
      log_pop_dens         REAL,
      pv_capacity_kw       REAL,
      pv_data_year         INTEGER,
      nearest_pv_distance_km REAL,
      pv_recent_capacity_kw  REAL,
      pv_recent_data_year    INTEGER,
      vqi                  REAL,
      event2025_ntl_pre    REAL,
      event2025_ntl_event  REAL,
      event2025_drop_pct   REAL,
      event2025_rec_days   REAL,
      pv_detected_mw       REAL,
      pv_detected_count    INTEGER,
      pv_detected_area_ha  REAL,
      dist_bess_km         REAL,
      exp_wind             REAL,
      water_storage_m3     REAL,
      water_sources        REAL,
      in_analytical_subset INTEGER DEFAULT 1,
      data_status          TEXT NOT NULL DEFAULT 'synthetic',
      source               TEXT DEFAULT '',
      vintage_label        TEXT DEFAULT '',
      updated_at           TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS historical_disaster_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name     TEXT NOT NULL,
      event_type     TEXT NOT NULL,
      event_date     TEXT,
      duration_hours REAL,
      description    TEXT DEFAULT '',
      data_status    TEXT NOT NULL DEFAULT 'synthetic',
      source         TEXT DEFAULT ''
    );

    -- ---------- infrastructure ----------
    CREATE TABLE IF NOT EXISTS electricity_assets (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      village_id         INTEGER REFERENCES villages(id),
      asset_type         TEXT NOT NULL,
      capacity_kw        REAL,
      islanding_capable  INTEGER DEFAULT 0,
      condition_note     TEXT DEFAULT '',
      data_status        TEXT NOT NULL DEFAULT 'synthetic',
      source             TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS water_assets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      village_id     INTEGER REFERENCES villages(id),
      asset_type     TEXT NOT NULL,
      storage_m3     REAL,
      pumping_kw     REAL,
      treatment      TEXT DEFAULT 'unknown',
      data_status    TEXT NOT NULL DEFAULT 'synthetic',
      source         TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS critical_facilities (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      village_id      INTEGER REFERENCES villages(id),
      facility_type   TEXT NOT NULL,
      name            TEXT NOT NULL,
      critical_load_kw REAL,
      water_demand_m3_day REAL,
      data_status     TEXT NOT NULL DEFAULT 'synthetic',
      source          TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS emergency_resources (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_type         TEXT NOT NULL,
      name                  TEXT NOT NULL,
      quantity              INTEGER DEFAULT 0,
      capacity_note         TEXT DEFAULT '',
      location              TEXT DEFAULT '',
      availability          TEXT DEFAULT 'available',
      transport_restriction TEXT DEFAULT '',
      data_status           TEXT NOT NULL DEFAULT 'synthetic',
      source                TEXT DEFAULT ''
    );

    -- ---------- scenarios (inputs stored separately from results) ----------
    CREATE TABLE IF NOT EXISTS disaster_scenarios (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      scenario_type TEXT NOT NULL,
      inputs_json  TEXT NOT NULL,
      created_by   TEXT DEFAULT '',
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scenario_results (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id  INTEGER NOT NULL REFERENCES disaster_scenarios(id),
      outputs_json TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    -- ---------- investment & finance ----------
    CREATE TABLE IF NOT EXISTS investment_projects (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      village_id      INTEGER REFERENCES villages(id),
      project_type    TEXT NOT NULL,
      beneficiary_population INTEGER DEFAULT 0,
      pv_kw           REAL DEFAULT 0,
      bess_kwh        REAL DEFAULT 0,
      bess_kw         REAL DEFAULT 0,
      gen_kw          REAL DEFAULT 0,
      water_storage_m3 REAL DEFAULT 0,
      pumping_kw      REAL DEFAULT 0,
      capex_usd       REAL DEFAULT 0,
      opex_usd_annual REAL DEFAULT 0,
      asset_lifetime_years INTEGER DEFAULT 25,
      implementation_year INTEGER,
      status          TEXT DEFAULT 'candidate',
      technical_feasibility TEXT DEFAULT 'unassessed',
      permitting_status TEXT DEFAULT 'unassessed',
      financing_notes TEXT DEFAULT '',
      data_status     TEXT NOT NULL DEFAULT 'synthetic',
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_assumptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES investment_projects(id),
      key        TEXT NOT NULL,
      value      TEXT,
      unit       TEXT DEFAULT '',
      source     TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS project_cash_flows (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL REFERENCES investment_projects(id),
      year          INTEGER NOT NULL,
      cash_flow_usd REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_milestones (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES investment_projects(id),
      name       TEXT NOT NULL,
      stage      TEXT DEFAULT '',
      owner      TEXT DEFAULT '',
      due_date   TEXT,
      status     TEXT DEFAULT 'planned'
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER REFERENCES investment_projects(id),
      contract_type    TEXT NOT NULL,
      counterparty     TEXT DEFAULT '',
      annual_value_usd REAL,
      start_year       INTEGER,
      end_year         INTEGER,
      data_status      TEXT NOT NULL DEFAULT 'synthetic'
    );

    -- ---------- ESG monitoring ----------
    CREATE TABLE IF NOT EXISTS esg_kpi_definitions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      dimension    TEXT NOT NULL,
      unit         TEXT DEFAULT '',
      formula      TEXT DEFAULT '',
      definition   TEXT DEFAULT '',
      baseline     REAL,
      target       REAL,
      responsible  TEXT DEFAULT '',
      data_status  TEXT NOT NULL DEFAULT 'engineering_estimate'
    );

    CREATE TABLE IF NOT EXISTS esg_kpi_observations (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      kpi_id              INTEGER NOT NULL REFERENCES esg_kpi_definitions(id),
      period              TEXT NOT NULL,
      actual_value        REAL,
      verification_status TEXT DEFAULT 'unverified',
      evidence_ref        TEXT DEFAULT '',
      entered_by          TEXT DEFAULT '',
      created_at          TEXT DEFAULT (datetime('now'))
    );

    -- ---------- community & governance ----------
    CREATE TABLE IF NOT EXISTS community_reports (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      village_id        INTEGER REFERENCES villages(id),
      submitted_by_name TEXT DEFAULT 'Community member',
      category          TEXT DEFAULT 'general',
      message           TEXT NOT NULL,
      status            TEXT DEFAULT 'new',
      created_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS official_notices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      village_id      INTEGER REFERENCES villages(id),
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      severity        TEXT DEFAULT 'info',
      verified        INTEGER DEFAULT 0,
      posted_by_role  TEXT DEFAULT 'planner',
      posted_by_name  TEXT DEFAULT '',
      created_at      TEXT DEFAULT (datetime('now')),
      expires_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_email TEXT DEFAULT 'anonymous',
      actor_role TEXT DEFAULT '',
      action     TEXT NOT NULL,
      entity     TEXT DEFAULT '',
      entity_id  TEXT DEFAULT '',
      detail     TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ind_village ON village_indicators(village_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(id);
  `);
}

ensureSchema();

// 기존 DB 마이그레이션 (이미 생성된 테이블에 실측 데이터 컬럼 추가 — 멱등)
(function migrateIndicators() {
  const cols = ['vqi REAL', 'event2025_ntl_pre REAL', 'event2025_ntl_event REAL', 'event2025_drop_pct REAL',
    'event2025_rec_days REAL', 'pv_detected_mw REAL', 'pv_detected_count INTEGER', 'pv_detected_area_ha REAL',
    'dist_bess_km REAL', 'exp_wind REAL'];
  for (const c of cols) {
    try { db.exec('ALTER TABLE village_indicators ADD COLUMN ' + c); } catch (e) { /* already exists */ }
  }
})();

module.exports = { db, ensureSchema, DATA_DIR };
