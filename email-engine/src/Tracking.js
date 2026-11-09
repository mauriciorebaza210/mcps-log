// ══════════════════════════════════════════════════════════════════════════════
// TRACKING INGEST: events relayed from api/email.js (clicks, opens, beacons,
// unsubscribes, form submits) → raw Events, the per-delivery Engagement summary,
// and, only where the evidence is strong enough, a stop request in the Inbox.
//
// Contract: email-engine/docs/PLAN.md → Tracking: evidence and confidence.
//   - The delivery (found by its token) decides the mode, and it must match the
//     signed mode in the link, or the event is refused (Execution modes).
//   - Raw events are never overwritten; Engagement is derived and records the
//     classifier version, so it can be recomputed.
//   - Only a browser-verified click (beacon, confidence high), a form submit or
//     an unsubscribe becomes a stop request. Opens never stop anything.
//   - Stop requests go first, through core.ingest (journaled, same lock as send
//     authorization); the event log comes after.
//
// env adds: events: { has(eventId, atMs), append(row) }   (monthly Events_YYYY_MM tabs)
// ══════════════════════════════════════════════════════════════════════════════

var EE_TRACK_MAX_EVENTS = 50;
var EE_BURST_WINDOW_MS = 10 * 1000;

function EE_createTracker(env, core) {
  var T = MCPS_EMAIL_TRACKING;
  function iso(ms) { return new Date(ms).toISOString(); }

  function ingest(events) {
    events = (events || []).slice(0, EE_TRACK_MAX_EVENTS);
    var byToken = {};
    env.store.rows('Deliveries').forEach(function (d) { if (d.token) byToken[d.token] = d; });
    return events.map(function (ev) {
      try { return one(ev, byToken[String(ev.token || '')]); }
      catch (e) { return { event_id: ev.event_id, status: 'error', error: String(e && e.message || e).slice(0, 200) }; }
    });
  }

  function one(ev, d) {
    var id = String(ev.event_id || '');
    if (!id) return { event_id: '', status: 'rejected', reason: 'no_event_id' };
    if (!d) return { event_id: id, status: 'ignored', reason: 'unknown_token' };
    if (d.mode !== ev.mode) return { event_id: id, status: 'rejected', reason: 'mode_mismatch' };
    var at = Number(ev.received_at) || env.now();
    if (env.events.has(id, at)) return { event_id: id, status: 'duplicate' };

    // 1. Stop requests first: they matter more than the log.
    var stop = null;
    if (ev.type === 'unsubscribe') {
      stop = core.ingest({ event_id: 'unsub_' + d.token, type: 'unsubscribe', mode: d.mode, email_norm: d.email_norm,
        contact_id: d.contact_id, scope: 'all' });
    }
    // 2. Grade and record.
    var g = env.store.get('Engagement', d.delivery_id) || { delivery_id: d.delivery_id, contact_id: d.contact_id,
      enrollment_id: d.enrollment_id, step_id: d.step_id, mode: d.mode, opens_total: 0, opens_low: 0, opens_medium: 0,
      clicks_total: 0, clicks_low: 0, clicks_medium: 0, clicks_high: 0, links_json: {}, recent_clicks: [] };
    var recent = (g.recent_clicks || []).filter(function (t) { return at - t < EE_BURST_WINDOW_MS; });
    var secs = d.sent_at ? Math.round((at - Date.parse(d.sent_at)) / 1000) : '';
    var cls = { confidence: 'high', reasons: [], ua_family: T.uaFamily(ev.ua) };
    if (ev.type === 'open' || ev.type === 'click' || ev.type === 'beacon') {
      cls = T.classify({ type: ev.type, method: ev.method, ua: ev.ua, seconds_since_send: secs,
        burst_count: ev.type === 'click' ? recent.length + 1 : 0 });
    }
    if (ev.type === 'beacon' && cls.confidence === 'high') {
      stop = core.ingest({ event_id: 'trk_' + id, type: 'signal', signal: 'click', confidence: 'high', mode: d.mode,
        email_norm: d.email_norm, contact_id: d.contact_id, enrollment_id: d.enrollment_id, step_id: d.step_id });
    } else if (ev.type === 'form') {
      stop = core.ingest({ event_id: 'trk_' + id, type: 'signal', signal: 'form', confidence: 'high', mode: d.mode,
        email_norm: d.email_norm, contact_id: d.contact_id, enrollment_id: d.enrollment_id, step_id: d.step_id });
    }

    env.withLock(function () {
      if (env.events.has(id, at)) return;                // a concurrent copy got here first
      env.events.append({ event_id: id, delivery_id: d.delivery_id, enrollment_id: d.enrollment_id, contact_id: d.contact_id,
        mode: d.mode, type: ev.type, link_id: ev.link_id || '', received_at: iso(at), seconds_since_send: secs,
        method: String(ev.method || '').toUpperCase(), ua_raw: String(ev.ua || '').slice(0, 300), ua_family: cls.ua_family,
        ip_prefix_hash: String(ev.ip_hash || '').slice(0, 32), beacon_present: ev.type === 'beacon' ? 'Y' : '',
        burst_count: ev.type === 'click' ? recent.length + 1 : '', confidence: cls.confidence, reasons: cls.reasons.join(','),
        classifier_version: T.CLASSIFIER_VERSION, source: String(ev.source || 'vercel') });

      var cur = env.store.get('Engagement', d.delivery_id) || g;    // re-read under the lock: counters never lose an update
      cur.recent_clicks = (cur.recent_clicks || []).filter(function (t) { return at - t < EE_BURST_WINDOW_MS; });
      var links = cur.links_json || {};
      if (ev.type === 'open') {
        cur.opens_total = Number(cur.opens_total || 0) + 1;
        if (cls.confidence === 'low') cur.opens_low = Number(cur.opens_low || 0) + 1; else cur.opens_medium = Number(cur.opens_medium || 0) + 1;
        cur.first_open_at = cur.first_open_at || iso(at); cur.last_open_at = iso(at);
      } else if (ev.type === 'click') {
        cur.clicks_total = Number(cur.clicks_total || 0) + 1;
        if (cls.confidence === 'low') cur.clicks_low = Number(cur.clicks_low || 0) + 1; else cur.clicks_medium = Number(cur.clicks_medium || 0) + 1;
        cur.first_click_at = cur.first_click_at || iso(at); cur.last_click_at = iso(at);
        cur.recent_clicks.push(at);
        if (ev.link_id) links[ev.link_id] = Number(links[ev.link_id] || 0) + 1;
      } else if (ev.type === 'beacon') {
        if (cls.confidence === 'high') cur.clicks_high = Number(cur.clicks_high || 0) + 1;
        cur.first_verified_click_at = cur.first_verified_click_at || (cls.confidence === 'high' ? iso(at) : '');
      } else if (ev.type === 'unsubscribe') {
        cur.unsubscribed_at = cur.unsubscribed_at || iso(at);
      } else if (ev.type === 'form') {
        cur.form_submitted_at = cur.form_submitted_at || iso(at);
      }
      cur.links_json = links;
      cur.classifier_version = T.CLASSIFIER_VERSION;
      cur.updated_at = iso(env.now());
      env.store.upsert('Engagement', cur);
    });
    var out = { event_id: id, status: 'recorded', confidence: cls.confidence };
    if (stop) out.stop_recorded = !!stop.ok;
    return out;
  }

  return { ingest: ingest };
}
