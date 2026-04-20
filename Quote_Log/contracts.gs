//04_contracts.gs
function generateContractForRow_(sheet, hm, row) {
  const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];

  const fullName = `${getByHeader_(rowData, hm.headers, "first_name")} ${getByHeader_(rowData, hm.headers, "last_name")}`.trim();
  const quoteId = getByHeader_(rowData, hm.headers, "quote_id");
  const fileName = `Pool Service Agreement - ${fullName} - #${quoteId}`;

  try {
    const templateFile = DriveApp.getFileById(CFG.CONTRACT.TEMPLATE_ID);
    const destinationFolder = DriveApp.getFolderById(CFG.CONTRACT.FOLDER_ID);

    const tempDocFile = templateFile.makeCopy("TEMP_DOC_" + fileName, destinationFolder);
    const doc = DocumentApp.openById(tempDocFile.getId());
    const body = doc.getBody();

    // --- Existing placeholders ---
    body.replaceText("{{DATE}}", Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMMM d, yyyy"));
    body.replaceText("{{CLIENT_NAME}}", fullName);
    body.replaceText("{{EMAIL}}", getByHeader_(rowData, hm.headers, "email"));
    body.replaceText("{{PHONE}}", getByHeader_(rowData, hm.headers, "phone"));
    body.replaceText("{{ADDRESS}}", getByHeader_(rowData, hm.headers, "address"));
    body.replaceText("{{SERVICE_TYPE}}", getByHeader_(rowData, hm.headers, "service"));
    body.replaceText("{{TOTAL}}", `$${Number(getByHeader_(rowData, hm.headers, "total_with_tax") || 0).toFixed(2)}`);
    body.replaceText("{{POOL_SPECS}}", getByHeader_(rowData, hm.headers, "specs_summary"));
    body.replaceText("{{MONTHLY_RATE}}", `$${Number(getByHeader_(rowData, hm.headers, "quote_subtotal") || 0).toFixed(2)}`);
    body.replaceText("{{SALES_TAX}}", `$${Number(getByHeader_(rowData, hm.headers, "sales_tax") || 0).toFixed(2)}`);

    // --- New placeholders ---
    body.replaceText("{{QUOTE_ID}}", quoteId || "N/A");

    const zip  = getByHeader_(rowData, hm.headers, "zip_code") || "";
    const city = getByHeader_(rowData, hm.headers, "city") || "";
    const location = [city, zip].filter(Boolean).join(", ");
    body.replaceText("{{ZIP_CODE}}", zip || "N/A");
    body.replaceText("{{CITY}}", city || "N/A");
    body.replaceText("{{LOCATION}}", location || "N/A");  // bonus: city + zip combined

    body.replaceText("{{TRAVEL_FEE}}", `$${Number(getByHeader_(rowData, hm.headers, "travel_fee") || 0).toFixed(2)}`);

    const startDateRaw = getByHeader_(rowData, hm.headers, "contract_start_date");
    let startDateFormatted = "TBD";
    if (startDateRaw) {
      try {
        const d = new Date(startDateRaw);
        startDateFormatted = Utilities.formatDate(d, Session.getScriptTimeZone(), "MMMM d, yyyy");
      } catch (_) {
        startDateFormatted = String(startDateRaw);
      }
    }
    body.replaceText("{{CONTRACT_START_DATE}}", startDateFormatted);

    doc.saveAndClose();

    const pdfBlob = tempDocFile.getAs(MimeType.PDF).setName(fileName + ".pdf");
    const finalPdfFile = destinationFolder.createFile(pdfBlob);
    tempDocFile.setTrashed(true);

    const fileId = finalPdfFile.getId();
    const driveUrl = finalPdfFile.getUrl();
    const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    setByHeader_(sheet, hm, row, "contract_generated", "Yes");
    setByHeader_(sheet, hm, row, "contract_file_id", fileId);
    setByHeader_(sheet, hm, row, "contract_url", driveUrl);
    setByHeader_(sheet, hm, row, "contract_download_url", directDownloadUrl);
    setByHeader_(sheet, hm, row, "contract_status", "CONTRACT_GENERATED");
    setByHeader_(sheet, hm, row, "generate_contract", false);

  } catch (err) {
    setByHeader_(sheet, hm, row, "generate_contract", false);
    logDebug_("ERROR", "Generation Error", { err: String(err), row });
    Logger.log("Generation Error: " + String(err));
  }
}
