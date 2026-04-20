// ChemicalAnalytics.gs

const CHEM_DETAIL_SHEET   = "Chemical_Cost_Detail";
const CHEM_ANALYTICS_SHEET = "Chem_Analytics";


// ─── Diagnostic helpers ───────────────────────────────────────────────────────
function DIAGNOSE_usagePricedRow() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const priced = ss.getSheetByName("Usage_Priced");
  const headers = priced.getRange(1, 1, 1, priced.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const poolCol = headers.indexOf("pool_id");
  const tsCol   = headers.indexOf("Timestamp");
  const lcCol   = headers.indexOf("Liquid Chlorine");

  const data = priced.getRange(2, 1, priced.getLastRow() - 1,
    priced.getLastColumn()).getValues();

  data.forEach((row, i) => {
    const pool = String(row[poolCol] || "").trim();
    const ts   = String(row[tsCol]   || "").trim();
    if (pool === "MCPS-0011") {
      Logger.log("Row " + (i+2) + " | ts: " + ts +
        " | Liquid Chlorine: " + (lcCol !== -1 ? row[lcCol] : "col not found"));
    }
  });
}

function DIAGNOSE_usagePricedHeaders() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const priced  = ss.getSheetByName("Usage_Priced");
  const headers = priced.getRange(1, 1, 1, priced.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());

  headers.forEach((h, i) => {
    if (h.toLowerCase().includes("chlorine") || h.toLowerCase().includes("liquid")) {
      Logger.log("Col " + (i+1) + ": " + JSON.stringify(h));
    }
  });

  const row18 = priced.getRange(18, 1, 1, priced.getLastColumn()).getValues()[0];
  headers.forEach((h, i) => {
    if (row18[i] && row18[i] !== "" && row18[i] !== 0) {
      Logger.log("Row 18 col " + (i+1) + " [" + h + "]: " + row18[i]);
    }
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────
function setupChemicalAnalytics() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let detail = ss.getSheetByName(CHEM_DETAIL_SHEET);
  if (!detail) detail = ss.insertSheet(CHEM_DETAIL_SHEET);

  let analytics = ss.getSheetByName(CHEM_ANALYTICS_SHEET);
  if (!analytics) analytics = ss.insertSheet(CHEM_ANALYTICS_SHEET);

  setupChemicalCostDetailSheet_(detail);
  rebuildChemicalCostDetail();
  rebuildChemAnalyticsReport();

  ss.toast("✅ Chemical analytics sheets created and rebuilt", "MCPS");
}

function setupChemicalCostDetailSheet_(sheet) {
  sheet.clear();

  const headers = [
    "Timestamp", "pool_id", "Client Name", "Address",
    "Service Type", "Chemical", "Qty", "Unit Cost",
    "Extended Cost", "Week Start", "WeekKey", "MonthKey"
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  sheet.autoResizeColumns(1, headers.length);
}
function getCustomerMasterLookup_() {
  const CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
  const crm = SpreadsheetApp.openById(CRM_SS_ID);

  const SHEETS_IN_PRIORITY = [
    "Signed_Customers",
    "Completed_One_Time",
    "Lost_Customers"
  ];

  const map = {};

  SHEETS_IN_PRIORITY.forEach(sheetName => {
    const sheet = crm.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;

    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h || "").trim());
    const col = name => headers.indexOf(name);

    const poolCol    = col("pool_id");
    const firstCol   = col("first_name");
    const lastCol    = col("last_name");
    const addressCol = col("address");
    const serviceCol = col("service");

    if (poolCol === -1) return;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const pid = String(row[poolCol] || "").trim();
      if (!pid) continue;

      // Keep first match only, since priority order matters
      if (map[pid]) continue;

      const first = firstCol !== -1 ? String(row[firstCol] || "").trim() : "";
      const last  = lastCol  !== -1 ? String(row[lastCol]  || "").trim() : "";
      const fullName = `${first} ${last}`.trim() || last || first;

      map[pid] = {
        client_name: fullName,
        address: addressCol !== -1 ? String(row[addressCol] || "").trim() : "",
        service_type: serviceCol !== -1 ? String(row[serviceCol] || "").trim() : "",
        source_sheet: sheetName
      };
    }
  });

  return map;
}
// ─── Rebuild Chemical_Cost_Detail ─────────────────────────────────────────────
function rebuildChemicalCostDetail() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const priced = ss.getSheetByName("Usage_Priced");
  const roll   = ss.getSheetByName("Chem_Cost_per_Pool");
  const customerLookup = getCustomerMasterLookup_();
  if (!priced) throw new Error("Missing Usage_Priced");
  if (!roll)   throw new Error("Missing Chem_Cost_per_Pool");

  let detail = ss.getSheetByName(CHEM_DETAIL_SHEET);
  if (!detail) detail = ss.insertSheet(CHEM_DETAIL_SHEET);

  setupChemicalCostDetailSheet_(detail);

  const pricedData = priced.getDataRange().getValues();
  if (pricedData.length < 2) return;

  const headers = pricedData[0].map(h => String(h || "").trim());

  const tsCol       = headers.indexOf("Timestamp");
  const poolCol     = headers.indexOf("pool_id");
  const weekStartCol = headers.indexOf("Week Start");
  const weekKeyCol  = headers.indexOf("WeekKey");
  const monthKeyCol = headers.indexOf("MonthKey");
  const voidedCol   = headers.indexOf("Voided");   // skip voided rows

  if (tsCol   === -1) throw new Error('Usage_Priced missing "Timestamp"');
  if (poolCol === -1) throw new Error('Usage_Priced missing "pool_id"');
  if (weekKeyCol === -1) throw new Error('Usage_Priced missing "WeekKey"');


  // Chemical name → columns mapping
  const chemSheet = ss.getSheetByName("Chem_Costs");
  if (!chemSheet) throw new Error("Missing Chem_Costs");

  const chemLastRow    = chemSheet.getLastRow();
  const chemicalNames  = chemLastRow >= 2
    ? chemSheet.getRange(2, 1, chemLastRow - 1, 1).getValues()
        .flat().map(v => String(v || "").trim()).filter(Boolean)
    : [];

  const legacyChemicalMap = buildLegacyAliasMap_();
  const chemCols = {};

  function addChemSource_(cleanName, qtyCol, unitCostCol) {
    if (qtyCol === -1) return;
    if (!chemCols[cleanName]) chemCols[cleanName] = [];
    const alreadyAdded = chemCols[cleanName].some(info => info.qtyCol === qtyCol);
    if (alreadyAdded) return;
    chemCols[cleanName].push({ qtyCol, unitCostCol });
  }

  chemicalNames.forEach(name => {
    const qtyCol     = headers.indexOf(name);
    const unitCostCol = headers.indexOf(`${name} Unit Cost (Snapshot)`);
    addChemSource_(name, qtyCol, unitCostCol);
  });

  Object.keys(legacyChemicalMap).forEach(oldName => {
    const cleanName  = legacyChemicalMap[oldName];
    const qtyCol     = headers.indexOf(oldName);
    const unitCostCol = headers.indexOf(`${oldName} Unit Cost (Snapshot)`);
    addChemSource_(cleanName, qtyCol, unitCostCol);
  });

  const rows = [];
  const tz   = ss.getSpreadsheetTimeZone();

  for (let i = 1; i < pricedData.length; i++) {
    const row = pricedData[i];

    // Skip voided rows
    if (voidedCol !== -1 && String(row[voidedCol] || "").trim().toLowerCase() === "yes") continue;

    const timestamp = row[tsCol];
    const poolId    = String(row[poolCol] || "").trim();
    const weekStart = weekStartCol !== -1 ? row[weekStartCol] : "";
    const weekKey   = row[weekKeyCol];

    let monthKey = "";
    if (monthKeyCol !== -1 && row[monthKeyCol]) {
      const rawMonth = row[monthKeyCol];
      if (Object.prototype.toString.call(rawMonth) === "[object Date]" && !isNaN(rawMonth)) {
        monthKey = Utilities.formatDate(rawMonth, tz, "yyyy-MM");
      } else {
        monthKey = String(rawMonth).trim();
      }
    } else {
      monthKey = Utilities.formatDate(new Date(timestamp), tz, "yyyy-MM");
    }

    if (!timestamp || !poolId) continue;

    const meta = customerLookup[poolId] || {};
    const clientName  = meta.client_name  || "";
    const address     = meta.address      || "";
    const serviceType = meta.service_type || "";

    Object.keys(chemCols).forEach(name => {
      const infos = chemCols[name];
      let totalQty = 0, totalCost = 0, lastUnitCost = 0;

      infos.forEach(info => {
        const qty = Number(row[info.qtyCol] || 0);
        if (!isFinite(qty) || qty === 0) return;
        const unitCost     = info.unitCostCol !== -1 ? Number(row[info.unitCostCol] || 0) : 0;
        totalQty  += qty;
        totalCost += qty * unitCost;
        if (unitCost) lastUnitCost = unitCost;
      });

      if (totalQty === 0) return;

      rows.push([
        timestamp, poolId, clientName, address, serviceType,
        name, totalQty, lastUnitCost, totalCost,
        weekStart, weekKey, monthKey
      ]);
    });
  }

  if (rows.length) {
    detail.getRange(2, 1, rows.length, 12).setValues(rows);
  }

  if (detail.getLastRow() > 1) {
    detail.getRange(2, 1,  detail.getLastRow() - 1, 1).setNumberFormat("m/d/yyyy h:mm am/pm");
    detail.getRange(2, 7,  detail.getLastRow() - 1, 1).setNumberFormat("0.00");
    detail.getRange(2, 8,  detail.getLastRow() - 1, 2).setNumberFormat("$0.00");
    detail.getRange(2, 10, detail.getLastRow() - 1, 1).setNumberFormat("m/d/yyyy");
  }

  detail.autoResizeColumns(1, 12);
}

