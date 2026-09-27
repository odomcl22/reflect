# Using Reflect

Everything below was run against a working build before it was written down. Where
something does not exist yet, it says so rather than describing what is planned.

Reflect keeps what it knows in `~/.reflect`, as plain files you can open, edit,
back up, or delete.

One thing leaves this machine, and only if you switch it on: **web search**. What
goes out is the search terms, or the address of a page. Your memory, your
conversations and your files never do. With it off — which is how it ships — the
footer says "Nothing leaves this machine", and that is literally true.

---

## The window

| Where | What |
|---|---|
| Left rail | Your conversations and projects, then: Memory, History, Skills, Folders, Tasks, Runtime, Settings |
| **New chat**, and **+** | A new conversation, and a new project |
| Arrow, top-left | Collapses the rail to icons. It remembers. |
| Composer | **+** menu · 🎙 dictate · model · send |

**The + menu** is everything you can bring to a turn: photos and files, the web,
connected folders, skills, assistants, tasks.

**There are no dials on the composer.** There were three — voice, thinking, and
how much context to bring in — and they are now in **Settings → How Reflect
answers**, set once rather than asked on every turn.

They are still there for anyone who wants them. **Warm** is conversational and
will ask you something back; **Direct** leads with the step or the tradeoff and
stops when the point stops. **How much it brings in** runs Glance to Total —
Balanced is 6 memories and yesterday's notes, Total is 24 memories, your project
files and a fortnight of notes. **Thinking** is reasoning before the answer:
slower, and only some models can.

The reason they left the composer is that they were the product asking you a
question it can answer itself. Recall already knows how much it found, the
question already shows how hard it is, and your journal already shows the
register you write in. An assistant that knows you should not be asking you to
configure knowing you.

---

## Choosing what runs the models

**Runtime** in the rail. Reflect looks for what is already on your machine and
offers it; it never switches on its own.

- **Ollama** — if you already have it, this brings your existing models.
- **Reflect built-in** — llama.cpp, shipped inside the app. Works with nothing else installed.
- **Any OpenAI-compatible server** — paste a base URL. This covers LM Studio, vLLM,
  or a beefier machine in your house.

**Models** (button inside Runtime) lists what you have and, if the runtime
supports downloading, lets you fetch more.

**Search Hugging Face** from the box at the top — `gemma`, `qwen`, `llama`.
Results show downloads and likes; click one to see its quantisations with real
sizes. Options too large for your machine are dashed and greyed rather than
hidden — it is your machine, and "too big" is advice.

Or paste an exact name if you already know it:

```
ggml-org/gemma-3-270m-it-GGUF:Q8_0
```

If a download fails, you get a real error. A "finished" download that did not
actually arrive is reported as a failure, not a success.

---

## Memory: how Reflect learns things

You do not have to manage this. Talk normally.

- **Say "remember this: …"** and it writes immediately.
- **Say something durable in passing** — "I work on a Mac Studio" — and it usually
  gets recorded on its own, a moment after the reply.
- **Memory** in the rail shows every file. They are yours to edit; editing one
  changes what Reflect believes.

Facts about you land in `USER.md`. Work-specific notes land in `projects/<name>.md`.
What happened today lands in `journal/<date>.md`.

**Print your year.** In the Memory panel, pick a year and Reflect composes your
journal, your projects and their decisions, and what it knows about you into a
PDF you can keep. Every word of it came from your own files — which is why no
service can offer this: it requires having given you the files in the first
place.

**Memory has a timeline.** Under the file, "What Reflect believed, and when"
lists every version — what changed it, how many facts it held, and buttons to
**See** an old one beside the current file or **Restore** it. A version is
taken before every change, whoever made it: you, extraction, or the nightly
tidy. Restoring is itself undoable, because it takes a version first.

**Every memory has a receipt.** Open **Memory** and under the file is "Where
these came from" — click a fact and Reflect opens the very conversation where
you said it. Edit a bullet by hand and its receipt stops matching, which is
deliberate: the words are yours now, and a citation for words you rewrote would
be a false one.


