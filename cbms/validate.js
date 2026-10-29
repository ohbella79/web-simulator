'use strict';

const {
  TRADES, BID_STATUSES, SUB_STATUSES, PROJECT_PRIORITIES, PROJECT_STATUSES,
  STATUS_TRANSITIONS, todayStr, isValidDate
} = require('./lib/constants');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// ---------- Subcontractor ----------
function validateSubcontractor(body, db, existingId) {
  const errors = {};
  const out = {};

  const name = str(body.company_name);
  if (!name) errors.company_name = 'Company name is required.';
  else if (name.length > 120) errors.company_name = 'Company name must be 120 characters or fewer.';
  else if (db) {
    const dup = db.prepare(
      'SELECT id FROM subcontractors WHERE lower(company_name) = lower(?) AND id != ?'
    ).get(name, existingId || -1);
    if (dup) errors.company_name = 'A subcontractor with this name already exists.';
  }
  out.company_name = name;

  const trade = str(body.trade);
  if (!trade) errors.trade = 'Trade is required.';
  else if (!TRADES.includes(trade)) errors.trade = 'Choose a trade from the list.';
  out.trade = trade;

  const contact = str(body.contact_name);
  if (contact.length > 100) errors.contact_name = 'Contact name must be 100 characters or fewer.';
  out.contact_name = contact;

  const email = str(body.email);
  if (email && !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address (e.g. name@company.com).';
  else if (email.length > 160) errors.email = 'Email must be 160 characters or fewer.';
  out.email = email;

  const phone = str(body.phone);
  if (phone && !/^[\d\s()+.\-]{7,40}$/.test(phone)) errors.phone = 'Enter a valid phone number (7-15 digits).';
  out.phone = phone;

  out.city = str(body.city).slice(0, 80);
  const state = str(body.state);
  if (state.length > 40) errors.state = 'State must be 40 characters or fewer.';
  out.state = state;

  const rating = body.rating === '' || body.rating == null ? 3 : Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = 'Rating must be a whole number from 1 to 5.';
  out.rating = rating;

  const status = str(body.status) || 'active';
  if (!SUB_STATUSES.includes(status)) errors.status = 'Status must be active or inactive.';
  out.status = status;

  out.notes = str(body.notes).slice(0, 1000);

  return { ok: Object.keys(errors).length === 0, errors, value: out };
}

// ---------- Project ----------
function validateProject(body, db, existingId) {
  const errors = {};
  const out = {};

  const name = str(body.name);
  if (!name) errors.name = 'Project name is required.';
  else if (name.length > 140) errors.name = 'Project name must be 140 characters or fewer.';
  else if (db) {
    const dup = db.prepare('SELECT id FROM projects WHERE lower(name) = lower(?) AND id != ?').get(name, existingId || -1);
    if (dup) errors.name = 'A project with this name already exists.';
  }
  out.name = name;

  out.location = str(body.location).slice(0, 120);

  const priority = str(body.priority) || 'medium';
  if (!PROJECT_PRIORITIES.includes(priority)) errors.priority = 'Priority must be high, medium or low.';
  out.priority = priority;

  const due = str(body.due_date);
  if (!due) errors.due_date = 'Bid due date is required.';
  else if (!isValidDate(due)) errors.due_date = 'Use the format YYYY-MM-DD.';
  out.due_date = due;

  const status = str(body.status) || 'bidding';
  if (!PROJECT_STATUSES.includes(status)) errors.status = 'Status must be bidding or closed.';
  out.status = status;

  out.description = str(body.description).slice(0, 1000);

  return { ok: Object.keys(errors).length === 0, errors, value: out };
}

// ---------- New bid (invitation) ----------
function validateBidNew(body, db) {
  const errors = {};
  const out = {};

  const projectId = Number(body.project_id);
  if (!Number.isInteger(projectId) || !db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
    errors.project_id = 'Choose a valid project.';
  }
  out.project_id = projectId;

  const subId = Number(body.subcontractor_id);
  if (!Number.isInteger(subId) || !db.prepare('SELECT id FROM subcontractors WHERE id = ?').get(subId)) {
    errors.subcontractor_id = 'Choose a valid subcontractor.';
  }
  out.subcontractor_id = subId;

  const invited = str(body.invited_date) || todayStr();
  if (!isValidDate(invited)) errors.invited_date = 'Use the format YYYY-MM-DD.';
  out.invited_date = invited;

  out.due_date = null; // resolved by the route against the project deadline
  const due = str(body.due_date);
  if (due) {
    if (!isValidDate(due)) errors.due_date = 'Use the format YYYY-MM-DD.';
    else out.due_date = due;
  }

  out.notes = str(body.notes).slice(0, 1000);

  if (!errors.project_id && !errors.subcontractor_id) {
    const dup = db.prepare(
      'SELECT id FROM bids WHERE project_id = ? AND subcontractor_id = ?'
    ).get(projectId, subId);
    if (dup) errors.subcontractor_id = 'This subcontractor already has a bid record on this project.';
  }

  return { ok: Object.keys(errors).length === 0, errors, value: out };
}

// ---------- Status change ----------
function validateStatusChange(bid, body) {
  const errors = {};
  const out = {};

  const to = str(body.to_status);
  if (!to) errors.to_status = 'Choose the new status.';
  else if (!BID_STATUSES.includes(to)) errors.to_status = 'Unknown status.';
  else if (to === bid.status) errors.to_status = `This bid is already "${to}".`;
  else if (!(STATUS_TRANSITIONS[bid.status] || []).includes(to)) {
    errors.to_status = `Transition "${bid.status}" to "${to}" is not allowed. Allowed next steps: ${(STATUS_TRANSITIONS[bid.status] || []).join(', ') || 'none'}.`;
  }
  out.to_status = to;

  const note = str(body.note).slice(0, 500);
  out.note = note;

  if (!errors.to_status) {
    if (to === 'submitted') {
      const sd = str(body.submitted_date) || todayStr();
      if (!isValidDate(sd)) errors.submitted_date = 'Use the format YYYY-MM-DD.';
      out.submitted_date = sd;
      const amount = numOrNull(body.amount);
      if (amount === null) out.amount = null;
      else if (Number.isNaN(amount) || amount < 0) errors.amount = 'Amount must be a number of 0 or more.';
      else out.amount = Math.round(amount * 100) / 100;
      const dd = str(body.due_date);
      if (dd && !isValidDate(dd)) errors.due_date = 'Use the format YYYY-MM-DD.';
    } else {
      const rd = str(body.responded_date) || todayStr();
      if (!isValidDate(rd)) errors.responded_date = 'Use the format YYYY-MM-DD.';
      out.responded_date = rd;
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, value: out };
}

// ---------- Deadline extension ----------
function validateExtend(body) {
  const errors = {};
  const due = str(body.due_date);
  if (!due) errors.due_date = 'Choose a new due date.';
  else if (!isValidDate(due)) errors.due_date = 'Use the format YYYY-MM-DD.';
  const reason = str(body.reason).slice(0, 300);
  return { ok: Object.keys(errors).length === 0, errors, value: { due_date: due, reason } };
}

// ---------- Project deadline adjustment ----------
function validateDeadlineChange(body) {
  const errors = {};
  const due = str(body.due_date);
  if (!due) errors.due_date = 'Choose a new project bid date.';
  else if (!isValidDate(due)) errors.due_date = 'Use the format YYYY-MM-DD.';
  const cascade = body.cascade === true || body.cascade === 'true' || body.cascade === 'on';
  const reason = str(body.reason).slice(0, 300);
  return { ok: Object.keys(errors).length === 0, errors, value: { due_date: due, cascade, reason } };
}

module.exports = {
  validateSubcontractor,
  validateProject,
  validateBidNew,
  validateStatusChange,
  validateExtend,
  validateDeadlineChange
};
