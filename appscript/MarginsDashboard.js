// MarginsDashboard.gs
// ─────────────────────────────────────────────────────────────────────────────
// Serves profit margin data by joining:
//   Signed_Customers  (CRM)         → contracted revenue per pool
//   Chemical_Cost_Detail (Chem Log) → actual chemical spend per visit
//
// Called from doGet with action=margins_data
// Returns JSON: { ok, pools, summary, generated_at }
// ─────────────────────────────────────────────────────────────────────────────

const MARGINS_CRM_SS_ID   = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
const MARGINS_CHEM_SS_ID  = SpreadsheetApp.getActiveSpreadsheet().getId();
const LABOR_PER_VISIT     = 15.00; // $ per pool per visit — optional toggle from frontend

function getMarginsDashboardData(includeLaborParam) {
  const includeLabor = includeLaborParam === "true" || includeLaborParam === true;

  try {
    // ── 1. Load Signed_Customers ─────────────────────────────────────────────
    const crmSs       = SpreadsheetApp.openById(MARGINS_CRM_SS_ID);
    const signedSheet = crmSs.getSheetByName("Signed_Customers");
    if (!signedSheet || signedSheet.getLastRow() < 2) {
      return { ok: false, error: "Signed_Customers sheet is empty or missing" };
    }

    const signedData    = signedSheet.getDataRange().getValues();
    const signedHeaders = signedData[0].map(h => String(h || "").trim());
    const sc            = h => signedHeaders.indexOf(h);

    const poolIdCol      = sc("pool_id");
    const firstNameCol   = sc("first_name");
    const lastNameCol    = sc("last_name");
    const addressCol     = sc("address");
    const serviceCol     = sc("service");
    const revenueCol     = sc("discounted_service_subtotal");
    const travelFeeCol   = sc("travel_fee");
    const sizeCol        = sc("size");
    const statusCol      = sc("service_status");

    if (poolIdCol === -1 || revenueCol === -1) {
      return { ok: false, error: "Signed_Customers missing required columns (pool_id, discounted_service_subtotal)" };
    }

    // Build pool map: pool_id → metadata + revenue
    const poolMap = {};
    for (let i = 1; i < signedData.length; i++) {
      const row    = signedData[i];
      const poolId = String(row[poolIdCol] || "").trim();
      if (!poolId) continue;

      const status = statusCol !== -1 ? String(row[statusCol] || "").trim().toLowerCase() : "";
      // Only include active signed customers (skip lost/cancelled)
      if (status === "lost" || status === "cancelled") continue;

      const revenue    = parseFloat(row[revenueCol]) || 0;
      const travelFee  = travelFeeCol !== -1 ? (parseFloat(row[travelFeeCol]) || 0) : 0;
      const firstName  = firstNameCol !== -1 ? String(row[firstNameCol] || "").trim() : "";
      const lastName   = lastNameCol  !== -1 ? String(row[lastNameCol]  || "").trim() : "";
      const address    = addressCol   !== -1 ? String(row[addressCol]   || "").trim() : "";
      const service    = serviceCol   !== -1 ? String(row[serviceCol]   || "").trim() : "";
      const size       = sizeCol      !== -1 ? String(row[sizeCol]      || "").trim() : "";

      poolMap[poolId] = {
        pool_id     : poolId,
        client_name : `${firstName} ${lastName}`.trim(),
        address,
        service,
        size,
        revenue_per_visit : revenue,  // what customer pays per service visit
        travel_fee        : travelFee,
        visits            : [],        // will be populated from Chemical_Cost_Detail
        weeks             : {},        // weekKey → { chem_cost, visit_count }
        months            : {},        // monthKey → { chem_cost, visit_count, revenue }
      };
    }

    // ── 2. Load Chemical_Cost_Detail ─────────────────────────────────────────
    const chemSs      = SpreadsheetApp.openById(MARGINS_CHEM_SS_ID);
    const detailSheet = chemSs.getSheetByName("Chemical_Cost_Detail");
    if (!detailSheet || detailSheet.getLastRow() < 2) {
      return { ok: false, error: "Chemical_Cost_Detail sheet is empty or missing" };
    }

    const detailData    = detailSheet.getDataRange().getValues();
    const detailHeaders = detailData[0].map(h => String(h || "").trim());
    const dc            = h => detailHeaders.indexOf(h);

    const dPoolIdCol  = dc("pool_id");
    const dTsCol      = dc("Timestamp");
    const dCostCol    = dc("Extended Cost");
    const dWeekCol    = dc("WeekKey");
    const dMonthCol   = dc("MonthKey");

    if (dPoolIdCol === -1 || dCostCol === -1) {
      return { ok: false, error: "Chemical_Cost_Detail missing required columns" };
    }

    // Aggregate chem costs per pool → per visit (by timestamp+pool) → per week → per month
    // First pass: group by pool+timestamp to get per-visit chem cost
    const visitMap = {}; // key: `${poolId}|${ts}` → { poolId, ts, weekKey, monthKey, chemCost }

    for (let i = 1; i < detailData.length; i++) {
      const row    = detailData[i];
      const poolId = String(row[dPoolIdCol] || "").trim();
      if (!poolId || !poolMap[poolId]) continue; // skip pools not in Signed_Customers

      const ts       = row[dTsCol] ? new Date(row[dTsCol]).toISOString() : "";
      const cost     = parseFloat(row[dCostCol]) || 0;
      const weekKey  = dWeekCol  !== -1 ? String(row[dWeekCol]  || "").trim() : "";
      const monthKey = dMonthCol !== -1 ? formatMonthKey_(row[dMonthCol]) : "";

      if (!ts) continue;

      const visitKey = `${poolId}|${ts.slice(0, 16)}`; // group by minute to catch same visit
      if (!visitMap[visitKey]) {
        visitMap[visitKey] = { poolId, ts, weekKey, monthKey, chemCost: 0 };
      }
      visitMap[visitKey].chemCost += cost;
    }

    // Second pass: push visits into pool buckets
    Object.values(visitMap).forEach(visit => {
      const pool = poolMap[visit.poolId];
      if (!pool) return;

      pool.visits.push(visit);

      // Weekly bucket
      if (visit.weekKey) {
        if (!pool.weeks[visit.weekKey]) {
          pool.weeks[visit.weekKey] = { chem_cost: 0, visit_count: 0 };
        }
        pool.weeks[visit.weekKey].chem_cost   += visit.chemCost;
        pool.weeks[visit.weekKey].visit_count += 1;
      }

      // Monthly bucket
      if (visit.monthKey) {
        if (!pool.months[visit.monthKey]) {
          pool.months[visit.monthKey] = { chem_cost: 0, visit_count: 0 };
        }
        pool.months[visit.monthKey].chem_cost   += visit.chemCost;
        pool.months[visit.monthKey].visit_count += 1;
      }
    });

    // ── 3. Compute margins ───────────────────────────────────────────────────
    const now         = new Date();
    const currentMonth = Utilities.formatDate(now, "America/Chicago", "yyyy-MM");
    const currentWeek  = getCurrentWeekKey_();

    const results = [];

    Object.values(poolMap).forEach(pool => {
      if (pool.visits.length === 0 && pool.revenue_per_visit === 0) return;

      // ── Per-visit lifetime avg ─────────────────────────────────────────────
      const totalVisits   = pool.visits.length;
      const totalChemCost = pool.visits.reduce((s, v) => s + v.chemCost, 0);
      const avgChemPerVisit = totalVisits > 0 ? totalChemCost / totalVisits : 0;
      const laborPerVisit   = includeLabor ? LABOR_PER_VISIT : 0;
      const avgCOGS         = avgChemPerVisit + laborPerVisit;

      const lifetimeMarginDollar  = pool.revenue_per_visit - avgCOGS;
      const lifetimeMarginPercent = pool.revenue_per_visit > 0
        ? (lifetimeMarginDollar / pool.revenue_per_visit) * 100
        : 0;

      // ── Weekly data ────────────────────────────────────────────────────────
      const weeklyData = Object.entries(pool.weeks)
        .sort((a, b) => parseWeekKeyToDate_(a[0]) - parseWeekKeyToDate_(b[0]))
        .map(([weekKey, w]) => {
          const cogs    = w.chem_cost + (includeLabor ? LABOR_PER_VISIT * w.visit_count : 0);
          const rev     = pool.revenue_per_visit * w.visit_count;
          const profit  = rev - cogs;
          const margin  = rev > 0 ? (profit / rev) * 100 : 0;
          return { weekKey, chem_cost: w.chem_cost, visit_count: w.visit_count, revenue: rev, cogs, profit, margin };
        });

      // ── Monthly data with projection ───────────────────────────────────────
      const monthlyData = Object.entries(pool.months)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([monthKey, m]) => {
          const isCurrentMonth = monthKey === currentMonth;
          const daysInMonth    = getDaysInMonth_(monthKey);
          const daysElapsed    = isCurrentMonth ? now.getDate() : daysInMonth;

          // For weekly service: expect ~4 visits/month. For bi-weekly: ~2.
          const expectedVisits = getExpectedVisitsPerMonth_(pool.service);

          // Projection: if partial month, scale up
          let projectedVisits = m.visit_count;
          let projectedChem   = m.chem_cost;
          let isProjected     = false;

          if (isCurrentMonth && m.visit_count > 0 && daysElapsed < daysInMonth) {
            const completionRatio = daysElapsed / daysInMonth;
            projectedVisits = Math.round(m.visit_count / completionRatio);
            projectedChem   = m.chem_cost / completionRatio;
            isProjected     = true;
          }

          const projectedRevenue = pool.revenue_per_visit * projectedVisits;
          const projectedCOGS    = projectedChem + (includeLabor ? LABOR_PER_VISIT * projectedVisits : 0);
          const projectedProfit  = projectedRevenue - projectedCOGS;
          const projectedMargin  = projectedRevenue > 0 ? (projectedProfit / projectedRevenue) * 100 : 0;

          // Actual (no projection)
          const actualRevenue = pool.revenue_per_visit * m.visit_count;
          const actualCOGS    = m.chem_cost + (includeLabor ? LABOR_PER_VISIT * m.visit_count : 0);
          const actualProfit  = actualRevenue - actualCOGS;
          const actualMargin  = actualRevenue > 0 ? (actualProfit / actualRevenue) * 100 : 0;

          return {
            monthKey,
            visit_count          : m.visit_count,
            chem_cost            : m.chem_cost,
            actual_revenue       : actualRevenue,
            actual_cogs          : actualCOGS,
            actual_profit        : actualProfit,
            actual_margin        : actualMargin,
            projected_visits     : projectedVisits,
            projected_chem       : projectedChem,
            projected_revenue    : projectedRevenue,
            projected_cogs       : projectedCOGS,
            projected_profit     : projectedProfit,
            projected_margin     : projectedMargin,
            is_projected         : isProjected,
            days_elapsed         : daysElapsed,
            days_in_month        : daysInMonth,
          };
        });

      results.push({
        pool_id             : pool.pool_id,
        client_name         : pool.client_name,
        address             : pool.address,
        service             : pool.service,
        size                : pool.size,
        revenue_per_visit   : pool.revenue_per_visit,
        total_visits        : totalVisits,
        avg_chem_per_visit  : avgChemPerVisit,
        labor_per_visit     : laborPerVisit,
        avg_cogs_per_visit  : avgCOGS,
        lifetime_profit     : lifetimeMarginDollar,
        lifetime_margin     : lifetimeMarginPercent,
        weekly              : weeklyData,
        monthly             : monthlyData,
        has_chem_data       : totalVisits > 0,
      });
    });

    // ── 4. Business-level summary ────────────────────────────────────────────
    const activePools      = results.filter(p => p.has_chem_data);
    const currentMonthData = activePools.map(p => {
      const m = p.monthly.find(m => m.monthKey === currentMonth);
      return m || null;
    }).filter(Boolean);

    const summaryRevenue = currentMonthData.reduce((s, m) => s + m.projected_revenue, 0);
    const summaryCOGS    = currentMonthData.reduce((s, m) => s + m.projected_cogs,    0);
    const summaryProfit  = summaryRevenue - summaryCOGS;
    const summaryMargin  = summaryRevenue > 0 ? (summaryProfit / summaryRevenue) * 100 : 0;

    // Top 5 highest-margin pools this month
    const poolsThisMonth = activePools
      .map(p => {
        const m = p.monthly.find(m => m.monthKey === currentMonth);
        return m ? { pool_id: p.pool_id, client_name: p.client_name, margin: m.projected_margin, profit: m.projected_profit } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.margin - a.margin);

    // Bottom 5 (drain pools)
    const drainPools = [...poolsThisMonth].sort((a, b) => a.margin - b.margin).slice(0, 5);

    return {
      ok           : true,
      generated_at : now.toISOString(),
      include_labor: includeLabor,
      current_month: currentMonth,
      current_week : currentWeek,
      summary      : {
        total_active_pools   : activePools.length,
        total_signed_pools   : Object.keys(poolMap).length,
        projected_revenue    : summaryRevenue,
        projected_cogs       : summaryCOGS,
        projected_profit     : summaryProfit,
        projected_margin     : summaryMargin,
        top_margin_pools     : poolsThisMonth.slice(0, 5),
        drain_pools          : drainPools,
      },
      pools: results.sort((a, b) => b.lifetime_margin - a.lifetime_margin),
    };

  } catch(err) {
    Logger.log("getMarginsDashboardData error: " + err + "\n" + err.stack);
    return { ok: false, error: String(err) };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMonthKey_(raw) {
  if (!raw) return "";
  // Already a clean string like "2026-03"
  if (typeof raw === "string" && /^\d{4}-\d{2}$/.test(raw.trim())) return raw.trim();
  // Date object or date serial
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, "America/Chicago", "yyyy-MM");
    }
  } catch(e) {}
  return String(raw).trim();
}


