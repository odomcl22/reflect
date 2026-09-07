/**
 * Every runtime that speaks OpenAI's wire format, which is nearly all of them.
 *
 * llama.cpp's `llama-server`, LM Studio, vLLM, llamafile, a machine in the next
 * room — one adapter, a base URL, and an optional key. That is the whole reason
 * this file exists instead of four files: the differences between those servers
 * live in `capabilities()` and two fallbacks, not in the streaming loop.
 *
 * Three places where OpenAI's shape differs from Ollama's, all handled here so
 * that nothing above the port learns the difference:
 *
 *  1. **Streaming is SSE**, not newline-delimited JSON, and it ends with a
 *     literal `data: [DONE]` rather than a flag on the last object.
 *  2. **Tool calls arrive in fragments** — an index, then a name, then the
 *     arguments a few characters at a time — and have to be reassembled before
 *     anyone sees them. Ollama hands over whole calls. Downstream expects whole
 *     calls, so this is where they are made whole.
 *  3. **Reasoning has no agreed field.** llama.cpp and DeepSeek-style servers
 *     send `reasoning_content`; some send `reasoning`. Both are read; neither is
 *     required.
 *
 * The context window is the one capability genuinely lost against Ollama:
 * llama-server fixes `n_ctx` when it loads a model, so `useContext()` is
 * remembered and reported but cannot take effect until a reload. It is recorded
 * rather than ignored so the interface can say "needs a reload" instead of
 * silently doing nothing.
 */

/** Trailing slashes off, and `/v1` on exactly once however the user typed it. */
function bases(input) {
  const root = String(input || '').replace(/\/+$/, '');
  return { root: root.replace(/\/v1$/, ''), api: /\/v1$/.test(root) ? root : `${root}/v1` };
}

import { record as ledger } from '../../reflect/Ledger.js';

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

export class OpenAICompatAdapter {
  /**
   * @param {object}  opts
   * @param {string}  opts.baseUrl  with or without the trailing `/v1`
   * @param {string} [opts.apiKey]  sent as a bearer token when present
   * @param {string} [opts.id]      'llamacpp' when we know that is what it is
   * @param {string} [opts.label]
   */
  constructor({ baseUrl, apiKey = null, id = 'openai-compat', label = 'OpenAI-compatible' } = {}) {
    const { root, api } = bases(baseUrl);
    this.baseUrl = api;
    this.rootUrl = root;
    this.apiKey = apiKey;
    this.id = id;
    this.label = label;
    this.#contexts = new Map();
    this.#describeCache = new Map();
  }

  #contexts;
  #describeCache;
  /** Set once a server has rejected `reasoning_effort`, so we stop sending it. */
  #refusesEffort = false;

  capabilities() {
    return {
      id: this.id,
      label: this.label,
      // A pull endpoint is llama.cpp's `/models` family, not part of the OpenAI
      // shape. The llama.cpp profile overrides this; a generic endpoint cannot
      // be assumed to have it.
      models: 'list',
      // llama-server fixes n_ctx at load. Saying 'per-request' here would make
      // the maxContext dial appear to work and quietly not.
      context: 'per-instance',
      thinking: 'levels',
      embeddings: true,
      // `/v1/models` returns names and nothing else, so an embedding model is
      // indistinguishable from a chat model. Auto-selecting from this list
      // would eventually embed the corpus with a chat model — vectors that look
      // fine, score badly, and are silently wrong. Match known names or ask.
      embeddingModels: 'unlabelled',
      tools: true,
    };
  }

  #headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }

  /**
   * Recorded, not applied. See the class comment — the window belongs to the
   * loaded model instance, so this is what a settings screen reads to tell the
   * user a reload is needed.
   */
  useContext(model, numCtx) {
    if (model && Number(numCtx) > 0) this.#contexts.set(model, Math.floor(numCtx));
  }

  /** What `useContext` was last told, so the gap is visible rather than silent. */
  pendingContext(model) {
    return this.#contexts.get(model) ?? null;
  }

