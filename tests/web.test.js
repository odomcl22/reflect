/**
 * Going out to the web.
 *
 * Most of this file is the guard, because the guard is the feature. Reflect
 * serves an unauthenticated API on loopback, sits on a network with a router
 * and a printer on it, and on a cloud host shares an address space with a
 * metadata service that hands out credentials to anyone who asks. A fetch tool
 * that opens any URL is a proxy into all of that — and the thing driving it can
 * be argued with by a web page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { checkUrl, isPrivateAddress } = await import('../src/web/Safety.js');
const { htmlToText, fetchPage } = await import('../src/web/Fetch.js');
const { search, PROVIDERS } = await import('../src/web/Search.js');

const allowed = async (u) => (await checkUrl(u)).ok;

// ------------------------------------------------------------------- the guard

test('the machine itself is not on the web', async () => {
  for (const u of [
    'http://localhost:3040/api/memory',
    'http://127.0.0.1/',
    'http://127.0.0.53/',
    'http://[::1]/',
    'http://0.0.0.0/',
  ]) {
    assert.equal(await allowed(u), false, `${u} should be refused`);
  }
});

test('the local network is not on the web either', async () => {
  for (const u of ['http://192.168.1.1/', 'http://10.0.0.5/', 'http://172.16.4.4/', 'http://100.64.1.1/']) {
    assert.equal(await allowed(u), false, `${u} should be refused`);
  }
  // Names, not just numbers: a NAS or printer answers to one of these long
  // before anyone types its address.
  for (const u of ['http://nas.local/', 'http://printer.lan/', 'http://vault.internal/', 'http://box.home/']) {
    assert.equal(await allowed(u), false, `${u} should be refused`);
  }
});

// 169.254.169.254 serves instance credentials, unauthenticated, to whatever
// asks. It is the single most valuable thing an SSRF can reach.
test('the cloud metadata service is refused', async () => {
  assert.equal(await allowed('http://169.254.169.254/latest/meta-data/iam/'), false);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
});

// `new URL()` rewrites ::ffff:127.0.0.1 into ::ffff:7f00:1, so a check that
// only knew the readable spelling waved loopback straight through. Found by
// running the list, not by reading the code.
test('a v4 address wearing a v6 hat is still that address', async () => {
  assert.equal(await allowed('http://[::ffff:127.0.0.1]/'), false, 'hex-normalised loopback');
  assert.equal(await allowed('http://[::ffff:192.168.1.1]/'), false, 'hex-normalised private');
  assert.equal(await allowed('http://[::ffff:8.8.8.8]/'), true, 'a real public address still works');
});

test('only http and https are openable', async () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,hi', 'gopher://example.com/']) {
    assert.equal(await allowed(u), false, `${u} should be refused`);
  }
});

// A hostname is not an address. `evil.test` resolving to 127.0.0.1 is a
// two-line DNS record, which is why the resolved addresses are checked too.
test('a public name that resolves private is refused', async () => {
  const resolve = async (host) =>
    ({
      'rebind.test': [{ address: '127.0.0.1' }],
      'mixed.test': [{ address: '93.184.216.34' }, { address: '10.0.0.7' }],
      'good.test': [{ address: '93.184.216.34' }],
    })[host] || [];

  assert.equal((await checkUrl('https://rebind.test/', { resolve })).ok, false);
  assert.equal((await checkUrl('https://good.test/', { resolve })).ok, true);
  // Every address, not the first — otherwise it is reachable by retrying.
  assert.equal((await checkUrl('https://mixed.test/', { resolve })).ok, false);
});

test('a refusal says which host and why, so it can be argued with', async () => {
  const r = await checkUrl('http://192.168.0.10/admin');
  assert.equal(r.ok, false);
  assert.match(r.reason, /192\.168\.0\.10/);
});

// --------------------------------------------------------------------- reading

test('a page becomes text worth reading', () => {
  const { title, text } = htmlToText(`
    <html><head><title>Laminar flow</title><style>p{color:red}</style></head>
    <body><nav>menu junk</nav><script>alert(1)</script>
    <h1>Laminar flow</h1><p>Fluid in&nbsp;layers.</p>
    <ul><li>Smooth</li><li>Predictable</li></ul>
    <footer>copyright</footer></body></html>`);

  assert.equal(title, 'Laminar flow');
  assert.match(text, /Fluid in layers\./);
  assert.match(text, /- Smooth/);
  assert.ok(!/alert\(1\)/.test(text), 'script contents are not prose');
  assert.ok(!/color:red/.test(text), 'neither is CSS');
  assert.ok(!/menu junk/.test(text), 'navigation is not prose');
  // Structure survives: without it every paragraph runs into the next one.
  assert.ok(text.includes('\n'), 'block structure is kept');
});

test('entities come back as characters', () => {
  const { text } = htmlToText('<p>Caf&eacute; &amp; bar &#8212; &quot;open&quot;</p>');
  assert.match(text, /& bar — "open"/);
});

// --------------------------------------------------------------------- fetching

test('a redirect into the machine is refused at the hop, not at the start', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/bounce') {
      res.writeHead(302, { location: 'http://127.0.0.1:9/secret' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>fine</title><p>ok</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // The first hop is treated as public so the redirect is actually reached;
    // every hop after it is judged for real. Without this, `fetch` would follow
    // the 302 itself and the guard would never see the second address.
    const seen = [];
    const check = async (u) => {
      seen.push(u);
      const url = new URL(u);
      if (seen.length === 1) return { ok: true, url };
      return isPrivateAddress(url.hostname)
        ? { ok: false, reason: `${url.hostname} is a private address` }
        : { ok: true, url };
    };

    const r = await fetchPage(`http://127.0.0.1:${port}/bounce`, { check });
    assert.equal(r.ok, false);
    assert.match(r.reason, /127\.0\.0\.1/);
    assert.equal(seen.length, 2, 'the redirect target was checked as well as the original');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('a page that is not text is not read as text', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const r = await fetchPage(`http://127.0.0.1:${port}/x`, {
      check: async (u) => ({ ok: true, url: new URL(u) }),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /image\/png/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// Content-Length is a claim, and an optional one. A chunked response with no
// length can run until the process dies, so the cap is applied while reading.
test('an endless page is cut off rather than swallowed', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    // Stop the moment the reader goes away. Without the destroyed/closed
    // checks this keeps writing into a cancelled socket, the connection never
    // ends, and server.close() waits for it — which hung the whole suite
    // intermittently rather than failing this one test.
    const pump = () => {
      if (res.writableEnded || res.destroyed || res.socket?.destroyed) return;
      if (res.write('x'.repeat(64 * 1024))) setImmediate(pump);
      else res.once('drain', pump);
    };
    res.on('close', () => res.destroy());
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const r = await fetchPage(`http://127.0.0.1:${port}/big`, {
      check: async (u) => ({ ok: true, url: new URL(u) }),
      maxChars: 5000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < 6000, `kept ${r.text.length} characters`);
  } finally {
    // close() alone waits on live sockets; this test deliberately leaves one.
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------- search

test('search never throws — a failure is something to say, not to crash on', async () => {
  const r = await search('', {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /no search terms/);
});

test('a provider that needs a key says so instead of failing obscurely', async () => {
  for (const [name, why] of [
    ['brave', /API key/i],
    ['tavily', /API key/i],
    ['searxng', /instance/i],
  ]) {
    const r = await search('anything', { provider: name });
    assert.equal(r.ok, false);
    assert.match(r.reason, why, `${name} should explain what it needs`);
  }
});

test('every provider declares what it costs to set up', () => {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label, `${name} needs a label`);
    assert.ok(p.note, `${name} needs a note saying what it requires`);
    assert.ok([null, 'apiKey', 'baseUrl'].includes(p.needs), `${name} has an odd 'needs'`);
  }
});

// The first attempt at a no-account default read DuckDuckGo with a GET, got
// 202 and an anti-bot page, and concluded it was impossible — so the default
// went to Mojeek, which serves a CAPTCHA after a handful of queries and was
// useless in a real session. The form on the page submits as a POST. Posting is
// both what works and what an ordinary visit looks like.
test('the default provider needs no account', () => {
  assert.equal(PROVIDERS.duckduckgo.needs, null);
  assert.ok(PROVIDERS.duckduckgo.run, 'and it has to be wired up');
});

test('an unknown provider falls back rather than throwing', async () => {
  // Reached via a config file written by an older version, or edited by hand.
  const r = await search('', { provider: 'nonesuch' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no search terms/, 'the empty query is what failed, not the lookup');
});

// Found by an audit of everything that leaves the machine: the SSRF guard ran
// on search *results* and never on the SearXNG instance address, which is the
// one search destination a person types rather than one that is built in. The
// guard that protects web_fetch could simply be walked around.
test('a self-hosted search instance may be on your own machine', async () => {
  const { checkInstance } = await import('../src/web/Safety.js');
  for (const url of ['http://localhost:8888', 'http://127.0.0.1:8888', 'http://192.168.1.50:8888']) {
    assert.equal((await checkInstance(url)).ok, true, `${url} should be allowed`);
  }
});

// The exception, and the reason this is not simply checkUrl: loopback and the
// LAN are where SearXNG actually lives, but no instance is ever on the
// link-local range, and 169.254.169.254 answers with credentials.
test('a search instance may not be the cloud metadata service', async () => {
  const { checkInstance } = await import('../src/web/Safety.js');
  const blocked = await checkInstance('http://169.254.169.254/latest/meta-data/');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /metadata/);

  const rebound = await checkInstance('http://sneaky.example.com', {
    resolve: async () => [{ address: '169.254.169.254' }],
  });
  assert.equal(rebound.ok, false, 'a name resolving into metadata is the same request');
});

test('a search instance must be a web address at all', async () => {
  const { checkInstance } = await import('../src/web/Safety.js');
  assert.equal((await checkInstance('file:///etc/passwd')).ok, false);
  assert.equal((await checkInstance('not a url')).ok, false);
});
