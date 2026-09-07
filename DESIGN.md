# Reflect 2.0 — Design Document

**Status:** Proposed
**Date:** 2026-08-12
**Supersedes:** Reflect 1.0, retained privately as a frozen reference
**Author:** Design pass against the Reflect 1.0 North Star

---

## 0. Why a 2.0 and not a refactor

Reflect 1.0 proved the product thesis and produced three things worth keeping: a working
Ollama adapter, an unusually good retrieval-telemetry contract, and a centralized
`buildPrompt`. It also accumulated, across several agent-written phases, a structure that
actively fights the North Star:

- **17 services and a 6,655-line `server.js`**, with the entire chat pipeline inline in a
  ~2,300-line route handler.
- **Nine components whose job is to decide whether to remember**, several of which resolve
  to "don't." The word *"memory"* in a user message routes to project buckets, which
  outside a project session returns `search: false` — so *"I've been thinking about the
  Reflect memory architecture again"* retrieves nothing.
- **Prompt modes that delete context on purpose**, logging
  `[FAIL-CLOSED] MINIMAL mode: DROPPING working state`.
- **Opaque storage**: memory lives in `embeddings.json` as rows of 384 floats. A user
  cannot read it, cannot correct it, and a bad write corrupts the store — hence
  `repairEmbeddingsStore`, mock-embedding rejection guards, and a shape war between
  `ConversationSummary` and `compaction` that silently destroys summaries.
- **Three competing persona systems** (`personas.json`, `prompts.system.*_mode`,
  `modelProfile`) and no context budget of any kind.

None of that is fixable by moving files around. The substrate is wrong, and the control
flow is built on the assumption that context is a risk to be gated rather than a signal to
be ranked. 2.0 changes exactly two things at the root — **what memory is stored in**, and
**who decides what's relevant** — and most of the accidental complexity disappears as a
consequence.

**The 2.0 bet, in one line:**

> Memory is Markdown the user can read and edit. The index is a disposable cache.
> Recall always ranks and never gates.

---

## 1. The promise this design serves

From the North Star (§3): *the more you use it, the more useful and familiar it becomes.*

The hundredth conversation should not feel like the first. That requires four capabilities,
and every design decision below traces to one of them:

| Capability | North Star | Mechanism in 2.0 |
|---|---|---|
| It knows who I am | §5, §9 | `USER.md`, frozen into the system prompt each session |
| It remembers what we discussed | §4, §6 | `conversations/*.jsonl` + `summaries/*.md` + journal |
| It connects today to before | §6, §10 | Hybrid recall (vector + BM25) with temporal decay and MMR |
| It gets my tone right | §20 | One `SOUL.md` with mode blocks — no competing persona systems |

---

## 2. Substrate: files first, index second

Everything the user's assistant knows lives in human-readable files under `REFLECT_HOME`
(default `~/.reflect`, overridable — which is also how tests get an isolated store by
construction rather than by discipline).

```
~/.reflect/
├── SOUL.md                   # Identity + interaction modes. Editable. Reloaded per session.
├── USER.md                   # Curated profile: name, relationships, preferences, style
├── projects/
│   ├── reflectforge.md       # One file per persistent topic
│   └── turtles-book.md
├── journal/
│   └── 2026-08-12.md         # Append-only daily log. Today + yesterday always in context.
├── conversations/
│   └── <id>.jsonl            # Raw turns. Append-only. Never rewritten.
├── summaries/
│   └── <id>.md               # Rolling summary per conversation
├── index.sqlite              # DERIVED. Deletable. Rebuilt from everything above.
└── config.json               # Settings, model prefs, budgets
```

### Why this is the load-bearing decision

1. **Corruption stops being data loss.** If `index.sqlite` is bad, delete it; it rebuilds
   from the Markdown. In 1.0, a bad write to `embeddings.json` loses memories permanently.
2. **The user can audit and correct.** North Star §13 asks for observable memory. The
   strongest form of observability is a file you can open in any editor and fix.
3. **Memory becomes portable.** Back it up with `git`, sync it with anything, read it on a
   phone. A JSON array of float vectors is portable to nothing.
4. **Debugging collapses.** "Why did it say that?" is answered by reading two files, not by
   decoding a scoring trace.

### File formats

**`USER.md`** — curated, evergreen, never decayed:

