// A small MCP server for tests, speaking the real protocol over stdio, or over
// HTTP with --http <port>. No dependencies, like the client it tests.
import http from 'node:http';

const TOOLS = [
  { name: 'echo', description: 'Echo the text back. Use for echoing.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers together.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'broken', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Report whether a secret leaked into the environment.', inputSchema: { type: 'object', properties: {} } },
];

function handle(msg) {
  if (msg.method === 'initialize') {
    return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1.0' } };
  }
  if (msg.method === 'tools/list') {
    // Paginated, so the client has to follow the cursor.
    return msg.params?.cursor ? { tools: TOOLS.slice(2) } : { tools: TOOLS.slice(0, 2), nextCursor: 'page2' };
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: a = {} } = msg.params || {};
    if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${a.text}` }] };
    if (name === 'add') return { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] };
    if (name === 'broken') return { content: [{ type: 'text', text: 'it broke' }], isError: true };
    if (name === 'env') return { content: [{ type: 'text', text: process.env.REFLECT_TEST_SECRET ? 'LEAKED' : 'clean' }] };
    return { error: { code: -32602, message: `unknown tool ${name}` } };
  }
  return undefined;
}

if (process.argv[2] === '--http') {
  const port = Number(process.argv[3]);
  http
    .createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const msg = JSON.parse(body || '{}');
        if (process.argv[4] === '--token' && req.headers.authorization !== `Bearer ${process.argv[5]}`) {
          res.writeHead(401).end();
          return;
        }
        if (msg.id === undefined) return void res.writeHead(202).end();
        const out = handle(msg);
        const reply = out?.error ? { jsonrpc: '2.0', id: msg.id, error: out.error } : { jsonrpc: '2.0', id: msg.id, result: out };
        // Answer tool calls as an event stream, everything else as JSON, so
        // the client has to handle both.
        if (msg.method === 'tools/call') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 's1' });
          res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' });
          res.end(JSON.stringify(reply));
        }
      });
    })
    .listen(port, '127.0.0.1');
} else {
  let buf = '';
  let pinged = false;
  let ponged = false;
  const held = [];
  const answer = (msg) => {
    const out = handle(msg);
    const reply = out?.error ? { jsonrpc: '2.0', id: msg.id, error: out.error } : { jsonrpc: '2.0', id: msg.id, result: out };
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id === 'server-ping') { ponged = true; held.splice(0).forEach(answer); continue; } // the client answering our ping
      if (msg.id === undefined) {
        // After the handshake, the server asks the client something, as real
        // servers do. A client that ignores this leaves the server waiting.
        if (msg.method === 'notifications/initialized' && !pinged) {
          pinged = true;
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' })}\n`);
        }
        continue;
      }
      // Hold the listing until our ping is answered. A client that ignores the
      // server's own requests then times out here, visibly, instead of in the
      // wild — and a client that answers is never penalised for sending its
      // next request before the ping arrived.
      if (msg.method === 'tools/list' && !ponged) {
        held.push(msg);
        continue;
      }
      answer(msg);
    }
  });
}
