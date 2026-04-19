const CFG = {
  SHEETS: {
    LOG:      "Quotes_Log",
    CRM:      "CRM",
    SIGNED:   "Signed_Customers",
    COMPLETED_ONE_TIME: "Completed_One_Time",
    SETTINGS: "Settings",
    DEBUG:    "DEBUG",
  },

  COST_TRACKER: {
    get SPREADSHEET_ID() {
      return PropertiesService.getScriptProperties().getProperty("COST_TRACKER_SS_ID") || "";
    },
    SHEET_NAME: "Chem_Cost_per_Pool",
  },

  API: {
    get EXPECTED_KEY() {
      return PropertiesService.getScriptProperties().getProperty("API_KEY") || "";
    },
  },

  CONTRACT: {
    get TEMPLATE_ID() {
      return PropertiesService.getScriptProperties().getProperty("TEMPLATE_DOC_ID") || "";
    },
    get FOLDER_ID() {
      return PropertiesService.getScriptProperties().getProperty("CONTRACTS_FOLDER_ID") || "";
    },
  },

  // ── Startup lifecycle ─────────────────────────────────────────────────
  // Admin email to notify when a sponsored client is ready to sign.
  // Set via Script Properties: ADMIN_NOTIFICATION_EMAIL
  STARTUP: {
    get ADMIN_EMAIL() {
      return PropertiesService.getScriptProperties().getProperty("ADMIN_NOTIFICATION_EMAIL")
        || "mauricio@mcpoolsolutions.org";
    },
    // Monthly visits required before firing the "ready to sign" notification.
    SPONSORED_TRIGGER_VISIT: 4,
  },

  STATUS: ["UNSENT", "CONTRACT_GENERATED", "SENT", "SIGNED", "LOST", "VOIDED", "COMPLETED_ONE_TIME"],

  GUARDS: {
    MIN_SECONDS_BETWEEN_SENDS: 60,
  },
};


// 00_config.gs

const SCHEMA = {
  LOG: [
    "timestamp", "quote_id", "first_name", "last_name", "email", "phone", "address",
    "service", "size", "spa", "finish", "debris",
    "zip_code", "city", "travel_fee", "travel_one_way_miles", "travel_round_trip_miles",
    "travel_billable_round_trip_miles", "distance_source",

    // ✅ Discount tracking (NEW)
    "service_subtotal",
    "discount_type",
    "discount_value",
    "discount_amount",
    "discounted_service_subtotal",

    // Existing totals
    "quote_subtotal", "sales_tax", "total_with_tax",
    "chem_cost_est", "net_profit_est", "margin_percent",
    "specs_summary", "created_by", "quote_source", "quote_version"
  ],

  CRM: [
    "timestamp", "quote_id", "first_name", "last_name", "email", "phone",
    "address", "city", "zip_code",
    "service", "size", "spa", "finish", "debris",
    "travel_fee", "travel_one_way_miles", "travel_round_trip_miles",
    "travel_billable_round_trip_miles", "distance_source",

    // ✅ Discount tracking (NEW)
    "service_subtotal",
    "discount_type",
    "discount_value",
    "discount_amount",
    "discounted_service_subtotal",

    // Existing totals
    "quote_subtotal", "sales_tax", "total_with_tax",
    "quickbooks_skus",
    "chem_cost_est", "net_profit_est", "margin_percent",
    "specs_summary", "created_by", "quote_source", "quote_version",
    "contract_start_date",
    "generate_contract", "contract_generated", "contract_url", "contract_file_id" , "contract_download_url",
    "send_contract", "send_contract_at", "sent_at", "signrequest_id", "signrequest_url",
    "signed_at", "status",

    // ── MCP sponsorship (flows to Signed_Customers on promotion) ─────────
    "sponsored_by_mcp",     // TRUE = MCP paid first month
    "startup_start_date",   // date operator will begin the startup
    "startup_total_days",   // number of days the startup lasts (3 for MCP-sponsored)
  ],


  SIGNED: [
    "pool_id",
    "timestamp", "quote_id", "first_name", "last_name", "email", "phone",
    "address", "city", "zip_code",
    "service", "size", "spa", "finish", "debris",
    "travel_fee", "travel_one_way_miles", "travel_round_trip_miles",
    "travel_billable_round_trip_miles", "distance_source",

    // ✅ Discount tracking
    "service_subtotal",
    "discount_type",
    "discount_value",
    "discount_amount",
    "discounted_service_subtotal",

    // Existing totals
    "quote_subtotal", "sales_tax", "total_with_tax",
    "quickbooks_skus",
    "chem_cost_est", "net_profit_est", "margin_percent",
    "specs_summary", "created_by", "quote_source", "quote_version",
    "contract_start_date",
    "generate_contract", "contract_generated", "contract_url",
    "send_contract", "sent_at",
    "signed_at", "service_status", "contract_status", "lost_at",

    // ── Startup lifecycle tracking (auto-managed, do not edit manually) ──
    "startup_total_days",        // 0 = not a startup; 3 = MCP-sponsored 3-day; etc.
    "startup_visits_logged",     // auto-incremented by StartupLifecycle.gs on each form submit
    "startup_complete",          // TRUE once visits_logged >= total_days
    "monthly_start_date",        // date of final startup visit = first day of paid month

    // ── Monthly / sponsored tracking ─────────────────────────────────────
    "monthly_visits_logged",     // incremented on each post-startup form submit
    "sponsored_contract_notified", // TRUE after 4th monthly visit notification is fired

    // ── MCP sponsorship + scheduling ──────────────────────────────────────
    "sponsored_by_mcp",          // TRUE = MCP paid first month (drives QBO invoice)
    "startup_start_date",        // date entered in quote calc; pins startup to exact days
    "trigger_qbo_invoice",       // auto-set TRUE on 3rd MCP visit → Zapier fires QBO invoice
  ],

  COMPLETED_ONE_TIME: [
    "pool_id",
    "timestamp", "quote_id", "first_name", "last_name", "email", "phone",
    "address", "city", "zip_code",
    "service", "size", "spa", "finish", "debris",
    "travel_fee", "travel_one_way_miles", "travel_round_trip_miles",
    "travel_billable_round_trip_miles", "distance_source",

    "service_subtotal",
    "discount_type",
    "discount_value",
    "discount_amount",
    "discounted_service_subtotal",

    "quote_subtotal", "sales_tax", "total_with_tax",
    "chem_cost_est", "net_profit_est", "margin_percent",
    "specs_summary", "created_by", "quote_source", "quote_version",
    "contract_start_date",
    "generate_contract", "contract_generated", "contract_url",
    "signed_at", "status", "lost_at", "completed_at"
  ],

};
