// ─────────────────────────────────────────────────────────────────────────────
// Fleet Monitor — the metric layer.
//
// Pure functions only: no DOM, no network, no globals from the rest of the app.
// Everything the board draws is derived here, so if these numbers are wrong
// every pixel above them is wrong too.
//
// The Taylor bands below are copied VERBATIM from SVC_READING_BANDS in
// js/features/service-log-v2.js. The service log and this board must never
// disagree about what "in range" means. If one changes, change both.
// ─────────────────────────────────────────────────────────────────────────────

// ── Taylor ideal ranges ───────────────────────────────────────────────────────
// green IDEAL / amber LOW·HIGH / red VERY HIGH. `min`/`max` = meter scale ends.
const MON_BANDS = {
  'Free Chlorine (FC)':    { low:3,    idealMax:5,                   min:0,    max:8,    unit:'ppm' },
  'pH':                    { low:7.2,  idealMax:7.6,                 min:6.8,  max:8.4,  unit:''    },
  'Total Alkalinity (TA)': { low:80,   idealMax:120,                 min:0,    max:240,  unit:'ppm' },
  'Calcium Hardness (CH)': { low:200,  idealMax:400,                 min:0,    max:600,  unit:'ppm' },
  'Cyanuric Acid (CYA)':   { low:30,   idealMax:80,   veryHigh:80,   min:0,    max:120,  unit:'ppm' },
  'Salt Level':            { low:2700, idealMax:4500, veryHigh:4500, min:1500, max:6000, unit:'ppm' }
};

// Short column headers, mirroring SVC_READING_SHORT.
const MON_SHORT = {
  'Free Chlorine (FC)':'FC', 'pH':'pH', 'Total Alkalinity (TA)':'TA',
  'Calcium Hardness (CH)':'CH', 'Cyanuric Acid (CYA)':'CYA', 'Salt Level':'Salt'
};

// Board column order, left to right. Order is presentational only — scoring
// sums over these, so rearranging them cannot change a score.
const MON_READINGS = ['Free Chlorine (FC)', 'pH', 'Total Alkalinity (TA)',
                      'Calcium Hardness (CH)', 'Cyanuric Acid (CYA)', 'Salt Level'];

// Score weights. pH and FC carry double because they are what actually makes a
// pool safe and swimmable this week; the rest are slower-moving balance metrics.
const MON_WEIGHTS = {
  'pH':2.0, 'Free Chlorine (FC)':2.0, 'Total Alkalinity (TA)':1.5,
  'Calcium Hardness (CH)':1.0, 'Cyanuric Acid (CYA)':1.0, 'Salt Level':1.0
};

// A reading scores zero once it sits this far outside its ideal band, measured
// as a fraction of that reading's full meter scale. Tuned so pH 8.1 and FC 0.4
// both land near zero while FC 2.5 and TA 68 read as mild drift.
const MON_ZERO_AT = 0.35;

// Status thresholds. Kept as named constants so they can be tuned in one place.
const MON_OUT_SCORE   = 70;   // below this, the pool is out of spec
const MON_DRIFT_SCORE = 88;   // below this, the pool is drifting

// ── Tolerant parsing ──────────────────────────────────────────────────────────
// Sheet values arrive as display strings: "7.5", "", "7.5 ", "<0.5", "n/a".
// Anything we can't read confidently becomes null — never NaN, and never 0,
// because a fabricated zero would drag a pool's score down for no reason.
function monNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  // "<0.5" and ">5" are real technician entries — take the bound as the value.
  s = s.replace(/^[<>~≈]+/, '').replace(/,/g, '').replace(/ppm$/i, '').trim();
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// ── Band classification ───────────────────────────────────────────────────────
// Port of readingBand() from service-log-v2.js. Returns 'low' | 'ideal' |
// 'high' | 'veryhigh', or null when the reading wasn't taken.
function monBand(field, val) {
  const r = MON_BANDS[field];
  const v = monNum(val);
  if (!r || v === null) return null;
  if (v < r.low) return 'low';
  if (v <= r.idealMax) return 'ideal';
  if (r.veryHigh && v > r.veryHigh) return 'veryhigh';
  return 'high';
}

// Position (0–100%) of a value on a reading's meter scale. Mirrors _svcMeterPct_.
function monMeterPct(field, val) {
  const r = MON_BANDS[field];
  const v = monNum(val);
  if (!r || v === null) return null;
  return Math.max(0, Math.min(100, ((v - r.min) / (r.max - r.min)) * 100));
}

// The ideal band as start/end percentages of the meter, for drawing the green
// zone behind a micro-meter or a detail chart.
function monIdealZone(field) {
  const r = MON_BANDS[field];
  if (!r) return null;
  const span = r.max - r.min;
  return {
    start: ((r.low - r.min) / span) * 100,
    end:   ((r.idealMax - r.min) / span) * 100
  };
}

