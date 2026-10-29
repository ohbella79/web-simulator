'use strict';

// Business rules for risk analytics, follow-up prioritization and scenario
// comparison. Every rule is intentionally transparent and surfaced in the UI.

const { db } = require('./db');
const { todayStr, daysBetween, OPEN_STATUSES } = require('./lib/constants');

const OPEN_SQL = `b.status IN ('pending','accepted','in_preparation')`;

// ---------- KPIs + dashboard charts ----------
function getDashboard() {
  const today = todayStr();
  const k = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM subcontractors) AS totalSubs,
      (SELECT COUNT(*) FROM subcontractors WHERE status = 'active') AS activeSubs,
      COUNT(*) AS invitations,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined,
      SUM(CASE WHEN status = 'in_preparation' THEN 1 ELSE 0 END) AS inPrep,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN ${OPEN_SQL} AND due_date < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN ${OPEN_SQL} AND due_date >= ? AND due_date <= date(?, '+3 day') THEN 1 ELSE 0 END) AS dueSoon,
      SUM(CASE WHEN status = 'submitted' THEN COALESCE(amount, 0) ELSE 0 END) AS submittedValue
    FROM bids b`).get(today, today, today);

  const responded = (k.accepted || 0) + (k.declined || 0);

  const byTrade = db.prepare(`
    SELECT s.trade AS trade, COUNT(*) AS total,
      SUM(CASE WHEN b.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN b.status = 'in_preparation' THEN 1 ELSE 0 END) AS inPrep,
      SUM(CASE WHEN b.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN b.status = 'declined' THEN 1 ELSE 0 END) AS declined,
      SUM(CASE WHEN b.status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN ${OPEN_SQL.replace(/b\./g, 'b.')} AND b.due_date < ? THEN 1 ELSE 0 END) AS overdue
    FROM bids b JOIN subcontractors s ON s.id = b.subcontractor_id
    GROUP BY s.trade ORDER BY total DESC LIMIT 8`).all(today);

  // Due-date aging buckets for open bids
  const openBids = db.prepare(`SELECT due_date FROM bids b WHERE ${OPEN_SQL}`).all();
  const buckets = { 'Overdue': 0, '1-3 days': 0, '4-7 days': 0, '8-14 days': 0, '15+ days': 0 };
  for (const b of openBids) {
    const left = daysBetween(today, b.due_date);
    if (left == null) continue;
    if (left < 0) buckets['Overdue']++;
    else if (left <= 3) buckets['1-3 days']++;
    else if (left <= 7) buckets['4-7 days']++;
    else if (left <= 14) buckets['8-14 days']++;
    else buckets['15+ days']++;
  }

  // Submission trend, last 8 weeks (weekly buckets, Monday start)
  const rows = db.prepare(`
    SELECT submitted_date AS d, COUNT(*) AS c, SUM(COALESCE(amount, 0)) AS v
    FROM bids WHERE status = 'submitted' AND submitted_date >= date(?, '-55 day')
    GROUP BY submitted_date ORDER BY d`).all(today);
  const monday = (ds) => {
    const d = new Date(ds + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  };
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const ws = monday(addDays(today, -7 * i));
    weeks.push({ week: ws, label: ws.slice(5).replace('-', '/'), count: 0, value: 0 });
  }
  for (const r of rows) {
    const ws = monday(r.d);
    const w = weeks.find((x) => x.week === ws);
    if (w) { w.count += r.c; w.value += r.v; }
  }

  const overdueTop = db.prepare(`
    SELECT b.id, b.due_date, p.name AS project_name, s.company_name, s.trade,
      CAST(julianday(?) - julianday(b.due_date) AS INTEGER) AS days_overdue
    FROM bids b JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id
    WHERE ${OPEN_SQL} AND b.due_date < ?
    ORDER BY days_overdue DESC LIMIT 6`).all(today, today);

  const activity = getActivity(10);

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      totalSubcontractors: k.totalSubs,
      activeSubcontractors: k.activeSubs,
      invitationsSent: k.invitations,
      pendingResponse: k.pending || 0,
      accepted: k.accepted || 0,
      declined: k.declined || 0,
      inPreparation: k.inPrep || 0,
      submitted: k.submitted || 0,
      overdue: k.overdue || 0,
      dueSoon: k.dueSoon || 0,
      submittedValue: k.submittedValue || 0,
      responseRate: k.invitations ? Math.round((responded / k.invitations) * 100) : 0
    },
    charts: { byTrade, dueBuckets: buckets, submissionTrend: weeks },
    overdueTop,
    activity
  };
}

function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- Activity / audit feed ----------
function getActivity(limit = 12) {
  const rows = db.prepare('SELECT * FROM status_history ORDER BY id DESC LIMIT ?').all(limit);
  const bidInfo = db.prepare(`
    SELECT b.id, p.name AS project_name, s.company_name FROM bids b
    JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id
    WHERE b.id = ?`);
  const projName = db.prepare('SELECT name FROM projects WHERE id = ?');
  const subName = db.prepare('SELECT company_name FROM subcontractors WHERE id = ?');
  return rows.map((h) => {
    let label = '';
    if (h.entity_type === 'bid') {
      const b = bidInfo.get(h.entity_id);
      label = b ? `${b.company_name} — ${b.project_name}` : `Bid #${h.entity_id}`;
    } else if (h.entity_type === 'project') {
      const p = projName.get(h.entity_id);
      label = p ? p.name : `Project #${h.entity_id}`;
    } else if (h.entity_type === 'followup') {
      const b = bidInfo.get(h.entity_id);
      label = b ? `Follow-up: ${b.company_name} — ${b.project_name}` : 'Follow-up';
    } else {
      const s = subName.get(h.entity_id);
      label = s ? s.company_name : `Subcontractor #${h.entity_id}`;
    }
    return { ...h, entity_label: label };
  });
}