---

## Connectors — reaching other systems

A connector is how Reflect reaches something else — your notes app, an issue
tracker, a database — using **MCP**, the standard the rest of the ecosystem
uses. There are thousands of MCP servers; add one in **Settings → Connectors**
with the command that runs it, or its address. **Test** says whether it
answers and what it can do.

**A connector only comes into a conversation when you mention it** — by name,
as `@name`, or in the other words you gave it ("notes, jottings"). That is
deliberate. A local model already carries a dozen tools and strains at it; five
connectors could add eighty more, and it would stop being able to choose. So
"what's in Linear" reaches Linear, and "what's the capital of France" reaches
nothing. When a request is about one, Reflect offers up to twelve of its tools,
the ones whose names best match what you asked.

**A skill can bring its connector.** A skill whose instructions say "pull my
issues from linear" reaches Linear when you use the skill, without you saying
so twice.

**A scheduled task can use a connector only if its instruction names it** —
the same rule as messaging and shortcuts, for the same reason: nobody is
watching it run.

Only you can add a connector, and one that arrives from a plugin arrives
switched off. A connector that runs on this machine gets only what it needs to
run, not Reflect's whole environment. If a plugin's connector needs a secret
(`${GITHUB_TOKEN}`), Reflect records that it does and **does not fill it in**
from your environment — otherwise a plugin could name any secret you have.
Whatever a connector returns is treated as data, not instructions.

**Signing in.** For a service that makes you sign in, add its address and
press **Sign in**. Reflect finds the service's sign-in page from the connector
itself, registers itself with the service where the service allows that, and
opens the page in your own browser — with its real address bar and your
password manager. You sign in there; the browser comes back to Reflect on this
machine, and Reflect keeps only the access the service grants, in a file only
you can read. It never sees your password. Expired access renews quietly, and
**Sign out** forgets it.

Some services will not let apps register themselves. Reflect says so, and
shows the address to register; paste the client ID the service gives you into
the connector and sign in again.

---

## Working in your other apps

Reflect works in your desktop apps through **your own macOS Shortcuts**. You
build the automation in the Shortcuts app — "export today's notes to PDF",
"start a focus session", "log a glass of water" — and Reflect runs it by name,
when you ask or on a schedule. Some shortcuts return text, and Reflect reads it.

Tick the ones it may run in **Settings → Your Mac**. None are ticked to begin
with, and while none are, Reflect has no way to run one at all. A shortcut can
do anything you built it to — send, delete, buy — which is why the list is
yours to write and nothing Reflect says can add to it.

A **task** may run a shortcut only if its own instruction says so: "every
morning, run my Morning Routine shortcut" can; "summarise the news" cannot,
even with the shortcut ticked.

Two limits worth knowing. A shortcut that stops to ask a question has nobody to
answer it when Reflect runs it, and gives up after a minute. And what a
shortcut does on the network is its own business — the ledger counts what
Reflect sends, not what your shortcuts do.

Why not have the model watch the screen and click? Because it needs a far
larger model than the ones Reflect runs to do that reliably, and it is at its
most dangerous exactly when it would be most useful: unattended, able to press
anything. A shortcut does the same thing every time, because you built it to.

---

## What a task is allowed to do

A task runs while nobody is watching. That is the point of it, and it is also
why a task does not hold every tool a live conversation holds — at eight in the
morning there is no one at the screen to notice a message going to the wrong
person, and a message cannot be taken back.

So reaching out is off unless your instruction asked for it. **"Text my wife
good morning every day at eight"** is a task that may send, because that is
what it is for. **"Search the news and summarise it"** is not, even though the
same machine can send.

Each task says which it is on the Tasks screen — *cannot reach out*, *may
notify you*, or *may message and email* — and the button beside it changes its
mind. Reflect is guessing at what you meant, and a guess you cannot see is one
you cannot correct.

