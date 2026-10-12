import {
  authSpreadsheetId,
  crmSpreadsheetId,
  getCached,
  hasAdminAccess,
  readExistingSheetRanges,
  readSheetRange,
  routesSpreadsheetId,
  rowsToObjects,
  sendJson,
  validatePortalSession,
  validatePortalSessionFromSheets
} from './_sheets.js';

const SCHEDULE_CACHE_MS = 20 * 1000;
const DEFAULT_TZ = 'America/Chicago';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const OFFICE_ADDR = '4640 S Flores Rd, Elmendorf, TX 78112';

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function isTruthy(value) {
  const raw = clean(value).toLowerCase();
  return value === true || raw === 'true' || raw === '1' || raw === 'yes';
}

function isoFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoFromParts(year, month, day) {
  return isoFromDate(new Date(Date.UTC(year, month - 1, day, 12)));
}

function parseDateIso(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Google Sheets serial date, where 25569 is 1970-01-01.
    return isoFromDate(new Date(Math.round((value - 25569) * 86400000)));
  }

  const raw = clean(value);
  if (!raw) return '';

  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));

  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    return isoFromParts(year, Number(m[1]), Number(m[2]));
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return isoFromDate(date);
}

function centralParts(date = new Date()) {
  const out = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: DEFAULT_TZ,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).forEach(part => {
    if (part.type !== 'literal') out[part.type] = part.value;
  });
  return out;
}

function todayIso() {
  const p = centralParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function weekdayName(iso) {
  const parsed = parseDateIso(iso);
  if (!parsed) return '';
  const [y, m, d] = parsed.split('-').map(Number);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()
  ];
}

function addDays(iso, days) {
  const parsed = parseDateIso(iso);
  if (!parsed) return '';
  const [y, m, d] = parsed.split('-').map(Number);
  return isoFromParts(y, m, d + days);
}

function currentWeekStart() {
  const today = todayIso();
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return isoFromParts(y, m, d + diff);
}

function weekStartForDate(value) {
  const iso = parseDateIso(value);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return isoFromParts(y, m, d + diff);
}

function dayDate(dayName, weekStart) {
  const idx = WEEKDAYS.indexOf(dayName);
  if (idx === -1) return '';
  return addDays(weekStart, idx);
}

function monthlyMatchesWeek(dayOfWeek, monthlyWeek, weekStart) {
  const iso = dayDate(dayOfWeek, weekStart);
  if (!iso) return false;
  const [, monthRaw, dayRaw] = iso.split('-').map(Number);
  const occurrence = Math.ceil(dayRaw / 7);
  const next = addDays(iso, 7);
  const isLast = next && Number(next.split('-')[1]) !== monthRaw;
  const want = lower(monthlyWeek);
  if (want === 'last' || want === '5' || want === 'l') return isLast;
  if (['1', '2', '3', '4'].includes(want)) return occurrence === Number(want);
  return occurrence === 1;
}

function firstValue(row, keys) {
  for (const key of keys) {
    const value = clean(row && row[key]);
    if (value) return value;
  }
  return '';
}

function quoteCustomerName(row) {
  return firstValue(row, ['customer_name', 'client_name', 'display_name'])
    || [firstValue(row, ['first_name']), firstValue(row, ['last_name'])].filter(Boolean).join(' ');
}

function mapBy(rows, key) {
  const out = new Map();
  (rows || []).forEach(row => {
    const id = clean(row && row[key]);
    if (id && !out.has(id)) out.set(id, row);
  });
  return out;
}

function readOptionalRange(range, spreadsheetId) {
  return readSheetRange(range, spreadsheetId).catch(() => []);
}

function buildOperators(users) {
  const operators = (users || [])
    .filter(row => {
      const roles = lower(row.roles || row.role);
      return isTruthy(row.active) && roles.includes('technician');
    })
    .map(row => firstValue(row, ['name', 'operator_name', 'username']))
    .filter(Boolean);
  return operators.length ? operators : ['UNASSIGNED'];
}

function buildOperatorsFromRoutes(routeRows) {
  const operators = [];
  const seen = new Set();
  (routeRows || []).forEach(row => {
    const op = clean(row.operator);
    if (!op || lower(op) === 'unassigned') return;
    const key = lower(op);
    if (seen.has(key)) return;
    seen.add(key);
    operators.push(op);
  });
  return operators.length ? operators : ['UNASSIGNED'];
}