// ---------- Risk analytics ----------
function getRisk() {
  const today = todayStr();
  const base = `
    SELECT b.id, b.status, b.due_date, b.invited_date, b.amount,
      p.id AS project_id, p.name AS project_name, p.priority,
      s.id AS sub_id, s.company_name, s.trade, s.rating, s.contact_name, s.email, s.phone,
      CAST(julianday(?) - julianday(b.due_date) AS INTEGER) AS days_overdue,
      CAST(julianday(?) - julianday(b.invited_date) AS INTEGER) AS days_since_invited
    FROM bids b JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id`;

  const overdue = db.prepare(`${base}
    WHERE ${OPEN_SQL} AND b.due_date < ? ORDER BY days_overdue DESC`).all(today, today, today);
  const dueSoon = db.prepare(`${base}
    WHERE ${OPEN_SQL} AND b.due_date >= ? AND b.due_date <= date(?, '+3 day')
    ORDER BY b.due_date`).all(today, today, today, today);
  const unanswered = db.prepare(`${base}
    WHERE b.status = 'pending' AND CAST(julianday(?) - julianday(b.invited_date) AS INTEGER) >= 7
    ORDER BY days_since_invited DESC`).all(today, today, today);

  const chronic = db.prepare(`
    SELECT s.id AS sub_id, s.company_name, s.trade, s.rating,
      SUM(CASE WHEN b.status = 'declined' THEN 1 ELSE 0 END) AS declines,
      SUM(CASE WHEN b.status = 'submitted' THEN 1 ELSE 0 END) AS submissions,
      GROUP_CONCAT(p.name) AS projects
    FROM bids b JOIN subcontractors s ON s.id = b.subcontractor_id JOIN projects p ON p.id = b.project_id
    GROUP BY s.id HAVING declines >= 2 ORDER BY declines DESC, s.company_name`).all();

  const aging = { '1-7 days': 0, '8-14 days': 0, '15+ days': 0 };
  for (const b of overdue) {
    if (b.days_overdue <= 7) aging['1-7 days']++;
    else if (b.days_overdue <= 14) aging['8-14 days']++;
    else aging['15+ days']++;
  }

  const byTradeRisk = db.prepare(`
    SELECT s.trade AS trade,
      SUM(CASE WHEN ${OPEN_SQL} THEN 1 ELSE 0 END) AS open_bids,
      SUM(CASE WHEN ${OPEN_SQL} AND b.due_date < ? THEN 1 ELSE 0 END) AS overdue
    FROM bids b JOIN subcontractors s ON s.id = b.subcontractor_id
    GROUP BY s.trade HAVING open_bids > 0 ORDER BY overdue DESC, open_bids DESC`).all(today);

  // Subcontractor-level flags: any active risk driver
  const flagged = db.prepare(`
    SELECT s.id AS sub_id, s.company_name, s.trade, s.rating, s.status,
      SUM(CASE WHEN ${OPEN_SQL} AND b.due_date < ? THEN 1 ELSE 0 END) AS overdue_bids,
      SUM(CASE WHEN b.status = 'pending' AND CAST(julianday(?) - julianday(b.invited_date) AS INTEGER) >= 7 THEN 1 ELSE 0 END) AS unanswered,
      (SELECT COUNT(*) FROM bids b3 WHERE b3.subcontractor_id = s.id AND b3.status = 'declined') AS total_declines,
      (SELECT COUNT(*) FROM bids b4 WHERE b4.subcontractor_id = s.id AND ${OPEN_SQL.replace(/b\./g, 'b4.')}) AS open_bids
    FROM subcontractors s LEFT JOIN bids b ON b.subcontractor_id = s.id
    GROUP BY s.id
    HAVING overdue_bids > 0 OR unanswered > 0 OR (total_declines >= 2 AND open_bids > 0)
    ORDER BY overdue_bids DESC, unanswered DESC`).all(today, today);
  for (const f of flagged) {
    f.reasons = [];
    if (f.overdue_bids > 0) f.reasons.push(`${f.overdue_bids} overdue proposal${f.overdue_bids > 1 ? 's' : ''}`);
    if (f.unanswered > 0) f.reasons.push(`${f.unanswered} invitation${f.unanswered > 1 ? 's' : ''} unanswered 7+ days`);
    if (f.total_declines >= 2 && f.open_bids > 0) f.reasons.push(`${f.total_declines} lifetime declines — re-engagement needed`);
    f.level = f.overdue_bids >= 2 ? 'red' : (f.overdue_bids > 0 || f.unanswered >= 2 ? 'amber' : 'yellow');
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      overdueCount: overdue.length,
      dueSoonCount: dueSoon.length,
      unansweredCount: unanswered.length,
      chronicDecliners: chronic.length,
      flaggedSubs: flagged.length
    },
    overdue, dueSoon, unanswered, chronic, aging, byTradeRisk, flagged
  };
}

