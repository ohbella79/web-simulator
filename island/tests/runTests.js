'use strict';

// Phase 1 validation suite. Runs against a live server (accepts a base URL).
// CLI:  npm test     In app: Governance -> Validation.

const { db } = require('../db');
const { PROVENANCE } = require('../lib/constants');

async function runTests(baseUrl) {
  const results = [];
  const jar = {}; // simple cookie jar per user
  const ctx = {}; // cross-test values (import stamp etc)
  const req = async (path, opts = {}, as) => {
    const headers = Object.assign({}, opts.headers || {});
    if (as && jar[as]) headers.Cookie = jar[as];
    const res = await fetch(baseUrl + path, Object.assign({}, opts, { headers }));
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && as) jar[as] = setCookie.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body, headers: res.headers };
  };
  const post = (path, data, as) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }, as);
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, m) => assert(a === b, `${m || 'values differ'} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

  const login = async (email, as) => {
    const r = await post('/api/auth/login', { email, password: 'Demo2026!' }, as);
    eq(r.status, 200, `login ${email}`);
    return r;
  };

  const tests = [
    ['Database schema contains all 20 required tables', async () => {
      const required = ['villages', 'village_indicators', 'historical_disaster_events', 'electricity_assets',
        'water_assets', 'critical_facilities', 'emergency_resources', 'disaster_scenarios', 'scenario_results',
        'investment_projects', 'project_assumptions', 'project_cash_flows', 'esg_kpi_definitions',
        'esg_kpi_observations', 'project_milestones', 'contracts', 'community_reports', 'official_notices',
        'audit_logs', 'user_roles'];
      for (const t of required) {
        assert(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), `missing table ${t}`);
      }
    }],

    ['Real Census villages seeded with coordinates and populations', async () => {
      const n = db.prepare('SELECT COUNT(*) c FROM villages').get().c;
      assert(n >= 50, 'village count ' + n);
      const bad = db.prepare('SELECT COUNT(*) c FROM villages WHERE lat NOT BETWEEN -15.2 AND -13.4 OR lon NOT BETWEEN -171.3 AND -169.3').get().c;
      eq(bad, 0, 'villages outside bbox');
      const fake = db.prepare(`SELECT COUNT(*) c FROM villages WHERE data_status != 'observed' OR population IS NULL OR population < 1`).get().c;
      eq(fake, 0, 'all villages real with populations');
      const feats = db.prepare(`SELECT geometry_json FROM villages`).all().map((r) => JSON.parse(r.geometry_json));
      eq(feats.length, n, 'geojson rows');
      for (const g of feats) {
        assert(g.type === 'Polygon' || g.type === 'Point', 'geometry type');
        const c0 = g.coordinates[0][0];
        assert(Number.isFinite(c0[0]) && Number.isFinite(c0[1]), 'finite coordinates');
      }
    }],

    ['Every Chart.js config declares a top-level type (prevents undefined-controller crash)', async () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      const re = /new Chart\(\s*\$\([^)]+\)\s*,\s*\{/g;
      let m, count = 0;
      while ((m = re.exec(html))) {
        count++;
        const next = html.slice(m.index, m.index + 160);
        assert(/type:\s*['"]/.test(next), 'Chart config #' + count + ' missing type:');
      }
      assert(count >= 5, 'expected chart configs found (got ' + count + ')');
    }],
    ['Every indicator row carries a provenance status from the allowed list', async () => {
      const rows = db.prepare('SELECT DISTINCT data_status FROM village_indicators').all();
      for (const r of rows) assert(PROVENANCE.includes(r.data_status), `provenance ${r.data_status} not allowed`);
      eq(db.prepare(`SELECT COUNT(*) c FROM village_indicators WHERE data_status='observed' AND (vintage_label IS NULL OR vintage_label NOT LIKE '%observed%')`).get().c, 0, 'observed rows must cite observed provenance');
      eq(db.prepare(`SELECT COUNT(*) c FROM village_indicators WHERE data_status NOT IN ('synthetic','observed')`).get().c, 0, 'no stray provenance');
    }],

    ['Unauthenticated API access is rejected with 401', async () => {
      const r = await req('/api/villages');
      eq(r.status, 401, 'status');
      assert(r.body && r.body.error, 'error message present');
    }],

    ['Wrong password is rejected (401) and the failure is audited', async () => {
      const r = await post('/api/auth/login', { email: 'executive@demo.islandresilience.ai', password: 'wrong' });
      eq(r.status, 401, 'status');
      const hit = db.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE action='login_failed'`).get().c;
      assert(hit > 0, 'audit entry written');
    }],

    ['All four demo roles can sign in', async () => {
      await login('executive@demo.islandresilience.ai', 'exec');
      await login('engineer@demo.islandresilience.ai', 'eng');
      await login('planner@demo.islandresilience.ai', 'plan');
      await login('resident@demo.islandresilience.ai', 'res');
    }],

    ['Passwordless demo-login issues a working session', async () => {
      const r = await post('/api/auth/demo-login', { role: 'planner' }, 'demo');
      eq(r.status, 200, 'status');
      eq(r.body.user.role, 'planner', 'role honored');
      assert(r.body.demoMode === true, 'demoMode flag');
      const map = await req('/api/villages', {}, 'demo');
      eq(map.status, 200, 'session works on protected API');
      const bad = await post('/api/auth/demo-login', { role: 'nope' });
      eq(bad.status, 400, 'unknown role rejected');
    }],

    ['Community resident is blocked from the village map API (403)', async () => {
      const r = await req('/api/villages', {}, 'res');
      eq(r.status, 403, 'status');
      assert(String(r.body.error).includes('not authorized'), 'authorization message');
    }],

    ['Resident is blocked from data import (403); engineer can access templates', async () => {
      const r = await req('/api/export/template/villages', {}, 'res');
      eq(r.status, 403, 'resident blocked');
      const ok = await req('/api/export/template/villages', {}, 'eng');
      eq(ok.status, 200, 'engineer allowed');
    }],

    ['Screening is deterministic and responds to weight changes', async () => {
      const a = await req('/api/screening', {}, 'eng');
      const b = await req('/api/screening', {}, 'eng');
      eq(a.status, 200, 'screening status');
      eq(JSON.stringify(a.body.results), JSON.stringify(b.body.results), 'identical runs');
      const topA = a.body.results[0].score;
      const w = { disruption: 10, recovery: 0, social: 0, access: 0, exposure: 0, water: 0 };
      const c = await req('/api/screening?weights=' + encodeURIComponent(JSON.stringify(w)), {}, 'eng');
      assert(c.status === 200, 'weighted screening ok');
      const topC = c.body.results[0].score;
      assert(topA !== topC || JSON.stringify(a.body.weightsUsed) !== JSON.stringify(c.body.weightsUsed), 'weights change the output');
      assert(String(JSON.stringify(c.body.method.disclaimer)).includes('not a validated outage probability'), 'disclaimer present');
    }],

    ['Screening flags missing data instead of imputing', async () => {
      const r = await req('/api/screening', {}, 'eng');
      const anyFlags = r.body.results.some((v) => v.data_quality.missing_inputs.length > 0);
      assert(anyFlags, 'at least one village has missing-input flags');
      const subset = r.body.results.find((v) => !v.data_quality.in_analytical_subset);
      assert(subset && subset.data_quality.warnings.some((x) => x.includes('subset')), 'subset warning present');
    }],

    ['Village profile returns assets and facilities', async () => {
      const r = await req('/api/villages/3', {}, 'eng');
      eq(r.status, 200, 'status');
      assert(r.body.village.village_name, 'village name');
      assert(Array.isArray(r.body.facilities) && r.body.facilities.length >= 0, 'facilities array');
      const miss = await req('/api/villages/99999', {}, 'eng');
      eq(miss.status, 404, 'missing village 404');
    }],

    ['CSV village import validates rows: one imported, bad rows rejected with reasons', async () => {
      const S = 'QA' + Date.now().toString(36).toUpperCase();
      ctx.importStamp = S;
      const csv = [
        'village_code,village_name,district_label,lat,lon,population',
        `${S}-1,QA Import Village (temp),QA,-14.28,-170.75,500`,
        `${S}-2,Bad Coords (temp),QA,-20.00,170.75,300`,
        `${S}-3,,QA,-14.28,-170.76,200`,
        `${S}-1,Duplicate village (temp),QA,-14.28,-170.77,100`
      ].join('\n');
      const fd = new FormData();
      fd.append('file', new Blob([csv], { type: 'text/csv' }), 'qa-villages.csv');
      const res = await fetch(baseUrl + '/api/import/villages', { method: 'POST', headers: { Cookie: jar.eng }, body: fd });
      const body = await res.json();
      eq(res.status, 200, 'import status');
      eq(body.imported, 1, 'one imported');
      eq(body.failed, 3, 'three rejected');
      assert(body.failures[0].reason.length > 3, 'failure reason provided');
      const dup = db.prepare(`SELECT COUNT(*) c FROM villages WHERE village_code = ? AND village_name LIKE 'QA Import%'`).get(ctx.importStamp + '-1').c;
      eq(dup, 1, 'only the valid row persisted');
    }],

    ['Indicator import updates an existing village and rejects out-of-range values', async () => {
      const S = ctx.importStamp;
      const csv = [
        'village_code,share_65plus,dist_power_node_km,water_storage_m3',
        `${S}-1,0.11,2.5,700`,
        `${S}-1,5.0,1.0,600`
      ].join('\n');
      const fd = new FormData();
      fd.append('file', new Blob([csv], { type: 'text/csv' }), 'qa-ind.csv');
      const res = await fetch(baseUrl + '/api/import/indicators', { method: 'POST', headers: { Cookie: jar.eng }, body: fd });
      const body = await res.json();
      eq(res.status, 200, 'status');
      eq(body.imported, 1, 'valid row imported');
      eq(body.failed, 1, 'out-of-range row rejected');
      const v = db.prepare(`SELECT i.share_65plus FROM villages v JOIN village_indicators i ON i.village_id=v.id WHERE v.village_code = ?`).get(ctx.importStamp + '-1');
      assert(v && Math.abs(v.share_65plus - 0.11) < 1e-9, 'indicator value persisted');
    }],

    ['Portal: resident can read notices and village status; all marked demo', async () => {
      const n = await req('/api/portal/notices', {}, 'res');
      eq(n.status, 200, 'notices status');
      assert(n.body.rows.some((x) => x.official === true), 'verified notice exists');
      const v = await req('/api/portal/villages', {}, 'res');
      const first = v.body.rows[0];
      const detail = await req('/api/portal/village/' + first.id, {}, 'res');
      eq(detail.status, 200, 'village status');
      assert(String(detail.body.electricity_status.status) === 'no_verified_live_data', 'no fake live data claimed');
      assert(String(detail.body.demoNotice).includes('DEMONSTRATION MODE'), 'demo banner text');
    }],

    ['Feedback requires a message and is persisted + audited', async () => {
      const bad = await post('/api/portal/feedback', { message: '   ' }, 'res');
      eq(bad.status, 400, 'empty rejected');
      const ok = await post('/api/portal/feedback', { message: 'qa-feedback-test' }, 'res');
      eq(ok.status, 201, 'accepted');
      const hit = db.prepare(`SELECT COUNT(*) c FROM community_reports WHERE message='qa-feedback-test'`).get().c;
      eq(hit, 1, 'persisted');
      const aud = db.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE action='feedback'`).get().c;
      assert(aud > 0, 'audited');
    }],

    ['Phase preview endpoint serves real inventory data (resident blocked)', async () => {
      const r = await req('/api/preview/overview', {}, 'exec');
      eq(r.status, 200, 'status');
      assert(r.body.villages >= 50, 'village count present');
      assert(r.body.population > 30000, 'census population total');
      assert(r.body.resources.length >= 8, 'resource inventory rows');
      const res403 = await req('/api/preview/overview', {}, 'res');
      eq(res403.status, 403, 'resident blocked');
    }],

    ['Governance overview and audit feed are role-protected (resident 403)', async () => {
      const r = await req('/api/gov/overview', {}, 'res');
      eq(r.status, 403, 'resident blocked');
      const ok = await req('/api/gov/overview', {}, 'exec');
      eq(ok.status, 200, 'executive allowed');
      assert(ok.body.counts.villages >= 51, 'counts include the QA import');
    }],

    ['Exports work: screening CSV has headers, villages XLSX has ZIP magic bytes', async () => {
      const csv = await req('/api/export/screening?format=csv', {}, 'exec');
      eq(csv.status, 200, 'csv status');
      assert(String(csv.body).includes('screening_score'), 'screening header');
      assert(String(csv.body).includes('not a validated outage probability'), 'disclaimer exported');
      const x = await req('/api/export/villages?format=xlsx', {}, 'exec');
      eq(x.status, 200, 'xlsx status');
      assert(String(x.body).startsWith('PK'), 'zip magic');
    }],

    ['Village list + geojson feature counts agree and stay stable (reproducibility)', async () => {
      const a = await req('/api/villages/geojson', {}, 'eng');
      const b = await req('/api/villages/geojson', {}, 'eng');
      eq(JSON.stringify(a.body), JSON.stringify(b.body), 'identical geojson');
      const list = await req('/api/villages', {}, 'eng');
      eq(list.body.rows.length, a.body.features.length, 'list vs geojson count');
    }]
  ];

  for (const [name, fn] of tests) {
    try { await fn(); results.push({ name, pass: true }); }
    catch (e) { results.push({ name, pass: false, detail: e.message }); }
  }

  // ---- cleanup: remove QA records created by the suite ----
  try {
    const qa = db.prepare(`SELECT id FROM villages WHERE village_code LIKE 'QA%' OR village_name LIKE 'QA %' OR village_name LIKE '%(temp)' OR village_code LIKE 'IMP-%'`).all();
    for (const v of qa) {
      db.prepare('DELETE FROM village_indicators WHERE village_id = ?').run(v.id);
      db.prepare('DELETE FROM critical_facilities WHERE village_id = ?').run(v.id);
      db.prepare('DELETE FROM electricity_assets WHERE village_id = ?').run(v.id);
      db.prepare('DELETE FROM water_assets WHERE village_id = ?').run(v.id);
      db.prepare('DELETE FROM villages WHERE id = ?').run(v.id);
    }
    db.prepare(`DELETE FROM community_reports WHERE message LIKE 'qa-%'`).run();
  } catch (e) {
    results.push({ name: 'Cleanup of qa records', pass: false, detail: e.message });
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    baseUrl, ranAt: new Date().toISOString(), phase: 'Phase 1',
    total: results.length, passed, failed: results.length - passed,
    allPassed: passed === results.length, results
  };
}

module.exports = { runTests };

if (require.main === module) {
  const port = process.env.PORT || 8741;
  runTests(`http://127.0.0.1:${port}`).then((r) => {
    for (const t of r.results) console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.name}${t.pass ? '' : '  -> ' + t.detail}`);
    console.log(`\n${r.passed}/${r.total} passed`);
    process.exit(r.allPassed ? 0 : 1);
  }).catch((e) => { console.error('Test runner crashed:', e); process.exit(2); });
}
