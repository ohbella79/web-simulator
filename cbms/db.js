'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// DB_PATH 환경변수로 DB 파일 위치 지정 가능 (Render 영구 디스크 등)
const DB_FILE = process.env.DB_PATH || path.join(DATA_DIR, 'cbms.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subcontractors (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name  TEXT NOT NULL,
      trade         TEXT NOT NULL,
      contact_name  TEXT DEFAULT '',
      email         TEXT DEFAULT '',
      phone         TEXT DEFAULT '',
      city          TEXT DEFAULT '',
      state         TEXT DEFAULT '',
      rating        INTEGER DEFAULT 3,
      status        TEXT DEFAULT 'active',
      notes         TEXT DEFAULT '',
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT NOT NULL,
      location           TEXT DEFAULT '',
      priority           TEXT DEFAULT 'medium',
      due_date           TEXT NOT NULL,
      original_due_date  TEXT NOT NULL,
      status             TEXT DEFAULT 'bidding',
      description        TEXT DEFAULT '',
      created_at         TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bids (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id         INTEGER NOT NULL REFERENCES projects(id),
      subcontractor_id   INTEGER NOT NULL REFERENCES subcontractors(id),
      invited_date       TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      due_date           TEXT NOT NULL,
      original_due_date  TEXT NOT NULL,
      responded_date     TEXT,
      decline_reason     TEXT DEFAULT '',
      submitted_date     TEXT,
      amount             REAL,
      notes              TEXT DEFAULT '',
      created_at         TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL,          -- bid | subcontractor | project | followup
      entity_id    INTEGER NOT NULL,
      field        TEXT,                   -- status | due_date | company_name | ...
      old_value    TEXT,
      new_value    TEXT,
      note         TEXT DEFAULT '',
      actor        TEXT DEFAULT 'PM (demo)',
      changed_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bids_status   ON bids(status);
    CREATE INDEX IF NOT EXISTS idx_bids_due      ON bids(due_date);
    CREATE INDEX IF NOT EXISTS idx_bids_project  ON bids(project_id);
    CREATE INDEX IF NOT EXISTS idx_bids_sub      ON bids(subcontractor_id);
    CREATE INDEX IF NOT EXISTS idx_hist_entity   ON status_history(entity_type, entity_id);
  `);
}

ensureSchema();

module.exports = { db, ensureSchema, DATA_DIR };
