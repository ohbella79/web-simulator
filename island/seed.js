'use strict';

// IslandResilience AI seed — REAL geography edition.
// Village names, 2020/2010 populations (US Census 2020), coordinates (GeoNames)
// and county boundaries (geoBoundaries) are REAL public data bundled in
// data-real/villages.json. Per-village resilience INDICATORS (nighttime-light
// ratios, socioeconomic shares, water storage) remain SYNTHETIC and are labeled
// as such everywhere in the app.

const { db } = require('./db');
const { hashPassword } = require('./auth');
const { todayStr, DEFAULT_WEIGHTS } = require('./lib/constants');
const REAL = require('./data-real/villages.json');

const round = (x, n) => Math.round(x * Math.pow(10, n)) / Math.pow(10, n);

// Deterministic synthetic indicator generator (demo values, labeled synthetic).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed() {
  const today = todayStr();
  const rnd = mulberry32(20261101);

  const tx = db.transaction(() => {
    // ----- users & role matrix -----
    db.prepare('INSERT INTO user_roles (role, label, permissions) VALUES (?,?,?)')
      .run('admin', 'System Administrator', JSON.stringify(['manage_users', 'import_data', 'edit_all', 'run_tests', 'view_audit']));
    db.prepare('INSERT INTO user_roles (role, label, permissions) VALUES (?,?,?)')
      .run('executive', 'EPS Executive', JSON.stringify(['view_all', 'run_tests', 'view_audit', 'export']));
    db.prepare('INSERT INTO user_roles (role, label, permissions) VALUES (?,?,?)')
      .run('engineer', 'EPS Energy & Infrastructure Engineer', JSON.stringify(['view_all', 'import_data', 'edit_operational', 'run_tests', 'export']));
    db.prepare('INSERT INTO user_roles (role, label, permissions) VALUES (?,?,?)')
      .run('planner', 'Government / Utility / Emergency Planner', JSON.stringify(['view_map', 'view_monitoring', 'post_notices', 'export']));
    db.prepare('INSERT INTO user_roles (role, label, permissions) VALUES (?,?,?)')
      .run('resident', 'Community Resident', JSON.stringify(['view_portal', 'submit_feedback']));

    const insUser = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)');
    const pw = hashPassword('Demo2026!');
    insUser.run('admin@demo.islandresilience.ai', pw, 'Demo Administrator', 'admin');
    insUser.run('executive@demo.islandresilience.ai', pw, 'Demo EPS Executive', 'executive');
    insUser.run('engineer@demo.islandresilience.ai', pw, 'Demo EPS Engineer', 'engineer');
    insUser.run('planner@demo.islandresilience.ai', pw, 'Demo Emergency Planner', 'planner');
    insUser.run('resident@demo.islandresilience.ai', pw, 'Demo Community Resident', 'resident');

    // ----- historical disaster events -----
    const insEvent = db.prepare(`INSERT INTO historical_disaster_events
      (event_name, event_type, event_date, duration_hours, description, data_status, source)
      VALUES (?,?,?,?,?,?,?)`);
    insEvent.run('Tropical Cyclone Gita (American Samoa)', 'cyclone', '2018-02-09', 24,
      'REAL EVENT: Severe Tropical Cyclone Gita passed just south of Tutuila on 9-10 February 2018 with damaging winds, widespread power outages, structural damage and a disaster declaration. Village-level nighttime-light disruption values in this platform are SYNTHETIC demonstration indicators patterned on this event, not observations.',
      'observed', 'NOAA / NWS and American Samoa government public records (public event); village indicator values synthetic');
    insEvent.run('2025 flooding-related observation period (demo indicators)', 'flood', '2025-01-15', 72,
      'Flooding-related disruption observation period used by the platform research concept. Village-level values here are SYNTHETIC demonstration values, not validated observations.',
      'synthetic', 'Synthetic demo dataset');

    // ----- REAL villages + synthetic indicators -----
    const insVillage = db.prepare(`INSERT INTO villages
      (village_code, village_name, island, district_label, lat, lon, population, geometry_json, data_status, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insInd = db.prepare(`INSERT INTO village_indicators
      (village_id, gita2018_min_ratio, gita2018_rec_days, flood2025_min_ratio, log_median_hh_income,
       share_lt_hs, unemp_rate, share_65plus, dist_power_node_km, SIAI, EXP_flood, log_pop_dens,
       pv_capacity_kw, pv_data_year, nearest_pv_distance_km, pv_recent_capacity_kw, pv_recent_data_year,
       water_storage_m3, water_sources, in_analytical_subset, data_status, source, vintage_label)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insEA = db.prepare(`INSERT INTO electricity_assets (village_id, asset_type, capacity_kw, islanding_capable, condition_note, data_status, source) VALUES (?,?,?,?,?,?,?)`);
    const insWA = db.prepare(`INSERT INTO water_assets (village_id, asset_type, storage_m3, pumping_kw, treatment, data_status, source) VALUES (?,?,?,?,?,?,?)`);
    const insFac = db.prepare(`INSERT INTO critical_facilities (village_id, facility_type, name, critical_load_kw, water_demand_m3_day, data_status, source) VALUES (?,?,?,?,?,?,?)`);

    const vis = REAL.villages.slice().sort((a, b) => a.name.localeCompare(b.name));
    const islandOf = (v) => (v.lon > -169.9 ? "Manu'a Islands" : v.county.toLowerCase().includes('swains') ? 'Swains Island' : 'Tutuila / Aunu\u2019u');
    // Demo quality-screened subset: Tutuila/Aunu'u villages with pop >= 100 (labeled demo subset)
    const subsetNames = new Set(vis.filter((v) => v.lon > -169.9 && v.population >= 100).map((v) => v.name));

    vis.forEach((v, i) => {
      const island = islandOf(v);
      const code = 'ASM-' + String(i + 1).padStart(2, '0');
      const approx = { type: 'Polygon', coordinates: [[
        [v.lon - 0.009, v.lat - 0.006], [v.lon + 0.009, v.lat - 0.006], [v.lon + 0.009, v.lat + 0.006],
        [v.lon - 0.009, v.lat + 0.006], [v.lon - 0.009, v.lat - 0.006]]] };
      const vInfo = insVillage.run(code, v.name, island,
        (v.county ? v.county + ' County' : '') + (v.district ? ' · ' + v.district + ' District' : ''),
        v.lat, v.lon, v.population, JSON.stringify(approx), 'observed',
        'REAL village: name & population from US Census 2020 (' + v.population.toLocaleString('en-US') +
        ' residents; 2010: ' + (v.population_2010 == null ? 'n/a' : v.population_2010.toLocaleString('en-US')) +
        '), coordinates from GeoNames. Display polygon is an approximate shape for visualization, not official boundaries.');
      const vid = vInfo.lastInsertRowid;

      // synthetic indicators (labeled)
      const gitaMin = round(0.25 + rnd() * 0.65, 4);
      const recDays = Math.round(4 + rnd() * 80);
      const floodMin = round(0.38 + rnd() * 0.58, 4);
      const income = round(Math.log(20000 + rnd() * 33000), 2);
      const ltHs = round(0.06 + rnd() * 0.27, 4);
      const unemp = round(0.02 + rnd() * 0.17, 4);
      const s65 = round(0.035 + rnd() * 0.11, 4);
      const distNode = round(0.1 + rnd() * 5.0, 2);
      const siai = round(0.25 + rnd() * 0.6, 4);
      const expFlood = round(rnd() * rnd(), 4);
      const popDens = round(Math.log(Math.max(v.population, 30) / (2.5 + rnd() * 6)), 2);
      const pv18 = rnd() < 0.3 ? Math.floor(rnd() * 250) : 0;
      const pvRecent = rnd() < 0.2 ? Math.floor(rnd() * 450) : 0;
      insInd.run(vid, gitaMin, subsetNames.has(v.name) ? recDays : null, floodMin, income, ltHs, unemp, s65,
        distNode, siai, expFlood, popDens, pv18, pv18 ? 2018 : null, round(rnd() * 4.5, 2),
        pvRecent, pvRecent ? 2024 : null, Math.floor(150 + rnd() * 2600), Math.floor(1 + rnd() * 3),
        subsetNames.has(v.name) ? 1 : 0, 'synthetic',
        'Synthetic demo indicators (patterned on published Tutuila analyses) attached to a REAL village',
        'TC Gita 2018 + 2025 flood window (demo values) / Census-shaped demo values');

      insEA.run(vid, 'distribution feeder node', Math.floor(120 + rnd() * 640), rnd() < 0.12 ? 1 : 0,
        'Synthetic demo asset — not a real feeder record.', 'synthetic', 'Synthetic demo dataset');
      insWA.run(vid, 'community storage tank', Math.floor(200 + rnd() * 2400), Math.floor(4 + rnd() * 26),
        rnd() < 0.5 ? 'chlorination (demo)' : 'unknown — no verified treatment data (demo)', 'synthetic', 'Synthetic demo dataset');
      const facTypes = ['clinic', 'school', 'emergency shelter', 'water pumping station'];
      const facCount = rnd() < 0.75 ? 1 : 2;
      for (let f = 0; f < facCount; f++) {
        const t = facTypes[Math.floor(rnd() * facTypes.length)];
        insFac.run(vid, t, `${v.name} ${t} (demo)`, Math.floor(4 + rnd() * 60), Math.floor(2 + rnd() * 30),
          'synthetic', 'Synthetic demo dataset');
      }
    });

    // ----- emergency resources (synthetic) -----
    const insRes = db.prepare(`INSERT INTO emergency_resources
      (resource_type, name, quantity, capacity_note, location, availability, transport_restriction, data_status, source)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    insRes.run('mobile_generator', 'Towable diesel generator 100 kW (demo)', 4, '100 kW each, 400 L integral tank', 'Depot A (demo location)', 'available', 'Road transport only', 'synthetic', 'Synthetic demo dataset');
    insRes.run('mobile_generator', 'Towable diesel generator 50 kW (demo)', 6, '50 kW each', 'Depot A (demo location)', 'available', 'Road transport only', 'synthetic', 'Synthetic demo dataset');
    insRes.run('diesel_fuel', 'Diesel stock (demo)', 12000, 'Liters, bulk', 'Fuel farm (demo location)', 'available', 'Hazmat transport rules', 'synthetic', 'Synthetic demo dataset');
    insRes.run('portable_battery', 'Portable battery energy units (demo)', 8, '20 kWh / 10 kW each', 'Depot B (demo location)', 'available', 'Light vehicle', 'synthetic', 'Synthetic demo dataset');
    insRes.run('water_tank', 'Mobile water tanks (demo)', 10, '10 m3 each, potable-rated (demo)', 'Depot B (demo location)', 'available', 'Truck mounted', 'synthetic', 'Synthetic demo dataset');
    insRes.run('water_truck', 'Water delivery trucks (demo)', 3, '12 m3 tanker each', 'Utilities yard (demo location)', 'available', 'Paved roads preferred', 'synthetic', 'Synthetic demo dataset');
    insRes.run('personnel', 'Emergency response crews (demo)', 12, '2-person crews', 'Depot A (demo location)', 'on_call', '-', 'synthetic', 'Synthetic demo dataset');
    insRes.run('budget', 'Emergency allocation budget (demo)', 250000, 'USD, demo fiscal window', 'HQ (demo)', 'available', '-', 'synthetic', 'Synthetic demo dataset');

    // ----- official notices -----
    const insNotice = db.prepare(`INSERT INTO official_notices
      (village_id, title, body, severity, verified, posted_by_role, posted_by_name, created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    insNotice.run(null, 'DEMONSTRATION MODE — no official emergency information is published here',
      'This portal is a working prototype. Village names, locations and census populations shown in the platform are real public data; emergency statuses, resource locations and restoration estimates are NOT official and are demo values only.',
      'info', 1, 'admin', 'Demo Administrator', today + ' 09:00:00');
    insNotice.run(null, 'Sample preparedness notice (demo content)',
      'Sample community preparedness reminder for demonstration of the notice workflow: store drinking water for 3 days, charge medical devices, and confirm your household evacuation meeting point. This sample notice is demo content, not an official advisory.',
      'info', 1, 'planner', 'Demo Emergency Planner', today + ' 09:30:00');

    db.prepare(`INSERT INTO community_reports (village_id, submitted_by_name, category, message, status)
      VALUES (?,?,?,?,?)`).run(3, 'Demo resident account', 'question',
      'Prototype feedback example: would the resilience hub serve the school in an outage? (demo record)', 'new');
  });

  tx();
  return {
    villages: db.prepare('SELECT COUNT(*) c FROM villages').get().c,
    indicators: db.prepare('SELECT COUNT(*) c FROM village_indicators').get().c,
    facilities: db.prepare('SELECT COUNT(*) c FROM critical_facilities').get().c,
    events: db.prepare('SELECT COUNT(*) c FROM historical_disaster_events').get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    realGeography: true,
    generatedOn: todayStr()
  };
}

function resetSeed() {
  const tables = [
    'sessions', 'users', 'user_roles', 'village_indicators', 'villages', 'historical_disaster_events',
    'electricity_assets', 'water_assets', 'critical_facilities', 'emergency_resources',
    'disaster_scenarios', 'scenario_results', 'investment_projects', 'project_assumptions',
    'project_cash_flows', 'project_milestones', 'contracts', 'esg_kpi_definitions',
    'esg_kpi_observations', 'community_reports', 'official_notices', 'audit_logs'
  ];
  db.exec('DELETE FROM ' + tables.join('; DELETE FROM ') + ';');
  return seed();
}

function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM villages').get().c === 0) return seed();
  return null;
}

module.exports = { seed, resetSeed, seedIfEmpty, DEFAULT_WEIGHTS, REAL };
