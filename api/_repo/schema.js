// ══════════════════════════════════════════════════════════════════════════════
// RELATIONAL SCHEMA — one definition of the sales data model
//
// These tabs already exist and are already populated by appscript/SalesHub.js
// (syncQuoteToNormalized_). Until now they were a WRITE-ONLY MIRROR: no screen
// read them, so nothing noticed when they drifted from the flat Quotes sheet.
// This file makes them the model, and Quotes a derived compatibility export.
//
// ⚠️ Column lists MUST stay supersets of the MCPS_*_HEADERS constants in
// appscript/SalesHub.js. Apps Script still writes these tabs during signing, and
// a column it writes but we do not declare is a column we would silently drop.
//
// The shape is deliberately Postgres-ready: every entity has a single-column
// primary key, foreign keys are plain id columns, and nothing depends on row
// order or cell position. Migrating is then `CREATE TABLE` + a copy, not a
// redesign — which is the whole reason for going relational rather than just
// making the spreadsheet faster.
// ══════════════════════════════════════════════════════════════════════════════

export const ENTITIES = {
  clients: {
    sheet: 'Clients',
    id: 'client_id',
    prefix: 'CLI',
    width: 6,
    columns: [
      'client_id', 'first_name', 'last_name', 'display_name', 'email', 'phone',
      'billing_address', 'billing_city', 'billing_state', 'billing_zip', 'status',
      'created_at', 'updated_at', 'legacy_quote_ids', 'notes'
    ]
  },

  locations: {
    sheet: 'Client_Locations',
    id: 'location_id',
    prefix: 'LOC',
    width: 6,
    fk: { client_id: 'clients' },
    columns: [
      'location_id', 'client_id', 'pool_id', 'service_address', 'city', 'state',
      'zip_code', 'area', 'pool_type', 'pool_size', 'material', 'spa', 'finish',
      'debris_level', 'sun_exposure', 'pets_on_property', 'robot_on_site',
      'year_built', 'active', 'created_at', 'updated_at', 'notes'
    ]
  },

  proposals: {
    sheet: 'Proposals',
    id: 'proposal_id',
    prefix: 'PRP',
    width: 6,
    fk: { client_id: 'clients', location_id: 'locations' },
    columns: [
      'proposal_id', 'proposal_number', 'legacy_quote_id', 'client_id',
      'location_id', 'status', 'service_type', 'proposal_title', 'created_by',
      'quote_source', 'quote_version', 'valid_until', 'travel_fee',
      'travel_one_way_miles', 'travel_round_trip_miles',
      'travel_billable_round_trip_miles', 'distance_source', 'subtotal',
      'discount_type', 'discount_value', 'discount_amount', 'discounted_subtotal',
      'tax_rate', 'sales_tax', 'total', 'chem_cost_est', 'net_profit_est',
      'margin_percent', 'specs_summary', 'proposal_pdf_url', 'contract_url',
      'proposal_image_url', 'sent_at', 'accepted_at', 'declined_at', 'expired_at',
      'converted_at', 'created_at', 'updated_at', 'notes',
      // ── Added by the relational write path ──────────────────────────────────
      // The flat sheet could only hold one discount figure, so a price ABOVE the
      // rate card had nowhere to live and was clamped away. These give a premium
      // a home of its own instead of overloading discount_amount with a sign.
      'adjustment_kind',      // 'none' | 'discount' | 'premium'
      'adjustment_type',      // 'percentage' | 'dollar' | 'custom'
      'adjustment_value',     // exactly what the operator typed
      'premium_amount',
      'service_key',          // machine key, never the display label
      'scope_items_json',
      'plan_options_json',
      'manual_price',
      'pricing_source',       // 'server' — recorded so a client-priced row is identifiable
      'idempotency_key',
      'change_log'
    ]
  },

  proposalItems: {
    sheet: 'Proposal_Items',
    id: 'proposal_item_id',
    prefix: 'PIT',
    width: 6,
    fk: { proposal_id: 'proposals' },
    columns: [
      'proposal_item_id', 'proposal_id', 'line_type', 'product_service_name',
      'description', 'quantity', 'rate', 'amount', 'taxable', 'quickbooks_sku',
      'quickbooks_item_name', 'sort_order', 'created_at', 'updated_at',
      // Re-pricing supersedes lines rather than deleting them. An executed or
      // previously-sent document must stay reproducible, so the old lines remain
      // and are marked instead of vanishing.
      'status',          // 'active' | 'superseded'
      'superseded_at'
    ]
  },

  agreements: {
    sheet: 'Service_Agreements',
    id: 'agreement_id',
    prefix: 'AGR',
    width: 4,
    fk: { client_id: 'clients', location_id: 'locations', proposal_id: 'proposals' },
    columns: [
      'agreement_id', 'agreement_number', 'client_id', 'location_id',
      'proposal_id', 'service_account_id', 'source_quote_id', 'status',
      'signature_required', 'activation_method', 'service_type', 'service_name',
      'monthly_rate', 'startup_fee', 'travel_fee', 'tax_rate', 'sales_tax', 'total',
      'billing_start', 'service_start', 'invoice_day', 'agreement_pdf_url',
      'contract_url', 'contract_file_id', 'signrequest_id', 'sent_at', 'signed_at',
      'declined_at', 'activated_at', 'created_by', 'created_at', 'updated_at',
      'notes',
      'signature_name', 'signature_image_url', 'signature_method', 'signer_ip',
      'signer_user_agent', 'consent_accepted', 'consent_at', 'signed_pdf_url',
      'document_version', 'agreement_type', 'target_agreement_id'
    ]
  },

  serviceAccounts: {
    sheet: 'Service_Accounts',
    id: 'service_account_id',
    prefix: 'SVA',
    width: 6,
    fk: { client_id: 'clients', location_id: 'locations' },
    columns: [
      'service_account_id', 'client_id', 'location_id', 'source_proposal_id',
      'source_agreement_id', 'source_quote_id', 'pool_id', 'service_type',
      'service_name', 'status', 'schedule_type', 'route_status', 'billing_type',
      'monthly_rate', 'tax_rate', 'invoice_day', 'billing_start', 'service_start',
      'service_end', 'payment_log', 'contract_status', 'contract_url', 'created_at',
      'updated_at', 'notes'
    ]
  }
};