// ── Balance Score ─────────────────────────────────────────────────────────────
// The "price". 0–100, where 100 means every reading taken sat inside its ideal
// band. Readings that weren't taken drop out of the denominator entirely rather
// than scoring zero — a partial panel must not make a healthy pool look sick.
//
// `visit` is an object keyed by the full reading names in MON_BANDS.
// Returns null when nothing testable was recorded, so callers can render
// "not tested" instead of a number that means nothing.
function monScore(visit) {
  if (!visit) return null;
  let weighted = 0, totalWeight = 0;

  for (const field of MON_READINGS) {
    const r = MON_BANDS[field];
    const v = monNum(visit[field]);
    if (v === null) continue;

    // A blank or zero salt reading means "not a salt pool", not "salt is zero".
    // Scoring it would punish every chlorine-tab pool in the fleet.
    if (field === 'Salt Level' && v <= 0) continue;

    let dist = 0;
    if (v < r.low) dist = r.low - v;
    else if (v > r.idealMax) dist = v - r.idealMax;

    const norm    = dist / (r.max - r.min);
    const penalty = Math.min(1, norm / MON_ZERO_AT);
    const w       = MON_WEIGHTS[field] || 1;

    weighted   += w * penalty;
    totalWeight += w;
  }

  if (!totalWeight) return null;
  return Math.round((100 * (1 - weighted / totalWeight)) * 10) / 10;
}

// How many readings in this visit were actually taken.
function monTestedCount(visit) {
  if (!visit) return 0;
  return MON_READINGS.filter(f => {
    const v = monNum(visit[f]);
    if (v === null) return false;
    if (f === 'Salt Level' && v <= 0) return false;
    return true;
  }).length;
}

// ── Status ────────────────────────────────────────────────────────────────────
// Drives the row dot. Deliberately NOT based on estimated LSI — only on fully
// measured values, so a pool is never flagged on the strength of an assumption.
// Returns 'ok' | 'drift' | 'out' | 'nodata'.
function monStatus(visit) {
  const score = monScore(visit);
  if (score === null) return 'nodata';

  const fcBand = monBand('Free Chlorine (FC)', visit['Free Chlorine (FC)']);

  // Evaluate bands over exactly the readings monScore counted. A blank or zero
  // Salt Level means "not a salt pool", not "salt is zero" — counting its band
  // would mark every chlorine-tab pool in the fleet as drifting.
  const bands = MON_READINGS.map(f => {
    const v = monNum(visit[f]);
    if (v === null) return null;
    if (f === 'Salt Level' && v <= 0) return null;
    return monBand(f, visit[f]);
  }).filter(Boolean);

  // No sanitizer is urgent regardless of how the rest of the panel looks.
  if (fcBand === 'low') return 'out';
  if (bands.some(b => b === 'veryhigh')) return 'out';
  if (score < MON_OUT_SCORE) return 'out';
  if (score < MON_DRIFT_SCORE) return 'drift';
  if (bands.some(b => b !== 'ideal')) return 'drift';
  return 'ok';
}

// ── Estimated LSI ─────────────────────────────────────────────────────────────
// LSI = pH + TF + CF + AF − K
//
// ⚠️ Two of the five inputs are ASSUMPTIONS. The service log records no water
// temperature and no TDS, so temperature comes from a San Antonio seasonal
// curve and TDS is inferred from salt. Every LSI this returns must be rendered
// with an `est` marker and a tooltip naming the assumed temperature. It must
// never be the sole basis for a status — see monStatus above.

// Monthly average outdoor pool water temperature, San Antonio (°F). Index 0 = Jan.
const MON_SEASONAL_TEMP_F = [55, 58, 65, 72, 79, 85, 88, 88, 84, 75, 64, 56];

function monAssumedTempF(date) {
  const d = (date instanceof Date && isFinite(date)) ? date : new Date();
  return MON_SEASONAL_TEMP_F[d.getMonth()];
}

// Temperature factor, interpolated from the standard LSI table.
const MON_TF_TABLE = [
  [32, 0.0], [37, 0.1], [46, 0.2], [53, 0.3], [60, 0.4],
  [66, 0.5], [76, 0.6], [84, 0.7], [94, 0.8], [105, 0.9]
];

