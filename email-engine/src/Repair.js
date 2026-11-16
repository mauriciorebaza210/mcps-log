// One-time repair (2026-11-16, Mau): Tony sent the MCP Legacy Follow Up by hand on Nov 16
// to the 12 he approved at "Follow Up next". Record it so the engine never sends it again:
// they wait for approval at the Check-In, like the 25 from Nov 10. Only people approved
// today at the Follow Up and not yet in a sequence. Runs once (Config repair_fu_nov16).
// Remove after it has run.
function EE_repairFollowUpNov16_(env, core) {
  var done = env.store.get('Config', 'repair_fu_nov16');
  if (done && done.value) return { skipped: 'already ran' };
  var enrolled = {};
  env.store.rows('Enrollments').forEach(function (e) { enrolled[e.contact_id] = true; });
  var items = [];
  env.store.rows('Contacts').forEach(function (c) {
    if (c.bucket !== 'B' || c.review_status !== 'confirmed' || c.start_step !== 'b_followup') return;
    if (String(c.review_reason || '').indexOf('approved by') !== 0 || String(c.intro_sent_on || '') === '' || c.followup_sent_on) return;
    if (enrolled[c.contact_id]) return;
    items.push({ type: 'contact', opId: 'contact:' + c.contact_id + ':followup_by_hand:2026-11-16', data: {
      contact_id: c.contact_id, followup_sent_on: '2026-11-16', start_step: 'b_checkin', review_status: 'awaiting_approval',
      review_reason: 'Intro sent by hand on ' + c.intro_sent_on + '; Follow Up on 2026-11-16' } });
  });
  EE_commitMany_(core, items);
  env.store.upsert('Config', { key: 'repair_fu_nov16', value: 'done ' + items.length + ' ' + new Date(env.now()).toISOString() });
  return { repaired: items.length };
}