// The flat legacy sheet. Still written on every save so the proposal PDF, the
// signing page, Comms targeting, the Home dashboard and the spreadsheet reports
// keep working unchanged — but ONE WAY ONLY. It is an export, never a source.
// Reading it for logic is what the relational model exists to stop.
export const COMPAT_SHEET = 'Quotes';

// Sequence numbers that are customer-visible rather than internal ids.
export const SEQUENCES = {
  proposal_number: { sheet: 'Proposals', column: 'proposal_number', prefix: 'PRO', width: 4 },
  agreement_number: { sheet: 'Service_Agreements', column: 'agreement_number', prefix: 'AGN', width: 4 },
  pool_id: { sheet: 'Quotes', column: 'pool_id', prefix: 'MCPS', width: 4 }
};

// Every tab the quote write path touches, in one list, so a save is ONE batchGet
// instead of six sequential opens. This is where the speed actually comes from —
// not from the schema, but from reading it all at once and joining in memory.
export const QUOTE_CONTEXT_RANGES = [
  ENTITIES.clients.sheet,
  ENTITIES.locations.sheet,
  ENTITIES.proposals.sheet,
  ENTITIES.proposalItems.sheet,
  ENTITIES.agreements.sheet,
  ENTITIES.serviceAccounts.sheet,
  COMPAT_SHEET
];

export function entityBySheet(sheetName) {
  const key = Object.keys(ENTITIES).find(k => ENTITIES[k].sheet === sheetName);
  return key ? ENTITIES[key] : null;
}
