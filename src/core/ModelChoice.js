/**
 * Which model to use when nobody has chosen one.
 *
 * The rule used to be "the largest local model", on the reasonable theory that
 * bigger is better. It is not, past the point where the weights stop fitting in
 * memory: a 13.8 GB model on a 17 GB machine loads by evicting everything else
 * and then pages, turning a first run into minutes of silence. The person who
 * gets that impression does not stay to find out that a smaller model would
 * have answered in two seconds.
 *
 * So: the largest model that comfortably fits, which is a different question.
 *
 * This is deliberately pure and knows nothing about `node:os` — the caller
 * passes the memory figure, the same way the storage port keeps the filesystem
 * out of the core.
 */

/**
 * How much of a machine's memory the weights may claim.
 *
 * The rest is not slack. The OS wants its share, the KV cache grows with the
 * context window and is resident for the whole conversation, and on Apple
 * Silicon the GPU is drawing from the same pool. Two thirds is the point where
 * a model still loads without evicting the browser it was opened from.
 */
export const MEMORY_SHARE = 0.65;

/** Nothing in the list fits? Take the smallest and let it be slow but working. */
const smallest = (models) => models.reduce((a, b) => (a.sizeBytes <= b.sizeBytes ? a : b));

/**
 * Pick a default from what is installed.
 *
 * @param {Array<{name: string, sizeBytes?: number, cloud?: boolean}>} models
 * @param {object}  opts
 * @param {number}  opts.totalMemoryBytes  0 or unknown falls back to the old behaviour
 * @returns {{name: string, reason: string}|null}
 */
export function pickDefaultModel(models = [], { totalMemoryBytes = 0 } = {}) {
  const local = models.filter((m) => !m.cloud);
  if (!local.length) return null;

  // Without a memory figure there is nothing to reason with, and guessing low
  // would be its own kind of wrong. Largest, as before.
  if (!(totalMemoryBytes > 0)) {
    return { name: biggest(local).name, reason: 'largest installed' };
  }

  const budget = totalMemoryBytes * MEMORY_SHARE;
  // A model with no reported size is not evidence that it is small, but
  // refusing to consider it would hide models on runtimes that do not report
  // sizes at all. Treat unknown as acceptable and let it sort last.
  const fits = local.filter((m) => !m.sizeBytes || m.sizeBytes <= budget);

  if (!fits.length) {
    const pick = smallest(local);
    return { name: pick.name, reason: 'smallest installed — nothing here fits in memory' };
  }

  const pick = biggest(fits);
  return {
    name: pick.name,
    reason:
      fits.length === local.length
        ? 'largest installed'
        : `largest that fits in ${Math.round(budget / 1e9)} GB of ${Math.round(totalMemoryBytes / 1e9)} GB`,
  };
}

const biggest = (models) => models.reduce((a, b) => ((b.sizeBytes || 0) > (a.sizeBytes || 0) ? b : a));

/**
 * How small the model that writes memory may be.
 *
 * Measured against the extraction contract, not guessed — seven cases covering
 * splitting a run-on introduction into four facts, filing a preference phrased
 * as a complaint, dropping a passing state, and staying silent on a question:
 *
 *   qwen3:4b          7/7    9.4s per turn
 *   llama3.2:1b       3/7    3.5s   every case it passed was a rejection; it
 *                                   never extracted anything at all
 *   deepseek-r1:1.5b  1/7   30.9s   malformed JSON, and it reasons first
 *
 * Below roughly 3B a model stops finding facts while still returning valid
 * empty JSON. That is the worst failure available here: memory quietly stops
 * working, every request succeeds, and nothing anywhere reports an error.
 */
/**
 * Below this, Reflect works but does not feel like it does.
 *
 * Measured across this session rather than guessed. A 4B model asked plainly,
 * in English, to save a skill did not reach for the tool; a 9B did it first
 * try. Project notes were filed to the wrong place. Extraction on small models
 * scored 0 out of 8 on the same corpus a larger one handled.
 *
 * The harness is the same in every case — what changes is whether the model
 * can hold a dozen tool definitions and still follow a sentence. Saying "any
 * chat model will do" invites someone to try a 1B, conclude Reflect is bad,
 * and be right about their experience.
 *
 * It is a warning, never a block. Somebody on a small laptop should still get
 * a working assistant, and told plainly what they are trading away.
 */
export const COMFORTABLE_PARAMS_B = 7;

