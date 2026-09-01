// WeeklyDeck.gs
// Generates a branded weekly ops presentation in Google Slides.
// Data source: Chemical_Cost_Detail (already built by ChemicalAnalytics.gs)
//
// CONFIGURE THESE:
const DECK_COMPANY_NAME   = "Mission Custom Pool Solutions";
const DECK_RECIPIENT_1    = "mauricio@mcpoolsolutions.org";   // you
const DECK_RECIPIENT_2    = "mauriciorebazaf@gmail.com"; // head of ops — update this
const DECK_SLIDES_FOLDER  = "";  // Google Drive folder ID to save decks in (leave "" for root)

// Brand colors
const C_DARK    = "#1a1f2e";  // slide backgrounds
const C_BLUE    = "#1a73e8";  // primary accent
const C_GREEN   = "#34a853";  // startup / positive
const C_ORANGE  = "#fa7b17";  // service / warning
const C_RED     = "#d93025";  // alerts / high cost
const C_LIGHT   = "#f8f9fa";  // light backgrounds
const C_WHITE   = "#ffffff";
const C_MUTED   = "#aab2c0";
const C_CARD    = "#242b3b";  // card backgrounds on dark slides

// Slide dimensions (16:9 in points — Google Slides default)
const SW = 720;  // slide width
const SH = 405;  // slide height

// ─── Public entry points ──────────────────────────────────────────────────────
const DECK_LOGO_URL = "https://i.ibb.co/vx7vPB6p/logo.png";

function addLogoFromUrl_(slide, url, x, y, w, h) {
  try {
    slide.insertImage(url, x, y, w, h);
  } catch (e) {
    Logger.log("Logo insert warning: " + e);
  }
}

function addFooter_(slide, rightText) {
  addRect_(slide, 40, SH - 18, SW - 80, 1, "#31384a");

  addText_(slide, DECK_COMPANY_NAME, 40, SH - 16, 240, 10, {
    fontSize: 7,
    color: C_MUTED
  });

  addText_(slide, rightText || "Weekly Ops Report", SW - 220, SH - 16, 180, 10, {
    fontSize: 7,
    color: C_MUTED,
    align: SlidesApp.ParagraphAlignment.END
  });
}

function generateWeeklyDeckLatest() {
  const weeks = getAvailableWeeks();
  if (!weeks.length) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      "No week data found in Chemical_Cost_Detail",
      "Weekly Deck"
    );
    return;
  }

  const today = new Date();
  const isMonday = today.getDay() === 1;
  let weekKey;

  if (isMonday && weeks.length >= 2) {
    weekKey = weeks[weeks.length - 2];
  } else {
    weekKey = weeks[weeks.length - 1];
  }

  generateWeeklyDeck(weekKey);
}

/** Time-based trigger calls this every Monday morning */
function generateWeeklyDeckTrigger() {
  generateWeeklyDeckLatest();
}

/** Install the Monday 7am trigger (run once from menu) */
function installWeeklyDeckTrigger() {
  // Remove any existing deck triggers first
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "generateWeeklyDeckTrigger") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("generateWeeklyDeckTrigger")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();

  SpreadsheetApp.getActiveSpreadsheet().toast(
    "✅ Weekly deck will auto-generate every Monday at 7am", "Weekly Deck"
  );
}

// ─── Main builder ─────────────────────────────────────────────────────────────

