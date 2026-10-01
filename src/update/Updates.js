/**
 * Is there a newer Reflect?
 *
 * The one thing in Reflect that reaches the internet without being asked, and
 * it is a setting, counted like everything else. It asks GitHub what the newest
 * release is and compares it with the running version. That is all it does:
 * nothing is downloaded, nothing is installed, nothing restarts. The person is
 * told, and goes to the releases page if they want it.
 *
 * ## Why it does not install anything
 *
 * On macOS it could not. Squirrel, which is what an Electron app updates
 * itself with, only accepts an update signed by the same identity as the
 * running app — and an unsigned build is ad-hoc signed, with a fresh identity
 * every time it is built. Every update would be rejected. Signing properly
 * needs a paid Apple certificate.
 *
 * Windows has no such rule, so installing could be done there. It is not,
 * because an app that quietly replaces its own code is a strange thing to
 * build into one whose whole claim is that it does not do things behind your
 * back — and doing it on one platform only is worse than not doing it.
 *
 * ## Versions
 *
 * Deliberately not strict semver, for one reason: Reflect's own versions are
 * `2.0.0-m9`, and semver compares a pre-release tag like `m9` as a string,
 * which puts `m10` *before* `m9`. Numbers inside a tag are compared as
 * numbers here, so the next milestone is newer than the last one.
 */

import { readJSON, writeJSON } from '../store/FileStore.js';
import { record as ledger } from '../reflect/Ledger.js';

const FILE = 'update-check.json';

/** Whose releases to read. Overridable so a fork, or a test, points elsewhere. */
export const REPO = process.env.REFLECT_UPDATE_REPO || 'odomcl22/reflect';
const API = process.env.REFLECT_UPDATE_API || 'https://api.github.com';

/** How often an automatic check is allowed to actually go out. */
export const EVERY_MS = 6 * 60 * 60 * 1000;

/** Digits compared as digits, so m10 lands after m9. */
const chunks = (s) =>
  String(s)
    .toLowerCase()
    .match(/\d+|\D+/g)
    ?.map((c) => (/^\d+$/.test(c) ? Number(c) : c)) || [];

function compareChunks(a, b) {
  const x = chunks(a);
  const y = chunks(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === typeof q) {
      if (p < q) return -1;
      if (p > q) return 1;
      continue;
    }
    // A number ranks below a word, as semver has it: 2.0.0-1 precedes 2.0.0-beta.
    return typeof p === 'number' ? -1 : 1;
  }
  return 0;
}

/** `v2.0.0-m9` → { core: [2,0,0], pre: 'm9' }. Anything unparseable sorts lowest. */
export function parseVersion(text) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/.exec(String(text || '').trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] || '' };
}

/** -1 if a is older, 0 the same, 1 if a is newer. An unreadable version is oldest. */
export function compare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return !x && !y ? 0 : x ? 1 : -1;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  // A release outranks any pre-release of the same number: 2.0.0 beats 2.0.0-m9.
  if (!x.pre && !y.pre) return 0;
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return compareChunks(x.pre, y.pre);
}

export const isPrerelease = (text) => Boolean(parseVersion(text)?.pre);

/**
 * The newest release worth telling someone on `current` about.
 *
 * Someone running a milestone build is already on a pre-release and should be
 * offered the next one. Someone on a settled version should not be moved onto
 * a pre-release by a notice they did not ask for.
 */
export function pick(releases, current) {
  const wantPre = isPrerelease(current);
  const usable = (releases || [])
    .filter((r) => r && !r.draft && (wantPre || !r.prerelease))
    .filter((r) => parseVersion(r.tag_name));
  let best = null;
  for (const r of usable) if (!best || compare(r.tag_name, best.tag_name) > 0) best = r;
  return best;
}

async function remembered() {
  const state = await readJSON(FILE, null);
  return state && typeof state === 'object' ? state : {};
}

/** What was found last time, without going anywhere. */
export async function last() {
  const state = await remembered();
  return state.checkedAt ? state : null;
}

export async function forget() {
  await writeJSON(FILE, {});
}

/**
 * Ask GitHub, at most every few hours unless forced.
 *
 * Never throws and never blocks anything important: a machine with no internet,
 * a rate limit, or a repository that has published nothing yet all come back as
 * a result with `ok: false` and a reason, which the settings screen shows.
 */
export async function check({ current, force = false, now = Date.now() } = {}) {
  const before = await remembered();
  if (!force && before.checkedAt && now - new Date(before.checkedAt).getTime() < EVERY_MS) {
    return { ...before, current, fromCache: true };
  }

  const url = `${API}/repos/${REPO}/releases?per_page=20`;
  await ledger({ kind: 'update', url, detail: 'checking for a new version' }).catch(() => {});

  let result;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Reflect' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const best = pick(await res.json(), current);
    result = best
      ? {
          ok: true,
          latest: String(best.tag_name).replace(/^v/, ''),
          name: String(best.name || best.tag_name || '').slice(0, 200),
          url: String(best.html_url || `https://github.com/${REPO}/releases`),
          publishedAt: best.published_at || null,
        }
      : { ok: true, latest: null, url: `https://github.com/${REPO}/releases` };
  } catch (err) {
    // Keep what was known before: a failed check should not erase a notice the
    // person has already been shown.
    result = { ok: false, reason: err.message, latest: before.latest || null, url: before.url || null };
  }

  const state = { ...result, checkedAt: new Date(now).toISOString() };
  await writeJSON(FILE, state).catch(() => {});
  return { ...state, current, fromCache: false };
}

/** The whole answer for the settings screen, with the comparison already done. */
export async function status({ current, force = false, enabled = true } = {}) {
  if (!enabled) {
    const known = await last();
    return { enabled: false, current, latest: known?.latest || null, newer: false, checkedAt: known?.checkedAt || null };
  }
  const found = await check({ current, force });
  return {
    enabled: true,
    current,
    latest: found.latest || null,
    newer: Boolean(found.latest) && compare(found.latest, current) > 0,
    url: found.url || `https://github.com/${REPO}/releases`,
    name: found.name || null,
    checkedAt: found.checkedAt || null,
    ok: found.ok !== false,
    reason: found.ok === false ? found.reason : undefined,
  };
}
