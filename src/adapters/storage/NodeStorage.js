/**
 * Storage on a real filesystem, rooted at REFLECT_HOME.
 *
 * The two rules learned from Reflect 1.0 live here, at the only layer that knows
 * what a file is:
 *   1. Writes are atomic (tmp + rename). A crash mid-write can never leave a
 *      half-written file, which is how 1.0 lost memory stores.
 *   2. Reads never throw on a missing file. "Nothing recorded yet" is a normal
 *      state, not an error.
 *
 * Keys are relative and POSIX-ish; this is the only place they become paths.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { homePath } from '../../config.js';

let tmpCounter = 0;

export class NodeStorage {
  constructor({ root } = {}) {
    this.root = root || null;
  }

  /** Resolved late, so a test that sets REFLECT_HOME after construction works. */
  get base() {
    return this.root || homePath();
  }

  #resolve(key) {
    const clean = String(key).replace(/^\/+/, '');
    const full = path.resolve(this.base, ...clean.split('/'));
    // A key is not a path, and must never be able to become one that escapes.
    if (full !== this.base && !full.startsWith(this.base + path.sep)) {
      throw new Error(`Refusing to touch "${key}" — outside the memory folder.`);
    }
    return full;
  }

  async read(key, fallback = '') {
    try {
      return await fsp.readFile(this.#resolve(key), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return fallback;
      throw err;
    }
  }

  /**
   * Bytes, for the things that are not text.
   *
   * An attached photo has to be a real photo on disk — openable in Preview,
   * copyable out, still there if Reflect is uninstalled. Base64 inside a text
   * file would have kept the port to eight methods and quietly broken the
   * promise that your memory is a folder of files you own.
   */
  async readBytes(key) {
    try {
      return new Uint8Array(await fsp.readFile(this.#resolve(key)));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
      throw err;
    }
  }

  async writeBytes(key, bytes) {
    const file = this.#resolve(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${(tmpCounter++).toString(36)}.tmp`;
    try {
      await fsp.writeFile(tmp, Buffer.from(bytes));
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async write(key, text) {
    const file = this.#resolve(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // The temp name must be unique per *write*, not per process. Two concurrent
    // turns in one server both wrote `USER.md.<pid>.tmp`; the first rename moved
    // it away and the second failed with ENOENT, losing a memory mid-turn.
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${(tmpCounter++).toString(36)}.tmp`;
    try {
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Appends are already crash-safe at the line level, so no tmp dance. */
  async append(key, text) {
    const file = this.#resolve(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, text, 'utf8');
  }

  async list(prefix, ext = '') {
    try {
      const names = await fsp.readdir(this.#resolve(prefix));
      return names.filter((n) => !n.startsWith('.') && (!ext || n.endsWith(ext))).sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async exists(key) {
    try {
      await fsp.access(this.#resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key) {
    await fsp.rm(this.#resolve(key), { force: true });
  }

  async removeAll(prefix) {
    await fsp.rm(this.#resolve(prefix), { recursive: true, force: true });
  }

  async ensure(prefix) {
    await fsp.mkdir(this.#resolve(prefix), { recursive: true });
  }

  /** Where this is, for the health endpoint and `reflect where`. */
  describe() {
    return { kind: 'files', where: this.base };
  }
}
