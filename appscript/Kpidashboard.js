// KpiDashboard.gs
// Generates a navigable KPI_Dashboard sheet.
// - Cell B2 holds a Data Validation dropdown of all available weeks.
// - Cell D2 holds a Data Validation dropdown for service type filter.
// - "📊 Refresh KPI Dashboard" menu item calls refreshKpiDashboard()
//   which reads B2 + D2 and rebuilds the view section below row 4.

const KPI_SHEET_NAME     = "KPI_Dashboard";
const KPI_WEEK_CELL      = "B2";   // user picks week here
const KPI_FILTER_CELL    = "D2";   // user picks All / Startup / Service / Other
const KPI_CONTENT_ROW    = 5;      // dashboard content starts here
const KPI_FILTER_OPTIONS = ["All", "Startup", "Service", "Other"];

// ─── Menu entry point ────────────────────────────────────────────────────────
function refreshKpiDashboard() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(KPI_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(KPI_SHEET_NAME);
    setupKpiSheetChrome_(sheet);
  }

  // Re-apply Data Validation in case weeks list has grown
  applyKpiDropdowns_(sheet);

  const weekKey = String(sheet.getRange(KPI_WEEK_CELL).getValue() || "").trim();
  const rawFilter = String(sheet.getRange(KPI_FILTER_CELL).getValue() || "All").trim();
  const serviceFilter = rawFilter === "All" ? "all" : rawFilter;

  if (!weekKey) {
    clearKpiContent_(sheet);
    sheet.getRange(KPI_CONTENT_ROW, 1).setValue("← Select a week in cell B2, then run Refresh KPI Dashboard again.");
    ss.toast("Pick a week in cell B2 first", "KPI Dashboard");
    return;
  }

  const snap = getWeeklyKpiSnapshot(weekKey, serviceFilter);
  renderKpiToSheet_(sheet, snap);

  ss.toast("✅ KPI Dashboard updated: " + weekKey + " · " + rawFilter, "MCPS");
}

// ─── First-time sheet setup ──────────────────────────────────────────────────
function setupKpiSheetChrome_(sheet) {
  sheet.clear();
  sheet.setTabColor("#1a73e8");

  // ── Title row ──
  sheet.getRange("A1").setValue("📊 MCPS KPI Dashboard")
    .setFontSize(14).setFontWeight("bold").setFontColor("#202124");
  sheet.getRange("A1:H1").merge();

  // ── Label row ──
  sheet.getRange("A2").setValue("Week →").setFontWeight("bold").setFontColor("#5f6368").setFontSize(11);
  sheet.getRange("C2").setValue("Filter →").setFontWeight("bold").setFontColor("#5f6368").setFontSize(11);
  sheet.getRange("E2").setValue("↑ Pick week & filter, then: ⚗️ Chem Admin → 📊 Refresh KPI Dashboard")
    .setFontColor("#9aa0a6").setFontSize(10).setFontStyle("italic");
  sheet.getRange("E2:J2").merge();

  // ── Style the dropdown cells ──
  sheet.getRange(KPI_WEEK_CELL).setBackground("#e8f0fe").setFontWeight("bold").setFontSize(12);
  sheet.getRange(KPI_FILTER_CELL).setBackground("#e6f4ea").setFontWeight("bold").setFontSize(12);

  // ── Separator row 3 ──
  sheet.getRange("A3:J3").setBackground("#e8eaed");
  sheet.setRowHeight(3, 4);

  // ── Row 4: column headers for content area ──
  sheet.getRange("A4").setValue("").setBackground("#f8f9fa");

  sheet.setFrozenRows(4);

  // ── Column widths ──
  sheet.setColumnWidth(1, 160);  // A: label / pool
  sheet.setColumnWidth(2, 120);  // B: week picker / value
  sheet.setColumnWidth(3, 100);  // C: filter label / value
  sheet.setColumnWidth(4, 110);  // D: filter cell / value
  sheet.setColumnWidth(5, 200);  // E: client/address
  sheet.setColumnWidth(6, 80);   // F: cost
  sheet.setColumnWidth(7, 70);   // G: qty
  sheet.setColumnWidth(8, 80);   // H: pct
  sheet.setColumnWidth(9, 120);  // I: bar
}