function generateWeeklyDeck(weekKey) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast("⏳ Building weekly deck for " + weekKey + "…", "Weekly Deck");

  // ── Pull data ──────────────────────────────────────────────────────────────
  const snap    = getWeeklyKpiSnapshot(weekKey, "all");
  const snapSvc = getWeeklyKpiSnapshot(weekKey, "Service");
  const snapStu = getWeeklyKpiSnapshot(weekKey, "Startup");
  const snapOth = getWeeklyKpiSnapshot(weekKey, "Other");
  const prevSnap = getPreviousWeekSnapshot_(weekKey);
  // Muted directly in the Apps Script editor at some point and never mirrored into
  // git — found by diffing the live project on 2026-08-30. Preserved deliberately so
  // a deploy does not silently resume inventory alerts in the weekly deck. To turn
  // them back on, restore: getInventoryAlerts_()
  const invAlerts = []; // muted manually

  // WoW numbers
  const wowDelta  = prevSnap ? snap.grandTotal - prevSnap.grandTotal : null;
  const wowPct    = prevSnap && prevSnap.grandTotal
    ? (snap.grandTotal - prevSnap.grandTotal) / prevSnap.grandTotal
    : null;

  // ── Create presentation ────────────────────────────────────────────────────
  const title = DECK_COMPANY_NAME + " — Weekly Ops Report · " + weekKey;
  const pres  = SlidesApp.create(title);
  pres.getSlides()[0].remove(); // remove default blank slide

  // ── Build slides ───────────────────────────────────────────────────────────
  buildCoverSlide_(pres, weekKey, snap);
  buildExecSummarySlide_(pres, weekKey, snap, wowDelta, wowPct, prevSnap);
  buildSvcSplitSlide_(pres, snap, snapSvc, snapStu);
  buildTopPoolsSlide_(pres, snap, weekKey);
  buildChemUsageSlide_(pres, snap, weekKey);
  buildStartupDetailSlide_(pres, snapStu, weekKey);
  buildServiceDetailSlide_(pres, snapSvc, weekKey);
  buildOtherDetailSlide_(pres, snapOth, weekKey);
  if (invAlerts.length) buildInventoryAlertSlide_(pres, invAlerts);

  // ── Move to folder ─────────────────────────────────────────────────────────
  if (DECK_SLIDES_FOLDER) {
    try {
      const folder = DriveApp.getFolderById(DECK_SLIDES_FOLDER);
      const file   = DriveApp.getFileById(pres.getId());
      folder.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    } catch(e) {
      Logger.log("Folder move warning: " + e);
    }
  }

  const deckUrl = pres.getUrl();
  Logger.log("Deck created: " + deckUrl);

  // ── Email PDF ──────────────────────────────────────────────────────────────
  emailDeck_(pres, weekKey, snap, wowDelta, wowPct, deckUrl);

  ss.toast("✅ Weekly deck ready — emailed to ops team", "Weekly Deck");
  return deckUrl;
}

// ─── Slide builders ───────────────────────────────────────────────────────────

/** Slide 1: Cover */
function buildCoverSlide_(pres, weekKey, snap) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);

  // Logo
  addLogoFromUrl_(slide, DECK_LOGO_URL, 40, 36, 64, 64);

  // Company name
  addText_(slide, DECK_COMPANY_NAME, 118, 44, 360, 20, {
    fontSize: 14,
    bold: true,
    color: C_WHITE
  });

  // Small brand line
  addText_(slide, "WEEKLY OPERATIONS REPORT", 118, 66, 260, 16, {
    fontSize: 9,
    bold: true,
    color: C_BLUE
  });

  // Main title
  addText_(slide, "Weekly Ops Report", 40, 110, 360, 38, {
    fontSize: 26,
    bold: true,
    color: C_WHITE
  });

  // Subtitle
  addText_(slide, "Chemical performance, service activity, and inventory alerts", 40, 148, 420, 18, {
    fontSize: 10,
    color: "#94a3b8"
  });

  // Week pill
  addRect_(slide, 40, 182, 140, 26, "#1e293b");
  addText_(slide, weekKey, 40, 182, 140, 26, {
    fontSize: 10,
    bold: true,
    color: C_WHITE,
    align: SlidesApp.ParagraphAlignment.CENTER
  });

  // KPI cards
  const cards = [
    { label: "POOLS SERVICED", value: String(snap.poolCount) },
    { label: "TOTAL CHEM COST", value: "$" + snap.grandTotal.toFixed(2) },
    { label: "AVG PER POOL", value: "$" + snap.costPerPool.toFixed(2) }
  ];

  const cardW = 210;
  const cardH = 82;
  const startX = 40;
  const startY = 250;
  const gap = 15;

  cards.forEach((c, i) => {
    const x = startX + i * (cardW + gap);

    addRect_(slide, x, startY, cardW, cardH, "#1e293b");

    addText_(slide, c.label, x + 16, startY + 12, cardW - 32, 14, {
      fontSize: 8,
      color: "#94a3b8"
    });

    addText_(slide, c.value, x + 16, startY + 28, cardW - 32, 34, {
      fontSize: 21,
      bold: true,
      color: C_WHITE
    });
  });

  addFooter_(slide, "Automated Weekly Report");
}

