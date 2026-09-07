/**
 * When the runtime returns nothing.
 *
 * Observed for real: `gpt-oss:20b` on a 16GB Mac, with other models resident.
 * Ollama does not error — it answers `{"message":{"content":""},"done":false}`,
 * and Reflect rendered that as an empty bubble with no explanation, which looks
 * exactly like a model that had nothing to say.
 *
 * Two rules come out of it: say what happened, and do not write an assistant
 * turn that never existed. The transcript is the one thing in Reflect that is
 * supposed to be a faithful record.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { useStorage, resetStorage } = await import('../src/core/Storage.js');
const { MemoryStorage } = await import('../src/adapters/storage/MemoryStorage.js');
useStorage(new MemoryStorage());

const FileStore = await import('../src/store/FileStore.js');
const Conversations = await import('../src/store/ConversationStore.js');
const { createChatHandler } = await import('../src/api/ChatController.js');

await FileStore.scaffold();

/** A runtime that loads nothing and says nothing about it. */
const silentOllama = {
  async describe() {
    return { contextLength: 8192, thinking: false, tools: false };
  },
  useContext() {},
  async *chat() {
    yield { type: 'done', metrics: { model: 'brick:20b', latencyMs: 12, tokensPerSecond: null } };
  },
};

/**
 * One that reasons and never concludes.
 *
 * deepseek-r1 does this when thinking is switched off: it is a pure reasoning
 * model, so suppressing the thinking channel leaves the answer nowhere to go.
 * Observed producing thirty thousand characters of reasoning and no content.
 */
const ruminatingOllama = {
  ...silentOllama,
  async describe() {
    return { contextLength: 8192, thinking: true, tools: false };
  },
  async *chat() {
    yield { type: 'thinking', text: 'Let me consider. '.repeat(40) };
    yield { type: 'done', metrics: { model: 'ruminator:1.5b', latencyMs: 900 } };
  },
};

/** One that answers normally, for the contrast. */
const talkativeOllama = {
  ...silentOllama,
  async *chat() {
    yield { type: 'content', text: 'Priya.' };
    yield { type: 'done', metrics: { model: 'fine:4b', latencyMs: 30 } };
  },
};

function serve(ollama) {
  const app = express();
  app.use(express.json());
  app.post('/api/chat', createChatHandler({ runtime: ollama }));
  return app.listen(0);
}

/** Drive one turn and collect the SSE events. */
async function turn(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ depth: 1, model: 'brick:20b', thinking: 'off', ...body }),
  });
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line.replace(/^data: /, ''));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

test.after(() => resetStorage());

