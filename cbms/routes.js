'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');

const { db } = require('./db');
const { resetSeed, seedIfEmpty, REAL } = require('./seed');
const analytics = require('./analytics');
const v = require('./validate');
const { importFile, exportReport, TEMPLATES } = require('./importExport');
const { runTests } = require('./tests/runTests');
const {
  TRADES, STATUS_LABELS, OPEN_STATUSES, todayStr, daysBetween, addDays
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

const api = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (e) { next(e); }
};
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const logHistory = db.prepare(`INSERT INTO status_history
  (entity_type, entity_id, field, old_value, new_value, note, actor, changed_at)
  VALUES (?,?,?,?,?,?,?,?)`);

// ---------- meta ----------
router.get('/market/ga', api((req, res) => {
  res.json(require('./data-real/ga_market.json'));
}));

router.get('/meta', api((req, res) => {
  res.json({
    name: 'Construction Bid Management System',
    version: '1.0.0',
    sampleData: true,
    sampleDataNotice: 'Project facts — names, locations, letting dates, engineer estimates, contractor names and bid amounts — are REAL public TxDOT bid tabulation records (Texas Open Data Portal). Contacts, ratings and bid-desk workflow statuses are synthetic demo values layered on top.',
    dataSources: REAL.sources,
    today: todayStr(),
    trades: TRADES,
    statusLabels: STATUS_LABELS,
    openStatuses: OPEN_STATUSES
  });
}));

// ---------- dashboard ----------
router.get('/dashboard', api((req, res) => res.json(analytics.getDashboard())));
router.get('/analytics', api((req, res) => res.json(analytics.getBidAnalytics())));
router.get('/activity', api((req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);
  res.json({ items: analytics.getActivity(limit) });
}));

// ---------- subcontractors ----------
const SUB_LIST_SQL = `
  SELECT s.*,
    (SELECT COUNT(*) FROM bids b WHERE b.subcontractor_id = s.id) AS total_bids,
    (SELECT COUNT(*) FROM bids b2 WHERE b2.subcontractor_id = s.id AND b2.status IN ('pending','accepted','in_preparation')) AS open_bids,
    (SELECT COUNT(*) FROM bids b3 WHERE b3.subcontractor_id = s.id AND b3.status IN ('pending','accepted','in_preparation') AND b3.due_date < ?) AS overdue_bids
  FROM subcontractors s`;

router.get('/subcontractors', api((req, res) => {
  const today = todayStr();
  const { search, trade, status } = req.query;
  const where = [];
  const params = [today];
  if (search) { where.push('(s.company_name LIKE ? OR s.contact_name LIKE ? OR s.city LIKE ?)'); const q = `%${String(search).trim()}%`; params.push(q, q, q); }
  if (trade && TRADES.includes(trade)) { where.push('s.trade = ?'); params.push(trade); }
  if (status === 'active' || status === 'inactive') { where.push('s.status = ?'); params.push(status); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  if (req.query.all === '1') {
    const rows = db.prepare(`${SUB_LIST_SQL}${whereSql} ORDER BY s.company_name`).all(...params);
    return res.json({ rows, total: rows.length });
  }
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 5), 50);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) c FROM subcontractors s${whereSql}`).get(...params.slice(1)).c;
  const rows = db.prepare(`${SUB_LIST_SQL}${whereSql} ORDER BY s.company_name LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ rows, total, page, pages: Math.max(Math.ceil(total / pageSize), 1), pageSize });
}));

router.get('/subcontractors/:id', api((req, res) => {
  const today = todayStr();
  const sub = db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subcontractor not found.' });
  const bids = db.prepare(`
    SELECT b.*, p.name AS project_name, p.priority,
      CAST(julianday(?) - julianday(b.due_date) AS INTEGER) AS days_overdue
    FROM bids b JOIN projects p ON p.id = b.project_id
    WHERE b.subcontractor_id = ? ORDER BY b.due_date`).all(today, sub.id);
  const history = db.prepare(`
    SELECT h.* FROM status_history h
    WHERE (h.entity_type = 'subcontractor' AND h.entity_id = ?)
       OR (h.entity_type = 'bid' AND h.entity_id IN (SELECT id FROM bids WHERE subcontractor_id = ?))
       OR (h.entity_type = 'followup' AND h.entity_id IN (SELECT id FROM bids WHERE subcontractor_id = ?))
    ORDER BY h.id DESC LIMIT 100`).all(sub.id, sub.id, sub.id);
  res.json({ sub, bids, history });
}));