/** Slide 2: Executive Summary */
function buildExecSummarySlide_(pres, weekKey, snap, wowDelta, wowPct, prevSnap) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Executive Summary", weekKey, C_BLUE);

  const isUp = wowDelta !== null && wowDelta > 0;
  const wowColor = wowDelta === null ? C_WHITE : (isUp ? C_RED : C_GREEN);

  // Main hero card
  addRect_(slide, 40, 74, SW - 80, 92, "#1e293b");
  addRect_(slide, 40, 74, 4, 92, C_BLUE);

  addText_(slide, "TOTAL CHEMICAL SPEND", 56, 88, 220, 14, {
    fontSize: 8,
    bold: true,
    color: "#94a3b8"
  });

  addText_(slide, "$" + snap.grandTotal.toFixed(2), 56, 106, 260, 34, {
    fontSize: 28,
    bold: true,
    color: C_WHITE
  });

  addText_(
    slide,
    prevSnap
      ? ((isUp ? "▲ " : "▼ ") +
         "$" + Math.abs(wowDelta).toFixed(2) +
         " vs last week (" + (wowPct >= 0 ? "+" : "") + (wowPct * 100).toFixed(1) + "%)")
      : "First week on record",
    56,
    138,
    320,
    16,
    {
      fontSize: 9,
      color: wowColor
    }
  );

  // Secondary cards
  const cards = [
    {
      label: "Pools Serviced",
      value: String(snap.poolCount),
      sub: prevSnap
        ? ((snap.poolCount - prevSnap.poolCount >= 0 ? "▲ " : "▼ ") +
           Math.abs(snap.poolCount - prevSnap.poolCount) + " vs last week")
        : "",
      accent: C_BLUE,
      valueColor: C_WHITE
    },
    {
      label: "Avg Cost per Pool",
      value: "$" + snap.costPerPool.toFixed(2),
      sub: snap.topPools && snap.topPools.length
        ? "Highest: " + (snap.topPools[0].client ? snap.topPools[0].client + " (" + snap.topPools[0].pool + ")" : snap.topPools[0].pool) + " ($" + snap.topPools[0].cost.toFixed(2) + ")"
        : "",
      accent: C_ORANGE,
      valueColor: C_WHITE
    },
    {
      label: "Top Chemical",
      value: snap.topChems && snap.topChems.length ? snap.topChems[0].chem : "—",
      sub: snap.topChems && snap.topChems.length
        ? "$" + snap.topChems[0].cost.toFixed(2) + " · qty " + snap.topChems[0].qty.toFixed(1)
        : "",
      accent: C_ORANGE,
      valueColor: C_WHITE
    }
  ];

  const cardY = 186;
  const cardW = 205;
  const cardH = 92;
  const gap = 12;

  cards.forEach((c, i) => {
    const x = 40 + i * (cardW + gap);

    addRect_(slide, x, cardY, cardW, cardH, "#1e293b");
    addRect_(slide, x, cardY, 4, cardH, c.accent);

    addText_(slide, c.label.toUpperCase(), x + 16, cardY + 12, cardW - 28, 14, {
      fontSize: 8,
      bold: true,
      color: "#94a3b8"
    });

    addText_(slide, c.value, x + 16, cardY + 28, cardW - 28, 28, {
      fontSize: c.label === "Top Chemical" ? 18 : 20,
      bold: true,
      color: c.valueColor
    });

    if (c.sub) {
      addText_(slide, c.sub, x + 16, cardY + 62, cardW - 28, 16, {
        fontSize: 8,
        color: "#b7bcc7"
      });
    }
  });

  // Subtle week-over-week insight bar
  if (prevSnap && wowDelta !== null) {
    const boxY = 300;

    addRect_(slide, 40, boxY, SW - 80, 34, "#1e293b");

    addText_(slide, "WEEK-OVER-WEEK", 56, boxY + 7, 120, 12, {
      fontSize: 8,
      bold: true,
      color: "#94a3b8"
    });

    const change =
      (isUp ? "▲ " : "▼ ") +
      "$" + Math.abs(wowDelta).toFixed(2) +
      " (" + (wowPct >= 0 ? "+" : "") + (wowPct * 100).toFixed(1) + "%) vs previous week";

    addText_(slide, change, 170, boxY + 7, SW - 230, 14, {
      fontSize: 11,
      bold: true,
      color: wowColor
    });
  }

  addFooter_(slide, weekKey);
}