function getCurrentWeekKey_() {
  const now   = new Date();
  const day   = now.getDay();
  const sun   = new Date(now);
  sun.setDate(now.getDate() - day);
  const sat   = new Date(sun);
  sat.setDate(sun.getDate() + 6);
  const tz    = "America/Chicago";
  const ss    = Utilities.formatDate(sun, tz, "M/d");
  const es    = Utilities.formatDate(sat, tz, "M/d");
  return `${ss}-${es}`;
}

function parseWeekKeyToDate_(weekKey) {
  const m = String(weekKey || "").match(/^(\d{1,2})\/(\d{1,2})/);
  if (!m) return new Date(0);
  return new Date(new Date().getFullYear(), Number(m[1]) - 1, Number(m[2]));
}

function getDaysInMonth_(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  if (!year || !month) return 30;
  return new Date(year, month, 0).getDate();
}

function getExpectedVisitsPerMonth_(service) {
  const s = String(service || "").toLowerCase();
  if (s.includes("bi-weekly") || s.includes("biweekly")) return 2;
  if (s.includes("monthly")) return 1;
  return 4; // default: weekly
}

// ─── Wire into doGet ──────────────────────────────────────────────────────────
// Add this case to your existing doGet() in WebhookReceiver.gs:
//
//   if (e && e.parameter && e.parameter.action === 'margins_data') {
//     const includeLabor = e.parameter.labor || "false";
//     const data = getMarginsDashboardData(includeLabor);
//     return ContentService.createTextOutput(JSON.stringify(data))
//       .setMimeType(ContentService.MimeType.JSON);
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

function TEST_marginsDashboard() {
  const result = getMarginsDashboardData(false);
  Logger.log(JSON.stringify(result).slice(0, 3000));
  SpreadsheetApp.getActiveSpreadsheet().toast(
    result.ok
      ? `OK — ${result.pools.length} pools, ${result.summary.total_active_pools} with data`
      : "ERROR: " + result.error,
    "Margins Test"
  );
}