router.post('/subcontractors', api((req, res) => {
  const check = v.validateSubcontractor(req.body || {}, db);
  if (!check.ok) return res.status(400).json({ error: 'Validation failed. Fix the highlighted fields.', fields: check.errors });
  const val = check.value;
  const info = db.prepare(`INSERT INTO subcontractors
    (company_name, trade, contact_name, email, phone, city, state, rating, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(val.company_name, val.trade, val.contact_name, val.email, val.phone, val.city, val.state, val.rating, val.status, val.notes);
  logHistory.run('subcontractor', info.lastInsertRowid, 'profile', '', 'created', 'Subcontractor added', 'PM (demo)', nowSql());
  res.status(201).json(db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(info.lastInsertRowid));
}));

router.put('/subcontractors/:id', api((req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Subcontractor not found.' });
  const check = v.validateSubcontractor({ ...existing, ...req.body }, db, id);
  if (!check.ok) return res.status(400).json({ error: 'Validation failed. Fix the highlighted fields.', fields: check.errors });
  const val = check.value;
  db.prepare(`UPDATE subcontractors SET company_name=?, trade=?, contact_name=?, email=?, phone=?, city=?, state=?, rating=?, status=?, notes=? WHERE id=?`)
    .run(val.company_name, val.trade, val.contact_name, val.email, val.phone, val.city, val.state, val.rating, val.status, val.notes, id);
  for (const field of ['company_name', 'trade', 'contact_name', 'email', 'phone', 'city', 'state', 'rating', 'status', 'notes']) {
    if (String(existing[field]) !== String(val[field])) {
      logHistory.run('subcontractor', id, field, String(existing[field]), String(val[field]),
        `Updated ${field.replace('_', ' ')}`, 'PM (demo)', nowSql());
    }
  }
  res.json(db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(id));
}));

router.delete('/subcontractors/:id', api((req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM subcontractors WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Subcontractor not found.' });
  const bids = db.prepare('SELECT COUNT(*) c FROM bids WHERE subcontractor_id = ?').get(id).c;
  if (bids > 0) {
    return res.status(409).json({ error: `This subcontractor has ${bids} bid record${bids === 1 ? '' : 's'} and cannot be deleted. Set the status to inactive instead.` });
  }
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM status_history WHERE (entity_type='subcontractor' AND entity_id=?) OR (entity_type='followup' AND entity_id IN (SELECT id FROM bids WHERE subcontractor_id=?))`).run(id, id);
    db.prepare('DELETE FROM bids WHERE subcontractor_id = ?').run(id);
    db.prepare('DELETE FROM subcontractors WHERE id = ?').run(id);
  });
  tx();
  res.status(204).end();
}));

