// ══════════════════════════════════════════════════════════════════════════════
// PRICING ENGINE — the single source of truth for what a job costs
//
// Loads three ways, deliberately, so there is exactly ONE implementation:
//   browser   <script src="js/lib/pricing.js">   -> globalThis.MCPS_PRICING
//   node test require('js/lib/pricing.js')       -> module.exports
//   vercel    import PRICING from '.../pricing.js' -> module.exports (default)
//             NOT createRequire — see the note in api/_repo/quote-write.js
//
// ⚠️ WHY THIS FILE EXISTS. The engine used to live only in js/features/quotes.js,
// and appscript/SalesHub.js wrote whatever dollar figures the browser sent it —
// no recompute, no bounds check. Anyone holding a session token could save a
// legally-binding agreement at any price, and a quote's own arithmetic was never
// verified against itself. Pricing now runs here and the server recomputes from
// the same inputs, so the browser proposes and the server decides.
//
// Pure functions only: no DOM, no fetch, no Date.now(). Everything needed for a
// price is an argument, which is what makes it testable and what makes the
// server able to reach the identical answer.
// ══════════════════════════════════════════════════════════════════════════════

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MCPS_PRICING = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Rate card ───────────────────────────────────────────────────────────────
  // Kept as plain data, not scattered literals, because the next step is loading
  // this from a Pricing_Catalog sheet so a rate change is an edit and not a
  // deploy. Anything reading these must go through CATALOG so that swap is one
  // change. The UI must also render its "+$25" labels FROM here — they used to be
  // hardcoded a second time in index.html, where they could drift and lie.
  var CATALOG = {
    tax_rate: 0.0825,

    weekly_full:    { small: 220, medium: 260, large: 300 },
    weekly_chem:    { small: 25,  medium: 40,  large: 60  },
    biweekly:       { small: 120, medium: 140, large: 170 },

    // Fiberglass weekly is a flat rate that intentionally REPLACES the size
    // rate and every modifier — less brushing, no plaster. Left exactly as it
    // was; the change is that the UI now says so instead of showing live
    // "+$25" pills that quietly do nothing.
    fiberglass_weekly_flat: 200,

    green_to_clean_flat: 200,

    startup: {
      chemical:      287.86,
      chemical_cost: 162.86,
      programming:    62.50,
      pool_school:    62.50
    },

    modifiers: {
      spa:               25,
      dark_finish:       10,
      heavy_debris:      10,
      high_sun_exposure: 10,
      has_pets:           5,
      has_robot:         -5
    }
  };

  var MODIFIER_LABELS = {
    spa: 'Attached Spa',
    dark_finish: 'Dark Pool Color',
    heavy_debris: 'Debris: Heavy',
    high_sun_exposure: 'High Sun Exposure',
    has_pets: 'Pets on Property',
    has_robot: 'Cleaning Robot Discount'
  };

  // Service keys. ⚠️ These are the KEYS, never the display labels. Comparing a
  // label to a key is what silently killed repair work orders: SalesHub.js
  // tested `service === 'repair_job'` against 'Repair / Replacement / Other Job'
  // so the guard was never true and no Repair_Order row was ever created.
  var SERVICES = {
    weekly_full:    { key: 'weekly_full',    label: 'Weekly Full Service',              scope: 'weekly'  },
    biweekly_maint: { key: 'biweekly_maint', label: 'Bi-Weekly Maintenance',            scope: 'weekly'  },
    green_to_clean: { key: 'green_to_clean', label: 'Green-to-Clean Cleaning Service',  scope: 'g2c'     },
    pool_startup:   { key: 'pool_startup',   label: 'Pool Startup',                     scope: 'startup' },
    repair_job:     { key: 'repair_job',     label: 'Repair / Replacement / Other Job', scope: 'repair'  }
  };

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // Resolve a service KEY from either a key or a stored display label, so rows
  // written before this existed still price correctly.
  function serviceKeyOf(value) {
    var v = String(value == null ? '' : value).trim();
    if (SERVICES[v]) return v;
    var lower = v.toLowerCase();
    for (var k in SERVICES) {
      if (SERVICES[k].label.toLowerCase() === lower) return k;
    }
    // Legacy free-text tolerance, mirroring what the schedule dispatcher does.
    if (lower.indexOf('startup') !== -1) return 'pool_startup';
    if (lower.indexOf('green') !== -1) return 'green_to_clean';
    if (lower.indexOf('repair') !== -1 || lower.indexOf('other job') !== -1) return 'repair_job';
    if (lower.indexOf('bi-weekly') !== -1 || lower.indexOf('biweekly') !== -1) return 'biweekly_maint';
    if (lower.indexOf('weekly') !== -1) return 'weekly_full';
    return '';
  }

  // Does this configuration price itself, or does a human type the number?
  // Repair has always been operator-priced. Above-ground bi-weekly used to
  // return base 0 with pricing_ready false, which disabled Save forever with no
  // way forward — so it joins Repair instead of being a dead end.
  function requiresManualPrice(input) {
    var key = serviceKeyOf(input.service);
    if (key === 'repair_job') return true;
    if (key === 'biweekly_maint' && String(input.pool_type) === 'above_ground') return true;
    return false;
  }

  // ── Base service price ──────────────────────────────────────────────────────
  function calcBase(input) {
    var key   = serviceKeyOf(input.service);
    var size  = String(input.size || 'medium');
    var mat   = String(input.material || 'plaster');
    var svc   = SERVICES[key];

    var out = {
      service_key: key,
      service_label: svc ? svc.label : String(input.service || ''),
      base: 0,
      chem_cost: 0,
      manual: false,
      flat_rate: false,
      suppressed_modifiers: [],
      applied_modifiers: [],
      qb_names: [],
      qb_skus: [],
      warnings: []
    };

    if (!svc) {
      out.warnings.push('Unrecognised service type: "' + String(input.service || '') + '".');
      return out;
    }

    if (requiresManualPrice(input)) {
      out.manual = true;
      out.base = Math.max(num(input.manual_price), 0);
      if (key === 'repair_job') {
        var repairSku = String(input.repair_type) === 'other_job' ? 'OTHER-JOB' : 'REPAIR-GENERAL';
        out.qb_names = [svc.label];
        out.qb_skus  = [repairSku];
      } else {
        out.qb_names = [svc.label];
        out.qb_skus  = ['BIWEEKLY-AG-' + size.toUpperCase()];
        out.warnings.push('Above-ground bi-weekly has no rate card — enter the price for this pool.');
      }
      return out;
    }

    if (key === 'green_to_clean') {
      out.base = CATALOG.green_to_clean_flat;
      out.flat_rate = true;
      out.qb_names = [svc.label];
      out.qb_skus  = ['GTC-CLEAN'];
      return out;
    }

    if (key === 'pool_startup') {
      if (input.startup_chemical) {
        out.base += CATALOG.startup.chemical;
        out.chem_cost += CATALOG.startup.chemical_cost;
        out.qb_names.push('Startup Chemicals', 'Pool Startup Chemical Work');
        out.qb_skus.push('START-CHEM', 'START-CHEM-LABOR');
      }
      if (input.startup_programming) {
        out.base += CATALOG.startup.programming;
        out.qb_names.push('Pool Startup Programming');
        out.qb_skus.push('START-PROGRAM');
      }
      if (input.startup_pool_school) {
        out.base += CATALOG.startup.pool_school;
        out.qb_names.push('Pool School');
        out.qb_skus.push('POOL-SCHOOL');
      }
      if (!out.base) out.warnings.push('Select at least one startup service.');
      return out;
    }

    // Recurring: weekly_full or biweekly_maint (inground)
    var fiberglassFlat = (key === 'weekly_full' && mat === 'fiberglass');
    if (fiberglassFlat) {
      out.base = CATALOG.fiberglass_weekly_flat;
      out.flat_rate = true;
      out.qb_names = ['Swimming Pool Maintenance (Fiberglass Pool)'];
      out.qb_skus  = ['WEEKLY-FIBERGLASS'];
    } else if (key === 'weekly_full') {
      out.base = CATALOG.weekly_full[size] || 0;
      out.chem_cost = CATALOG.weekly_chem[size] || 0;
      out.qb_names = [svc.label];
      out.qb_skus  = ['WEEKLY-' + size.toUpperCase()];
    } else {
      out.base = CATALOG.biweekly[size] || 0;
      out.qb_names = [svc.label];
      out.qb_skus  = ['BIWEEKLY-' + size.toUpperCase()];
    }

    // Modifiers apply to recurring work only. On the fiberglass flat rate they
    // are reported as SUPPRESSED rather than silently dropped, so the UI can
    // show them as inactive instead of advertising a price effect it won't have.
    var active = {
      spa:               !!input.spa,
      dark_finish:       String(input.finish) === 'dark',
      heavy_debris:      String(input.debris) === 'heavy',
      high_sun_exposure: !!input.high_sun_exposure,
      has_pets:          !!input.has_pets,
      has_robot:         !!input.has_robot
    };

    Object.keys(CATALOG.modifiers).forEach(function (mod) {
      if (!active[mod]) return;
      if (fiberglassFlat) {
        out.suppressed_modifiers.push(mod);
        return;
      }
      out.base += CATALOG.modifiers[mod];
      out.applied_modifiers.push(mod);
    });

    if (fiberglassFlat && out.suppressed_modifiers.length) {
      out.warnings.push(
        'Fiberglass weekly is a flat $' + CATALOG.fiberglass_weekly_flat.toFixed(2) +
        ' — ' + out.suppressed_modifiers.map(function (m) { return MODIFIER_LABELS[m]; }).join(', ') +
        ' do not change the price.'
      );
    }

    out.base = round2(out.base);
    out.chem_cost = round2(out.chem_cost);
    return out;
  }

  // ── Price adjustment ────────────────────────────────────────────────────────
  // THE FIX AT THE HEART OF THIS FILE. The old qCalcDiscount() did
  // Math.min(cprice, subtotal) — a custom price above the preset was silently
  // rewritten DOWN to the preset, the discount line then computed to zero so it
  // hid itself, and the operator saw the preset with no indication their number
  // had been discarded. A pool service business must be able to charge a premium.
  //
  // Now: any positive custom price is honoured, and the result says plainly
  // whether it is a discount or a premium. Invalid input is REFUSED with a
  // reason instead of being coerced into something plausible.
  //
  //   kind: 'none' | 'discount' | 'premium'
  function calcAdjustment(subtotal, type, value) {
    var sub = round2(subtotal);
    var t = String(type || 'none').toLowerCase();
    var raw = String(value == null ? '' : value).trim();
    var v = parseFloat(raw);

    var none = { kind: 'none', amount: 0, adjusted: sub, percent: 0, error: '' };
    if (t === 'none' || t === '') return none;

    if (raw === '' || !isFinite(v)) {
      return { kind: 'none', amount: 0, adjusted: sub, percent: 0, error: 'Enter a number.' };
    }
    if (v < 0) {
      return { kind: 'none', amount: 0, adjusted: sub, percent: 0,
               error: 'Cannot be negative. Use Custom Price to set a figure directly.' };
    }

    if (t === 'percentage') {
      if (v > 100) {
        return { kind: 'none', amount: 0, adjusted: sub, percent: 0,
                 error: 'A discount cannot exceed 100%.' };
      }
      var pctAmt = round2(sub * v / 100);
      return { kind: pctAmt ? 'discount' : 'none', amount: pctAmt,
               adjusted: round2(sub - pctAmt), percent: round2(v), error: '' };
    }

    if (t === 'dollar' || t === 'dollar amount') {
      if (v > sub) {
        return { kind: 'none', amount: 0, adjusted: sub, percent: 0,
                 error: 'A discount of $' + v.toFixed(2) + ' exceeds the $' + sub.toFixed(2) +
                        ' service price. Use Custom Price instead.' };
      }
      var dAmt = round2(v);
      return { kind: dAmt ? 'discount' : 'none', amount: dAmt,
               adjusted: round2(sub - dAmt), percent: sub ? round2(dAmt / sub * 100) : 0, error: '' };
    }

    if (t === 'custom' || t === 'custom price') {
      var cp = round2(v);
      var delta = round2(cp - sub);
      if (delta === 0) return { kind: 'none', amount: 0, adjusted: cp, percent: 0, error: '' };
      return {
        kind: delta > 0 ? 'premium' : 'discount',
        amount: Math.abs(delta),
        adjusted: cp,
        percent: sub ? round2(Math.abs(delta) / sub * 100) : 0,
        error: ''
      };
    }

    return { kind: 'none', amount: 0, adjusted: sub, percent: 0,
             error: 'Unknown adjustment type: ' + type };
  }

  // ── Full quote ──────────────────────────────────────────────────────────────
  // One call, everything derived. `travel_fee` is passed in because it comes
  // from a distance lookup, not from the rate card.
  function priceQuote(input) {
    input = input || {};
    var base = calcBase(input);
    var adj = calcAdjustment(base.base, input.adjustment_type, input.adjustment_value);

    var travel = input.void_travel ? 0 : round2(num(input.travel_fee));
    var sub    = round2(adj.adjusted + travel);
    var tax    = round2(sub * CATALOG.tax_rate);
    var total  = round2(sub + tax);
    var net    = round2(sub - base.chem_cost);
    var margin = sub > 0 ? Math.round(net / sub * 1000) / 10 : 0;

    var warnings = base.warnings.slice();
    if (adj.error) warnings.push(adj.error);

    // Ready to save? A manual-price service needs a figure; everything else
    // needs a rate card hit. An adjustment error blocks too — better a disabled
    // button with a reason than a saved quote at a price nobody chose.
    var ready = !adj.error && !!base.service_key;
    if (ready) ready = base.manual ? base.base > 0 : base.base > 0;

    return {
      service_key:   base.service_key,
      service_label: base.service_label,
      scope_key:     SERVICES[base.service_key] ? SERVICES[base.service_key].scope : '',

      service_subtotal: base.base,       // rate card, before any adjustment
      adjustment_kind:  adj.kind,        // 'none' | 'discount' | 'premium'
      adjustment_amount: adj.amount,     // always positive
      adjustment_percent: adj.percent,
      adjusted_service: adj.adjusted,    // what the customer is charged for service

      travel_fee: travel,
      quote_subtotal: sub,
      tax_rate: CATALOG.tax_rate,
      sales_tax: tax,
      total_with_tax: total,

      chem_cost_est: base.chem_cost,
      net_profit_est: net,
      margin_percent: margin,

      requires_manual_price: base.manual,
      flat_rate: base.flat_rate,
      applied_modifiers: base.applied_modifiers,
      suppressed_modifiers: base.suppressed_modifiers,
      qb_names: base.qb_names,
      qb_skus: base.qb_skus,

      pricing_ready: ready,
      adjustment_error: adj.error,
      warnings: warnings
    };
  }

  // ── Server-side verification ────────────────────────────────────────────────
  // The browser sends its arithmetic along with the inputs. This recomputes from
  // the inputs alone and reports any money field that disagrees. The server
  // stores ITS OWN numbers regardless — this exists to surface a tampered or
  // stale client, not to decide the price.
  var MONEY_FIELDS = [
    'service_subtotal', 'adjusted_service', 'travel_fee',
    'quote_subtotal', 'sales_tax', 'total_with_tax'
  ];

  function verifyQuote(input, claimed, tolerance) {
    var tol = tolerance == null ? 0.01 : tolerance;
    var authoritative = priceQuote(input);
    var mismatches = [];
    if (claimed) {
      MONEY_FIELDS.forEach(function (f) {
        if (claimed[f] === undefined || claimed[f] === null || claimed[f] === '') return;
        var got = num(claimed[f]);
        var want = num(authoritative[f]);
        if (Math.abs(got - want) > tol) {
          mismatches.push({ field: f, claimed: round2(got), computed: round2(want) });
        }
      });
    }
    return { ok: mismatches.length === 0, priced: authoritative, mismatches: mismatches };
  }

  // ── Display strings ─────────────────────────────────────────────────────────
  // specs_summary is stored on the quote and rendered into the proposal PDF and
  // the signing page, so it belongs next to the pricing it describes rather than
  // being rebuilt by whichever screen happens to need it.
  function poolTypeLabel(v) { return String(v) === 'above_ground' ? 'Above Ground' : 'Inground'; }
  function materialLabel(v) {
    var m = String(v || 'plaster');
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  function buildSpecsSummary(input, priced) {
    input = input || {};
    priced = priced || priceQuote(input);
    var key = priced.service_key;
    var specs = [];

    if (key === 'repair_job') {
      var name = [input.first_name, input.last_name].filter(Boolean).join(' ').trim();
      return [
        'Job Type: ' + (String(input.repair_type) === 'other_job' ? 'Other Job' : 'Repair / Replacement'),
        'Company: ' + (String(input.repair_company || '').trim() || name || 'N/A'),
        'Address: ' + (String(input.address || '').trim() || 'Not provided'),
        'QuickBooks SKU: ' + (priced.qb_skus[0] || '')
      ].join(', ');
    }

    specs.push('Pool Type: ' + poolTypeLabel(input.pool_type));
    specs.push('Size: ' + (key === 'pool_startup' ? 'startup' : String(input.size || 'medium')));
    specs.push('Material: ' + materialLabel(input.material));

    if (key === 'weekly_full' || key === 'biweekly_maint') {
      if (priced.flat_rate && String(input.material) === 'fiberglass') {
        specs.push('Fiberglass Weekly Full Service Flat Rate');
      }
      // Only what actually moved the price, plus the neutral defaults, so the
      // summary never claims a surcharge the customer was not billed.
      var applied = priced.applied_modifiers || [];
      if (applied.indexOf('spa') !== -1) specs.push('Attached Spa');
      if (!priced.flat_rate) {
        specs.push(String(input.finish) === 'dark' ? 'Dark Pool Color' : 'Light Pool Color');
        specs.push(String(input.debris) === 'heavy' ? 'Debris: Heavy' : 'Debris: Light');
      }
      if (applied.indexOf('high_sun_exposure') !== -1) specs.push('High Sun Exposure');
      if (applied.indexOf('has_pets') !== -1) specs.push('Pets on Property');
      if (applied.indexOf('has_robot') !== -1) specs.push('Cleaning Robot Discount');
      (priced.suppressed_modifiers || []).forEach(function (m) {
        specs.push(MODIFIER_LABELS[m] + ' (no charge — flat rate)');
      });
    } else {
      if (input.spa) specs.push('Attached Spa');
      specs.push('Pool Color: ' + (String(input.finish) === 'dark' ? 'Dark' : 'Light'));
      specs.push('Debris: ' + (String(input.debris) === 'heavy' ? 'Heavy' : 'Light'));
      if (input.high_sun_exposure) specs.push('High Sun Exposure');
      if (input.has_pets) specs.push('Pets on Property');
      if (input.has_robot) specs.push('Cleaning Robot On Site');
      if (key === 'pool_startup') {
        var si = [];
        if (input.startup_chemical) si.push('Chemical Work');
        if (input.startup_programming) si.push('Programming');
        if (input.startup_pool_school) si.push('Pool School');
        specs.push('Startup Services: ' + (si.join(', ') || 'None Selected'));
        if (String(input.startup_company || '').trim()) {
          specs.push('Startup Coming From: ' + String(input.startup_company).trim());
        }
      }
    }
    return specs.join(', ');
  }

  return {
    CATALOG: CATALOG,
    SERVICES: SERVICES,
    MODIFIER_LABELS: MODIFIER_LABELS,
    serviceKeyOf: serviceKeyOf,
    requiresManualPrice: requiresManualPrice,
    calcBase: calcBase,
    calcAdjustment: calcAdjustment,
    priceQuote: priceQuote,
    verifyQuote: verifyQuote,
    buildSpecsSummary: buildSpecsSummary,
    poolTypeLabel: poolTypeLabel,
    materialLabel: materialLabel,
    round2: round2
  };
});
