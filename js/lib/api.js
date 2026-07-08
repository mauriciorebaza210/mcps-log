// ══════════════════════════════════════════════════════════════════════════════
// API — shared fetch helpers (AS and SEC defined in constants.js)
// ══════════════════════════════════════════════════════════════════════════════

const GAS_PROXY_PATH = '/api/gas';

function gasEndpoint_() {
  const protocol = window.location && window.location.protocol;
  if (protocol === 'http:' || protocol === 'https:') return GAS_PROXY_PATH;
  return AS;
}

function parseApiResponse_(res) {
  return res.text().then(text => {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Expected JSON from ${res.url}, got: ${text.slice(0, 160)}`);
    }
  });
}

/**
 * Performs a POST request through the same-origin GAS proxy when hosted.
 * Falls back to direct Apps Script requests when opened outside http(s).
 * 
 * @param {Object} payload - The data to send in the POST body.
 * @param {Object} options - Optional fetch overrides (e.g. signal).
 */
function currentSessionToken_() {
  if (typeof _s !== 'undefined' && _s && _s.token) return _s.token;
  try {
    const stored = JSON.parse(localStorage.getItem('mcps_s') || 'null');
    return stored && stored.token ? stored.token : '';
  } catch (_) {
    return '';
  }
}

function withSessionToken_(payload) {
  const out = Object.assign({}, payload || {});
  if (out.token === undefined) {
    const token = currentSessionToken_();
    if (token) out.token = token;
  }
  return out;
}

function api(payload, options = {}) {
  const bodyPayload = withSessionToken_(payload);
  const endpoint = gasEndpoint_();
  const fetchOptions = {
    method: 'POST',
    body: JSON.stringify(bodyPayload),
    ...options
  };

  if (endpoint === GAS_PROXY_PATH) {
    const headers = new Headers(fetchOptions.headers || {});
    headers.set('Content-Type', 'application/json');
    fetchOptions.headers = headers;
  } else if (fetchOptions.headers) {
    // Ensure no Content-Type was accidentally passed in options.headers
    if (fetchOptions.headers instanceof Headers) {
      fetchOptions.headers.delete('Content-Type');
    } else {
      delete fetchOptions.headers['Content-Type'];
      delete fetchOptions.headers['content-type'];
    }
  }

  return fetch(endpoint, fetchOptions).then(parseApiResponse_);
}

/**
 * Performs a GET request through the same-origin GAS proxy when hosted.
 * Encodes all parameters into the URL query string.
 * 
 * @param {Object} params - Key-value pairs for the query string (e.g. {action: '...'}).
 * @param {Object} options - Optional fetch overrides (e.g. signal).
 */
function apiGet(params, options = {}) {
  const url = new URL(gasEndpoint_(), window.location.origin);
  const requestParams = withSessionToken_(params);
  
  // Append params to the URL search string
  Object.entries(requestParams).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, v);
    }
  });

  const fetchOptions = {
    method: 'GET',
    ...options
  };

  // GET does not need custom headers here, and direct fallback should stay simple.
  delete fetchOptions.headers;

  return fetch(url.toString(), fetchOptions).then(parseApiResponse_);
}

function apiLocalGet(path, params = {}, options = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  return fetch(url.toString(), { method: 'GET', ...options }).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}