// ─── Main analytics report (sheet) ───────────────────────────────────────────
function rebuildChemAnalyticsReport() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const detail = ss.getSheetByName("Chemical_Cost_Detail");
  let   sheet  = ss.getSheetByName("Chem_Analytics");

  if (!detail) throw new Error("Missing Chemical_Cost_Detail");
  if (!sheet)  sheet = ss.insertSheet("Chem_Analytics");

  const data = detail.getDataRange().getValues();
  if (data.length < 2) throw new Error("Chemical_Cost_Detail has no data");

  const headers = data[0].map(h => String(h || "").trim());
  const col     = name => headers.indexOf(name);

  const poolCol    = col("pool_id");
  const clientCol  = col("Client Name");
  const addressCol = col("Address");
  const serviceCol = col("Service Type");
  const chemCol    = col("Chemical");
  const qtyCol     = col("Qty");
  const costCol    = col("Extended Cost");
  const weekCol    = col("WeekKey");
  const monthCol   = col("MonthKey");

  const rows = data.slice(1);

  // Build aggregates split by serviceCategory (Startup vs Service)
  const weekly = {}, monthly = {}, weeklyChem = {}, monthlyChem = {}, weeklyPool = {};
  // Service-type split versions
  const weeklyByType = {};  // weeklyByType[type][weekKey] = { total, pools }

  rows.forEach(r => {
    const week    = String(r[weekCol] || "").trim();
    const service = String(r[serviceCol] || "").trim();
    const poolLabel_ = String(r[poolCol] || "").trim();
    const svcCat  = classifyServiceType_(service, poolLabel_); // "Startup" | "Service" | "Other"

    let month = "";
    const rawMonth = r[monthCol];
    if (Object.prototype.toString.call(rawMonth) === "[object Date]" && !isNaN(rawMonth)) {
      month = Utilities.formatDate(rawMonth, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM");
    } else {
      month = String(rawMonth || "").trim();
    }

    const pool    = String(r[poolCol]    || "").trim();
    const client  = String(r[clientCol]  || "").trim();
    const address = String(r[addressCol] || "").trim();
    const chem    = String(r[chemCol]    || "").trim();
    const qty     = Number(r[qtyCol]  || 0);
    const cost    = Number(r[costCol] || 0);

    if (!week || !month) return;

    // Overall weekly/monthly
    if (!weekly[week])  weekly[week]  = { total: 0, pools: new Set() };
    if (!monthly[month]) monthly[month] = { total: 0, pools: new Set() };
    weekly[week].total   += cost;
    weekly[week].pools.add(pool);
    monthly[month].total += cost;
    monthly[month].pools.add(pool);

    // By service type
    if (!weeklyByType[svcCat])          weeklyByType[svcCat] = {};
    if (!weeklyByType[svcCat][week])    weeklyByType[svcCat][week] = { total: 0, pools: new Set() };
    weeklyByType[svcCat][week].total += cost;
    weeklyByType[svcCat][week].pools.add(pool);

    // Chemical aggregates
    const wkChemKey = `${week}|${chem}`;
    if (!weeklyChem[wkChemKey]) weeklyChem[wkChemKey] = { week, chem, qty: 0, cost: 0 };
    weeklyChem[wkChemKey].qty  += qty;
    weeklyChem[wkChemKey].cost += cost;

    const moChemKey = `${month}|${chem}`;
    if (!monthlyChem[moChemKey]) monthlyChem[moChemKey] = { month, chem, qty: 0, cost: 0 };
    monthlyChem[moChemKey].qty  += qty;
    monthlyChem[moChemKey].cost += cost;

    // Pool weekly
    const wkPoolKey = `${week}|${pool}`;
    if (!weeklyPool[wkPoolKey]) {
      weeklyPool[wkPoolKey] = { week, pool, client, address, service, svcCat, cost: 0 };
    }
    weeklyPool[wkPoolKey].cost += cost;
  });

  const weekKeys  = Object.keys(weekly).sort((a,b) => parseWeekStart_(a) - parseWeekStart_(b));
  const monthKeys = Object.keys(monthly).sort();
  const latestWeek = weekKeys.length ? weekKeys[weekKeys.length - 1] : "";

  sheet.clear();
  let r = 1;

  // ── KPI cards (latest week) ────────────────────────────────────────────────
  sheet.getRange(r, 1).setValue("MCPS Chemical Analytics").setFontWeight("bold").setFontSize(14);
  r += 2;

  sheet.getRange(r, 1, 1, 6).setValues([[
    "Latest Week", "Pools Serviced", "Total Chem Cost",
    "Cost per Pool", "Top Chemical This Week", "Top Pool This Week"
  ]]).setFontWeight("bold");

  const latestWeekPools  = latestWeek ? weekly[latestWeek].pools.size : 0;
  const latestWeekTotal  = latestWeek ? weekly[latestWeek].total      : 0;
  const latestWeekCPP    = latestWeekPools ? latestWeekTotal / latestWeekPools : 0;

  const latestWeekChemItems = Object.values(weeklyChem)
    .filter(x => x.week === latestWeek).sort((a,b) => b.cost - a.cost);
  const latestWeekPoolItems = Object.values(weeklyPool)
    .filter(x => x.week === latestWeek).sort((a,b) => b.cost - a.cost);

  const topChem = latestWeekChemItems[0];
  const topPool = latestWeekPoolItems[0];

  sheet.getRange(r+1, 1, 1, 6).setValues([[
    latestWeek, latestWeekPools, latestWeekTotal, latestWeekCPP,
    topChem ? `${topChem.chem} ($${topChem.cost.toFixed(2)})` : "",
    topPool ? `${topPool.client ? topPool.client + " (" + topPool.pool + ")" : topPool.pool} ($${topPool.cost.toFixed(2)})` : ""
  ]]);
  sheet.getRange(r+1, 3, 1, 2).setNumberFormat("$0.00");
  r += 4;

  // ── Service-type split summary ────────────────────────────────────────────
  sheet.getRange(r, 1).setValue("Weekly Costs by Service Type").setFontWeight("bold").setFontSize(12);
  r += 2;

  sheet.getRange(r, 1, 1, 5).setValues([[
    "Week", "Service Type", "Pools Serviced", "Total Chem Cost", "Cost per Pool"
  ]]).setFontWeight("bold");
  r++;

  const svcTypeStart = r;
  weekKeys.forEach(w => {
    ["Startup", "Service", "Other"].forEach(type => {
      const bucket = (weeklyByType[type] || {})[w];
      if (!bucket || bucket.total === 0) return;
      const pools = bucket.pools.size;
      const total = bucket.total;
      const cpp   = pools ? total / pools : 0;
      sheet.getRange(r, 1, 1, 5).setValues([[w, type, pools, total, cpp]]);
      r++;
    });
    sheet.getRange(r, 1, 1, 5).setValues([["","","","",""]]);
    r++;
  });
  const svcTypeRows = r - svcTypeStart;
  if (svcTypeRows > 0) {
    sheet.getRange(svcTypeStart, 4, svcTypeRows, 2).setNumberFormat("$0.00");
  }
  r += 2;

  // ── Weekly overall summary ────────────────────────────────────────────────
  const weeklySummaryHeaderRow = r;
  sheet.getRange(r, 1, 1, 6).setValues([[
    "Week", "Pools Serviced", "Total Chem Cost", "Cost per Pool", "WoW $ Change", "WoW % Change"
  ]]).setFontWeight("bold");
  r++;

  let prevTotal = null;
  weekKeys.forEach(w => {
    const total = weekly[w].total;
    const pools = weekly[w].pools.size;
    const cpp   = pools ? total / pools : 0;
    const wow   = prevTotal == null ? "" : total - prevTotal;
    const wowPct= prevTotal == null || prevTotal === 0 ? "" : (total - prevTotal) / prevTotal;
    sheet.getRange(r, 1, 1, 6).setValues([[w, pools, total, cpp, wow, wowPct]]);
    prevTotal = total;
    r++;
  });

  const wSumDataStart = weeklySummaryHeaderRow + 1;
  const wSumRows = r - wSumDataStart;
  if (wSumRows > 0) {
    sheet.getRange(wSumDataStart, 3, wSumRows, 3).setNumberFormat("$0.00");
    sheet.getRange(wSumDataStart, 6, wSumRows, 1).setNumberFormat("0.0%");
  }
  r += 2;

  // ── Monthly summary ───────────────────────────────────────────────────────
  const monthlySummaryHeaderRow = r;
  sheet.getRange(r, 1, 1, 4).setValues([[
    "Month", "Pools Serviced", "Total Chem Cost", "Cost per Pool"
  ]]).setFontWeight("bold");
  r++;

  monthKeys.forEach(m => {
    const total = monthly[m].total;
    const pools = monthly[m].pools.size;
    const cpp   = pools ? total / pools : 0;
    sheet.getRange(r, 1, 1, 4).setValues([[m, pools, total, cpp]]);
    r++;
  });

  const mSumDataStart = monthlySummaryHeaderRow + 1;
  const mSumRows      = r - mSumDataStart;
  if (mSumRows > 0) {
    sheet.getRange(mSumDataStart, 3, mSumRows, 2).setNumberFormat("$0.00");
  }
  r += 2;

  // ── Top 5 pools this week ─────────────────────────────────────────────────
  sheet.getRange(r, 1).setValue("Top 5 Highest-Cost Pools This Week").setFontWeight("bold");
  r++;
  sheet.getRange(r, 1, 1, 6).setValues([[
    "Week", "pool_id", "Client / Address", "Service Type", "Category", "Pool Chem Cost"
  ]]).setFontWeight("bold");
  r++;

  const topPoolStart = r;
  latestWeekPoolItems.slice(0, 5).forEach(x => {
    sheet.getRange(r, 1, 1, 6).setValues([[
      x.week, x.pool, `${x.client} / ${x.address}`, x.service, x.svcCat, x.cost
    ]]);
    r++;
  });
  if (r - topPoolStart > 0) sheet.getRange(topPoolStart, 6, r - topPoolStart, 1).setNumberFormat("$0.00");
  r += 2;

  // ── Top 5 chemicals this week ─────────────────────────────────────────────
  sheet.getRange(r, 1).setValue("Top 5 Highest-Cost Chemicals This Week").setFontWeight("bold");
  r++;
  sheet.getRange(r, 1, 1, 4).setValues([["Week","Chemical","Qty","Cost"]]).setFontWeight("bold");
  r++;

  const topChemStart = r;
  latestWeekChemItems.slice(0, 5).forEach(x => {
    sheet.getRange(r, 1, 1, 4).setValues([[x.week, x.chem, x.qty, x.cost]]);
    r++;
  });
  if (r - topChemStart > 0) {
    sheet.getRange(topChemStart, 3, r - topChemStart, 1).setNumberFormat("0.00");
    sheet.getRange(topChemStart, 4, r - topChemStart, 1).setNumberFormat("$0.00");
  }
  r += 2;

  // ── Weekly chemical usage breakdown ──────────────────────────────────────
  sheet.getRange(r, 1, 1, 4).setValues([["Week","Chemical","Qty","Cost"]]).setFontWeight("bold");
  r++;
  const weeklyChemStart = r;
  weekKeys.forEach(w => {
    Object.values(weeklyChem).filter(x => x.week === w).sort((a,b) => b.cost - a.cost).forEach(x => {
      sheet.getRange(r, 1, 1, 4).setValues([[x.week, x.chem, x.qty, x.cost]]);
      r++;
    });
    sheet.getRange(r, 1, 1, 4).setValues([["","","",""]]);
    r++;
  });
  if (r - weeklyChemStart > 0) {
    sheet.getRange(weeklyChemStart, 3, r - weeklyChemStart, 1).setNumberFormat("0.00");
    sheet.getRange(weeklyChemStart, 4, r - weeklyChemStart, 1).setNumberFormat("$0.00");
  }
  r++;

  // ── Weekly pool breakdown ─────────────────────────────────────────────────
  sheet.getRange(r, 1, 1, 6).setValues([[
    "Week","pool_id","Client / Address","Service Type","Category","Pool Chem Cost"
  ]]).setFontWeight("bold");
  r++;
  const weeklyPoolStart = r;
  weekKeys.forEach(w => {
    Object.values(weeklyPool).filter(x => x.week === w).sort((a,b) => b.cost - a.cost).forEach(x => {
      sheet.getRange(r, 1, 1, 6).setValues([[
        x.week, x.pool, `${x.client} / ${x.address}`, x.service, x.svcCat, x.cost
      ]]);
      r++;
    });
    sheet.getRange(r, 1, 1, 6).setValues([["","","","","",""]]);
    r++;
  });
  if (r - weeklyPoolStart > 0) {
    sheet.getRange(weeklyPoolStart, 6, r - weeklyPoolStart, 1).setNumberFormat("$0.00");
  }
  r++;

  // ── Monthly chemical usage ────────────────────────────────────────────────
  sheet.getRange(r, 1, 1, 4).setValues([["Month","Chemical","Qty","Cost"]]).setFontWeight("bold");
  r++;
  const monthlyChemStart = r;
  monthKeys.forEach(m => {
    Object.values(monthlyChem).filter(x => x.month === m).sort((a,b) => b.cost - a.cost).forEach(x => {
      sheet.getRange(r, 1, 1, 4).setValues([[m, x.chem, x.qty, x.cost]]);
      r++;
    });
    sheet.getRange(r, 1, 1, 4).setValues([["","","",""]]);
    r++;
  });
  if (r - monthlyChemStart > 0) {
    sheet.getRange(monthlyChemStart, 3, r - monthlyChemStart, 1).setNumberFormat("0.00");
    sheet.getRange(monthlyChemStart, 4, r - monthlyChemStart, 1).setNumberFormat("$0.00");
  }

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(1, 1, lastRow, 10).setVerticalAlignment("middle");
    sheet.getRange(1, 1, lastRow, 10).setWrap(true);
  }
  sheet.autoResizeColumns(1, 10);
}