function buildWeeklyOverrides(rows, weekStart) {
  const overrides = {};
  (rows || []).forEach(row => {
    if (parseDateIso(row.week_start) !== weekStart) return;
    const poolId = clean(row.pool_id);
    if (!poolId) return;
    overrides[poolId] = {
      day: clean(row.override_day),
      operator: clean(row.override_operator)
    };
  });
  return overrides;
}

function isPoolVisibleForWeek(row, weekStart) {
  const status = lower(row.route_status);
  if (status === 'inactive' || status === 'startup_complete') return false;

  const service = lower(row.service);
  if (service.includes('startup')) {
    const startupWeek = row.startup_start_date ? weekStartForDate(row.startup_start_date) : '';
    if (startupWeek && startupWeek !== weekStart) return false;
  }

  const serviceStartWeek = row.service_start_date ? weekStartForDate(row.service_start_date) : '';
  if (serviceStartWeek && weekStart < serviceStartWeek) return false;

  return true;
}

function startupDateFromVisit(scheduledDate, visitType) {
  const vt = clean(visitType);
  if (!scheduledDate || !vt) return '';
  const offset = vt === 'startup_day_2' ? -1 : vt === 'startup_day_3' ? -2 : 0;
  if (offset === 0 && vt !== 'startup_day_1') return '';
  return addDays(scheduledDate, offset);
}

function routeAddressInfo(row) {
  return {
    address: firstValue(row, ['address', 'service_address']),
    city: firstValue(row, ['city']),
    gate_code: clean(row.gate_code),
    customer_name: clean(row.customer_name)
  };
}

function quoteAddressInfo(row) {
  return {
    address: firstValue(row, ['address', 'service_address']),
    city: firstValue(row, ['city']),
    gate_code: clean(row.gate_code),
    customer_name: quoteCustomerName(row)
  };
}

// ── One-time jobs (visit_type=job) ─────────────────────────────────────────────
// Field-for-field mirror of jobShape_ / otjGroupStats_ / otjForViewer_ in
// appscript/OneTimeJobs.js. Keep the two in step.

