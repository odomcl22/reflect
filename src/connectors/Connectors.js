/**
 * Connectors: the systems Reflect can reach, and which of them a turn may use.
 *
 * ## Who adds them
 *
 * The person, and nothing else. A connector is either a program that runs on
 * this machine or a service somewhere else, and either can act — send the
 * email, file the issue, delete the page. Same rule as folders, contacts and
 * shortcuts: no tool can add one, and one that arrives from a plugin arrives
 * switched off.
 *
 * ## Which ones a turn gets — the actual problem
 *
 * Adding MCP to an assistant that runs on a local model is not the hard part.
 * Surviving it is. A turn here already carries about fourteen tools and two
 * thousand tokens of definitions, and a 7–9B model visibly strains at that;
 * one mail connector is another dozen tools, and five connectors is eighty
 * definitions the model cannot choose between.
 *
 * So connector tools are not offered by default. A connector's tools come into
 * a turn only when the turn is about it — when the message names it ("what's
 * in Linear", "@linear"), matched on the connector's own name and any words the
 * person gave it. That is computed from what was typed, not decided by the
 * model: measured this session, a 9B asked in a skill's exact trigger words
 * never once chose to load it on its own, so a routing scheme that depends on
 * the model asking would not route.
 *
 * It also settles the unattended case for free. A task's message is its
 * instruction — the person's own words — so a scheduled task can use a
 * connector only if its instruction names it.
 *
 * And a cap. Past it, the tools whose names and descriptions share the most
 * words with the request are the ones offered.
 */

import { readJSON, writeJSON } from '../store/FileStore.js';
import { record as ledger } from '../reflect/Ledger.js';
import { McpClient } from './Mcp.js';

const FILE = 'connectors.json';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Tools one turn may carry from connectors, across all of them. */
export const TOOL_CAP = 12;

/** Words in a connector's name that say nothing about what it is for. */
const GENERIC = new Set(['mcp', 'server', 'servers', 'the', 'and', 'for', 'app', 'api', 'tool', 'tools', 'local', 'official', 'client', 'plugin']);

/**
 * One form per word, so "my calendars" reaches a connector named calendar.
 *
 * Not a stemmer — three plural rules, applied to both sides alike, which is
 * the part that matters: a rule that mangles "status" into "statu" does so to
 * the message and the connector's name equally, and they still meet.
 */