This is worked out from your own words, never chosen by the model. Reflect
creates tasks with a tool, so a model that could set this could grant itself
the ability to message people, and a web page it read could talk it into it.
Conversations you are present for are unaffected: you are the supervision.

---

## Reaching you when Reflect is not open

A task that runs at eight in the morning used to leave its answer in a
conversation you had to remember to go and find. Three ways out now, and they
cost different amounts, which is why they are three things and not one.

**A notification** appears on this screen. It reaches nobody else, so it needs
no setup — Settings → Reaching you has a button to show you one.

**A message** is an iMessage, and it sends for real and cannot be taken back.
It goes only to people you have added in Settings. The list starts empty, and
while it is empty Reflect has no way to send one at all: the tool is not
offered rather than offered and refused. Most people add themselves and nobody
else.

**An email** opens as a draft in Mail, filled in, and stops. Reflect never
presses send. That is why any address is fine here and only listed people can
be messaged.

Ask for them in the ordinary way — "text me the summary at eight", "draft that
as an email to Ali". A task can do the same, which is the point: it can now
reach you rather than wait to be found.

**On running scripts.** Reflect drives Messages and Mail through AppleScript,
and it still never runs code you or a model wrote. The scripts are fixed and
live in `src/deliver/Deliver.js`; everything else arrives as arguments, the way
a filename arrives at a program, and is read as text. Words that look like a
command come out the other side as words.

---

## What left this machine

The line under the composer used to promise that nothing does. It now counts.

Every connection Reflect opens is recorded where the socket is opened — the
model, extraction, embeddings, searches, page fetches, name lookups, model
downloads. Click the line to see them: when, what kind, and which host.

The number counts **other people's computers**. Your own machine and your own
network are your infrastructure — whether the model runs under the desk or on
the box in the next room, that is Reflect working, not your data going
somewhere. Traffic to your own network is still recorded, still listed under
"On your own network", and the empty page still names the machine — it is
reported, just not counted as having left.

A public host is somebody else, and that includes the runtime: point Reflect at
a cloud endpoint and every prompt counts, which is exactly the case the number
exists for.

The ledger is a plain file in your memory folder, like everything else, and it
is never summarised by a model. A count you can check is the only version of
this promise worth making.

---

## Remembering forward

Say **"I'll call mom tomorrow"** in the middle of a conversation about
something else, and tomorrow it is on your page. Reflect keeps the sentence you
said, in the words you said it, with the date it found in it — no model decides
what you promised, so it cannot invent an obligation you never took on.

It only counts a commitment with a date in it. "I'll think about it" is a turn
of phrase; "I'll think about it tonight" is a plan. That one rule does almost
all the filtering without guessing at what you meant, and "next Friday" is
ignored on purpose — it means two different days to different people.

Promises are closed by hand, with **Done** or **Not any more**. Reflect has no
way to know whether you actually rang your mother, and ticking things off on
your behalf would be the one thing that makes this a liar. An overdue promise
keeps asking for a week and then goes quiet.

---

## While you were away

The empty chat is not empty any more. When Reflect has something to show, it
shows today's page: **a year ago today** from your journal, the thread you left
mid-thought, what is owed this week, what runs today, and yesterday played
back. Every line is computed from your own files — nothing on the page is
generated, so nothing on it can be invented.

And once a day, after ten quiet minutes, Reflect **sleeps**: it re-reads
USER.md and merges bullets that say the same thing in different words — the
tidying that daytime extraction is too hurried to do. The version before it goes on
the memory timeline, and a pass that would lose a name, a number or a section
refuses itself and changes nothing. Settings → Memory switches it
off.

---

## Projects — a place for related chats

**+** beside New chat. Name it as you would say it.

A project is a folder in the rail. Chats you file into it nest inside; everything
else sits under "Everything else". Click the folder to collapse it, and Reflect
remembers which ones you shut.

**To file a chat:** the `⋯` beside it → pick a project.