/** Slide 3: Startup vs Service Split */
function buildSvcSplitSlide_(pres, snap, snapSvc, snapStu) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Startup vs Service Split", "This Week", C_BLUE);

  const hasStartup = snapStu && !snapStu.noData;
  const hasService = snapSvc && !snapSvc.noData;

  const cardY = 76;
  const cardH = 278; // taller so top chemical + qty stay inside
  const cardW = 312;
  const leftX = 40;
  const rightX = 368;

  const cols = [
    {
      x: leftX,
      label: "Startups",
      snap: snapStu,
      has: hasStartup,
      accent: C_GREEN
    },
    {
      x: rightX,
      label: "Service Visits",
      snap: snapSvc,
      has: hasService,
      accent: C_ORANGE
    }
  ];

  cols.forEach(col => {
    const x = col.x;
    const y = cardY;
    const s = col.snap;

    // outer card
    addRect_(slide, x, y, cardW, cardH, "#1e293b");
    addRect_(slide, x, y, 4, cardH, col.accent);

    // title
    addText_(slide, col.label.toUpperCase(), x + 16, y + 14, 160, 16, {
      fontSize: 9,
      bold: true,
      color: "#94a3b8"
    });

    if (!col.has) {
      addRect_(slide, x + 18, y + 62, cardW - 36, 78, "#17202d");

      addText_(slide, "No visits recorded", x + 18, y + 82, cardW - 36, 18, {
        fontSize: 12,
        bold: true,
        color: C_WHITE,
        align: SlidesApp.ParagraphAlignment.CENTER
      });

      addText_(slide, "This section will populate automatically when data exists.", x + 24, y + 104, cardW - 48, 16, {
        fontSize: 8,
        color: C_MUTED,
        align: SlidesApp.ParagraphAlignment.CENTER
      });

      return;
    }

    // metric 1
    addText_(slide, "$" + s.grandTotal.toFixed(2), x + 16, y + 52, cardW - 32, 28, {
      fontSize: 22,
      bold: true,
      color: C_WHITE
    });

    addText_(slide, "Total Cost", x + 16, y + 76, cardW - 32, 14, {
      fontSize: 8,
      color: C_MUTED
    });

    // metric 2
    addText_(slide, String(s.poolCount), x + 16, y + 108, cardW - 32, 28, {
      fontSize: 20,
      bold: true,
      color: C_WHITE
    });

    addText_(slide, "Pools", x + 16, y + 132, cardW - 32, 14, {
      fontSize: 8,
      color: C_MUTED
    });

    // metric 3
    addText_(slide, "$" + s.costPerPool.toFixed(2), x + 16, y + 164, cardW - 32, 28, {
      fontSize: 20,
      bold: true,
      color: C_WHITE
    });

    addText_(slide, "Avg per Pool", x + 16, y + 188, cardW - 32, 14, {
      fontSize: 8,
      color: C_MUTED
    });

    // top chemical block
    if (s.topChems && s.topChems.length) {
      const tc = s.topChems[0];

      addRect_(slide, x + 16, y + 214, cardW - 32, 1, "#334155");

      addText_(slide, "TOP CHEMICAL", x + 16, y + 224, 120, 12, {
        fontSize: 8,
        bold: true,
        color: "#94a3b8"
      });

      addText_(slide, tc.chem, x + 16, y + 238, cardW - 120, 14, {
        fontSize: 10,
        bold: true,
        color: col.accent
      });

      addText_(slide, "$" + tc.cost.toFixed(2), x + cardW - 90, y + 238, 58, 14, {
        fontSize: 10,
        bold: true,
        color: C_WHITE,
        align: SlidesApp.ParagraphAlignment.END
      });

      addText_(slide, "Qty: " + tc.qty.toFixed(1), x + 16, y + 252, cardW - 32, 12, {
        fontSize: 8,
        color: "#b7bcc7"
      });
    }
  });

  addFooter_(slide, "This Week");
}

/** Slide 4: Top Pools Bar Chart */
function buildTopPoolsSlide_(pres, snap, weekKey) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Top Pools by Chemical Cost", weekKey);

  if (!snap.topPools || !snap.topPools.length) {
    addText_(slide, "No pool data available", 40, 120, SW - 80, 40,
      { fontSize: 14, color: C_MUTED, align: SlidesApp.ParagraphAlignment.CENTER });
    return;
  }

  const pools   = snap.topPools.slice(0, 5);
  const maxCost = pools[0].cost;
  const barMaxW = SW - 280;
  const rowH    = 46;
  const startY  = 78;

  const rankColors = [C_RED, C_ORANGE, C_BLUE, C_BLUE, C_BLUE];

  pools.forEach((p, i) => {
    const y    = startY + i * (rowH + 8);
    const pct  = maxCost > 0 ? p.cost / maxCost : 0;
    const barW = Math.max(4, Math.round(barMaxW * pct));

    // Rank number
    addRect_(slide, 40, y, 30, rowH, C_CARD);
    addText_(slide, String(i + 1), 40, y, 30, rowH, {
      fontSize: 14, bold: true, color: rankColors[i] || C_BLUE,
      align: SlidesApp.ParagraphAlignment.CENTER
    });

    // Pool name + service type
    const poolLabel = p.client ? p.client + " (" + p.pool + ")" : p.pool;
    addText_(slide, poolLabel, 80, y + 2, 160, 22, { fontSize: 11, bold: true, color: C_WHITE });
    addText_(slide, (p.client || "") + (p.svc ? "  ·  " + p.svc : ""),
      80, y + 24, 160, 16, { fontSize: 8, color: C_MUTED });

    // Bar
    addRect_(slide, 248, y + 10, barMaxW, rowH - 20, "#2a2f3e");
    addRect_(slide, 248, y + 10, barW, rowH - 20, rankColors[i] || C_BLUE);

    // Cost label
    addText_(slide, "$" + p.cost.toFixed(2), 248 + barW + 6, y + 10, 80, rowH - 20, {
      fontSize: 11, bold: true, color: C_WHITE
    });
  });
}

