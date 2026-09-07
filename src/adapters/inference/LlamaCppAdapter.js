/**
 * llama.cpp's `llama-server`, which is an OpenAI-compatible server plus a model
 * manager.
 *
 * Everything about talking to a model is inherited. What is added is the part
 * that is not in OpenAI's shape at all: `/models`, `/models/load`,
 * `/models/unload` and `/models/sse` — router mode, where one process supervises
 * several models, loads them on demand, evicts the least recently used, and can
 * fetch new ones from Hugging Face.
 *
 * Router mode is the reason this is the runtime Reflect bundles. It is also why
 * the class is small: the capability that used to require Ollama is now a few
 * endpoints on a server we can ship as an 11 MB binary.
 */

import { OpenAICompatAdapter } from './OpenAICompatAdapter.js';

export class LlamaCppAdapter extends OpenAICompatAdapter {
  constructor({ baseUrl, apiKey = null } = {}) {
    super({ baseUrl, apiKey, id: 'llamacpp', label: 'llama.cpp' });
  }

  capabilities() {
    return { ...super.capabilities(), models: 'list+pull' };
  }

  /**
   * Models the server knows about, including ones on disk but not loaded.
   *
   * `/models` carries state that `/v1/models` does not — whether a model is
   * loaded, sleeping, or still downloading — and a picker that cannot show
   * "downloading" is a picker that looks broken for the two minutes that
   * matters most.
   */
  async listModels() {
    try {
      const res = await fetch(`${this.rootUrl}/models`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const rows = data.models || data.data || [];
        if (rows.length) {
          return rows
            .map((m) => ({
              name: m.id || m.name,
              sizeBytes: m.meta?.size || m.size || 0,
              parameterSize: m.meta?.n_params ? `${Math.round(m.meta.n_params / 1e9)}B` : null,
              quantization: quantOf(m.id || m.name),
              contextLength: m.meta?.n_ctx_train || null,
              capabilities: [],
              thinking: false,
              cloud: false,
              // Router mode reports status as an object carrying the child's
              // argv and preset. The picker wants a word, and rendering the
              // object gives "[object Object]".
              status: m.status?.value || m.status || 'unloaded',
            }))
            .sort((a, b) => b.sizeBytes - a.sizeBytes);
        }
      }
    } catch {
      // An older build without router mode: fall back to the OpenAI list, which
      // every llama-server has served for years.
    }
    return super.listModels();
  }

  /**
   * Download a model from Hugging Face, reporting progress.
   *
   * Yields `{type:'progress', received, total, percent, status}` and finally
   * `{type:'done'}`. Throws on failure — the caller decides what a failed pull
   * means, the same way it does for a failed embed.
   *
   * The stream is opened *before* the download is asked for. `/models/sse` is a
   * global event feed with no replay, so starting the download first loses
   * every event that fires before the reader attaches — on a small model over a
   * fast connection, that can be all of them, and the UI sits at 0% until the
   * download has already finished.
   */
  async *pull(model, { signal } = {}) {
    const events = await fetch(`${this.rootUrl}/models/sse`, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!events.ok || !events.body) throw new Error(`llama.cpp /models/sse returned ${events.status}`);

    const started = await fetch(`${this.rootUrl}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!started.ok) {
      const detail = await started.text().catch(() => '');
      // Asking for a model that is already registered answers 400 "already
      // exists". That is not a failure — it is the request having nothing to
      // do — and reporting it as one makes "download the model you already
      // have" look broken on the second run.
      if (/already exists/i.test(detail)) {
        yield { type: 'done', model };
        return;
      }
      throw new Error(`llama.cpp could not start the download${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;

          let ev;
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          // The feed is global — other models may be loading at the same time,
          // and their events are not ours.
          if (ev.model && ev.model !== model) continue;

          // The discriminator is `event`, not `type`. Getting this wrong is not
          // loud: nothing matches, the loop never sees `download_finished`, and
          // the read blocks until the connection dies — which surfaces as
          // "terminated" long after the download actually succeeded.
          const kind = ev.event || ev.type;
          const data = ev.data || ev;

          if (kind === 'download_finished') {
            // Not taken at face value. llama.cpp emits download_finished — and
            // logs "download completed successfully" — even when the fetch
            // failed: a 401 from Hugging Face for a repo that does not exist
            // still ends here. Believing it gives the user "Done" followed a
            // moment later by "model not found" from a different screen.
            if (await this.#registered(model)) {
              yield { type: 'done', model };
              return;
            }
            throw new Error(
              `${model} did not arrive. Check the repository name — a private or ` +
                'misspelled one fails the same way as a missing one.'
            );
          }
          if (kind === 'download_failed') {
            throw new Error(data.error || `downloading ${model} failed`);
          }
          if (kind === 'download_progress') {
            // Sharded and multimodal models fetch several files at once;
            // progress is their sum, not whichever reported last.
            const files = data.files || [data];
            const received = files.reduce((n, f) => n + (f.done || f.received || 0), 0);
            const total = files.reduce((n, f) => n + (f.total || 0), 0);
            yield {
              type: 'progress',
              received,
              total,
              percent: total ? Math.round((received / total) * 100) : null,
              status: 'downloading',
            };
          } else if (kind === 'model_status') {
            const status = data.status?.value || data.status || 'loading';
            if (status === 'loaded' || status === 'sleeping') {
              yield { type: 'done', model };
              return;
            }
            // No byte counts on a status change, but silence for two minutes
            // reads as a hang, so say what stage it is at.
            yield { type: 'progress', received: 0, total: 0, percent: null, status };
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /** Did the model actually land? The only trustworthy answer to a finished pull. */
  async #registered(model) {
    try {
      return (await this.listModels()).some((m) => m.name === model);
    } catch {
      return false;
    }
  }

  /** Stop a download, or evict a loaded model. */
  async unload(model) {
    const res = await fetch(`${this.rootUrl}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    return res.ok;
  }
}

/** `…-GGUF:Q4_K_M` → `Q4_K_M`. Cosmetic, but it is what people choose by. */
function quantOf(name) {
  const m = /:(\w+)$/.exec(String(name || ''));
  return m && /^(Q\d|IQ\d|BF16|F16|F32)/i.test(m[1]) ? m[1] : null;
}