```markdown
# User

## Identity
- Name: Sam
- Location: ...

## Relationships
- Wife: Priya

## Preferences
- Wants direct technical answers; lately prefers deeper analysis over short ones
  (updated 2026-08-01, supersedes earlier "keep it short")

## Working style
- Local-first by conviction, not convenience
```

Supersession is expressed the way a person would write it — newer line, explicit note,
older line removed by the Reflector. No `confidence` floats, no `last_confirmed`
timestamps, no 90-day decay arithmetic. If a fact is in `USER.md`, it is current.

**`projects/<slug>.md`** — one per persistent topic, with frontmatter for linking:

```markdown
---
name: ReflectForge
aliases: [forge, the agent framework]
status: active
last_touched: 2026-08-10
---

## What it is
Local agent framework. Ollama is the inference backend.

## Decisions
- 2026-07-14 — Forge delegates orchestration to agents rather than owning it.

## Open
- Whether the plugin API ships in v1
```

The `aliases` field is what makes §6 indirect recall work: *"my agent framework"* resolves
to `reflectforge.md` by alias match, before embeddings are consulted at all.

**`journal/YYYY-MM-DD.md`** — append-only running context. This replaces 1.0's
`working_state.json` + `threads.json` + `StateUpdater` + `conversationStateMachine`
entirely. It is the same idea (what matters right now, decays naturally) on a substrate you
can read, and today+yesterday are always in context, so §11 working memory finally reaches
the model instead of being gated behind `PROJECT_ACTIVE` and then dropped by MINIMAL mode.

**`index.sqlite`** — chunks, embeddings, FTS5. Stamped with a **fingerprint**:
`{embedProvider, embedModel, dimensions, chunkSize, chunkOverlap}`. If any of those change,
the index self-resets and reindexes. This closes a real 1.0 bug: compaction embeds with a
hardcoded `nomic-embed-text` while the main path uses `defaultEmbedModel`, and
`cosineSimilarity` returns `-1` on dimension mismatch — silently making every compaction
summary unretrievable with no error anywhere.

---

## 3. Module map

Eight modules. Target: under 3,000 lines of backend, down from 12,477.

```
reflect/
├── store/
│   ├── FileStore.js          # atomic read/write, locking, REFLECT_HOME resolution
│   ├── ConversationStore.js  # jsonl append, load, list, branch
│   └── MemoryFiles.js        # USER.md / projects / journal read+write, § entry parsing
│
├── recall/
│   ├── Indexer.js            # chunk, embed, FTS; fingerprint; incremental sync
│   └── Recall.js             # hybrid search → ranked candidates. NEVER returns a gate.
│
├── context/
│   ├── ContextBudget.js      # model context length → per-section token allocation
│   └── PromptAssembler.js    # sections → messages[]; stable prefix
│
├── reflect/
│   └── Reflector.js          # post-turn: extract facts, update files, roll summary
│
├── inference/
│   └── OllamaAdapter.js      # ported from 1.0 ollamaClient.js
│
├── modes/
│   └── Soul.js               # SOUL.md load + mode block selection
│
└── api/
    ├── ChatController.js     # the pipeline, ~200 lines
    └── routes/               # conversations, settings, models, memory, debug
```

**Deleted relative to 1.0**, with the reason:

| Removed | Why |
|---|---|
| `MemoryRouter` | Regex fact classification replaced by the Reflector's model call |
| `RetrievalRouter` | Retrieval is never gated, so there is nothing to route |
| `RetrievalDecisionService` | Same |
| `intentBucketMap` | Same; it is also the source of the "memory" → suppression bug |
| `bucketTaxonomy` | Buckets were a workaround for having no ranking |
| `conversationStateMachine` | `PROJECT_ACTIVE` existed to gate context; nothing is gated |
| `WorkingMemory` + `ThreadManager` + `StateUpdater` | Replaced by the daily journal file |
| `computePromptMode` / `determinePromptMode` | Three modes replaced by one budget |
| `MemoryNodeService` | Merged into `MemoryFiles` |
| `ProjectScopeService` | Merged into `Recall` as a scoring signal, not a filter |
| `GraphRuntimeService` / `CheckpointService` | Demoted to a debug sink behind a flag |
| Python `MODEL_SERVICE_URL` paths, `chromadb/`, `patterns.json` | Vestigial |
| `personas.json` + `prompts.system.*_mode` + `modelProfile` modes | One `SOUL.md` |
| Every `FAIL-CLOSED ... DROPPING` branch | They implement the opposite of the product |