/** Slide 5: Chemical Usage */
function buildChemUsageSlide_(pres, snap, weekKey) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Chemical Usage Breakdown", weekKey);

  if (!snap.allChems || !snap.allChems.length) {
    addText_(slide, "No chemical data available", 40, 120, SW - 80, 40,
      { fontSize: 14, color: C_MUTED, align: SlidesApp.ParagraphAlignment.CENTER });
    return;
  }

  const chems   = snap.allChems.slice(0, 7); // max 7 to fit slide
  const maxCost = chems[0].cost;
  const barMaxW = SW - 300;
  const rowH    = 38;
  const startY  = 78;

  chems.forEach((c, i) => {
    const y    = startY + i * (rowH + 4);
    const pct  = maxCost > 0 ? c.cost / maxCost : 0;
    const barW = Math.max(4, Math.round(barMaxW * pct));
    const isTop = i === 0;

    // Chemical name
    addText_(slide, c.chem, 40, y + 6, 200, 20,
      { fontSize: isTop ? 12 : 10, bold: isTop, color: isTop ? C_WHITE : "#c0c4cc" });

    // Bar track + fill
    addRect_(slide, 248, y + 8, barMaxW, rowH - 16, "#2a2f3e");
    addRect_(slide, 248, y + 8, barW, rowH - 16, isTop ? C_ORANGE : C_BLUE);

    // Qty
    addText_(slide, "×" + c.qty.toFixed(1), 248 + barW + 6, y + 8, 55, rowH - 16,
      { fontSize: 9, color: C_MUTED });

    // Cost
    addText_(slide, "$" + c.cost.toFixed(2), SW - 90, y + 6, 80, 20,
      { fontSize: isTop ? 12 : 10, bold: isTop, color: isTop ? C_ORANGE : C_WHITE,
        align: SlidesApp.ParagraphAlignment.END });
  });

  // Total footer
  addRect_(slide, 40, SH - 50, SW - 80, 1, "#3a3f4e");
  addText_(slide, "TOTAL CHEMICAL SPEND", 40, SH - 42, 260, 24,
    { fontSize: 9, bold: true, color: C_MUTED });
  addText_(slide, "$" + snap.grandTotal.toFixed(2), 40, SH - 42, SW - 80, 24,
    { fontSize: 14, bold: true, color: C_WHITE,
      align: SlidesApp.ParagraphAlignment.END });
}

/** Slide 6: Startup Detail */
function buildStartupDetailSlide_(pres, snapStu, weekKey) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Startup Detail", weekKey, C_GREEN);

  if (!snapStu || snapStu.noData) {
    addText_(slide, "No startup visits this week", 40, 140, SW - 80, 40,
      { fontSize: 16, color: C_MUTED, align: SlidesApp.ParagraphAlignment.CENTER });
    return;
  }

  buildDetailTable_(slide, snapStu);
}

/** Slide 7: Service Detail */
function buildServiceDetailSlide_(pres, snapSvc, weekKey) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Service Detail", weekKey, C_ORANGE);

  if (!snapSvc || snapSvc.noData) {
    addText_(slide, "No service visits this week", 40, 140, SW - 80, 40, {
      fontSize: 16,
      color: C_MUTED,
      align: SlidesApp.ParagraphAlignment.CENTER
    });
    return;
  }

  buildDetailTable_(slide, snapSvc);
}

