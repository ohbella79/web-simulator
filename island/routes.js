'use strict';

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');

const { db } = require('./db');
const { resetSeed, seedIfEmpty, REAL } = require('./seed');
const { computeScreening } = require('./screening');
const { runTests } = require('./tests/runTests');
const auth = require('./auth');
const {
  ROLES, ROLE_LABELS, PAGE_ACCESS, DATA_EDITORS, PROVENANCE, PROVENANCE_LABELS,
  DATA_DICTIONARY, SCREENING_DIMENSIONS, DEFAULT_WEIGHTS, DEMO_NOTICE, todayStr
} = require('./lib/constants');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname || '');
    if (!ok) return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    cb(null, true);
  }
});

const api = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// =================== meta (public) ===================
router.get('/meta', api((req, res) => {
  res.json({
    name: 'IslandResilience AI',
    phase: 'Phase 1 - shell, database, authentication, village map, data import',
    demoMode: true,
    demoNotice: DEMO_NOTICE,
    sampleDataNotice: 'Real public geography: village names and 2020 census populations (US Census Bureau), coordinates (GeoNames) and county boundaries (geoBoundaries). Per-village resilience indicators, assets and statuses are synthetic demo values.',
    dataSources: REAL.sources,
    today: todayStr(),
    roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r] })),
    provenance: PROVENANCE.map((p) => ({ key: p, label: PROVENANCE_LABELS[p] })),
    dataDictionary: DATA_DICTIONARY,
    screeningDimensions: SCREENING_DIMENSIONS,
    defaultWeights: DEFAULT_WEIGHTS
  });
}));

// =================== NTL 2025 observed time series & comparisons ===================
router.get('/ntl/timeseries', api((req, res) => {
  const u = auth.currentUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  if (u.role === 'resident') return res.status(403).json({ error: 'Resident role cannot access village-level analysis data.' });
  const NTL = require('./data-real/ntl2025.json');
  const rows = db.prepare(`SELECT vi.village_id, v.village_name, v.population,
      vi.event2025_drop_pct, vi.event2025_rec_days, vi.event2025_ntl_pre,
      vi.pv_detected_mw, vi.pv_detected_count
    FROM village_indicators vi JOIN villages v ON v.id = vi.village_id`).all();
  res.json(Object.assign({}, NTL, {
    rows,
    note: 'Weekly means of observed VIIRS DNB village radiance (nW/cm2/sr). Comparisons are descriptive, not causal.'
  }));
}));

router.get('/energy/layers', api((req, res) => {
  const u = auth.currentUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  if (u.role === 'resident') return res.status(403).json({ error: 'Resident role cannot access facility-level data.' });
  res.json({ pv: require('./data-real/pv_detections.json'), facilities: require('./data-real/facilities.json') });
}));

// =================== auth ===================
router.post('/auth/login', api((req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND active = 1').get(email);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    auth.audit(user || null, 'login_failed', 'auth', email, email ? 'Invalid credentials' : 'Missing credentials');
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  auth.audit(user, 'login', 'auth', user.id, 'Signed in');
  res.json({ user: { email: user.email, name: user.name, role: user.role } });
}));

// Passwordless demo sign-in (convenience for the demonstration build).
// Issues a real session for one of the seeded demo accounts - no password needed.
router.post('/auth/demo-login', api((req, res) => {
  const emailByRole = {
    admin: 'admin@demo.islandresilience.ai',
    executive: 'executive@demo.islandresilience.ai',
    engineer: 'engineer@demo.islandresilience.ai',
    planner: 'planner@demo.islandresilience.ai',
    resident: 'resident@demo.islandresilience.ai'
  };
  const role = String((req.body || {}).role || 'engineer');
  const email = emailByRole[role];
  if (!email) return res.status(400).json({ error: 'Unknown demo role. Use: admin, executive, engineer, planner, resident.' });
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND active = 1').get(email);
  if (!user) return res.status(500).json({ error: 'Demo accounts are missing. Run "Reset demo data" (admin) or reseed the database.' });
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  auth.audit(user, 'demo_login', 'auth', user.id, 'Passwordless demo sign-in as ' + role);
  res.json({ user: { email: user.email, name: user.name, role: user.role }, demoMode: true });
}));

