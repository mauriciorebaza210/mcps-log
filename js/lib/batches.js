// ══════════════════════════════════════════════════════════════════════════════
// BATCHES: which people a batch starts (pure; shared by the Lifecycle page and
// the engine via scripts/ee-sync.mjs).
//
// A batch takes contacts waiting in Needs review from one group, narrowed by
// filters, and starts N of them on its start date (PLAN.md → Plan changes
// 2026-11-10). "Pick now" stores the exact people when the batch is created;
// "pick at start" runs this again on the start date over whoever is still waiting.
//
//   eligible(contacts, batch)        who could be in it
//   pick(contacts, batch, random)    the N it takes (random or oldest first)
// ══════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCPS_BATCHES = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var low = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
  var tagsOf = function (c) { return (Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(',')).map(low).filter(Boolean); };

  // batch: { group, filters: { area: [..], tags: [..], source: [..] }, exclude: [contact_id] }
  // Every filter list is "any of"; filters combine with "and". Empty = no filter.
  function eligible(contacts, batch) {
    var f = (batch && batch.filters) || {}, skip = {};
    (batch.exclude || []).forEach(function (id) { skip[id] = true; });
    var any = function (list, value) { return !list || !list.length || list.map(low).indexOf(low(value)) !== -1; };
    return (contacts || []).filter(function (c) {
      if (c.review_status !== 'needs_review' || c.bucket !== batch.group || skip[c.contact_id]) return false;
      // Test contacts (the engine stores 'Y', the page sends true) are never batched.
      if ((c.is_test === true || String(c.is_test || '').toUpperCase() === 'Y') && !batch.include_test) return false;
      // Someone who has already been in a sequence (now stopped or done) never starts again.
      if (c.sequence || c.enrolled) return false;
      if (!any(f.area, c.area || c.city)) return false;
      if (!any(f.source, c.source)) return false;
      if (f.tags && f.tags.length) { var t = tagsOf(c); if (!f.tags.map(low).some(function (x) { return t.indexOf(x) !== -1; })) return false; }
      return true;
    });
  }

  // random: () => [0, 1). Oldest first is by created_at, then contact_id, so it's stable.
  function pick(contacts, batch, random) {
    var pool = eligible(contacts, batch), n = Math.max(0, Math.floor(Number(batch.count) || 0));
    if (batch.order === 'oldest') {
      pool.sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)) || String(a.contact_id).localeCompare(String(b.contact_id)); });
    } else {
      var r = random || Math.random;
      for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    }
    return pool.slice(0, n);
  }

  // The values to offer in the filters, from the waiting contacts of a group.
  function filterOptions(contacts, group) {
    var areas = {}, tags = {}, sources = {};
    (contacts || []).forEach(function (c) {
      if (c.review_status !== 'needs_review' || c.bucket !== group) return;
      var a = c.area || c.city; if (a) areas[a] = (areas[a] || 0) + 1;
      if (c.source) sources[c.source] = (sources[c.source] || 0) + 1;
      tagsOf(c).forEach(function (t) { tags[t] = (tags[t] || 0) + 1; });
    });
    var list = function (o) { return Object.keys(o).sort().map(function (k) { return { value: k, count: o[k] }; }); };
    return { area: list(areas), tags: list(tags), source: list(sources) };
  }

  return { eligible: eligible, pick: pick, filterOptions: filterOptions };
}));
