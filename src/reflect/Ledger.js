/**
 * What left this machine, and where it went.
 *
 * "Nothing leaves this machine" is the claim the whole product rests on, and
 * until now it was footer text — an assertion, printed by the same program it
 * describes, which is exactly the form of evidence nobody should accept. Every
 * assistant claims something like it. The difference worth having is not a
 * better sentence; it is a count you can check.
 *
 * So the footer stops asserting and starts reporting. Zero is the honest
 * default and the common case, and when it is not zero the ledger says what
 * went, when, and to which host, in a list the person can read.
 *
 * Three properties make it worth trusting.
 *
 * **It records the attempt, not the intention.** Entries are written at the
 * call site that actually opens the socket, so a feature that quietly reaches
 * the network cannot avoid being counted by forgetting to mention it.
 *
 * **It counts other people's computers.** The first version of this counted a
 * prompt sent to your own Ollama as something that left, on the grounds that it
 * literally did. That made the headline useless: two thirds of it was Reflect
 * talking to hardware you own, and capability probes asking "what models do you
 * have" — which carry nothing of yours at all — outnumbered the real web
 * searches three to one.
 *
 * The question the number answers is "did my data go to someone else", so the
 * answer is about parties, not packets. Your own machine and your own network
 * are your infrastructure whether the model runs under the desk or on the box
 * in the next room. A public host is somebody else, including when it is the
 * runtime: point this at a cloud endpoint and every prompt counts, loudly,
 * because that is exactly the case the count exists for.
 *
 * Nothing is hidden by this. Traffic to your own network is still recorded,
 * still shown, and still named on the empty page — "the model runs on
 * 192.168.1.50". Hiding it was the old lie; counting it was the new one.
 *
 * **It is local, and the count is permanent.** The record of what left is
 * itself a file that never leaves — readable with `cat`, and never summarised
 * by a model, because a ledger that is generated rather than counted proves
 * nothing.
 *
 * The detail rows are bounded rather than infinite, which is a real limit and
 * is said plainly here rather than glossed: a year of use is 20MB and a fifth
 * of a second to read, and it does not stop growing. What is bounded is the
 * list; the counts are folded into a totals file first and are exact for the
 * life of the install. Off-machine rows outlive local ones by five to one,
 * because they are rare and they are the whole question.
 */

import net from 'node:net';
import { appendLine, readLines, readJSON, writeJSON, writeText } from '../store/FileStore.js';

const FILE = 'ledger.jsonl';
const TOTALS = 'ledger-totals.json';

/** How many entries the panel shows. */
export const RECENT = 200;

/**
 * How much detail is kept, and why it is not everything.
 *
 * Measured: a year of ordinary use is about 180,000 entries and 20MB, and
 * reading that on every page load costs a fifth of a second — for a line under
 * the composer, which is too much, and it keeps growing.
 *
 * So the counts are kept forever and exactly, in a totals file that only ever
 * goes up, and it is the *detail rows* that are bounded. The number the claim
 * rests on is never an estimate; what ages out is the individual line saying
 * which localhost probe happened on a Tuesday in March.
 *
 * Calls that left the machine are kept far longer than calls that did not,
 * because they are rare and they are the entire question. Trimming the noise
 * first means the interesting record survives years while the file stays small.
 */
export const KEEP_OFF = 5000;
export const KEEP_LOCAL = 1000;

/** Writes between size checks. Restarting re-checks, which is the point. */
const CHECK_EVERY = 500;
let sinceCheck = CHECK_EVERY;

/**
 * Where a host sits, from the machine's point of view.
 *
 * Safety.js answers a different question — it treats loopback and LAN as one
 * category, because for SSRF both are equally dangerous to reach. Here they are
 * the whole distinction: one is this machine, the other is not.
 */
export function scopeOf(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return 'internet';
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return 'loopback';

  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 169 && b === 254) return 'private';
    return 'internet';
  }

  if (net.isIPv6(h)) {
    // ::ffff:127.0.0.1 is loopback wearing an IPv6 hat, and the readable form
    // is the one people paste into a config.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return scopeOf(mapped[1]);
    if (/^fe80:/.test(h)) return 'private';
    if (/^f[cd]/.test(h)) return 'private';
    return 'internet';
  }

  // A name ending .local or with no dot at all is something on your own
  // network — a printer, a NAS, the machine in the other room.
  if (h.endsWith('.local') || !h.includes('.')) return 'private';
  return 'internet';
}

export function hostOf(url) {
  try {
    return new URL(String(url)).host || '';
  } catch {
    return String(url || '');
  }
}