test('an empty reply is reported, not rendered as silence', async () => {
  const server = serve(silentOllama);
  try {
    const events = await turn(server, { message: 'Who is my wife?' });
    const error = events.find((e) => e.type === 'error');

    assert.ok(error, 'a model that returned nothing must produce an error event');
    assert.match(error.message, /brick:20b/, 'name the model that failed, not "the model"');
    assert.match(error.message, /empty reply/i);
    assert.match(error.message, /smaller model/, 'an error a person can act on says what to do');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('nothing said is nothing recorded', async () => {
  const server = serve(silentOllama);
  try {
    const events = await turn(server, { message: 'Remember nothing at all' });
    const convId = events.find((e) => e.type === 'start')?.conversationId;
    assert.ok(convId);

    const turns = await Conversations.turns(convId);
    assert.equal(turns.length, 1, 'the user turn stands; the assistant turn never happened');
    assert.equal(turns[0].role, 'user');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).empty, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a real reply is unaffected', async () => {
  const server = serve(talkativeOllama);
  try {
    const events = await turn(server, { message: 'Who is my wife?', model: 'fine:4b' });
    assert.equal(events.some((e) => e.type === 'error'), false);

    const convId = events.find((e) => e.type === 'start')?.conversationId;
    const turns = await Conversations.turns(convId);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].content, 'Priya.');
    assert.notEqual(events.at(-1).empty, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/** A runtime that streams a little, then waits to be cut off. */
const slowOllama = {
  ...silentOllama,
  async *chat({ signal }) {
    yield { type: 'content', text: 'The rain begins as ' };
    yield { type: 'content', text: 'a rumour on the roof.' };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
    });
    yield { type: 'done', metrics: {} };
  },
};

test('stopping keeps what was already read', async () => {
  // The reader saw two sentences. If the transcript does not have them, the app
  // lied about what happened the moment they scroll back.
  const server = serve(slowOllama);
  try {
    const port = server.address().port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Essay about rain', depth: 1, model: 'slow:4b' }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    let convId = null;
    while (!convId || !seen.includes('rumour')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      const match = /"conversationId":"([^"]+)"/.exec(seen);
      if (match) convId = match[1];
    }

    controller.abort();
    // Give the server the moment it needs to notice and write.
    await new Promise((r) => setTimeout(r, 300));

    const turns = await Conversations.turns(convId);
    assert.equal(turns.length, 2, 'the partial reply belongs in the record');
    assert.match(turns[1].content, /rumour on the roof/);
    assert.equal(turns[1].stopped, true, 'and it is marked, so it can be read as unfinished');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ─────────────────────────────────────────── when a model parrots the tools

test('a model that types the tool schema back is not shown as an answer', async () => {
  const { looksLikeToolEcho } = await import('../src/api/ChatController.js');

  // Verbatim from llama3.2:1b, which reports `tools` in its capabilities and
  // then emits the definition instead of calling it.
  const echo =
    '}\n{"type":"function","function":{"name":"memory_get","description":"Read one memory file in full.';
  assert.ok(looksLikeToolEcho(echo));
  assert.ok(looksLikeToolEcho('{"type":"function","function":{"name":"file_write","description":"..."}}'));

  // Ordinary answers, including ones that legitimately talk about JSON or tools,
  // must not trip it — suppressing a real reply is worse than showing a bad one.
  assert.ok(!looksLikeToolEcho('Here is the JSON you asked for: {"type":"function"}'));
  assert.ok(!looksLikeToolEcho('I used memory_write to save that.'));
  assert.ok(!looksLikeToolEcho('```json\n{"name":"memory_write"}\n```'));
  assert.ok(!looksLikeToolEcho('The sky is blue.'));
});

test('a model that reasons but never answers is not a blank turn', async () => {
  // The guard used to require that there was no thinking either, so this case
  // slipped through and was filed as an empty assistant turn — the one thing
  // the transcript is supposed never to contain.
  const server = serve(ruminatingOllama);
  const events = await turn(server, {
    message: 'What is 2+2?',
    model: 'ruminator:1.5b',
    conversationId: 'ruminate',
  });

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, 'reasoning without an answer must be reported');
  // Thinking was off in this turn, so the advice is to turn it back on.
  assert.match(error.message, /reasoned but never answered/);
  assert.match(error.message, /thinking/i);

  const recorded = await Conversations.turns('ruminate');
  assert.equal(
    recorded.filter((t) => t.role === 'assistant').length,
    0,
    'no assistant turn should be recorded for an answer that never came'
  );
  server.close();
});

test('reasoning that ran out of room is not blamed on the thinking setting', async () => {
  // The first version of this message told someone to turn thinking back *on*
  // when it was already on and the reasoning had simply consumed the window.
  // Blaming the wrong cause is worse than saying nothing.
  const server = serve(ruminatingOllama);
  const events = await turn(server, {
    message: 'Build me an HTML page with a chessboard.',
    model: 'ruminator:1.5b',
    conversationId: 'ranout',
    thinking: 'medium',
  });

  const error = events.find((e) => e.type === 'error');
  assert.ok(error);
  assert.match(error.message, /ran out of room/);
  assert.ok(!/Turn thinking back on/.test(error.message), 'thinking was already on');
  server.close();
});