// ---------- projects ----------
router.get('/projects', api((req, res) => {
  const today = todayStr();
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM bids b WHERE b.project_id = p.id) AS total_bids,
      (SELECT COUNT(*) FROM bids b WHERE b.project_id = p.id AND b.status IN ('pending','accepted','in_preparation')) AS open_bids,
      (SELECT COUNT(*) FROM bids b WHERE b.project_id = p.id AND b.status IN ('pending','accepted','in_preparation') AND b.due_date < ?) AS overdue_bids,
      (SELECT COUNT(*) FROM bids b WHERE b.project_id = p.id AND b.status = 'submitted') AS submitted_bids
    FROM projects p ORDER BY p.due_date`).all(today);
  res.json({ rows });
}));

router.post('/projects', api((req, res) => {
  const check = v.validateProject(req.body || {}, db);
  if (!check.ok) return res.status(400).json({ error: 'Validation failed. Fix the highlighted fields.', fields: check.errors });
  const val = check.value;
  const info = db.prepare(`INSERT INTO projects (name, location, priority, due_date, original_due_date, status, description)
    VALUES (?,?,?,?,?,?,?)`)
    .run(val.name, val.location, val.priority, val.due_date, val.due_date, val.status, val.description);
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
}));

router.put('/projects/:id', api((req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found.' });
  const check = v.validateProject({ ...existing, ...req.body, due_date: existing.due_date }, db, id);
  if (!check.ok) return res.status(400).json({ error: 'Validation failed. Fix the highlighted fields.', fields: check.errors });
  const val = check.value;
  db.prepare('UPDATE projects SET name=?, location=?, priority=?, status=?, description=? WHERE id=?')
    .run(val.name, val.location, val.priority, val.status, val.description, id);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}));

router.post('/projects/:id/deadline-preview', api((req, res) => {
  const id = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const check = v.validateDeadlineChange(req.body || {});
  if (!check.ok) return res.status(400).json({ error: 'Validation failed.', fields: check.errors });
  const newDue = check.value.due_date;
  const today = todayStr();
  const open = db.prepare(`SELECT b.*, s.company_name FROM bids b JOIN subcontractors s ON s.id = b.subcontractor_id
    WHERE b.project_id = ? AND ${'b.status IN (\u0027pending\u0027,\u0027accepted\u0027,\u0027in_preparation\u0027)'}`).all(id);
  const overdueNow = open.filter((b) => b.due_date < today).length;
  const overdueAfter = check.value.cascade ? (newDue < today ? open.length : 0) : overdueNow;
  const moves = open.filter((b) => b.due_date !== newDue);
  res.json({
    newDue, cascade: check.value.cascade,
    openCount: open.length,
    overdueNow, overdueAfter,
    bidsMoved: check.value.cascade ? moves.length : 0,
    sampleMoves: moves.slice(0, 5).map((b) => `${b.company_name} (${b.due_date} → ${newDue})`)
  });
}));

router.post('/projects/:id/deadline', api((req, res) => {
  const id = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const check = v.validateDeadlineChange(req.body || {});
  if (!check.ok) return res.status(400).json({ error: 'Validation failed.', fields: check.errors });
  const { due_date: newDue, cascade, reason } = check.value;
  const today = todayStr();
  let bidsUpdated = 0;
  const tx = db.transaction(() => {
    db.prepare('UPDATE projects SET due_date = ? WHERE id = ?').run(newDue, id);
    logHistory.run('project', id, 'due_date', project.due_date, newDue,
      reason || 'Project bid date adjusted', 'PM (demo)', nowSql());
    if (cascade) {
      const open = db.prepare(`SELECT b.*, s.company_name FROM bids b JOIN subcontractors s ON s.id = b.subcontractor_id
        WHERE b.project_id = ? AND b.status IN ('pending','accepted','in_preparation') AND b.due_date != ?`).all(id, newDue);
      const upd = db.prepare('UPDATE bids SET due_date = ? WHERE id = ?');
      for (const b of open) {
        upd.run(newDue, b.id);
        logHistory.run('bid', b.id, 'due_date', b.due_date, newDue,
          `Aligned with project deadline change${reason ? ': ' + reason : ''}`, 'PM (demo)', nowSql());
        bidsUpdated++;
      }
    }
  });
  tx();
  res.json({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id),
    bidsUpdated,
    overdueResolved: cascade && newDue >= today
  });
}));

// ---------- bids ----------
const BID_SELECT = `
  SELECT b.*, p.name AS project_name, p.priority AS project_priority,
    s.company_name, s.trade, s.rating, s.contact_name, s.email, s.phone
  FROM bids b JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id`;

router.get('/bids', api((req, res) => {
  const today = todayStr();
  const { status, projectId, trade, search, overdue, dueSoon } = req.query;
  const where = [];
  const params = [];
  if (status && STATUS_LABELS[status]) { where.push('b.status = ?'); params.push(status); }
  if (projectId) { where.push('b.project_id = ?'); params.push(Number(projectId)); }
  if (trade && TRADES.includes(trade)) { where.push('s.trade = ?'); params.push(trade); }
  if (search) { const q = `%${String(search).trim()}%`; where.push('(s.company_name LIKE ? OR p.name LIKE ?)'); params.push(q, q); }
  if (overdue === '1') { where.push(`b.status IN ('pending','accepted','in_preparation') AND b.due_date < ?`); params.push(today); }
  if (dueSoon === '1') { where.push(`b.status IN ('pending','accepted','in_preparation') AND b.due_date >= ? AND b.due_date <= date(?, '+3 day')`); params.push(today, today); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`${BID_SELECT}${whereSql} ORDER BY b.due_date, s.company_name LIMIT 500`).all(...params);
  for (const r of rows) {
    r.days_overdue = Math.max(daysBetween(r.due_date, today), 0);
    r.days_left = Math.max(-daysBetween(r.due_date, today), 0);
  }
  res.json({ rows, total: rows.length });
}));

router.get('/bids/:id', api((req, res) => {
  const row = db.prepare(`${BID_SELECT} WHERE b.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Bid not found.' });
  res.json(row);
}));

