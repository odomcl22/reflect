/**
 * Signing in to a connector through the browser.
 *
 * Most hosted connectors — mail, calendars, documents — will not take a pasted
 * token; they want the person to sign in on the service's own page and grant
 * access. MCP specifies exactly how, and this follows it rather than inventing
 * a variant:
 *
 *   1. The connector answers 401 and names its protected-resource metadata
 *      (RFC 9728), which names the sign-in server.
 *   2. The sign-in server describes itself (RFC 8414).
 *   3. Reflect registers itself with it (RFC 7591), where the service allows
 *      that. Where it does not, the person registers Reflect and pastes the
 *      client ID — said plainly rather than failing mysteriously.
 *   4. The person signs in in their own browser. Authorization code with PKCE
 *      (S256), a random state, and the resource indicator (RFC 8707), so a
 *      token is minted for this connector and no other.
 *   5. The browser comes back to Reflect's own loopback address with a code,
 *      which is exchanged for tokens. Refresh happens quietly after that.
 *
 * ## What Reflect never does
 *
 * See the person's password. The sign-in happens on the service's page, in
 * their browser; Reflect only ever holds the tokens that come back.
 *
 * ## Where the tokens live
 *
 * A file in Reflect's home, readable by nobody but its owner, and never in
 * config.json beside everything else. Signing out deletes them.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJSON, writeJSON } from '../store/FileStore.js';
import { record as ledger } from '../reflect/Ledger.js';
import { homePath } from '../config.js';

const FILE = 'connector-auth.json';

/** How long a sign-in link stays good. Long enough to find a password. */
const PENDING_MS = 10 * 60_000;

/** Refresh this long before a token says it expires. */
const EARLY_MS = 60_000;

const pending = new Map(); // state → an in-progress sign-in

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The spec requires HTTPS for everything involved in sign-in, and allows plain
 * HTTP only on this machine. A sign-in server that asks for a password over
 * plain HTTP across the internet is refused, not trusted.
 */
export function secureEnough(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** The connector's address as a resource identifier: no fragment, no trailing slash. */
export function canonical(url) {
  const u = new URL(url);
  const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
  return `${u.protocol}//${u.host.toLowerCase()}${p}`;
}

/** RFC 8414 and 9728 put the well-known segment between the host and any path. */
function wellKnown(base, suffix) {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, '');
  return p ? [`${u.origin}/.well-known/${suffix}${p}`, `${u.origin}${p}/.well-known/${suffix}`] : [`${u.origin}/.well-known/${suffix}`];
}

async function getJSON(url) {
  ledger({ kind: 'connector', url, detail: 'sign-in discovery' });
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Ask the connector, unsigned, so it says where to sign in. */
async function challengeFrom(mcpUrl) {
  try {
    ledger({ kind: 'connector', url: mcpUrl, detail: 'sign-in probe' });
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reflect', version: '2.0' } } }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.status === 401 ? res.headers.get('www-authenticate') || '' : null;
  } catch {
    return '';
  }
}

export async function discover(mcpUrl) {
  const challenge = await challengeFrom(mcpUrl);
  const named = /resource_metadata="([^"]+)"/.exec(challenge || '');
  let resourceMeta = null;
  for (const u of named ? [named[1]] : wellKnown(mcpUrl, 'oauth-protected-resource')) {
    resourceMeta = await getJSON(u);
    if (resourceMeta) break;
  }

  const issuer = resourceMeta?.authorization_servers?.[0] || new URL(mcpUrl).origin;
  let as = null;
  for (const u of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const m = await getJSON(u);
    if (m?.authorization_endpoint && m?.token_endpoint) {
      as = m;
      break;
    }
  }
  if (!as) throw new Error('This connector does not say where to sign in.');

  for (const endpoint of [as.authorization_endpoint, as.token_endpoint, as.registration_endpoint].filter(Boolean)) {
    if (!secureEnough(endpoint)) throw new Error(`Refusing to sign in over an insecure address: ${endpoint}`);
  }
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes('S256')) {
    throw new Error('This sign-in server does not support the protection (PKCE) Reflect requires.');
  }

  return { as, resource: resourceMeta?.resource || canonical(mcpUrl), scopes: resourceMeta?.scopes_supported || [] };
}

