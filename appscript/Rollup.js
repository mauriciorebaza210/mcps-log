//Rollup.gs
const ROLLUP_SHEET_NAME = "Chem_Cost_per_Pool";
const PRICED_SHEET_NAME = "Usage_Priced";

function rollupLatestSnapshotToPoolWeek_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const priced = ss.getSheetByName(PRICED_SHEET_NAME);
  const roll = ss.getSheetByName(ROLLUP_SHEET_NAME);
  if (!priced || !roll) throw new Error("Missing Usage_Priced or Chem_Cost_per_Pool");

  const pricedHeaders = priced.getRange(1, 1, 1, priced.getLastColumn()).getValues()[0].map(String);
  const rollHeaders = roll.getRange(1, 1, 1, roll.getLastColumn()).getValues()[0].map(String);

  const col = (headers, name) => headers.indexOf(name) + 1;

  const pidCol = col(pricedHeaders, "pool_id");
  const keyCol = col(pricedHeaders, "WeekKey");
  const totCol = col(pricedHeaders, "Total Visit Chem Cost (Snapshot)");

  if (!pidCol || !keyCol || !totCol) {
    throw new Error('Usage_Priced must have: pool_id, WeekKey, Total Visit Chem Cost (Snapshot)');
  }

  const r = priced.getLastRow();
  if (r < 2) return;

  const row = priced.getRange(r, 1, 1, priced.getLastColumn()).getValues()[0];
  const poolId = String(row[pidCol - 1] || "").trim();
  const weekKey = String(row[keyCol - 1] || "").trim();
  const amount = Number(row[totCol - 1] || 0);

  Logger.log("poolId = " + poolId);
  Logger.log("weekKey = " + weekKey);
  Logger.log("amount = " + amount);

  if (!poolId || !weekKey || !isFinite(amount) || amount === 0) return;

  const poolRange = roll.getRange(2, 1, Math.max(0, roll.getLastRow() - 1), 1).getValues().flat();
  let poolRow = poolRange.findIndex(v => String(v).trim() === poolId);

  if (poolRow === -1) {
    roll.appendRow([poolId]);
    poolRow = roll.getLastRow() - 2;
  }

  const sheetRow = poolRow + 2;

  let weekCol = rollHeaders.findIndex(h => String(h).trim() === weekKey);

  Logger.log("Adding/finding week column for: " + weekKey);

  if (weekCol === -1) {
    roll.getRange(1, roll.getLastColumn() + 1).setValue(weekKey);
    weekCol = roll.getLastColumn() - 1;
  }

  const sheetCol = weekCol + 1;

  Logger.log("Writing amount to row " + sheetRow + ", col " + sheetCol);

  const current = Number(roll.getRange(sheetRow, sheetCol).getValue() || 0);
  roll.getRange(sheetRow, sheetCol).setValue(current + amount);
}

function TEST_submitFakeWeeklyUsageRow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const raw = ss.getSheetByName("Chemical_Usage_Log");
  if (!raw) throw new Error("Missing sheet: Chemical_Usage_Log");

  const hm = getHeaderMap_(raw);
  const row = new Array(hm.headers.length).fill("");

  const put = (header, value) => {
    const col = hm.map[header];
    if (col) row[col - 1] = value;
    else Logger.log("Header not found in Chemical_Usage_Log: " + header);
  };

  put("Timestamp", new Date());
  put("pool_id", "Libby - Weekly Full Service - 27121 Highland Crest - MCPS-0007");

  // EXACT names from Chem_Costs / form
  put("LTD QTY - 1 GALLON HASA LIQUID CHLORINE", 1);
  put("HAZMAT 4 X 1 GALLON HASA MURIATIC ACID", 0.5);

  raw.appendRow(row);
  const addedRawRow = raw.getLastRow();

  snapshotUsageToPriced_();

  const priced = ss.getSheetByName("Usage_Priced");
  const addedPricedRow = priced.getLastRow();

  Logger.log("Added Chemical_Usage_Log row: " + addedRawRow);
  Logger.log("Added Usage_Priced row: " + addedPricedRow);
}

function backfillWeeklyFieldsInUsagePriced() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const priced = ss.getSheetByName("Usage_Priced");
  if (!priced) throw new Error("Missing Usage_Priced");

  const hm = getHeaderMap_(priced);
  if (!hm.map["Timestamp"]) throw new Error('Usage_Priced missing "Timestamp"');

  const needed = [];
  if (!hm.map["Week Start"]) needed.push("Week Start");
  if (!hm.map["WeekKey"]) needed.push("WeekKey");
  if (!hm.map["Visit # in Week"]) needed.push("Visit # in Week");

  if (needed.length) {
    priced.getRange(1, priced.getLastColumn() + 1, 1, needed.length).setValues([needed]);
  }

  const newHm = getHeaderMap_(priced);
  const lastRow = priced.getLastRow();
  if (lastRow < 2) return;

  const data = priced.getRange(2, 1, lastRow - 1, priced.getLastColumn()).getValues();

  const tsCol = newHm.map["Timestamp"] - 1;
  const pidCol = newHm.map["pool_id"] - 1;
  const weekStartCol = newHm.map["Week Start"] - 1;
  const weekKeyCol = newHm.map["WeekKey"] - 1;
  const visitWeekCol = newHm.map["Visit # in Week"] - 1;

  const tz = ss.getSpreadsheetTimeZone();

  for (let i = 0; i < data.length; i++) {
    const ts = new Date(data[i][tsCol]);
    if (isNaN(ts)) continue;

    const weekStart = getUsageWeekStart_(ts);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const startStr = Utilities.formatDate(weekStart, tz, "M/d");
    const endStr = Utilities.formatDate(weekEnd, tz, "M/d");
    const weekKey = `${startStr}-${endStr}`;

    data[i][weekStartCol] = weekStart;
    data[i][weekKeyCol] = weekKey;
  }

  const counts = {};
  for (let i = 0; i < data.length; i++) {
    const poolId = String(data[i][pidCol] || "").trim();
    const weekKey = String(data[i][weekKeyCol] || "").trim();
    if (!poolId || !weekKey) continue;

    const key = `${poolId}__${weekKey}`;
    counts[key] = (counts[key] || 0) + 1;
    data[i][visitWeekCol] = counts[key];
  }

  priced.getRange(2, 1, data.length, priced.getLastColumn()).setValues(data);
}

