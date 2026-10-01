# Reflect

**A personal AI assistant that runs on your own computer and remembers you.**

**Reflect acts in your life. [ReflectForge](https://github.com/odomcl22/reflect-forge) builds things.**

Reflect is a desktop chat app for macOS and Windows (or any browser) that talks
to AI models running on your own machine through [Ollama](https://ollama.com),
LM Studio or llama.cpp. It remembers what you tell it, keeps track of your day,
reaches your other apps, and can do small jobs on a schedule — without an
account, a subscription, or your conversations leaving your computer.

Its memory is a folder of plain Markdown files. You can open them, edit them,
back them up or delete them. Models will come and go; the folder is yours.

```
~/.reflect/
├── USER.md                  what Reflect knows about you
├── journal/2026-09-07.md    what happened today
├── projects/turtles-book.md decisions on a piece of work
└── conversations/           every turn, as plain JSONL
```

---

## What Reflect does

### Chats with you, on your own models
- A chat window like the ones you know: streaming replies, Markdown, code with
  highlighting, tables, maths, diagrams, and charts or small pages drawn inline.
- **Attach files** — drag them in or paste a screenshot. Text is read into the
  conversation; images go to models that can see.
- **Projects** group related chats in the sidebar. **History** searches
  everything you have ever said.
- **Assistants** — set up roles with their own voice and model (a writing
  partner, a planner). They all share one memory, so what you tell one, they
  all know.
- Use any local model, or point Reflect at another machine on your network if
  that is where the big model lives.

### Remembers you
- It notices things worth keeping as you talk (*"my sister's name is Ana"*,
  *"I'm vegetarian"*) and writes them to `USER.md`. Or just say *"remember this"*.
- **Every memory has a receipt.** Click a fact to see the conversation where
  you said it.
- **Every change is versioned.** See what Reflect believed in March, and put it
  back.
- Once a day it **tidies its own memory**, merging lines that say the same
  thing — and refuses any tidy that would lose a name, a number or a section.
- Projects you talk about get their own file of decisions, so *"what did we
  decide about the cover?"* has an answer.

### Keeps track of your day
- An empty chat opens on **today's page**: a year ago today, the thread you left
  mid-thought, what you said you would do this week, and what runs today. Every
  line comes from your own files, so nothing on it is invented.
- **It remembers forward.** Say *"I'll call mom tomorrow"* in passing, and
  tomorrow it is on your page, in your words.
- **Print your year** — journal, projects and decisions as a PDF.

### Does things for you
- **Tasks:** *"every weekday at 8, summarise what I said yesterday"* becomes a
  saved task that runs on schedule.
- **Reaching you:** a task's answer can arrive as a notification, an iMessage
  to someone you have allowed, or an email draft waiting for you to send.
- **Your Mac's Shortcuts:** run automations you built in the Shortcuts app —
  only the ones you tick in Settings.
- **Folders:** let Reflect read a folder you choose, and — as a separate step —
  write to it.
- **The web:** off until you switch it on. Search and read pages, with
  DuckDuckGo by default.

### Reaches your other apps — skills, plugins and connectors
- **Skills** are reusable instructions (*"how I like meeting notes written"*).
  Write your own, ask Reflect to write one, or import them.
- **Connectors** reach other systems — calendars, notes, issue trackers — using
  [MCP](https://modelcontextprotocol.io), the standard the rest of the AI world
  uses. Local servers or remote ones, including ones you sign in to through
  your browser.
- **Plugins** in the same format Claude uses bundle skills and connectors
  together. See [Getting skills, plugins and connectors](#getting-skills-plugins-and-connectors).

### Talks and listens
- **Dictation** with whisper.cpp, on this machine. Audio is never uploaded.
- **Read aloud** with your computer's voices, or the much more natural
  [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voice — also on-device.

### Looks the way you like
- Light or dark, text size, reading font (system, serif or mono), accent
  colour, conversation width, and whether Enter or ⌘/Ctrl+Enter sends.

### Shows you what left your machine
- The line under the chat box is a count, not a promise: what went to the
  internet, and what went to other machines on your network. Click it for the
  full list.
- Nothing you say is in that count. The only thing Reflect sends out on its
  own is a check with GitHub for a newer version, every few hours — counted
  like everything else, and switchable off in Settings. Web search and
  connectors reach out only when you have turned them on.

---

## What Reflect will not do

- **Run code** — not a script from a plugin, not a hook, not something a model
  wrote.
- **Take on big jobs by itself** — plan, spawn sub-agents, or review its own
  work. That is [ReflectForge](https://github.com/odomcl22/reflect-forge).
- **Send your conversations to a cloud AI.** It talks to models on your own
  machine or your own network. Web search and connectors reach out only when
  you have switched them on, and each request is counted.

The line: **if it can be expressed as one thing you would have typed, it
belongs in Reflect. If it needs a plan, phases and a review loop, it belongs in
ReflectForge.**

---

## Install

### 1. Get a model

Install [Ollama](https://ollama.com), then pull a model:

```bash
ollama pull qwen3.5:9b
```

**Use 7B or larger if you can.** Below about 7B, a model starts missing things
worth remembering and skipping tools it should use — measured, not guessed.
Reflect warns you under the chat box when the model you picked is small. On a
16 GB Mac, 7–12B models are the sweet spot.

### 2. Get Reflect

**Download the app** from [Releases](https://github.com/odomcl22/reflect/releases):
the `.dmg` for Apple Silicon Macs, or the `.exe` for Windows.

> **The builds are not code-signed** (that needs a paid developer
> certificate), so your computer will warn you the first time.
> **macOS:** right-click the app → **Open** → **Open**.
> **Windows:** **More info** → **Run anyway**.

**Or run it from source** with [Node 20+](https://nodejs.org):

```bash
git clone https://github.com/odomcl22/reflect.git
cd reflect
npm install
npm start          # then open http://localhost:3040
npm run desktop    # or run it as a desktop app
```

Using LM Studio, llama.cpp, vLLM, or a model on another computer? Rail →
**Runtime** → set the address. Anything with an OpenAI-compatible endpoint works.

**Optional:** `npm run install:voice` adds the Kokoro voice. Dictation downloads
its speech model (~78 MB) the first time you use it, after asking.

---

## Getting skills, plugins and connectors

Reflect uses the same formats as the rest of the ecosystem, so there is no
Reflect-only store to learn. **Everything you import arrives switched off** —
read it, then turn it on.

### Where to find them

| What | Where |
|---|---|
| Skills | [anthropics/skills](https://github.com/anthropics/skills) — Anthropic's public collection |
| Plugins | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) — the official plugin directory |
| Connectors (MCP servers) | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) and the [MCP Registry](https://registry.modelcontextprotocol.io) |

### How importing works

Download it to your computer first — Reflect imports a folder from disk, not a
URL. Then **Skills** in the left rail → **Plugins and skills from elsewhere** →
paste the path → **Import**. Reflect says what it took and what it refused.
The [Cookbook](#cookbook) below walks through real examples.

**Which folder to point at:**
- **A plugin:** the folder with `.claude-plugin/` inside.
- **A single skill:** the folder with `SKILL.md` inside.
- **A collection of skills:** the folder with a `skills/` folder inside.
- **A whole plugin directory** doesn't import as one thing — Reflect tells you
  which plugin folders inside it to pick from.

**Using a skill:** type `/` and its name in the chat box, or just ask for what
it does and Reflect loads it when it fits. Smaller models are much more reliable
when you name the skill with `/`.

### What comes through, and what doesn't

| In the plugin | In Reflect |
|---|---|
| Skills and commands | Skills, switched off |
| Reference files beside a skill | Kept with the skill |
| Scripts | **Copied as plain text, never run.** A skill that depends on its scripts — like the Word, PDF and PowerPoint skills — can explain what it would do, but can't do the scripted part |
| `.mcp.json` servers | Connectors, switched off |
| Sub-agents and hooks | **Refused**, with the reason — they need running code or sub-agents |
| Secrets the plugin names, like `${GITHUB_TOKEN}` | Listed as "needs …" and **never** filled in from your environment |

A connector marked **needs** a token can't be given one from the app yet —
there's a [worked way round it](#add-a-connector-that-a-plugin-brought) below.

### Adding a connector yourself

**Settings → Connectors.** Give it a name, and either the command that starts
it (for example `npx -y some-mcp-server`) or its `https://` address, then press
**Add connector**. Paste a token if the service uses one; if it uses a browser
sign-in, press **Sign in** once it is added.

A connector is only offered to the model when your message mentions it — by
name, as `@name`, or by other words you give it (*"calendar"*, *"my notes"*).
That keeps a small local model from drowning in tools it doesn't need.

---

## Cookbook

Worked examples, using Anthropic's public repositories. Keep the downloads
somewhere you'll find them again — Reflect reads a folder on your disk, it does
not copy the repository, so the folder is also where updates arrive.

```bash
mkdir -p ~/reflect-sources
```

### Install Anthropic's skills collection

```bash
git clone https://github.com/anthropics/skills.git ~/reflect-sources/skills
```

**Skills** → paste `~/reflect-sources/skills` → **Import**. Every skill in the
collection arrives at once, all switched off. Reflect lists anything it refused
and why — a skill whose description breaks the format's 1,024-character limit,
for example, since a description that long would never be used to choose it.

Read the ones you want and switch them on. The document skills (`docx`, `pdf`,
`pptx`) are the exception worth knowing: they lean on their Python scripts,
which Reflect copies but never runs, so they can explain the procedure but not
produce the file.

### Install one plugin from the official directory

```bash
git clone https://github.com/anthropics/claude-plugins-official.git ~/reflect-sources/claude-plugins
```

Import the **plugin's own folder**, not the whole repository:

```
~/reflect-sources/claude-plugins/plugins/code-review
```

Point Import at the repository root instead and it won't import anything — it
will tell you which folders inside are plugins, so you can pick one.

### Update a skill or plugin when a new version lands

First update your copy of the source:

```bash
cd ~/reflect-sources/skills && git pull
```

Then, in Reflect: **Skills** → find the plugin in the list → **Remove** →
**Import** the same folder again.

Importing over the top on its own does nothing, on purpose: Reflect never
writes over a skill that already exists, because it cannot tell whether you
have edited it since. A re-import says so rather than failing quietly.

Two things to expect after an update:

- **The skill comes back switched off.** Every import does, including this one.
  Turn it on again.
- **Your own edits to that skill are gone**, because Remove took the plugin's
  copy with it. To keep a skill you have made your own, open
  `~/.reflect/skills/<name>/SKILL.md` and delete its `source:` line first.
  Reflect then treats it as yours, and removing the plugin leaves it alone.

### Remove something you have imported

- **A plugin:** Skills → the plugin's row → **Remove**. It takes the skills and
  connectors it brought — except any skill whose `source:` line you removed.
- **A single skill:** Skills → the skill → delete it there.
- **A connector:** Settings → Connectors → **Remove**. Signing out happens with
  it.

### Add a connector that a plugin brought

Some plugins ship an MCP server rather than skills. The GitHub one, for example:

```
~/reflect-sources/claude-plugins/external_plugins/github
```

Importing it adds a connector called `github`, switched off and tagged **needs
GITHUB_PERSONAL_ACCESS_TOKEN** — the plugin names the secret, and Reflect never
takes it from your environment. Until the app can fill that in, remove that
connector and add it again by hand under **Settings → Connectors** with the
same address and your own token.

### Write your own skill

Ask for one: *"write me a skill for how I like meeting notes: decisions first,
then who owes what, no summary paragraph."* Reflect writes it and leaves it
switched off, like anything else — read it, then turn it on.

Skills are folders of Markdown under `~/.reflect/skills/`. Writing one by hand
is just a `SKILL.md` with a name and a description:

```markdown
---
name: meeting-notes
description: Write up meeting notes. Use when asked to write up a meeting.
enabled: true
---

Decisions first, as a list. Then who owes what, with names.
No summary paragraph.
```

---

## Where your data lives

Everything is under `~/.reflect`, outside this repository. Set `REFLECT_HOME`
to keep it somewhere else. Sign-in tokens for connectors are kept in a file only
your user account can read.

Web search is off by default. When it is on, your search terms go to the
provider you chose and nothing else does — and the ledger counts every one.

### Checking for new versions

Reflect asks GitHub, at most every few hours, whether a newer release has been
published. It is the one request Reflect makes without being asked, it sends
nothing but the request itself, and the ledger counts it like any other. If a
newer version exists, **Settings → This copy of Reflect** says so and links to
the download page.

**Nothing is downloaded or installed for you**, on purpose. On macOS it could
not be: an app can only replace itself with a build signed by the same identity,
and unsigned builds are signed afresh every time, so every update would be
rejected. Doing it on Windows alone would be worse than not doing it. Updating
is a download you choose, from the link.

Turn the check off with **Settings → Look for new versions**, or set
`updateCheck: false` in `~/.reflect/config.json`.

---

## For developers

Ports and adapters, one runtime dependency (`express`), no build step. The
client is vanilla ES modules — no bundler, no framework.

```
src/
├── api/          the chat turn, start to finish
├── context/      what goes into the prompt, and what it costs
├── recall/       hybrid search over memory
├── reflect/      extraction, noticing, sleep, promises, receipts, the ledger
├── store/        memory files, conversations, versions
├── adapters/     Ollama, OpenAI-compatible, llama.cpp
├── skills/       skills and plugin import
├── connectors/   MCP client and browser sign-in
├── tasks/        one saved instruction, on a clock
└── deliver/      notifications, messages, mail drafts
```

```bash
npm test          # unit tests; no model needed
npm run e2e       # end to end, against a real model
npm run dist      # build an installer for this platform
npm run dist:win  # Windows, cross-built from a Mac
```

[GUIDE.md](GUIDE.md) is the user manual. [DESIGN.md](DESIGN.md) is the
reasoning behind the decisions. [SECURITY.md](SECURITY.md) says how to report a
problem.

---

## Status

Working, and used daily by its author. Unsigned, not in any app store, and not a
finished product — expect rough edges. The memory format will stay readable
whatever else changes.

## License

MIT — see [LICENSE](LICENSE).
