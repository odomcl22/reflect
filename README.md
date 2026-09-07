# Reflect

**A local assistant whose memory is a folder of files you own.**

Reflect is not a model. It is the harness around one — the part that knows who
you are, what you are working on, and what you said three weeks ago, so that a
model running on your own machine feels like something that knows you.

Your memory is Markdown. You can read it, edit it, copy it to a USB stick, or
print it. There is no account, no sync, no server. Models will come and go; the
folder is yours.

```
~/.reflect/
├── USER.md              what Reflect knows about you
├── journal/2026-09-07.md    what happened today
├── projects/turtles-book.md decisions on a piece of work
└── conversations/           every turn, as plain JSONL
```

---

## What it does that other assistants do not

**It reflects something back.** Open an empty chat and you get today's page: a
year ago today from your journal, the thread you left mid-thought, what is owed
this week, what runs today. Every line is computed from your own files — nothing
on it is generated, so nothing on it can be invented.

**It remembers forward.** Say *"I'll call mom tomorrow"* in the middle of a
conversation about something else, and tomorrow it is on your page, in the words
you said it. No assistant without a journal can do this, because it has no
tomorrow to bring it back to.

**It sleeps.** Once a day, after ten quiet minutes, Reflect re-reads its own
memory and merges the bullets that say the same thing in different words — the
tidying that daytime extraction is too hurried to do. A pass that would lose a
name, a number or a section refuses itself.

**Every memory has a receipt.** Click a fact and Reflect opens the conversation
where you said it. Edit the bullet by hand and the receipt stops matching, which
is deliberate: the words are yours now, and a citation for words you rewrote
would be a false one.

**Memory has a timeline, and undo.** Every change is versioned — yours,
extraction's, and the nightly tidy's. See what Reflect believed in March, and
put it back. Restoring is itself undoable.

**It counts what leaves.** The line under the composer is not a promise, it is a
count taken at the socket: what went to the internet, what went to your own
network, what never left. Zero is the normal reading.

**You can print your year.** Journal, projects and decisions composed into a PDF
you can put on a shelf. No service can offer this, because it would require
having given you the files in the first place.

---

## Running it

You need [Node 20+](https://nodejs.org) and something to run a model. Ollama is
the easiest:

```bash
brew install ollama && ollama serve      # or https://ollama.com
ollama pull qwen3:4b                     # any chat model will do
```

Then:

```bash
git clone https://github.com/odomcl22/reflect.git
cd reflect
npm install
npm start                                # http://localhost:3000
```

For the desktop app:

```bash
npm run desktop
```

Reflect also speaks to LM Studio, llama.cpp, vLLM, or anything with an
OpenAI-compatible endpoint — including one on another machine on your network.
Runtime → set the address.

### Building an installer

```bash
npm run dist          # your platform
npm run dist:win      # Windows, cross-built
```

**The builds are not code-signed.** macOS Gatekeeper will refuse to open the app
and Windows SmartScreen will warn about it. That is what an unsigned build looks
like, not a sign that something is wrong — right-click → Open on macOS, or More
info → Run anyway on Windows. Signing needs a paid developer certificate.

---

## Where your data lives

Everything is under `~/.reflect`, outside this repository, and nothing in the
app sends it anywhere. Point `REFLECT_HOME` somewhere else if you prefer.

Web search is off by default. When you turn it on, your search terms go to the
provider you chose and nothing else does — and the ledger counts every one.

---

## Reflect and ReflectForge

Reflect is a chat app. It has no plugin system, and that is deliberate: its
extension points are skills, folders and tasks, each a plain file you own rather
than a package you install.

The line: **if it can be expressed as one thing you would have typed, it belongs
in Reflect. If it needs a plan, phases, and a review loop, it belongs in
[ReflectForge](https://github.com/odomcl22/reflect-forge).**

---

## The shape of it

Ports and adapters, one runtime dependency, no build step.

```
src/
├── api/          the chat turn, start to finish
├── context/      what goes into the prompt, and what it costs
├── recall/       hybrid search over memory
├── reflect/      extraction, noticing, sleep, promises, receipts, the ledger
├── store/        memory files, conversations, versions
├── adapters/     Ollama, OpenAI-compatible, llama.cpp
├── tasks/        one saved instruction, on a clock
└── deliver/      notifications, messages, mail drafts
```

`express` is the only runtime dependency. The client is vanilla ES modules —
no bundler, no transpiler, no framework. `GUIDE.md` is the user manual;
`DESIGN.md` is the reasoning behind the decisions.

```bash
npm test          # 658 unit tests
npm run e2e       # end-to-end, against a real model
```

---

## Status

Working and used daily by its author. Not signed, not packaged for stores, and
not remotely a finished product. Expect rough edges, and expect the memory
format to stay readable even when other things change.

## License

MIT — see [LICENSE](LICENSE).
