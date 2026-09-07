/**
 * The inference port.
 *
 * Reflect is not a model and does not want to become one (North Star §31). What
 * it needs from whatever runs the model is small and unlikely to change:
 *
 * ```
 *   capabilities()                  → see below
 *   listModels()                    → [{ name, contextLength, capabilities }]
 *   describe(model)                 → { contextLength, thinking, tools }
 *   chat({model, messages, ...})    → async iterable of
 *                                     {type:'thinking'|'content'|'tool_calls'|'done'}
 *   complete({model, messages, format}) → { content, metrics }
 *   embed({model, texts})           → number[][]   (optional; recall degrades
 *                                     to keyword-only without it)
 *   useContext(model, numCtx)       → void         (optional)
 * ```
 *
 * The reason it is a port and not just a class is the phone: iOS has no Ollama,
 * and an MLX or llama.cpp adapter has to be able to take its place without the
 * prompt assembler, the budget, the reflector, or the recall engine noticing.
 *
 * The contract to preserve, whatever the runtime: `chat` streams, `describe`
 * reports a real context window, and a missing capability degrades rather than
 * throws — no embeddings means keyword recall, not a broken app.
 *
 * ## capabilities()
 *
 * ```
 *   { id, label,
 *     models:     'list' | 'list+pull',
 *     context:    'per-request' | 'per-instance',
 *     thinking:   'levels' | 'boolean' | 'none',
 *     embeddings: boolean,
 *     tools:      boolean }
 * ```
 *
 * Adapters say what they can do and the interface believes them: a runtime that
 * cannot pull models does not get a pull button, and one whose context is fixed
 * at launch does not get a dial that appears to work and does not.
 *
 * Without this the failure is quiet and specific — features collapse to the
 * intersection of every backend we support, or `ChatController` grows a switch
 * on provider name and the port stops being a port. Declaring the differences
 * is what keeps them from being handled everywhere.
 *
 * Two distinctions worth reading twice:
 *
 *  - `thinking` describes what the **wire** can carry, not what a model can do.
 *    Whether *this* model reasons is `describe(model).thinking`. Ollama's wire
 *    takes a boolean or a level; OpenAI's takes `reasoning_effort`; a bare
 *    completions endpoint takes neither.
 *  - `context: 'per-instance'` means `useContext()` is remembered but cannot be
 *    applied to the next request — llama.cpp fixes the window when the model is
 *    loaded. The setting is real, it just needs a reload, and the interface has
 *    to be able to say so instead of lying.
 */

let current = null;

/** Install an inference adapter. Anything not Ollama must call this at boot. */
export function useInference(adapter) {
  current = adapter;
}

/** The adapter in force, loading Ollama lazily if nobody chose. */
export async function inference(options = {}) {
  if (!current) {
    const { OllamaAdapter } = await import('../adapters/inference/OllamaAdapter.js');
    current = new OllamaAdapter(options);
  }
  return current;
}

/** Drop the installed adapter. Tests use this; nothing else should. */
export function resetInference() {
  current = null;
}
