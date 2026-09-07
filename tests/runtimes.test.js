/**
 * Runtimes.
 *
 * M9 makes what runs the model a choice, which introduces a failure mode the
 * project has not had before: a feature that works on one backend and quietly
 * does not on another. So these tests are mostly about *sameness*.
 *
 * The load-bearing one is `both runtimes yield identical chunks` — two adapters,
 * two wire formats, run against fake servers and compared frame by frame. If
 * that passes, nothing above the port can tell them apart, which is the only
 * thing that makes swapping runtimes safe.
 *
 * The rest cover the three places OpenAI's shape differs from Ollama's and one
 * place it is genuinely worse:
 *
 *   - SSE rather than newline JSON, ending in a sentinel;
 *   - tool calls arriving in fragments that must be reassembled;
 *   - reasoning under a field name nobody agrees on;
 *   - a context window that cannot be set per request, which must be *reported*
 *     rather than silently ignored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { OllamaAdapter } = await import('../src/adapters/inference/OllamaAdapter.js');
const { OpenAICompatAdapter } = await import('../src/adapters/inference/OpenAICompatAdapter.js');
const { LlamaCppAdapter } = await import('../src/adapters/inference/LlamaCppAdapter.js');
const { identify, detect, adapterFor } = await import('../src/runtimes/Providers.js');
const { Embedder } = await import('../src/recall/Embeddings.js');

// ──────────────────────────────────────────────────────────────── a fake server

/** Start an http server from a {'<METHOD> <path>': handler} map. */
async function serve(routes) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const body = await new Promise((resolve) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
    });
    seen.push({ method: req.method, path, url: req.url, body });

    const handler = routes[`${req.method} ${path}`];
    if (!handler) {
      res.writeHead(404).end('no route');
      return;
    }
    await handler(req, res, body);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
};

/** Write SSE frames, then the sentinel that ends an OpenAI stream. */
const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};

const ndjson = (res, lines) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const l of lines) res.write(`${JSON.stringify(l)}\n`);
  res.end();
};

const collect = async (iter) => {
  const out = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
};

// ───────────────────────────────────────────────────────────────── capabilities

test('every adapter says what it can do, in the same shape', () => {
  const shape = (caps) => {
    for (const key of ['id', 'label', 'models', 'context', 'thinking', 'embeddings', 'tools']) {
      assert.ok(key in caps, `capabilities() is missing ${key}`);
    }
    assert.ok(['list', 'list+pull'].includes(caps.models), caps.models);
    assert.ok(['per-request', 'per-instance'].includes(caps.context), caps.context);
    assert.ok(['levels', 'boolean', 'none'].includes(caps.thinking), caps.thinking);
    assert.equal(typeof caps.embeddings, 'boolean');
  };

  shape(new OllamaAdapter({ baseUrl: 'http://x' }).capabilities());
  shape(new OpenAICompatAdapter({ baseUrl: 'http://x' }).capabilities());
});

test('the context difference is declared, not hidden', () => {
  // This is the one capability genuinely lost against Ollama, and the whole
  // point of the descriptor is that the interface can say so rather than
  // offering a dial that does nothing.
  assert.equal(new OllamaAdapter({ baseUrl: 'http://x' }).capabilities().context, 'per-request');
  assert.equal(new OpenAICompatAdapter({ baseUrl: 'http://x' }).capabilities().context, 'per-instance');
});

test('a window set on a per-instance runtime is remembered so it can be reported', () => {
  const a = new OpenAICompatAdapter({ baseUrl: 'http://x' });
  assert.equal(a.pendingContext('m'), null);
  a.useContext('m', 16384);
  assert.equal(a.pendingContext('m'), 16384, 'the setting is real; it just needs a reload');
});

test('the base URL is accepted however it is pasted', () => {
  for (const given of ['http://h:1234', 'http://h:1234/', 'http://h:1234/v1', 'http://h:1234/v1/']) {
    const a = new OpenAICompatAdapter({ baseUrl: given });
    assert.equal(a.baseUrl, 'http://h:1234/v1', given);
    assert.equal(a.rootUrl, 'http://h:1234', given);
  }
});

// ───────────────────────────────────────────────────────────────────── models

