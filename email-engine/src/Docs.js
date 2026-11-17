// ══════════════════════════════════════════════════════════════════════════════
// CHATGPT DICTIONARY in Tony's Drive (Plan changes 2026-11-16).
//
// EE_DICTIONARY (Dictionary.js, generated from email-engine/docs/chatgpt/DICTIONARY.md)
// travels with every deploy. The first time the engine sees new text (right after a
// deploy: doGet, a run, or the 15-minute requests pass) it rewrites
// "MCPS Marketing / Email Engine Dictionary - ChatGPT.txt" in place (same file, so
// ChatGPT's link never changes). Nobody is emailed about it (Mau, 2026-11-16): the
// Drive file is the only place changes go.
// ══════════════════════════════════════════════════════════════════════════════

var EE_DICT_FILE_NAME = 'Email Engine Dictionary - ChatGPT.txt';

// deps: { props: { get, set }, writeFile(name, text) -> url }
function EE_publishDictionaryWith_(dict, deps) {
  var out = { wrote: false };
  if (!dict || !dict.hash || deps.props.get('EE_DICT_HASH') === dict.hash) return out;
  var url = deps.writeFile(EE_DICT_FILE_NAME, dict.text);
  if (!url) return out;                                // no Marketing folder yet: try again later
  deps.props.set('EE_DICT_URL', url);
  deps.props.set('EE_DICT_HASH', dict.hash);
  out.wrote = true;
  return out;
}

function EE_publishDictionary_() {
  if (typeof EE_DICTIONARY === 'undefined') return null;
  var props = EE_props_();
  if (props.getProperty('EE_DICT_HASH') === EE_DICTIONARY.hash) return null;
  // Drive never runs under the script lock; a short cache flag keeps two callers from both publishing.
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
      }
    });
  } finally { cache.remove('ee_dict_busy'); }
}
