/**
 * The Node-flavoured half of configuration: where the files are, and which port
 * to serve on.
 *
 * The names and defaults themselves live in `core/Keys.js`, which knows about no
 * platform at all. They are re-exported here so existing importers keep working
 * — but anything above the storage port should import from `core/Keys.js`, and
 * that is what the memory engine now does.
 */

import os from 'node:os';
import path from 'node:path';

export { paths, REQUIRED_DIRS, DEFAULT_CONFIG } from './core/Keys.js';

/** Where the files actually are: display, and the Node adapter's root. */
export function homePath() {
  return process.env.REFLECT_HOME
    ? path.resolve(process.env.REFLECT_HOME)
    : path.join(os.homedir(), '.reflect');
}

export const PORT = Number(process.env.PORT || 3040);

/**
 * Which interface to listen on. Loopback, deliberately.
 *
 * This served on 0.0.0.0 until M10, which meant that on any shared network —
 * an office, a café, a hotel — everyone else could open Reflect, read the
 * memory files, and use the folder tools on whatever had been granted. There
 * is no authentication, because the premise is that the only person who can
 * reach it is the person sitting at the machine. That premise has to be
 * enforced by the bind address, and now is.
 *
 * `REFLECT_HOST=0.0.0.0` opts back out, for someone deliberately serving
 * Reflect to their own network and aware of what that means.
 */
export const HOST = process.env.REFLECT_HOST || '127.0.0.1';