function monTempFactor(tempF) {
  const t = MON_TF_TABLE;
  if (tempF <= t[0][0]) return t[0][1];
  if (tempF >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 0; i < t.length - 1; i++) {
    const [x0, y0] = t[i], [x1, y1] = t[i + 1];
    if (tempF >= x0 && tempF <= x1) {
      return y0 + ((tempF - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 0.7;
}

// TDS constant. Step table used in standard pool practice.
function monTdsConstant(tds) {
  if (tds <= 1000) return 12.1;
  if (tds <= 2000) return 12.2;
  if (tds <= 3000) return 12.3;
  if (tds <= 4000) return 12.4;
  return 12.5;
}

// Returns { value, tempF, tds, assumed:true } or null when CH or TA is missing.
function monLSI(visit, date) {
  if (!visit) return null;
  const pH = monNum(visit['pH']);
  const ch = monNum(visit['Calcium Hardness (CH)']);
  const ta = monNum(visit['Total Alkalinity (TA)']);
  if (pH === null || ch === null || ta === null || ch <= 0 || ta <= 0) return null;

  const salt  = monNum(visit['Salt Level']);
  // Salt pools carry roughly their salt level plus ~1000ppm of other solids.
  const tds   = (salt && salt > 0) ? salt + 1000 : 1000;
  const tempF = monAssumedTempF(date);

  const TF = monTempFactor(tempF);
  const CF = Math.log10(ch) - 0.4;
  const AF = Math.log10(ta);
  const K  = monTdsConstant(tds);

  return {
    value:   Math.round((pH + TF + CF + AF - K) * 100) / 100,
    tempF:   tempF,
    tds:     tds,
    assumed: true
  };
}

// Plain-language reading of an LSI value, for the gauge label.
function monLSILabel(lsi) {
  if (lsi === null || lsi === undefined) return 'Not enough data';
  if (lsi < -0.5) return 'Corrosive';
  if (lsi < -0.3) return 'Slightly corrosive';
  if (lsi <= 0.3) return 'Balanced';
  if (lsi <= 0.5) return 'Slightly scaling';
  return 'Scaling';
}

// ── Burn-rate forecast ────────────────────────────────────────────────────────
// Fits a line through the last few readings and projects forward to the edge of
// the ideal band. This is what makes the board predictive rather than a report
// of what already happened.
//
// `visits` is newest-first, each { date: Date, readings: {...} }.
// Returns { field, days, direction, edge } or null when there isn't enough
// signal — we say nothing rather than invent a date.

const MON_FORECAST_MIN_POINTS = 3;   // fewer than this and a slope is noise
const MON_FORECAST_MAX_DAYS   = 21;  // beyond three weeks, stop pretending
const MON_FORECAST_POINTS     = 4;   // how far back to fit

function monForecast(visits, field) {
  if (!Array.isArray(visits) || visits.length < MON_FORECAST_MIN_POINTS) return null;
  const r = MON_BANDS[field];
  if (!r) return null;

  // Oldest-first, only visits where this reading was actually taken.
  const pts = visits
    .slice(0, MON_FORECAST_POINTS)
    .map(v => ({ t: v.date instanceof Date ? v.date.getTime() : null, y: monNum(v.readings && v.readings[field]) }))
    .filter(p => p.t !== null && p.y !== null)
    .reverse();

  if (pts.length < MON_FORECAST_MIN_POINTS) return null;

  // Days elapsed from the first point, so the slope comes out per-day.
  const DAY = 86400000;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / DAY);
  const ys = pts.map(p => p.y);
  const span = xs[xs.length - 1];
  if (!span) return null;

  const n = pts.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) * (xs[i] - meanX);
  }
  if (!den) return null;
  const slope = num / den;               // units per day
  const current = ys[ys.length - 1];

  // Which edge are we heading toward?
  let edge, direction;
  if (slope < 0)      { edge = r.low;      direction = 'falling'; }
  else if (slope > 0) { edge = r.idealMax; direction = 'rising';  }
  else return null;

  // Already outside the band — nothing to forecast, monStatus already says so.
  if (current < r.low || current > r.idealMax) return null;

  const days = (edge - current) / slope;
  if (!isFinite(days) || days <= 0 || days > MON_FORECAST_MAX_DAYS) return null;

  return {
    field:     field,
    short:     MON_SHORT[field] || field,
    days:      Math.round(days),
    direction: direction,
    edge:      edge
  };
}

// The single most urgent forecast across the readings that move fastest.
function monSoonestForecast(visits) {
  const candidates = ['Free Chlorine (FC)', 'pH']
    .map(f => monForecast(visits, f))
    .filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => a.days - b.days)[0];
}

// ── Fleet index ───────────────────────────────────────────────────────────────
// The "market". Mean Balance Score across ACTIVE WEEKLY pools only — startups
// are legitimately out of range while they stabilize, and averaging them in
// would make the business look worse every time a pool is sold.
function monFleetIndex(pools) {
  const scores = (pools || [])
    .filter(p => !p.is_startup)
    .map(p => p.score)
    .filter(s => s !== null && s !== undefined);
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

// ── Formatting ────────────────────────────────────────────────────────────────

// Reading value for display. Keeps the technician's precision, never invents it.
function monFmtReading(field, val) {
  const v = monNum(val);
  if (v === null) return null;
  if (field === 'pH') return v.toFixed(1);
  if (field === 'Free Chlorine (FC)') return (Math.round(v * 10) / 10).toString();
  return Math.round(v).toString();
}

// "Last serviced 3 days ago" — brand voice, not "3d".
function monDaysAgo(date) {
  if (!(date instanceof Date) || !isFinite(date)) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days < 0) return 0;
  return days;
}

function monDaysAgoLabel(days) {
  if (days === null || days === undefined) return 'No visits logged';
  if (days === 0) return 'Serviced today';
  if (days === 1) return 'Serviced yesterday';
  return 'Serviced ' + days + ' days ago';
}
