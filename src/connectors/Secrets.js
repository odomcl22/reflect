/**
 * The values a connector needs but should never be written down beside it.
 *
 * A connector's settings say *where* a secret goes — `Authorization: Bearer
 * ${GITHUB_TOKEN}` in a header, `${API_KEY}` in an environment variable — and
 * this file holds *what* it is. The two meet only at the moment a connector is
 * opened, and only here.
 *
 * Three rules, each of which was once broken somewhere and is the reason this
 * module exists:
 *
 * - **Never from the environment.** A plugin that writes `${GITHUB_TOKEN}` is
 *   naming a secret, not asking for whichever one happens to be in Reflect's
 *   environment. A value is used only if the person typed it in, here.
 * - **Never to the page.** The settings screen learns which names a connector
 *   needs and whether each is filled in. It is never sent a value.
 * - **Owner-only on disk**, beside the sign-in tokens and like them.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJSON, writeJSON } from '../store/FileStore.js';
import { homePath } from '../config.js';

const FILE = 'connector-secrets.json';

/** `${NAME}` — the only shape a placeholder takes. */
export const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function all() {
  const state = await readJSON(FILE, null);
  return state && typeof state === 'object' ? state : {};
}

async function save(state) {
  await writeJSON(FILE, state);
  await fsp.chmod(path.join(homePath(), FILE), 0o600).catch(() => {});
}

/** Every string a connector carries that a placeholder could sit in. */
function strings(connector) {
  return [
    connector.url,
    connector.command,
    ...(connector.args || []),
    ...Object.values(connector.env || {}),
    ...Object.values(connector.headers || {}),
  ].filter((s) => typeof s === 'string');
}

/** The secret names a connector's settings refer to, in order, once each. */
export function placeholders(connector) {
  const seen = new Set();
  for (const s of strings(connector)) for (const m of s.matchAll(PLACEHOLDER)) seen.add(m[1]);
  return [...seen];
}

/** For the settings screen: each name and whether it has a value. Never the value. */
export async function status(connector) {
  const mine = (await all())[connector.name] || {};
  return placeholders(connector).map((name) => ({ name, set: typeof mine[name] === 'string' && mine[name] !== '' }));
}

/** Fill in, or with an empty value clear, one secret. Only names the connector actually uses. */
export async function set(connector, name, value) {
  if (!VAR.test(String(name))) return { ok: false, reason: 'That is not a name a secret can have.' };
  if (!placeholders(connector).includes(name)) return { ok: false, reason: `${connector.name} does not use ${name}.` };
  const state = await all();
  const mine = { ...(state[connector.name] || {}) };
  const v = String(value ?? '').trim();
  if (v) mine[name] = v;
  else delete mine[name];
  if (Object.keys(mine).length) state[connector.name] = mine;
  else delete state[connector.name];
  await save(state);
  return { ok: true };
}

/** Store values that arrived with a new connector, such as a pasted token. */
export async function setMany(connectorName, values) {
  const entries = Object.entries(values || {}).filter(([k, v]) => VAR.test(k) && String(v ?? '').trim());
  if (!entries.length) return;
  const state = await all();
  state[connectorName] = { ...(state[connectorName] || {}), ...Object.fromEntries(entries.map(([k, v]) => [k, String(v).trim()])) };
  await save(state);
}

export async function remove(connectorName) {
  const state = await all();
  if (!(connectorName in state)) return;
  delete state[connectorName];
  await save(state);
}

/**
 * The connector as it will actually be run: every placeholder replaced by the
 * person's value. Refuses — rather than connecting with a literal `${TOKEN}`,
 * which a server would read as a wrong password — when any value is missing.
 */
export async function resolve(connector) {
  const mine = (await all())[connector.name] || {};
  const missing = placeholders(connector).filter((n) => !mine[n]);
  if (missing.length) {
    const err = new Error(`${connector.name} needs ${missing.join(', ')} — fill ${missing.length === 1 ? 'it' : 'them'} in under Settings → Connectors.`);
    err.missing = missing;
    throw err;
  }
  const fill = (s) => (typeof s === 'string' ? s.replace(PLACEHOLDER, (_, n) => mine[n]) : s);
  const map = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, fill(v)]));
  return {
    ...connector,
    ...(connector.url ? { url: fill(connector.url) } : {}),
    ...(connector.command ? { command: fill(connector.command) } : {}),
    ...(connector.args ? { args: connector.args.map(fill) } : {}),
    ...(connector.env ? { env: map(connector.env) } : {}),
    ...(connector.headers ? { headers: map(connector.headers) } : {}),
  };
}