// ─── KPI Snapshot API (for sidebar) ──────────────────────────────────────────

/**
 * Returns all available week keys, sorted ascending.
 * Called by ChemAdminUI to populate the week picker.
 */
function getAvailableWeeks() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const detail = ss.getSheetByName(CHEM_DETAIL_SHEET);
  if (!detail || detail.getLastRow() < 2) return [];

  const headers  = detail.getRange(1, 1, 1, detail.getLastColumn())
    .getValues()[0].map(h => String(h || "").trim());
  const weekCol  = headers.indexOf("WeekKey");
  if (weekCol === -1) return [];

  const vals = detail.getRange(2, weekCol + 1, detail.getLastRow() - 1, 1)
    .getValues().flat().map(v => String(v || "").trim()).filter(Boolean);

  return [...new Set(vals)].sort((a,b) => parseWeekStart_(a) - parseWeekStart_(b));
}

/**
 * Returns a full KPI snapshot for a given weekKey, optionally filtered by
 * serviceFilter: "all" | "Startup" | "Service" | "Other"
 */
function getWeeklyKpiSnapshot(weekKey, serviceFilter) {
  serviceFilter = serviceFilter || "all";

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const detail = ss.getSheetByName(CHEM_DETAIL_SHEET);
  if (!detail || detail.getLastRow() < 2) {
    return { weekKey, noData: true };
  }

  const data    = detail.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());

  const col = name => headers.indexOf(name);

  const poolCol    = col("pool_id");
  const clientCol  = col("Client Name");
  const addressCol = col("Address");
  const serviceCol = col("Service Type");
  const chemCol    = col("Chemical");
  const qtyCol     = col("Qty");
  const costCol    = col("Extended Cost");
  const weekCol    = col("WeekKey");

  const rows = data.slice(1).filter(r => {
    if (String(r[weekCol] || "").trim() !== weekKey) return false;
    if (serviceFilter === "all") return true;
    const svcCat = classifyServiceType_(String(r[serviceCol] || "").trim(), String(r[poolCol] || "").trim());
    return svcCat === serviceFilter;
  });

  if (!rows.length) return { weekKey, noData: true, serviceFilter };

  const poolTotals = {}, chemTotals = {};
  let grandTotal = 0;
  const poolSet  = new Set();

  rows.forEach(r => {
    const pool   = String(r[poolCol]   || "").trim();
    const client = String(r[clientCol] || "").trim();
    const addr   = String(r[addressCol]|| "").trim();
    const svc    = String(r[serviceCol]|| "").trim();
    const chem   = String(r[chemCol]   || "").trim();
    const qty    = Number(r[qtyCol]  || 0);
    const cost   = Number(r[costCol] || 0);

    poolSet.add(pool);
    grandTotal += cost;

    if (!poolTotals[pool]) poolTotals[pool] = { pool, client, addr, svc, cost: 0 };
    poolTotals[pool].cost += cost;

    if (!chemTotals[chem]) chemTotals[chem] = { chem, qty: 0, cost: 0 };
    chemTotals[chem].qty  += qty;
    chemTotals[chem].cost += cost;
  });

  const poolCount    = poolSet.size;
  const costPerPool  = poolCount ? grandTotal / poolCount : 0;

  const topPools = Object.values(poolTotals).sort((a,b) => b.cost - a.cost).slice(0, 5);
  const topChems = Object.values(chemTotals).sort((a,b) => b.cost - a.cost).slice(0, 5);
  const allChems = Object.values(chemTotals).sort((a,b) => b.cost - a.cost);

  // Service type breakdown within this week
  const byType = {};
  data.slice(1).filter(r => String(r[weekCol] || "").trim() === weekKey).forEach(r => {
    const pool_sb = String(r[poolCol] || "").trim();
    const svcCat = classifyServiceType_(String(r[serviceCol] || "").trim(), pool_sb);
    const cost   = Number(r[costCol] || 0);
    const pool   = pool_sb;
    if (!byType[svcCat]) byType[svcCat] = { total: 0, pools: new Set() };
    byType[svcCat].total += cost;
    byType[svcCat].pools.add(pool);
  });

  const serviceBreakdown = Object.keys(byType).map(type => ({
    type,
    total : byType[type].total,
    pools : byType[type].pools.size,
    pct   : grandTotal ? byType[type].total / grandTotal : 0
  })).sort((a,b) => b.total - a.total);

  return {
    weekKey,
    serviceFilter,
    poolCount,
    grandTotal,
    costPerPool,
    topPools,
    topChems,
    allChems,
    serviceBreakdown,
    noData: false
  };
}

