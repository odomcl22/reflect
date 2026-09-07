/**
 * The storage port.
 *
 * Everything Reflect knows lives behind this interface: ten async methods
 * over string keys. No `node:fs`, no absolute paths, no `~/.reflect` — a key is
 * `USER.md` or `conversations/2026-08-13-ab12cd.jsonl`, and the adapter decides
 * what that means. On a Mac it means a file under REFLECT_HOME. On a phone it
 * can mean a row in SQLite or a blob in app storage, and nothing above this line
 * needs to be told.
 *
 * That is the whole point of the boundary. Reflect's actual product — what gets
 * remembered, what gets recalled, what fits in the prompt — is 2,000 lines of
 * plain JavaScript that only touches files through these calls.
 *
 * ```
 *   read(key, fallback)     → string
 *   write(key, text)        → void   (atomic: never a half-written memory)
 *   readBytes(key)          → Uint8Array | null
 *   writeBytes(key, bytes)  → void   (atomic, same as write)
 *   append(key, text)       → void
 *   list(prefix, ext)       → string[]  names directly under the prefix —
 *                                        both leaves and the first segment of
 *                                        deeper keys, sorted. `ext` filters
 *                                        leaves only, so a folder never
 *                                        matches one.
 *   exists(key)             → boolean
 *   remove(key)             → void
 *   removeAll(prefix)       → void   (everything under a prefix)
 *   ensure(prefix)          → void   (a no-op for stores without directories)
 * ```
 *
 * Adapters live in `src/adapters/storage/`. `NodeStorage` is the one that ships;
 * `MemoryStorage` exists so the tests can prove the core runs with no filesystem
 * underneath it at all — which is the same claim a mobile build depends on.
 *
 * The byte pair arrived with attachments in M11. A photo someone drags into a
 * conversation has to be a real photo on disk — openable in Preview, copyable
 * out, still there if Reflect is uninstalled. Base64 inside a text file would
 * have kept this list shorter and quietly broken the promise the whole design
 * rests on.
 */

/** Join key segments. Keys are POSIX-ish regardless of the host platform. */
export function join(...parts) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/** The last segment of a key: `projects/turtles.md` → `turtles.md`. */
export const basename = (key) => String(key).split('/').pop();

/** Everything before the last segment, or '' at the root. */
export const dirname = (key) => {
  const parts = String(key).split('/');
  parts.pop();
  return parts.join('/');
};

let current = null;

/**
 * Install a storage adapter. Call this before anything else on a platform that
 * is not Node — otherwise the Node adapter is loaded on first use.
 */
export function useStorage(adapter) {
  current = adapter;
}

/** The adapter in force, loading the Node one lazily if nobody chose. */
export async function storage() {
  if (!current) {
    // Dynamic, not static: a build for a platform without `node:fs` installs its
    // own adapter first and never reaches this line.
    const { NodeStorage } = await import('../adapters/storage/NodeStorage.js');
    current = new NodeStorage();
  }
  return current;
}

/** Drop the installed adapter. Tests use this; nothing else should. */
export function resetStorage() {
  current = null;
}
