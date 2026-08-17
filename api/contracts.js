import {
  getCached,
  hasAdminAccess,
  readSheetRanges,
  rowsToObjects,
  sendJson,
  validatePortalSession,
  validatePortalSessionFromSheets
} from './_sheets.js';

const CONTRACTS_CACHE_MS = 20 * 1000;
const DEFAULT_TZ = 'America/Chicago';
const CONTRACT_RANGES = [
  'Service_Agreements',
  'Clients',
  'Client_Locations',
  'Quotes',
  'Proposal_Approvals'
];

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function firstValue(row, keys) {
  for (const key of keys) {
    const value = clean(row && row[key]);
    if (value) return value;
  }
  return '';
}

function mapBy(rows, key) {
  const out = new Map();
  (rows || []).forEach(row => {
    const id = clean(row && row[key]);
    if (id && !out.has(id)) out.set(id, row);
  });
  return out;
}

function quoteIdentity(row) {
  const name = firstValue(row, ['client_name'])
    || [firstValue(row, ['first_name']), firstValue(row, ['last_name'])].filter(Boolean).join(' ');
  const label = [firstValue(row, ['address', 'service_address']), firstValue(row, ['city'])]
    .filter(Boolean)
    .join(', ');
  return { name, label };
}

export function withContractCustomerNames(agreements, clients, locations, quotes) {
  const clientsById = mapBy(clients, 'client_id');
  const locationsById = mapBy(locations, 'location_id');
  const quotesById = mapBy(quotes, 'quote_id');

  return (agreements || []).map(row => {
    const agreement = Object.assign({}, row);
    let name = '';
    let label = '';

    const client = clientsById.get(clean(agreement.client_id));
    if (client) {
      name = firstValue(client, ['display_name'])
        || [firstValue(client, ['first_name']), firstValue(client, ['last_name'])].filter(Boolean).join(' ');
    }

    const location = locationsById.get(clean(agreement.location_id));
    if (location) {
      label = [
        firstValue(location, ['service_address', 'address']),
        firstValue(location, ['city'])
      ].filter(Boolean).join(', ');
    }

    if (!name || !label) {
      const quote = quotesById.get(clean(agreement.source_quote_id));
      if (quote) {
        const fallback = quoteIdentity(quote);
        if (!name) name = fallback.name;
        if (!label) label = fallback.label;
      }
    }

    agreement.customer_name = name || '';
    agreement.location_label = label || '';
    return agreement;
  });
}

function isAgreementAmendment(row) {
  return clean(row && row.agreement_type).toLowerCase() === 'amendment';
}

function followupApprovalForAgreement(agreement, approvals) {
  const agreementId = clean(agreement && agreement.agreement_id);
  if (!agreementId) return null;

  const targetMatches = (approvals || []).filter(row => clean(row.target_agreement_id) === agreementId);
  if (targetMatches.length === 1) return targetMatches[0];
  if (targetMatches.length > 1) return null;
  if (isAgreementAmendment(agreement)) return null;

  const proposalId = clean(agreement.proposal_id);
  const quoteId = clean(agreement.source_quote_id);
  const originalMatches = (approvals || []).filter(row => {
    if (clean(row.target_agreement_id)) return false;
    if (proposalId && clean(row.proposal_id) === proposalId) return true;
    if (quoteId && clean(row.quote_id) === quoteId) return true;
    return false;
  });
  return originalMatches.length === 1 ? originalMatches[0] : null;
}

export function withContractFollowups(agreements, approvals) {
  return (agreements || []).map(row => {
    const agreement = Object.assign({}, row);
    const approval = followupApprovalForAgreement(agreement, approvals);
    if (!approval) return agreement;
    agreement.followup_approval_id = clean(approval.approval_id);
    agreement.followup_enabled = clean(approval.followup_enabled);
    agreement.followup_schedule = clean(approval.followup_schedule);
    agreement.final_notice_lead_days = clean(approval.final_notice_lead_days);
    agreement.followup_next_index = clean(approval.followup_next_index);
    agreement.followup_cycle = clean(approval.followup_cycle);
    agreement.last_followup_at = clean(approval.last_followup_at);
    agreement.last_followup_error = clean(approval.last_followup_error);
    agreement.followup_stopped_reason = clean(approval.followup_stopped_reason);
    agreement.followup_updated_at = clean(approval.followup_updated_at);
    agreement.approval_status = clean(approval.status);
    agreement.approval_sent_at = clean(approval.sent_at);
    agreement.approval_expires_at = clean(approval.expires_at);
    return agreement;
  });
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = clean(value);
  if (!raw) return null;

  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    return new Date(Date.UTC(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 12));
  }

  const usDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usDate) {
    return new Date(Date.UTC(Number(usDate[3]), Number(usDate[1]) - 1, Number(usDate[2]), 12));
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function datePart(date, timezone, part) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  return parts.find(p => p.type === part)?.value || '';
}

function monthKey(date, timezone) {
  return `${datePart(date, timezone, 'year')}-${datePart(date, timezone, 'month')}`;
}