// ─── Utility: classify using both the Service Type column value AND pool_id label ─
// Pass serviceColValue (from the "Service Type" column on the pool record)
// Classifies a service type using the Service Type column value and/or pool_id label.
// Known exact values:
//   Startup  → "Pool Startup"
//   Service  → "Weekly Full Service", "Bi-Weekly Full Service", "Monthly Full Service", etc.
// Either source is sufficient — checks both for robustness.
function classifyServiceType_(serviceColValue, poolIdLabel) {
  const svc   = String(serviceColValue || "").toLowerCase().trim();
  const label = String(poolIdLabel     || "").toLowerCase().trim();

  // "Pool Startup" is the canonical startup value; also catch any future variants
  const isStartup =
    svc   === "pool startup"    ||
    svc.includes("startup")     || svc.includes("start up")  || svc.includes("new pool") ||
    label.includes("pool startup") || label.includes("startup") ||
    label.includes("start up")  || label.includes("new pool");

  if (isStartup) return "Startup";

  // "Weekly Full Service", "Bi-Weekly Full Service", "Monthly Full Service", etc.
  const isService =
    svc.includes("weekly")      || svc.includes("monthly")    ||
    svc.includes("bi-weekly")   || svc.includes("biweekly")   ||
    svc.includes("full service") || svc.includes("service")   ||
    svc.includes("one time")    || svc.includes("one-time")   ||
    label.includes("weekly")    || label.includes("monthly")  ||
    label.includes("bi-weekly") || label.includes("full service") ||
    label.includes("service")   || label.includes("one time") ||
    label.includes("one-time");

  if (isService) return "Service";
  return "Other";
}