The point is not tidiness. A project has notes of its own — decisions, open
questions — that Reflect writes as you work, and **those notes come into any chat
in that project**. So a new chat inside a project already knows where you got to.

Projects do not wall anything off. Recall still runs over everything you have
ever said, so working on a science project still reminds Reflect how you like to
be written to. A project is a filing decision, not a smaller memory.

Rename or delete one with the `⋯` beside the folder. **Deleting a project keeps
every chat in it** — they stop being grouped, and nothing that was said is lost.

---

## When a conversation gets long

Reflect was built because a long chat somewhere else hit its limit and took
everything in it with it. Two things exist for that.

**Continue in a new chat.** When a conversation outgrows what fits, Reflect
offers it under the reply — or take it from the `⋯` any time. It summarises the
whole thing and opens a fresh chat that already knows it, in the same project,
with the same voice. The old conversation is untouched and still in your list,
and the new one links back to it.

> Carried sixteen turns about a book. The new chat, asked cold, knew the deadline
> was the 14th of November and that chapter 3 was the goldfish's perspective.

**Branch from any turn.** Hover a message:

- On a reply — **Branch from here**. Everything through it comes across and you
  type what happens next.
- On something you said — **Ask differently**. Everything *before* it comes
  across, and your message is handed back to the composer to edit.

Both roads exist afterwards. Nothing is rewritten, because Reflect never edits a
transcript in place.

---

## Reflect noticing

On an empty chat, Reflect may say one thing you did not ask about:

> Turtle book: First draft due by the 27th of August — that is in 3 days.

It is deliberately dull about this. There is **no model involved** — it is
arithmetic over your own files, so it can only ever repeat something you wrote
down, with the dates worked out. It will mention a scheduled task that has
stopped running, something you wrote down as owed within the week, and a project
you have not touched in a fortnight. One at a time. **Dismiss** means dismissed,
not snoozed.

It will not guess. "We first talked about this on the 3rd of March" has a date in
it and is not a deadline, so it says nothing.

---

## Assistants — a role, not a second mind

**+** menu → **Assistants & personas**, or the picker in the composer once you
have more than one.

An assistant changes how Reflect speaks, which model answers, and what is on the
table. It does **not** change what Reflect knows about you. Everything written in
a conversation with any assistant goes to the same memory — so what you tell one,
all of them know. That is the whole point, and it is the one decision here that
could not be undone later.

```
Name        study-coach
For         Patient. Explains rather than answers.
Behaviour   Ask what they already know before you teach.
            Never give away an answer they could work out.
Model       (or leave it on whichever is selected)
```

---

## The web

Off until you switch it on: **+** menu → **Search the web**.

With it on, a **Web** chip appears in the composer and the footer changes to say
what actually leaves. Reflect can search, and read a page you give it.

- **DuckDuckGo** is the default and needs no account.
- **Brave** or **Tavily** take a free API key and are more reliable if you lean
  on it. **SearXNG** points at your own instance.

Reading a page needs no account at all — paste a link and ask what it says.

**What it will not do:** open anything on your own machine or network. `localhost`,
private addresses, `.local` names and the cloud metadata address are all refused,
including via a redirect. Page text is treated as a document, never as
instructions — a web page cannot tell Reflect to do something.

Every search and every page shows in the transcript: what was searched for, and
what was read.

---

## Skills — reusable instructions

A skill is a folder with a `SKILL.md` in it, in the open Agent Skills format.

Reflect starts with four — `brief`, `proofread`, `plain-english`,
`devils-advocate` — so the panel shows the shape of the thing rather than a
blank editor. They are ordinary files from the moment they are written: edit
them, switch them off, delete them. A deleted one stays deleted.

**To switch one off:** the checkbox beside its name. Off writes `enabled: false`
into that skill's own frontmatter, so opening `SKILL.md` in an editor shows why
it is not being offered, and copying the folder to another machine carries the
setting. Off means off even if you name it with `/` — otherwise the switch would
be a suggestion. Every skill in the catalogue costs prompt tokens on every turn,
which is the whole reason to switch one off.