That is 17 services → 8 modules, and nine "should we remember?" components → one ranker.

---

## 4. Request lifecycle

```
POST /api/chat
  │
  ├─ 1. ConversationStore.append(user turn)          # durable before anything can fail
  ├─ 2. Recall.search(message, recentTurns)          # → ranked candidates (may be empty)
  ├─ 3. ContextBudget.plan(model)                    # → token allocation per section
  ├─ 4. PromptAssembler.build(...)                   # → messages[]
  ├─ 5. OllamaAdapter.stream()                       # → SSE to client
  ├─ 6. ConversationStore.append(assistant turn)
  └─ 7. Reflector.observe(turn)                      # async: files, summary, index
```

Seven steps, each testable in isolation. Compare to 1.0, where steps 1–7 plus routing,
classification, embedding, dedup, pruning, filtering, sorting, capping, and telemetry live
in one function.

### Step 2 — Recall never gates

```js
// Recall.search returns a ranked list. Empty is an honest answer.
// There is no `search: false`, no buckets, no "Suppressed: Chat Mode".

score = 0.70 * vectorSimilarity      // semantic — "the machine running the gateway"
      + 0.30 * bm25Score             // exact tokens — "Vespa GTS300", "ReflectForge"

score *= temporalDecay(ageDays)      // e^(-ln2 * age / halfLife), halfLife = 30d
                                     // EXEMPT: USER.md, projects/*.md (evergreen)

score *= 1.15  if aliasMatch         // "my agent framework" → reflectforge.md
score *= 1.10  if sameProject        // scoped conversations rank up, are not filtered

candidates = mmr(candidates, lambda = 0.7)   // diversity: drop near-duplicates
return candidates.filter(c => c.score >= threshold).slice(0, budget.memorySlots)
```

