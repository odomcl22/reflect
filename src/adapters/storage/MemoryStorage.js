/**
 * Storage in a Map.
 *
 * Not a toy: it is the proof that the port is real. If Reflect's memory,
 * recall, compaction, and conversation history all work against this, then
 * nothing above the storage boundary depends on there being a filesystem — which
 * is exactly the claim a mobile build has to be able to make.
 *
 * It is also the fastest possible test substrate: no temp directories, no
 * cleanup, no cross-test leakage.
 */

import { dirname } from '../../core/Storage.js';

export class MemoryStorage {
  constructor(seed = {}) {
    this.files = new Map(Object.entries(seed));
  }

  #key = (key) => String(key).replace(/^\/+/, '');

  async read(key, fallback = '') {
    const value = this.files.get(this.#key(key));
    return value === undefined ? fallback : value;
  }

  async write(key, text) {
    this.files.set(this.#key(key), String(text));
  }
  async readBytes(key) {
    const value = this.files.get(this.#key(key));
    if (value === undefined) return null;
    return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  }
  async writeBytes(key, bytes) {
    this.files.set(this.#key(key), Uint8Array.from(bytes));
  }

  async append(key, text) {
    const k = this.#key(key);
    this.files.set(k, (this.files.get(k) || '') + String(text));
  }

/**
   * Names directly under a prefix — leaves *and* the folders implied by deeper
   * keys, which is what a filesystem `readdir` returns.
   *
   * Listing only leaves was a real bug: skills live at
   * `skills/<name>/SKILL.md`, so the store looked empty here while working
   * perfectly on disk. Keeping the two adapters honest about the same contract
   * is the entire reason this one exists.
   */
  async list(prefix, ext = '') {
    const dir = this.#key(prefix);
    const names = new Set();

    for (const key of this.files.keys()) {
      const under = dir ? key.startsWith(`${dir}/`) : true;
      if (!under) continue;

      const rest = dir ? key.slice(dir.length + 1) : key;
      const cut = rest.indexOf('/');
      const name = cut === -1 ? rest : rest.slice(0, cut);
      if (!name || name.startsWith('.')) continue;
      // A folder has no extension to match, so an ext filter excludes it —
      // exactly as readdir plus a filter would.
      if (ext && !name.endsWith(ext)) continue;
      names.add(name);
    }

    return [...names].sort();
  }

  async exists(key) {
    return this.files.has(this.#key(key));
  }

  async remove(key) {
    this.files.delete(this.#key(key));
  }

  async removeAll(prefix) {
    const dir = this.#key(prefix);
    for (const key of [...this.files.keys()]) {
      if (key === dir || key.startsWith(dir + '/')) this.files.delete(key);
    }
  }

  /** Directories are a filesystem idea. There is nothing to create here. */
  async ensure() {}

  describe() {
    return { kind: 'memory', where: `${this.files.size} entries, in this process` };
  }
}
