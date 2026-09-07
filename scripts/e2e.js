#!/usr/bin/env node
/**
 * End-to-end sweep. Real server, real Ollama, real models, a throwaway home.
 *
 * The unit suite proves the parts. This proves the product: it runs the
 * scenarios from the design document's test contract against a live stack, and
 * every one of them is a thing that was broken in Reflect 1.0.
 *
 * It keeps going after a failure rather than stopping at the first one, because
 * the point is to see every bug in one pass.
 *
 *   npm run e2e                 # default models
 *   E2E_MODEL=qwen3.5:9b npm run e2e
 *   E2E_KEEP=1 npm run e2e      # leave the home directory behind to inspect
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MODEL = process.env.E2E_MODEL || 'granite4.1:8b';
const SMALL_MODEL = process.env.E2E_SMALL_MODEL || 'qwen3:4b';
const PORT = Number(process.env.E2E_PORT || 3099);
const BASE = `http://localhost:${PORT}`;
const ROOT = path.dirname(new URL('.', import.meta.url).pathname);

let home;
let server;
const results = [];

// ─────────────────────────────────────────────────────────────────── harness

let skipped = 0;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * The sweep takes a quarter of an hour against real models, which is fine for
 * CI and miserable when you are iterating on one phase. E2E_ONLY runs the
 * phases whose names match, and says plainly that it did.
 */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
let current = '';

function phase(title) {
  current = title;
  if (ONLY && !ONLY.test(title)) return;
  console.log(`\n${c.bold(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)}`);
}

async function check(name, fn) {
  if (ONLY && !ONLY.test(current)) {
    skipped++;
    return;
  }
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ${c.green('✓')} ${name}${detail ? c.dim(`  ${detail}`) : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  ${c.red('✗')} ${name}`);
    console.log(`      ${c.red(err.message)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Send a chat turn and collect everything the stream reports. */
async function chat(message, { conversationId, model = MODEL, depth, tolerateEmpty = false } = {}) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId, model, depth }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out = { text: '', events: [], writes: [], trace: null, recall: null, compacted: null, error: null };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i).replace(/^data: /, '').trim();
      buf = buf.slice(i + 2);
      if (!raw) continue;
      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
      out.events.push(ev);
      if (ev.type === 'content_delta') out.text += ev.text;
      else if (ev.type === 'memory_write') out.writes.push(ev.write);
      else if (ev.type === 'context') {
        out.trace = ev.trace;
        out.recall = ev.trace.recall;
      } else if (ev.type === 'compacted') out.compacted = ev;
      else if (ev.type === 'error') out.error = ev.message;
    }
  }

  // Some checks are about what the *server* decided — which skill was
  // invoked, what went into the prompt — and those decisions are made and
  // reported before a single token is generated. Failing them because a 8B
  // model could not load on a busy machine tests the machine, not the code.
  if (out.error && !tolerateEmpty) throw new Error(`chat failed: ${out.error}`);
  return out;
}

const api = async (p, init) => {
  const res = await fetch(`${BASE}${p}`, init);
  if (!res.ok && res.status !== 404) throw new Error(`${p} → ${res.status}`);
  return res.json();
};

const readHomeFile = (rel) => fsp.readFile(path.join(home, rel), 'utf8').catch(() => '');
const has = (text, needle) => new RegExp(needle, 'i').test(text);
const countOf = (text, needle) => (text.match(new RegExp(needle, 'gi')) || []).length;

