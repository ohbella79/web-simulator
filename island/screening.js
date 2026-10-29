'use strict';

// Explainable village vulnerability screening (Module B2).
// - Min-max normalization across villages with data (0 = lowest concern, 1 = highest).
// - gita2018_min_ratio / flood2025_min_ratio are INVERTED: lower light ratio = deeper disruption.
// - Missing inputs are excluded, never imputed, and reported as data-quality flags.
// - The output is a DECISION-SUPPORT SCREENING INDEX (0-100). It is NOT a validated
//   outage probability and must not be presented as one.

const { db } = require('./db');
const { SCREENING_DIMENSIONS } = require('./lib/constants');

function minmax(values) {
  const vals = values.filter((v) => v != null && Number.isFinite(v));
  if (vals.length < 2) return { min: null, max: null };
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function computeScreening(weights) {
  const w = { ...SCREENING_DIMENSIONS };
  const usedWeights = {};
  for (const key of Object.keys(w)) {
    const x = Number(weights && weights[key]);
    usedWeights[key] = Number.isFinite(x) ? Math.max(0, Math.min(10, x)) : 0;
  }

  const rows = db.prepare(`
    SELECT v.id, v.village_code, v.village_name, v.district_label, v.population, v.lat, v.lon,
      i.gita2018_min_ratio, i.gita2018_rec_days, i.flood2025_min_ratio, i.log_median_hh_income,
      i.share_lt_hs, i.unemp_rate, i.share_65plus, i.dist_power_node_km, i.SIAI, i.EXP_flood,
      i.water_storage_m3, i.water_sources, i.in_analytical_subset, i.data_status, i.vintage_label
    FROM villages v LEFT JOIN village_indicators i ON i.village_id = v.id
    ORDER BY v.village_code`).all();

  // Collect per-variable normalization ranges once (documented min-max method).
  const ranges = {};
  for (const key of Object.keys(w)) {
    for (const varName of w[key].variables) {
      if (!ranges[varName]) ranges[varName] = minmax(rows.map((r) => r[varName]));
    }
  }

  const norm = (varName, value, invert) => {
    if (value == null || !Number.isFinite(value)) return null;
    const r = ranges[varName];
    if (r.min == null || r.max == null || r.max === r.min) return 0;
    let x = (value - r.min) / (r.max - r.min);
    if (invert) x = 1 - x;
    return Math.max(0, Math.min(1, x));
  };

  const results = rows.map((r) => {
    const dims = {};
    let weightedSum = 0;
    let weightTotal = 0;
    const missing = [];

    for (const [key, def] of Object.entries(w)) {
      let value = null;
      let detail = '';
      if (key === 'disruption') {
        const g = norm('gita2018_min_ratio', r.gita2018_min_ratio, true);
        const f = norm('flood2025_min_ratio', r.flood2025_min_ratio, true);
        const parts = [g, f].filter((x) => x != null);
        if (parts.length) { value = parts.reduce((a, b) => a + b, 0) / parts.length; detail = 'mean of available event drops'; }
      } else if (key === 'recovery') {
        if (r.in_analytical_subset) {
          value = norm('gita2018_rec_days', r.gita2018_rec_days, false);
          detail = 'quality-screened subset only';
        } else {
          detail = 'outside the quality-screened subset - recovery days not used';
        }
      } else if (key === 'social') {
        if (r.SIAI != null && Number.isFinite(r.SIAI)) {
          value = norm('SIAI', r.SIAI, false);
          detail = 'provided SIAI index';
        } else {
          const comps = [
            norm('log_median_hh_income', r.log_median_hh_income, true),
            norm('share_lt_hs', r.share_lt_hs, false),
            norm('unemp_rate', r.unemp_rate, false),
            norm('share_65plus', r.share_65plus, false)
          ].filter((x) => x != null);
          if (comps.length) { value = comps.reduce((a, b) => a + b, 0) / comps.length; detail = 'documented composite (income, education, unemployment, 65+)'; }
        }
      } else if (key === 'access') {
        value = norm('dist_power_node_km', r.dist_power_node_km, false);
        detail = 'distance to power node';
      } else if (key === 'exposure') {
        const e = norm('EXP_flood', r.EXP_flood, false);
        const f = norm('flood2025_min_ratio', r.flood2025_min_ratio, true);
        const parts = [e, f].filter((x) => x != null);
        if (parts.length) { value = parts.reduce((a, b) => a + b, 0) / parts.length; detail = 'flood exposure + 2025 flood-window drop'; }
      } else if (key === 'water') {
        const perCapita = (r.water_storage_m3 != null && r.population > 0) ? r.water_storage_m3 / r.population : null;
        const pc = perCapita != null ? Math.max(0, Math.min(1, 1 - Math.min(perCapita / 1.2, 1))) : null; // <=1.2 m3/person benchmark
        const src = r.water_sources != null ? Math.max(0, Math.min(1, 1 - (r.water_sources - 1) / 3)) : null;
        const parts = [pc, src].filter((x) => x != null);
        if (parts.length) { value = parts.reduce((a, b) => a + b, 0) / parts.length; detail = 'per-capita storage (1.2 m3 benchmark) + source count'; }
        if (parts.length === 0) detail = 'no verified water data';
      }

      const weight = usedWeights[key];
      if (value == null) {
        if (r.gita2018_min_ratio == null && def.variables.includes('gita2018_min_ratio')) missing.push(def.variables.join(', '));
        if (key === 'recovery' && !r.in_analytical_subset) missing.push('gita2018_rec_days (subset)');
        if (key === 'social' && r.SIAI == null && r.log_median_hh_income == null) missing.push('social variables');
        if (key === 'access' && r.dist_power_node_km == null) missing.push('dist_power_node_km');
        if (key === 'exposure' && r.EXP_flood == null && r.flood2025_min_ratio == null) missing.push('exposure variables');
        if (key === 'water' && r.water_storage_m3 == null && r.water_sources == null) missing.push('water variables');
        dims[key] = { label: def.label, value: null, normalized: null, weight, missing: true, detail };
      } else {
        weightedSum += value * weight;
        weightTotal += weight;
        dims[key] = { label: def.label, value: null, normalized: Math.round(value * 1000) / 1000, weight, missing: false, detail };
      }
    }

    const score = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 1000) / 10 : null;
    const band = score == null ? 'insufficient data' : score >= 65 ? 'high concern' : score >= 45 ? 'elevated' : score >= 25 ? 'moderate' : 'lower';
    const subsetWarn = !r.in_analytical_subset
      ? 'Outside the 41-village quality-screened subset: recovery-duration dimension not evaluated; other values carry lower confidence.'
      : null;
    return {
      village_id: r.id, village_code: r.village_code, village_name: r.village_name,
      district_label: r.district_label, population: r.population,
      score, band, dims,
      data_quality: {
        data_status: r.data_status,
        vintage_label: r.vintage_label,
        in_analytical_subset: !!r.in_analytical_subset,
        missing_inputs: missing,
        warnings: [
          score == null ? 'No dimensions could be computed with the current weights - all weighted inputs are missing.' : null,
          subsetWarn,
          'Screening index is a relative ranking for decision support, not a validated outage probability.'
        ].filter(Boolean)
      }
    };
  });

  // per-capita normalization range for transparency
  const pcValues = rows
    .filter((r) => r.water_storage_m3 != null && r.population > 0)
    .map((r) => r.water_storage_m3 / r.population);

  results.sort((a, b) => (b.score == null ? -1 : a.score == null ? 1 : b.score - a.score));
  const scored = results.filter((r) => r.score != null);

  return {
    generatedAt: new Date().toISOString(),
    method: {
      name: 'Explainable weighted min-max screening index',
      normalization: 'Each variable is min-max normalized across villages with data to 0-1 (1 = highest concern). Light ratios are inverted (lower ratio = deeper disruption). Missing values are excluded and flagged; nothing is imputed.',
      waterBenchmark: 'Water dimension: per-capita storage <= 1.2 m3/person scores highest; observed demo range ' +
        (pcValues.length ? Math.round(Math.min(...pcValues) * 100) / 100 + '-' + Math.round(Math.max(...pcValues) * 100) / 100 + ' m3/person' : 'n/a') + '.',
      subset: 'gita2018_rec_days is used only for the quality-screened 41-village analytical subset.',
      disclaimer: 'This index is a decision-support screening measure for prioritizing field verification. It is not a validated outage probability, not a causal benefit estimate, and not a measure of actual resilience benefit.'
    },
    weightsUsed: usedWeights,
    results,
    distribution: {
      high: scored.filter((r) => r.score >= 65).length,
      elevated: scored.filter((r) => r.score >= 45 && r.score < 65).length,
      moderate: scored.filter((r) => r.score >= 25 && r.score < 45).length,
      lower: scored.filter((r) => r.score < 25).length,
      insufficient: results.filter((r) => r.score == null).length
    }
  };
}

module.exports = { computeScreening };