test('models and their real window come back from an OpenAI-compatible server', async () => {
  const srv = await serve({
    'GET /v1/models': (_q, res) =>
      json(res, {
        data: [
          { id: 'small', meta: { n_ctx_train: 32768, n_params: 4e9, size: 2e9 } },
          { id: 'big', meta: { n_ctx_train: 8192, n_params: 8e9, size: 9e9 } },
        ],
      }),
    // llama.cpp reports what it actually loaded, which is the number that will
    // truncate us — 4096 here, far below the 32768 the weights were trained for.
    'GET /props': (_q, res) => json(res, { default_generation_settings: { n_ctx: 4096 } }),
  });

  const a = new OpenAICompatAdapter({ baseUrl: srv.url });
  const models = await a.listModels();
  assert.deepEqual(models.map((m) => m.name), ['big', 'small'], 'largest first');
  assert.equal(models[1].contextLength, 32768);

  const described = await a.describe('small');
  assert.equal(described.contextLength, 4096, 'the loaded window wins over the trained one');
  assert.equal(described.source, 'props');

  await srv.close();
});

test('a server with no /props falls back to the model list, then to a safe default', async () => {
  const srv = await serve({
    'GET /v1/models': (_q, res) => json(res, { data: [{ id: 'known', meta: { n_ctx_train: 16384 } }] }),
  });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });

  assert.equal((await a.describe('known')).contextLength, 16384);
  // Unknown model, no metadata anywhere: guess small. Too small truncates;
  // too large overflows, which is the worse failure.
  assert.equal((await a.describe('mystery')).contextLength, 8192);

  await srv.close();
});

// ─────────────────────────────────────────────────────────────────── streaming

const OPENAI_STREAM = [
  { choices: [{ delta: { reasoning_content: 'Let me think. ' } }] },
  { choices: [{ delta: { content: 'Hello' } }] },
  { choices: [{ delta: { content: ' world' } }] },
  { usage: { prompt_tokens: 11, completion_tokens: 3 }, choices: [{ delta: {} }] },
];

test('a streamed reply arrives as thinking then content', async () => {
  const srv = await serve({ 'POST /v1/chat/completions': (_q, res) => sse(res, OPENAI_STREAM) });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });

  const chunks = await collect(a.chat({ model: 'm', messages: [] }));
  assert.deepEqual(
    chunks.filter((c) => c.type !== 'done'),
    [
      { type: 'thinking', text: 'Let me think. ' },
      { type: 'content', text: 'Hello' },
      { type: 'content', text: ' world' },
    ]
  );

  const done = chunks.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.metrics.promptTokens, 11, 'usage only arrives if we ask for it');
  assert.equal(done.metrics.completionTokens, 3);

  await srv.close();
});

test('reasoning is read under either name servers use for it', async () => {
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res) =>
      sse(res, [{ choices: [{ delta: { reasoning: 'plain-reasoning' } }] }]),
  });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });
  const chunks = await collect(a.chat({ model: 'm', messages: [] }));
  assert.equal(chunks[0].text, 'plain-reasoning');
  await srv.close();
});