  async health() {
    try {
      const res = await count(`${this.baseUrl}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(2500),
      });
      return { ok: res.ok, url: this.baseUrl };
    } catch (err) {
      return { ok: false, url: this.baseUrl, error: err.message };
    }
  }

  async listModels() {
    const res = await count(`${this.baseUrl}/models`, {
      headers: this.#headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`${this.label} /v1/models returned ${res.status}`);
    const { data = [] } = await res.json();

    return data
      .map((m) => ({
        name: m.id,
        // llama.cpp hangs a `meta` block off each model; most servers do not,
        // and a missing window is null rather than a guess — `describe()` is
        // where a real number gets resolved.
        sizeBytes: m.meta?.size || 0,
        parameterSize: m.meta?.n_params ? `${Math.round(m.meta.n_params / 1e9)}B` : null,
        quantization: null,
        contextLength: m.meta?.n_ctx_train || null,
        capabilities: [],
        thinking: false,
        cloud: false,
      }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
  }

  /**
   * The real window for a model, preferring what the server says it actually
   * loaded over what the weights were trained for.
   *
   * `/props` is llama.cpp's and reports the live `n_ctx` — which is the number
   * that matters, because it is what will truncate us. `n_ctx_train` is the
   * fallback and is frequently far larger than what was loaded.
   */
  async describe(model) {
    if (this.#describeCache.has(model)) return this.#describeCache.get(model);

    let info = { model, contextLength: 8192, thinking: false, tools: true, source: 'default' };

    try {
      const res = await count(`${this.rootUrl}/props?model=${encodeURIComponent(model)}`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const ctx = data.default_generation_settings?.n_ctx;
        if (Number(ctx) > 0) {
          info = { ...info, contextLength: Number(ctx), source: 'props' };
        }
      }
    } catch {
      // Not a llama.cpp server, or it does not answer /props. Fall through.
    }

    if (info.source === 'default') {
      try {
        const found = (await this.listModels()).find((m) => m.name === model);
        if (found?.contextLength) {
          info = { ...info, contextLength: found.contextLength, source: 'models' };
        }
      } catch {
        // Leave the conservative default. A wrong-but-small window truncates;
        // a wrong-but-large one overflows, which is the worse failure.
      }
    }

    this.#describeCache.set(model, info);
    return info;
  }

  /**
   * Our `think` values are Ollama's. Translate, and say what was applied.
   *
   * `true` means "reason, at whatever depth you normally would", which is the
   * absence of the field rather than a level — picking one for the user would
   * be inventing a setting they did not choose.
   */
  #effort(think) {
    if (this.#refusesEffort) return undefined;
    if (think === false) return 'none';
    if (think === true || think === undefined) return undefined;
    return String(think);
  }

  async complete({ model, messages, format, options = {}, signal, timeoutMs = 60000 }) {
    const body = {
      model,
      messages: toContentParts(messages),
      stream: false,
      temperature: 0,
      ...toSampling(options),
      ...formatToResponseFormat(format),
    };

    const res = await count(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${this.label} /v1/chat/completions returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
    }

    const data = await res.json();
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      metrics: {
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
        latencyMs: data.timings?.predicted_ms ? Math.round(data.timings.predicted_ms) : null,
      },
    };
  }

  /**
   * Stream a chat completion, yielding exactly what `OllamaAdapter.chat` yields.
   *
   * Anything that reads these chunks — the controller, the trace, the transcript
   * — must not be able to tell which runtime produced them. That equivalence is
   * the whole value of the port, and it is asserted in the tests rather than
   * hoped for.
   */
  async *chat({ model, messages, options = {}, think, tools, signal }) {
    const started = Date.now();
    let firstTokenAt = null;
    /** Tool calls, assembled by their stream index. */
    const byIndex = new Map();

    const post = () =>
      count(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          model,
          messages: toContentParts(messages),
          stream: true,
          // Without this, most servers omit usage entirely on a streamed
          // response and every token count in the trace reads null.
          stream_options: { include_usage: true },
          temperature: 0.7,
          ...toSampling(options),
          ...(tools?.length ? { tools } : {}),
          ...withEffort(this.#effort(think)),
        }),
        signal,
      });

    let applied = this.#effort(think);
    let res = await post();

    // The same defensive step-down the Ollama adapter makes for `think`: servers
    // that predate reasoning_effort reject the whole request rather than
    // ignoring one field. Retry once without it, and remember, so a long
    // conversation does not pay for the discovery on every turn.
    if (!res.ok && applied !== undefined) {
      const detail = await res.text().catch(() => '');
      if (/reasoning|effort/i.test(detail)) {
        this.#refusesEffort = true;
        applied = undefined;
        res = await post();
      } else {
        throw new Error(
          `${this.label} /v1/chat/completions returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
        );
      }
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${this.label} /v1/chat/completions returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let timings = null;

    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break outer;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // a split frame completes on the next read
        }