router.get('/bids/:id/history', api((req, res) => {
  const rows = db.prepare(`SELECT * FROM status_history WHERE (entity_type='bid' OR entity_type='followup') AND entity_id = ? ORDER BY id`).all(req.params.id);
  res.json({ rows });
}));

router.post('/bids', api((req, res) => {
  const check = v.validateBidNew(req.body || {}, db);
  if (!check.ok) return res.status(400).json({ error: 'Validation failed. Fix the highlighted fields.', fields: check.errors });
  const val = check.value;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(val.project_id);
  const due = val.due_date || project.due_date;
  const info = db.prepare(`INSERT INTO bids
    (project_id, subcontractor_id, invited_date, status, due_date, original_due_date, notes)
    VALUES (?,?,?,?,?,?,?)`)
    .run(val.project_id, val.subcontractor_id, val.invited_date, 'pending', due, due, val.notes);
  logHistory.run('bid', info.lastInsertRowid, 'status', '', 'pending', 'Invitation sent', 'PM (demo)', nowSql());
  res.status(201).json(db.prepare(`${BID_SELECT} WHERE b.id = ?`).get(info.lastInsertRowid));
}));

router.post('/bids/:id/status', api((req, res) => {
  const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(req.params.id);
  if (!bid) return res.status(404).json({ error: 'Bid not found.' });
  const check = v.validateStatusChange(bid, req.body || {});
  if (!check.ok) return res.status(400).json({ error: 'Validation failed.', fields: check.errors });
  const val = check.value;
  const tx = db.transaction(() => {
    if (val.to_status === 'submitted') {
      db.prepare('UPDATE bids SET status=?, submitted_date=?, amount=? WHERE id=?')
        .run(val.to_status, val.submitted_date, val.amount, bid.id);
    } else if (val.to_status === 'accepted' || val.to_status === 'declined') {
      db.prepare('UPDATE bids SET status=?, responded_date=? WHERE id=?').run(val.to_status, val.responded_date, bid.id);
    } else {
      db.prepare('UPDATE bids SET status=? WHERE id=?').run(val.to_status, bid.id);
    }
    const note = val.note || ({
      accepted: 'Subcontractor accepted the invitation',
      declined: 'Subcontractor declined the invitation',
      in_preparation: 'Proposal preparation started',
      submitted: 'Proposal submitted'
    }[val.to_status] || 'Status updated');
    logHistory.run('bid', bid.id, 'status', bid.status, val.to_status, note, 'PM (demo)', nowSql());
  });
  tx();
  res.json(db.prepare(`${BID_SELECT} WHERE b.id = ?`).get(bid.id));
}));