**To make one:** rail → **Skills** → **New** → name it in lowercase-with-hyphens →
edit the file:

```markdown
---
name: terse
description: Answer in one short sentence, no preamble.
---

Answer in a single short sentence. No preamble, no sign-off.
```

The `description` is the important line: it is what the model reads when deciding
whether the skill is relevant.

**To use one:** type `/` in the composer and pick it, or write `/terse` at the
start of your message.

```
/terse What is the capital of France?
→ Paris.
```

**To check it worked:** the turn shows which skill was applied. A skill that is
missing a description is listed as *not usable*, and says why.

Skills live in `~/.reflect/skills/<name>/SKILL.md`.

---

**Reflect can write one for you.** Say "always format my standups as three
bullets — save that so I don't have to repeat it" and it writes the skill from
what you just told it.

It arrives **switched off**. You turn it on in Skills, having read it. That is
deliberate and it is the whole safety property: a skill is standing
instructions for every future turn, and a web page Reflect had just read could
otherwise talk it into giving itself a habit nobody chose. A dormant file
changes nothing. It also never writes over a skill you wrote yourself.

**Skills from elsewhere.** Reflect reads the same skill format as the rest of
the ecosystem — a folder with a `SKILL.md` in it. In Skills → *Import a folder*,
point it at a skill folder or a whole plugin folder. Skills and a plugin's
older-style commands come in as skills, **switched off**, marked with where
they came from. Read one, then tick it. Reference documents a skill points to
come with it; scripts are copied as plain text and never run. A plugin's
connectors are recorded and wait for connector support. Agents and hooks are
not imported — Reflect has no sub-agents, and hooks are code.

A plugin can be removed again, and takes its skills with it — except any you
have edited and made your own.

**How a skill gets used.** Type `/name` and it is used, every time. Reflect can
also load one itself when a request matches its description, but that depends
on the model: measured on a 9B, it loaded a skill every time it was named and
never once on its own, even when asked in the skill's own trigger words. On a
small model, name the skill.

## Folders — letting Reflect read and write your files

This is the only way Reflect touches anything outside its own memory folder.

**1. Connect it.** Rail → **Folders** → paste a path → **Connect**.
Connecting gives **reading only**.

**2. Raise it to writing** if you want that — a separate, deliberate step on that
same folder. The change is dated.

**3. Then just ask.**

```
Write a file called shopping.md in my Desk folder
containing a markdown list: oat milk, sencha, lemons.
```

The model calls `file_write`, the transcript shows the tool call and names the
file, and the file appears on disk. Verified — that exact request produced a real
`shopping.md`.

**What is enforced, not merely intended:**

- Nothing outside a connected folder can be read, ever. Path traversal is refused
  on the resolved path, not the string you typed.
- Creating a file is free. **Replacing** one is refused unless you agreed to it.
- Reflect's own memory folder cannot be granted to itself.
- A model cannot grant itself access, and a skill cannot either.

**Word, Excel and PDF all work.** Name the file and Reflect does the rest — you
do not have to say anything special.

```
Write the notes from this conversation to ~/Desktop/sync.docx
Put that comparison in a spreadsheet at ~/Desktop/costs.xlsx
Write a one-page agenda for Tuesday to ~/Desktop/agenda.pdf
Make a folder on my Desktop for the science project
```

- **`.docx`** — headings, bullets, bold and italic carry over.
- **`.xlsx`** — numbers are stored as numbers, so the spreadsheet can add them up.
- **`.pdf`** — headings, paragraphs, bullets, rules, wrapped and paginated.

In all three the model writes ordinary prose and Reflect builds the file. It is
never asked to author the format itself, which it would do badly and
confidently.

---

## Tasks — something you would have typed, saved

