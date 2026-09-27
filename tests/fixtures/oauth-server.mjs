// An MCP server protected by OAuth, with its own sign-in server, all on this
// machine — the shape of a hosted connector, for tests. Strict where real ones
// are strict: PKCE is checked, redirect URIs must be the registered ones, the
// resource indicator must match, codes are single-use.
//
//   node oauth-server.mjs <port> [--no-register]
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2]);
const allowRegister = !process.argv.includes('--no-register');
const origin = `http://127.0.0.1:${port}`;
const resource = `${origin}/mcp`;

const clients = new Map([['pre-registered', { redirect_uris: null }]]); // null = any loopback
const codes = new Map();
const access = new Set();
const refreshes = new Set();
let n = 0;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const read = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, origin);

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource, authorization_servers: [origin], scopes_supported: ['mcp:tools'] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(allowRegister ? { registration_endpoint: `${origin}/register` } : {}),
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await read(req));
      const id = `client-${++n}`;
      clients.set(id, { redirect_uris: body.redirect_uris });
      return json(res, 201, { client_id: id });
    }
    if (url.pathname === '/authorize') {
      // Stands in for the person signing in and pressing Allow.
      const q = url.searchParams;
      const client = clients.get(q.get('client_id'));
      const redirect = q.get('redirect_uri');
      const ok =
        client &&
        (client.redirect_uris ? client.redirect_uris.includes(redirect) : /^http:\/\/127\.0\.0\.1:\d+\//.test(redirect)) &&
        q.get('code_challenge_method') === 'S256' &&
        q.get('code_challenge') &&
        q.get('resource') === resource &&
        q.get('state');
      if (!ok) return json(res, 400, { error: 'invalid_request' });
      const code = `code-${++n}`;
      codes.set(code, { challenge: q.get('code_challenge'), client: q.get('client_id'), redirect, resource: q.get('resource') });
      res.writeHead(302, { Location: `${redirect}?code=${code}&state=${encodeURIComponent(q.get('state'))}` });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await read(req));
      if (p.get('grant_type') === 'authorization_code') {
        const c = codes.get(p.get('code'));
        codes.delete(p.get('code')); // single use
        const verified = c && b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest()) === c.challenge;
        if (!verified || c.redirect !== p.get('redirect_uri') || c.client !== p.get('client_id') || c.resource !== p.get('resource')) {
          return json(res, 400, { error: 'invalid_grant' });
        }
      } else if (p.get('grant_type') === 'refresh_token') {
        if (!refreshes.has(p.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
      } else {
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      const at = `at-${++n}`;
      const rt = `rt-${n}`;
      access.add(at);
      refreshes.add(rt);
      return json(res, 200, { access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: rt });
    }
    if (url.pathname === '/test/expire-all' && req.method === 'POST') {
      access.clear(); // tokens stop working; refresh tokens still do
      return json(res, 200, {});
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!access.has(token)) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const msg = JSON.parse(await read(req));
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result =
        msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cloud-test', version: '1' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'whoami', description: 'Say who is signed in.', inputSchema: { type: 'object', properties: {} } }] }
        : msg.method === 'tools/call' ? { content: [{ type: 'text', text: 'signed in as the test user' }] }
        : {};
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    }
    res.writeHead(404).end();
  })
  .listen(port, '127.0.0.1');
