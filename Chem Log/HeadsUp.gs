// HeadsUp.gs
// Sends a "heads up" SMS to a client via Zapier webhook when a technician is on the way.

var HU_CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";

function sendHeadsUp(pool_id, customer_name) {
  var ss = SpreadsheetApp.openById(HU_CRM_SS_ID);
  var sheet = ss.getSheetByName("Signed_Customers");
  if (!sheet) return { ok: false, error: "Signed_Customers sheet not found" };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: false, error: "No customer data found" };

  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var poolIdCol   = headers.indexOf("pool_id");
  var phoneCol    = headers.indexOf("phone");
  var firstNameCol = headers.indexOf("first_name");

  if (poolIdCol === -1 || phoneCol === -1) {
    return { ok: false, error: "Required columns not found in Signed_Customers" };
  }

  var phone = null, firstName = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][poolIdCol]).trim() === String(pool_id).trim()) {
      phone = String(data[i][phoneCol] || "").trim();
      firstName = firstNameCol !== -1 ? String(data[i][firstNameCol] || "").trim() : "";
      break;
    }
  }

  if (!phone) return { ok: false, error: "Phone number not found for this pool" };

  // Fall back to first word of full name if first_name column is empty
  if (!firstName && customer_name) {
    firstName = String(customer_name).split(" ")[0];
  }
  if (!firstName) firstName = "there";

  var message = "Hi " + firstName + "! Your MCPS pool technician is on their way. See you soon! \u2013 Mission Custom Pool Solutions";

  var zapierUrl = PropertiesService.getScriptProperties().getProperty("ZAPIER_HEADS_UP_WEBHOOK");
  if (!zapierUrl) return { ok: false, error: "Zapier webhook not configured (add ZAPIER_HEADS_UP_WEBHOOK script property)" };

  try {
    UrlFetchApp.fetch(zapierUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ to: phone, message: message, customer: firstName }),
      muteHttpExceptions: true
    });
  } catch (err) {
    return { ok: false, error: "Failed to reach Zapier: " + String(err) };
  }

  return { ok: true, customer: firstName };
}