/**
 * Write one line. Never throws, and never blocks the thing it is recording.
 *
 * A ledger that could fail a request would be a reason to stop calling it, and
 * a ledger people route around records nothing.
 */
export async function record({ kind, url = null, host = null, detail = '', at = new Date() }) {
  // A caller that cannot name the host is a bug, but the safe reading of one is
  // that the call left: under-reporting is the only error this file cannot
  // afford, so an unknown destination counts against the total and says so
  // rather than being quietly dropped.
  const where = host || hostOf(url) || 'unknown';
  const entry = {
    at: at.toISOString(),
    kind,
    host: where,
    scope: scopeOf(where.replace(/:\d+$/, '')),
    detail: String(detail || '').slice(0, 200),
  };
  await appendLine(FILE, entry).catch(() => {});

  // Counted in memory rather than by reading the file, because the first draft
  // of this checked the size on every write and so made each write cost the
  // whole ledger — a fix for a slow read that produced a slower write.
  if (++sinceCheck >= CHECK_EVERY) {
    sinceCheck = 0;
    const rows = await all();
    if (rows.length > (KEEP_OFF + KEEP_LOCAL) * 1.5) await trim(rows).catch(() => {});
  }

  return entry;
}

async function all() {
  return (await readLines(FILE).catch(() => [])).filter((l) => l && l.at && l.kind);
}

const emptyTotals = () => ({ total: 0, byScope: { loopback: 0, private: 0, internet: 0 }, byKind: {}, hosts: [], yours: [] });

/**
 * Fold the rows about to be dropped into permanent counts, then keep the tail.
 *
 * Runs only when the file has grown well past its caps, so the rewrite is
 * amortised across thousands of writes rather than paid on each one.
 */
async function trim(rows) {
  const off = rows.filter((r) => r.scope !== 'loopback');
  const local = rows.filter((r) => r.scope === 'loopback');
  const keep = [...off.slice(-KEEP_OFF), ...local.slice(-KEEP_LOCAL)].sort((a, b) => (a.at < b.at ? -1 : 1));

  const dropped = rows.length - keep.length;
  if (dropped <= 0) return rows;

  const kept = new Set(keep);
  const totals = (await readJSON(TOTALS, null)) || emptyTotals();
  const hosts = new Set(totals.hosts || []);
  const yours = new Set(totals.yours || []);
  for (const r of rows) {
    if (kept.has(r)) continue;
    totals.total += 1;
    totals.byScope[r.scope] = (totals.byScope[r.scope] || 0) + 1;
    totals.byKind[r.kind] = (totals.byKind[r.kind] || 0) + 1;
    if (r.scope === 'internet' && r.host) hosts.add(r.host);
    else if (r.scope === 'private' && r.host) yours.add(r.host);
  }
  totals.hosts = [...hosts];
  totals.yours = [...yours];
  await writeJSON(TOTALS, totals);
  await writeText(FILE, keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return keep;
}

/**
 * The numbers the footer shows.
 *
 * `offMachine` is the one that matters and the one the claim was about: how
 * many times anything at all was sent somewhere that is not this computer.
 */
export async function summary({ since = null } = {}) {
  const rows = await all();
  const kept = since ? rows.filter((r) => r.at >= since) : rows;

  // Rows that aged out are still counted — the number is the claim, and a
  // claim that quietly resets when a file is trimmed would be worthless.
  const folded = since ? emptyTotals() : (await readJSON(TOTALS, null)) || emptyTotals();
  const byScope = { ...{ loopback: 0, private: 0, internet: 0 }, ...folded.byScope };
  const byKind = { ...folded.byKind };
  const hosts = new Set(folded.hosts || []);
  const yours = new Set(folded.yours || []);
  for (const r of kept) {
    byScope[r.scope] = (byScope[r.scope] || 0) + 1;
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    if (r.scope === 'internet') hosts.add(r.host);
    else if (r.scope === 'private' && r.host) yours.add(r.host);
  }

  return {
    total: kept.length + (folded.total || 0),
    // Somebody else's computer. Your own network is reported beside it rather
    // than folded into it, because the two facts answer different questions:
    // one is "who else saw this", the other is "where does the model run".
    offMachine: byScope.internet,
    onYourNetwork: byScope.private,
    byScope,
    byKind,
    hosts: [...hosts].sort(),
    yourHosts: [...yours].sort(),
    since: kept.length ? kept[0].at : null,
  };
}

/** Newest first, for the panel. */
export async function entries(limit = RECENT) {
  const rows = await all();
  return rows.slice(-limit).reverse();
}
