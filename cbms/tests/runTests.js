'use strict';

// Built-in API test suite. Runs against a live server instance.
//  - CLI:      npm test            (expects the server on PORT or 8734)
//  - In app:   POST /api/tests/run (Data & Tests page)
// The suite creates its own records (marked "qa"), then removes them again.

const { db } = require('../db');
const { todayStr, addDays } = require('../lib/constants');

async function runTests(baseUrl) {
  const results = [];
  const ctx = { bidIds: [], subIds: [] };
  const today = todayStr();

  const req = async (path, opts = {}) => {
    const res = await fetch(baseUrl + path, opts);
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body, headers: res.headers };
  };
  const post = (path, data) => req(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const eq = (a, b, msg) => assert(a === b, `${msg || 'values differ'} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

  const tests = [
    ['Meta endpoint flags synthetic sample data', async () => {
      const r = await req('/api/meta');
      eq(r.status, 200, 'status');
      eq(r.body.sampleData, true, 'sampleData flag');
      assert(String(r.body.sampleDataNotice).length > 30, 'sample data notice present');
    }],

    ['Dashboard KPIs reconcile with the bid register', async () => {
      const d = await req('/api/dashboard');
      const b = await req('/api/bids');
      eq(d.status, 200, 'dashboard status');
      eq(b.status, 200, 'bids status');
      eq(d.body.kpis.invitationsSent, b.body.rows.length, 'invitations equal bid rows');
      const overdue = b.body.rows.filter((r) => ['pending', 'accepted', 'in_preparation'].includes(r.status) && r.due_date < today).length;
      eq(d.body.kpis.overdue, overdue, 'overdue count');
    }],

    ['Rejects a subcontractor with a missing company name (400 + field error)', async () => {
      const r = await post('/api/subcontractors', { trade: 'Electrical' });
      eq(r.status, 400, 'status');
      assert(r.body.fields && r.body.fields.company_name, 'company_name error returned');
    }],

    ['Rejects an invalid email address (400 + field error)', async () => {
      const r = await post('/api/subcontractors', { company_name: 'QA Bad Email Co', trade: 'Electrical', email: 'not-an-email' });
      eq(r.status, 400, 'status');
      assert(r.body.fields && r.body.fields.email, 'email error returned');
    }],

    ['Creates, lists and updates a subcontractor', async () => {
      const create = await post('/api/subcontractors', {
        company_name: 'QA Test Subco (temp)', trade: 'Masonry', city: 'Denver', state: 'Colorado',
        email: 'qa@qatest.example.com', rating: 4, notes: 'qa-temp-record'
      });
      eq(create.status, 201, 'create status');
      ctx.subIds.push(create.body.id);
      const list = await req('/api/subcontractors?search=QA%20Test%20Subco&all=1');
      assert(list.body.rows.some((s) => s.id === create.body.id), 'created sub appears in list');
      const upd = await req(`/api/subcontractors/${create.body.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Tucson' })
      });
      eq(upd.status, 200, 'update status');
      eq(upd.body.city, 'Tucson', 'city updated');
    }],

    ['Blocks deleting a subcontractor that has bids (409)', async () => {
      const withBids = db.prepare(`
        SELECT s.id FROM subcontractors s
        WHERE EXISTS (SELECT 1 FROM bids b WHERE b.subcontractor_id = s.id)
        LIMIT 1`).get();
      const r = await req(`/api/subcontractors/${withBids.id}`, { method: 'DELETE' });
      eq(r.status, 409, 'status');
      assert(String(r.body.error).includes('cannot be deleted'), 'conflict message');
    }],

    ['Rejects a bid referencing an unknown project (400 + field error)', async () => {
      const r = await post('/api/bids', { project_id: 999999, subcontractor_id: ctx.subIds[0] });
      eq(r.status, 400, 'status');
      assert(r.body.fields && r.body.fields.project_id, 'project_id error returned');
    }],

    ['Bid lifecycle: invite, accept, start preparation', async () => {
      const create = await post('/api/bids', { project_id: 1, subcontractor_id: ctx.subIds[0] });
      eq(create.status, 201, 'create status');
      eq(create.body.status, 'pending', 'starts pending');
      ctx.bidIds.push(create.body.id);
      const accept = await post(`/api/bids/${create.body.id}/status`, { to_status: 'accepted', note: 'qa accept' });
      eq(accept.status, 200, 'accept status');
      const prep = await post(`/api/bids/${create.body.id}/status`, { to_status: 'in_preparation' });
      eq(prep.status, 200, 'in_preparation status');
      const invalid = await post(`/api/bids/${create.body.id}/status`, { to_status: 'accepted' });
      eq(invalid.status, 400, 'invalid transition rejected');
      assert(String(invalid.body.fields.to_status).includes('not allowed'), 'transition error message');
    }],

    ['Deadline extension logs an audit entry and flips the overdue flag', async () => {
      const bidId = ctx.bidIds[0];
      const ext = await post(`/api/bids/${bidId}/extend`, { due_date: addDays(today, -10), reason: 'qa test — simulate overdue' });
      eq(ext.status, 200, 'extend status');
      eq(ext.body.impact.nowOverdue, true, 'now overdue');
      const overdueList = await req('/api/bids?overdue=1');
      assert(overdueList.body.rows.some((b) => b.id === bidId), 'bid appears in overdue filter');
      const hist = await req(`/api/bids/${bidId}/history`);
      assert(hist.body.rows.some((h) => h.field === 'due_date' && String(h.note).includes('qa test')), 'due_date audit entry with reason');
    }],

    ['Submit flow works; illegal backwards transition is rejected', async () => {
      const bidId = ctx.bidIds[0];
      const sub = await post(`/api/bids/${bidId}/status`, { to_status: 'submitted', amount: 123456, note: 'qa submit' });
      eq(sub.status, 200, 'submit status');
      eq(sub.body.status, 'submitted', 'status is submitted');
      eq(sub.body.amount, 123456, 'amount saved');
      const back = await post(`/api/bids/${bidId}/status`, { to_status: 'in_preparation' });
      eq(back.status, 400, 'backwards transition rejected');
    }],

    ['Follow-up logging requires a note and records history', async () => {
      const bidId = ctx.bidIds[0];
      const missing = await post('/api/followups', { bid_id: bidId, note: '   ' });
      eq(missing.status, 400, 'empty note rejected');
      const ok = await post('/api/followups', { bid_id: bidId, note: 'qa follow-up call placed' });
      eq(ok.status, 201, 'follow-up logged');
      const hist = await req(`/api/bids/${bidId}/history`);
      assert(hist.body.rows.some((h) => h.entity_type === 'followup'), 'follow-up in history');
    }],

    ['CSV import: mixed file imports the valid row and reports the bad rows', async () => {
      const csv = [
        'company_name,trade,contact_name,email,rating,status,notes',
        'QA Import Good Co (temp),Electrical,Jane Doe,jane@qa.example.com,4,active,qa-import-marker',
        ',Electrical,Missing Name,x@x.com,3,active,qa-import-marker',
        'QA Import Bad Email,Electrical,Bad Email,broken-email,3,active,qa-import-marker'
      ].join('\n');
      const fd = new FormData();
      fd.append('file', new Blob([csv], { type: 'text/csv' }), 'qa-subs.csv');
      const res = await fetch(baseUrl + '/api/import/subcontractors', { method: 'POST', body: fd });
      const body = await res.json();
      eq(res.status, 200, 'import status');
      eq(body.imported, 1, 'one row imported');
      eq(body.failed, 2, 'two rows rejected');
      assert(body.failures[0].reason.length > 3, 'failure reason provided');
    }],

    ['Exports: CSV has headers, XLSX is a valid workbook (PK header)', async () => {
      const csv = await req('/api/export/subcontractors?format=csv');
      eq(csv.status, 200, 'csv status');
      assert(String(csv.headers.get('content-type')).includes('text/csv'), 'csv content type');
      assert(String(csv.body).includes('company_name'), 'csv header row present');
      const xlsx = await req('/api/export/bids?format=xlsx');
      eq(xlsx.status, 200, 'xlsx status');
      assert(String(xlsx.body).startsWith('PK'), 'xlsx magic bytes (ZIP)');
    }],

    ['Scenario comparison returns four scenarios with computed numbers', async () => {
      const r = await post('/api/scenarios', { extendDays: 7, addPerPackage: 1 });
      eq(r.status, 200, 'status');
      eq(r.body.scenarios.length, 4, 'four scenarios');
      for (const s of r.body.scenarios) {
        assert(typeof s.projectedSubmissions === 'number', 'projectedSubmissions numeric');
        assert(typeof s.riskIndex === 'number', 'riskIndex numeric');
      }
      assert(r.body.assumptions.rules.length >= 4, 'assumptions documented');
    }],

    ['Follow-up priorities are ranked with a visible score breakdown', async () => {
      const r = await req('/api/priorities');
      eq(r.status, 200, 'status');
      const items = r.body.items;
      assert(items.length > 0, 'at least one priority item');
      for (let i = 1; i < items.length; i++) {
        assert(items[i - 1].score >= items[i].score, 'sorted by score descending');
      }
      assert(items[0].breakdown.length >= 1, 'top item exposes its score breakdown');
      assert(r.body.rules.length >= 5, 'scoring rules documented');
    }],

    ['Unknown API route returns a JSON 404', async () => {
      const r = await req('/api/definitely-not-a-route');
      eq(r.status, 404, 'status');
      assert(r.body && r.body.error, 'JSON error body');
    }],

    ['Malformed JSON body returns a friendly 400', async () => {
      const res = await fetch(baseUrl + '/api/subcontractors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{oops-not-json'
      });
      const body = await res.json();
      eq(res.status, 400, 'status');
      assert(String(body.error).includes('JSON'), 'friendly message');
    }]
  ];

  for (const [name, fn] of tests) {
    try {
      await fn();
      results.push({ name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, detail: e.message });
    }
  }

  // ---- cleanup: remove everything the suite created ----
  try {
    const delHist = db.prepare(`DELETE FROM status_history WHERE (entity_type IN ('bid','followup') AND entity_id = ?) OR (entity_type = 'subcontractor' AND entity_id = ?)`);
    const delBid = db.prepare('DELETE FROM bids WHERE id = ?');
    const delSub = db.prepare('DELETE FROM subcontractors WHERE id = ?');
    for (const id of ctx.bidIds) { delHist.run(id, -1); delBid.run(id); }
    for (const id of ctx.subIds) { delHist.run(-1, id); delSub.run(id); }
    const imported = db.prepare(`SELECT id FROM subcontractors WHERE notes LIKE 'qa-import%'`).all();
    for (const row of imported) { delHist.run(-1, row.id); delSub.run(row.id); }
    const leftover = db.prepare(`SELECT id FROM subcontractors WHERE company_name LIKE 'QA %'`).all();
    for (const row of leftover) { delHist.run(-1, row.id); delSub.run(row.id); }
  } catch (e) {
    results.push({ name: 'Cleanup of qa records', pass: false, detail: e.message });
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    baseUrl,
    ranAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    allPassed: passed === results.length,
    results
  };
}

module.exports = { runTests };

if (require.main === module) {
  const port = process.env.PORT || 8734;
  runTests(`http://127.0.0.1:${port}`).then((r) => {
    for (const t of r.results) {
      console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.name}${t.pass ? '' : '  -> ' + t.detail}`);
    }
    console.log(`\n${r.passed}/${r.total} passed`);
    process.exit(r.allPassed ? 0 : 1);
  }).catch((e) => { console.error('Test runner crashed:', e); process.exit(2); });
}