**You can just ask.** "Every weekday morning at 8, summarise what I said the day
before" makes the task. Reflect tells you what it saved and when it runs — and if
it could not read the schedule, it says so plainly instead of pretending.

The Tasks screen (rail → **Tasks**) is where they live, grouped by how often they
run: every hour, every day, every weekday, every week, every month, then the ones
that only run when you ask. Each row says when it last ran and when it runs next.

A task is one instruction, optionally on a clock. It is deliberately *not* a
workflow: no steps, no branches. If it cannot be said in one message, it does not
belong here.

**To make one:** rail → **Tasks** → **New**. Give it an instruction and a schedule
written the way you would say it:

```
every day at 09:00
every monday at 07:30
every hour
manual
```

Anything it cannot read becomes **manual** and tells you so, rather than inventing
a schedule you did not ask for.

**To run it now:** **Run now** on the task. It opens the resulting conversation.

**To know it ran:** three places agree —
1. the conversation appears in your ordinary history,
2. the task file records `lastRun` and which conversation it produced,
3. the day's journal has a line about it.

**The catch worth knowing:** the clock only ticks while Reflect is running. From a
terminal, "every day at 09:00" means "if `npm start` happens to be running at
nine". The desktop app is what makes scheduling real. If the machine was asleep at
nine, the task runs when it wakes rather than being skipped.

Tasks live in `~/.reflect/tasks/<name>.md`.

---

## Attachments

📎, or drag a file onto the window, or paste a screenshot.

- **Text files** are excerpted into the prompt and labelled with their filename.
  Long ones are truncated, and the excerpt says so — a model told it has the whole
  file will answer as though it does.
- **Images** go to the model if the model can see (`qwen3-vl`, for example).
- Files are stored under the conversation and are real files on disk. Deleting the
  conversation deletes them.

---

## Dictation

🎙 in the composer. The first use downloads a speech model (~78 MB) and asks first.

Audio goes to whisper.cpp **on this machine**. It is never uploaded and never
written to disk. Text appears as you speak and firms up as later words give it
context, so a phrase can correct itself a second after you say it. **Done** keeps
it, **Cancel** restores what you had.

Pressing **send** while still talking stops the recording and sends what it
heard, including the words still being transcribed — it does not leave the
microphone running behind a message you already sent.


---

## Hearing a reply

The speaker button on any reply reads it aloud. Two engines, and the difference
is speed against quality.

**Your computer's voices** are the default because they start instantly. On a
Mac they are also, by default, the oldest and worst ones Apple ships — the good
neural voices are a free download that macOS does not install for you. **System
Settings → Accessibility → Spoken Content → System Voice → Manage Voices**, add
Ava, Zoe or Evan, and they appear in Reflect immediately with no change here.
Try that before anything else.

**Kokoro** is a neural voice that runs on this machine and sounds far better.
It is optional, about 380MB once, and then entirely local — nothing is sent
anywhere to speak.

It is for people running Reflect from source, because installing it is an npm
command and the packaged app has no way to run one. Keeping it out of the
installer is also what keeps the installer at 113MB rather than 191MB, for a
voice most people will not turn on.

```bash
npm run install:voice
```

Then Settings → Speech → Which voice engine. It is not the default and should
not be: measured here it generates roughly 0.5 to 1 times real time, so a
sentence takes a few seconds to arrive. An assistant that pauses before
speaking is worse than one that sounds plain, unless you have decided otherwise
— which is the point of it being a choice.

**Blending.** A Kokoro voice is not a recording, it is a list of 256 numbers.
Averaging two of them produces a third that sounds like neither exactly, so you
can slide between Emma and George and stop where you like. That is a voice that
is yours, made without recording anybody — which is also why Reflect does not
do voice cloning: copying a real person's voice is a different model and a
different set of problems.

## Settings

Rail → **Settings**. Deliberately short — the rest lives in `~/.reflect/config.json`,
which is documented and yours to edit.