function rebuildWeeklyRollupFromUsagePriced() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const priced = ss.getSheetByName("Usage_Priced");
  const roll = ss.getSheetByName("Chem_Cost_per_Pool");

  if (!priced) throw new Error("Missing Usage_Priced");
  if (!roll) throw new Error("Missing Chem_Cost_per_Pool");

  const pricedData = priced.getDataRange().getValues();
  if (pricedData.length < 2) throw new Error("Usage_Priced has no data rows");

  const pricedHeaders = pricedData[0].map(h => String(h || "").trim());

  const col = (headers, name) => headers.indexOf(name);

  const pidCol = col(pricedHeaders, "pool_id");
  const keyCol = col(pricedHeaders, "WeekKey");
  const totCol = col(pricedHeaders, "Total Visit Chem Cost (Snapshot)");

  if (pidCol === -1) throw new Error('Usage_Priced missing "pool_id"');
  if (keyCol === -1) throw new Error('Usage_Priced missing "WeekKey"');
  if (totCol === -1) throw new Error('Usage_Priced missing "Total Visit Chem Cost (Snapshot)"');

  const totalsByPool = {};
  const allWeekKeysSet = new Set();

  for (let i = 1; i < pricedData.length; i++) {
    const row = pricedData[i];
    const poolId = String(row[pidCol] || "").trim();
    const weekKey = String(row[keyCol] || "").trim();
    const amount = Number(row[totCol] || 0);

    if (!poolId || !weekKey || !isFinite(amount) || amount === 0) continue;

    if (!totalsByPool[poolId]) totalsByPool[poolId] = {};
    if (!totalsByPool[poolId][weekKey]) totalsByPool[poolId][weekKey] = 0;

    totalsByPool[poolId][weekKey] += amount;
    allWeekKeysSet.add(weekKey);
  }

  const allWeekKeys = [...allWeekKeysSet].sort((a, b) => {
    const parseStart = (s) => {
      const m = String(s).match(/^(\d{1,2})\/(\d{1,2})-/);
      if (!m) return new Date(0);
      const year = new Date().getFullYear();
      return new Date(year, Number(m[1]) - 1, Number(m[2]));
    };
    return parseStart(a) - parseStart(b);
  });

  const rollLastRow = roll.getLastRow();
  const rollLastCol = roll.getLastColumn();
  if (rollLastRow < 1 || rollLastCol < 1) throw new Error("Chem_Cost_per_Pool is empty");

  const rollHeaders = roll.getRange(1, 1, 1, rollLastCol).getValues()[0].map(h => String(h || "").trim());

  const poolIdHeaderIdx = rollHeaders.indexOf("pool_id");
  if (poolIdHeaderIdx === -1) throw new Error('Chem_Cost_per_Pool missing "pool_id" header');

  let firstWeekCol = rollHeaders.findIndex(h => /^\d{1,2}\/\d{1,2}-\d{1,2}\/\d{1,2}$/.test(h));

  if (firstWeekCol === -1) {
    firstWeekCol = rollHeaders.length;
  }

  if (rollLastCol > firstWeekCol) {
    roll.getRange(1, firstWeekCol + 1, roll.getMaxRows(), rollLastCol - firstWeekCol).clearContent();
  }

  if (allWeekKeys.length > 0) {
    roll.getRange(1, firstWeekCol + 1, 1, allWeekKeys.length).setValues([allWeekKeys]);
  }

  const poolIds = roll.getRange(2, poolIdHeaderIdx + 1, Math.max(0, roll.getLastRow() - 1), 1).getValues().flat();
  const poolRowMap = {};
  poolIds.forEach((pid, idx) => {
    const key = String(pid || "").trim();
    if (key) poolRowMap[key] = idx + 2;
  });

  const numRows = Math.max(0, roll.getLastRow() - 1);
  if (numRows === 0 || allWeekKeys.length === 0) return;

  const output = Array.from({ length: numRows }, () => new Array(allWeekKeys.length).fill(""));

  Object.keys(totalsByPool).forEach(poolId => {
    const sheetRow = poolRowMap[poolId];
    if (!sheetRow) return;

    const rowIdx = sheetRow - 2;
    allWeekKeys.forEach((weekKey, colIdx) => {
      const amt = totalsByPool[poolId][weekKey];
      if (amt) output[rowIdx][colIdx] = amt;
    });
  });

  roll.getRange(2, firstWeekCol + 1, numRows, allWeekKeys.length).setValues(output);
}