function dateKey(date, timezone) {
  return `${datePart(date, timezone, 'year')}-${datePart(date, timezone, 'month')}-${datePart(date, timezone, 'day')}`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isOriginalAgreement(row) {
  const type = clean(row && row.agreement_type).toLowerCase();
  return !type || type === 'original';
}

export function buildContractsFunnel(approvals, agreements, months = 6, now = new Date(), timezone = DEFAULT_TZ) {
  const signedByProposal = {};
  const signedByQuote = {};

  (agreements || []).forEach(agreement => {
    if (!isOriginalAgreement(agreement)) return;
    const signedAt = parseDate(agreement.signed_at);
    if (!signedAt) return;

    const proposalId = clean(agreement.proposal_id);
    const quoteId = clean(agreement.source_quote_id);
    if (proposalId && !signedByProposal[proposalId]) signedByProposal[proposalId] = signedAt;
    if (quoteId && !signedByQuote[quoteId]) signedByQuote[quoteId] = signedAt;
  });

  const buckets = {};
  let expiringSoon = 0;
  let amendmentsSigned = 0;
  let trackingStart = null;

  (approvals || []).forEach(row => {
    const isAmendment = !!clean(row.target_agreement_id);
    const status = clean(row.status).toUpperCase();
    const sentAt = parseDate(row.sent_at);
    const viewedAt = parseDate(row.viewed_at);
    const expiresAt = parseDate(row.expires_at);

    if (viewedAt && (!trackingStart || viewedAt.getTime() < trackingStart.getTime())) {
      trackingStart = viewedAt;
    }

    if (
      status === 'SENT'
      && expiresAt
      && expiresAt.getTime() > now.getTime()
      && expiresAt.getTime() - now.getTime() <= 7 * 86400000
    ) {
      expiringSoon += 1;
    }

    if (isAmendment) {
      if (status === 'APPROVED') amendmentsSigned += 1;
      return;
    }

    if (!sentAt) return;

    const key = monthKey(sentAt, timezone);
    const bucket = buckets[key] || (buckets[key] = {
      month: key,
      sent: 0,
      viewed: 0,
      signed: 0,
      days: []
    });

    bucket.sent += 1;
    if (viewedAt) bucket.viewed += 1;

    if (status === 'APPROVED') {
      bucket.signed += 1;
      const proposalId = clean(row.proposal_id);
      const quoteId = clean(row.quote_id);
      const signedAt = signedByProposal[proposalId] || signedByQuote[quoteId] || parseDate(row.responded_at);
      if (signedAt) {
        const days = (signedAt.getTime() - sentAt.getTime()) / 86400000;
        if (days >= 0) bucket.days.push(days);
      }
    }
  });

  const currentKey = monthKey(now, timezone);
  if (!buckets[currentKey]) {
    buckets[currentKey] = { month: currentKey, sent: 0, viewed: 0, signed: 0, days: [] };
  }

  const shape = bucket => {
    const med = median(bucket.days);
    return {
      month: bucket.month,
      sent: bucket.sent,
      viewed: bucket.viewed,
      signed: bucket.signed,
      close_rate: bucket.sent ? Math.round((bucket.signed / bucket.sent) * 1000) / 10 : 0,
      median_days_to_close: med === null ? null : Math.round(med * 10) / 10
    };
  };

  const count = Math.min(24, Math.max(1, Number(months) || 6));
  const keys = Object.keys(buckets).sort().reverse().slice(0, count);
  const latestKey = Object.keys(buckets)
    .filter(key => buckets[key].sent > 0)
    .sort()
    .reverse()[0];

  return {
    ok: true,
    months: keys.map(key => shape(buckets[key])),
    current: shape(buckets[currentKey]),
    latest_cohort: latestKey && latestKey !== currentKey ? shape(buckets[latestKey]) : null,
    expiring_soon: expiringSoon,
    amendments_signed: amendmentsSigned,
    viewed_tracking_since: trackingStart ? dateKey(trackingStart, timezone) : '',
    timezone,
    generated_at: now.toISOString()
  };
}

function sortAgreements(agreements) {
  return agreements.slice().sort((a, b) => clean(b.signed_at || b.sent_at || b.created_at)
    .localeCompare(clean(a.signed_at || a.sent_at || a.created_at)));
}

async function loadContractsPayload(months) {
  const values = await readSheetRanges(CONTRACT_RANGES);
  const agreements = rowsToObjects(values.Service_Agreements);
  const clients = rowsToObjects(values.Clients);
  const locations = rowsToObjects(values.Client_Locations);
  const quotes = rowsToObjects(values.Quotes);
  const approvals = rowsToObjects(values.Proposal_Approvals);

  const joinedAgreements = sortAgreements(
    withContractFollowups(
      withContractCustomerNames(agreements, clients, locations, quotes),
      approvals
    )
  );

  return {
    agreements: joinedAgreements,
    funnel: buildContractsFunnel(approvals, joinedAgreements, months)
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }

    const token = req.query && req.query.token;
    let authSource = 'sheets';
    const session = await validatePortalSessionFromSheets(token).catch(error => {
      console.warn('contracts direct auth failed; falling back to GAS validation', error.message || error);
      authSource = 'gas';
      return validatePortalSession(token);
    });
    if (!session) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    if (!hasAdminAccess(session)) return sendJson(res, 403, { ok: false, error: 'Admin access required.' });

    const months = Math.min(24, Math.max(1, Number(req.query && req.query.months) || 6));
    const refresh = ['1', 'true', 'yes'].includes(clean(req.query && req.query.refresh).toLowerCase());
    const cacheVersion = clean(req.query && req.query.cache_version) || 'default';
    const cacheKey = `contracts:stage5b:v2:${cacheVersion}:${months}`;
    const data = refresh
      ? await loadContractsPayload(months)
      : await getCached(cacheKey, CONTRACTS_CACHE_MS, () => loadContractsPayload(months));

    return sendJson(res, 200, {
      ok: true,
      source: 'sheets_api',
      auth_source: authSource,
      cache_ttl_ms: refresh ? 0 : CONTRACTS_CACHE_MS,
      agreements: data.agreements,
      funnel: data.funnel
    });
  } catch (error) {
    console.error('contracts endpoint failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'Contracts read failed' });
  }
}
