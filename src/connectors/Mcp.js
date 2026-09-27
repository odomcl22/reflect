/**
 * The Model Context Protocol, spoken directly.
 *
 * MCP is how the rest of the ecosystem reaches other systems — calendars,
 * issue trackers, databases, notes — and there are thousands of servers for
 * it. Reflect could not hand-write those integrations, and should not try: the
 * rule is to own the formats (a PDF has no account and no API that changes)
 * and speak the standard for the systems.
 *
 * It is spoken here without the SDK, because Reflect has one runtime
 * dependency and MCP is small: JSON-RPC 2.0, carried either over a child
 * process's stdin and stdout, one message per line, or over HTTP POST, where
 * the answer comes back as JSON or as a short server-sent event stream. A
 * client needs four calls — initialize, the initialized notification,
 * tools/list and tools/call — and to answer the server's own pings.
 *
 * What is deliberately not here: OAuth. The large hosted connectors (Google,
 * Microsoft, Notion) require it, and it is a separate piece of work rather
 * than something to half-do. Local servers and token-authenticated HTTP ones
 * work today.
 */

import { spawn } from 'node:child_process';
import { record as ledger } from '../reflect/Ledger.js';

export const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'reflect', version: '2.0' };
const CALL_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 20_000;

class RpcError extends Error {}

/** The connector wants the person to sign in. Distinct, so the UI can offer to. */
export class NeedsSignIn extends RpcError {
  constructor() {
    super('this connector needs you to sign in — Settings → Connectors → Sign in');
    this.needsSignIn = true;
  }
}

/**
 * The environment a local server is started with.
 *
 * Not Reflect's own. A connector is a program somebody else wrote, and
 * Reflect's environment can carry API keys for other things; handing it all
 * over would give every server every secret. It gets what it needs to run —
 * PATH and HOME and a few basics — plus whatever its own config names.
 */
function serverEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  for (const [k, v] of Object.entries(extra || {})) env[k] = String(v);
  return env;
}

/** A server started as a child process and spoken to over its pipes. */
class StdioTransport {
  constructor({ command, args = [], env = {}, cwd } = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.pending = new Map();
    this.buffer = '';
    this.onRequest = null;
    this.closed = false;
  }

  async start() {
    // execFile semantics: an argument array and no shell, so nothing in a
    // command or its arguments is ever interpreted.
    this.child = spawn(this.command, this.args, {
      env: serverEnv(this.env),
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.#read(d));
    // A server's own logging is not our business, and an unread stderr pipe
    // can fill and stall the process.
    this.child.stderr.on('data', () => {});
    const fail = (why) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new RpcError(why));
      this.pending.clear();
    };
    this.child.on('error', (err) => fail(`could not start ${this.command}: ${err.message}`));
    this.child.on('exit', (code) => fail(`the connector stopped${code !== null ? ` (exit ${code})` : ''}`));
  }

  #read(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not ours to interpret
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      if (msg.error) waiting.reject(new RpcError(msg.error.message || 'the connector returned an error'));
      else waiting.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // The server asking us something. Ping is answered; anything else —
      // sampling, roots — is declined rather than left hanging.
      const reply = msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by this client' } };
      this.#write(reply);
    }
  }

  #write(obj) {
    if (this.closed) throw new RpcError('the connector is not running');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(id, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} took longer than ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async close() {
    this.closed = true;
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

/** A server at a URL: POST in, JSON or an event stream out. */
class HttpTransport {
  constructor({ url, headers = {}, getToken = null, refresh = null } = {}) {
    this.url = url;
    this.headers = headers;
    this.session = null;
    this.protocol = null;
    // Supplied by the connector layer when a signed-in token exists. Kept out
    // of this file so the protocol code never touches token storage.
    this.getToken = getToken;
    this.refresh = refresh;
  }

  async start() {}

  async #post(body, timeoutMs, token = undefined) {
    ledger({ kind: 'connector', url: this.url, detail: body.method || '' });
    const bearer = token === undefined ? await this.getToken?.() : token;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
        ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}),
        // A signed-in token, unless the person set their own header.
        ...(bearer && !this.headers.Authorization ? { Authorization: `Bearer ${bearer}` } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    return res;
  }

  async request(id, method, params, timeoutMs) {
    let res = await this.#post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    // An expired token is the ordinary case, not an error: refresh once and
    // retry. Only if that fails is the person asked to sign in again.
    if (res.status === 401 && this.refresh) {
      const fresh = await this.refresh();
      if (fresh) res = await this.#post({ jsonrpc: '2.0', id, method, params }, timeoutMs, fresh);
    }
    if (res.status === 401) {
      if (this.headers.Authorization) throw new RpcError('the connector refused the token it was given');
      // Only a 401 that says how to sign in means "sign in". A bare 401 is a
      // server that wants a token, and offering a sign-in page it does not
      // have would send the person looking for something that is not there.
      if (/bearer/i.test(res.headers.get('www-authenticate') || '')) throw new NeedsSignIn();
      throw new RpcError('the connector refused the request — it may need a token');
    }
    if (res.status === 403) throw new RpcError('the connector refused access — the account may not be allowed this');
    if (!res.ok) throw new RpcError(`the connector answered ${res.status}`);

    const type = res.headers.get('content-type') || '';
    let msg = null;
    if (type.includes('text/event-stream')) {
      // Read events until the one that answers this request.
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.id === id) {
            msg = parsed;
            break;
          }
        } catch {
          /* keep looking */
        }
      }
    } else {
      msg = await res.json().catch(() => null);
    }
    if (!msg) throw new RpcError('the connector sent no answer');
    if (msg.error) throw new RpcError(msg.error.message || 'the connector returned an error');
    return msg.result;
  }

  notify(method, params) {
    this.#post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, 10_000).catch(() => {});
  }

  async close() {}
}

/**
 * One connection to one server: handshake once, then list and call.
 */
export class McpClient {
  constructor(config) {
    this.config = config;
    this.nextId = 1;
    this.transport =
      config.type === 'http' || config.url
        ? new HttpTransport({ url: config.url, headers: config.headers, getToken: config.getToken, refresh: config.refresh })
        : new StdioTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd });
  }

  async connect() {
    await this.transport.start();
    const result = await this.transport.request(
      this.nextId++,
      'initialize',
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
      START_TIMEOUT_MS
    );
    this.server = result?.serverInfo || null;
    this.instructions = result?.instructions || '';
    if (this.transport instanceof HttpTransport) this.transport.protocol = result?.protocolVersion || PROTOCOL;
    this.transport.notify('notifications/initialized');
    return this.server;
  }

  /** Every tool, following pagination. */
  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.transport.request(this.nextId++, 'tools/list', cursor ? { cursor } : {}, START_TIMEOUT_MS);
      tools.push(...(result?.tools || []));
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  /** Call one tool and flatten its content to text the model can read. */
  async callTool(name, args = {}) {
    const result = await this.transport.request(this.nextId++, 'tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
    const parts = (result?.content || []).map((c) =>
      c.type === 'text' ? c.text
      : c.type === 'resource' && c.resource?.text ? c.resource.text
      : c.type === 'image' ? '[an image]'
      : `[${c.type}]`
    );
    if (result?.structuredContent && !parts.length) parts.push(JSON.stringify(result.structuredContent));
    return { text: parts.join('\n'), isError: Boolean(result?.isError) };
  }

  async close() {
    await this.transport.close();
  }
}
