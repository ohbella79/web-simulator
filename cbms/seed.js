'use strict';

// Construction Bid Management System seed — REAL public data edition.
// Projects, locations, letting dates, engineer estimates, bid item details,
// contractor names and bid amounts come from REAL public TxDOT bid tabulation
// records (Texas Open Data Portal). The bid-desk workflow (invitation /
// accepted / declined / in preparation, ratings, follow-ups) is a demo layer
// with clearly labeled synthetic values on top of that real foundation.

const { db } = require('./db');
const { todayStr, addDays } = require('./lib/constants');
const REAL = require('./data-real/txdot.json');

const rnd = (() => { let a = 48271; return () => { a = (a * 48271) % 2147483647; return a / 2147483647; }; })();

const TRADE_MAP = [
  [/EARTHWORK|EXCAV|DRAIN|FENCE|LANDSCAP|SEWER|STORM|RETAIN|GUARD|RAIL|SIDEWALK|CURB|DRIVEWAY|CLEAR|GRAD|WATER LINE|UTIL|PUMP|WELL|SANIT|POND|BOAT|RAMPS|MOW|PAVEMENT MARKER/i, 'Sitework & Excavation'],
  [/CONCRETE|CEMENT|PAVEMENT|ASPHALT|HOT MIX|BITUM|SURFACE TREAT|SEAL COAT/i, 'Concrete'],
  [/STEEL|STRUCT|BRIDGE|SUBSTRUCT|SUPERSTRUCT|GIRD|REINF|BEAM|PEDESTAL/i, 'Structural Steel'],
  [/ELECTRIC|LIGHT|SIGNAL|ITS|CCTV|CAMERA|CONDUIT|TRAFFIC SIGNAL/i, 'Electrical'],
  [/SIGN|MARK|STRIP|PAINT|REFLECT/i, 'Painting & Coatings'],
  [/WALL|ROCK|SOIL|ANCHOR|MASON|STONE/i, 'Masonry'],
  [/FENCE|GATE/i, 'Sitework & Excavation'],
  [/LANDSCAP|PLANT|SOIL|TOPSOIL|SEED|SOD/i, 'Sitework & Excavation'],
  [/PLUMB|HVAC|MECHAN|WATER|SEWER/i, 'Plumbing & Fire Protection'],
  [/DEMO|REMOV|HAUL|MOBIL|BARRICADE|TEMP/i, 'Sitework & Excavation']
];
function tradeFor(specs) {
  const counts = {};
  for (const s of specs || []) {
    if (!s || s === 'OTHER') continue;
    for (const [re, trade] of TRADE_MAP) {
      if (re.test(s)) { counts[trade] = (counts[trade] || 0) + 1; break; }
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'Concrete';
}
function timeOfDay() { return `${String(8 + Math.floor(rnd() * 9)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`; }

function seed() {
  const today = todayStr();
  const insSub = db.prepare(`INSERT INTO subcontractors
    (company_name, trade, contact_name, email, phone, city, state, rating, status, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insProj = db.prepare(`INSERT INTO projects
    (name, location, priority, due_date, original_due_date, status, description, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insBid = db.prepare(`INSERT INTO bids
    (project_id, subcontractor_id, invited_date, status, due_date, original_due_date,
     responded_date, decline_reason, submitted_date, amount, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insHist = db.prepare(`INSERT INTO status_history
    (entity_type, entity_id, field, old_value, new_value, note, actor, changed_at)
    VALUES (?,?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    // ---- subcontractors from REAL TxDOT bidder names ----
    const subIds = {};
    REAL.vendors.forEach((v, i) => {
      const trade = tradeFor(v.top_specs);
      const info = insSub.run(
        v.name, trade, '', '',
        '', '', 'Texas', 3 + (i % 3), 'active',
        `REAL contractor name from TxDOT public bid tabulation records (${v.projects} project${v.projects === 1 ? '' : 's'} in this dataset). Contact details, rating and bid-desk workflow values are synthetic demo data.`,
        addDays(today, -40 - i) + ' 09:00:00');
      subIds[v.name] = info.lastInsertRowid;
    });

    // ---- projects from REAL TxDOT lettings ----
    const projIds = {};
    REAL.projects.forEach((p) => {
      const prio = p.engineer_estimate > 8e6 ? 'high' : p.engineer_estimate > 2e6 ? 'medium' : 'low';
      const desc =
        `${p.classification} · ${p.type}. TxDOT district ${p.district}, ${p.county} County, HWY ${p.highway}` +
        (p.limits && p.limits !== 'nan to nan' ? ` · ${p.limits}` : '') +
        ` · Engineer's estimate $${p.engineer_estimate.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
        (p.work_days ? ` · ${p.work_days} working days` : '') +
        '. Project facts are public TxDOT records; bid-desk workflow on this platform is demo.';
      const info = insProj.run(p.name, `${p.county} County, Texas (TxDOT ${p.district})`, prio,
        p.let_date, p.let_date, 'bidding', desc, addDays(today, -35) + ' 09:00:00');
      projIds[p.project_id] = info.lastInsertRowid;
    });

    // ---- bids: REAL bidders & amounts; demo workflow statuses ----
    const history = [];
    for (const p of REAL.projects) {
      const pid = projIds[p.project_id];
      const isPast = !p.is_future;
      const letDate = p.let_date;
      const pastLet = letDate <= today;
      // demo: low bidder + one other get "submitted" on past lettings; upcoming lettings get open workflow
      p.bidders.forEach((b, k) => {
        const sid = subIds[b.name];
        if (!sid) return;
        let status, dueDate, origDue, invited, responded = null, submitted = null, amount = null, note = '', declineReason = '';
        if (isPast && pastLet) {
          invited = addDays(letDate, -(21 + Math.floor(rnd() * 14)));
          dueDate = letDate; origDue = letDate;
          status = 'submitted';
          submitted = letDate;
          responded = addDays(letDate, -(17 + Math.floor(rnd() * 10)));
          amount = b.total;
          note = `Bid opened at the TxDOT letting (REAL amount). Rank ${k + 1}${b.low ? ' — apparent low bidder' : ''}.`;
        } else if (pastLet) {
          // estimated letting date already passed without an actual letting yet (real record state)
          invited = addDays(letDate, -(24 + Math.floor(rnd() * 10)));
          origDue = letDate; dueDate = letDate;
          status = k === 0 ? 'in_preparation' : 'pending';
          responded = k === 0 ? addDays(letDate, -12) : null;
          note = 'Letting date has passed without an actual letting on record — demo workflow treats this as an open, overdue package.';
        } else {
          invited = addDays(today, -(10 + Math.floor(rnd() * 18)));
          origDue = letDate; dueDate = letDate;
          const r = rnd();
          status = k === 0 ? (r < 0.5 ? 'in_preparation' : 'accepted') : (r < 0.6 ? 'accepted' : r < 0.8 ? 'pending' : 'declined');
          if (status !== 'pending') responded = addDays(invited, 2 + Math.floor(rnd() * 9));
          if (status === 'declined') declineReason = ['Crew committed to another project through Q3', 'Bonding capacity reached for this scope', 'Pricing another GC on this package'][Math.floor(rnd() * 3)];
          note = 'Upcoming TxDOT letting — bid-desk workflow is demo.';
        }
        const info = insBid.run(pid, sid, invited, status, dueDate, origDue, responded, declineReason,
          submitted, amount, note, invited + ' ' + timeOfDay());
        const bidId = info.lastInsertRowid;
        history.push(['bid', bidId, 'status', '', 'pending', `Invitation sent to ${b.name} — ${p.name}`, 'Seed (sample workflow)', invited + ' ' + timeOfDay()]);
        if (responded) {
          history.push(['bid', bidId, 'status', 'pending', status === 'declined' ? 'declined' : 'accepted',
            status === 'declined' ? `Declined: ${declineReason}` : 'Subcontractor accepted the invitation', 'Seed (sample workflow)', responded + ' ' + timeOfDay()]);
        }
        if (status === 'in_preparation') {
          const t = Math.max(Math.min((responded ? new Date(responded).getTime() : Date.now()) - 2 * 86400000, Date.now()), new Date(invited).getTime());
          history.push(['bid', bidId, 'status', 'accepted', 'in_preparation', 'Proposal preparation started', 'Seed (sample workflow)', new Date(t).toISOString().slice(0, 19).replace('T', ' ')]);
        }
        if (status === 'submitted' && submitted) {
          history.push(['bid', bidId, 'status', 'accepted', 'in_preparation', 'Proposal preparation started', 'Seed (sample workflow)', addDays(submitted, -10) + ' ' + timeOfDay()]);
          history.push(['bid', bidId, 'status', 'in_preparation', 'submitted',
            `Proposal submitted — $${Math.round(amount).toLocaleString('en-US')} (TxDOT letting result${b.low ? ', apparent low bidder' : ''})`,
            'Seed (sample workflow)', submitted + ' ' + timeOfDay()]);
        }
      });
    }
    // ---- supplemental demo-workflow packages on recent REAL projects ----
    const recent = REAL.projects
      .filter((p) => !p.is_future && (Date.parse(today) - Date.parse(p.let_date)) / 86400000 <= 90)
      .slice(-6);
    const offsets = [-4, -2, 1, 3, 6, 9, 12];
    let oi = 0;
    for (const p of recent) {
      const candidates = REAL.vendors.filter((v) => !p.bidders.some((b) => b.name === v.name));
      const picks = [candidates[oi % candidates.length], candidates[(oi + 3) % candidates.length], candidates[(oi + 7) % candidates.length]].filter(Boolean);
      oi += 2;
      for (const v of picks) {
        const sid = subIds[v.name];
        if (!sid) continue;
        const dueOff = offsets[oi++ % offsets.length];
        const invited = addDays(today, -(12 + Math.floor(rnd() * 6)));
        const due = addDays(today, dueOff);
        let status, responded = null, declineReason = '';
        if (dueOff < -1) { status = rnd() < 0.5 ? 'in_preparation' : 'pending'; }
        else if (dueOff <= 3) { status = 'accepted'; responded = addDays(invited, 3 + Math.floor(rnd() * 5)); }
        else { status = rnd() < 0.6 ? 'pending' : 'in_preparation'; if (status !== 'pending') responded = addDays(invited, 4 + Math.floor(rnd() * 6)); }
        if (status === 'in_preparation' && !responded) responded = addDays(invited, 3 + Math.floor(rnd() * 6));
        const info = insBid.run(projIds[p.project_id], sid, invited, status, due, due, responded, declineReason,
          null, null, 'Supplemental package invitation — demo workflow layered on a real TxDOT project.', invited + ' ' + timeOfDay());
        const bidId = info.lastInsertRowid;
        history.push(['bid', bidId, 'status', '', 'pending', `Supplemental invitation sent to ${v.name} (demo workflow) — ${p.name}`, 'Seed (sample workflow)', invited + ' ' + timeOfDay()]);
        if (responded) {
          history.push(['bid', bidId, 'status', 'pending', status === 'declined' ? 'declined' : 'accepted',
            status === 'declined' ? 'Declined: ' + declineReason : 'Subcontractor accepted the invitation', 'Seed (sample workflow)', responded + ' ' + timeOfDay()]);
        }
        if (status === 'in_preparation') {
          history.push(['bid', bidId, 'status', 'accepted', 'in_preparation', 'Proposal preparation started', 'Seed (sample workflow)', addDays(responded, 2) + ' ' + timeOfDay()]);
        }
      }
    }

    history.sort((a, b) => (a[7] < b[7] ? -1 : 1));
    history.forEach((h) => insHist.run(...h));
  });

  tx();
  return {
    subcontractors: db.prepare('SELECT COUNT(*) c FROM subcontractors').get().c,
    projects: db.prepare('SELECT COUNT(*) c FROM projects').get().c,
    bids: db.prepare('SELECT COUNT(*) c FROM bids').get().c,
    realDataSource: 'TxDOT Bid Tabulations (Texas Open Data Portal)',
    generatedOn: today
  };
}

function resetSeed() {
  db.exec(`
    DELETE FROM status_history; DELETE FROM bids; DELETE FROM projects; DELETE FROM subcontractors;
    DELETE FROM sqlite_sequence WHERE name IN ('bids','projects','subcontractors','status_history');
  `);
  return seed();
}

function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) c FROM bids').get().c;
  if (n === 0) return seed();
  return null;
}

module.exports = { seed, resetSeed, seedIfEmpty, REAL };
