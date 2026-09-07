/**
 * Looking something up on the web.
 *
 * "Local-first" was never "offline". Everything Reflect knows about you — your
 * memory, your conversations, your files — stays on this machine and is never
 * sent anywhere. Looking up a fact is a different act: what leaves is the
 * question, and only when the model decides it needs to ask.
 *
 * That distinction is the whole reason this is a separate module with its own
 * switch. It is off until someone turns it on, because a product that says
 * "nothing leaves this machine" has to mean it until you say otherwise.
 *
 * ## Why a port
 *
 * Search engines block scrapers, and the ones that do not today will tomorrow.
 * Measured from this machine before writing a line of parser: DuckDuckGo's lite
 * and html endpoints both answer 202 with an anti-bot page and no results, and
 * public SearXNG instances have JSON output switched off. Mojeek answers, has
 * its own index rather than reselling someone else's, and its markup is stable
 * enough to read — so it is the default that needs no account.
 *
 * It is still someone else's HTML. That is what the port is for: when it breaks
 * the fix is one adapter, and anyone who wants a contract instead of a courtesy
 * can point this at an API key.
 */

import { checkUrl, checkInstance } from './Safety.js';
import { record as ledger } from '../reflect/Ledger.js';

/** Kept short: a search nobody asked for should not hold up a reply. */
export const SEARCH_TIMEOUT_MS = 12_000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const decode = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(Number(e[1] === 'x' ? `0x${e.slice(2)}` : e.slice(1)));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsaquo: '›', hellip: '…' }[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();

/**
 * DuckDuckGo — the default, and the one that needs no account.
 *
 * It has to be a POST. A GET to the same address answers 202 with an anti-bot
 * page and no results, which is what made this look impossible the first time
 * round and sent the default to Mojeek — where a CAPTCHA arrives after a
 * handful of queries. The form on the page submits as a POST, so posting is
 * both what works and what an ordinary visit looks like.
 */
async function duckduckgo(query, { limit, signal }) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      referer: 'https://html.duckduckgo.com/',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo answered ${res.status}`);
  const html = await res.text();

  if (/anomaly|unusual traffic|challenge-form/i.test(html)) {
    throw new Error('DuckDuckGo is rate-limiting this machine — try again in a minute');
  }

  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gis)].map((m) => decode(m[1]));
  let i = 0;
  for (const m of html.matchAll(re)) {
    // Results are proxied through /l/?uddg=… when JavaScript is off.
    let url = m[1];
    const wrapped = /[?&]uddg=([^&]+)/.exec(url);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    out.push({ url, title: decode(m[2]), snippet: snippets[i] || '' });
    i++;
    if (out.length >= limit) break;
  }
  if (!out.length && !/no results/i.test(html)) {
    throw new Error('DuckDuckGo answered, but its results could not be read — the page layout may have changed');
  }
  return out;
}

/**
 * Mojeek — a second no-account option, with its own index.
 *
 * Reads `<h2><a class="title" href>` for the link and the `<p class="s">` that
 * follows it for the snippet.
 */
async function mojeek(query, { limit, signal }) {
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal });
  if (!res.ok) throw new Error(`Mojeek answered ${res.status}`);
  const html = await res.text();

  // Answering 200 with a challenge page is the normal way to be refused, and it
  // is why the no-key path cannot be relied on. Measured here: the first few
  // queries return results, then "JavaScript is required to complete this
  // challenge" arrives with a perfectly ordinary status code. Detected
  // explicitly, because the alternative is telling someone their question has
  // no answers when it was never asked.
  if (/JavaScript is required to complete this challenge|<title>\s*Captcha/i.test(html)) {
    throw new Error('Mojeek is asking for a CAPTCHA — free search without an account is rate-limited');
  }

  const out = [];
  const re = /<h2><a class="title"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a><\/h2>(?:\s*<p class="s">(.*?)<\/p>)?/gis;
  for (const m of html.matchAll(re)) {
    out.push({ url: m[1], title: decode(m[2]), snippet: decode(m[3] || '') });
    if (out.length >= limit) break;
  }
  // An empty page is not the same as a page that could not be read. If the
  // markup moved, say so — a silent zero is indistinguishable from an honest
  // one, and this is scraped HTML that nobody promised would stay put.
  if (!out.length && !/no results|did not match/i.test(html)) {
    throw new Error('Mojeek answered, but its results could not be read — the page layout may have changed');
  }
  return out;
}

/**
 * Tavily — built for this, and the free tier does not need a card.
 *
 * Returns snippets long enough to answer from, which for most questions saves a
 * second round trip to fetch the page.
 */
async function tavily(query, { limit, signal, apiKey }) {
  if (!apiKey) throw new Error('Tavily needs an API key');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: limit }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily answered ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, limit).map((r) => ({
    url: r.url,
    title: decode(r.title || ''),
    snippet: decode(r.content || ''),
  }));
}

/** Brave — for anyone who would rather have a contract than a courtesy. */
async function brave(query, { limit, signal, apiKey }) {
  if (!apiKey) throw new Error('Brave Search needs an API key');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Brave Search answered ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, limit).map((r) => ({
    url: r.url,
    title: decode(r.title || ''),
    snippet: decode(r.description || ''),
  }));
}

/** SearXNG — someone else's instance, or your own. JSON must be enabled on it. */
async function searxng(query, { limit, signal, baseUrl }) {
  if (!baseUrl) throw new Error('SearXNG needs the address of an instance');

  // The one search provider whose address is typed rather than built in, and
  // so the one that could point anywhere. Results are already run past the
  // guard; the instance itself never was, which left a way round it — the
  // query is the person's own words, and the metadata service answers anyone.
  const safe = await checkInstance(baseUrl);
  if (!safe.ok) throw new Error(`That SearXNG address will not do: ${safe.reason}`);

  const url = `${baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`SearXNG answered ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, limit).map((r) => ({
    url: r.url,
    title: decode(r.title || ''),
    snippet: decode(r.content || ''),
  }));
}

/**
 * What can be searched with, and what each one costs to set up.
 *
 * `needs: null` means it works with no account — and, as the Mojeek notes
 * above say, means best-effort. The three that take a key are the ones that
 * will still be working next month.
 */
export const PROVIDERS = {
  duckduckgo: {
    label: 'DuckDuckGo',
    run: duckduckgo,
    host: 'html.duckduckgo.com',
    needs: null,
    note: 'No account needed. The default.',
  },
  mojeek: {
    label: 'Mojeek',
    run: mojeek,
    host: 'www.mojeek.com',
    needs: null,
    note: 'No account needed, its own index. Asks for a CAPTCHA if you lean on it.',
  },
  brave: {
    label: 'Brave Search',
    run: brave,
    host: 'api.search.brave.com',
    needs: 'apiKey',
    note: 'Free tier, 2,000 searches a month. brave.com/search/api',
  },
  tavily: {
    label: 'Tavily',
    run: tavily,
    host: 'api.tavily.com',
    needs: 'apiKey',
    note: 'Built for assistants — longer snippets, fewer page fetches. tavily.com',
  },
  searxng: {
    label: 'SearXNG',
    run: searxng,
    host: null, // whatever baseUrl says — often the person's own machine
    needs: 'baseUrl',
    note: 'Your own instance, or someone else\u2019s with JSON output enabled.',
  },
};

/**
 * @returns {Promise<{ok: true, results: Array, provider: string} | {ok: false, reason: string}>}
 *
 * Never throws. A failed search is a fact for the model to work with — "I could
 * not reach the web" is a better turn than an exception that loses the reply.
 */
export async function search(query, { provider = 'duckduckgo', apiKey = null, baseUrl = null, limit = 5, signal } = {}) {
  const text = String(query || '').trim();
  if (!text) return { ok: false, reason: 'no search terms were given' };

  const chosen = PROVIDERS[provider] || PROVIDERS.duckduckgo;

  // Recorded here rather than inside each provider, so a provider added later
  // is counted without anyone remembering to count it. The terms are part of
  // the entry: what left is the question you asked.
  ledger({
    kind: 'search',
    // A provider's own host, except SearXNG, which is wherever it was pointed
    // — and that is frequently the machine under the desk, which the ledger
    // should say rather than calling it "the internet".
    host: chosen.host || null,
    url: chosen.host ? '' : baseUrl || '',
    detail: text.slice(0, 120),
  });

  const timer = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;

  try {
    const results = await chosen.run(text, { limit: Math.min(10, Math.max(1, limit)), signal: combined, apiKey, baseUrl });
    // Results carry URLs the model may hand straight to web_fetch, so they are
    // filtered here rather than trusted later.
    const safe = [];
    for (const r of results) {
      if ((await checkUrl(r.url)).ok) safe.push(r);
    }
    return { ok: true, results: safe, provider: chosen.label };
  } catch (err) {
    const why = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'the search timed out' : err.message;
    return { ok: false, reason: why };
  }
}