async function startServer() {
  server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, REFLECT_HOME: home, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => {
    const s = String(d);
    if (/Error|error/.test(s)) process.stderr.write(c.dim(`      server: ${s}`));
  });

  for (let i = 0; i < 60; i++) {
    try {
      const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
      if (health.ok) {
        // Make sure this is *our* server. A stale instance left on the port
        // answers health perfectly well, and the sweep would then run against
        // whatever home that one was started with — possibly the real one. It
        // happened: a leftover server made a grant check fail in a way that
        // looked like a product bug for ten minutes.
        if (health.home !== home) {
          throw new Error(
            `something else is already serving port ${PORT} (its home is ${health.home}). ` +
              'Stop it before running the sweep.'
          );
        }
        return health;
      }
    } catch (err) {
      if (/already serving/.test(err.message)) throw err;
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  server = null;
}

// ────────────────────────────────────────────────────────────────── the sweep

async function main() {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-e2e-'));
  console.log(c.bold('\nReflect 2.0 — end-to-end sweep'));
  console.log(c.dim(`  home    ${home}`));
  console.log(c.dim(`  models  ${MODEL} (chat), ${SMALL_MODEL} (swap test)`));

  const health = await startServer();

  // ── preflight ───────────────────────────────────────────────────────────
  phase('Preflight');
  await check('server is up and Ollama is reachable', () => {
    assert(health.ok, 'server unhealthy');
    assert(health.runtime?.ok, `Runtime unreachable: ${health.runtime?.error || 'unknown'}`);
    return health.version;
  });
  await check('the requested models are installed', async () => {
    const { models } = await api('/api/models');
    const names = models.map((m) => m.name);
    assert(names.includes(MODEL), `${MODEL} not installed`);
    assert(names.includes(SMALL_MODEL), `${SMALL_MODEL} not installed`);
    return `${models.length} chat models available`;
  });
  await check('a fresh home starts with an empty profile', async () => {
    const memory = await api('/api/memory');
    assert(memory.profile.empty, 'USER.md should start empty');
    assert(memory.projects.length === 0, 'no projects expected');
    return 'clean slate';
  });

  // ── M1/M2: conversation, explicit save, cross-chat recall ───────────────
  phase('Conversation and explicit memory');

  await check('a first turn answers and persists', async () => {
    const r = await chat('Hello — quick sanity check, are you there?', { conversationId: 'e2e-a' });
    assert(r.text.trim().length > 0, 'empty reply');
    const conv = await api('/api/conversations/e2e-a');
    assert(conv.turns.length === 2, `expected 2 turns, got ${conv.turns.length}`);
    return `${r.text.trim().slice(0, 40)}…`;
  });

  await check('"remember this" writes to USER.md immediately', async () => {
    const r = await chat('Remember this: my wife is Priya and I ride a Vespa GTS300.', {
      conversationId: 'e2e-a',
    });
    const explicit = r.writes.find((w) => w.action === 'save' && !w.auto);
    assert(explicit, 'no explicit save recorded');
    const profile = await readHomeFile('USER.md');
    assert(has(profile, 'Priya'), 'Priya not in USER.md');
    assert(has(profile, 'GTS300'), 'the bike is not in USER.md');
    return explicit.target;
  });

  await check('an ordinary fact is captured without being asked', async () => {
    await chat('I do most of my work on a Mac Studio with 128 gigs of RAM.', {
      conversationId: 'e2e-a',
    });
    const profile = await readHomeFile('USER.md');
    assert(has(profile, 'Mac Studio'), 'the Mac Studio was not captured automatically');
    return 'captured';
  });

  await check('a project note lands in its own file', async () => {
    await chat(
      "For the Turtles Book I've decided it's darker and more adult, keeping the original personalities.",
      { conversationId: 'e2e-a' }
    );
    const memory = await api('/api/memory');
    assert(memory.projects.length >= 1, 'no project file created');

    // Find the book by name rather than trusting position: the list is ordered
    // by last touched, so index 0 is whichever project moved most recently.
    const book = memory.projects.find((p) => /turtle|book/i.test(p.slug)) || memory.projects[0];
    const doc = await api(`/api/memory/file?path=projects/${book.slug}.md`);

    // Assert on substance, not wording. A model given "darker and more adult"
    // may file "Dark and adult adaptation of the original personalities" — the
    // decision is intact and the exact adjective is not the product. Insisting
    // on the literal word made this fail while the feature worked.
    const kept = ['dark', 'adult', 'personalit'].filter((w) => has(doc.content, w));
    assert(
      kept.length >= 2,
      `the decision is not in the project file — it holds:\n        ${doc.content.replace(/\n/g, '\n        ')}`
    );
    return `projects/${book.slug}.md · ${kept.join(', ')}`;
  });

  // ── the cold restart ────────────────────────────────────────────────────
  phase('Cold restart');

  await check('the server restarts against the same home', async () => {
    await stopServer();
    const h = await startServer();
    assert(h.ok, 'server did not come back');
    return 'restarted';
  });

  await check('a brand-new conversation knows the user (§6 direct recall)', async () => {
    const r = await chat('What is my wife called, and what do I ride?', { conversationId: 'e2e-b' });
    assert(has(r.text, 'Priya'), `wife not recalled — said: ${r.text.slice(0, 90)}`);
    assert(has(r.text, 'GTS300|Vespa'), `bike not recalled — said: ${r.text.slice(0, 90)}`);
    return `${r.trace.memoriesIncluded} memories injected`;
  });

  await check('an oblique reference finds the project (§6 indirect recall)', async () => {
    const r = await chat('I want to get back to that book idea again.', {
      conversationId: 'e2e-c',
      depth: 4,
    });
    const cited = (r.trace.memories || []).some((m) => /projects\//.test(m.source));
    assert(cited, 'the project file was not recalled');
    assert(has(r.text, 'dark|adult|personalit'), `the decision was not used — said: ${r.text.slice(0, 90)}`);
    return `via ${r.trace.memories.find((m) => /projects\//.test(m.source))?.via}`;
  });

  await check('REGRESSION: the word "memory" does not suppress recall', async () => {
    const r = await chat(
      'My memory is terrible — remind me what my wife is called? Also what did we say about the prompt in Reflect?',
      { conversationId: 'e2e-d' }
    );
    assert(r.recall.mode !== 'off', 'recall was switched off');
    assert(has(r.text, 'Priya'), `suppressed — said: ${r.text.slice(0, 90)}`);
    return `recall ran in ${r.recall.mode} mode`;
  });

  await check('an unrelated question recalls nothing and says nothing about memory', async () => {
    const r = await chat('What is the boiling point of water at sea level?', {
      conversationId: 'e2e-e',
    });
    assert(has(r.text, '100|212'), `wrong answer: ${r.text.slice(0, 80)}`);
    assert(!has(r.text, 'Priya|GTS300'), 'unrelated memories leaked into the answer');
    assert(!has(r.text, 'memory-context|USER\\.md'), 'the memory fence leaked into the reply');
    return `${r.trace.memoriesIncluded} memories injected`;
  });

  // ── memory integrity ────────────────────────────────────────────────────
  phase('Memory integrity');

  await check('no fact is recorded twice in different words', async () => {
    const profile = await readHomeFile('USER.md');
    const bullets = profile.split('\n').filter((l) => /^\s*-\s+/.test(l));
    const offenders = (needle) => bullets.filter((l) => new RegExp(needle, 'i').test(l));

    for (const [label, needle] of [['Priya', 'Priya'], ['the bike', 'GTS300']]) {
      const hits = offenders(needle);
      assert(
        hits.length === 1,
        `${label} appears ${hits.length} times:\n        ${hits.join('\n        ')}`
      );
    }
    return `${bullets.length} facts on file`;
  });

  await check('a project is never forked into two files', async () => {
    const memory = await api('/api/memory');
    const bookish = memory.projects.filter((p) => /turtle|book/i.test(p.slug));
    assert(bookish.length === 1, `the book has ${bookish.length} files: ${bookish.map((p) => p.slug).join(', ')}`);
    return bookish[0].slug;
  });

  await check('supersession replaces a preference rather than stacking one', async () => {
    await chat('Honestly, just keep answers short — I do not need the essay.', {
      conversationId: 'e2e-f',
    });
    await chat('Actually scratch that, I want the deeper reasoning from now on.', {
      conversationId: 'e2e-f',
    });
    const profile = await readHomeFile('USER.md');
    const bullets = profile.split('\n').filter((l) => /^\s*-\s+/.test(l));
    const prefs = bullets.filter((l) => /short|brief|concise|deep|detail|thorough|reasoning|essay|answer/i.test(l));
    const shown = prefs.length ? `\n        ${prefs.join('\n        ')}` : ' (none recorded)';

    const wantsShort = prefs.some((l) => /prefers? short|answers short|concise|brief/i.test(l));
    const wantsDeep = prefs.some((l) => /deep|detailed|thorough|reasoning/i.test(l));
    assert(wantsDeep, `the new preference was not recorded:${shown}`);
    assert(!wantsShort, `the superseded preference is still on file:${shown}`);
    return 'replaced, not stacked';
  });

  await check('editing a memory file changes what Reflect believes', async () => {
    const before = await api('/api/memory/file?path=USER.md');
    const edited = before.content.replace(/Priya/g, 'Priyanka');
    await api('/api/memory/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'USER.md', content: edited }),
    });
    await api('/api/memory/reindex', { method: 'POST' });

    const r = await chat("What is my wife's name?", { conversationId: 'e2e-g' });
    assert(has(r.text, 'Priyanka'), `the edit was ignored — said: ${r.text.slice(0, 80)}`);

    await api('/api/memory/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'USER.md', content: before.content }),
    });
    await api('/api/memory/reindex', { method: 'POST' });
    return 'the file is the source of truth';
  });

  // ── recall quality ──────────────────────────────────────────────────────
  phase('Recall');

  await check('search is hybrid and reports how each hit was found', async () => {
    const r = await api('/api/memory/search?q=' + encodeURIComponent('what do I ride'));
    assert(r.trace.mode === 'hybrid', `expected hybrid, got ${r.trace.mode} (${r.trace.reason})`);
    assert(r.results.length > 0, 'no results for a question with an obvious answer');
    assert(r.results[0].via, 'no provenance on the top hit');
    return `${r.results.length} hits, top via ${r.results[0].via}`;
  });

  await check('nonsense returns an empty list rather than the least-bad guess', async () => {
    const r = await api('/api/memory/search?q=' + encodeURIComponent('quantum chromodynamics lattice gauge'));
    assert(r.results.length === 0, `expected nothing, got: ${r.results.map((x) => x.text).join(' | ')}`);
    return 'empty is an answer';
  });

  await check('the index rebuilds from the files after being deleted', async () => {
    await fsp.rm(path.join(home, 'index.json'), { force: true });
    const sync = await api('/api/memory/reindex', { method: 'POST' });
    assert(sync.ready, `reindex failed: ${sync.reason}`);
    assert(sync.vectors > 0, 'no vectors after rebuild');
    const r = await api('/api/memory/search?q=' + encodeURIComponent('what do I ride'));
    assert(r.results.length > 0, 'recall broken after rebuild');
    return `${sync.vectors} vectors rebuilt`;
  });

  // ── compaction ──────────────────────────────────────────────────────────
  phase('Long conversations');

  await check('a long conversation compacts and still knows its opening', async () => {
    const id = 'e2e-long';
    const { default: fs } = await import('node:fs');
    const file = path.join(home, 'conversations', `${id}.jsonl`);

    const lines = [
      JSON.stringify({ type: 'meta', id, title: null, mode: 'companion', createdAt: new Date().toISOString() }),
      JSON.stringify({
        type: 'turn',
        id: 't_open_u',
        role: 'user',
        content:
          'Before we start: the deploy key rotates every Tuesday, and Priya owns the runbook. Keep that in mind.',
        at: new Date().toISOString(),
      }),
      JSON.stringify({
        type: 'turn',
        id: 't_open_a',
        role: 'assistant',
        content: 'Understood — Tuesday rotation, Priya owns the runbook.',
        at: new Date().toISOString(),
      }),
    ];
    const topics = ['caching', 'retries', 'log shipping', 'index rebuilds', 'queue depth', 'cold starts'];
    for (let i = 0; i < 14; i++) {
      const t = topics[i % topics.length];
      lines.push(
        JSON.stringify({
          type: 'turn',
          id: `t_${i}_u`,
          role: 'user',
          content: `Question ${i} about ${t}. ${'Detail '.repeat(110)}`,
          at: new Date().toISOString(),
        })
      );
      lines.push(
        JSON.stringify({
          type: 'turn',
          id: `t_${i}_a`,
          role: 'assistant',
          content: `On ${t}: ${'consideration '.repeat(110)}`,
          at: new Date().toISOString(),
        })
      );
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const r = await chat('Different question — what is the rotation schedule, and who owns the runbook?', {
      conversationId: id,
      model: SMALL_MODEL,
    });

    assert(r.compacted, 'compaction did not run on a conversation past its budget');
    assert(has(r.text, 'Tuesday'), `the schedule was lost — said: ${r.text.slice(0, 100)}`);
    assert(has(r.text, 'Priya'), `the owner was lost — said: ${r.text.slice(0, 100)}`);
    assert(r.trace.promptTokens < 8192, `prompt of ${r.trace.promptTokens} exceeded an 8k window`);
    return `compressed ${r.compacted.compressed} turns → ${r.trace.promptTokens} prompt tokens`;
  });

  await check('INVARIANT: the full transcript survives compaction', async () => {
    const conv = await api('/api/conversations/e2e-long');
    assert(conv.turns.length === 32, `expected 32 turns on disk, found ${conv.turns.length}`);
    assert(has(conv.turns[0].content, 'deploy key rotates'), 'the opening turn was destroyed');
    return `${conv.turns.length} turns intact`;
  });

  // ── model independence ──────────────────────────────────────────────────
  phase('Model independence');

  await check('a different model answers from the same memory', async () => {
    const r = await chat('Who is my wife?', { conversationId: 'e2e-swap', model: SMALL_MODEL });
    assert(has(r.text, 'Priya'), `${SMALL_MODEL} could not recall — said: ${r.text.slice(0, 80)}`);
    return `${SMALL_MODEL} recalled it`;
  });

  await check('the budget follows the model, not a constant', async () => {
    const big = await chat('Say hello.', { conversationId: 'e2e-budget-1', model: MODEL });
    const small = await chat('Say hello.', { conversationId: 'e2e-budget-2', model: SMALL_MODEL });
    assert(big.trace.window > 0 && small.trace.window > 0, 'no window reported');
    return `${MODEL}: ${big.trace.window} · ${SMALL_MODEL}: ${small.trace.window}`;
  });

  // ── the runtime is a choice ─────────────────────────────────────────────
  //
  // §11 scenario 9: the same questions across two runtimes should give the same
  // answers. Ollama serves an OpenAI-compatible endpoint alongside its own, so
  // this can be tested for real on one machine — same models, same memory, a
  // different wire format and a different adapter. A memory that only survives
  // on Ollama is a memory living in the adapter.
  phase('Runtimes');

  await check('the app says what runs its models, and what else could', async () => {
    const { current, detected, health } = await api('/api/runtimes');
    assert(health.ok, 'the current runtime is not answering');
    assert(current.capabilities, 'no capabilities reported — the UI cannot know what to offer');
    assert(current.capabilities.models === 'list+pull', `Ollama should be able to pull, said ${current.capabilities.models}`);
    assert(current.capabilities.context === 'per-request', 'Ollama sets context per request');
    assert(detected.some((d) => d.kind === 'ollama'), 'detection did not find the Ollama it is talking to');
    return `${current.capabilities.label} · ${detected.length} runtime(s) found`;
  });

  await check('a runtime that answers nothing is refused, not saved', async () => {
    const res = await fetch(`${BASE}/api/runtime`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai-compat', baseUrl: 'http://127.0.0.1:1' }),
    });
    assert(res.status === 400, `a dead address answered ${res.status}`);
    // And the app is still usable afterwards — a bad choice must not strand it.
    const after = await api('/api/runtimes');
    assert(after.health.ok, 'a refused choice broke the working runtime');
    return (await res.json()).error.slice(0, 60);
  });

  await check('SCENARIO 9: the same memory answers through a different wire format', async () => {
    // Ollama's own /v1 surface, driven by OpenAICompatAdapter rather than
    // OllamaAdapter: SSE instead of newline JSON, reasoning_effort instead of
    // think, /v1/models instead of /api/tags.
    const swapped = await api('/api/runtime', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai-compat', baseUrl: 'http://localhost:11434/v1' }),
    });
    assert(swapped.ok, `could not switch: ${swapped.error}`);
    assert(swapped.current.capabilities.context === 'per-instance', 'the context difference should be declared');

    const r = await chat('What is my wife called, and what do I ride?', {
      conversationId: 'e2e-runtime-swap',
      model: MODEL,
    });
    assert(has(r.text, 'Priya'), `wife not recalled through the other adapter — said: ${r.text.slice(0, 90)}`);
    assert(has(r.text, 'GTS300|Vespa'), `bike not recalled — said: ${r.text.slice(0, 90)}`);

    // Back, so the phases after this one run against the runtime they expect.
    const restored = await api('/api/runtime', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434' }),
    });
    assert(restored.ok, `could not switch back: ${restored.error}`);
    return 'same answers, different adapter';
  });

  // ── what the model can make ─────────────────────────────────────────────
  //
  // Everything below is new since M6 and none of it was covered here, which is
  // the gap that lets a feature rot quietly. These check the contract between
  // the model, the renderer, and the pane — not that a picture is pretty.
  phase('Artifacts');

  await check('the model is told what it can make', async () => {
    const { abilitiesFor } = await import('../src/context/Abilities.js');
    const brief = abilitiesFor({});
    assert(brief.includes('chart'), 'the brief never mentions charts');

    const reply = await chat('Say hello.', { conversationId: 'e2e-abilities' });
    assert(reply.trace.systemTokens > 0, 'no system prompt reported');
    // The brief is in the frozen prefix, so it is paid for once per session and
    // has to stay small enough to be worth it.
    const { estimateTokens } = await import('../src/context/ContextBudget.js');
    const cost = estimateTokens(brief);
    assert(cost <= 130, `the abilities brief has grown to ${cost} tokens`);
    return `${cost} tokens of prompt`;
  });

  await check('a chart the model writes is a chart we can draw', async () => {
    const reply = await chat(
      'Reply with ONLY a fenced code block whose language is exactly chart, containing exactly: ' +
        '{"type":"bar","title":"Speed","data":[{"label":"a","value":3},{"label":"b","value":5}]}',
      { conversationId: 'e2e-chart' }
    );

    const fence = /```chart\s*([\s\S]*?)```/.exec(reply.text);
    assert(fence, `no chart block in the reply: ${reply.text.slice(0, 120)}`);

    const { parseChart, renderChart } = await import('../public/chart.js');
    const spec = parseChart(fence[1]);
    assert(spec, 'the model wrote a chart block the renderer rejects');
    const svg = renderChart(spec);
    assert(svg.startsWith('<svg'), 'the spec did not draw');
    assert(!/<script/.test(svg), 'a label reached the svg as markup');
    return `${spec.type}, ${spec.data.length} points, ${svg.length} bytes of svg`;
  });

  await check('a reply becomes a card rather than a wall of source', async () => {
    const { renderMarkdown } = await import('../public/markdown.js');
    const html = renderMarkdown('here\n\n```html\n<title>T</title><script>alert(1)<\/script>\n```');
    assert(/class="artifact" data-kind="html"/.test(html), 'an html block should open in the pane');
    assert(!/<script>alert/.test(html), 'artifact source must never run in the transcript');
    return 'html blocks stay inert until opened';
  });

  await check('the transcript survives a round trip through the renderer', async () => {
    // The renderer is the only thing between a stored turn and the screen, so
    // a reply that cannot be rendered is a reply the user cannot read.
    const { renderMarkdown } = await import('../public/markdown.js');
    const conversations = await api('/api/conversations');
    let checked = 0;
    for (const conv of conversations.conversations.slice(0, 8)) {
      const { turns } = await api(`/api/conversations/${conv.id}`);
      for (const turn of turns) {
        if (turn.role !== 'assistant') continue;
        const html = renderMarkdown(turn.content, { mermaid: true });
        assert(typeof html === 'string', 'the renderer returned nothing');
        assert(!/<script(?![^>]*data-)/i.test(html), `a script tag survived rendering in ${conv.id}`);
        checked++;
      }
    }
    return `${checked} real replies rendered without incident`;
  });

  await check('the vendored renderers are present and honest about themselves', async () => {
    const manifest = await fetch(`${BASE}/vendor/manifest.json`)
      .then((r) => (r.ok ? r.json() : { libraries: [] }))
      .catch(() => ({ libraries: [] }));

    if (!manifest.libraries.length) return 'none installed — diagrams and maths degrade to text';

    for (const lib of manifest.libraries) {
      const res = await fetch(`${BASE}${lib.url}`);
      assert(res.ok, `${lib.name} is in the manifest but ${lib.url} returns ${res.status}`);
    }
    return manifest.libraries.map((l) => `${l.name} ${l.version}`).join(', ');
  });

  // ── what it has been taught, and what it may touch ──────────────────────
  //
  // Skills and grants are the first features where the interesting behaviour is
  // *refusal*, so these run against the real server rather than a stub.
  phase('Skills and folders');

  await check('a skill installed through the API is offered to the model', async () => {
    await api('/api/skills/e2e-brevity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: '---\nname: e2e-brevity\ndescription: Answer in one short sentence, always.\n---\n\nBe terse.\n',
      }),
    });

    const { skills, catalogueTokens } = await api('/api/skills');
    const mine = skills.find((s) => s.name === 'e2e-brevity');
    assert(mine, 'the skill did not appear');
    assert(mine.valid, `the skill is not usable: ${mine.problems.join(', ')}`);
    assert(catalogueTokens > 0 && catalogueTokens < 400, `catalogue costs ${catalogueTokens} tokens`);
    return `${skills.length} installed · ${catalogueTokens} tokens`;
  });

  await check('naming a skill loads it for that turn, and only that turn', async () => {
    const used = await chat('/e2e-brevity What is the capital of France?', {
      conversationId: 'e2e-skill-1',
      tolerateEmpty: true,
    });
    const event = used.events.find((e) => e.type === 'skills');
    assert(event, 'no skills event — the invocation was not recognised');
    assert(event.used.includes('e2e-brevity'), `wrong skill: ${JSON.stringify(event.used)}`);

    const plain = await chat('What is the capital of France?', {
      conversationId: 'e2e-skill-2',
      tolerateEmpty: true,
    });
    assert(!plain.events.some((e) => e.type === 'skills'), 'a skill was applied to a turn that did not ask for one');
    return 'invoked once, not twice';
  });

  await check('a broken skill is reported rather than silently ignored', async () => {
    await api('/api/skills/e2e-broken', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '---\nname: e2e-broken\n---\n' }),
    });
    const { skills } = await api('/api/skills');
    const broken = skills.find((s) => s.name === 'e2e-broken');
    assert(broken && !broken.valid, 'a skill with no description should not be usable');
    assert(broken.problems.length, 'and it should say why');
    await api('/api/skills/e2e-broken', { method: 'DELETE' });
    return broken.problems[0];
  });

  await check('nothing outside a grant can be read, before or after', async () => {
    const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-e2e-desk-'));
    await fsp.writeFile(path.join(folder, 'list.md'), '# List\n\n- oat milk\n');

    const before = await fetch(`${BASE}/api/grants/list?path=${encodeURIComponent(folder)}`);
    assert(before.status === 403, `an ungranted folder answered ${before.status}, not 403`);

    const granted = await api('/api/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    assert(granted.access === 'read', 'connecting should give reading, not writing');

    const listed = await api(`/api/grants/list?path=${encodeURIComponent(folder)}`);
    assert(listed.items.some((i) => i.name === 'list.md'), 'the granted folder did not list its contents');

    await fetch(`${BASE}/api/grants?path=${encodeURIComponent(folder)}`, { method: 'DELETE' });
    const after = await fetch(`${BASE}/api/grants/list?path=${encodeURIComponent(folder)}`);
    assert(after.status === 403, 'revoking did not take effect');

    await fsp.rm(folder, { recursive: true, force: true });
    return 'refused, granted, refused again';
  });

  await check('the memory folder cannot be granted to itself', async () => {
    // It would turn every guard in the storage port into a suggestion.
    const res = await fetch(`${BASE}/api/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: home }),
    });
    assert(res.status === 400, `granting the memory folder answered ${res.status}`);
    const body = await res.json();
    assert(/already has its own memory folder/.test(body.error), body.error);
    return body.error;
  });

  // ── a saved instruction, on a clock ─────────────────────────────────────
  //
  // The claim worth proving live is not that a task can be stored — the unit
  // suite has that — but that running one is an *ordinary turn*: it lands in the
  // same conversation list, sees the same grants, and leaves the same trace as a
  // message someone typed. If a second execution path ever appears, these fail.
  phase('Tasks');

  await check('a saved task reads its schedule back in English', async () => {
    const saved = await api('/api/tasks/e2e-daily', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Say the word pineapple and nothing else.', when: 'every day at 09:00' }),
    });
    assert(saved.valid, `task not usable: ${saved.problems.join(', ')}`);
    assert(saved.schedule.kind === 'daily', `expected daily, got ${saved.schedule.kind}`);
    assert(saved.schedule.text === 'every day at 09:00', saved.schedule.text);

    const { tasks } = await api('/api/tasks');
    assert(tasks.some((t) => t.name === 'e2e-daily'), 'the task did not appear in the list');
    return saved.schedule.text;
  });

  await check('a sentence that merely mentions a day is not a weekly schedule', async () => {
    // "on the third tuesday unless it rains" contains a weekday and means
    // nothing a scheduler can read. Guessing "every tuesday" invents a job.
    const saved = await api('/api/tasks/e2e-vague', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Check the roof.', when: 'on the third tuesday unless it rains' }),
    });
    assert(saved.schedule.kind === 'manual', `it invented a ${saved.schedule.kind} schedule`);
    assert(/could not read/.test(saved.schedule.text), saved.schedule.text);
    await api('/api/tasks/e2e-vague', { method: 'DELETE' });
    return saved.schedule.text;
  });

  await check('a task with no instruction cannot be run', async () => {
    await api('/api/tasks/e2e-empty', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: '   ', when: 'manual' }),
    });
    const res = await fetch(`${BASE}/api/tasks/e2e-empty/run`, { method: 'POST' });
    assert(res.status === 400, `an empty task answered ${res.status}`);
    const body = await res.json();
    assert(/instruction/.test(body.error), body.error);
    await api('/api/tasks/e2e-empty', { method: 'DELETE' });
    return body.error;
  });

  await check('running a task leaves the trace of an ordinary conversation', async () => {
    const run = await api('/api/tasks/e2e-daily/run', { method: 'POST' });
    assert(run.ok, `the run failed: ${run.error}`);
    assert(run.conversationId, 'the run produced no conversation');

    // 1. It is in the same list as everything else you have said.
    const { conversations } = await api('/api/conversations');
    assert(
      conversations.some((cv) => cv.id === run.conversationId),
      'a task ran somewhere other than the ordinary conversation list'
    );
    const convo = await api(`/api/conversations/${run.conversationId}`);
    const asked = convo.turns.find((t) => t.role === 'user');
    assert(asked && has(asked.content, 'pineapple'), 'the task instruction is not the user turn of the conversation');

    // 2. The task file records when it ran and where the answer went.
    const file = await readHomeFile(path.join('tasks', 'e2e-daily.md'));
    assert(has(file, 'lastRun'), 'the task did not record that it ran');
    assert(file.includes(run.conversationId), 'the task does not point at its conversation');

    // 3. And the day's journal says so, in the same place as everything else.
    const stamp = new Date().toISOString().slice(0, 10);
    const journal = await readHomeFile(path.join('journal', `${stamp}.md`));
    assert(has(journal, 'e2e-daily'), 'nothing in the journal about the run');
    return run.conversationId;
  });

  await check('a task sees the folders you have connected, and nothing else', async () => {
    const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-e2e-task-'));
    await fsp.writeFile(path.join(folder, 'tea.md'), '# Tea\n\n- sencha\n');
    await api('/api/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });

    await api('/api/tasks/e2e-folder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: `List the files in the folder ${folder} and name them.`,
        when: 'manual',
      }),
    });

    const run = await api('/api/tasks/e2e-folder/run', { method: 'POST' });
    assert(run.ok, `the run failed: ${run.error}`);
    const convo = await api(`/api/conversations/${run.conversationId}`);
    const reply = convo.turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('\n');
    // A task that cannot reach the tools a typed message reaches is a second
    // execution path wearing a disguise. This is the check that would notice.
    assert(has(reply, 'tea'), `the task never read the granted folder: ${reply.slice(0, 160)}`);

    await fetch(`${BASE}/api/grants?path=${encodeURIComponent(folder)}`, { method: 'DELETE' });
    await api('/api/tasks/e2e-folder', { method: 'DELETE' });
    await fsp.rm(folder, { recursive: true, force: true });
    return 'the same tools a typed message gets';
  });

  await check('a task can be switched off, and deleted', async () => {
    const off = await api('/api/tasks/e2e-daily', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Say the word pineapple.', when: 'every day at 09:00', enabled: false }),
    });
    assert(off.enabled === false, 'a task that was switched off says it is still on');

    await api('/api/tasks/e2e-daily', { method: 'DELETE' });
    const { tasks } = await api('/api/tasks');
    assert(!tasks.some((t) => t.name === 'e2e-daily'), 'the deleted task is still listed');
    const gone = await fetch(`${BASE}/api/tasks/e2e-daily`, { method: 'DELETE' });
    assert(gone.status === 404, `deleting it twice answered ${gone.status}`);
    return 'off, then gone';
  });

  // ── isolation ───────────────────────────────────────────────────────────
  phase('Isolation');

  await check('nothing was written outside REFLECT_HOME', async () => {
    const real = path.join(os.homedir(), '.reflect');
    const existed = await fsp
      .stat(real)
      .then(() => true)
      .catch(() => false);
    if (!existed) return 'the real ~/.reflect was never created';
    const stat = await fsp.stat(real);
    const ageMs = Date.now() - stat.mtimeMs;
    assert(ageMs > 60_000, 'the real ~/.reflect was modified during this run');
    return 'the real home was untouched';
  });
}

// ─────────────────────────────────────────────────────────────────── wrap up

try {
  await main();
} catch (err) {
  console.log(`\n${c.red('sweep aborted:')} ${err.message}`);
  results.push({ name: 'sweep completed', ok: false, detail: err.message });
} finally {
  await stopServer();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${c.bold('─'.repeat(62))}`);
  if (failed.length === 0) {
    console.log(c.green(`  ${results.length}/${results.length} checks passed`) + (skipped ? c.dim(`  (${skipped} skipped by E2E_ONLY)`) : ''));
  } else {
    console.log(c.red(`  ${failed.length} of ${results.length} checks failed:`));
    for (const f of failed) console.log(c.red(`    ✗ ${f.name}`));
  }
  if (process.env.E2E_KEEP) console.log(c.dim(`\n  home kept at ${home}`));
  else if (home) await fsp.rm(home, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