/** @returns {null | {level: 'small'|'tiny', params: number, says: string}} */
export function sizeWarning(model) {
  const p = paramsB(model);
  if (p === null || p >= COMFORTABLE_PARAMS_B) return null;
  if (p < 4) {
    return {
      level: 'tiny',
      params: p,
      says: `${model.name} is ${model.parameterSize || `${p}B`}. It will chat, but it will miss most of what is worth remembering and will rarely use tools. 7B or larger is where Reflect starts working properly.`,
    };
  }
  return {
    level: 'small',
    params: p,
    says: `${model.name} is ${model.parameterSize || `${p}B`}. Expect it to forget things worth keeping and to skip tools it should reach for. 7B or larger is noticeably better.`,
  };
}

export const EXTRACT_MIN_PARAMS_B = 3;

/**
 * And how large it may be, as a share of the machine.
 *
 * Not a memory-fit calculation — an upper bound on how long a swap can cost.
 * A model under this loads in a couple of seconds, so choosing it is safe even
 * when it displaces the chat model between turns.
 */
export const EXTRACT_MAX_SHARE = 0.25;
export const EXTRACT_MIN_BYTES = 2e9;

/** Weights that cannot hold a conversation, whatever their size. */
const NOT_A_CHAT_MODEL = /embed|rerank|whisper|flux|stable-?diffusion|z-image|sdxl|clip\b/i;

export const paramsB = (m) => {
  const match = /([\d.]+)\s*B/i.exec(m.parameterSize || '');
  return match ? Number(match[1]) : null;
};

/** Big enough to extract reliably, and actually a chat model. */
export const canExtract = (m) => {
  if (NOT_A_CHAT_MODEL.test(m.name)) return false;
  const p = paramsB(m);
  // Parameter count is the honest signal; file size is a proxy that moves with
  // quantisation, so it is only consulted when the runtime reports no count.
  return p === null ? (m.sizeBytes || 0) >= EXTRACT_MIN_BYTES : p >= EXTRACT_MIN_PARAMS_B;
};

/**
 * Which model should write memory, given the one that answers.
 *
 * Extraction is a second full pass fired the moment a reply finishes, so it is
 * charged to the same machine while it is still warm and often still busy. Run
 * it on a large chat model and it is slow enough to hit the timeout — and a
 * timeout here is invisible, because the reply was fine and only the memory
 * never appeared.
 *
 * A small model does this job as well as a large one (7/7 above) and about an
 * order of magnitude faster, so the pick is the *smallest* competent model
 * rather than the largest that fits. That inverts pickDefaultModel on purpose:
 * chat wants the best answer it can afford, memory wants a cheap reliable one.
 *
 * @returns {{name: string, reason: string}|null} null means "use the chat
 *   model" — either nothing better is installed, or the pair would not fit.
 */
export function pickExtractModel(models = [], { chatModel = null, totalMemoryBytes = 0 } = {}) {
  const candidates = models.filter((m) => !m.cloud && canExtract(m));
  if (!candidates.length) return null;

  const pick = candidates.reduce((a, b) => ((b.sizeBytes || 0) < (a.sizeBytes || 0) ? b : a));
  if (chatModel && pick.name === chatModel) return null;

  const chat = models.find((m) => m.name === chatModel);
  // Nothing is gained by loading a second model that is bigger than the one
  // already resident.
  if (chat?.sizeBytes && pick.sizeBytes >= chat.sizeBytes) return null;

  // Requiring both to be resident at once was the first rule here, and it was
  // wrong twice over. It refused in exactly the case that needed fixing — a
  // 9.6 GB chat model on a 17 GB machine, where the pair does not fit and
  // extraction therefore stayed on the big model. And it measured the wrong
  // thing: granite4.1:8b, a 5.3 GB download, was observed holding 27.3 GB
  // resident, because the KV cache and not the weights decides the footprint.
  //
  // What is left is the guard that pays for itself. The extractor has to be
  // genuinely small, so that loading it costs a couple of seconds even when it
  // displaces the chat model. Swapping is a cost; a silent memory failure is
  // not a cost, it is the feature not working.
  if (totalMemoryBytes > 0 && pick.sizeBytes > totalMemoryBytes * EXTRACT_MAX_SHARE) return null;

  return { name: pick.name, reason: `smallest model that extracts reliably (${pick.parameterSize || `${Math.round((pick.sizeBytes || 0) / 1e8) / 10} GB`})` };
}