router.post('/auth/logout', api((req, res) => {
  const token = auth.currentUser(req) ? auth.currentUser(req).token : null;
  auth.destroySession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
}));

router.get('/auth/me', api((req, res) => {
  const u = auth.currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: { email: u.email, name: u.name, role: u.role }, pageAccess: PAGE_ACCESS });
}));

// =================== villages & map ===================
router.get('/villages', auth.requireRole('admin', 'executive', 'engineer', 'planner'), api((req, res) => {
  const { search } = req.query;
  const where = []; const params = [];
  if (search) { where.push('(v.village_name LIKE ? OR v.village_code LIKE ?)'); const q = `%${String(search).trim()}%`; params.push(q, q); }
  const whereSql = where.length ? ' AND ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT v.id, v.village_code, v.village_name, v.district_label, v.lat, v.lon, v.population,
      v.data_status, i.gita2018_min_ratio, i.gita2018_rec_days, i.flood2025_min_ratio, i.SIAI,
      i.dist_power_node_km, i.EXP_flood, i.in_analytical_subset, i.water_storage_m3,
      i.pv_capacity_kw, i.pv_data_year, i.pv_recent_capacity_kw, i.pv_recent_data_year
    FROM villages v LEFT JOIN village_indicators i ON i.village_id = v.id
    WHERE 1=1${whereSql} ORDER BY v.village_code`).all(...params);
  res.json({ rows, demoNotice: DEMO_NOTICE });
}));

router.get('/villages/geojson', auth.requireRole('admin', 'executive', 'engineer', 'planner'), api((req, res) => {
  const rows = db.prepare('SELECT id, village_code, village_name, district_label, lat, lon, population, geometry_json FROM villages').all();
  res.json({
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: JSON.parse(r.geometry_json),
      properties: { village_id: r.id, village_code: r.village_code, village_name: r.village_name, district_label: r.district_label, population: r.population }
    }))
  });
}));

router.get('/counties/geojson', auth.requireRole('admin', 'executive', 'engineer', 'planner'), api((req, res) => {
  res.json(REAL.county_boundaries);
}));

router.get('/villages/:id', auth.requireRole('admin', 'executive', 'engineer', 'planner'), api((req, res) => {
  const v = db.prepare('SELECT * FROM villages WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Village not found.' });
  const ind = db.prepare('SELECT * FROM village_indicators WHERE village_id = ?').get(v.id) || {};
  const electric = db.prepare('SELECT * FROM electricity_assets WHERE village_id = ?').all(v.id);
  const water = db.prepare('SELECT * FROM water_assets WHERE village_id = ?').all(v.id);
  const facilities = db.prepare('SELECT * FROM critical_facilities WHERE village_id = ?').all(v.id);
  res.json({ village: v, indicators: ind, electricity_assets: electric, water_assets: water, facilities, demoNotice: DEMO_NOTICE });
}));

// =================== screening ===================
router.get('/screening', auth.requireRole('admin', 'executive', 'engineer', 'planner'), api((req, res) => {
  let weights = null;
  if (req.query.weights) {
    try { weights = JSON.parse(req.query.weights); } catch (e) { return res.status(400).json({ error: 'weights must be a JSON object.' }); }
  }
  res.json(computeScreening(weights || DEFAULT_WEIGHTS));
}));

// =================== import (engineers/admin only) ===================
function readUpload(req, res) {
  if (!req.file) { res.status(400).json({ error: 'Attach a .csv, .xlsx or .xls file in the "file" field.' }); return null; }
  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true }); }
  catch (e) { res.status(400).json({ error: 'Could not parse the file. Upload a valid .csv, .xlsx or .xls file.' }); return null; }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) { res.status(400).json({ error: 'The file has no readable worksheet.' }); return null; }
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' }).map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[String(k).toLowerCase().trim().replace(/\s+/g, '_')] = v;
    return o;
  });
  if (!rows.length) { res.status(400).json({ error: 'The file has no data rows (header only).' }); return null; }
  return rows;
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function checkRange(field, value) {
  const d = DATA_DICTIONARY[field];
  if (!d || d.min == null) return null;
  if (value == null) return null;
  if (value < d.min) return `${field} is below the documented minimum (${d.min}).`;
  if (d.max != null && value > d.max) return `${field} is above the documented maximum (${d.max}).`;
  return null;
}

router.post('/import/villages', auth.requireRole(...DATA_EDITORS), upload.single('file'), api((req, res) => {
  const rows = readUpload(req, res);
  if (!rows) return;
  let imported = 0; const failures = [];
  const ins = db.prepare(`INSERT INTO villages (village_code, village_name, island, district_label, lat, lon, population, geometry_json, data_status, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const fail = (reason) => failures.push({ row: rowNo, name: String(r.village_name || ''), reason });
    const name = String(r.village_name || '').trim();
    if (!name) return fail('village_name is required.');
    const lat = num(r.lat), lon = num(r.lon);
    if (lat == null || Number.isNaN(lat) || lon == null || Number.isNaN(lon)) return fail('lat and lon are required numbers (decimal degrees).');
    if (lat < -14.6 || lat > -14.0 || lon < -171.2 || lon > -170.2) return fail('Coordinates are outside the American Samoa scope (lat -14.6..-14.0, lon -171.2..-170.2).');
    const pop = num(r.population);
    if (Number.isNaN(pop)) return fail('population must be a number.');
    const code = String(r.village_code || '').trim() || 'IMP-' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 20);
    if (db.prepare('SELECT id FROM villages WHERE village_code = ? OR lower(village_name) = lower(?)').get(code, name)) {
      return fail(`A village with code "${code}" or name "${name}" already exists.`);
    }
    const geo = { type: 'Point', coordinates: [lon, lat] };
    const info = ins.run(code, name, 'Tutuila', String(r.district_label || 'Imported (demo)'), lat, lon,
      pop == null ? null : Math.round(pop), JSON.stringify(geo), 'synthetic', 'Imported via upload (demo); provenance per data_status default synthetic.');
    auth.audit(req.user, 'import', 'village', info.lastInsertRowid, `Imported village ${name}`);
    imported++;
  });
  res.json({ entity: 'villages', total: rows.length, imported, failed: failures.length, failures });
}));