async function register(as, redirectUri) {
  if (!as.registration_endpoint) return null;
  ledger({ kind: 'connector', url: as.registration_endpoint, detail: 'registering Reflect' });
  const res = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Reflect',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The service refused to register Reflect (${res.status}).`);
  const client = await res.json();
  return client?.client_id ? { client_id: String(client.client_id), ...(client.client_secret ? { client_secret: String(client.client_secret) } : {}) } : null;
}

async function tokenRequest(endpoint, params, client) {
  ledger({ kind: 'connector', url: endpoint, detail: `token (${params.grant_type})` });
  const body = new URLSearchParams({ ...params, ...(client?.client_secret ? { client_secret: client.client_secret } : {}) });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `the sign-in server answered ${res.status}`);
  return data;
}

// ─────────────────────────────────────────────────────────── the token file

async function all() {
  return (await readJSON(FILE, null)) || {};
}

async function save(state) {
  await writeJSON(FILE, state);
  // Owner-only. These are the keys to the person's accounts.
  await fsp.chmod(path.join(homePath(), FILE), 0o600).catch(() => {});
}

async function put(name, record) {
  const state = await all();
  state[name] = record;
  await save(state);
}

const asRecord = (tokens, keepRefresh = null) => ({
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token || keepRefresh || null,
  expires_at: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : null,
  scope: tokens.scope || null,
});

// ─────────────────────────────────────────────────────────── the flow

/**
 * Start signing in. Returns the page to send the person to.
 *
 * @param connector  the connector's config, with its url and optionally a
 *                   pre-registered oauthClient { client_id, client_secret? }
 * @param redirectUri  Reflect's own loopback callback
 */
export async function begin(connector, { redirectUri }) {
  const found = await discover(connector.url);
  const client = connector.oauthClient?.client_id ? connector.oauthClient : await register(found.as, redirectUri);
  if (!client?.client_id) {
    return {
      ok: false,
      reason: "This service does not let apps register themselves. Register Reflect with it as an app, with the redirect address below, and paste the client ID it gives you into this connector.",
      redirectUri,
    };
  }

  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(24));
  pending.set(state, { name: connector.name, verifier, client, as: found.as, resource: found.resource, redirectUri, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);

  const url = new URL(found.as.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('resource', found.resource);
  if (found.scopes.length) url.searchParams.set('scope', found.scopes.join(' '));
  return { ok: true, url: url.href };
}

/**
 * The browser came back with a code. Exchange it, once.
 *
 * A state that is unknown, expired or already used is refused: that is what
 * stops a page elsewhere from finishing a sign-in the person never started.
 */
export async function finish(state, code) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > PENDING_MS) {
    return { ok: false, reason: 'That sign-in link has expired or was already used. Start again from Settings.' };
  }
  try {
    const tokens = await tokenRequest(
      p.as.token_endpoint,
      { grant_type: 'authorization_code', code: String(code || ''), redirect_uri: p.redirectUri, client_id: p.client.client_id, code_verifier: p.verifier, resource: p.resource },
      p.client
    );
    await put(p.name, { ...asRecord(tokens), client: p.client, token_endpoint: p.as.token_endpoint, resource: p.resource });
    return { ok: true, name: p.name };
  } catch (err) {
    return { ok: false, reason: `Signing in did not finish: ${err.message}` };
  }
}

/** A usable access token, refreshing first if it is about to run out. */
export async function tokenFor(name) {
  const rec = (await all())[name];
  if (!rec?.access_token) return null;
  if (rec.expires_at && Date.now() > rec.expires_at - EARLY_MS) return refresh(name);
  return rec.access_token;
}

/** Trade the refresh token for a new access token. Null if that is not possible. */
export async function refresh(name) {
  const rec = (await all())[name];
  if (!rec?.refresh_token) return null;
  try {
    const tokens = await tokenRequest(
      rec.token_endpoint,
      { grant_type: 'refresh_token', refresh_token: rec.refresh_token, client_id: rec.client.client_id, resource: rec.resource },
      rec.client
    );
    await put(name, { ...rec, ...asRecord(tokens, rec.refresh_token) });
    return tokens.access_token;
  } catch {
    return null;
  }
}

export async function status(name) {
  const rec = (await all())[name];
  return { signedIn: Boolean(rec?.access_token), expiresAt: rec?.expires_at || null };
}

export async function signOut(name) {
  const state = await all();
  delete state[name];
  await save(state);
  return { ok: true };
}