// ---------- Follow-up priorities (transparent scoring) ----------
// score = 3 x min(daysOverdue,30)  [+12 due within 3 days]  [+15 unanswered >= 7d]
//       + project priority (high 20 / medium 10 / low 5)  [+ (4-rating)x2 if rating < 4]
//       + 10 if subcontractor has 2+ lifetime declines
function getPriorities() {
  const today = todayStr();
  const rows = db.prepare(`
    SELECT b.id, b.status, b.due_date, b.invited_date,
      p.name AS project_name, p.priority,
      s.id AS sub_id, s.company_name, s.trade, s.rating, s.contact_name, s.email, s.phone,
      CAST(julianday(?) - julianday(b.due_date) AS INTEGER) AS days_overdue,
      CAST(julianday(?) - julianday(b.invited_date) AS INTEGER) AS days_since_invited,
      (SELECT COUNT(*) FROM bids b2 WHERE b2.subcontractor_id = s.id AND b2.status = 'declined') AS lifetime_declines
    FROM bids b JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id
    WHERE ${OPEN_SQL}`).all(today, today);

  const items = rows.map((r) => {
    let score = 0;
    const breakdown = [];
    let action = 'Monitor — no action needed yet.';

    if (r.days_overdue > 0) {
      const pts = 3 * Math.min(r.days_overdue, 30);
      score += pts;
      breakdown.push({ label: `Proposal ${r.days_overdue} day${r.days_overdue === 1 ? '' : 's'} overdue`, points: pts });
      action = r.status === 'pending'
        ? 'Call the subcontractor — the invitation appears to have been missed. Re-confirm intent to bid or source an alternate.'
        : 'Request an updated proposal schedule; offer a deadline extension or confirm withdrawal.';
    } else if (r.days_overdue <= 0 && daysBetween(today, r.due_date) <= 3) {
      score += 12;
      breakdown.push({ label: 'Due within 3 days, not yet submitted', points: 12 });
      action = 'Confirm the proposal will be submitted on time; ask for the bid form today.';
    }
    if (r.status === 'pending' && r.days_since_invited >= 7) {
      score += 15;
      breakdown.push({ label: `Invitation unanswered for ${r.days_since_invited} days`, points: 15 });
      if (r.days_overdue <= 0 && daysBetween(today, r.due_date) > 3) {
        action = 'Follow up on the invitation — no response received. Verify the subcontractor received the bid package.';
      }
    }
    const pp = r.priority === 'high' ? 20 : r.priority === 'medium' ? 10 : 5;
    score += pp;
    breakdown.push({ label: `Project priority: ${r.priority}`, points: pp });
    if (r.rating < 4) {
      const pts = (4 - r.rating) * 2;
      score += pts;
      breakdown.push({ label: `Subcontractor performance rating ${r.rating}/5`, points: pts });
    }
    if (r.lifetime_declines >= 2) {
      score += 10;
      breakdown.push({ label: `${r.lifetime_declines} lifetime declines on record`, points: 10 });
      action = 'Consider alternates for this package; re-engage the subcontractor before relying on it.';
    }

    const severity = score >= 60 ? 'critical' : score >= 35 ? 'high' : score >= 15 ? 'medium' : 'watch';
    return {
      bid_id: r.id, project_name: r.project_name, priority: r.priority,
      sub_id: r.sub_id, company_name: r.company_name, trade: r.trade,
      rating: r.rating, contact_name: r.contact_name, email: r.email, phone: r.phone,
      status: r.status, due_date: r.due_date,
      days_overdue: Math.max(r.days_overdue, 0),
      score, severity, breakdown, suggested_action: action
    };
  });

  items.sort((a, b) => b.score - a.score);
  const ruleDocs = [
    'Overdue proposals: +3 points per day overdue (capped at 30 days, max +90).',
    'Due within 3 days and not submitted: +12 points.',
    'Invitation unanswered 7 or more days: +15 points.',
    'Project priority: high +20 / medium +10 / low +5.',
    'Subcontractor rated below 4/5: +2 points per missing rating step.',
    'Subcontractor with 2+ lifetime declines: +10 points.',
    'Severity bands: 60+ critical, 35-59 high, 15-34 medium, under 15 watch.'
  ];
  return { generatedAt: new Date().toISOString(), items, rules: ruleDocs };
}

