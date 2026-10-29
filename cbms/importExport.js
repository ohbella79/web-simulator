'use strict';

const XLSX = require('xlsx');
const { db } = require('./db');
const { todayStr, daysBetween, OPEN_STATUSES, BID_STATUSES } = require('./lib/constants');
const { validateSubcontractor } = require('./validate');
const analytics = require('./analytics');

// ---------- import templates ----------
const TEMPLATES = {
  subcontractors:
    'company_name,trade,contact_name,email,phone,city,state,rating,status,notes\n' +
    'Example Electric LLC,Electrical,Jane Doe,jane@example.com,(555) 010-1000,Austin,Texas,4,active,Optional notes\n',
  bids:
    'project_name,company_name,invited_date,due_date,status,decline_reason,submitted_date,amount,notes\n' +
    'Riverside Medical Center — Phase 2,Example Electric LLC,2026-10-20,2026-11-10,pending,,,,Optional notes\n'
};

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function normalizeKey(k) {
  return String(k).toLowerCase().trim().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function normalizeDate(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return s;
}

function parseWorkbook(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    const err = new Error('Could not parse the file. Upload a valid .csv, .xlsx or .xls file.');
    err.status = 400;
    throw err;
  }
  const sheetName = wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : null;
  if (!ws) {
    const err = new Error('The file does not contain a readable worksheet.');
    err.status = 400;
    throw err;
  }
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return raw.map((row) => {
    const out = {};
    for (const [k, val] of Object.entries(row)) out[normalizeKey(k)] = val;
    return out;
  });
}

// ---------- import: subcontractors ----------
function importSubcontractors(rows) {
  const ins = db.prepare(`INSERT INTO subcontractors
    (company_name, trade, contact_name, email, phone, city, state, rating, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const log = db.prepare(`INSERT INTO status_history (entity_type, entity_id, field, old_value, new_value, note, actor, changed_at)
    VALUES ('subcontractor', ?, 'profile', '', 'created', ?, 'Import (demo)', ?)`);
  let imported = 0;
  const failures = [];
  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const body = {
      company_name: row.company_name, trade: row.trade, contact_name: row.contact_name,
      email: row.email, phone: row.phone, city: row.city, state: row.state,
      rating: row.rating, status: row.status || 'active', notes: row.notes
    };
    const check = validateSubcontractor(body, db);
    if (!check.ok) {
      failures.push({ row: rowNo, company: String(row.company_name || ''), reason: Object.entries(check.errors).map(([, m]) => m).join(' ') });
      return;
    }
    const val = check.value;
    const info = ins.run(val.company_name, val.trade, val.contact_name, val.email, val.phone, val.city, val.state, val.rating, val.status, val.notes);
    log.run(info.lastInsertRowid, `Imported from file (${val.company_name})`, nowSql());
    imported++;
  });
  return { total: rows.length, imported, failed: failures.length, failures };
}

// ---------- import: bids ----------
function importBids(rows) {
  const projects = new Map(db.prepare('SELECT id, name FROM projects').all().map((p) => [p.name.toLowerCase().trim(), p.id]));
  const subs = new Map(db.prepare('SELECT id, company_name FROM subcontractors').all().map((s) => [s.company_name.toLowerCase().trim(), s.id]));
  const ins = db.prepare(`INSERT INTO bids
    (project_id, subcontractor_id, invited_date, status, due_date, original_due_date, responded_date, decline_reason, submitted_date, amount, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const log = db.prepare(`INSERT INTO status_history (entity_type, entity_id, field, old_value, new_value, note, actor, changed_at)
    VALUES ('bid', ?, 'status', '', ?, ?, 'Import (demo)', ?)`);
  const today = todayStr();
  let imported = 0;
  const failures = [];

  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const fail = (reason) => failures.push({ row: rowNo, company: String(row.company_name || ''), reason });
    const projectName = String(row.project_name || '').toLowerCase().trim();
    const subName = String(row.company_name || '').toLowerCase().trim();
    const projectId = projects.get(projectName);
    if (!projectId) return fail(`Project "${row.project_name}" was not found. Use an exact project name from the Bid Register.`);
    const subId = subs.get(subName);
    if (!subId) return fail(`Subcontractor "${row.company_name}" was not found. Import the subcontractor list first.`);
    const due = normalizeDate(row.due_date);
    if (!due) return fail('due_date is required.');
    const status = String(row.status || 'pending').toLowerCase().trim().replace(/\s+/g, '_');
    if (!BID_STATUSES.includes(status)) return fail(`status must be one of: ${BID_STATUSES.join(', ')}.`);
    if (db.prepare('SELECT id FROM bids WHERE project_id = ? AND subcontractor_id = ?').get(projectId, subId)) {
      return fail('A bid for this subcontractor on this project already exists.');
    }
    const invited = normalizeDate(row.invited_date) || today;
    const amountRaw = String(row.amount ?? '').trim();
    let amount = null;
    if (amountRaw) {
      const n = Number(amountRaw.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n) || n < 0) return fail('amount must be a number of 0 or more.');
      amount = n;
    }
    const submitted = normalizeDate(row.submitted_date) || (status === 'submitted' ? today : null);
    const info = ins.run(projectId, subId, invited, status, due, due,
      ['accepted', 'declined'].includes(status) ? (normalizeDate(row.responded_date) || today) : null,
      row.decline_reason || '', submitted, amount, row.notes || '');
    log.run(info.lastInsertRowid, status, `Bid imported (${row.project_name})`, nowSql());
    imported++;
  });
  return { total: rows.length, imported, failed: failures.length, failures };
}

