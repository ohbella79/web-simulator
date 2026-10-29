'use strict';

// Canonical reference lists shared by the server, validation and the seed data.
// All data in this prototype is SYNTHETIC and clearly labeled as such.

const TRADES = [
  'Electrical',
  'HVAC & Mechanical',
  'Plumbing & Fire Protection',
  'Concrete',
  'Structural Steel',
  'Drywall & Framing',
  'Roofing & Waterproofing',
  'Glazing & Storefront',
  'Sitework & Excavation',
  'Masonry',
  'Interior Finishes',
  'Painting & Coatings'
];

const BID_STATUSES = ['pending', 'accepted', 'declined', 'in_preparation', 'submitted'];
const OPEN_STATUSES = ['pending', 'accepted', 'in_preparation'];

// Allowed lifecycle transitions. Anything else is rejected with a 400.
const STATUS_TRANSITIONS = {
  pending: ['accepted', 'declined'],
  accepted: ['in_preparation', 'declined'],
  in_preparation: ['submitted'],
  submitted: [],
  declined: ['accepted'] // re-engagement after a declined invitation
};

const SUB_STATUSES = ['active', 'inactive'];
const PROJECT_PRIORITIES = ['high', 'medium', 'low'];
const PROJECT_STATUSES = ['bidding', 'closed'];

const STATUS_LABELS = {
  pending: 'Invitation pending',
  accepted: 'Accepted',
  declined: 'Declined',
  in_preparation: 'Proposal in preparation',
  submitted: 'Proposal submitted'
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayStr() {
  const d = new Date();
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// Whole days from -> to (positive when to is later than from). Treats both as UTC dates.
function daysBetween(fromDate, toDate) {
  const a = Date.parse(String(fromDate).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(toDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  TRADES,
  BID_STATUSES,
  OPEN_STATUSES,
  STATUS_TRANSITIONS,
  SUB_STATUSES,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  STATUS_LABELS,
  todayStr,
  isValidDate,
  daysBetween,
  addDays
};