// ---------- Historical trade rates (used by scenario comparison) ----------
function tradeRates() {
  const rows = db.prepare(`
    SELECT s.trade AS trade, COUNT(*) AS invited,
      SUM(CASE WHEN b.status != 'pending' THEN 1 ELSE 0 END) AS responded,
      SUM(CASE WHEN b.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN b.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN b.status = 'submitted' AND b.submitted_date <= b.due_date THEN 1 ELSE 0 END) AS onTime
    FROM bids b JOIN subcontractors s ON s.id = b.subcontractor_id
    GROUP BY s.trade`).all();
  const gcInvited = rows.reduce((a, r) => a + r.invited, 0);
  const gcResponded = rows.reduce((a, r) => a + r.responded, 0);
  const gcAccepted = rows.reduce((a, r) => a + r.accepted, 0);
  const gcSubmitted = rows.reduce((a, r) => a + r.submitted, 0);
  const gcOnTime = rows.reduce((a, r) => a + r.onTime, 0);
  const gc = {
    invited: gcInvited,
    acceptanceRate: gcResponded ? gcAccepted / gcResponded : 0.7,
    submissionRate: gcAccepted ? gcSubmitted / gcAccepted : 0.75,
    onTimeRate: gcSubmitted ? gcOnTime / gcSubmitted : 0.8
  };
  const map = {};
  for (const r of rows) {
    map[r.trade] = {
      invited: r.invited,
      acceptanceRate: r.responded ? r.accepted / r.responded : gc.acceptanceRate,
      submissionRate: r.accepted ? r.submitted / r.accepted : gc.submissionRate,
      onTimeRate: r.submitted ? r.onTime / r.submitted : gc.onTimeRate,
      sample: r.invited >= 3
    };
  }
  return { byTrade: map, gcWide: gc };
}

