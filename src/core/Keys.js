/**
 * What things are called, and what the defaults are. No platform in sight.
 *
 * This is deliberately separate from `config.js`: that module knows about
 * `node:os`, home directories, and ports, and the memory engine must not. Every
 * module above the storage port imports its keys from here, so the core's import
 * graph contains nothing that a phone lacks.
 */

/** Keys, not paths. Nothing here may be handed to a filesystem API. */
export function paths() {
  return {
    soul: 'SOUL.md',
    user: 'USER.md',
    projects: 'projects',
    journal: 'journal',
    conversations: 'conversations',
    summaries: 'summaries',
    skills: 'skills',
    tasks: 'tasks',
    attachments: 'attachments',
    assistants: 'assistants',
    index: 'index.json',
    config: 'config.json',
  };
}

/** Prefixes that must exist before anything runs. A no-op on a keyed store. */
export const REQUIRED_DIRS = ['projects', 'journal', 'conversations', 'summaries', 'skills', 'tasks', 'attachments', 'assistants'];

/** `process` is not a given off Node, so read it defensively. */
const env = (name) => globalThis.process?.env?.[name];

export const DEFAULT_CONFIG = {
  model: null, // resolved from the inference adapter on first run
  mode: 'companion', // companion | builder
  depth: 3, // 1..5, see ContextBudget.DEPTHS

  // The ceiling on the context window Reflect plans for *and* asks the runtime
  // to serve (`num_ctx`). Not a quality dial — KV cache is resident RAM, and 32k
  // behind a large model on a 16GB machine buys swapping, not context. Raise it
  // if you have the memory; a model with a smaller window still wins.
  maxContext: 8192,

  // How hard the model reasons before answering: off | low | medium | high.
  // Off by default — thinking triples the tokens for an ordinary question, and
  // a chat companion should answer instantly unless you ask it to deliberate.
  thinking: 'off',

  ollamaUrl: env('OLLAMA_URL') || 'http://localhost:11434',

  // What runs the models. `null` means "nobody has chosen" — the app detects
  // what is running and offers it, rather than picking silently. Once set it is
  // { provider, baseUrl, apiKey } and is obeyed even if something else appears
  // on a well-known port later: a runtime is a decision, not a scan result.
  runtime: null,

  // Which assistant answers by default. A role, not a separate mind — every
  // one of them reads and writes the same memory.
  assistant: 'reflect',

  // Tools the model may not use, by name. Empty means all of them.
  //
  // A deny-list rather than an allow-list, so a tool added in a later version
  // is available by default instead of silently off for everyone who has a
  // config file from before it existed.
  disabledTools: [],

  // Which whisper model transcribes dictation. Null until someone turns
  // dictation on and the weights are fetched — the binary ships, the model
  // does not.
  dictationModel: null,

  // Which model makes the vectors. Separate from `model` because the runtime
  // that answers best may not embed at all, and recall should not quietly
  // degrade because of a decision made about chat.
  embedModel: null,

  // Tell the model it can draw charts and build pages. Worth about a second of
  // first-token latency; turn it off if you only ever want prose.
  artifacts: true,

  // How long the model stays in memory after you stop typing, in minutes.
  //
  // The tradeoff is entirely about the machine. Loading a 6 GB model takes about
  // twenty seconds here, and that cost is paid by whoever types next — but a
  // model sitting in memory is memory nothing else can have. On a large machine
  // "always" is right; on a laptop doing other work, a couple of minutes is.
  //
  // 0 unloads immediately, -1 keeps it forever. Ollama's own default is 5.
  keepWarmMinutes: 30,

  // Reading replies out loud.
  //
  // The voice is the OS's own — 47 English voices on this machine, more if you
  // add them in system settings — rather than a model Reflect downloads. That
  // was not the first plan: Piper is the obvious neural choice and its macOS
  // release ships without its own libraries, so the binary cannot start. The
  // system voices work on all three platforms today, need no download, and
  // include the good ones people have already installed.
  //
  // `voice` is a name from that list, and it is machine-specific by nature —
  // a name chosen on a Mac will not exist on Windows, and an unknown name
  // falls back to the default rather than failing.
  speech: { autoSpeak: false, voice: null, rate: 1 },

  // Follow the system, or override it. Not a cosmetic afterthought: someone
  // who works at night on a machine set to light wants the choice, and every
  // app they use offers it.
  theme: 'system', // system | light | dark

  // Going out to the web. Off until someone turns it on, because "nothing
  // leaves this machine" has to be true until you say otherwise — and because
  // the useful providers want an account.
  //
  // What leaves when it is on is the search terms and the address of a page,
  // never your memory, your conversations, or your files.
  web: {
    enabled: false,
    provider: 'duckduckgo', // see web/Search.js PROVIDERS
    apiKey: null,
    baseUrl: null, // SearXNG only
  },

  // The nightly consolidation pass over USER.md — see reflect/Sleep.js.
  // On by default because it is the half of memory that makes the other half
  // trustworthy, and off is one switch away for anyone who wants the file
  // never touched by a model at all.
  sleep: true,

  // Automatic memory extraction after each turn. `extractModel: null` means
  // "use the chat model"; point it at something small to keep it cheap.
  autoExtract: true,
  extractModel: null,
};