/** Slide 8: Other Detail */
function buildOtherDetailSlide_(pres, snapOth, weekKey) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Other Detail", weekKey, "#9aa0a6");

  if (!snapOth || snapOth.noData) {
    addText_(slide, "No other visits this week", 40, 140, SW - 80, 40, {
      fontSize: 16,
      color: C_MUTED,
      align: SlidesApp.ParagraphAlignment.CENTER
    });
    return;
  }

  buildDetailTable_(slide, snapOth);
}

function buildDetailTable_(slide, snap) {
  const pools   = snap.topPools || [];
  const chems   = snap.allChems || [];
  const rowH    = 28;
  const startY  = 80;
  const maxRows = 7;

  // Layout
  const tableX = 40;
  const tableW = 390;

  const poolX  = 52;
  const svcX   = 230;
  const costX  = tableX + tableW - 90;

  const hY = startY;

  // Header row
  addRect_(slide, tableX, hY, tableW, rowH, "#2a2f3e");

  addText_(slide, "Pool", poolX, hY, 160, rowH, {
    fontSize: 9,
    bold: true,
    color: C_MUTED
  });

  addText_(slide, "Service Type", svcX, hY, 130, rowH, {
    fontSize: 9,
    bold: true,
    color: C_MUTED
  });

  addText_(slide, "Cost", costX, hY, 70, rowH, {
    fontSize: 9,
    bold: true,
    color: C_MUTED,
    align: SlidesApp.ParagraphAlignment.END
  });

  // Data rows
  pools.slice(0, maxRows).forEach((p, i) => {
    const y = startY + (i + 1) * (rowH + 4);
    const shade = i % 2 === 0 ? "#1f2937" : "#17202d";

    addRect_(slide, tableX, y, tableW, rowH, shade);

    const poolLabel = p.client ? p.client + " (" + p.pool + ")" : (p.pool || "—");
    addText_(slide, poolLabel, poolX, y, 160, rowH, {
      fontSize: 10,
      bold: true,
      color: C_WHITE
    });

    addText_(slide, p.svc || "—", svcX, y, 130, rowH, {
      fontSize: 9,
      color: "#cbd5e1"
    });

    addText_(slide, "$" + Number(p.cost || 0).toFixed(2), costX, y, 70, rowH, {
      fontSize: 12,
      bold: true,
      color: "#f97316",
      align: SlidesApp.ParagraphAlignment.END
    });
  });

  // Right-side Top Chemicals card
  if (chems.length) {
    const cardX = 460;
    const cardY = startY;
    const cardW = 220;
    const cardH = 190;

    addRect_(slide, cardX, cardY, cardW, cardH, "#1e293b");

    addText_(slide, "Top Chemicals", cardX + 16, cardY + 10, 160, 20, {
      fontSize: 12,
      bold: true,
      color: C_WHITE
    });

    addRect_(slide, cardX + 16, cardY + 34, cardW - 32, 1, "#334155");

    chems.slice(0, 5).forEach((c, i) => {
      const cy = cardY + 44 + i * 26;

      addText_(slide, c.chem || "—", cardX + 16, cy, 130, 20, {
        fontSize: 9,
        color: C_WHITE
      });

      addText_(slide, "$" + Number(c.cost || 0).toFixed(2), cardX + 140, cy, 60, 20, {
        fontSize: 9,
        bold: true,
        color: C_ORANGE,
        align: SlidesApp.ParagraphAlignment.END
      });
    });
  }
}

/** Slide 8: Inventory Alerts */
function buildInventoryAlertSlide_(pres, alerts) {
  const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  fillBg_(slide, C_DARK);
  slideHeader_(slide, "Inventory Alerts", "Action Required", C_RED);

  const rowH = 44;
  const startY = 80;

  alerts.slice(0, 7).forEach((a, i) => {
    const y = startY + i * (rowH + 8);
    const isCrit = a.qty <= 0;
    const color = isCrit ? C_RED : C_ORANGE;
    const label = isCrit ? "OUT OF STOCK" : "LOW STOCK";

    // clean dark card
    addRect_(slide, 40, y, SW - 80, rowH, "#1e293b");
    addRect_(slide, 40, y, 4, rowH, color);

    // item name
    addText_(slide, a.name || "—", 56, y + 4, 260, 18, {
      fontSize: 11,
      bold: true,
      color: C_WHITE
    });

    // unit
    addText_(slide, a.unitType || "", 56, y + 22, 120, 14, {
      fontSize: 8,
      color: C_MUTED
    });

    // status pill
    addRect_(slide, 430, y + 10, 92, 24, "#0f172a");
    addText_(slide, label, 430, y + 10, 92, 24, {
      fontSize: 8,
      bold: true,
      color: color,
      align: SlidesApp.ParagraphAlignment.CENTER
    });

    // qty and reorder info
    addText_(slide, a.qty.toFixed(2) + " on hand", 540, y + 6, 120, 14, {
      fontSize: 10,
      bold: true,
      color: C_WHITE,
      align: SlidesApp.ParagraphAlignment.END
    });

    addText_(slide, "Reorder at " + a.reorderLevel, 540, y + 22, 120, 12, {
      fontSize: 8,
      color: "#94a3b8",
      align: SlidesApp.ParagraphAlignment.END
    });
  });
}