test('a frame split across reads still parses', async () => {
  // Not hypothetical: SSE frames are chopped at arbitrary byte boundaries, and
  // a parser that assumes whole lines drops tokens under load.
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'whole' } }] })}\n\n`;
      res.write(frame.slice(0, 14));
      setTimeout(() => {
        res.write(frame.slice(14));
        res.write('data: [DONE]\n\n');
        res.end();
      }, 10);
    },
  });

  const a = new OpenAICompatAdapter({ baseUrl: srv.url });
  const chunks = await collect(a.chat({ model: 'm', messages: [] }));
  assert.equal(chunks[0].text, 'whole');
  await srv.close();
});

// ─────────────────────────────────────────────────────────────────── tool calls

test('tool calls arriving in fragments are handed over whole', async () => {
  // OpenAI streams a call as an index, then a name, then the arguments a few
  // characters at a time. Everything downstream expects one finished call, so
  // this is where it gets made whole — and parsing early would fail on every
  // fragment but the last.
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res) =>
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'file_read', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/a.md"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'folder_list', arguments: '{}' } }] } }] },
      ]),
  });

  const a = new OpenAICompatAdapter({ baseUrl: srv.url });
  const chunks = await collect(a.chat({ model: 'm', messages: [] }));
  const calls = chunks.find((c) => c.type === 'tool_calls')?.calls;

  assert.equal(calls.length, 2, 'two indices, two calls');
  assert.equal(calls[0].function.name, 'file_read');
  assert.equal(calls[0].function.arguments, '{"path":"/a.md"}', 'fragments concatenated in order');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: '/a.md' });
  assert.equal(calls[1].function.name, 'folder_list');

  await srv.close();
});

// ──────────────────────────────────────────────────────────────────── reasoning

test('a thinking level is sent as reasoning effort, and off means off', async () => {
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res) => sse(res, [{ choices: [{ delta: { content: 'x' } }] }]),
  });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });

  await collect(a.chat({ model: 'm', messages: [], think: 'high' }));
  assert.equal(srv.seen.at(-1).body.reasoning_effort, 'high');

  await collect(a.chat({ model: 'm', messages: [], think: false }));
  assert.equal(srv.seen.at(-1).body.reasoning_effort, 'none');

  // `true` is "reason as you normally would" — that is the absence of a level,
  // not a level we invent on the user's behalf.
  await collect(a.chat({ model: 'm', messages: [], think: true }));
  assert.ok(!('reasoning_effort' in srv.seen.at(-1).body));

  await srv.close();
});

test('a server that rejects reasoning effort is retried once, then not asked again', async () => {
  let rejections = 0;
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res, body) => {
      if ('reasoning_effort' in body) {
        rejections++;
        return json(res, { error: 'unknown field reasoning_effort' }, 400);
      }
      sse(res, [{ choices: [{ delta: { content: 'ok' } }] }]);
    },
  });

  const a = new OpenAICompatAdapter({ baseUrl: srv.url });
  const first = await collect(a.chat({ model: 'm', messages: [], think: 'high' }));
  assert.equal(first.find((c) => c.type === 'content').text, 'ok', 'it stepped down rather than failing');
  assert.equal(
    first.at(-1).metrics.think,
    true,
    'the level was refused but the model still reasoned — report the step-down, not the wish'
  );

  await collect(a.chat({ model: 'm', messages: [], think: 'high' }));
  assert.equal(rejections, 1, 'the discovery is remembered, not repaid every turn');

  await srv.close();
});

test('a real error is not mistaken for a reasoning refusal', async () => {
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res) => json(res, { error: 'model not found' }, 404),
  });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });
  await assert.rejects(
    () => collect(a.chat({ model: 'gone', messages: [], think: 'high' })),
    /404/
  );
  await srv.close();
});

// ────────────────────────────────────────────────────── schema-constrained JSON

test('a JSON schema survives translation to response_format', async () => {
  // The Reflector depends on constrained sampling to get a parseable object out
  // of a 4B model. Dropping the constraint would not fail loudly — it would
  // start returning prose that occasionally fails to parse.
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res) => json(res, { choices: [{ message: { content: '{"ok":true}' } }] }),
  });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });

  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const out = await a.complete({ model: 'm', messages: [], format: schema });
  assert.equal(out.content, '{"ok":true}');

  const sent = srv.seen.at(-1).body.response_format;
  assert.equal(sent.type, 'json_schema');
  assert.deepEqual(sent.json_schema.schema, schema);

  await a.complete({ model: 'm', messages: [], format: 'json' });
  assert.equal(srv.seen.at(-1).body.response_format.type, 'json_object');

  await srv.close();
});

test('num_ctx is dropped rather than sent somewhere it does nothing', async () => {
  const srv = await serve({
    'POST /v1/chat/completions': (_q, res) => json(res, { choices: [{ message: { content: '' } }] }),
  });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });
  await a.complete({ model: 'm', messages: [], options: { num_ctx: 8192, temperature: 0.2, num_predict: 50 } });

  const body = srv.seen.at(-1).body;
  assert.ok(!('num_ctx' in body), 'it has no per-request meaning here');
  assert.ok(!('options' in body), "and Ollama's envelope is not part of this wire");
  assert.equal(body.temperature, 0.2, 'what does translate, translates');
  assert.equal(body.max_tokens, 50);

  await srv.close();
});

// ─────────────────────────────────────────────────────────────────── embeddings

test('embeddings come back as plain rows, or throw for the caller to handle', async () => {
  const srv = await serve({
    'POST /v1/embeddings': (_q, res, body) =>
      json(res, { data: body.input.map((_t, i) => ({ embedding: [i, i + 1] })) }),
  });
  const a = new OpenAICompatAdapter({ baseUrl: srv.url });

  assert.deepEqual(await a.embed({ model: 'e', texts: ['a', 'b'] }), [[0, 1], [1, 2]]);
  await srv.close();

  // Unreachable server: the adapter throws so the caller owns the decision to
  // degrade to keyword recall and can say why.
  const dead = new OpenAICompatAdapter({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(() => dead.embed({ model: 'e', texts: ['a'] }));
});

// ───────────────────────────────────────────────── the reason any of this works

test('both runtimes yield identical chunks for the same reply', async () => {
  // The load-bearing test of M9. Two wire formats, two adapters; if the frames
  // they hand upward differ in shape, then swapping runtimes is a change the
  // controller, the trace and the transcript can all feel — and "pick your
  // backend" becomes a promise the product cannot keep.
  const ollamaSrv = await serve({
    'POST /api/chat': (_q, res) =>
      ndjson(res, [
        { message: { thinking: 'Let me think. ' } },
        { message: { content: 'Hello' } },
        { message: { content: ' world' } },
        {
          message: { tool_calls: [{ function: { name: 'file_read', arguments: { path: '/a.md' } } }] },
        },
        { done: true, prompt_eval_count: 11, eval_count: 3, eval_duration: 1e9 },
      ]),
  });

  const openaiSrv = await serve({
    'POST /v1/chat/completions': (_q, res) =>
      sse(res, [
        { choices: [{ delta: { reasoning_content: 'Let me think. ' } }] },
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'file_read', arguments: '{"path":"/a.md"}' } }] } }] },
        { usage: { prompt_tokens: 11, completion_tokens: 3 }, choices: [{ delta: {} }] },
      ]),
  });

  const fromOllama = await collect(
    new OllamaAdapter({ baseUrl: ollamaSrv.url }).chat({ model: 'm', messages: [] })
  );
  const fromOpenAI = await collect(
    new OpenAICompatAdapter({ baseUrl: openaiSrv.url }).chat({ model: 'm', messages: [] })
  );

  // Same frames, in the same order.
  assert.deepEqual(
    fromOllama.map((c) => c.type),
    fromOpenAI.map((c) => c.type)
  );

  // Same text, chunk for chunk.
  const texts = (list) => list.filter((c) => c.text !== undefined).map((c) => [c.type, c.text]);
  assert.deepEqual(texts(fromOllama), texts(fromOpenAI));

  // Same tool call, despite one arriving as an object and the other as a string
  // assembled from fragments. `ChatController.parseArgs` accepts both.
  const call = (list) => list.find((c) => c.type === 'tool_calls').calls[0];
  assert.equal(call(fromOllama).function.name, call(fromOpenAI).function.name);
  const args = (c) => (typeof c === 'string' ? JSON.parse(c) : c);
  assert.deepEqual(args(call(fromOllama).function.arguments), args(call(fromOpenAI).function.arguments));

  // Same metrics keys, so the trace renders identically whatever is underneath.
  assert.deepEqual(
    Object.keys(fromOllama.at(-1).metrics).sort(),
    Object.keys(fromOpenAI.at(-1).metrics).sort()
  );
  assert.equal(fromOllama.at(-1).metrics.promptTokens, fromOpenAI.at(-1).metrics.promptTokens);
  assert.equal(fromOllama.at(-1).metrics.completionTokens, fromOpenAI.at(-1).metrics.completionTokens);

  await ollamaSrv.close();
  await openaiSrv.close();
});

// ───────────────────────────────────────────────────────────── pulling a model

test('both runtimes report download progress the same way', async () => {
  // A pull is the one long operation a person watches, so the shape of the
  // progress has to be identical or the UI needs to know which backend it is
  // talking to — which is the thing the port exists to prevent.
  const llamaSrv = await serve({
    // The real wire shape, taken from a running llama-server rather than from
    // documentation: the discriminator is `event`, and the payload is `data`.
    'GET /models/sse': (_q, res) =>
      sse(res, [
        { model: 'org/m:Q4', event: 'download_progress', data: { files: [{ done: 50, total: 200 }, { done: 50, total: 200 }] } },
        { model: 'other/x', event: 'download_progress', data: { files: [{ done: 1, total: 9999 }] } },
        { model: 'org/m:Q4', event: 'download_finished' },
      ]),
    'POST /models': (_q, res) => json(res, { ok: true }),
    'GET /models': (_q, res) => json(res, { data: [{ id: 'org/m:Q4' }] }),
  });

  const ollamaSrv = await serve({
    'POST /api/pull': (_q, res) =>
      ndjson(res, [
        { status: 'pulling manifest' },
        { status: 'downloading', completed: 100, total: 400 },
        { status: 'success' },
      ]),
  });

  const fromLlama = await collect(new LlamaCppAdapter({ baseUrl: llamaSrv.url }).pull('org/m:Q4'));
  const fromOllama = await collect(new OllamaAdapter({ baseUrl: ollamaSrv.url }).pull('m'));

  for (const [name, events] of [['llama.cpp', fromLlama], ['ollama', fromOllama]]) {
    assert.equal(events.at(-1).type, 'done', `${name} must end with done`);
    const progress = events.filter((e) => e.type === 'progress');
    assert.ok(progress.length, `${name} reported no progress`);
    for (const p of progress) {
      for (const key of ['received', 'total', 'percent', 'status']) {
        assert.ok(key in p, `${name} progress is missing ${key}`);
      }
    }
  }

  // Several files download at once for a sharded model; progress is their sum.
  assert.equal(fromLlama[0].received, 100);
  assert.equal(fromLlama[0].total, 400);
  assert.equal(fromLlama[0].percent, 25);
  // And another model's download is not ours.
  assert.equal(fromLlama.filter((e) => e.type === 'progress').length, 1, 'someone else’s download leaked in');

  await llamaSrv.close();
  await ollamaSrv.close();
});

test('the progress stream is opened before the download is asked for', async () => {
  // /models/sse has no replay. Start the download first and every event that
  // fires before the reader attaches is lost — on a small model that can be all
  // of them, and the bar sits at 0% until the file is already there.
  const order = [];
  const srv = await serve({
    'GET /models/sse': (_q, res) => {
      order.push('sse');
      sse(res, [{ model: 'm', event: 'download_finished' }]);
    },
    'GET /models': (_q, res) => json(res, { data: [{ id: 'm' }] }),
    'POST /models': (_q, res) => {
      order.push('post');
      json(res, { ok: true });
    },
  });

  await collect(new LlamaCppAdapter({ baseUrl: srv.url }).pull('m'));
  assert.deepEqual(order, ['sse', 'post']);
  await srv.close();
});

test('a failed download throws rather than hanging', async () => {
  const srv = await serve({
    'GET /models/sse': (_q, res) => sse(res, [{ model: 'm', event: 'download_failed', data: { error: 'no such repo' } }]),
    'POST /models': (_q, res) => json(res, { ok: true }),
  });
  await assert.rejects(() => collect(new LlamaCppAdapter({ baseUrl: srv.url }).pull('m')), /no such repo/);
  await srv.close();
});

test('only the runtimes that can pull say they can', () => {
  assert.equal(new LlamaCppAdapter({ baseUrl: 'http://x' }).capabilities().models, 'list+pull');
  assert.equal(new OllamaAdapter({ baseUrl: 'http://x' }).capabilities().models, 'list+pull');
  // A base URL someone pasted is not known to have a model manager, and
  // offering a pull button that 404s is worse than not offering one.
  assert.equal(new OpenAICompatAdapter({ baseUrl: 'http://x' }).capabilities().models, 'list');
});

test('llama.cpp prefers its own model list, and falls back when there is none', async () => {
  const router = await serve({
    'GET /models': (_q, res) =>
      json(res, { models: [{ id: 'org/big:Q4_K_M', status: 'downloading', meta: { size: 5e9 } }] }),
  });
  const listed = await new LlamaCppAdapter({ baseUrl: router.url }).listModels();
  assert.equal(listed[0].status, 'downloading', 'a picker that cannot show this looks broken');
  assert.equal(listed[0].quantization, 'Q4_K_M');
  await router.close();

  // An older build with no router mode still has /v1/models.
  const old = await serve({ 'GET /v1/models': (_q, res) => json(res, { data: [{ id: 'plain' }] }) });
  assert.equal((await new LlamaCppAdapter({ baseUrl: old.url }).listModels())[0].name, 'plain');
  await old.close();
});

// ──────────────────────────────────────────────────────────────────── detection

test('a server is identified by what it answers, not by its port', async () => {
  const ollama = await serve({ 'GET /api/tags': (_q, res) => json(res, { models: [] }) });
  const llamacpp = await serve({
    'GET /v1/models': (_q, res) => json(res, { data: [] }),
    'GET /props': (_q, res) => json(res, { default_generation_settings: { n_ctx: 4096 } }),
  });
  const generic = await serve({ 'GET /v1/models': (_q, res) => json(res, { data: [] }) });

  assert.equal((await identify(ollama.url)).kind, 'ollama');
  // /props is the only thing that separates llama.cpp from any other
  // OpenAI-compatible server — both serve /v1/models identically.
  assert.equal((await identify(llamacpp.url)).kind, 'llamacpp');
  assert.equal((await identify(generic.url)).kind, 'openai-compat');
  assert.equal(await identify('http://127.0.0.1:1'), null, 'nothing there is not a runtime');

  await ollama.close();
  await llamacpp.close();
  await generic.close();
});

test('detection probes every port at once', async () => {
  // Serially, five dead ports is five timeouts on the machine least able to
  // wait for them — the one with nothing installed.
  const live = await serve({ 'GET /api/tags': (_q, res) => json(res, { models: [] }) });
  const port = Number(new URL(live.url).port);

  const started = Date.now();
  const found = await detect({
    hosts: [{ port }, { port: 1 }, { port: 2 }, { port: 3 }, { port: 4 }],
  });
  const elapsed = Date.now() - started;

  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'ollama');
  assert.ok(elapsed < 2500, `probing took ${elapsed}ms — that looks serial`);

  await live.close();
});

test('a saved choice builds the runtime it names', () => {
  assert.equal(adapterFor({ provider: 'ollama' }).capabilities().id, 'ollama');
  assert.equal(adapterFor({ provider: 'llamacpp', baseUrl: 'http://x' }).capabilities().id, 'llamacpp');
  assert.equal(adapterFor({ provider: 'openai-compat', baseUrl: 'http://x' }).capabilities().id, 'openai-compat');
  assert.throws(() => adapterFor({ provider: 'wishful' }), /Unknown runtime provider/);
});

// ───────────────────────────────────────────────── embeddings follow the choice

test('the embedder uses the runtime it was given, not a hardcoded Ollama', async () => {
  const srv = await serve({
    'GET /v1/models': (_q, res) => json(res, { data: [{ id: 'nomic-embed-text-v1.5' }, { id: 'chatty' }] }),
    'POST /v1/embeddings': (_q, res, body) =>
      json(res, { data: body.input.map(() => ({ embedding: [3, 4] })) }),
  });

  const embedder = new Embedder({ adapter: new OpenAICompatAdapter({ baseUrl: srv.url }) });
  assert.equal(await embedder.resolve(), 'nomic-embed-text-v1.5', 'a known embedding name is recognised');

  const [vec] = await embedder.embed(['hello']);
  assert.equal(Number(vec[0].toFixed(1)), 0.6, 'vectors come back unit-normalized');
  assert.equal(embedder.reason, 'ok');

  await srv.close();
});

test('an unlabelled runtime declines to guess an embedding model', async () => {
  // This is the safety property. A bare /v1/models cannot tell an embedding
  // model from a chat model, and guessing would embed the whole corpus with a
  // chat model — vectors that look fine, score badly, and are wrong in a way
  // nobody notices for weeks. Declining costs semantic recall until someone
  // chooses; guessing costs the index.
  const srv = await serve({ 'GET /v1/models': (_q, res) => json(res, { data: [{ id: 'some-chat-model' }] }) });

  const embedder = new Embedder({ adapter: new OpenAICompatAdapter({ baseUrl: srv.url }) });
  assert.equal(await embedder.resolve(), null);
  assert.match(embedder.reason, /does not say which models embed/);
  assert.equal(await embedder.embed(['x']), null, 'recall degrades to keyword rather than breaking');

  await srv.close();
});

test('a labelled runtime may pick for itself', async () => {
  // Ollama's tags say which models embed, so falling back to the first one is
  // a safe answer rather than a guess.
  const srv = await serve({
    'GET /api/tags': (_q, res) =>
      json(res, {
        models: [
          { name: 'chatty:8b', capabilities: ['completion'] },
          { name: 'house-embedder:1b', capabilities: ['embedding'] },
        ],
      }),
  });

  const embedder = new Embedder({ adapter: new OllamaAdapter({ baseUrl: srv.url }) });
  assert.equal(await embedder.resolve(), 'house-embedder:1b', 'not the chat model');
  await srv.close();
});

test('an unreachable runtime degrades recall instead of breaking the turn', async () => {
  const embedder = new Embedder({ adapter: new OllamaAdapter({ baseUrl: 'http://127.0.0.1:1' }) });
  assert.equal(await embedder.embed(['x']), null);
  assert.match(embedder.reason, /unreachable|failed/);
});

test('Embeddings no longer talks to Ollama behind the port', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/recall/Embeddings.js', import.meta.url), 'utf8')
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  // It was a second Ollama client for four milestones. If these come back,
  // choosing a runtime silently stops applying to recall.
  assert.doesNotMatch(code, /\/api\/(tags|embed)/, 'embeddings must go through the port');
  assert.doesNotMatch(code, /11434/, 'no runtime URL belongs in the recall engine');
});

// ────────────────────────────────────── what a finished download actually means

test('a download that failed is not reported as finished', async () => {
  // llama.cpp emits download_finished — and logs "download completed
  // successfully" — even when the fetch 401'd, which is what Hugging Face
  // answers for a repo that does not exist. Believing it hands the user "Done"
  // and then "model not found" from a different screen a moment later.
  const srv = await serve({
    'GET /models/sse': (_q, res) => sse(res, [{ model: 'org/ghost:Q4', event: 'download_finished' }]),
    'POST /models': (_q, res) => json(res, { ok: true }),
    // The model never appears, because it never arrived.
    'GET /models': (_q, res) => json(res, { data: [] }),
  });

  await assert.rejects(
    () => collect(new LlamaCppAdapter({ baseUrl: srv.url }).pull('org/ghost:Q4')),
    /did not arrive/
  );
  await srv.close();
});

test('the event field is `event`, not `type`', async () => {
  // Getting this wrong is silent: nothing matches, download_finished is never
  // seen, and the read blocks until the connection dies — surfacing as
  // "terminated" long after the download actually succeeded.
  const srv = await serve({
    'GET /models/sse': (_q, res) =>
      sse(res, [
        { model: 'org/m:Q4', event: 'model_status', data: { status: 'downloading' } },
        { model: 'org/m:Q4', event: 'download_finished' },
      ]),
    'POST /models': (_q, res) => json(res, { ok: true }),
    'GET /models': (_q, res) => json(res, { data: [{ id: 'org/m:Q4' }] }),
  });

  const events = await collect(new LlamaCppAdapter({ baseUrl: srv.url }).pull('org/m:Q4'));
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.some((e) => e.type === 'progress' && e.status === 'downloading'));
  await srv.close();
});

test('asking for a model already registered is done, not an error', async () => {
  // Router mode answers 400 "already exists". That is the request having
  // nothing to do, and reporting it as a failure makes re-running a pull look
  // broken on every machine that already has the model.
  const srv = await serve({
    'GET /models/sse': (_q, res) => sse(res, []),
    'POST /models': (_q, res) =>
      json(res, { error: { code: 400, message: "model 'org/m:Q4' already exists" } }, 400),
  });
  const events = await collect(new LlamaCppAdapter({ baseUrl: srv.url }).pull('org/m:Q4'));
  assert.deepEqual(events, [{ type: 'done', model: 'org/m:Q4' }]);
  await srv.close();
});

test('router status is a word, not the object it arrives as', async () => {
  // /models reports status as an object carrying the child's argv and preset.
  // Rendered straight into the picker, that reads "[object Object]".
  const srv = await serve({
    'GET /models': (_q, res) =>
      json(res, { data: [{ id: 'org/m:Q4', status: { value: 'unloaded', args: ['--port', '0'] } }] }),
  });
  const [model] = await new LlamaCppAdapter({ baseUrl: srv.url }).listModels();
  assert.equal(model.status, 'unloaded');
  await srv.close();
});