// ─── Refresh entry point ──────────────────────────────────────────────────────
function refreshChemicalAnalytics() {
  rebuildChemicalCostDetail();
  rebuildChemAnalyticsReport();
  SpreadsheetApp.getActiveSpreadsheet().toast("✅ Chemical analytics refreshed", "MCPS");
}

function parseWeekStart_(weekKey) {
  const m = String(weekKey || "").match(/^(\d{1,2})\/(\d{1,2})-/);
  if (!m) return new Date(0);
  const year = new Date().getFullYear();
  return new Date(year, Number(m[1]) - 1, Number(m[2]));
}

// ─── Legacy alias map ─────────────────────────────────────────────────────────
function buildLegacyAliasMap_() {
  const base = {
    "1 QUART SCALE-OFF TILE CLEANER RED"              : "Scale-Off Tile Cleaner",
    "LTD QTY - 1 GALLON HASA LIQUID CHLORINE"         : "Liquid Chlorine",
    "HAZMAT 4 X 1 GALLON HASA MURIATIC ACID"          : "Muriatic Acid",
    "64 OZ MCGRAYEL ALGATEC SUPER ALGAECIDE"          : "Algaecide",
    "64 OZ MCGRAYEL SCALETEC PLUS CALCIUM POOL"       : "ScaleTec (Calcium Remover)",
    "64 OZ MCGRAYEL STARTUP TEC NEW POOL"             : "Startup-Tec",
    'HAZMAT 50 LB POOL BREEZE 3" CHLORINATING TABLETS': 'Chlorine Tablets (3")',
    "10 LB POOL BREEZE TOTAL ALKALINITY"              : "Alkalinity Increaser",
    "8 LB BREEZE CALCIUM HARDNESS INCREASER"          : "Calcium Hardness Increaser",
    "100 LB CONDITIONER CYANURIC ACID GRANULAR"       : "Cyanuric Acid (Stabilizer)",
    "Liquid Chlorine"                                 : "Liquid Chlorine",
    "Muriatic Acid"                                   : "Muriatic Acid",
    "Cyanuric Acid (Stabilizer)"                      : "Cyanuric Acid (Stabilizer)",
    'Chlorine Tablets (3")'                           : 'Chlorine Tablets (3")',
    "ScaleTec (Calcium Remover)"                      : "ScaleTec (Calcium Remover)",
    "Startup-Tec"                                     : "Startup-Tec",
    "Calcium Hardness Increaser"                      : "Calcium Hardness Increaser",
    "Algaecide"                                       : "Algaecide",
    "Alkalinity Increaser"                            : "Alkalinity Increaser",
    "Scale-Off Tile Cleaner"                          : "Scale-Off Tile Cleaner"
  };

  try {
    const ss         = SpreadsheetApp.getActiveSpreadsheet();
    const aliasSheet = ss.getSheetByName("Chem_Aliases");
    if (aliasSheet && aliasSheet.getLastRow() >= 2) {
      aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, 2).getValues()
        .forEach(function(r) {
          const oldName = String(r[0] || "").trim();
          const newName = String(r[1] || "").trim();
          if (oldName && newName) base[oldName] = newName;
        });
    }
  } catch(e) {
    Logger.log("buildLegacyAliasMap_ warning: " + e);
  }

  return base;
}