router.post('/import/indicators', auth.requireRole(...DATA_EDITORS), upload.single('file'), api((req, res) => {
  const rows = readUpload(req, res);
  if (!rows) return;
  const numericFields = Object.keys(DATA_DICTIONARY).filter((k) => ['number', 'id'].includes(DATA_DICTIONARY[k].type)
    && !['village_id', 'village_name', 'population'].includes(k));
  let imported = 0; const failures = [];
  const upsert = db.prepare(`INSERT INTO village_indicators
    (village_id, ${numericFields.join(', ')}, data_status, source, vintage_label, updated_at)
    VALUES (?,${numericFields.map(() => '?').join(',')},?,?,?,?)
    ON CONFLICT(village_id) DO UPDATE SET ${numericFields.map((f) => `${f}=excluded.${f}`).join(', ')},
      data_status=excluded.data_status, source=excluded.source, vintage_label=excluded.vintage_label, updated_at=excluded.updated_at`);
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const fail = (reason) => failures.push({ row: rowNo, name: String(r.village_code || r.village_name || ''), reason });
    let village = null;
    if (r.village_code) village = db.prepare('SELECT id FROM villages WHERE village_code = ?').get(String(r.village_code).trim());
    if (!village && r.village_name) village = db.prepare('SELECT id FROM villages WHERE lower(village_name) = lower(?)').get(String(r.village_name).trim());
    if (!village) return fail('No matching village by village_code or exact village_name.');
    const values = [];
    for (const f of numericFields) {
      const raw = r[f];
      const v = raw === '' || raw == null ? null : num(raw);
      if (Number.isNaN(v)) return fail(`${f} must be a number (got "${raw}").`);
      const rangeErr = checkRange(f, v);
      if (rangeErr) return fail(rangeErr);
      values.push(v);
    }
    const status = PROVENANCE.includes(String(r.data_status || '').trim()) ? String(r.data_status).trim() : 'synthetic';
    upsert.run(village.id, ...values, status,
      String(r.source || 'Imported via upload (demo)'), String(r.vintage_label || ''), nowSql());
    auth.audit(req.user, 'import', 'village_indicators', village.id, `Updated ${numericFields.filter((f, k) => values[k] != null).length} indicators`);
    imported++;
  });
  res.json({ entity: 'indicators', total: rows.length, imported, failed: failures.length, failures });
}));

