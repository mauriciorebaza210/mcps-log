// 03_triggers.gs

function installedOnEdit(e) {
  try {
    if (!e || !e.range) return;

    const sheet = e.range.getSheet();
    const sheetName = sheet.getName();
    const row = e.range.getRow();
    if (row < 2) return;

    const hm = getHeaderMap_(sheet);
    const colHeader = hm.headers[e.range.getColumn() - 1];
    const val = String(e.value ?? "").toUpperCase();

    // CRM
    if (sheetName === CFG.SHEETS.CRM) {
      if (colHeader === "generate_contract" && val === "TRUE") {
        generateContractForRow_(sheet, hm, row);
        return;
      }

      if (colHeader === "send_contract") {
        if (val === "TRUE") {
          setByHeader_(sheet, hm, row, "send_contract_at", new Date());
          sendContractWebhook(sheet, hm, row);
        } else {
          setByHeader_(sheet, hm, row, "send_contract_at", "");
        }
        return;
      }

      if ((colHeader === "status" || colHeader === "contract_status") && val === "SIGNED") {
        moveToSignedSheet_(sheet, row);
        return;
      }

      return;
    }

    // Signed_Customers
    if (sheetName === CFG.SHEETS.SIGNED) {
      if (colHeader === "contract_status" || colHeader === "service_status") {
        if (val === "LOST") {
          moveToLostSheet_(sheet, row);
          return;
        }

        if (val === "COMPLETED_ONE_TIME") {
          moveToCompletedOneTimeSheet_(sheet, row);
          return;
        }
      }

      return;
    }

  } catch (err) {
    logDebug_("ERROR", "installedOnEdit failed", { err: String(err) });
    Logger.log("installedOnEdit Error: " + String(err));
    throw err;
  }
}

function processSignedRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CFG.SHEETS.CRM);
  if (!sheet) return;

  const hm = getHeaderMap_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  const rowsToMove = [];
  data.forEach((rowData, i) => {
    const status = String(getByHeader_(rowData, hm.headers, "status") || "").toUpperCase();
    if (status === "SIGNED") {
      rowsToMove.push(i + 2); // actual sheet row
    }
  });

  for (let i = rowsToMove.length - 1; i >= 0; i--) {
    const row = rowsToMove[i];
    try {
      moveToSignedSheet_(sheet, row);
    } catch (err) {
      logDebug_("ERROR", "processSignedRows failed", {
        row,
        err: String(err)
      });
    }
  }
}

function flagStuckContractSends_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CFG.SHEETS.CRM);
  if (!sheet) return;

  const hm = getHeaderMap_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const now = new Date();

  for (let row = 2; row <= lastRow; row++) {
    const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];

    const sendContract = getByHeader_(rowData, hm.headers, "send_contract");
    const sendContractAt = getByHeader_(rowData, hm.headers, "send_contract_at");
    const sentAt = getByHeader_(rowData, hm.headers, "sent_at");

    if (sendContract === true && sendContractAt && !sentAt) {
      const ageMinutes = (now - new Date(sendContractAt)) / 1000 / 60;
      if (ageMinutes >= 10) {
        setByHeader_(sheet, hm, row, "send_error", "SEND_TIMEOUT");
      }
    }
  }
}