        if (chunk.error) throw new Error(`${this.label}: ${chunk.error.message || chunk.error}`);
        if (chunk.usage) usage = chunk.usage;
        if (chunk.timings) timings = chunk.timings;

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // No agreed field name for reasoning; read either.
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) {
          firstTokenAt ??= Date.now();
          yield { type: 'thinking', text: reasoning };
        }
        if (delta.content) {
          firstTokenAt ??= Date.now();
          yield { type: 'content', text: delta.content };
        }

        for (const part of delta.tool_calls || []) {
          const key = part.index ?? byIndex.size;
          const call = byIndex.get(key) || { id: null, type: 'function', function: { name: '', arguments: '' } };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name = part.function.name;
          // Arguments arrive a few characters at a time and are concatenated as
          // text: parsing early would fail on every fragment but the last.
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
          byIndex.set(key, call);
        }
      }
    }

    if (byIndex.size) {
      yield { type: 'tool_calls', calls: [...byIndex.values()] };
    }

    const elapsed = Date.now() - started;
    const completion = usage?.completion_tokens ?? null;

    yield {
      type: 'done',
      metrics: {
        model,
        // Report Ollama's vocabulary, not the wire's, so the trace reads the
        // same whatever is underneath — and report what was *applied*. If the
        // server refused the level we asked for, the model still reasoned, at
        // its own depth: that is `true`, the same step-down Ollama makes.
        think: thinkApplied(think, applied),
        latencyMs: elapsed,
        ttftMs: firstTokenAt ? firstTokenAt - started : null,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: completion,
        tokensPerSecond:
          timings?.predicted_per_second != null
            ? Number(timings.predicted_per_second.toFixed(1))
            : completion && firstTokenAt
              ? Number((completion / ((Date.now() - firstTokenAt) / 1000 || 1)).toFixed(1))
              : null,
      },
    };
  }

  async embed({ model, texts, timeoutMs = 120000 }) {
    const res = await count(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${this.label} /v1/embeddings returned ${res.status}`);
    const data = await res.json();
    const rows = (data.data || []).map((d) => d.embedding).filter(Boolean);
    if (!rows.length) throw new Error('no embeddings returned');
    return rows;
  }

  /**
   * There is no way to tell an embedding model from a chat model over `/v1`, so
   * every model is a candidate and the caller picks by name. Ollama's tags carry
   * a capability list; this does not.
   */
  async listEmbeddingModels() {
    return (await this.listModels()).map((m) => ({ name: m.name, sizeBytes: m.sizeBytes }));
  }
}

/**
 * Ollama hangs images off the message as a base64 array; OpenAI wants content
 * parts with data URLs. The controller speaks one vocabulary and the adapters
 * translate, the same arrangement `think` and `reasoning_effort` already have.
 */
function toContentParts(messages = []) {
  return messages.map((m) => {
    if (!m.images?.length) return m;
    const { images, ...rest } = m;
    return {
      ...rest,
      content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/*;base64,${b64}` } })),
      ],
    };
  });
}

/** `reasoning_effort` only when we have one; `undefined` means "your default". */
function withEffort(effort) {
  return effort === undefined ? {} : { reasoning_effort: effort };
}

/**
 * What the model was actually asked for, in the vocabulary the trace uses.
 *
 * @param requested  what the caller wanted: false | true | 'low'|'medium'|'high'
 * @param sent       the `reasoning_effort` that survived, or undefined
 */
function thinkApplied(requested, sent) {
  if (requested === undefined) return null;
  if (requested === false) return false;
  // A level we asked for and got to send.
  if (typeof requested === 'string' && sent !== undefined) return requested;
  // Either a plain `true`, or a level the server refused — both end up as
  // "reasoning, at the model's own depth".
  return true;
}

/**
 * Ollama puts sampling under `options` with its own names. Translate the ones
 * that have an OpenAI equivalent and drop the rest — `num_ctx` in particular,
 * which has no per-request form here and would be silently ignored anyway.
 */
function toSampling(options = {}) {
  const out = {};
  if (options.temperature !== undefined) out.temperature = options.temperature;
  if (options.top_p !== undefined) out.top_p = options.top_p;
  if (options.seed !== undefined) out.seed = options.seed;
  if (options.num_predict !== undefined) out.max_tokens = options.num_predict;
  if (options.stop !== undefined) out.stop = options.stop;
  return out;
}

/**
 * Ollama takes a bare JSON Schema in `format`; OpenAI wants it wrapped.
 *
 * This matters more than it looks: the Reflector depends on schema-constrained
 * sampling to get a parseable object out of a 4B model. Losing the constraint
 * would not fail loudly — it would just start returning prose that fails to
 * parse, occasionally, on the smallest models.
 */
function formatToResponseFormat(format) {
  if (!format) return {};
  if (format === 'json') return { response_format: { type: 'json_object' } };
  if (typeof format === 'object') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', strict: true, schema: format },
      },
    };
  }
  return {};
}
