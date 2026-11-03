// Sentence explanations from Claude, streamed to the overlay over a port.
// The overlay sends the line plus its neighbours; answers are cached in
// extension storage so a line is only ever paid for once.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const CACHE_LIMIT = 1500; // explanations kept (≈2 KB each)

const SYSTEM = `You help an English-speaking learner of Mandarin understand a line of dialogue from a show they are watching. They can already look up single words; what they need from you is how the line works as a whole.

For the line you're given, explain:
- **Literal**: a word-by-word gloss of the line (keep pinyin for the words that matter).
- **Meaning**: what the speaker actually means here, in natural English, using the neighbouring lines for context.
- **The subtitle**: how the English subtitle relates to the Chinese — where it loosens, compresses, localises or misses something, and why a translator would choose that. Say so if it's simply accurate. Skip this if there is no subtitle.
- **Notes**: slang, colloquialisms, idioms, set phrases, internet slang, regionalisms, grammar patterns or cultural references worth knowing. For example, 小鲜肉 xiǎo xiān ròu is literally "little fresh meat" but means a handsome young male celebrity. Leave Notes out if nothing is worth noting.

If the line is cut off or only makes sense with what comes next, say what it is most likely heading toward and how sure you are.

Be brief — the learner reads this while the show plays. Plain text with **bold** labels and "- " bullets only; no headings, tables or other markdown.`;

function userPrompt(r) {
  const lines = [];
  if (r.title) lines.push(`Show: ${r.title}`, '');
  if (r.before && r.before.length) lines.push('Earlier lines:', ...r.before.map((l) => `  ${l}`), '');
  lines.push('Line to explain:', `  ${r.line}`);
  if (r.pinyin) lines.push(`  Pinyin: ${r.pinyin}`);
  if (r.english) lines.push(`  ${r.englishSource === 'mt' ? 'Machine translation' : 'English subtitle'}: ${r.english}`);
  else lines.push('  (no English subtitle)');
  if (r.after && r.after.length) lines.push('', 'Next lines:', ...r.after.map((l) => `  ${l}`));
  return lines.join('\n');
}

async function cacheGet(key) {
  const r = await chrome.storage.local.get(key);
  return r[key] || null;
}

async function cachePut(key, value) {
  const { xKeys = [] } = await chrome.storage.local.get('xKeys');
  const keys = xKeys.filter((k) => k !== key);
  keys.push(key);
  const drop = keys.length > CACHE_LIMIT ? keys.splice(0, keys.length - CACHE_LIMIT) : [];
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set({ [key]: value, xKeys: keys });
}

function errorCode(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'badkey';
  if (e instanceof Anthropic.PermissionDeniedError) return 'badkey';
  if (e instanceof Anthropic.RateLimitError) return 'rate';
  if (e instanceof Anthropic.APIConnectionError) return 'network';
  return 'api';
}

async function explain(port, req, state) {
  const key = `x:${req.key}`;
  const cached = await cacheGet(key);
  if (cached) {
    port.postMessage({ type: 'done', text: cached.text, model: cached.model, cached: true });
    return;
  }
  const { anthropicKey, apiBaseUrl } = await chrome.storage.local.get(['anthropicKey', 'apiBaseUrl']);
  if (!anthropicKey) {
    port.postMessage({ type: 'error', code: 'nokey' });
    return;
  }
  const client = new Anthropic({
    apiKey: anthropicKey,
    baseURL: apiBaseUrl || undefined, // only set by the end-to-end test
    dangerouslyAllowBrowser: true, // the key lives in this extension's own storage
  });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' }, // short explanations; keeps the wait down
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // a declined request is retried on Anthropic's recommended model
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(req) }],
  });
  state.stream = stream;
  stream.on('text', (delta) => {
    if (!state.closed) port.postMessage({ type: 'delta', text: delta });
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    if (!state.closed) port.postMessage({ type: 'error', code: 'refusal' });
    return;
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  await cachePut(key, { text, model: msg.model, at: Date.now() });
  if (!state.closed) port.postMessage({ type: 'done', text, model: msg.model, cached: false });
}

export function startExplainer() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'explain') return;
    const state = { closed: false, stream: null };
    port.onDisconnect.addListener(() => { state.closed = true; });
    port.onMessage.addListener((req) => {
      explain(port, req, state).catch((e) => {
        if (e instanceof Anthropic.APIUserAbortError || state.closed) return;
        console.error('[zimu] explain failed', e);
        port.postMessage({ type: 'error', code: errorCode(e), message: String(e.message || e) });
      });
    });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'clearExplanations') {
      chrome.storage.local.get('xKeys').then(async ({ xKeys = [] }) => {
        await chrome.storage.local.remove([...xKeys, 'xKeys']);
        sendResponse({ ok: true, removed: xKeys.length });
      });
      return true;
    }
    return false;
  });
}
