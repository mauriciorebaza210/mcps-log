// ══════════════════════════════════════════════════════════════════════════════
// CHATGPT DICTIONARY in Tony's Drive (Plan changes 2026-11-16).
//
// EE_DICTIONARY (Dictionary.js, generated from email-engine/docs/chatgpt/DICTIONARY.md)
// travels with every deploy. The first time the engine sees new text (right after a
// deploy: doGet, a run, or the 15-minute requests pass) it rewrites
// "MCPS Marketing / Email Engine Dictionary - ChatGPT.txt" in place (same file, so
// ChatGPT's link never changes). When the version number went up, it also emails
// Tony what changed, once per version. A wording fix without a new version only
// updates the file.
// ══════════════════════════════════════════════════════════════════════════════

var EE_DICT_FILE_NAME = 'Email Engine Dictionary - ChatGPT.txt';

// The email for every version after `emailed` (0 = Tony has never had it). Pure.
function EE_dictionaryEmail_(dict, emailed, fileUrl) {
  emailed = Number(emailed || 0);
  if (!dict || !(dict.version > emailed)) return null;
  var news = (dict.changes || []).filter(function (c) { return c.version > emailed; });
  var lines = ['Hi Tony,', ''];
  if (!emailed) {
    lines.push('ChatGPT now has a full guide to the email engine\'s data: what every tab and column means, how the campaigns work, and how to ask for changes.',
      '', 'How to use it: in ChatGPT (with Google Drive connected), start with',
      '  "Read Email Engine Dictionary in my MCPS Marketing folder, then ..."',
      'and ask what you need, for example who is still in MCP Legacy, or move someone to the Nov 30 batch.',
      'ChatGPT makes changes by adding a row to the ChatGPT_Requests tab of the engine sheet; the engine applies it within 15 minutes and writes the result next to it.');
  } else {
    lines.push('The email engine changed, so ChatGPT\'s guide was updated to version ' + dict.version + '.', '', 'What changed:');
    news.forEach(function (c) { c.items.forEach(function (i) { lines.push('- ' + i); }); });
    lines.push('', 'Nothing to do: ChatGPT always reads the current file.');
  }
  lines.push('', 'The guide: MCPS Marketing > ' + EE_DICT_FILE_NAME.replace(/\.txt$/, ''), fileUrl || '', '', 'Sent automatically by the MCPS email engine.');
  return { subject: emailed ? 'Email engine update: ChatGPT guide version ' + dict.version : 'ChatGPT guide to the email engine',
    body: lines.join('\n') };
}

// deps: { props: { get, set }, writeFile(name, text) -> url, sendMail(to, subject, body), recipient() , quotaOk() }
function EE_publishDictionaryWith_(dict, deps) {
  var out = { wrote: false, emailed: false };
  if (!dict || !dict.hash) return out;
  var url = deps.props.get('EE_DICT_URL') || '';
  if (deps.props.get('EE_DICT_HASH') !== dict.hash) {
    url = deps.writeFile(EE_DICT_FILE_NAME, dict.text);
    if (!url) return out;                              // no Marketing folder yet: try again later
    deps.props.set('EE_DICT_URL', url);
    deps.props.set('EE_DICT_HASH', dict.hash);
    out.wrote = true;
  }
  var mail = EE_dictionaryEmail_(dict, deps.props.get('EE_DICT_EMAILED'), url);
  var to = mail && deps.recipient();
  if (mail && to && deps.quotaOk()) {
    deps.sendMail(to, mail.subject, mail.body);
    deps.props.set('EE_DICT_EMAILED', String(dict.version));
    out.emailed = true;
  }
  return out;
}

function EE_publishDictionary_() {
  if (typeof EE_DICTIONARY === 'undefined') return null;
  var props = EE_props_();
  if (props.getProperty('EE_DICT_HASH') === EE_DICTIONARY.hash && Number(props.getProperty('EE_DICT_EMAILED') || 0) >= EE_DICTIONARY.version) return null;
  // Drive and Gmail never run under the script lock; a short cache flag keeps two callers from both publishing.
  var cache = CacheService.getScriptCache();
  if (cache.get('ee_dict_busy')) return null;
  cache.put('ee_dict_busy', '1', 120);
  try {
    return EE_publishDictionaryWith_(EE_DICTIONARY, {
      props: { get: function (k) { return props.getProperty(k); }, set: function (k, v) { props.setProperty(k, v); } },
      writeFile: function (name, text) {
        var rootId = props.getProperty('EE_FOLDER_MARKETING'); if (!rootId) return '';
        var root = DriveApp.getFolderById(rootId), id = props.getProperty('EE_DICT_FILE'), f = null;
        if (id) { try { f = DriveApp.getFileById(id); if (f.isTrashed()) f = null; } catch (e) { f = null; } }
        if (!f) { var it = root.getFilesByName(name); f = it.hasNext() ? it.next() : null; }
        if (f) f.setContent(text); else f = root.createFile(name, text, MimeType.PLAIN_TEXT);
        props.setProperty('EE_DICT_FILE', f.getId());
        return f.getUrl();
      },
      recipient: function () {
        var row = EE_env().store.get('Config', 'dictionary_email');
        return String((row && row.value) || props.getProperty('EE_OWNER_EMAIL') || '').trim();
      },
      quotaOk: function () {
        var reserve = Number((EE_env().store.get('Config', 'quota_reserve') || {}).value || 20);
        return MailApp.getRemainingDailyQuota() > reserve;
      },
      sendMail: function (to, subject, body) { GmailApp.sendEmail(to, subject, body, { name: 'MCPS Email Engine' }); }
    });
  } finally { cache.remove('ee_dict_busy'); }
}
