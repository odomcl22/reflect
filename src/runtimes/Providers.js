/**
 * Which runtime Reflect is talking to, and how it found out.
 *
 * The rule this module exists to enforce: **a runtime is the user's choice, and
 * detection is a suggestion.** Reflect probes a handful of well-known ports so
 * the first-run screen can say "you already have this" instead of asking
 * someone to paste a URL they do not know — but nothing here silently switches
 * a runtime out from under a configured one. A machine where Ollama happens to
 * be running should not quietly stop using the built-in server that has all the
 * user's models on it.
 *
 * Probes are cheap, parallel, and short-timeout, because this runs while
 * somebody is looking at a blank screen.
 */

import { OllamaAdapter } from '../adapters/inference/OllamaAdapter.js';
import { OpenAICompatAdapter } from '../adapters/inference/OpenAICompatAdapter.js';
import { LlamaCppAdapter } from '../adapters/inference/LlamaCppAdapter.js';

/**
 * Where runtimes usually are.
 *
 * Ports, not brands. Reflect does not partner with anything — it notices a
 * server answering on a port and asks it what it is. `label` is a hint for the
 * picker, not an identity, and `kind` is confirmed by probing rather than
 * assumed from the port number.
 */
export const WELL_KNOWN = [
  { port: 11434, kind: 'ollama', label: 'Ollama' },
  { port: 8080, kind: 'openai-compat', label: 'llama-server' },
  { port: 9931, kind: 'openai-compat', label: 'llama.cpp' },
  { port: 1234, kind: 'openai-compat', label: 'OpenAI-compatible server' },
  { port: 8000, kind: 'openai-compat', label: 'OpenAI-compatible server' },
];

const TIMEOUT = 1200;

/**
 * Ask a base URL what it is.
 *
 * Order matters. `/api/tags` identifies Ollama; `/props` identifies llama.cpp
 * and is the only reliable way to tell it from a generic OpenAI endpoint, since
 * both serve `/v1/models` identically. Anything that answers `/v1/models` and
 * neither of the others is "OpenAI-compatible", which is all we need to know.
 */
export async function identify(baseUrl, { timeoutMs = TIMEOUT } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
  const get = async (path) => {
    try {
      const res = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? res : null;
    } catch {
      return null;
    }
  };

  const tags = await get('/api/tags');
  if (tags) return { kind: 'ollama', baseUrl: root, label: 'Ollama' };

  const models = await get('/v1/models');
  if (!models) return null;

  const props = await get('/props');
  if (!props) return { kind: 'openai-compat', baseUrl: root, label: 'OpenAI-compatible server' };

  // 9931 is the port Llama.app serves on. Calling it "llama.cpp" is true and
  // unhelpful — someone who installed an app wants to see that app's name in
  // the list, not the library it happens to be built on.
  const port = Number(new URL(root).port);
  return { kind: 'llamacpp', baseUrl: root, label: port === 9931 ? 'Llama' : 'llama.cpp' };
}

/**
 * What is running on this machine right now.
 *
 * Every port is probed at once — serially this would take five seconds of
 * timeouts on a machine with nothing installed, which is exactly the machine
 * least able to afford the wait.
 */
export async function detect({ hosts = WELL_KNOWN, host = '127.0.0.1' } = {}) {
  const found = await Promise.all(
    hosts.map((h) => identify(`http://${host}:${h.port}`).then((r) => (r ? { ...r, port: h.port } : null)))
  );
  return found.filter(Boolean);
}

/**
 * Build the adapter for a saved choice.
 *
 * @param {object}  runtime
 * @param {string}  runtime.provider  'ollama' | 'llamacpp' | 'openai-compat'
 * @param {string} [runtime.baseUrl]
 * @param {string} [runtime.apiKey]
 */
export function adapterFor(runtime = {}) {
  const { provider, baseUrl, apiKey = null } = runtime;
  switch (provider) {
    case 'ollama':
      return new OllamaAdapter({ ...(baseUrl ? { baseUrl } : {}) });
    // The bundled server is llama.cpp; it differs only in who started it, which
    // is the shell's business and not the adapter's.
    case 'builtin':
    case 'llamacpp':
      return new LlamaCppAdapter({ baseUrl, apiKey });
    case 'openai-compat':
      return new OpenAICompatAdapter({ baseUrl, apiKey });
    default:
      throw new Error(`Unknown runtime provider: ${provider}`);
  }
}

/**
 * Turn a detection result into something `adapterFor` accepts.
 *
 * Kept separate so that "what did we find" and "what did the user choose" never
 * become the same value by accident — the first is transient, the second is
 * saved to config and outlives whatever happens to be running today.
 */
export const asChoice = (detected) => ({
  provider: detected.kind,
  baseUrl: detected.baseUrl,
  label: detected.label,
});