function importFile(type, buffer, filename) {
  const rows = parseWorkbook(buffer);
  if (!rows.length) {
    const err = new Error('The file has no data rows (header only).');
    err.status = 400;
    throw err;
  }
  const result = type === 'bids' ? importBids(rows) : importSubcontractors(rows);
  return { file: filename, entity: type, ...result };
}

// ---------- exports ----------
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildReport(type) {
  const today = todayStr();
  if (type === 'subcontractors') {
    const rows = db.prepare(`
      SELECT s.company_name, s.trade, s.contact_name, s.email, s.phone, s.city, s.state, s.rating, s.status,
        (SELECT COUNT(*) FROM bids b WHERE b.subcontractor_id = s.id) AS total_bids,
        (SELECT COUNT(*) FROM bids b2 WHERE b2.subcontractor_id = s.id AND b2.status IN ('pending','accepted','in_preparation')) AS open_bids,
        (SELECT COUNT(*) FROM bids b3 WHERE b3.subcontractor_id = s.id AND b3.status IN ('pending','accepted','in_preparation') AND b3.due_date < ?) AS overdue_bids,
        s.notes
      FROM subcontractors s ORDER BY s.company_name`).all(today);
    return [{ name: 'Subcontractors', rows }];
  }
  if (type === 'bids') {
    const rows = db.prepare(`
      SELECT p.name AS project_name, p.priority, s.company_name, s.trade, b.status, b.invited_date,
        b.due_date, b.responded_date, b.submitted_date, b.amount, b.decline_reason,
        CASE WHEN b.status IN ('pending','accepted','in_preparation') AND b.due_date < ? THEN CAST(julianday(?) - julianday(b.due_date) AS INTEGER) ELSE 0 END AS days_overdue,
        b.notes
      FROM bids b JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id
      ORDER BY b.due_date, s.company_name`).all(today, today);
    return [{ name: 'Bid register', rows }];
  }
  if (type === 'risk') {
    const risk = analytics.getRisk();
    const rows = [];
    const push = (section, list) => list.forEach((b) => rows.push({
      section, project_name: b.project_name, company_name: b.company_name, trade: b.trade,
      status: b.status, due_date: b.due_date,
      days_overdue: Math.max(b.days_overdue || 0, 0), days_since_invited: b.days_since_invited || '',
      rating: b.rating, contact_name: b.contact_name, email: b.email, phone: b.phone
    }));
    push('Overdue proposal', risk.overdue);
    push('Due within 3 days', risk.dueSoon);
    push('Invitation unanswered 7+ days', risk.unanswered);
    return [{ name: 'Risk items', rows }];
  }
  if (type === 'summary') {
    const d = analytics.getDashboard();
    const k = d.kpis;
    const kpiRows = [
      { metric: 'Report date', value: today },
      { metric: 'Total subcontractors', value: k.totalSubcontractors },
      { metric: 'Invitations sent', value: k.invitationsSent },
      { metric: 'Awaiting response', value: k.pendingResponse },
      { metric: 'Bids accepted', value: k.accepted },
      { metric: 'Bids declined', value: k.declined },
      { metric: 'Proposals in preparation', value: k.inPreparation },
      { metric: 'Proposals submitted', value: k.submitted },
      { metric: 'Overdue bids', value: k.overdue },
      { metric: 'Submitted value (USD)', value: k.submittedValue },
      { metric: 'Invitation response rate (%)', value: k.responseRate }
    ];
    const tradeRows = d.charts.byTrade.map((t) => ({
      trade: t.trade, invitations: t.total, submitted: t.submitted,
      in_preparation: t.inPrep, accepted: t.accepted, declined: t.declined,
      pending: t.pending, overdue: t.overdue
    }));
    return [
      { name: 'Executive summary', rows: kpiRows },
      { name: 'By trade', rows: tradeRows }
    ];
  }
  return null;
}

function exportReport(type, format) {
  const sheets = buildReport(type);
  if (!sheets) return null;
  const stamp = todayStr();
  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    for (const sheet of sheets) {
      const ws = XLSX.utils.json_to_sheet(sheet.rows.length ? sheet.rows : [{}]);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
    }
    const body = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return { body, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${type}-report-${stamp}.xlsx` };
  }
  const lines = [];
  for (const sheet of sheets) {
    const keys = Object.keys(sheet.rows[0] || { info: 'no data' });
    lines.push(`# ${sheet.name}`);
    lines.push(keys.join(','));
    for (const r of sheet.rows) lines.push(keys.map((k) => csvEscape(r[k])).join(','));
    lines.push('');
  }
  return { body: '\uFEFF' + lines.join('\r\n'), contentType: 'text/csv; charset=utf-8', filename: `${type}-report-${stamp}.csv` };
}

module.exports = { importFile, exportReport, TEMPLATES };
