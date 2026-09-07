/**
 * The only thing that talks to a model.
 *
 * Deliberately thin (North Star §31): Ollama already owns model loading, GGUF
 * execution, quantization, and GPU scheduling. Reflect's job is to hand it a
 * well-built context and stream the result back.
 */

import { DEFAULT_CONFIG } from '../../config.js';
import { record as ledger } from '../../reflect/Ledger.js';

const url = (base, p) => `${String(base).replace(/\/+$/, '')}${p}`;

/**
 * Every socket this adapter opens, counted.
 *
 * Wrapping fetch rather than annotating each call site is deliberate: an audit
 * of this file found requests nobody would have thought to log — capability
 * probes, `/api/show`, and an embedding call that ships your memory text to
 * whatever host the runtime points at. A ledger assembled by remembering to
 * add lines is a ledger that is wrong the first time somebody forgets.
 *
 * The kind is read off the path and the model off the body, so a request added
 * later is counted correctly without anyone doing anything.
 */
const count = (input, init) => {
  const u = String(input);
  const kind = /\/(chat|completions)/.test(u)
    ? 'model'
    : /embed/.test(u)
      ? 'embedding'
      : /pull|download/.test(u)
        ? 'download'
        : 'probe';
  let model = '';
  try {
    model = JSON.parse(init?.body || '{}').model || '';
  } catch {
    // A body that is not JSON tells us nothing about the model; the host and
    // the kind are still worth recording.
  }
  ledger({ kind, url: u, detail: model });
  return fetch(input, init);
};

export class OllamaAdapter {
  constructor({ baseUrl = DEFAULT_CONFIG.ollamaUrl } = {}) {
    this.baseUrl = baseUrl;
    this.#showCache = new Map();
    this.#contexts = new Map();
  }

  #showCache;
  #contexts;

  /**
   * What this runtime can do. See the port for the shape.
   *
   * `thinking: 'levels'` is the honest answer even though most models take only
   * a boolean: the *wire* accepts a level, and `chat()` steps down to `true`
   * when a particular build refuses one. What a given model supports is
   * `describe(model).thinking`, which is a different question.
   */
  capabilities() {
    return {
      id: 'ollama',
      label: 'Ollama',
      models: 'list+pull',
      context: 'per-request',
      thinking: 'levels',
      embeddings: true,
      // Ollama's tags carry a capability list, so an embedding model can be
      // told from a chat model. That is what makes auto-selection safe here and
      // not safe over a bare `/v1`.
      embeddingModels: 'labelled',
      tools: true,
    };
  }

  /**
   * Remember the window a model is being served with, so every later call uses
   * the same one.
   *
   * It has to be one number per model. Ollama reloads `llama-server` whenever
   * `num_ctx` changes, so a chat at 8192 followed by an extraction at the
   * default would evict and reload the model between the reply and the memory
   * pass — twice per turn, on a machine where loading is measured in seconds.
   */
  useContext(model, numCtx) {
    if (model && Number(numCtx) > 0) this.#contexts.set(model, Math.floor(numCtx));
  }

