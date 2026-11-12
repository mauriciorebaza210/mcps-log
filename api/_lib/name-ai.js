// AI help for names the rules can't settle (PLAN.md → "Contact cleanup and
// duplicates"): 3+ word names ("Mary Ann Smith" vs "Jose Rodriguez Garza"),
// couples with two surnames, unclear businesses. Claude Haiku 5.5, chosen by Mau
// for cost ("dirt cheap"). Only the names are sent: never emails, phones or addresses.
//
//   askNames(names, { client }) → [{ i, first_name, last_name, kind, greeting }] | { error }
// Every answer is checked: each word must come from the original name (apart from
// "and", "family", "Familia", "Mr.", "Mrs."), so the model can tidy but never invent.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const NAME_MODEL = 'claude-haiku-5-5';
export const NAME_BATCH = 40;

const Result = z.object({
  names: z.array(z.object({
    i: z.number().int(),
    first_name: z.string(),
    last_name: z.string(),
    kind: z.enum(['person', 'couple', 'family', 'business', 'unclear']),
    greeting: z.string()
  }))
});

const SYSTEM = [
  'You tidy customer names for a pool service company in San Antonio, Texas (many Hispanic names).',
  'For each input name, return how it should be stored and greeted in an email:',
  '- first_name: the given name(s) used in "Hi <first_name>,". For a couple: "John and Mary". For a family: "Smith family" (or "Familia Garza" if written in Spanish). Empty for a business.',
  '- last_name: the surname (keep Hispanic double surnames together, e.g. "Rodriguez Garza"; keep particles like "de la"). For a business, the business name.',
  '- kind: person, couple, family, business, or unclear.',
  '- greeting: what follows "Hi " in an email (usually first_name; empty for a business).',
  'Use proper capitalization (McDonald, O\'Brien, De la Cruz). Never add, translate or guess words that are not in the input; if unsure, use kind "unclear" and keep the words as given.',
  'Return one entry per input, with the same i.'
].join('\n');

const ALLOWED = new Set(['and', 'family', 'familia', 'mr.', 'mrs.', 'mr', 'mrs', 'y']);
const words = s => String(s || '').toLowerCase().replace(/[^a-zà-ÿ' -]/g, ' ').split(/[\s-]+/).filter(Boolean);
// Only words that were in the original (plus the few connectors above).
export function faithful(input, out) {
  const have = new Set(words(input));
  return words(out.first_name + ' ' + out.last_name + ' ' + out.greeting).every(w => have.has(w) || ALLOWED.has(w));
}

// names: [{ i, name }] (name = the original text). client: an Anthropic client (tests pass a fake).
export async function askNames(names, opts = {}) {
  const key = opts.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY;
  if (!opts.client && !key) return { error: 'ai_off' };
  const client = opts.client || new Anthropic({ apiKey: key, maxRetries: 2, timeout: 60000 });
  const out = [];
  for (let k = 0; k < names.length; k += NAME_BATCH) {
    const batch = names.slice(k, k + NAME_BATCH);
    let res;
    try {
      res = await client.messages.parse({
        model: NAME_MODEL,
        max_tokens: 8000,
        output_config: { effort: 'low', format: zodOutputFormat(Result) },
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(batch.map(n => ({ i: n.i, name: n.name }))) }]
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return { error: 'ai_busy', partial: out };
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { error: 'ai_key_rejected', partial: out };
      if (e instanceof Anthropic.APIError) return { error: 'ai_failed: ' + (e.status || '') + ' ' + String(e.message || '').slice(0, 120), partial: out };
      throw e;
    }
    if (res.stop_reason === 'refusal' || !res.parsed_output) continue;
    const byI = new Map(batch.map(n => [n.i, n.name]));
    res.parsed_output.names.forEach(r => {
      const input = byI.get(r.i);
      if (input === undefined || r.kind === 'unclear' || !faithful(input, r)) return;   // rules' answer stands
      out.push({ i: r.i, first_name: r.first_name.trim(), last_name: r.last_name.trim(), kind: r.kind, greeting: r.greeting.trim() });
    });
  }
  return out;
}