// =================== exports ===================
function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function sendCsv(res, sheets, base) {
  const lines = [];
  for (const sh of sheets) {
    lines.push(`# ${sh.name}`);
    const keys = Object.keys(sh.rows[0] || { info: 'no data' });
    lines.push(keys.join(','));
    for (const r of sh.rows) lines.push(keys.map((k) => csvEscape(r[k])).join(','));
    lines.push('');
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${base}-${todayStr()}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
}
function sendXlsx(res, sheets, base) {
  const wb = XLSX.utils.book_new();
  for (const sh of sheets) {
    const ws = XLSX.utils.json_to_sheet(sh.rows.length ? sh.rows : [{}]);
    XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}-${todayStr()}.xlsx"`);
  res.send(buf);
}

router.get('/export/:type', auth.requireRole('admin', 'executive', 'engineer', 'planner'), api((req, res) => {
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
  let sheets = null, base = req.params.type;
  if (req.params.type === 'villages') {
    sheets = [{
      name: 'Villages (synthetic demo)',
      rows: db.prepare(`SELECT v.village_code, v.village_name, v.district_label, v.lat, v.lon, v.population, v.data_status,
        i.gita2018_min_ratio, i.gita2018_rec_days, i.flood2025_min_ratio, i.SIAI, i.EXP_flood, i.dist_power_node_km,
        i.share_65plus, i.water_storage_m3, i.pv_capacity_kw, i.pv_data_year, i.pv_recent_capacity_kw, i.pv_recent_data_year,
        i.in_analytical_subset, i.vintage_label
        FROM villages v LEFT JOIN village_indicators i ON i.village_id = v.id ORDER BY v.village_code`).all()
    }];
  } else if (req.params.type === 'screening') {
    const s = computeScreening(DEFAULT_WEIGHTS);
    sheets = [{
      name: 'Vulnerability screening',
      rows: s.results.map((r) => ({
        village_code: r.village_code, village_name: r.village_name, population: r.population,
        screening_score: r.score, band: r.band,
        disruption: r.dims.disruption.normalized, recovery: r.dims.recovery.normalized,
        social: r.dims.social.normalized, access: r.dims.access.normalized,
        exposure: r.dims.exposure.normalized, water: r.dims.water.normalized,
        missing_inputs: r.data_quality.missing_inputs.join('; '),
        data_status: r.data_quality.data_status, note: 'Decision-support screening index - not a validated outage probability'
      }))
    }];
  } else if (req.params.type === 'audit') {
    sheets = [{ name: 'Audit log', rows: db.prepare('SELECT created_at, actor_email, actor_role, action, entity, entity_id, detail FROM audit_logs ORDER BY id DESC LIMIT 5000').all() }];
  } else {
    return res.status(404).json({ error: 'Unknown export. Use villages, screening or audit.' });
  }
  if (format === 'xlsx') sendXlsx(res, sheets, base); else sendCsv(res, sheets, base);
}));

router.get('/export/template/:type', auth.requireRole(...DATA_EDITORS), api((req, res) => {
  const t = {
    villages: 'village_code,village_name,district_label,lat,lon,population\nDEMO-V90,Sample imported village (demo),Imported (demo),-14.28,-170.75,500\n',
    indicators: 'village_code,gita2018_min_ratio,gita2018_rec_days,flood2025_min_ratio,log_median_hh_income,share_lt_hs,unemp_rate,share_65plus,dist_power_node_km,SIAI,EXP_flood,water_storage_m3,water_sources,pv_capacity_kw,pv_data_year,data_status,source,vintage_label\nDEMO-V01,0.55,30,0.60,10.4,0.15,0.08,0.09,1.2,0.55,0.30,900,2,120,2018,synthetic,my-upload-v1,TC Gita 2018 + 2025 (demo)\n'
  }[req.params.type];
  if (!t) return res.status(404).json({ error: 'Unknown template. Use villages or indicators.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-import-template.csv"`);
  res.send(t);
}));

// =================== phase previews (all non-resident roles) ===================
router.get('/preview/overview', auth.requireRole('admin', 'executive', 'engineer', 'planner'), api((req, res) => {
  const one = (sql) => db.prepare(sql).get().c;
  res.json({
    villages: one('SELECT COUNT(*) c FROM villages'),
    population: db.prepare('SELECT SUM(population) s FROM villages').get().s || 0,
    subset: one('SELECT COUNT(*) c FROM village_indicators WHERE in_analytical_subset = 1'),
    facilities: one('SELECT COUNT(*) c FROM critical_facilities'),
    electricityAssets: one('SELECT COUNT(*) c FROM electricity_assets'),
    waterAssets: one('SELECT COUNT(*) c FROM water_assets'),
    facilityTypes: db.prepare('SELECT facility_type, COUNT(*) c FROM critical_facilities GROUP BY facility_type ORDER BY c DESC').all(),
    events: db.prepare('SELECT event_name, event_type, event_date, data_status, source FROM historical_disaster_events ORDER BY event_date').all(),
    resources: db.prepare(`SELECT resource_type, name, quantity, capacity_note, location, availability, transport_restriction, data_status
      FROM emergency_resources ORDER BY id`).all(),
    realGeography: true,
    demoNotice: DEMO_NOTICE
  });
}));

// =================== governance ===================
router.get('/gov/overview', auth.requireRole('admin', 'executive', 'engineer'), api((req, res) => {
  const counts = {};
  for (const t of ['villages', 'village_indicators', 'historical_disaster_events', 'electricity_assets', 'water_assets',
    'critical_facilities', 'emergency_resources', 'disaster_scenarios', 'investment_projects',
    'esg_kpi_definitions', 'official_notices', 'community_reports', 'users', 'audit_logs']) {
    counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  }
  res.json({ counts, roles: db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all(), demoNotice: DEMO_NOTICE });
}));

router.get('/gov/audit', auth.requireRole('admin', 'executive', 'engineer'), api((req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 500);
  res.json({ rows: db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit) });
}));

router.get('/gov/users', auth.requireRole('admin', 'executive'), api((req, res) => {
  res.json({
    rows: db.prepare('SELECT email, name, role, active, created_at FROM users ORDER BY role, email').all(),
    roleMatrix: PAGE_ACCESS, roleLabels: ROLE_LABELS
  });
}));

router.get('/gov/data-quality', auth.requireRole('admin', 'executive', 'engineer'), api((req, res) => {
  const cols = ['gita2018_min_ratio', 'gita2018_rec_days', 'flood2025_min_ratio', 'log_median_hh_income',
    'share_lt_hs', 'unemp_rate', 'share_65plus', 'dist_power_node_km', 'SIAI', 'EXP_flood',
    'water_storage_m3', 'pv_capacity_kw'];
  const total = db.prepare('SELECT COUNT(*) c FROM villages').get().c;
  const fields = cols.map((c) => ({
    field: c, label: DATA_DICTIONARY[c] ? DATA_DICTIONARY[c].label : c,
    present: db.prepare(`SELECT COUNT(*) c FROM village_indicators WHERE ${c} IS NOT NULL`).get().c, total
  }));
  res.json({ fields, subsetCount: db.prepare('SELECT COUNT(*) c FROM village_indicators WHERE in_analytical_subset = 1').get().c, total });
}));

// =================== community portal (all authenticated roles) ===================
router.get('/portal/villages', auth.requireAuth, api((req, res) => {
  res.json({ rows: db.prepare('SELECT id, village_name, village_code, district_label FROM villages ORDER BY village_name').all() });
}));

router.get('/portal/village/:id', auth.requireAuth, api((req, res) => {
  const v = db.prepare('SELECT id, village_name, village_code, district_label FROM villages WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Village not found.' });
  const fac = db.prepare(`SELECT facility_type, name, data_status FROM critical_facilities WHERE village_id = ? AND (facility_type = 'emergency shelter' OR facility_type = 'water pumping station')`).all(v.id);
  res.json({
    village: v,
    electricity_status: { status: 'no_verified_live_data', message: 'No verified live electricity status is connected for this village in the prototype. Do not treat this as an official restoration estimate.', demoNotice: DEMO_NOTICE },
    water_status: { status: 'no_verified_live_data', message: 'No verified live water system status is connected for this village in the prototype.', demoNotice: DEMO_NOTICE },
    locations: fac.map((f) => ({ name: f.name, type: f.facility_type, verified: false, data_status: f.data_status, note: 'DEMO location - not an official emergency resource location.' })),
    demoNotice: DEMO_NOTICE
  });
}));