// ---------- Scenario comparison (transparent assumptions) ----------
// Classification of each open bid:
//   overdue          -> projected miss (unless the extension covers the overrun)
//   due in <= 5 days -> at risk
//   otherwise        -> projected on time, weighted by the trade on-time rate
// Adding invites: for each package with no submitted proposal, K eligible
// subcontractors are assumed invited; expected new submissions =
// K x trade acceptance rate x trade submission rate.
function getScenarios({ extendDays = 0, addPerPackage = 0 }) {
  const today = todayStr();
  const rates = tradeRates();
  const rateFor = (trade) => {
    const r = rates.byTrade[trade];
    return r && r.sample ? r : rates.gcWide;
  };

  const securedPackages = new Set(
    db.prepare(`SELECT project_id || '|' || (SELECT trade FROM subcontractors WHERE id = subcontractor_id) AS k
                FROM bids WHERE status = 'submitted'`).all().map((r) => r.k)
  );

  const open = db.prepare(`
    SELECT b.id, b.due_date, b.status, p.id AS project_id, p.name AS project_name,
      s.trade, s.company_name, s.rating
    FROM bids b JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id
    WHERE ${OPEN_SQL}`).all();

  const packages = new Map();
  for (const b of open) {
    const key = `${b.project_id}|${b.trade}`;
    if (!packages.has(key)) {
      packages.set(key, {
        key, project_id: b.project_id, project_name: b.project_name, trade: b.trade, bids: []
      });
    }
    packages.get(key).bids.push(b);
  }

  const eligibleSubs = db.prepare(`
    SELECT COUNT(*) AS c FROM subcontractors s
    WHERE s.trade = ? AND s.status = 'active'
      AND s.id NOT IN (SELECT subcontractor_id FROM bids WHERE project_id = ?)`);

  function classify(bid, ext) {
    const overdueDays = daysBetween(bid.due_date, today);
    const r = rateFor(bid.trade);
    if (overdueDays > 0) {
      if (ext >= overdueDays) return { cls: 'recovered', ev: r.onTimeRate * 0.9 };
      return { cls: 'miss', ev: 0 };
    }
    const daysLeft = -overdueDays;
    if (daysLeft <= 5) return { cls: 'atRisk', ev: 0.35 };
    return { cls: 'onTime', ev: r.onTimeRate };
  }

  function buildScenario(label, ext, addK) {
    let projected = securedPackages.size;
    let evOpen = 0;
    let miss = 0, atRisk = 0, recovered = 0, onTime = 0;
    let covered = 0;
    let expectedNewTotal = 0;
    for (const pkg of packages.values()) {
      let pkgExpectedNew = 0;
      for (const b of pkg.bids) {
        const c = classify(b, ext);
        evOpen += c.ev;
        if (c.cls === 'miss') miss++;
        else if (c.cls === 'atRisk') atRisk++;
        else if (c.cls === 'recovered') recovered++;
        else onTime++;
      }
      if (addK > 0 && !securedPackages.has(pkg.key)) {
        const eligible = eligibleSubs.get(pkg.trade, pkg.project_id).c;
        const pool = Math.min(addK, eligible);
        const r = rateFor(pkg.trade);
        pkgExpectedNew = pool * r.acceptanceRate * r.submissionRate;
        expectedNewTotal += pkgExpectedNew;
      }
      if (securedPackages.has(pkg.key) || pkgExpectedNew >= 0.6) covered++;
    }
    const packagesTotal = packages.size;
    return {
      key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      label, extendDays: ext, addPerPackage: addK,
      securedSubmissions: securedPackages.size,
      projectedSubmissions: Math.round((securedPackages.size + evOpen + expectedNewTotal) * 10) / 10,
      packagesTotal,
      packagesCovered: covered,
      packagesAtRisk: packagesTotal - covered,
      riskIndex: Math.round((miss + atRisk * 0.5 + recovered * 0.25) * 10) / 10,
      detail: { projectedOnTime: onTime, atRisk, recovered, projectedMiss: miss, expectedNewInvites: Math.round(expectedNewTotal * 10) / 10 }
    };
  }

  const scenarios = [
    buildScenario('Current plan (no change)', 0, 0),
    buildScenario(`Extend deadlines by ${extendDays} day${extendDays === 1 ? '' : 's'}`, extendDays, 0),
    buildScenario(`Invite ${addPerPackage} additional sub${addPerPackage === 1 ? '' : 's'} per open package`, 0, addPerPackage),
    buildScenario(`Combined: extend ${extendDays} days + ${addPerPackage} extra invite${addPerPackage === 1 ? '' : 's'}`, extendDays, addPerPackage)
  ];

  const ruleDocs = [
    'Open bids already submitted count as secured (one per project + trade package).',
    'Overdue open bids are projected misses unless the deadline extension covers the full overrun; recovered bids are weighted at 90% of the trade on-time rate.',
    'Open bids due within 5 days are "at risk" and weighted at 35% expected value.',
    'Open bids due in more than 5 days are weighted at the trade on-time rate (trades with fewer than 3 historical bids use the company-wide rate).',
    'Extra invitations target packages with no submitted proposal; expected new submissions = invites x trade acceptance rate x trade submission rate.',
    'A package counts as covered when it has a submitted proposal or an expected 0.6+ submissions from new invites.'
  ];

  return {
    generatedAt: new Date().toISOString(),
    scenarios,
    assumptions: {
      rates: Object.entries(rates.byTrade).map(([trade, r]) => ({
        trade,
        invited: r.invited,
        sampleBasedOnHistory: r.sample,
        acceptanceRate: Math.round(r.acceptanceRate * 100),
        submissionRate: Math.round(r.submissionRate * 100),
        onTimeRate: Math.round(r.onTimeRate * 100)
      })),
      gcWide: {
        acceptanceRate: Math.round(rates.gcWide.acceptanceRate * 100),
        submissionRate: Math.round(rates.gcWide.submissionRate * 100),
        onTimeRate: Math.round(rates.gcWide.onTimeRate * 100)
      },
      rules: ruleDocs
    }
  };
}