BM25 is the half 1.0 is missing entirely, and for a personal assistant it matters more than
the embedding half — proper nouns, project names, model numbers, and people's names are
exactly where pure vector search is weakest and exactly what a personal assistant is asked
about. MMR and evergreen-exempt temporal decay are lifted from OpenClaw's memory design;
both are well-specified there and both address failure modes 1.0 has today (near-duplicate
memories crowding the window; a well-worded old note outranking last week's correction).

**Alias resolution runs before embeddings.** This is what makes *"I want to work on the
book project again"* find `turtles-book.md` deterministically rather than hoping cosine
similarity gets there.

### Step 3 — A real context budget

1.0 has fixed constants: 8 recent turns, 5 memories, 1,000 memory tokens, regardless of
whether the model has a 4k or 128k window. §16/§17 ask for the opposite.

```js
ContextBudget.plan(model) {
  const total = model.contextLength;               // from Ollama /api/show
  const reserve = Math.min(2048, total * 0.15);    // room for the response
  const usable = total - reserve;

  return {
    system:        usable * 0.15,   // SOUL + USER.md + today's journal  (frozen prefix)
    summary:       usable * 0.15,   // rolling conversation summary
    memories:      usable * 0.25,   // recalled candidates
    recentTurns:   usable * 0.45,   // the actual conversation
  };
}
```

Percentages are defaults, not law — they move with `interactionMode` (Builder allocates
more to memories and project files; Companion more to recent turns). The key property is
that **an 8k model and a 128k model both get a full, proportional context**, which is the
"make small models feel strong" mechanism from §15 stated as arithmetic.

### Step 4 — Prompt shape, and the frozen prefix

```
┌─ SYSTEM  (stable for the whole session — never changes between turns) ─┐
│  SOUL.md identity                                                       │
│  Active interaction mode block                                          │
│  USER.md snapshot                                                       │
│  Today's + yesterday's journal                                          │
└─────────────────────────────────────────────────────────────────────────┘
┌─ CONVERSATION ──────────────────────────────────────────────────────────┐
│  Rolling summary (if the conversation has been compacted)               │
│  Recent turns, verbatim                                                  │
└─────────────────────────────────────────────────────────────────────────┘
┌─ CURRENT TURN ──────────────────────────────────────────────────────────┐
│  <memory-context>                                                       │
│    Recalled, ranked, fenced as reference data — not user input          │
│  </memory-context>                                                      │
│  User message                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

Two deliberate choices here, both borrowed:

**The system block is a frozen snapshot** (Hermes' pattern). `USER.md` and `SOUL.md` are
read once at session start and do not change mid-session; writes during the session land on
disk immediately and appear on the next session. This keeps the prompt prefix byte-stable,
so the model's KV cache holds across every turn of the conversation. For a local model on a
16GB machine that is a large, free latency win. Reflect 1.0 re-ranks and re-injects memories
into the system region on every single turn and forfeits it entirely.

**Recalled memory is fenced** in `<memory-context>` tags in the *user* region, explicitly
labeled as reference data. A streaming scrubber strips the tags across chunk boundaries so
they cannot leak into the visible reply. This replaces 1.0's `detectPromptLeak` /
`stripPromptLeakChunk`, which pattern-match for `## USER MEMORIES` in the *output* — the
reactive version of the same idea. Fencing also gives a clean prompt-injection boundary for
imported ChatGPT history and workspace files, which are untrusted content.

The prompt is a `messages[]` array, not a single concatenated string. 1.0 flattens
everything into one system string, which discards the role structure every instruct-tuned
model was trained on.

### Step 7 — The Reflector (the piece 1.0 never built)

North Star §33 describes post-turn intelligence. 1.0 approximates it with a 160-line regex
classifier that decides *"My wife's name is Priya"* is durable because it starts with
`my `.

2.0 makes one cheap, structured call **after the response has already streamed** — so the
user never waits on it:

```js
// Input: the turn + current USER.md + open projects
// Output: structured, validated
{
  facts:        [{ text, section }],           // → USER.md
  preferences:  [{ text, supersedes }],        // → USER.md, replacing the old line
  projects:     [{ slug, note, kind }],        // → projects/<slug>.md
  journal:      [string],                      // → journal/YYYY-MM-DD.md
  corrections:  [{ target, replacement }],     // → rewrite the wrong line
  nothing:      boolean                        // the common, cheap case
}
```

Rules:

- **Explicit save always wins.** "Remember this" bypasses the model call and writes
  directly. (1.0 gets this genuinely right, including the `embed_pending` fallback when
  embeddings are down — port that behavior verbatim.)
- **Never delete, only supersede.** Corrections rewrite the line in `USER.md` and append
  the prior value to the journal with a date. Nothing is unrecoverable.
- **Nothing is the default.** "I'm hungry" produces `nothing: true` and costs one small
  call. §12's memory-hoarding failure is avoided by a model that understands durability,
  not by a regex that guesses.

The Reflector also rolls the conversation summary and queues index updates. One component
owns the entire write path — compare 1.0, where memory writes happen in the chat route, in
`MemoryNodeService`, in the explicit-save short-circuit, in the pending-save fallback, and
in `compaction`, with two of those writing incompatible shapes to the same file.

### Memory tools — the second recall path

Ambient recall handles the common case. For direct questions (§6), the model also gets
tools, as both Hermes and OpenClaw do:

- `memory_search(query)` — semantic + keyword over memory files
- `memory_get(path)` — read a specific file or section
- `memory_write(action, target, content)` — explicit add/replace/remove

This makes *"what did we decide about the UI?"* reliable rather than dependent on retrieval
luck, and it gives the user a way to say "look that up again" that actually does something.

---

## 5. Compaction and the pre-compaction flush

When a conversation approaches the context limit:

1. **Memory flush first** (OpenClaw's pattern). A silent turn: *"This session is nearing
   compaction. Write anything durable to memory now. Reply NO_REPLY if nothing."* The model
   decides what mattered **while it still has the full context in front of it.** This is
   strictly better than summarizing after the fact.
2. **Then compact.** Protect the first N and last M turns verbatim; summarize the middle
   into `summaries/<id>.md`.
3. **Index the summary** so it is reachable from other conversations.

Thresholds come from `ContextBudget`, i.e. from the actual model's window, and recalculate
on model switch — Hermes' `ContextEngine.update_model` behavior. 1.0 uses a fixed 8,000-token
threshold regardless of model.

---

## 6. Interaction modes: one system

`SOUL.md`, editable by the user, reloaded each session:

```markdown
# Reflect

You are Reflect, Sam's local-first assistant. You remember him across conversations
and use what you know naturally, without announcing it.

## Companion
Warm, grounded, conversational. Continuity without clinical framing.
One useful follow-up, not an interrogation.

## Builder
Direct, precise, implementation-minded. Concrete steps, tradeoffs, verification.
Challenge weak assumptions briefly when correctness is at risk.
```

One file. One system. The user can edit their assistant's personality in a text editor,
which is both a feature and the end of the three-persona-system problem.

---

## 7. Observability

Keep 1.0's best asset — the retrieval trace — and make it cheaper to reason about:

```
Recalled 3 memories                                          ▾

  USER.md · Relationships                        0.91  ✓ injected
  "Wife: Priya"

  projects/turtles-book.md · Decisions           0.78  ✓ injected
  "Darker reinterpretation, keep original personalities"

  journal/2026-08-04.md                          0.34  ✗ below threshold
```

Every row links to the file and line. Clicking opens it. Editing it changes what Reflect
believes. That is the strongest possible version of §13 and §27, and it is only possible
because memory is files.

Also retained: per-turn telemetry (`prompt_tokens`, `ttft`, `tok/s`), a
`/api/debug/prompt-preview` endpoint showing the exact assembled `messages[]`, and the
store-path audit. Not retained: the always-on full-prompt logging at info level and the
`if (... || true)` debug branch.

---

## 8. Traceability to the North Star

| § | Requirement | How 2.0 satisfies it |
|---|---|---|
| 4.1 | Immediate conversational context | Recent turns get the largest budget share |
| 4.2 | Conversation memory | `conversations/*.jsonl` + `summaries/*.md` |
| 5 | Global memory across chats | Memory files are global; conversations are local |
| 6 | Direct recall | Memory tools + `USER.md` frozen in the system prompt |
| 6 | Indirect recall | Alias resolution + hybrid recall, with **no suppression gates** |
| 7 | Embeddings are a tool, not the architecture | Files are truth; `index.sqlite` is a cache |
| 8 | Hybrid relevance | vector + BM25 + decay + alias + project + MMR |
| 9 | User model | `USER.md` — a real, readable, editable profile |
| 10 | Projects | `projects/*.md` with aliases and status |
| 11 | Working memory | Daily journal, always in context, decays naturally |
| 12 | Automatic capture | Reflector, with explicit save as an always-wins override |
| 13 | Observable memory | Trace rows link to files the user can open and edit |
| 14 | Model-agnostic | `OllamaAdapter` behind one interface; memory never model-specific |
| 15 | Small models feel strong | Proportional budget fills whatever window exists |
| 16 | Deliberate prompt assembly | `PromptAssembler` with budgeted sections and a frozen prefix |
| 17 | Hardware awareness | Budget derives from the model's real context length |
| 18 | Local-first | Files on disk, local embeddings, no service required |
| 19 | Conversations independent, memory shared | Exactly the file layout |
| 20 | One interaction-mode system | `SOUL.md` |
| 21 | Natural responses | Memory fenced as reference data; SOUL instructs against announcing it |
| 29 | Don't overengineer the UX | Eight modules; the user sees a text box |
| 36 | No hard-coded short circuits | Every gate deleted; ranking decides |

---

## 9. Migration from 1.0

The 1.0 data stores are currently empty (`embeddings.json` is `[]`, `conversations.json`
has no conversations), so there is nothing to migrate today. The importer still gets built,
because it doubles as the ChatGPT-export path:

```
scripts/import-v1.js  →  embeddings.json  → USER.md / projects/*.md (grouped, deduped)
                      →  conversations.json → conversations/*.jsonl
                      →  summaries.json     → summaries/*.md
```

Ported from 1.0 rather than rewritten: `ollamaClient.js`, `chatgpt_import_service.js`,
`modelFamilyMapping.js`, the frontend (largely intact — it consumes SSE and telemetry that
2.0 keeps compatible), and the explicit-save semantics.

---

## 10. Build order

Each milestone ends with something runnable. Nothing is built ahead of the milestone that
needs it.

**M1 — Talking skeleton** · done, `ae5e850`
`FileStore`, `ConversationStore`, `OllamaAdapter`, `Soul`, `PromptAssembler` with a fixed
budget, `ChatController`. No recall yet.
*Done:* a multi-turn conversation that persists across restart.

**M2 — Memory files** · done, `9c2ccd2`
`MemoryFiles`, `USER.md` / journal / projects, explicit-save, memory tools, `Reflector`
without the model call.
*Done:* "Remember this: my wife is Priya" writes to `USER.md`, and a new conversation in a
fresh process answers "what's my wife's name?"

**M3 — Recall** · done, `a364fb8`
`Indexer` with fingerprinting, `Recall` with vector + BM25 + decay + MMR + aliases, the
trace UI.
*Done:* the §2 Vespa Turtles scenario — *"I want to work on that book idea again"* surfaces
the project file, unprompted.

**M4 — The Reflector's model call** · done, `4226b06`
Automatic extraction, supersession, corrections.
*Done:* a week without typing "remember this", and it still knows your things.

**M5 — Budget and compaction** · done, `dee092f`
`ContextBudget` from real model metadata, memory flush, compaction, model-switch recalc.
*Done:* a 40k-token conversation still knows its opening, on an 8k model.

**M6 — The app around the engine** · done, `5a1f3ac`…`d411251`
Import, history search, timeline, CLI, packaging. Then the things that turned out to be part
of the same job: a thinking dial, one honest context window, the storage and inference ports,
markdown replies, and a mobile layout.
*Done:* it is usable by someone who is not the person who wrote it.

**M7 — What the model can make** · done, `fb5617b`…`f8b4af2`
Artifacts open beside the conversation rather than inside it: charts, pages, diagrams, maths,
and an editor to fix what the model wrote. Third-party renderers sandboxed, vendored, and
kept current by `npm outdated` rather than by memory.
*Done:* a chart the model writes is a chart the pane draws, and nothing it writes can run in
the transcript.

**M8 — Taught, connected, and on a clock** · done, `56699ec`…`a5748ef`
Skills in the open Agent Skills format with `/` invocation; connected folders as the first
thing Reflect may touch outside its own memory; folder tools offered by grant; panels for
each; and tasks — one saved instruction, optionally scheduled, run through the ordinary chat
endpoint.
*Done:* 330 unit tests and a 40/40 live sweep.

---

**M9 — Runtimes (next)**

Reflect assumes Ollama is installed. That is fair for a developer running `npm start` and
wrong for an application someone downloads. M9 makes the runtime a choice.

This is adapters and a picker, not a rewrite: the inference port already exists, and outside
the adapter there are exactly three functional coupling points — `OllamaAdapter` itself,
`Thinking.js` (written in Ollama's `think` vocabulary), and one error string in
`Embeddings.js`. Everywhere else, `ollama` is just what the variable is called.

- **`capabilities()` on the port.** Adapters declare what they support — `models:
  list | list+pull`, `context: per-request | per-instance`, `thinking: levels | boolean |
  none`, `embeddings` — and the interface reflects the answer. A backend that cannot pull
  models does not show a pull button. Without this, features silently collapse to the
  intersection of every backend, or `ChatController` grows a provider switch and the port
  stops being a port.
- **`OpenAICompatAdapter`.** One implementation of `/v1/chat/completions` and `/v1/models`,
  shared by everything that speaks it — which is nearly everything.
- **Three providers:** the built-in llama.cpp, a detected Ollama, and any OpenAI-compatible
  endpoint (base URL + key). The third is how someone points Reflect at a stronger machine in
  the next room, and how anything we have not named still works.
- **Model pull from Hugging Face, with progress.** `POST /models` + `GET /models/sse` on
  llama.cpp; `/api/pull` on Ollama.
- **Chat and embeddings are separate choices,** because a runtime that answers well may not
  embed at all, and recall should not quietly degrade because of a decision made about chat.

*Done when:* a machine with nothing installed downloads a model and holds a conversation, and
a machine that already has Ollama uses what is there.

**M10 — Desktop**
Electron shell around the existing server, bundled llama.cpp, tray, launch-at-login.
*Done when:* a scheduled task runs at nine because the app is running, not because a terminal
happened to be open.

**M11 — Composer**
Attachments, speech-to-text, a collapsible rail, import/export.

**Later — the Tasks tab.** The second mode is called Tasks, not Builder. Its screen is the
queue — what is scheduled and what it did — rather than another chat window. Chat is already
the other tab.

### The runtime decision

Ollama was never chosen; it was assumed in M1 and never re-examined. When packaging turned it
from a dev-setup question into a distribution question, the assumption was worth testing. What
follows is what the test found, recorded because the reasoning is less obvious than the answer.

**Throughput is not the axis.** Ollama vendors ggml and pins a llama.cpp build; it is largely
the same kernels with a Go layer over them. Every 2026 head-to-head that turns up is content
farming with no reproducible method, disagreeing in both directions by single digits. Nothing
here was decided on tokens per second, and a benchmark on the author's laptop would have
answered a question nobody asked — the app runs on other people's machines.

**Packaging is the axis**, and the balance moved. The one durable argument for Ollama was one
daemon, many models, loaded on demand. `llama-server` upstreamed router mode: on-demand
autoload, LRU eviction, idle sleep, per-model config, and Hugging Face download with progress
over SSE — all behind one OpenAI-compatible endpoint. Against that, llama.cpp is an 11 MB
tarball on a private port, where Ollama is a system service on a fixed one with no documented
silent install. An application should own its runtime rather than borrow one.

**Both, though, not either.** Providers are a choice, because someone with 26 models already
pulled should not be asked to pull them again. That costs one adapter file each, which the
port was built to make true.

**No MLX in the box.** MLX is not a binary you drop in — reaching it means shipping a Python
runtime inside Electron or writing a native inference server in Swift, and the second is §12's
non-goal wearing a different hat. It is also less of a sacrifice than it sounds: llama.cpp on
Apple Silicon runs on Metal, so the bundled path is GPU-accelerated, and MLX is an incremental
gain over that of a size nobody has credibly measured. Anyone who wants it picks Ollama, which
ships an MLX runner already. If MLX-in-the-box ever becomes a requirement, it is its own
milestone with real Swift work — a decision, not a bullet point.

**No cloud inference.** It was considered and cut. Memory files stay on disk either way, but
recalled memories go into the prompt — so a cloud provider means `USER.md` leaves the machine.
That is the one item on the list that changes what Reflect *is* rather than what it runs on.
Revisit deliberately or not at all.

---

## 11. The test contract

North Star §41 says to evaluate by using it. That is right, and it is also automatable. The
certification suite is these scenarios, run against a real local model with a temp
`REFLECT_HOME`:

1. **Cold identity** — state a fact, restart the process, open a new conversation, ask.
2. **Indirect recall** — discuss a project, wait, then reference it obliquely
   (*"that book idea"*, *"my agent framework"*) and require the project file to surface.
3. **The "memory" trap** — ask a personal question containing the words *memory*, *reflect*,
   and *prompt*. Must still recall. (This is the exact 1.0 suppression bug; it becomes a
   permanent regression test.)
4. **Supersession** — state a preference, later contradict it, verify the newer one is used
   and the older is no longer injected.
5. **Long conversation** — 40k tokens on an 8k-window model; ask about turn 3.
6. **Restraint** — ask something unrelated to any memory; verify no memory is injected and
   no memory is announced.
7. **Explicit save under failure** — kill the embedding model, save a memory, verify it
   persists and becomes searchable after reindex.
8. **Model swap** — same questions across two models with different context lengths; the
   answers should not change.
9. **Runtime swap** — the same questions again across two *runtimes*; the answers should not
   change either. A memory that only survives on Ollama is a memory living in the adapter.

Every one of these fails or is untested in 1.0 today. They run in CI, and — critically —
they live in the repo and are never deleted.

---

## 12. Non-goals

- **Not a coding assistant, and not a mission engine.** Reflect does the thing
  you could have done yourself in a minute — write the note, make the folder,
  draft the document, find the fact. Work that needs planning, several models,
  or a build is ReflectForge. The test has not changed: if it cannot be
  expressed as one thing you could have typed, it belongs in Forge.
- **Not an inference engine** (§31). Reflect speaks to runtimes; it does not become one. It
  may *bundle* a runtime so a fresh machine works — shipping a binary is distribution, not
  authorship — but the moment we are maintaining sampling code or a Swift MLX server, we are
  writing the wrong product. Adapters stay thin.
- **Not cloud inference.** Everything local is the promise, not a default to be relaxed when a
  bigger model is tempting. See §10, *The runtime decision*.
- Not a graph database. Relationships are frontmatter and aliases until that demonstrably
  isn't enough.
- Not cloud sync. Files + `git` is the answer for now.
- Not a memory dashboard. The trace links to files; the files are the UI.
- **Not a mission engine.** No work graphs, no team formation, no plan-review-verify
  loops, no agents spawning agents. That is ReflectForge. The day Reflect grows a
  planner, there are two products competing for one job.

### Who Reflect is for

Stated properly, because "a local-first assistant" describes a category and not
a person, and the difference decides most arguments about scope.

Reflect is for someone ordinary at their own desk. Someone taking notes in an
office job. A student revising. A person journaling, working on themselves,
thinking something through with a patient counterpart. Not a developer, not an
operator, not someone running a pipeline.

It exists because of a specific frustration: a long personal-development
conversation in ChatGPT that hit the context limit and could not be continued or
branched, and everything in it was simply gone. So the promise is continuity — it
knows you, and it grows with you. Move to a new conversation and it still
remembers what you were working on. Mention communication two weeks later and it
recalls that brevity was the thing you were practising. That is the product;
everything else is in service of it.

What follows from that:

- **The work has to leave the app.** Someone who took meeting notes needs to
  send them to a colleague, and `.md` does not do that. Word and Excel are not
  a power feature here; they are the difference between useful and a demo.
- **The desk is fair game.** "Make a folder on my Desktop for the science
  project" is the most ordinary request this app will ever get. Files, folders,
  documents — the things a person keeps.
- **Offering is part of it.** Noticing that something is worth keeping and
  asking is closer to an assistant than waiting to be instructed.
- **Local means your data, not your isolation.** Nothing about you leaves the
  machine. Fetching a public page and reading it here is a different act from
  uploading your memory, and conflating them makes Reflect less useful without
  making anyone safer.

### The line between Reflect and ReflectForge

An earlier draft of this section said "not agentic tool use" — written when the answer
was *no tools at all*. That is too blunt now, and a non-goal nobody can apply is worse
than none. The real boundary is size, not category:

> Could a person have done this themselves in about two minutes, and does it leave a
> trace in a file they own? → **Reflect.**
> Does it need a plan, dependencies, review, or evidence before the result can be
> trusted? → **Forge.**

So Reflect may take a note, write a file, open a document, read a folder you granted,
look something up — one step, done now, recorded where you can see it. It may not
decompose an objective, assign work, or verify its own output. Skills are *know-how*:
voice, format, procedure. They do not get to become plans.

The two share foundations deliberately — the same Agent Skills format, the same MCP
connectors, files as the source of truth — so a skill written for one works in the
other. What they must never share is the orchestrator.

---

## Appendix A — What was learned from the reference harnesses

**Hermes** (`Example_Code/hermes-agent-main`)

- `SOUL.md` — one editable Markdown file for identity, reloaded per message, no restart.
- `memories/MEMORY.md` + `memories/USER.md`, `§`-delimited entries, character limits.
- **Frozen snapshot pattern**: memory injected at session start and deliberately not changed
  mid-session, to hold the prompt prefix cache. Adopted in §4 above.
- `<memory-context>` fencing plus a streaming scrubber that survives chunk boundaries.
- Memory content is scanned for prompt-injection patterns *before* being injected.
- `MemoryProvider` / `ContextEngine` abstract bases with clean lifecycles
  (`prefetch` / `sync_turn` / `on_pre_compress`; `should_compress` / `compress` /
  `update_model`), and a hard one-provider-at-a-time rule to prevent tool bloat.
- The Curator: background maintenance that archives but **never deletes**, and exempts
  pinned items.

**OpenClaw** (`Example_Code/openclaw-main`)

- *"The files are the source of truth; the model only remembers what gets written to disk."*
  The single most important idea in this document.
- `MEMORY.md` (curated) + `memory/YYYY-MM-DD.md` (daily log); today + yesterday at session
  start.
- Pre-compaction memory flush as a silent agentic turn with `NO_REPLY`.
- Hybrid BM25 + vector with normalized weights; MMR (λ=0.7) for diversity; temporal decay
  (30-day half-life) with **evergreen files exempt**.
- Index fingerprinting on provider/model/chunking — change any, reindex everything.
- Graceful degradation at every layer: no FTS5 → vector only; no sqlite-vec → JS cosine;
  backend fails → builtin.

**What was deliberately not taken:** both are agent harnesses where memory is a tool the
model chooses to call in service of doing tasks. Neither promises to know the user. Reflect's
bet — ambient, automatic continuity that the system decides on without being asked — is more
ambitious and is the actual product. The tool path is added as a complement to ambient
recall, not as a replacement for it.