router.get('/portal/notices', auth.requireAuth, api((req, res) => {
  const rows = db.prepare(`SELECT n.*, v.village_name FROM official_notices n LEFT JOIN villages v ON v.id = n.village_id ORDER BY n.verified DESC, n.id DESC LIMIT 20`).all();
  res.json({ rows: rows.map((r) => ({ ...r, official: r.verified === 1 })) });
}));

router.post('/portal/feedback', auth.requireAuth, api((req, res) => {
  const message = String((req.body || {}).message || '').trim();
  const villageId = Number((req.body || {}).village_id);
  if (!message) return res.status(400).json({ error: 'Feedback message is required.', fields: { message: 'Please describe your feedback.' } });
  if (message.length > 1000) return res.status(400).json({ error: 'Keep feedback under 1000 characters.' });
  const info = db.prepare(`INSERT INTO community_reports (village_id, submitted_by_name, category, message) VALUES (?,?,?,?)`)
    .run(Number.isInteger(villageId) && villageId > 0 ? villageId : null, req.user.name, String((req.body || {}).category || 'general'), message);
  auth.audit(req.user, 'feedback', 'community_reports', info.lastInsertRowid, message.slice(0, 120));
  res.status(201).json({ ok: true, id: info.lastInsertRowid, notice: 'Feedback recorded in the demo database. It is visible to EPS/government roles in the governance console.' });
}));

// =================== admin & tests ===================
router.post('/admin/reset', auth.requireRole('admin'), api((req, res) => {
  const counts = resetSeed();
  auth.audit(req.user, 'reset', 'database', '', 'Database reseeded');
  res.json({ ok: true, message: 'Database reseeded with the synthetic demonstration dataset.', counts });
}));

router.post('/tests/run', auth.requireRole('admin', 'executive', 'engineer'), api(async (req, res) => {
  const result = await runTests(`http://127.0.0.1:${req.app.get('port')}`);
  auth.audit(req.user, 'run_tests', 'validation', '', `${result.passed}/${result.total} passed`);
  res.json(result);
}));

// multer errors
router.use((err, req, res, next) => {
  if (err.message === 'UNSUPPORTED_FILE_TYPE') return res.status(400).json({ error: 'Unsupported file type. Upload a .csv, .xlsx or .xls file.' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (10 MB max).' : `Upload error: ${err.code}` });
  next(err);
});

module.exports = router;