  /** Stored window for a model, unless the caller names its own. */
  #withContext(model, options = {}) {
    const stored = this.#contexts.get(model);
    return stored && !('num_ctx' in options) ? { num_ctx: stored, ...options } : options;
  }

  async health() {
    try {
      const res = await count(url(this.baseUrl, '/api/tags'), {
        signal: AbortSignal.timeout(2500),
      });
      return { ok: res.ok, url: this.baseUrl };
    } catch (err) {
      return { ok: false, url: this.baseUrl, error: err.message };
    }
  }

  /** Chat-capable local models, largest context first. Cloud + non-text hidden. */
  async listModels() {
    const res = await count(url(this.baseUrl, '/api/tags'), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
    const { models = [] } = await res.json();

    return models
      .filter((m) => {
        const caps = m.capabilities || [];
        if (caps.includes('embedding') || caps.includes('image')) return false;
        return caps.includes('completion');
      })
      .map((m) => ({
        name: m.name,
        sizeBytes: m.size || 0,
        parameterSize: m.details?.parameter_size || null,
        quantization: m.details?.quantization_level || null,
        contextLength: m.details?.context_length || null,
        capabilities: m.capabilities || [],
        thinking: (m.capabilities || []).includes('thinking'),
        cloud: /:cloud$|-cloud$/.test(m.name) || (m.size || 0) === 0,
      }))
      .sort((a, b) => Number(a.cloud) - Number(b.cloud) || b.sizeBytes - a.sizeBytes);
  }

  /** Context length and capabilities for one model. Cached — it never changes. */
  async describe(model) {
    if (this.#showCache.has(model)) return this.#showCache.get(model);

    // Conservative defaults: an unreachable /api/show must not make us offer
    // tools to a model that cannot parse them.
    let info = { model, contextLength: 8192, thinking: false, tools: false, source: 'default' };
    try {
      const res = await count(url(this.baseUrl, '/api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        const ctx =
          data.model_info?.[`${data.details?.family}.context_length`] ??
          Object.entries(data.model_info || {}).find(([k]) => k.endsWith('.context_length'))?.[1] ??
          data.details?.context_length;
        const caps = data.capabilities || [];
        info = {
          model,
          contextLength: Number(ctx) || 8192,
          thinking: caps.includes('thinking'),
          tools: caps.includes('tools'),
          family: data.details?.family || null,
          source: 'ollama',
        };
      }
    } catch {
      // Fall through to the default — an unreachable /api/show should degrade,
      // not break the turn.
    }

    this.#showCache.set(model, info);
    return info;
  }

  /**
   * Download a model, reporting progress.
   *
   * Same contract as every other runtime that can pull: yields
   * `{type:'progress', received, total, percent, status}` and finally
   * `{type:'done'}`. Ollama reports per-layer, so `completed` walks back to
   * zero each time a new layer starts — the percentage is of the layer in
   * flight, not the whole download, and pretending otherwise would show a bar
   * that repeatedly resets.
   */
  async *pull(model, { signal } = {}) {
    const res = await count(url(this.baseUrl, '/api/pull'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama /api/pull returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.error) throw new Error(`Ollama: ${ev.error}`);

        if (/^success$/i.test(ev.status || '')) {
          yield { type: 'done', model };
          return;
        }
        yield {
          type: 'progress',
          received: ev.completed || 0,
          total: ev.total || 0,
          percent: ev.total ? Math.round(((ev.completed || 0) / ev.total) * 100) : null,
          status: ev.status || 'downloading',
        };
      }
    }

    yield { type: 'done', model };
  }

  /** Installed models that embed rather than chat. Empty is a valid answer. */
  async listEmbeddingModels() {
    const res = await count(url(this.baseUrl, '/api/tags'), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
    const { models = [] } = await res.json();
    return models
      .filter((m) => (m.capabilities || []).includes('embedding'))
      .map((m) => ({ name: m.name, sizeBytes: m.size || 0 }));
  }

  /**
   * Vectors for a batch of texts.
   *
   * Throws rather than returning null: the caller owns the decision to degrade
   * to keyword recall, and an adapter that swallows its own errors gives it
   * nothing to explain.
   */
  async embed({ model, texts, timeoutMs = 120000 }) {
    const res = await count(url(this.baseUrl, '/api/embed'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama /api/embed returned ${res.status}`);
    const data = await res.json();
    const rows = data.embeddings || (data.embedding ? [data.embedding] : []);
    if (!rows.length) throw new Error('no embeddings returned');
    return rows;
  }

  /**
   * One non-streamed completion, optionally constrained to a JSON schema.
   *
   * Used by the Reflector, which needs a parseable object rather than prose.
   * Ollama enforces the schema during sampling, so this does not depend on the
   * model's willingness to follow formatting instructions — which is what makes
   * it viable on a 4B model.
   */
  async complete({ model, messages, format, options = {}, signal, timeoutMs = 60000, keepAlive }) {
    const res = await count(url(this.baseUrl, '/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: false, // extraction is a mechanical task; reasoning is wasted time
        ...(format ? { format } : {}),
        // How long this model stays resident afterwards. The caller decides,
        // because the answer depends on what else is competing for the memory —
        // see the note on the extraction call in reflect/Extractor.js.
        ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
        options: { temperature: 0, ...this.#withContext(model, options) },
      }),
      signal: signal || AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const data = await res.json();
    return {
      content: data.message?.content ?? '',
      metrics: {
        promptTokens: data.prompt_eval_count ?? null,
        completionTokens: data.eval_count ?? null,
        latencyMs: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
      },
    };
  }

  /**
   * Stream a chat completion.
   *
   * Yields { type: 'thinking' | 'content', text }, then optionally
   * { type: 'tool_calls', calls }, then { type: 'done', metrics }.
   *
   * Tool calls are accumulated rather than streamed to the user — a half-formed
   * function call is not something anyone wants to watch being typed.
   */
  async *chat({ model, messages, options = {}, think, tools, signal, keepAlive }) {
    const started = Date.now();
    let firstTokenAt = null;
    const toolCalls = [];

    const post = (thinkValue) =>
      count(url(this.baseUrl, '/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...(thinkValue === undefined ? {} : { think: thinkValue }),
          ...(tools?.length ? { tools } : {}),
          // How long this model stays resident afterwards. The whole point of
          // the setting is the next turn: a model still loaded answers in under
          // a second, and a model that has to be fetched back takes twenty.
          ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
          options: { temperature: 0.7, ...this.#withContext(model, options) },
        }),
        signal,
      });

    let applied = think;
    let res = await post(applied);

    // Reasoning *levels* ("low"/"medium"/"high") are a gpt-oss thing; every other
    // thinking model takes a boolean, and nothing in the capability list tells
    // them apart. Ask for the level, and step down if Ollama says no — one
    // wasted round trip beats a model-name allowlist that rots.
    //
    // A level steps down to plain `true`. A boolean steps down to *omitted*,
    // because there is nothing below it: retrying `think: false` as `true`
    // would turn on the very thing the user switched off.
    if (!res.ok && applied !== undefined) {
      const detail = await res.text().catch(() => '');
      if (/think/i.test(detail)) {
        applied = typeof applied === 'string' ? true : undefined;
        res = await post(applied);
        if (!res.ok && applied === true) {
          const second = await res.text().catch(() => '');
          if (/think/i.test(second)) {
            applied = undefined;
            res = await post(applied);
          }
        }
      } else {
        throw new Error(`Ollama /api/chat returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue; // a partial line will complete on the next read
        }

        if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);

        const thinking = chunk.message?.thinking;
        const content = chunk.message?.content;
        const calls = chunk.message?.tool_calls;

        if (Array.isArray(calls) && calls.length) toolCalls.push(...calls);
        if (thinking) {
          firstTokenAt ??= Date.now();
          yield { type: 'thinking', text: thinking };
        }
        if (content) {
          firstTokenAt ??= Date.now();
          yield { type: 'content', text: content };
        }
        if (chunk.done) final = chunk;
      }
    }

    if (toolCalls.length) yield { type: 'tool_calls', calls: toolCalls };

    const elapsed = Date.now() - started;
    const evalCount = final?.eval_count ?? 0;
    const evalNs = final?.eval_duration ?? 0;

    yield {
      type: 'done',
      metrics: {
        model,
        // What the model was actually asked to do, not what we hoped for.
        think: applied === undefined ? null : applied,
        latencyMs: elapsed,
        ttftMs: firstTokenAt ? firstTokenAt - started : null,
        promptTokens: final?.prompt_eval_count ?? null,
        completionTokens: evalCount || null,
        tokensPerSecond: evalNs ? Number((evalCount / (evalNs / 1e9)).toFixed(1)) : null,
      },
    };
  }
}