// ─── Email ────────────────────────────────────────────────────────────────────

function emailDeck_(pres, weekKey, snap, wowDelta, wowPct, deckUrl) {
  const subject = DECK_COMPANY_NAME + " · Weekly Ops Report · " + weekKey;

  const wowLine = wowDelta !== null
    ? (wowDelta >= 0 ? "▲" : "▼") + " $" + Math.abs(wowDelta).toFixed(2) +
      " (" + (wowPct * 100 > 0 ? "+" : "") + (wowPct * 100).toFixed(1) + "%) vs prior week"
    : "First week on record";

  const body = [
    "Hi team,",
    "",
    "Your weekly chemical ops report is ready for " + weekKey + ".",
    "",
    "  • Total Chemical Spend:  $" + snap.grandTotal.toFixed(2),
    "  • Pools Serviced:        " + snap.poolCount,
    "  • Avg Cost per Pool:     $" + snap.costPerPool.toFixed(2),
    "  • Week-over-Week:        " + wowLine,
    "",
    "View the full presentation here:",
    deckUrl,
    "",
    "— " + DECK_COMPANY_NAME + " Automated Reports"
  ].join("\n");

  // Export as PDF and attach
  let pdfBlob = null;
  try {
    const pdfUrl  = "https://docs.google.com/presentation/d/" +
      pres.getId() + "/export/pdf";
    const token   = ScriptApp.getOAuthToken();
    const response = UrlFetchApp.fetch(pdfUrl, {
      headers: { Authorization: "Bearer " + token }
    });
    pdfBlob = response.getBlob().setName(
      DECK_COMPANY_NAME.replace(/\s/g, "_") + "_WeeklyOps_" +
      weekKey.replace(/\//g, "-") + ".pdf"
    );
  } catch(e) {
    Logger.log("PDF export warning: " + e);
  }

  const recipients = [DECK_RECIPIENT_1, DECK_RECIPIENT_2].filter(Boolean);

  recipients.forEach(email => {
    try {
      const opts = { name: DECK_COMPANY_NAME + " Reports" };
      if (pdfBlob) opts.attachments = [pdfBlob];
      GmailApp.sendEmail(email, subject, body, opts);
      Logger.log("Email sent to: " + email);
    } catch(e) {
      Logger.log("Email error for " + email + ": " + e);
    }
  });
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

/** Gets the KPI snapshot for the week immediately before weekKey */
function getPreviousWeekSnapshot_(weekKey) {
  const weeks = getAvailableWeeks();
  const idx   = weeks.indexOf(weekKey);
  if (idx <= 0) return null;

  try {
    const prev = getWeeklyKpiSnapshot(weeks[idx - 1], "all");
    prev.weekKey = weeks[idx - 1];
    return prev.noData ? null : prev;
  } catch(e) {
    return null;
  }
}

/** Returns inventory items at or below reorder level */
function getInventoryAlerts_() {
  try {
    const invSs    = SpreadsheetApp.openById("1xPv2oEkJ1KCI3l1LexA4cGH73MM-sWXunQ4fr0wyBSI");
    const invSheet = invSs.getSheetByName("Inventory_Master");
    if (!invSheet || invSheet.getLastRow() < 2) return [];

    const headers = invSheet.getRange(1, 1, 1, invSheet.getLastColumn())
      .getValues()[0].map(h => String(h || "").trim());

    const dispCol    = headers.indexOf("display_name");
    const qtyCol     = headers.indexOf("qty_on_hand");
    const reorderCol = headers.indexOf("reorder_level");
    const unitCol    = headers.indexOf("usage_unit");

    if (dispCol === -1 || qtyCol === -1) return [];

    const data = invSheet.getRange(2, 1, invSheet.getLastRow() - 1, invSheet.getLastColumn())
      .getValues();

    return data
      .map(r => ({
        name        : String(r[dispCol]    || "").trim(),
        qty         : Number(r[qtyCol]     || 0),
        reorderLevel: reorderCol !== -1 ? Number(r[reorderCol] || 0) : 0,
        unitType    : unitCol    !== -1 ? String(r[unitCol]    || "").trim() : ""
      }))
      .filter(r => r.name && r.qty <= r.reorderLevel)
      .sort((a, b) => a.qty - b.qty);
  } catch(e) {
    Logger.log("Inventory alert warning: " + e);
    return [];
  }
}

// ─── Slide primitive helpers ──────────────────────────────────────────────────

function fillBg_(slide, hexColor) {
  slide.getBackground().setSolidFill(hexColor);
}
function generateWeeklyDeckPickWeek() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const weeks = getAvailableWeeks();

  if (!weeks.length) {
    ss.toast("No week data found in Chemical_Cost_Detail", "Weekly Deck");
    return;
  }

  const recentWeeks = weeks.slice(-12).reverse(); // newest first
  const msg =
    "Enter the week exactly as shown below:\n\n" +
    recentWeeks.map((w, i) => `${i + 1}. ${w}`).join("\n");

  const res = ui.prompt("Generate Weekly Deck", msg, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const input = String(res.getResponseText() || "").trim();

  let selectedWeek = null;

  // Allow either exact week text or list number
  if (/^\d+$/.test(input)) {
    const idx = Number(input) - 1;
    if (idx >= 0 && idx < recentWeeks.length) {
      selectedWeek = recentWeeks[idx];
    }
  } else if (weeks.includes(input)) {
    selectedWeek = input;
  }

  if (!selectedWeek) {
    ui.alert(
      "Invalid week",
      "Please enter either the exact week key or a number from the list.",
      ui.ButtonSet.OK
    );
    return;
  }

  generateWeeklyDeck(selectedWeek);
}

function normalizeHexColor_(hexColor) {
  hexColor = String(hexColor || "").trim();

  // Convert #RRGGBBAA -> #RRGGBB for Google Slides
  const m8 = hexColor.match(/^#([0-9a-fA-F]{8})$/);
  if (m8) return "#" + m8[1].substring(0, 6);

  // Allow normal #RRGGBB
  const m6 = hexColor.match(/^#([0-9a-fA-F]{6})$/);
  if (m6) return "#" + m6[1];

  throw new Error("Invalid hex color for Slides: " + hexColor);
}

function addRect_(slide, x, y, w, h, hexColor) {
  hexColor = normalizeHexColor_(hexColor);
  const shape = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x, y, w, h);
  shape.getFill().setSolidFill(hexColor);
  shape.getBorder().setTransparent();
  return shape;
}

function addText_(slide, text, x, y, w, h, opts) {
  opts = opts || {};
  const shape = slide.insertTextBox(String(text || ""), x, y, w, h);
  shape.getFill().setTransparent();
  shape.getBorder().setTransparent();

  const tf    = shape.getText();
  const style = tf.getTextStyle();

  style.setFontSize(opts.fontSize || 12);
  style.setBold(opts.bold || false);
  style.setItalic(opts.italic || false);
  style.setForegroundColor(opts.color || C_WHITE);
  if (opts.fontFamily) style.setFontFamily(opts.fontFamily);

  if (opts.align) {
    tf.getParagraphs().forEach(p =>
      p.getRange().getParagraphStyle()
        .setParagraphAlignment(opts.align)
    );
  }

  // Vertical center
  shape.setContentAlignment(SlidesApp.ContentAlignment.MIDDLE);

  return shape;
}

/** Consistent slide header: accent bar + title + subtitle */
function slideHeader_(slide, title, subtitle, accentColor) {
  accentColor = accentColor || C_BLUE;

  // thin top accent
  addRect_(slide, 0, 0, SW, 6, accentColor);

  // title
  addText_(slide, title, 40, 16, SW - 220, 26, {
    fontSize: 21,
    bold: true,
    color: C_WHITE
  });

  // subtitle label
  if (subtitle) {
    addRect_(slide, SW - 170, 14, 130, 24, "#232938");
    addRect_(slide, SW - 170, 14, 5, 24, accentColor);

    addText_(slide, subtitle, SW - 160, 14, 110, 24, {
      fontSize: 9,
      bold: true,
      color: C_WHITE,
      align: SlidesApp.ParagraphAlignment.CENTER
    });
  }

  // divider
  addRect_(slide, 40, 52, SW - 80, 1, "#31384a");
}