const base = (w) =>
  w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y`
  : w.endsWith('sses') ? w.slice(0, -2)
  : w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1)
  : w;

const words = (text) =>
  String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(base)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));

// ──────────────────────────────────────────────────────────────── the list

export async function list() {
  const state = (await readJSON(FILE, null)) || {};
  return Array.isArray(state.connectors) ? state.connectors : [];
}

async function save(connectors) {
  await writeJSON(FILE, { connectors });
  forget();
}

/**
 * Add one. Checked for shape, never for trustworthiness — that is the person's
 * judgement, which is why only a person can call this.
 */
export async function add(input = {}) {
  const name = String(input.name || '').toLowerCase().trim();
  if (!NAME.test(name)) return { ok: false, reason: 'A connector name is lowercase words joined by hyphens, like linear or apple-notes.' };

  const isHttp = Boolean(input.url);
  if (isHttp) {
    let url;
    try {
      url = new URL(String(input.url));
    } catch {
      return { ok: false, reason: 'That is not a web address.' };
    }
    if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: 'A connector address has to be http or https.' };
  } else if (!String(input.command || '').trim()) {
    return { ok: false, reason: 'A connector needs either a command to run or an address.' };
  }

  const all = await list();
  if (all.some((c) => c.name === name)) return { ok: false, reason: `There is already a connector called ${name}.` };

  const connector = {
    name,
    type: isHttp ? 'http' : 'stdio',
    ...(isHttp
      ? { url: String(input.url), headers: plainObject(input.headers) }
      : {
          command: String(input.command).trim(),
          args: Array.isArray(input.args) ? input.args.map(String) : splitArgs(input.args),
          env: plainObject(input.env),
        }),
    // Extra words that mean this connector — "tasks, todo" for one named
    // things-3 — so the person's own vocabulary routes to it.
    aliases: Array.isArray(input.aliases)
      ? input.aliases.map(String)
      : String(input.aliases || '').split(/[,\s]+/).filter(Boolean),
    enabled: input.enabled !== false,
    ...(input.source ? { source: String(input.source) } : {}),
  };
  await save([...all, connector]);
  return { ok: true, connector };
}

const plainObject = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), String(x)])) : {};

/** "--root ~/Notes --read-only" → ["--root", "~/Notes", "--read-only"], respecting quotes. */
function splitArgs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export async function remove(name) {
  const all = await list();
  await save(all.filter((c) => c.name !== name));
  return { ok: true };
}

export async function setEnabled(name, enabled) {
  const all = await list();
  const c = all.find((x) => x.name === name);
  if (!c) return { ok: false, reason: 'no such connector' };
  c.enabled = Boolean(enabled);
  await save(all);
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────── the pool

const pool = new Map(); // name → { client, tools }

function forget(name = null) {
  for (const [key, entry] of pool) {
    if (name && key !== name) continue;
    entry.client.close().catch(() => {});
    pool.delete(key);
  }
}

/** Connected and listed, once; reused until the config changes or it dies. */
async function open(connector) {
  const live = pool.get(connector.name);
  if (live && !live.client.transport.closed) return live;
  if (live) pool.delete(connector.name);

  const client = new McpClient(connector);
  await client.connect();
  const tools = await client.listTools();
  const entry = { client, tools };
  pool.set(connector.name, entry);
  return entry;
}

/** Connect, list, report — for the Test button, and nothing else. */
export async function test(name) {
  const c = (await list()).find((x) => x.name === name);
  if (!c) return { ok: false, reason: 'no such connector' };
  try {
    forget(name);
    const { client, tools } = await open(c);
    return { ok: true, server: client.server, tools: tools.map((t) => ({ name: t.name, description: t.description || '' })) };
  } catch (err) {
    forget(name);
    return { ok: false, reason: err.message };
  }
}

export async function shutdown() {
  forget();
}

// ──────────────────────────────────────────────────────────────── routing

/** The connectors a piece of text is about. */
export function named(text, connectors) {
  const said = new Set(words(text));
  const raw = String(text || '').toLowerCase();
  return connectors.filter((c) => {
    if (c.enabled === false) return false;
    if (new RegExp(`(^|\\s)@${c.name}\\b`).test(raw)) return true;
    const own = [...words(c.name), ...(c.aliases || []).flatMap(words)];
    return own.some((w) => said.has(w));
  });
}

const exposed = (connector, tool) => `${connector}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/**
 * The connector tools for one turn, and how to find them again.
 *
 * Never throws: a connector that will not start costs the turn its tools, not
 * the turn. The failure is reported so the model can say so rather than
 * pretend the system is empty.
 */
export async function forTurn(text, { cap = TOOL_CAP } = {}) {
  const chosen = named(text, await list());
  const schemas = [];
  const routes = {};
  const failed = [];

  const candidates = [];
  for (const c of chosen) {
    try {
      const { tools } = await open(c);
      for (const t of tools) candidates.push({ connector: c.name, tool: t });
    } catch (err) {
      failed.push({ name: c.name, reason: err.message });
    }
  }

  const want = new Set(words(text));
  const score = ({ tool }) => words(`${tool.name} ${tool.description || ''}`).filter((w) => want.has(w)).length;
  const kept = candidates.length > cap ? [...candidates].sort((a, b) => score(b) - score(a)).slice(0, cap) : candidates;

  for (const { connector, tool } of kept) {
    const name = exposed(connector, tool.name);
    routes[name] = { connector, tool: tool.name };
    const params = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
    schemas.push({
      type: 'function',
      function: {
        name,
        description: `[${connector}] ${String(tool.description || tool.name).slice(0, 600)}`,
        parameters: { type: 'object', properties: {}, ...params },
      },
    });
  }

  return { schemas, routes, connectors: chosen.map((c) => c.name), failed, dropped: candidates.length - kept.length };
}

/** Run one routed tool. */
export async function call(route, args = {}) {
  const c = (await list()).find((x) => x.name === route.connector && x.enabled !== false);
  if (!c) return { ok: false, text: `The ${route.connector} connector is not available.` };
  try {
    const { client } = await open(c);
    // A local server is a process on this machine; the ledger records the
    // call as staying here. What that process then does on the network is its
    // own business, and the guide says so. HTTP connectors are counted by the
    // transport itself, at the socket.
    if (c.type !== 'http') ledger({ kind: 'connector', host: 'localhost', detail: `${c.name}: ${route.tool}` });
    const out = await client.callTool(route.tool, args);
    return { ok: !out.isError, text: out.text };
  } catch (err) {
    forget(c.name);
    return { ok: false, text: `The ${c.name} connector failed: ${err.message}` };
  }
}
