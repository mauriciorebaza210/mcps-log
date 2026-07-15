function getRowValueByHeader_(rowData, headers, headerName) {
  const i = headers.indexOf(headerName);
  return i === -1 ? "" : String(rowData[i] || "").trim();
}

function normalizeUsagePoolId_(value) {
  const s = String(value || "").trim();
  const m = s.match(/MCPS-\d+/i);
  return m ? m[0].toUpperCase() : s.toUpperCase();
}

function normalizeUsageNotes_(value) {
  return String(value || "")
    .replace(/\s*\[condition:[^\]]*\]\s*/ig, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toUpperCase();
}

function compactUsageHash_(value) {
  const raw = String(value || "");
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  return bytes.map(function(b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("").slice(0, 16);
}

function buildUsageDedupKey_(rowData, headers, explicitPoolId) {
  const rawPoolId = explicitPoolId || getRowValueByHeader_(rowData, headers, "pool_id");
  const poolId = normalizeUsagePoolId_(rawPoolId);

  const technician = getRowValueByHeader_(rowData, headers, "Technician").toUpperCase();
  const notesHash = compactUsageHash_(normalizeUsageNotes_(getRowValueByHeader_(rowData, headers, "Notes")));

  const timestamp = getRowValueByHeader_(rowData, headers, "Timestamp");
  const ts = timestamp ? new Date(timestamp) : new Date();

  const minuteKey = Utilities.formatDate(
    ts,
    Session.getScriptTimeZone(),
    "yyyy-MM-dd HH:mm"
  );

  return [poolId, technician, notesHash, minuteKey].join(" | ");
}

function claimDedupAction_(actionName, dedupKey) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const props = PropertiesService.getScriptProperties();
    const propKey = "dedup|" + actionName + "|" + dedupKey;

    if (props.getProperty(propKey) === "done") {
      return false;
    }

    // Clean up dedup properties older than 30 minutes to prevent hitting the 50-property limit.
    // The key includes a minute-level timestamp, so we can parse and compare ages.
    try {
      const cutoff = Date.now() - 30 * 60 * 1000;
      const all = props.getProperties();
      Object.keys(all).forEach(k => {
        if (!k.startsWith("dedup|")) return;
        // Key format: "dedup|actionName|POOL | TECH | NOTES | yyyy-MM-dd HH:mm"
        const tsMatch = k.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/);
        if (tsMatch) {
          const age = new Date(tsMatch[1]).getTime();
          if (age < cutoff) props.deleteProperty(k);
        }
      });
    } catch (_) {}

    props.setProperty(propKey, "done");

    return true;
  } finally {
    lock.releaseLock();
  }
}