router.post('/bids/:id/extend', api((req, res) => {
  const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(req.params.id);
  if (!bid) return res.status(404).json({ error: 'Bid not found.' });
  if (!OPEN_STATUSES.includes(bid.status)) {
    return res.status(400).json({ error: 'Only open bids (pending, accepted, in preparation) can have their due date extended.' });
  }
  const check = v.validateExtend(req.body || {});
  if (!check.ok) return res.status(400).json({ error: 'Validation failed.', fields: check.errors });
  const { due_date: newDue, reason } = check.value;
  const today = todayStr();
  const wasOverdue = bid.due_date < today;
  const tx = db.transaction(() => {
    db.prepare('UPDATE bids SET due_date = ? WHERE id = ?').run(newDue, bid.id);
    logHistory.run('bid', bid.id, 'due_date', bid.due_date, newDue,
      reason || 'Due date extended by PM', 'PM (demo)', nowSql());
  });
  tx();
  res.json({
    bid: db.prepare(`${BID_SELECT} WHERE b.id = ?`).get(bid.id),
    impact: { wasOverdue, nowOverdue: newDue < today, previousDue: bid.due_date, newDue }
  });
}));

// ---------- follow-up log ----------
router.post('/followups', api((req, res) => {
  const bidId = Number((req.body || {}).bid_id);
  const note = String((req.body || {}).note || '').trim();
  if (!Number.isInteger(bidId) || !db.prepare('SELECT id FROM bids WHERE id = ?').get(bidId)) {
    return res.status(400).json({ error: 'A valid bid_id is required.' });
  }
  if (!note) return res.status(400).json({ error: 'A follow-up note is required.', fields: { note: 'Describe what was done (call, email, site visit...).' } });
  if (note.length > 500) return res.status(400).json({ error: 'Keep the note under 500 characters.' });
  logHistory.run('followup', bidId, 'followup', '', 'logged', note, 'PM (demo)', nowSql());
  res.status(201).json({ ok: true });
}));

// ---------- analytics ----------
router.get('/risk', api((req, res) => res.json(analytics.getRisk())));
router.get('/priorities', api((req, res) => res.json(analytics.getPriorities())));
router.post('/scenarios', api((req, res) => {
  const body = req.body || {};
  let ext = Number(body.extendDays);
  let add = Number(body.addPerPackage);
  if (!Number.isFinite(ext)) ext = 0;
  if (!Number.isFinite(add)) add = 0;
  ext = Math.min(Math.max(Math.round(ext), 0), 30);
  add = Math.min(Math.max(Math.round(add), 0), 5);
  res.json(analytics.getScenarios({ extendDays: ext, addPerPackage: add }));
}));

// ---------- import ----------
router.post('/import/subcontractors', upload.single('file'), api((req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a .csv, .xlsx or .xls file in the "file" field.' });
  res.json(importFile('subcontractors', req.file.buffer, req.file.originalname));
}));
router.post('/import/bids', upload.single('file'), api((req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a .csv, .xlsx or .xls file in the "file" field.' });
  res.json(importFile('bids', req.file.buffer, req.file.originalname));
}));

// ---------- export ----------
router.get('/export/template/:type', api((req, res) => {
  const tpl = TEMPLATES[req.params.type];
  if (!tpl) return res.status(404).json({ error: 'Unknown template. Use subcontractors or bids.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-import-template.csv"`);
  res.send(tpl);
}));

router.get('/export/:type', api((req, res) => {
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
  const out = exportReport(req.params.type, format);
  if (!out) return res.status(404).json({ error: 'Unknown report. Use subcontractors, bids, risk or summary.' });
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.body);
}));

// ---------- admin & tests ----------
router.post('/admin/reset', api((req, res) => {
  const counts = resetSeed();
  res.json({ ok: true, message: 'Database was cleared and reseeded with synthetic sample data.', counts });
}));

router.post('/admin/reseed-if-empty', api((req, res) => {
  const counts = seedIfEmpty();
  res.json({ ok: true, seeded: !!counts, counts });
}));

router.post('/tests/run', api(async (req, res) => {
  const port = req.app.get('port');
  const result = await runTests(`http://127.0.0.1:${port}`);
  res.json(result);
}));

// multer-specific errors
router.use((err, req, res, next) => {
  if (err.message === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(400).json({ error: 'Unsupported file type. Upload a .csv, .xlsx or .xls file.' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (10 MB max).' : `Upload error: ${err.code}` });
  }
  next(err);
});

module.exports = router;