// ---------- Bid analytics (visualization page) ----------
function getBidAnalytics() {
  const rows = db.prepare(`
    SELECT b.*, p.name AS project_name, p.priority AS project_priority,
      s.company_name, s.trade
    FROM bids b JOIN projects p ON p.id = b.project_id JOIN subcontractors s ON s.id = b.subcontractor_id`).all();

  const sum = (arr, f) => arr.reduce((a, r) => a + (f(r) || 0), 0);
  const funnel = {
    invited: rows.length,
    responded: rows.filter((r) => r.status !== 'pending').length,
    accepted: rows.filter((r) => ['accepted', 'in_preparation', 'submitted'].includes(r.status)).length,
    submitted: rows.filter((r) => r.status === 'submitted').length
  };

  const submitted = rows.filter((r) => r.status === 'submitted');
  const valueByProject = [];
  for (const r of submitted) {
    let e = valueByProject.find((x) => x.project === r.project_name);
    if (!e) { e = { project: r.project_name, count: 0, value: 0 }; valueByProject.push(e); }
    e.count++; e.value += r.amount || 0;
  }
  valueByProject.sort((a, b) => b.value - a.value);

  const avgByTrade = [];
  for (const r of submitted) {
    let e = avgByTrade.find((x) => x.trade === r.trade);
    if (!e) { e = { trade: r.trade, count: 0, total: 0, min: Infinity, max: 0 }; avgByTrade.push(e); }
    e.count++; e.total += r.amount || 0;
    e.min = Math.min(e.min, r.amount || 0); e.max = Math.max(e.max, r.amount || 0);
  }
  avgByTrade.forEach((e) => { e.avg = Math.round(e.total / e.count); delete e.total; });
  avgByTrade.sort((a, b) => b.avg - a.avg);

  const declines = rows.filter((r) => r.status === 'declined');
  const declineReasons = [];
  for (const r of declines) {
    const key = r.decline_reason || 'No reason recorded';
    let e = declineReasons.find((x) => x.reason === key);
    if (!e) { e = { reason: key, count: 0 }; declineReasons.push(e); }
    e.count++;
  }
  declineReasons.sort((a, b) => b.count - a.count);

  const respDays = rows.filter((r) => r.responded_date)
    .map((r) => daysBetween(r.invited_date, r.responded_date)).filter((d) => d != null && d >= 0);
  const buckets = { '1-3 days': 0, '4-7 days': 0, '8-14 days': 0, '15+ days': 0 };
  for (const d of respDays) {
    if (d <= 3) buckets['1-3 days']++;
    else if (d <= 7) buckets['4-7 days']++;
    else if (d <= 14) buckets['8-14 days']++;
    else buckets['15+ days']++;
  }
  const sorted = [...respDays].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  const onTime = submitted.filter((r) => r.submitted_date <= r.due_date).length;
  const late = submitted.length - onTime;

  const topSubs = [];
  for (const r of rows) {
    let e = topSubs.find((x) => x.company_name === r.company_name);
    if (!e) { e = { company_name: r.company_name, trade: r.trade, bids: 0, submitted: 0, value: 0 }; topSubs.push(e); }
    e.bids++;
    if (r.status === 'submitted') { e.submitted++; e.value += r.amount || 0; }
  }
  topSubs.sort((a, b) => b.value - a.value);

  return {
    generatedAt: new Date().toISOString(),
    sampleData: true,
    kpis: {
      totalSubmittedValue: sum(submitted, (r) => r.amount),
      avgSubmittedAmount: submitted.length ? Math.round(sum(submitted, (r) => r.amount) / submitted.length) : 0,
      medianResponseDays: median,
      onTimeRate: submitted.length ? Math.round((onTime / submitted.length) * 100) : 0,
      participationRate: rows.length ? Math.round((funnel.responded / rows.length) * 100) : 0
    },
    funnel, valueByProject, avgByTrade, declineReasons,
    responseBuckets: buckets, onTime, late, topSubs: topSubs.slice(0, 10),
    submittedCount: submitted.length
  };
}

module.exports = { getDashboard, getRisk, getPriorities, getScenarios, tradeRates, getActivity, getBidAnalytics };
