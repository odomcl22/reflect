/**
 * Reading a page.
 *
 * Unlike search, this needs no account and no key, which makes it the half of
 * "go and get that" that works the moment you turn it on: paste a link, ask
 * what it says.
 *
 * Three things here are load-bearing.
 *
 * **Redirects are followed by hand.** `fetch` follows them for you, and that
 * would undo the whole guard in Safety.js: https://example.com/x is allowed,
 * and if it answers 302 to http://127.0.0.1:3040/api/memory the redirect is
 * followed before anyone can object. So `redirect: 'manual'`, and every hop is
 * checked as if it had been typed.
 *
 * **The body is capped while it streams**, not after. Content-Length is a claim
 * the server makes, and it is optional; a chunked response can go on until the
 * process runs out of memory.
 *
 * **What comes back is untrusted.** It goes into the model's context alongside
 * tools that write files and memory, and a page can contain a paragraph
 * addressed to the model. It is labelled as somebody else's words at the point
 * of use — see MemoryTools — and it is never treated as something the user
 * said.
 */

import { checkUrl } from './Safety.js';
import { record as ledger } from '../reflect/Ledger.js';

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BYTES = 2_000_000;
/** Roughly 6k tokens: enough to answer from, small enough to leave room. */
export const MAX_CHARS = 24_000;
const MAX_HOPS = 5;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

const unescape = (s) =>
  String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = Number(e[1] === 'x' || e[1] === 'X' ? `0x${e.slice(2)}` : e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * HTML to something worth reading.
 *
 * Not a full reader implementation — no scoring, no boilerplate detection. It
 * drops what is certainly not prose, keeps block structure so paragraphs and
 * list items do not run together, and stops. A model reads around navigation
 * cruft perfectly well; what it cannot do is read a wall with no line breaks.
 */
export function htmlToText(html) {
  let s = String(html);

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] || '';

  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  s = unescape(s)
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title: unescape(title).replace(/\s+/g, ' ').trim(), text: s };
}

/** Read the body, but stop at the cap rather than trusting Content-Length. */
async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return { body: await res.text(), truncated: false };

  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value.slice(0, value.byteLength - (total - MAX_BYTES)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { body: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map(Buffer.from))), truncated };
}

/**
 * @returns {Promise<{ok: true, url, title, text, truncated, contentType} | {ok: false, reason: string}>}
 *
 * Never throws, for the same reason search does not: a page that will not load
 * is something the model should tell the user about, not an exception that
 * takes the turn with it.
 */
export async function fetchPage(input, { signal, maxChars = MAX_CHARS, check = checkUrl } = {}) {
  const timer = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;

  let target = input;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      // Every hop, not only the first. The guard is worth nothing if a 302 can
      // step around it.
      const checked = await check(target);
      if (!checked.ok) return { ok: false, reason: checked.reason };

      // Per hop, not per call: a redirect is a second host that saw the
      // request, and a ledger that recorded only the address you typed would
      // be hiding the one you did not.
      ledger({ kind: 'fetch', url: checked.url, detail: hop ? `redirect ${hop}` : '' });

      const res = await fetch(checked.url, {
        headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
        redirect: 'manual',
        signal: combined,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return { ok: false, reason: `that page redirected to nowhere (${res.status})` };
        target = new URL(location, checked.url).href;
        continue;
      }

      if (!res.ok) return { ok: false, reason: `that page answered ${res.status}` };

      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim() || 'text/html';
      if (!/^(text\/|application\/(json|xml|xhtml))/.test(contentType)) {
        return { ok: false, reason: `that link is ${contentType}, which is not something readable as text` };
      }

      const { body, truncated } = await readCapped(res);
      const parsed = /html|xml/.test(contentType) ? htmlToText(body) : { title: '', text: body.trim() };
      const clipped = parsed.text.length > maxChars;

      return {
        ok: true,
        url: checked.url.href,
        title: parsed.title,
        text: clipped ? `${parsed.text.slice(0, maxChars)}\n\n[…the rest of the page was not read]` : parsed.text,
        truncated: truncated || clipped,
        contentType,
      };
    }
    return { ok: false, reason: 'that link redirected too many times' };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { ok: false, reason: 'that page took too long to load' };
    return { ok: false, reason: err.message || 'that page could not be loaded' };
  }
}