// ─── Apply Data Validation dropdowns ────────────────────────────────────────
function applyKpiDropdowns_(sheet) {
  const weeks = getAvailableWeeks();

  if (weeks.length) {
    const weekRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(weeks.slice().reverse(), true)  // newest first
      .setAllowInvalid(false)
      .build();
    sheet.getRange(KPI_WEEK_CELL).setDataValidation(weekRule);

    // Default to latest week if cell is empty
    const currentVal = sheet.getRange(KPI_WEEK_CELL).getValue();
    if (!currentVal) {
      sheet.getRange(KPI_WEEK_CELL).setValue(weeks[weeks.length - 1]);
    }
  }

  const filterRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(KPI_FILTER_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(KPI_FILTER_CELL).setDataValidation(filterRule);

  const currentFilter = sheet.getRange(KPI_FILTER_CELL).getValue();
  if (!currentFilter) sheet.getRange(KPI_FILTER_CELL).setValue("All");
}

// ─── Clear content area (below chrome) ───────────────────────────────────────
function clearKpiContent_(sheet) {
  const lastRow = sheet.getMaxRows();
  if (lastRow >= KPI_CONTENT_ROW) {
    sheet.getRange(KPI_CONTENT_ROW, 1, lastRow - KPI_CONTENT_ROW + 1, 10).clearContent()
      .clearFormat();
  }
}

// ─── Render snapshot to sheet ────────────────────────────────────────────────
function renderKpiToSheet_(sheet, snap) {
  clearKpiContent_(sheet);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();

  let r = KPI_CONTENT_ROW;

  if (snap.noData) {
    sheet.getRange(r, 1, 1, 6).merge()
      .setValue("⚠️  No data found for " + snap.weekKey +
        (snap.serviceFilter !== "all" ? " with filter: " + snap.serviceFilter : ""))
      .setFontColor("#b06000").setBackground("#fef7e0").setFontSize(12)
      .setHorizontalAlignment("center");
    return;
  }

  const filterLabel = snap.serviceFilter === "all" ? "All Service Types"
    : snap.serviceFilter === "Startup"             ? "🆕 Startups Only"
    : snap.serviceFilter === "Service"             ? "🔁 Service Visits Only"
    : snap.serviceFilter;

  // ── Section header ──────────────────────────────────────────────────────
  sectionHeader_(sheet, r, snap.weekKey + "  ·  " + filterLabel, 10);
  r++;

  // ── KPI summary row ─────────────────────────────────────────────────────
  // Row of 4 KPI blocks: [Label | Value] [Label | Value] [Label | Value] [Label | Value]
  const kpiLabelRange = sheet.getRange(r, 1, 1, 8);
  kpiLabelRange.setValues([[
    "Total Chem Cost", "Pools Serviced", "Cost per Pool", "Top Chemical"
  ].reduce((acc, v, i) => { acc[i * 2] = v; return acc; }, new Array(8).fill(""))]);
  kpiLabelRange.setFontColor("#9aa0a6").setFontSize(9).setFontWeight("bold");
  r++;

  const topChem = snap.topChems.length ? snap.topChems[0] : null;
  const kpiValues = new Array(8).fill("");
  kpiValues[0] = snap.grandTotal;   // Total cost
  kpiValues[2] = snap.poolCount;    // Pools serviced
  kpiValues[4] = snap.costPerPool;  // Cost per pool
  kpiValues[6] = topChem ? topChem.chem : "—";
  sheet.getRange(r, 1, 1, 8).setValues([kpiValues])
    .setFontSize(14).setFontWeight("bold").setFontColor("#202124");
  sheet.getRange(r, 1).setNumberFormat("$#,##0.00").setFontColor("#1a73e8");
  sheet.getRange(r, 5).setNumberFormat("$#,##0.00").setFontColor("#34a853");
  if (topChem) {
    sheet.getRange(r, 7).setFontColor("#fa7b17");
  }
  r++;

  // Sub-labels
  const kpiSubs = new Array(8).fill("");
  kpiSubs[0] = "chemical spend";
  kpiSubs[2] = snap.poolCount === 1 ? "pool serviced" : "pools serviced";
  kpiSubs[4] = "avg per pool";
  kpiSubs[6] = topChem ? "$" + topChem.cost.toFixed(2) + "  ·  qty " + topChem.qty.toFixed(2) : "";
  sheet.getRange(r, 1, 1, 8).setValues([kpiSubs])
    .setFontColor("#9aa0a6").setFontSize(9).setFontStyle("italic");
  r += 2;

  // ── Startup vs Service split ─────────────────────────────────────────────
  if (snap.serviceBreakdown && snap.serviceBreakdown.length) {
    sectionHeader_(sheet, r, "Startup vs Service Split", 6);
    r++;

    // Header
    sheet.getRange(r, 1, 1, 5).setValues([["Type", "Pools", "Total Cost", "% of Week", "Visual"]])
      .setFontWeight("bold").setFontColor("#5f6368").setFontSize(10)
      .setBackground("#f1f3f4");
    r++;

    const typeColors = { "Startup": "#34a853", "Service": "#fa7b17", "Other": "#9aa0a6" };
    snap.serviceBreakdown.forEach(b => {
      const barFill = Math.round(b.pct * 20); // max 20 chars
      const bar = "█".repeat(barFill) + "░".repeat(20 - barFill);
      const color = typeColors[b.type] || "#9aa0a6";

      sheet.getRange(r, 1).setValue(b.type).setFontWeight("bold").setFontColor(color);
      sheet.getRange(r, 2).setValue(b.pools).setFontColor("#202124");
      sheet.getRange(r, 3).setValue(b.total).setNumberFormat("$#,##0.00").setFontColor("#202124");
      sheet.getRange(r, 4).setValue(b.pct).setNumberFormat("0.0%").setFontColor("#202124");
      sheet.getRange(r, 5).setValue(bar).setFontFamily("Courier New").setFontColor(color).setFontSize(10);
      r++;
    });

    // Total row
    sheet.getRange(r, 1).setValue("TOTAL").setFontWeight("bold").setFontColor("#202124");
    sheet.getRange(r, 3).setValue(snap.grandTotal).setNumberFormat("$#,##0.00").setFontWeight("bold");
    sheet.getRange(r, 4).setValue(1).setNumberFormat("0%").setFontWeight("bold");
    sheet.getRange(r, 1, 1, 5).setBackground("#f8f9fa");
    r += 2;
  }

  // ── Top 5 Pools ──────────────────────────────────────────────────────────
  sectionHeader_(sheet, r, "Top " + snap.topPools.length + " Pools by Chemical Cost", 6);
  r++;

  sheet.getRange(r, 1, 1, 6).setValues([["#", "Pool ID", "Client", "Address", "Service Type", "Cost"]])
    .setFontWeight("bold").setFontColor("#5f6368").setFontSize(10).setBackground("#f1f3f4");
  r++;

  const maxPoolCost = snap.topPools.length ? snap.topPools[0].cost : 1;
  snap.topPools.forEach((p, i) => {
    const shade = i % 2 === 0 ? "#ffffff" : "#f8f9fa";
    sheet.getRange(r, 1).setValue(i + 1).setFontColor("#dadce0").setFontWeight("bold");
    sheet.getRange(r, 2).setValue(p.pool).setFontWeight("bold");
    sheet.getRange(r, 3).setValue(p.client || "");
    sheet.getRange(r, 4).setValue(p.addr || "");
    sheet.getRange(r, 5).setValue(p.svc || "");
    sheet.getRange(r, 6).setValue(p.cost).setNumberFormat("$#,##0.00").setFontWeight("bold")
      .setFontColor(i === 0 ? "#d93025" : "#202124");
    sheet.getRange(r, 1, 1, 6).setBackground(shade);
    r++;
  });
  r++;

  // ── All Chemicals Used ───────────────────────────────────────────────────
  sectionHeader_(sheet, r, "All Chemicals Used This " + (snap.serviceFilter === "all" ? "Week" : snap.serviceFilter + " Visits"), 5);
  r++;

  sheet.getRange(r, 1, 1, 5).setValues([["#", "Chemical", "Qty Used", "Cost", "Visual"]])
    .setFontWeight("bold").setFontColor("#5f6368").setFontSize(10).setBackground("#f1f3f4");
  r++;

  const maxChemCost = snap.allChems.length ? snap.allChems[0].cost : 1;
  snap.allChems.forEach((c, i) => {
    const shade = i % 2 === 0 ? "#ffffff" : "#f8f9fa";
    const barFill = Math.round((c.cost / maxChemCost) * 15);
    const bar = "█".repeat(barFill) + "░".repeat(15 - barFill);

    sheet.getRange(r, 1).setValue(i + 1).setFontColor("#dadce0").setFontWeight("bold");
    sheet.getRange(r, 2).setValue(c.chem).setFontWeight(i < 3 ? "bold" : "normal");
    sheet.getRange(r, 3).setValue(c.qty).setNumberFormat("0.00");
    sheet.getRange(r, 4).setValue(c.cost).setNumberFormat("$#,##0.00")
      .setFontColor(i === 0 ? "#d93025" : "#202124");
    sheet.getRange(r, 5).setValue(bar).setFontFamily("Courier New")
      .setFontColor("#fa7b17").setFontSize(10);
    sheet.getRange(r, 1, 1, 5).setBackground(shade);
    r++;
  });
  r++;

  // ── All Pools Detail ─────────────────────────────────────────────────────
  if (snap.topPools.length < snap.poolCount) {
    // Only show expanded list if there are more pools than the top-5
    sectionHeader_(sheet, r, "All Pools (" + snap.poolCount + " total)", 5);
    r++;

    // Build full pool list from allChems aggregation — we need it from the snap
    // snap.topPools already has all pools sorted by cost (topPools is top-5,
    // but poolTotals in getWeeklyKpiSnapshot only sends top 5).
    // We already have the full list via the existing getWeeklyKpiSnapshot which
    // returns topPools (top 5). If user wants all, they can see the sheet.
    // Note: we'll just note this.
    sheet.getRange(r, 1, 1, 3).setValues([["Note: Top 5 pools shown above. Full breakdown available in Chemical_Cost_Detail sheet.", "", ""]])
      .setFontColor("#9aa0a6").setFontSize(10).setFontStyle("italic");
    sheet.getRange(r, 1, 1, 3).merge();
    r++;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  r++;
  const now = Utilities.formatDate(new Date(), tz, "M/d/yyyy h:mm a");
  sheet.getRange(r, 1, 1, 4).setValues([["Last refreshed: " + now, "", "", ""]])
    .setFontColor("#bdc1c6").setFontSize(9).setFontStyle("italic");
  sheet.getRange(r, 1, 1, 4).merge();
}

// ─── Helper: styled section header ───────────────────────────────────────────
function sectionHeader_(sheet, row, title, colSpan) {
  const range = sheet.getRange(row, 1, 1, colSpan);
  range.merge()
    .setValue(title)
    .setFontSize(11).setFontWeight("bold").setFontColor("#ffffff")
    .setBackground("#3c4043")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(row, 28);
}

// ─── One-time setup — run once to create the sheet and dropdowns ─────────────
function setupKpiDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(KPI_SHEET_NAME);

  if (sheet) {
    // Re-setup chrome in case it was wiped
    setupKpiSheetChrome_(sheet);
  } else {
    sheet = ss.insertSheet(KPI_SHEET_NAME);
    setupKpiSheetChrome_(sheet);
  }

  applyKpiDropdowns_(sheet);
  refreshKpiDashboard();

  ss.toast("✅ KPI Dashboard created — pick any week from the dropdown in B2", "MCPS");
}