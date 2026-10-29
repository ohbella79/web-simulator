'use strict';

// Shared reference lists: roles + permission matrix, provenance statuses and the
// configurable data dictionary for village indicators.

const ROLES = ['admin', 'executive', 'engineer', 'planner', 'resident'];

const ROLE_LABELS = {
  admin: 'System Administrator',
  executive: 'EPS Executive',
  engineer: 'EPS Energy & Infrastructure Engineer',
  planner: 'Government / Utility / Emergency Planner',
  resident: 'Community Resident'
};

// Page-level read access. API-level writes are enforced per-route.
const PAGE_ACCESS = {
  command_center: ['admin', 'executive', 'engineer'],
  map: ['admin', 'executive', 'engineer', 'planner'],
  simulator: ['admin', 'executive', 'engineer', 'planner'],
  allocation: ['admin', 'executive', 'engineer', 'planner'],
  planner: ['admin', 'executive', 'engineer'],
  optimizer: ['admin', 'executive', 'engineer'],
  raas: ['admin', 'executive'],
  monitoring: ['admin', 'executive', 'engineer', 'planner'],
  roadmap: ['admin', 'executive', 'engineer', 'planner'],
  governance: ['admin', 'executive', 'engineer'],
  portal: ['admin', 'executive', 'engineer', 'planner', 'resident']
};

// Who may import / edit operational data (investment assumptions: later phases).
const DATA_EDITORS = ['admin', 'engineer'];

// Provenance statuses required on every numerical output (Section 9).
const PROVENANCE = ['observed', 'verified_operational', 'engineering_estimate', 'simulated', 'synthetic'];
const PROVENANCE_LABELS = {
  observed: 'Observed',
  verified_operational: 'Verified operational',
  engineering_estimate: 'Engineering estimate',
  simulated: 'Simulated',
  synthetic: 'Synthetic demonstration'
};

// Configurable data dictionary (Section 4). Units, types and documented ranges.
const DATA_DICTIONARY = {
  village_id: { label: 'Village ID', unit: '-', type: 'id', description: 'Stable unique identifier.' },
  village_name: { label: 'Village name', unit: '-', type: 'text', description: 'Village name.' },
  population: { label: 'Population', unit: 'persons', type: 'number', min: 0, description: 'Resident population.' },
  gita2018_min_ratio: { label: 'TC Gita 2018 minimum light ratio', unit: 'ratio', type: 'number', min: 0, max: 2, description: 'Minimum VIIRS nighttime-light level during 2018 TC Gita relative to pre-cyclone baseline. Lower = deeper disruption. Descriptive screening only - not a validated outage probability.' },
  gita2018_rec_days: { label: 'TC Gita 2018 recovery days', unit: 'days', type: 'number', min: 0, description: 'Days for nighttime lights to return to baseline after TC Gita (quality-screened subset).' },
  flood2025_min_ratio: { label: '2025 flood minimum light ratio', unit: 'ratio', type: 'number', min: 0, max: 2, description: 'Minimum nighttime-light ratio during the 2025 flooding-related observation period.' },
  log_median_hh_income: { label: 'Log median household income', unit: 'log USD', type: 'number', description: 'Natural log of median household income (2020 Census).' },
  share_lt_hs: { label: 'Share less than high school', unit: 'share', type: 'number', min: 0, max: 1, description: 'Share of adults without high school completion.' },
  unemp_rate: { label: 'Unemployment rate', unit: 'share', type: 'number', min: 0, max: 1, description: 'Unemployed share of the labor force.' },
  share_65plus: { label: 'Share 65+', unit: 'share', type: 'number', min: 0, max: 1, description: 'Share of population aged 65 or older.' },
  dist_power_node_km: { label: 'Distance to power node', unit: 'km', type: 'number', min: 0, description: 'Straight-line distance to the nearest electricity infrastructure node.' },
  SIAI: { label: 'Social Infrastructure Adaptability Index', unit: 'index', type: 'number', min: 0, max: 1, description: 'Provided composite social vulnerability index when available; otherwise the platform computes a documented composite.' },
  EXP_flood: { label: 'Flood exposure', unit: 'index', type: 'number', min: 0, max: 1, description: 'Modeled flood exposure index.' },
  log_pop_dens: { label: 'Log population density', unit: 'log persons/km2', type: 'number', description: 'Natural log of population density.' },
  pv_capacity_kw: { label: 'PV capacity (2018 estimate)', unit: 'kW', type: 'number', min: 0, description: 'Historical satellite-estimated PV capacity with pv_data_year vintage. Keep 2018 estimates distinct from later installations.' },
  pv_data_year: { label: 'PV data year', unit: 'year', type: 'number', description: 'Vintage year of the pv_capacity_kw estimate.' },
  nearest_pv_distance_km: { label: 'Nearest PV distance', unit: 'km', type: 'number', min: 0, description: 'Distance to the nearest satellite-detected PV installation.' },
  pv_recent_capacity_kw: { label: 'PV capacity (later satellite detection)', unit: 'kW', type: 'number', min: 0, description: 'PV capacity from later satellite detections (post-2018). Stored separately from the 2018 estimate to preserve the temporal distinction.' },
  pv_recent_data_year: { label: 'Recent PV data year', unit: 'year', type: 'number', description: 'Vintage year of pv_recent_capacity_kw.' },
  water_storage_m3: { label: 'Verified water storage', unit: 'm3', type: 'number', min: 0, description: 'Verified community water storage volume. Synthetic placeholder until verified data is provided.' },
  water_sources: { label: 'Water sources', unit: 'count', type: 'number', min: 0, description: 'Number of verified community water sources.' }
};

// Vulnerability screening dimensions (Module B2) - explainable by design.
const SCREENING_DIMENSIONS = {
  disruption: { label: 'Historical disruption', description: 'Depth of nighttime-light disruption during TC Gita 2018 and the 2025 flood observation period (1 - min light ratio).', variables: ['gita2018_min_ratio', 'flood2025_min_ratio'] },
  recovery: { label: 'Historical recovery duration', description: 'Days for nighttime lights to recover after TC Gita 2018.', variables: ['gita2018_rec_days'] },
  social: { label: 'Social vulnerability', description: 'SIAI when provided; otherwise a composite of income, education, unemployment and elderly share.', variables: ['SIAI', 'log_median_hh_income', 'share_lt_hs', 'unemp_rate', 'share_65plus'] },
  access: { label: 'Infrastructure accessibility', description: 'Distance to the nearest electricity infrastructure node.', variables: ['dist_power_node_km'] },
  exposure: { label: 'Disaster exposure', description: 'Flood exposure index and 2025 flood-period light drop.', variables: ['EXP_flood', 'flood2025_min_ratio'] },
  water: { label: 'Water supply vulnerability', description: 'Per-capita verified water storage and source count (lower storage = higher vulnerability).', variables: ['water_storage_m3', 'water_sources'] }
};

const DEFAULT_WEIGHTS = { disruption: 5, recovery: 4, social: 4, access: 3, exposure: 4, water: 4 };

const DEMO_NOTICE = 'DEMONSTRATION MODE - NOT AN OFFICIAL EMERGENCY INFORMATION SERVICE.';

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = {
  ROLES, ROLE_LABELS, PAGE_ACCESS, DATA_EDITORS, PROVENANCE, PROVENANCE_LABELS,
  DATA_DICTIONARY, SCREENING_DIMENSIONS, DEFAULT_WEIGHTS, DEMO_NOTICE, todayStr
};
