// ══════════════════════════════════════════════════════════════════════════════
// API — shared fetch helpers (AS and SEC defined in constants.js)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Performs a POST request to Google Apps Script. 
 * Sends body as a plain string without Content-Type to avoid CORS preflight.
 * Google Apps Script handles this as a "Simple Request".
 * 
 * @param {Object} payload - The data to send in the POST body.
 * @param {Object} options - Optional fetch overrides (e.g. signal).
 */
function api(payload, options = {}) {
  const fetchOptions = {
    method: 'POST',
    body: JSON.stringify(payload),
    // Intentionally omitting Content-Type header to avoid OPTIONS preflight
    ...options
  };

  // Ensure no Content-Type was accidentally passed in options.headers
  if (fetchOptions.headers) {
    if (fetchOptions.headers instanceof Headers) {
      fetchOptions.headers.delete('Content-Type');
    } else {
      delete fetchOptions.headers['Content-Type'];
      delete fetchOptions.headers['content-type'];
    }
  }

  return fetch(AS, fetchOptions).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

/**
 * Performs a GET request to Google Apps Script.
 * Encodes all parameters into the URL query string to ensure a "Simple Request".
 * 
 * @param {Object} params - Key-value pairs for the query string (e.g. {action: '...'}).
 * @param {Object} options - Optional fetch overrides (e.g. signal).
 */
function apiGet(params, options = {}) {
  const url = new URL(AS);
  
  // Append params to the URL search string
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, v);
    }
  });

  const fetchOptions = {
    method: 'GET',
    ...options
  };

  // Completely remove custom headers for GET to avoid any preflight triggers
  delete fetchOptions.headers;

  return fetch(url.toString(), fetchOptions).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}