| | |
|---|---|
| **Theme** | Follow the system, or force light or dark |
| **Keep the model in memory for** | See below |
| **Charts and pages** | Costs about a second before the first word. Off if you only want prose. |
| **Notice things worth keeping** | Automatic memory. Off means only "remember this" saves anything. |
| **Model that writes memory** | Leave it on the recommended option. See below. |
| **Largest window to plan for** | Not a quality dial — the cache for it is resident memory |

**Keep the model in memory for.** A model still loaded answers in under a second;
one that has to be fetched back takes about twenty. It holds several gigabytes
while it waits, so shorten this if the machine is doing other things. Default is
30 minutes.

**Model that writes memory.** The recommended option reuses the model you are
talking to, and there is a good reason for it: a second model has to be loaded
after every reply, and on a machine without room for both, loading it pushes out
the model you are mid-conversation with — so the next thing you type waits twenty
seconds for it to come back. Only change this if you know there is room. Models
too small to do the job are named as such in the list.

---

## Typing while it is still answering

Just type. Pressing enter mid-reply queues the message rather than losing it, and
it shows above the composer with a × to take it back. Queued messages go one at a
time, in order, as soon as the current reply lands.

Stopping a reply does **not** fire the queue — stopping is a decision about the
exchange, and what you queued stays waiting.

---

## Tools — what the model may reach for

Rail → **Runtime** → **Tools**.

Tools in four groups. **Memory** is always available. **Connected folders**
appear once you connect one, and `file_write` once you raise it to writing.
**The web** appears once you switch it on. **Tasks** lets Reflect save one when
you ask for it.

An unavailable tool is shown greyed with the reason rather than hidden, because
"where did file_write go" is a worse question than a disabled row.

Switching one off **removes it from what the model is offered**, rather than
refusing it when called. A tool the model can see is a tool it will try, and a
refusal it does not understand costs a round trip and muddles the answer.

## Plugins

**There are none, and that is deliberate.**

Reflect is a chat app. The extension points it has are the three above — skills,
folders, tasks — and each is a plain file you own, not a package you install.

The agentic framework with plugins and connectors is **ReflectForge**, a separate
project. The line, from `DESIGN.md`: if it cannot be expressed as one thing you
could have typed, it belongs in Forge. That boundary is enforced by tests, not just
by intention.

---

## Building it for another machine

Reflect cross-builds. From a Mac:

```bash
npm run dist:win      # a Windows installer
npm run dist:linux    # a Linux AppImage
```

Each one fetches that platform's binaries, checks they are the right ones, and
packages. The check is not decoration: `extraResources` copies whatever is in
`vendor/` regardless of what is being built, so without it a Windows installer
made on a Mac ships macOS libraries — it installs cleanly and then dictation and
the bundled runtime do not work, with nothing saying why.

**Running the build leaves the wrong binaries in `vendor/`.** Put your own back
before running the app from source:

```bash
node scripts/fetch-llama.js && node scripts/fetch-whisper.js
```

macOS is the one direction that cannot be cross-built: whisper.cpp publishes no
runnable macOS binary, only an xcframework, so one has to be compiled — which
needs a Mac.

---

## When something looks wrong

| Symptom | Cause |
|---|---|
| "returned an empty reply" | The runtime could not load the model — usually too large for the machine |
| A wall of JSON with `"type":"function"` | A small model printed the tool definitions instead of using them. Use a bigger one. |
| Dictation not offered | No speech engine, or the model has not been downloaded |
| Model missing after switching runtimes | Models belong to a runtime. Pick one the new runtime has. |
| Recall feels worse | No embedding model. Semantic search degrades to keyword. |
| The model reloads between messages | Settings → *Model that writes memory* is set to a second model, and there is not room for both |
| Search says it was rate-limited | The no-account search engines throttle. A free Brave or Tavily key fixes it. |
| A task never ran | The clock only runs while Reflect is open. Reflect will tell you on an empty chat. |

`npx reflect doctor` reports what is installed and what is stale.