function parseJsonCell(value, fallback) {
  const raw = clean(value);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function normMaterials(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(it => ({ id: clean(it && it.id), text: clean(it && it.text) }))
    .filter(it => it.text && /^m_[A-Za-z0-9]{4,12}$/.test(it.id));
}

function isJobRow(row) {
  return lower(row && row.visit_type) === 'job';
}

function jobVisitOrder(a, b) {
  const da = parseDateIso(a.scheduled_date), db = parseDateIso(b.scheduled_date);
  if (da !== db) return da < db ? -1 : 1;
  const ca = clean(a.created_at), cb = clean(b.created_at);
  if (ca !== cb) return ca < cb ? -1 : 1;
  const ia = clean(a.scheduled_visit_id), ib = clean(b.scheduled_visit_id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function jobGroupStats(rows) {
  const groups = new Map();
  (rows || []).forEach(row => {
    if (!isJobRow(row) || lower(row.status) === 'cancelled') return;
    const g = clean(row.job_group_id);
    if (!g) return;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(row);
  });
  const stats = {};
  groups.forEach(list => {
    list.slice().sort(jobVisitOrder).forEach((row, i) => {
      stats[clean(row.scheduled_visit_id)] = { index: i + 1, count: list.length };
    });
  });
  return stats;
}

function jobShape(row, lookups, stats) {
  const id = clean(row.scheduled_visit_id);
  const poolId = clean(row.pool_id);
  const quoteId = clean(row.quote_id);
  const route = poolId ? lookups.routeByPool.get(poolId) : null;
  const quoteByPool = poolId ? lookups.quoteByPool.get(poolId) : null;
  const quoteById = quoteId ? lookups.quoteById.get(quoteId) : null;
  const srcs = [
    {
      name: clean(row.client_name) || clean(row.customer_name), phone: clean(row.phone),
      address: clean(row.address), city: clean(row.city), gate_code: clean(row.gate_code)
    },
    route ? { name: clean(route.customer_name), phone: clean(route.phone), address: firstValue(route, ['address', 'service_address']), city: clean(route.city), gate_code: clean(route.gate_code) } : null,
    quoteByPool ? { name: quoteCustomerName(quoteByPool), phone: clean(quoteByPool.phone), address: firstValue(quoteByPool, ['address', 'service_address']), city: clean(quoteByPool.city), gate_code: clean(quoteByPool.gate_code) } : null,
    quoteById ? { name: quoteCustomerName(quoteById), phone: clean(quoteById.phone), address: firstValue(quoteById, ['address', 'service_address']), city: clean(quoteById.city), gate_code: clean(quoteById.gate_code) } : null
  ];
  const pick = f => {
    for (const s of srcs) if (s && s[f]) return s[f];
    return '';
  };
  const st = stats[id] || { index: 1, count: 1 };
  const est = clean(row.est_minutes);
  return {
    scheduled_visit_id: id,
    job_group_id: clean(row.job_group_id) || id,
    visit_index: st.index,
    visit_count: st.count,
    title: clean(row.job_title) || 'Job',
    scheduled_date: parseDateIso(row.scheduled_date),
    assigned_technician: clean(row.assigned_technician),
    assigned_username: clean(row.assigned_username),
    est_minutes: est ? Number(est) : '',
    materials: normMaterials(parseJsonCell(row.materials, [])),
    materials_checked: parseJsonCell(row.materials_checked, {}) || {},
    notes: clean(row.notes),
    status: lower(row.status) || 'scheduled',
    completed_at: clean(row.completed_at),
    completed_by: clean(row.completed_by),
    rev: Number(row.rev) || 0,
    created_by: clean(row.created_by),
    created_at: clean(row.created_at),
    lead_status: lower(row.lead_status),
    client: {
      pool_id: poolId, quote_id: quoteId,
      name: pick('name'), phone: pick('phone'), address: pick('address'),
      city: pick('city'), gate_code: pick('gate_code')
    }
  };
}

function canSeeFullJob(job, viewer) {
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return !!viewer.username && lower(job && job.assigned_username) === viewer.username;
}

function jobForViewer(job, viewer) {
  if (!job || canSeeFullJob(job, viewer)) return job;
  return {
    scheduled_visit_id: job.scheduled_visit_id, job_group_id: job.job_group_id,
    visit_index: job.visit_index, visit_count: job.visit_count, title: job.title,
    scheduled_date: job.scheduled_date, assigned_technician: job.assigned_technician,
    status: job.status, restricted: true
  };
}

// Returns a redacted COPY for non-admin viewers. Never mutates the cached
// payload or its nested _job objects; untouched days/stops are shared as-is.
function redactScheduleForViewer(payload, viewer) {
  if (!payload || !Array.isArray(payload.days) || (viewer && viewer.isAdmin)) return payload;
  return {
    ...payload,
    days: payload.days.map(day => {
      let changed = false;
      const pools = (day.pools || []).map(pool => {
        if (!pool || !pool._job || canSeeFullJob(pool._job, viewer)) return pool;
        changed = true;
        return {
          pool_id: '', customer_name: 'Job', address: '', city: '', service: 'One-time job',
          maps_url: '', lat: '', lng: '', operator: pool.operator || '', pinned: false,
          monthly_week: '', week_override: false, gate_code: '', notes: '', startup_start_date: '',
          _is_scheduled_visit: true, _visit_type: 'job',
          _scheduled_visit_id: pool._scheduled_visit_id, _scheduled_visit_status: pool._scheduled_visit_status,
          _job: jobForViewer(pool._job, viewer)
        };
      });
      if (!changed) return day;
      return { ...day, pools, maps_url: buildMapsUrl(pools.filter(p => p.address)) };
    })
  };
}

function computeScheduledVisits({ scheduledVisits, routeRows, quoteRows, weekStart, operatorFilter }) {
  const weekEnd = addDays(weekStart, 5);
  const routeByPool = mapBy(routeRows, 'pool_id');
  const quoteByPool = mapBy(quoteRows, 'pool_id');
  const jobLookups = { routeByPool, quoteByPool, quoteById: mapBy(quoteRows, 'quote_id') };
  const jobStats = jobGroupStats(scheduledVisits);
  const visits = [];

  (scheduledVisits || []).forEach(row => {
    const status = lower(row.status);
    if (status && status !== 'scheduled' && status !== 'completed') return;

    const scheduledDate = parseDateIso(row.scheduled_date);
    if (!scheduledDate || scheduledDate < weekStart || scheduledDate > weekEnd) return;

    const assignedTech = clean(row.assigned_technician);
    if (operatorFilter && operatorFilter !== 'all' && lower(assignedTech) !== lower(operatorFilter)) return;

    const poolId = clean(row.pool_id);
    if (isJobRow(row)) {
      const job = jobShape(row, jobLookups, jobStats);
      visits.push({
        scheduled_visit_id: job.scheduled_visit_id,
        pool_id: poolId,
        customer_name: job.client.name || job.title,
        service_type: 'One-time job',
        visit_type: 'job',
        scheduled_date: scheduledDate,
        assigned_technician: assignedTech,
        status: status || 'scheduled',
        notes: job.notes,
        address: job.client.address,
        city: job.client.city,
        gate_code: job.client.gate_code,
        job
      });
      return;
    }
    const addr = routeAddressInfo(routeByPool.get(poolId) || {});
    const fallback = quoteAddressInfo(quoteByPool.get(poolId) || {});
    const customerName = clean(row.customer_name) || addr.customer_name || fallback.customer_name;

    visits.push({
      scheduled_visit_id: clean(row.scheduled_visit_id),
      pool_id: poolId,
      customer_name: customerName,
      service_type: clean(row.service_type),
      visit_type: clean(row.visit_type),
      scheduled_date: scheduledDate,
      assigned_technician: assignedTech,
      status,
      notes: clean(row.notes),
      address: addr.address || fallback.address,
      city: addr.city || fallback.city,
      gate_code: addr.gate_code || fallback.gate_code
    });
  });

  return visits;
}

function mergeScheduledVisits(dayPools, visits, weekStart) {
  const dateToDay = {};
  WEEKDAYS.forEach(day => {
    dateToDay[dayDate(day, weekStart)] = day;
  });

  (visits || []).forEach(visit => {
    const day = dateToDay[visit.scheduled_date];
    if (!day || !dayPools[day]) return;

    // One-time jobs are always their own stop — never folded into a weekly stop.
    if (visit.visit_type === 'job' && visit.job) {
      dayPools[day].push({
        pool_id: visit.pool_id,
        customer_name: visit.customer_name,
        address: visit.address,
        city: visit.city,
        service: 'One-time job',
        maps_url: '',
        lat: '',
        lng: '',
        operator: visit.assigned_technician,
        pinned: false,
        monthly_week: '',
        week_override: false,
        gate_code: visit.gate_code || '',
        notes: visit.notes || '',
        startup_start_date: '',
        _is_scheduled_visit: true,
        _visit_type: 'job',
        _scheduled_visit_id: visit.scheduled_visit_id,
        _scheduled_visit_status: visit.status,
        _job: visit.job
      });
      return;
    }

    const existing = dayPools[day].find(pool => clean(pool.pool_id) === clean(visit.pool_id));
    if (existing) {
      existing._is_scheduled_visit = true;
      existing._visit_type = visit.visit_type;
      existing._scheduled_visit_id = visit.scheduled_visit_id;
      existing._scheduled_visit_status = visit.status;
      if (!existing.startup_start_date) existing.startup_start_date = startupDateFromVisit(visit.scheduled_date, visit.visit_type);
      return;
    }

    dayPools[day].push({
      pool_id: visit.pool_id,
      customer_name: visit.customer_name,
      address: visit.address,
      city: visit.city,
      service: visit.service_type || visit.visit_type,
      maps_url: '',
      lat: '',
      lng: '',
      operator: visit.assigned_technician,
      pinned: false,
      monthly_week: '',
      week_override: false,
      gate_code: visit.gate_code || '',
      startup_start_date: startupDateFromVisit(visit.scheduled_date, visit.visit_type),
      _is_scheduled_visit: true,
      _visit_type: visit.visit_type,
      _scheduled_visit_id: visit.scheduled_visit_id,
      _scheduled_visit_status: visit.status
    });
  });
}

function stopAddress(pool) {
  const address = clean(pool && pool.address);
  const city = clean(pool && pool.city);
  if (!address) return '';
  return city ? `${address}, ${city}, TX` : `${address}, TX`;
}

function distanceKey(origin, destination) {
  return `${clean(origin).toLowerCase()}||${clean(destination).toLowerCase()}`;
}

function buildDistanceCache(rows) {
  const cache = new Map();
  (rows || []).forEach(row => {
    const origin = clean(row.origin);
    const destination = clean(row.destination);
    const minutes = Number(row.minutes);
    if (!origin || !destination || !Number.isFinite(minutes)) return;
    cache.set(distanceKey(origin, destination), minutes);
  });
  return cache;
}

function cachedMinutes(origin, destination, cache) {
  if (!origin || !destination) return null;
  if (clean(origin).toLowerCase() === clean(destination).toLowerCase()) return 0;
  const exact = cache.get(distanceKey(origin, destination));
  if (Number.isFinite(exact)) return exact;
  const reverse = cache.get(distanceKey(destination, origin));
  return Number.isFinite(reverse) ? reverse : null;
}

function hasCompleteDistanceCache(stops, cache) {
  if (!stops || stops.length <= 1) return true;
  const addresses = stops.map(stopAddress).filter(Boolean);
  if (addresses.length !== stops.length) return false;
  return addresses.every(origin => cachedMinutes(OFFICE_ADDR, origin, cache) != null)
    && addresses.every((origin, i) => addresses.every((destination, j) => (
      i === j || cachedMinutes(origin, destination, cache) != null
    )));
}

function orderStopsNearestNeighbor(stops, cache) {
  if (!stops || stops.length <= 1) return stops || [];
  if (!hasCompleteDistanceCache(stops, cache)) return stops;

  const remaining = stops.map(pool => ({ pool, address: stopAddress(pool) }));
  const chain = [];
  let current = OFFICE_ADDR;

  while (remaining.length) {
    let bestIdx = 0;
    let bestMinutes = Infinity;
    remaining.forEach((candidate, index) => {
      const minutes = cachedMinutes(current, candidate.address, cache);
      if (minutes != null && minutes < bestMinutes) {
        bestMinutes = minutes;
        bestIdx = index;
      }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    chain.push(next);
    current = next.address;
  }

  return chain.reverse().map(item => item.pool);
}

function orderDayPoolsByOperator(pools, cache) {
  if (!pools || pools.length <= 1) return pools || [];
  const groups = {};
  const order = [];
  pools.forEach(pool => {
    const operator = clean(pool.operator) || 'UNASSIGNED';
    if (!groups[operator]) {
      groups[operator] = [];
      order.push(operator);
    }
    groups[operator].push(pool);
  });

  return order.flatMap(operator => orderStopsNearestNeighbor(groups[operator], cache));
}

function buildMapsUrl(pools) {
  const stops = (pools || []).map(stopAddress).filter(Boolean);
  if (!stops.length) return '';
  return `https://www.google.com/maps/dir/${encodeURIComponent(OFFICE_ADDR)}/${
    stops.map(stop => encodeURIComponent(stop)).join('/')
  }/${encodeURIComponent(OFFICE_ADDR)}`;
}

function buildCompletionsByDate(rows, weekStart) {
  const weekEnd = addDays(weekStart, 5);
  const out = {};

  (rows || []).forEach(row => {
    const rowDate = parseDateIso(row.date) || parseDateIso(row.completed_at);
    if (!rowDate || rowDate < weekStart || rowDate > weekEnd) return;

    const completion = {
      visit_id: clean(row.visit_id),
      pool_id: clean(row.pool_id),
      technician: clean(row.technician),
      completed_at: clean(row.completed_at),
      day_of_week: clean(row.day_of_week),
      scheduled_visit_id: clean(row.scheduled_visit_id),
      service_key: clean(row.service_key)
    };

    if (!out[rowDate]) out[rowDate] = [];
    out[rowDate].push(completion);
  });

  return out;
}

function buildFullSchedule({ routeRows, weeklyOverrides, scheduledVisits, quotes, users, distanceRows, completions, weekStart }) {
  const dayPools = {};
  WEEKDAYS.forEach(day => {
    dayPools[day] = [];
  });

  const overrides = buildWeeklyOverrides(weeklyOverrides, weekStart);

  (routeRows || []).forEach(row => {
    const rawDay = clean(row.day_of_week);
    if (!WEEKDAYS.includes(rawDay)) return;
    if (!isPoolVisibleForWeek(row, weekStart)) return;

    const poolId = clean(row.pool_id);
    const override = overrides[poolId] || {};
    const effectiveDay = WEEKDAYS.includes(override.day) ? override.day : rawDay;
    const effectiveOperator = override.operator || clean(row.operator);

    const service = clean(row.service);
    if (lower(service).includes('monthly')) {
      const monthlyWeek = clean(row.monthly_week);
      if (!monthlyWeek) return;
      if (!monthlyMatchesWeek(effectiveDay, monthlyWeek, weekStart)) return;
    }

    dayPools[effectiveDay].push({
      pool_id: poolId,
      customer_name: clean(row.customer_name),
      address: firstValue(row, ['address', 'service_address']),
      city: clean(row.city),
      service,
      maps_url: clean(row.maps_link),
      lat: clean(row.lat),
      lng: clean(row.lng),
      operator: effectiveOperator,
      pinned: isTruthy(row.pinned),
      monthly_week: clean(row.monthly_week),
      week_override: effectiveDay !== rawDay,
      gate_code: clean(row.gate_code),
      startup_start_date: parseDateIso(row.startup_start_date) || clean(row.startup_start_date)
    });
  });

  const visits = computeScheduledVisits({
    scheduledVisits,
    routeRows,
    quoteRows: quotes,
    weekStart,
    operatorFilter: null
  });
  mergeScheduledVisits(dayPools, visits, weekStart);

  const distanceCache = buildDistanceCache(distanceRows);
  const days = WEEKDAYS.map(day => {
    const pools = orderDayPoolsByOperator(dayPools[day], distanceCache);
    return {
      day,
      date: dayDate(day, weekStart),
      pools,
      maps_url: buildMapsUrl(pools)
    };
  });

  return {
    ok: true,
    source: 'sheets_api',
    week_start: weekStart,
    today: todayIso(),
    all_operators: buildOperators(users).filter(op => op !== 'UNASSIGNED').length
      ? buildOperators(users)
      : buildOperatorsFromRoutes(routeRows),
    scheduled_visits_merged: true,
    route_ordering: 'distance_cache_only',
    completions_by_date: buildCompletionsByDate(completions, weekStart),
    days
  };
}

function filterSchedule(full, operatorFilter) {
  if (!operatorFilter || operatorFilter === 'all') return full;
  const f = lower(operatorFilter);
  return {
    ...full,
    days: (full.days || []).map(day => {
      const pools = (day.pools || []).filter(pool => lower(pool.operator) === f);
      return { ...day, pools, maps_url: buildMapsUrl(pools) };
    })
  };
}

async function loadSchedulePayload(weekStart) {
  const routesId = routesSpreadsheetId();
  const authId = authSpreadsheetId();
  const crmId = crmSpreadsheetId();

  const routeRangesPromise = readExistingSheetRanges([
    'Routes',
    'Weekly_Overrides',
    'Scheduled_Visits',
    'Route_Distance_Cache!A:D',
    'Job_Completions'
  ], routesId);
  const usersPromise = readOptionalRange('Users', authId);
  const quotesPromise = readOptionalRange('Quotes', crmId);

  const [
    routeValues,
    userValues,
    quoteValues
  ] = await Promise.all([
    routeRangesPromise,
    usersPromise,
    quotesPromise
  ]);

  return buildFullSchedule({
    routeRows: rowsToObjects(routeValues.Routes),
    users: rowsToObjects(userValues),
    weeklyOverrides: rowsToObjects(routeValues.Weekly_Overrides),
    scheduledVisits: rowsToObjects(routeValues.Scheduled_Visits),
    distanceRows: rowsToObjects(routeValues['Route_Distance_Cache!A:D']),
    completions: rowsToObjects(routeValues.Job_Completions),
    quotes: rowsToObjects(quoteValues),
    weekStart
  });
}

function requestedOperator(req, session) {
  const requested = clean(req.query && req.query.operator) || 'all';
  if (hasAdminAccess(session)) return requested;
  return clean(session && (session.operator_name || session.name || session.username)) || requested;
}

function truthyQuery(value) {
  return ['1', 'true', 'yes'].includes(lower(value));
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }

    const token = req.query && req.query.token;
    let authSource = 'sheets';
    const session = await validatePortalSessionFromSheets(token).catch(error => {
      console.warn('schedule direct auth failed; falling back to GAS validation', error.message || error);
      authSource = 'gas';
      return validatePortalSession(token);
    });
    if (!session) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

    const weekStart = parseDateIso(req.query && req.query.week_start) || currentWeekStart();
    const operator = requestedOperator(req, session);
    const refresh = truthyQuery(req.query && req.query.refresh);
    const cacheKey = `schedule:v1:${weekStart}`;
    const full = refresh
      ? await loadSchedulePayload(weekStart)
      : await getCached(cacheKey, SCHEDULE_CACHE_MS, () => loadSchedulePayload(weekStart));

    // `full` is the shared, viewer-neutral cached payload. Redaction runs after the
    // cache read and returns copies, so one viewer's response never leaks into
    // (or strips detail from) another's.
    const viewer = {
      username: lower(session.username),
      isAdmin: hasAdminAccess(session)
    };
    return sendJson(res, 200, {
      ...redactScheduleForViewer(filterSchedule(full, operator), viewer),
      auth_source: authSource,
      cache_ttl_ms: refresh ? 0 : SCHEDULE_CACHE_MS,
      operator
    });
  } catch (error) {
    console.error('schedule endpoint failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'Schedule read failed' });
  }
}
