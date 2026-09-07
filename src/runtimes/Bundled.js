/**
 * The runtime Reflect ships with, so an empty machine works.
 *
 * `llama-server` is a single binary — about 11 MB for macOS arm64 — that speaks
 * the OpenAI API, loads models on demand, and downloads them from Hugging Face.
 * Bundling it is distribution, not authorship: Reflect starts a process and
 * talks HTTP to it, exactly as it would to an Ollama someone else installed.
 * The non-goal in DESIGN §12 is writing an inference engine, not shipping one.
 *
 * Three places the binary might be, checked in this order:
 *
 *   1. `REFLECT_LLAMA_SERVER` — someone who built their own, or wants a
 *      specific build. Always wins.
 *   2. Inside the packaged app, under `resources/llama/`. This is the path that
 *      matters for a person who downloaded Reflect and has nothing else.
 *   3. On PATH — `brew install llama.cpp`, or a manual build. A developer
 *      running from source gets this without any extra step.
 *
 * If none of them exist, that is not an error. It means the built-in runtime is
 * unavailable and the picker should say so rather than the app failing to
 * start: Ollama or a remote endpoint are still perfectly good answers.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';

/** What the release archive is called for this machine, for the download step. */
export function platformKey({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (platform === 'win32') return 'win-cpu-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'ubuntu-arm64' : 'ubuntu-x64';
  return null;
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/**
 * Where to look for the binary, in priority order.
 *
 * `resourcesPath` is Electron's; passed in rather than imported so this module
 * stays testable and does not drag the shell into the server.
 */
/** Two levels up from src/<dir>/ — the checkout, when there is one. */
const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function candidatePaths({ resourcesPath = null, env = process.env, root = repoRoot() } = {}) {
  const found = [];
  if (env.REFLECT_LLAMA_SERVER) found.push(env.REFLECT_LLAMA_SERVER);
  if (resourcesPath) found.push(path.join(resourcesPath, 'llama', exe('llama-server')));
  // Running from source: the repo's own vendor/ is where fetch-llama.js puts it.
  // PATH was supposed to cover the developer case and does not — nobody adds
  // a project subfolder to PATH, so without this the bundled runtime is
  // invisible to everyone except a packaged build.
  if (root) found.push(path.join(root, 'vendor', 'llama', exe('llama-server')));
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    found.push(path.join(dir, exe('llama-server')));
  }
  return found;
}

/** The first candidate that exists and can be executed, or null. */
export function findBinary(opts = {}) {
  for (const candidate of candidatePaths(opts)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable. Keep looking — a missing built-in runtime
      // is a fact to report, not a failure to raise.
    }
  }
  return null;
}

/**
 * Arguments for router mode.
 *
 * Started with no model on purpose. In router mode `llama-server` supervises
 * models rather than serving one: it loads them on request, unloads them when
 * idle, and evicts the least recently used when there are too many. That is the
 * capability that used to be the only reason to require Ollama.
 *
 * `--models-max` is deliberately small. Each loaded model is resident memory,
 * and the machine this is most likely to matter on is the one with the least of
 * it.
 */
export function serverArgs({ port, modelsDir, maxLoaded = 2, idleSeconds = 600 } = {}) {
  return [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--models-dir', modelsDir,
    '--models-max', String(maxLoaded),
    '--sleep-idle-seconds', String(idleSeconds),
    // Tool calling is silently unavailable without this, which would break
    // folder tools on the bundled runtime only — the worst kind of difference
    // between backends.
    '--jinja',
  ];
}

/** Where downloaded models live: beside the memory folder, not inside it. */
export const modelsDir = (home = path.join(os.homedir(), '.reflect')) => path.join(home, 'models');

/**
 * Start the bundled server and resolve once it answers.
 *
 * Returns `{ baseUrl, stop }`, or null when there is no binary — the caller
 * treats that as "the built-in runtime is not available here", which is a
 * normal state on a machine where the user chose Ollama.
 */
export async function startBundled({ port, home, resourcesPath = null, root, timeoutMs = 20000 } = {}) {
  const binary = findBinary({ resourcesPath, ...(root === undefined ? {} : { root }) });
  if (!binary) return null;

  const dir = modelsDir(home);
  fs.mkdirSync(dir, { recursive: true });

  const child = spawn(binary, serverArgs({ port, modelsDir: dir }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detached false: if Reflect dies, this must die with it rather than
    // becoming an orphan holding a port and several gigabytes of weights.
    detached: false,
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  // Wait for it to answer rather than assuming a fixed delay: cold start varies
  // by an order of magnitude between machines.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`llama-server exited with ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { baseUrl, stop, binary, child };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  stop();
  throw new Error(`llama-server did not answer on ${baseUrl} within ${timeoutMs}ms`);
}
